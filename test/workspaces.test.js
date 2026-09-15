/**
 * The workspace-shape matrix.
 *
 * Every permutation that caused confusion in practice gets a case here: a project opened
 * directly, a folder of checkouts opened one level up, a project with nested sub-projects,
 * multi-root, and nothing open at all. Plus the malformed and awkward inputs a real
 * tasks.json collection contains.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { makeVscodeStub, loadWithStub, writeFixture, FakeTask } = require('./harness');

const TMP = path.join(os.tmpdir(), 'task-hierarchy-fixtures');

/** Run loadTasks() against a fixture tree and return the entries. */
async function load({ files, folders, nativeTasks = [], settings = {} }) {
    const root = writeFixture(path.join(TMP, `case-${Math.random().toString(36).slice(2)}`), files);
    const stub = makeVscodeStub({
        folders: folders.map((f) => (f === '.' ? root : path.join(root, f))),
        nativeTasks,
        settings,
    });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const result = await loadTasks('@');
    return { root, stub, ...result };
}

function byLabel(entries, label) {
    const found = entries.find((e) => e.label === label);
    assert.ok(found, `no task labelled "${label}" (have: ${entries.map((e) => e.label).join(', ')})`);
    return found;
}

const SIMPLE = {
    version: '2.0.0',
    tasks: [
        {
            label: 'publish (staging)',
            type: 'shell',
            command: 'echo publish',
            detail: '@env:staging @action:publish',
        },
    ],
};

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- workspace shapes

test('project opened directly: VS Code owns the task, we do not duplicate it', async () => {
    const files = { '.vscode/tasks.json': SIMPLE };
    const root = writeFixture(path.join(TMP, 'direct'), files);

    // At a folder root VS Code loads tasks.json itself, so fetchTasks reports it.
    const native = new FakeTask({ type: 'shell' }, { uri: { fsPath: root }, name: 'direct' },
        'publish (staging)', 'Workspace', null, []);
    native.scope = { uri: { fsPath: root, toString: () => `file://${root}` }, name: 'direct', index: 0 };

    const stub = makeVscodeStub({ folders: [root], nativeTasks: [native] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries } = await loadTasks('@');

    assert.equal(entries.length, 1, 'the task must appear exactly once, not twice');
    assert.equal(entries[0].origin, 'workspace', 'VS Code runs it, so we defer to its task');
    assert.equal(entries[0].task, native);
    assert.deepEqual(entries[0].tags, [
        { key: 'env', values: ['staging'] },
        { key: 'action', values: ['publish'] },
    ]);
});

test('folder of checkouts opened one level up: nested projects are still found', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'repo-a/.vscode/tasks.json': SIMPLE,
            'repo-b/.vscode/tasks.json': SIMPLE,
        },
    });

    // This is the case VS Code cannot do at all: it only reads tasks.json at a folder root.
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.origin === 'discovered'));
    assert.deepEqual(entries.map((e) => e.folderName).sort(), ['repo-a', 'repo-b']);
});

test('a project with nested sub-projects keeps each tasks.json separate', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'root', type: 'shell', command: 'echo root' }] },
            'ServiceA/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'inner', type: 'shell', command: 'echo inner' }] },
        },
    });

    assert.equal(entries.length, 2);
    // The root file's folder shows as the workspace folder name; the nested one by path.
    assert.equal(byLabel(entries, 'inner').folderName, 'ServiceA');
    assert.notEqual(byLabel(entries, 'root').folderName, 'ServiceA');
});

