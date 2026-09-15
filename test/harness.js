/**
 * A functional stand-in for the parts of the vscode API that task discovery touches,
 * backed by a real directory on disk.
 *
 * The smoke test only proves the bundle loads. This lets the actual discovery, synthesis
 * and grouping run end to end against fixture workspaces, so the workspace shapes that
 * caused trouble - a project opened directly, a folder of checkouts opened one level up,
 * multi-root - are covered by something repeatable rather than by clicking around.
 *
 * `findFiles` is a real recursive walk rather than a glob engine: matching the caller's
 * pattern is VS Code's job, and what needs testing here is what this extension does with
 * the files it is handed.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

/** Records every constructed Task so assertions can inspect the command built for it. */
class FakeTask {
    constructor(definition, scope, name, source, execution, problemMatchers) {
        this.definition = definition;
        this.scope = scope;
        this.name = name;
        this.source = source;
        this.execution = execution;
        this.problemMatchers = problemMatchers;
        this.isBackground = false;
        this.detail = undefined;
        this.presentationOptions = {};
    }
}

class FakeShellExecution {
    constructor(commandLine, argsOrOptions, maybeOptions) {
        this.kind = 'shell';
        this.commandLine = commandLine;
        this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        this.options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
    }
}

class FakeProcessExecution {
    constructor(process, args, options) {
        this.kind = 'process';
        this.process = process;
        this.args = args ?? [];
        this.options = options;
    }
}

function makeUri(fsPath) {
    return {
        fsPath,
        scheme: 'file',
        path: fsPath,
        toString: () => `file://${fsPath}`,
    };
}

/** Segments the default exclude pattern names; used to prune the walk. */
function excludedSegments(excludePattern) {
    const match = /\{([^}]*)\}/.exec(excludePattern ?? '');
    return new Set(match ? match[1].split(',').map((s) => s.trim()) : []);
}

function walkForTasksJson(root, excluded, found, cap) {
    if (found.length >= cap) {
        return;
    }
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (excluded.has(entry.name)) {
            continue;
        }
        const dir = path.join(root, entry.name);
        if (entry.name === '.vscode') {
            const candidate = path.join(dir, 'tasks.json');
            if (fs.existsSync(candidate)) {
                found.push(candidate);
            }
            continue;
        }
        walkForTasksJson(dir, excluded, found, cap);
    }
}

/**
 * @param {object} options
 * @param {string[]} options.folders      Absolute paths acting as open workspace folders.
 * @param {object[]} options.nativeTasks  Tasks VS Code itself would report.
 * @param {object} options.settings       taskHierarchy.* overrides.
 */
