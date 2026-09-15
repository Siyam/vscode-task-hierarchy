/**
 * Loads the built bundle the way VS Code does, with `vscode` stubbed out.
 *
 * The unit tests import from `src/` through tsc's output, so they never touch
 * `dist/extension.js` and cannot catch a bundling fault. One did ship: esbuild resolved
 * jsonc-parser's UMD entry, whose indirect `require()` calls it could not follow, leaving
 * them in the bundle to fail at load with "Cannot find module './impl/format'". The
 * extension never activated, and every command was reported as not found.
 *
 * Plain JS and not part of the tsc project, because it deliberately loads compiled output
 * rather than source.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const BUNDLE = path.join(__dirname, '..', 'dist', 'extension.js');

/** Enough of the vscode API surface that nothing fails for an unrelated reason. */
function stubVscode() {
    class Emitter {
        constructor() {
            this.event = () => ({ dispose() {} });
        }
        fire() {}
        dispose() {}
    }
    const noop = () => ({ dispose() {} });

    return {
        window: {
            createOutputChannel: () => ({
                appendLine() {},
                clear() {},
                show() {},
                dispose() {},
            }),
            createTreeView: () => ({ dispose() {} }),
            showErrorMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showQuickPick: async () => undefined,
            showInputBox: async () => undefined,
            withProgress: async (_options, task) =>
                task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: noop }),
            visibleTextEditors: [],
            activeTextEditor: undefined,
        },
        workspace: {
            workspaceFolders: undefined,
            getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
            createFileSystemWatcher: () => ({
                onDidChange: noop,
                onDidCreate: noop,
                onDidDelete: noop,
                dispose() {},
            }),
            onDidChangeWorkspaceFolders: noop,
            onDidChangeConfiguration: noop,
            findFiles: async () => [],
            openTextDocument: async () => ({ getText: () => '', positionAt: () => ({}) }),
            getWorkspaceFolder: () => undefined,
            asRelativePath: (p) => String(p),
            applyEdit: async () => true,
            fs: { readFile: async () => Buffer.from(''), writeFile: async () => {} },
        },
        tasks: {
            taskExecutions: [],
            fetchTasks: async () => [],
            executeTask: async () => ({ terminate() {} }),
            onDidStartTask: noop,
            onDidEndTask: noop,
            onDidEndTaskProcess: noop,
        },
        commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (u) => u },
        EventEmitter: Emitter,
        Task: class {},
        ShellExecution: class {},
        ProcessExecution: class {},
        TreeItem: class {},
        ThemeIcon: class {},
        MarkdownString: class {},
        Range: class {},
        WorkspaceEdit: class {},
        TaskScope: { Workspace: 1 },
        TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
        TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        ProgressLocation: { Notification: 15 },
        QuickPickItemKind: { Separator: -1 },
        TextEditorRevealType: { InCenter: 2 },
        EndOfLine: { LF: 1, CRLF: 2 },
    };
}

function loadBundle() {
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'vscode' ? 'vscode-stub' : original.call(this, request, ...rest);
    };
    require.cache['vscode-stub'] = {
        id: 'vscode-stub',
        filename: 'vscode-stub',
        loaded: true,
        exports: stubVscode(),
    };

    try {
        delete require.cache[require.resolve(BUNDLE)];
        return require(BUNDLE);
    } finally {
        Module._resolveFilename = original;
    }
}

test('the built bundle loads without throwing', () => {
    const extension = loadBundle();
    assert.equal(typeof extension.activate, 'function', 'must export activate()');
    assert.equal(typeof extension.deactivate, 'function', 'must export deactivate()');
});

test('the bundle has no unbundled runtime requires beyond node builtins and vscode', () => {
    const source = require('node:fs').readFileSync(BUNDLE, 'utf8');
    const allowed = new Set([
        'vscode', 'os', 'path', 'fs', 'util', 'events', 'stream', 'url', 'assert',
        'child_process', 'crypto', 'buffer', 'string_decoder',
    ]);

    const found = new Set();
    for (const match of source.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        const id = match[1].replace(/^node:/, '');
        if (!allowed.has(id)) {
            found.add(match[1]);
        }
    }

    assert.deepEqual(
        [...found],
        [],
        'these were left as runtime requires and will not resolve inside the extension host'
    );
});

test('activate() runs against a bare workspace without throwing', () => {
    const extension = loadBundle();
    const subscriptions = [];
    extension.activate({ subscriptions });
    assert.ok(subscriptions.length > 0, 'activate() must register disposables');
});