test('multi-root: tasks from every folder appear, tagged to their own folder', async () => {
    const root = writeFixture(path.join(TMP, 'multiroot'), {
        'one/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'a', type: 'shell', command: 'echo a' }] },
        'two/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'b', type: 'shell', command: 'echo b' }] },
    });
    const stub = makeVscodeStub({ folders: [path.join(root, 'one'), path.join(root, 'two')] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries } = await loadTasks('@');

    assert.deepEqual(entries.map((e) => e.label).sort(), ['a', 'b']);
    assert.deepEqual(entries.map((e) => e.folderName).sort(), ['one', 'two']);
});

test('no folder open: nothing is discovered and nothing throws', async () => {
    const stub = makeVscodeStub({ folders: [] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries, files } = await loadTasks('@');

    assert.deepEqual(entries, []);
    assert.deepEqual(files, []);
});

test('a workspace folder with no .vscode yields nothing', async () => {
    const { entries } = await load({ folders: ['.'], files: { 'src/index.ts': 'export {};' } });
    assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------- malformed input

test('a tasks.json with a syntax error is reported, not thrown, and others still load', async () => {
    const { entries, files } = await load({
        folders: ['.'],
        files: {
            'broken/.vscode/tasks.json': '{ "version": "2.0.0", "tasks": [ { "label": ',
            'good/.vscode/tasks.json': SIMPLE,
        },
    });

    const broken = files.find((f) => f.uri.fsPath.includes('broken'));
    assert.match(broken.error, /syntax error/);
    assert.equal(entries.length, 1, 'the healthy file must still contribute its task');
    assert.equal(entries[0].folderName, 'good');
});

test('a tasks.json with no tasks array is reported rather than crashing', async () => {
    const { files } = await load({
        folders: ['.'],
        files: { 'p/.vscode/tasks.json': { version: '2.0.0' } },
    });
    assert.match(files[0].error, /no "tasks" array/);
});

test('comments and trailing commas parse, as they must for a hand-maintained file', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': `{
                // The build everyone runs.
                "version": "2.0.0",
                "tasks": [
                    {
                        "label": "build", /* inline */
                        "type": "shell",
                        "command": "make",
                        "detail": "@action:build",
                    },
                ],
            }`,
        },
    });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].tags, [{ key: 'action', values: ['build'] }]);
});

test('"hide": true keeps a task out, matching the task Quick Pick', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [
                    { label: 'shown', type: 'shell', command: 'echo a' },
                    { label: 'hidden', type: 'shell', command: 'echo b', hide: true },
                ],
            },
        },
    });
    assert.deepEqual(entries.map((e) => e.label), ['shown']);
});

test('the excluded-directory pattern is honoured', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'node_modules/pkg/.vscode/tasks.json': SIMPLE,
            'real/.vscode/tasks.json': SIMPLE,
        },
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].folderName, 'real');
});

// ---------------------------------------------------------------- synthesis

test('shell and process tasks build the right execution, with cwd defaulting to the project', async () => {
    const { entries, root } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [
                    { label: 'sh', type: 'shell', command: 'echo hi' },
                    { label: 'proc', type: 'process', command: 'dotnet', args: ['build', '${workspaceFolder}/a.csproj'] },
                ],
            },
        },
    });

    const sh = byLabel(entries, 'sh').task;
    assert.equal(sh.execution.kind, 'shell');
    assert.equal(sh.execution.options.cwd, path.join(root, 'p'));

    const proc = byLabel(entries, 'proc').task;
    assert.equal(proc.execution.kind, 'process');
    assert.equal(proc.execution.process, 'dotnet');
    // ${workspaceFolder} means the folder holding .vscode, not the opened root.
    assert.deepEqual(proc.execution.args, ['build', path.join(root, 'p') + '/a.csproj']);
});

test('a task with no type at all is treated as a shell task, as VS Code does', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: { 'p/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'x', command: 'echo x' }] } },
    });
    assert.equal(byLabel(entries, 'x').task.execution.kind, 'shell');
});

test('a dependsOn aggregate has no execution and lists its steps in order', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [
                    { label: 'clean', type: 'shell', command: 'echo clean' },
                    { label: 'publish', type: 'shell', command: 'echo publish' },
                    { label: 'release', dependsOn: ['clean', 'publish'], dependsOrder: 'sequence' },
                ],
            },
        },
    });

    const release = byLabel(entries, 'release');
    assert.equal(release.task, undefined, 'an aggregate has no command of its own');
    assert.deepEqual(release.dependsOn, ['clean', 'publish']);
    assert.equal(release.dependsOrder, 'sequence');
});

test('an npm script task is translated to an npm invocation', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [
                    { label: 'npm: build', type: 'npm', script: 'build' },
                    { label: 'npm: install', type: 'npm', script: 'install' },
                ],
            },
        },
    });

    assert.deepEqual(byLabel(entries, 'npm: build').task.execution.args, ['run', 'build']);
    assert.deepEqual(byLabel(entries, 'npm: install').task.execution.args, ['install']);
});

test('a provider task type we cannot reproduce is listed as blocked, not dropped', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [{ label: 'gulp thing', type: 'gulp', task: 'thing' }],
            },
        },
    });

    const entry = byLabel(entries, 'gulp thing');
    assert.equal(entry.unsupportedType, 'gulp');
    assert.equal(entry.task, undefined);
});

test('a task needing ${input:} is listed as blocked with the variable named', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [{ label: 'deploy', type: 'shell', command: 'deploy ${input:tenant}' }],
            },
        },
    });

    const entry = byLabel(entries, 'deploy');
    assert.deepEqual(entry.unresolved, ['input:tenant']);
    // Still listed, so the tree explains itself rather than silently omitting the task.
    assert.ok(entry.task, 'the task is built; running it is what gets refused');
});

test('the osx override replaces only the keys it names', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'p/.vscode/tasks.json': {
                version: '2.0.0',
                tasks: [
                    {
                        label: 'platform',
                        type: 'shell',
                        command: 'default-cmd',
                        detail: '@action:run',
                        osx: { command: 'mac-cmd' },
                    },
                ],
            },
        },
    });

    const entry = byLabel(entries, 'platform');
    if (process.platform === 'darwin') {
        assert.equal(entry.task.execution.commandLine, 'mac-cmd');
    }
    assert.deepEqual(entry.tags, [{ key: 'action', values: ['run'] }], 'keys not named by the override survive');
});

test('the same label in two projects stays two distinct tasks', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            'a/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'echo a' }] },
            'b/.vscode/tasks.json': { version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'echo b' }] },
        },
    });

    assert.equal(entries.length, 2);
    assert.equal(new Set(entries.map((e) => e.id)).size, 2, 'ids must not collide across projects');
});

test('an extension-contributed task with no tasks.json entry is still listed', async () => {
    const root = writeFixture(path.join(TMP, 'contributed'), { 'src/x.ts': '' });
    const native = new FakeTask({ type: 'npm' }, undefined, 'npm: test', 'npm', null, []);
    native.scope = { uri: { fsPath: root, toString: () => `file://${root}` }, name: 'contributed', index: 0 };

    const stub = makeVscodeStub({ folders: [root], nativeTasks: [native] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries } = await loadTasks('@');

    assert.equal(entries.length, 1);
    assert.equal(entries[0].origin, 'extension');
    assert.equal(entries[0].definition, undefined, 'there is no file to reveal or annotate');
});

test('a failing fetchTasks does not take discovery down with it', async () => {
    const root = writeFixture(path.join(TMP, 'provider-blows-up'), { 'p/.vscode/tasks.json': SIMPLE });
    const stub = makeVscodeStub({ folders: [root] });
    stub.tasks.fetchTasks = async () => {
        throw new Error('a task provider threw');
    };
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries } = await loadTasks('@');

    assert.equal(entries.length, 1, 'discovered tasks survive a broken provider');
});

// ---------------------------------------------------------------- the real file

test('a real tasks.json parses and every task is accounted for', async (t) => {
    // Point TASK_HIERARCHY_FIXTURE at a real tasks.json to run the whole pipeline over
    // it. Skipped by default, since it depends on a checkout this repo does not contain.
    const real = process.env.TASK_HIERARCHY_FIXTURE;
    if (!real || !fs.existsSync(real)) {
        t.skip('set TASK_HIERARCHY_FIXTURE to a tasks.json to run this');
        return;
    }

    const root = path.join(TMP, 'real');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'project', '.vscode'), { recursive: true });
    fs.copyFileSync(real, path.join(root, 'project', '.vscode', 'tasks.json'));

    const stub = makeVscodeStub({ folders: [root] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { entries, files } = await loadTasks('@');

    assert.equal(files.length, 1);
    assert.equal(files[0].error, undefined, 'the real file must parse cleanly');

    const declared = files[0].tasks.filter((task) => !task.hide).length;
    assert.equal(entries.length, declared, 'every declared task must be represented');

    const blocked = entries.filter((e) => e.unresolved.length > 0 || e.unsupportedType);
    assert.deepEqual(blocked, [], 'no task in this file should be unrunnable');

    const aggregates = entries.filter((e) => !e.task);
    assert.ok(aggregates.length > 0, 'the pipeline tasks are dependsOn aggregates');
});

test('the empty-state message is withheld until a search has actually finished', async () => {
    // An empty tree during discovery looks exactly like a workspace with no tasks, and
    // the welcome view says so in as many words - which is a guess until we have looked.
    const root = writeFixture(path.join(TMP, 'loading'), { 'p/.vscode/tasks.json': SIMPLE });
    const stub = makeVscodeStub({ folders: [root] });

    const contexts = [];
    stub.commands.executeCommand = async (command, key, value) => {
        if (command === 'setContext') {
            contexts.push([key, value]);
        }
    };

    const { TaskHierarchyProvider } = loadWithStub('treeProvider.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const provider = new TaskHierarchyProvider(new TaskRunner(new RunHistory()));

    const messages = [];
    provider.attachView({
        set message(value) {
            messages.push(value);
        },
        get message() {
            return messages[messages.length - 1];
        },
    });

    assert.equal(provider.hasLoaded, false, 'nothing has been searched yet');

    await provider.refresh();

    assert.equal(provider.hasLoaded, true);
    assert.ok(
        messages.includes('Looking for tasks…'),
        'the view should say what it is doing while it does it'
    );
    assert.equal(messages[messages.length - 1], undefined, 'and stop saying it once done');
    assert.deepEqual(
        contexts.filter(([key]) => key === 'taskHierarchy.loaded'),
        [['taskHierarchy.loaded', true]],
        'the welcome view is gated on this, so it must only be set after the search'
    );
});

test('a second refresh does not re-announce that it is looking', async () => {
    const root = writeFixture(path.join(TMP, 'loading2'), { 'p/.vscode/tasks.json': SIMPLE });
    const stub = makeVscodeStub({ folders: [root] });
    const { TaskHierarchyProvider } = loadWithStub('treeProvider.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const provider = new TaskHierarchyProvider(new TaskRunner(new RunHistory()));
    const messages = [];
    provider.attachView({ set message(v) { messages.push(v); }, get message() { return undefined; } });

    await provider.refresh();
    const afterFirst = messages.length;
    // Saving a tasks.json refreshes; flashing a banner every time would be noise.
    await provider.refresh();

    assert.ok(
        !messages.slice(afterFirst).includes('Looking for tasks…'),
        'only the first search is worth announcing'
    );
});