function makeVscodeStub({ folders = [], nativeTasks = [], settings = {} } = {}) {
    const workspaceFolders = folders.length
        ? folders.map((folder, index) => ({
              uri: makeUri(folder),
              name: path.basename(folder),
              index,
          }))
        : undefined;

    const stub = {
        workspace: {
            workspaceFolders,
            getConfiguration: () => ({
                get: (key, fallback) => (key in settings ? settings[key] : fallback),
                update: async () => {},
            }),
            findFiles: async (include, exclude, maxResults) => {
                const excluded = excludedSegments(exclude);
                const found = [];
                for (const folder of folders) {
                    walkForTasksJson(folder, excluded, found, maxResults ?? 1000);
                }
                return found.map(makeUri);
            },
            getWorkspaceFolder: (uri) => {
                const matches = (workspaceFolders ?? []).filter((f) =>
                    uri.fsPath.startsWith(f.uri.fsPath + path.sep)
                );
                // The innermost folder wins, matching how VS Code resolves nesting.
                return matches.sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
            },
            asRelativePath: (uri) => {
                const p = typeof uri === 'string' ? uri : uri.fsPath;
                for (const folder of folders) {
                    if (p.startsWith(folder + path.sep)) {
                        return p.slice(folder.length + 1);
                    }
                }
                return p;
            },
            fs: {
                readFile: async (uri) => fs.readFileSync(uri.fsPath),
                writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data),
            },
            openTextDocument: async (uri) => {
                const text = fs.readFileSync(uri.fsPath, 'utf8');
                return { getText: () => text, positionAt: (o) => ({ offset: o }), eol: 1 };
            },
            applyEdit: async () => true,
        },
        // Task lifecycle events are real emitters here, so a test can drive a run from
        // start to exit and assert on what the tree ends up showing.
        tasks: {
            taskExecutions: [],
            fetchTasks: async () => nativeTasks,
            executeTask: async (task) => {
                const execution = { task, terminate() {} };
                stub.tasks.taskExecutions.push(execution);
                stub.tasks._fire('start', { execution });
                return execution;
            },
            onDidStartTask: (fn) => stub.tasks._on('start', fn),
            onDidEndTask: (fn) => stub.tasks._on('end', fn),
            onDidEndTaskProcess: (fn) => stub.tasks._on('endProcess', fn),

            _listeners: { start: [], end: [], endProcess: [] },
            _on(name, fn) {
                stub.tasks._listeners[name].push(fn);
                return { dispose: () => {} };
            },
            _fire(name, event) {
                for (const fn of [...stub.tasks._listeners[name]]) {
                    fn(event);
                }
            },
            /** Finish a started execution the way VS Code does: process, then task. */
            _finish(execution, exitCode) {
                if (exitCode !== undefined) {
                    stub.tasks._fire('endProcess', { execution, exitCode });
                }
                stub.tasks.taskExecutions = stub.tasks.taskExecutions.filter((e) => e !== execution);
                stub.tasks._fire('end', { execution });
            },
        },
        window: {
            showErrorMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
            // Runs the body immediately with a token that is never cancelled, which is
            // what a sequential group run needs to actually step through its tasks.
            withProgress: (_options, body) =>
                body(
                    { report() {} },
                    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
                ),
        },
        commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose() {} }) },
        Uri: {
            file: makeUri,
            joinPath: (base, ...parts) => makeUri(path.join(base.fsPath, ...parts)),
        },
        Task: FakeTask,
        ShellExecution: FakeShellExecution,
        ProcessExecution: FakeProcessExecution,
        // A real one: cancelling a group run is the thing being tested, so a stub that
        // never fires would make the test pass for the wrong reason.
        CancellationTokenSource: class {
            constructor() {
                this.listeners = [];
                this.token = {
                    isCancellationRequested: false,
                    onCancellationRequested: (listener) => {
                        this.listeners.push(listener);
                        return { dispose: () => {} };
                    },
                };
            }
            cancel() {
                this.token.isCancellationRequested = true;
                for (const listener of [...this.listeners]) {
                    listener();
                }
            }
            dispose() {
                this.listeners = [];
            }
        },
        TaskScope: { Global: 1, Workspace: 2 },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
        TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
        // A working emitter, not a stub: the extension's own events (a task failing, the
        // running set changing) are part of what these tests assert on.
        EventEmitter: class {
            constructor() {
                this.listeners = [];
                this.event = (listener) => {
                    this.listeners.push(listener);
                    return {
                        dispose: () => {
                            this.listeners = this.listeners.filter((l) => l !== listener);
                        },
                    };
                };
            }
            fire(value) {
                for (const listener of [...this.listeners]) {
                    listener(value);
                }
            }
            dispose() {
                this.listeners = [];
            }
        },
        EndOfLine: { LF: 1, CRLF: 2 },
        ThemeIcon: class {
            constructor(id, color) {
                this.id = id;
                this.color = color;
            }
        },
        ThemeColor: class {
            constructor(id) {
                this.id = id;
            }
        },
        TreeItem: class {
            constructor(label, collapsibleState) {
                this.label = label;
                this.collapsibleState = collapsibleState;
            }
        },
        MarkdownString: class {
            constructor(value) {
                this.value = value;
            }
        },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    };
    return stub;
}

/** Load a compiled module from out/src with `vscode` replaced by the stub. */
function loadWithStub(moduleRelativePath, stub) {
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'vscode' ? 'vscode-stub' : original.call(this, request, ...rest);
    };
    require.cache['vscode-stub'] = {
        id: 'vscode-stub',
        filename: 'vscode-stub',
        loaded: true,
        exports: stub,
    };
    try {
        const target = require.resolve(path.join(__dirname, '..', 'out', 'src', moduleRelativePath));
        // Every module in the graph must be re-evaluated so it closes over THIS stub.
        for (const key of Object.keys(require.cache)) {
            if (key.includes(path.join('out', 'src'))) {
                delete require.cache[key];
            }
        }
        return require(target);
    } finally {
        Module._resolveFilename = original;
    }
}

/** Write a fixture tree: { 'a/.vscode/tasks.json': {...} | 'raw text' }. */
function writeFixture(root, files) {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
            target,
            typeof content === 'string' ? content : JSON.stringify(content, null, 4)
        );
    }
    return root;
}

module.exports = {
    makeVscodeStub,
    loadWithStub,
    writeFixture,
    makeUri,
    FakeTask,
    FakeShellExecution,
    FakeProcessExecution,
};
