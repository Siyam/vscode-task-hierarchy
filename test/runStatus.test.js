/**
 * Drives a task from start to exit and asserts on what the tree ends up showing.
 *
 * The run status shipped not working: history was keyed off the vscode.Task object seen
 * in the lifecycle event, and the task VS Code hands back is not guaranteed to be the one
 * fetchTasks() returned. Recording succeeded and the lookup silently missed, so the tree
 * looked exactly as it had before. Nothing caught it, because nothing until now ran a
 * task through the real runner.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { makeVscodeStub, loadWithStub, writeFixture, FakeTask } = require('./harness');

const TMP = path.join(os.tmpdir(), 'task-hierarchy-runstatus');

const TASKS = {
    version: '2.0.0',
    tasks: [
        {
            label: 'build it',
            type: 'shell',
            command: 'echo build',
            detail: '@stage:develop @action:build Compiles everything',
        },
    ],
};

/** A workspace with one runnable task, plus the pieces the tree is built from. */
async function setup() {
    const root = writeFixture(path.join(TMP, `c-${Math.random().toString(36).slice(2)}`), {
        'proj/.vscode/tasks.json': TASKS,
    });
    const stub = makeVscodeStub({ folders: [root] });

    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const { entries } = await loadTasks('@');
    const history = new RunHistory();
    const runner = new TaskRunner(history);
    runner.setEntryResolver((task) => entries.find((e) => e.task === task));

    return { root, stub, entries, history, runner, entry: entries[0] };
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a successful run is recorded against the entry the tree shows', async () => {
    const { stub, runner, entry } = await setup();

    await runner.run(entry);
    const execution = stub.tasks.taskExecutions[0];
    assert.ok(execution, 'the task should be running');
    assert.equal(runner.isRunning(entry), true);
    assert.equal(runner.lastRun(entry)?.status, 'running');

    stub.tasks._finish(execution, 0);

    const run = runner.lastRun(entry);
    assert.ok(run, 'the tree looks up by entry; a miss here is why nothing appeared');
    assert.equal(run.status, 'ok');
    assert.equal(run.exitCode, 0);
    assert.equal(typeof run.durationMs, 'number');
    assert.equal(runner.isRunning(entry), false);
});

test('a non-zero exit is recorded as failed and announced', async () => {
    const { stub, runner, entry } = await setup();

    const failures = [];
    runner.onDidFail((record) => failures.push(record));

    await runner.run(entry);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 2);

    assert.equal(runner.lastRun(entry)?.status, 'failed');
    assert.equal(runner.lastRun(entry)?.exitCode, 2);
    assert.deepEqual(
        failures.map((f) => [f.label, f.exitCode]),
        [['build it', 2]],
        'a failure must be announced so it can be surfaced to the user'
    );
});

test('stopping a task records it as stopped, not failed', async () => {
    const { stub, runner, entry } = await setup();

    await runner.run(entry);
    const execution = stub.tasks.taskExecutions[0];
    await runner.stop(entry);
    // Killing a process reports a non-zero code that is not the task failing.
    stub.tasks._finish(execution, 137);

    assert.equal(runner.lastRun(entry)?.status, 'stopped');
});

test('a task started outside the tree is still matched to its entry', async () => {
    const { stub, runner, entry } = await setup();

    // Cmd+Shift+B, or the task Quick Pick: we never called run(), so the entry has to be
    // recovered from the task in the event.
    const execution = await stub.tasks.executeTask(entry.task);
    stub.tasks._finish(execution, 0);

    assert.equal(runner.lastRun(entry)?.status, 'ok');
});

/** A workspace whose tasks.json VS Code has loaded, so every task has a real Task. */
async function nativeWorkspace(tasks) {
    const root = writeFixture(path.join(TMP, `n-${Math.random().toString(36).slice(2)}`), {
        '.vscode/tasks.json': { version: '2.0.0', tasks },
    });
    const scope = { uri: { fsPath: root, toString: () => `file://${root}` }, name: 'p', index: 0 };
    const nativeTasks = tasks.map((t) => {
        // A composite has no execution - that is what makes it one.
        const execution = t.command ? { kind: 'shell' } : undefined;
        const task = new FakeTask({ type: 'shell' }, scope, t.label, 'Workspace', execution, []);
        task.scope = scope;
        return task;
    });

    const stub = makeVscodeStub({ folders: [root], nativeTasks });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const { entries } = await loadTasks('@');
    const runner = new TaskRunner(new RunHistory());
    runner.setEntryResolver((task) => entries.find((e) => e.task === task));

    const executed = [];
    stub.tasks._listeners.start.push(({ execution }) => executed.push(execution.task.name));

    /** Stand in for VS Code running a composite's steps. */
    const vscodeRunsStep = async (label, exitCode = 0) => {
        const step = entries.find((e) => e.label === label);
        const execution = await stub.tasks.executeTask(step.task);
        stub.tasks._finish(execution, exitCode);
    };

    return { stub, entries, runner, executed, vscodeRunsStep, byLabel: (l) => entries.find((e) => e.label === l) };
}

const PIPELINE = [
    { label: 'clean', type: 'shell', command: 'echo clean' },
    { label: 'publish', type: 'shell', command: 'echo publish' },
    { label: 'staging:api', dependsOn: ['clean', 'publish'], dependsOrder: 'sequence' },
];

test('running a composite hands it to VS Code and starts nothing else', async () => {
    // The whole point: this extension does not resolve dependsOn or sequence anything.
    // VS Code gets the composite exactly as written and runs it with its own semantics.
    const { runner, byLabel, executed } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    assert.equal(composite.isComposite, true);
    await runner.run(composite);

    assert.deepEqual(
        executed,
        ['staging:api'],
        'only the composite is started; its steps are VS Code’s business'
    );
});

test("a composite's status is observed from the steps it names", async () => {
    const { runner, byLabel, vscodeRunsStep } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    await runner.run(composite);
    assert.equal(runner.isRunning(composite), true);
    assert.equal(runner.lastRun(composite)?.status, 'running');

    await vscodeRunsStep('clean', 0);
    assert.equal(runner.isRunning(composite), true, 'still waiting on the second step');

    await vscodeRunsStep('publish', 0);

    const run = runner.lastRun(composite);
    assert.equal(run?.status, 'ok');
    assert.equal(runner.isRunning(composite), false);
});

test('a composite fails when one of its steps does', async () => {
    const { runner, byLabel, vscodeRunsStep } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    const failures = [];
    runner.onDidFail((record) => failures.push(record.label));

    await runner.run(composite);
    // VS Code stops a sequence at the first failure, so "publish" never runs.
    await vscodeRunsStep('clean', 1);

    assert.equal(runner.lastRun(composite)?.status, 'failed');
    assert.ok(failures.includes('staging:api'), 'the composite failure is announced too');
    assert.equal(runner.isRunning(composite), false, 'it must not wait for steps that will never run');
});

test('a native task with its own dependsOn is handed over untouched', async () => {
    const { runner, byLabel, executed } = await nativeWorkspace([
        { label: 'kill ports', type: 'shell', command: 'echo kill' },
        { label: 'build', type: 'shell', command: 'echo build', dependsOn: ['kill ports'] },
    ]);

    const build = byLabel('build');
    assert.equal(build.isComposite, false, 'it has a command of its own');
    await runner.run(build);

    assert.deepEqual(executed, ['build'], 'VS Code runs its dependsOn, not us');
});

test('a composite VS Code has not loaded is refused, with the remedy', async () => {
    // Discovered from a parent folder: there is no VS Code task to hand over, and
    // running it would mean resolving and sequencing its steps here. Refused instead.
    const root = writeFixture(path.join(TMP, `d-${Math.random().toString(36).slice(2)}`), {
        'proj/.vscode/tasks.json': { version: '2.0.0', tasks: PIPELINE },
    });
    const stub = makeVscodeStub({ folders: [root] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const { entries } = await loadTasks('@');
    const composite = entries.find((e) => e.label === 'staging:api');

    assert.equal(composite.task, undefined);
    assert.match(String(composite.blockedReason), /only lists other tasks/);

    const runner = new TaskRunner(new RunHistory());
    const executed = [];
    stub.tasks._listeners.start.push(({ execution }) => executed.push(execution.task.name));

    await runner.run(composite);
    assert.deepEqual(executed, [], 'nothing is started for a task we refuse to run');
    assert.equal(runner.lastRun(composite), undefined);
});

test('the steps of a refused composite still run on their own', async () => {
    const root = writeFixture(path.join(TMP, `d2-${Math.random().toString(36).slice(2)}`), {
        'proj/.vscode/tasks.json': { version: '2.0.0', tasks: PIPELINE },
    });
    const stub = makeVscodeStub({ folders: [root] });
    const { loadTasks } = loadWithStub('taskSource.js', stub);
    const { RunHistory } = loadWithStub('runHistory.js', stub);
    const { TaskRunner } = loadWithStub('runner.js', stub);

    const { entries } = await loadTasks('@');
    const clean = entries.find((e) => e.label === 'clean');
    assert.equal(clean.blockedReason, undefined, 'a plain command task is still runnable');

    const runner = new TaskRunner(new RunHistory());
    runner.setEntryResolver((task) => entries.find((e) => e.task === task));
    await runner.run(clean);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 0);

    assert.equal(runner.lastRun(clean)?.status, 'ok');
});

test('dependsOrder is read as VS Code documents it, for what the tooltip says', async () => {
    const { byLabel } = await nativeWorkspace([
        { label: 'x', type: 'shell', command: 'echo x' },
        { label: 'implicit', dependsOn: ['x'] },
        { label: 'explicit', dependsOn: ['x'], dependsOrder: 'sequence' },
    ]);

    assert.equal(byLabel('implicit').dependsOrder, 'parallel');
    assert.equal(byLabel('explicit').dependsOrder, 'sequence');
});

test('a finished composite keeps the outcome its steps established', async () => {
    // VS Code raises start and end for a composite but reports no exit code, having no
    // process. Recording that as a generic "finished" overwrote the result its steps had
    // already produced, so a successful composite showed neither a tick nor a cross.
    const { runner, byLabel, vscodeRunsStep, stub, entries } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    await runner.run(composite);
    const compositeExecution = stub.tasks.taskExecutions.find(
        (e) => e.task.name === 'staging:api'
    );

    await vscodeRunsStep('clean', 0);
    await vscodeRunsStep('publish', 0);
    assert.equal(runner.lastRun(composite)?.status, 'ok');

    // VS Code now reports the composite itself as finished, with no exit code.
    stub.tasks._finish(compositeExecution, undefined);

    assert.equal(
        runner.lastRun(composite)?.status,
        'ok',
        'the steps all passed, so it passed - not "ended, outcome unknown"'
    );
    assert.equal(runner.isRunning(composite), false);
    assert.equal(entries.length > 0, true);
});

test('a composite whose step failed still reads as failed after VS Code ends it', async () => {
    const { runner, byLabel, vscodeRunsStep, stub } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    await runner.run(composite);
    const compositeExecution = stub.tasks.taskExecutions.find(
        (e) => e.task.name === 'staging:api'
    );

    await vscodeRunsStep('clean', 1);
    stub.tasks._finish(compositeExecution, undefined);

    assert.equal(runner.lastRun(composite)?.status, 'failed');
});

test('stopping a group cancels the run, not just the task that is executing', async () => {
    // Terminating the running task makes runAndWait resolve, and the loop moves on to
    // the next one - so "stop" on a parent stopped one task and started another.
    const { runner, entries, stub } = await nativeWorkspace([
        { label: 'first', type: 'shell', command: 'echo one' },
        { label: 'second', type: 'shell', command: 'echo two' },
        { label: 'third', type: 'shell', command: 'echo three' },
    ]);

    const started = [];
    stub.tasks._listeners.start.push(({ execution }) => {
        started.push(execution.task.name);
        // Stop the group while the first task is running, the way the tree button does.
        if (execution.task.name === 'first') {
            runner.cancelGroup('group-node-id');
        }
        setTimeout(() => stub.tasks._finish(execution, 0), 0);
    });

    await runner.runGroup(entries, 'sequential', 'everything', 'group-node-id');

    assert.deepEqual(started, ['first'], 'nothing after the cancelled task should start');
});

test('stopping a composite terminates the composite, not only its running step', async () => {
    // VS Code drives the chain from the composite's own execution; killing a step alone
    // just lets it start the next one.
    const { runner, byLabel, stub } = await nativeWorkspace(PIPELINE);
    const composite = byLabel('staging:api');

    const terminated = [];
    stub.tasks.executeTask = async (task) => {
        const execution = {
            task,
            terminate() {
                terminated.push(task.name);
            },
        };
        stub.tasks.taskExecutions.push(execution);
        stub.tasks._fire('start', { execution });
        return execution;
    };

    await runner.run(composite);
    await stub.tasks.executeTask(byLabel('clean').task); // VS Code starts the first step
    await runner.stop(composite);

    assert.ok(terminated.includes('staging:api'), 'the composite itself must be terminated');
    assert.ok(terminated.includes('clean'), 'and the step that was running');
});

test('a new run clears what the previous one left on screen', async () => {
    const { runner, entry, stub } = await setup();

    await runner.run(entry);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 1);
    assert.equal(runner.lastRun(entry)?.status, 'failed');

    // What the tree does before starting a run, so old marks do not sit beside a new one.
    runner.history.forget([entry.id]);
    assert.equal(runner.lastRun(entry), undefined, 'the previous result is gone');

    await runner.run(entry);
    assert.equal(runner.lastRun(entry)?.status, 'running');
});

test('stopping a task that is not running leaves nothing behind', async () => {
    // Stopping a group calls stop() on every task under it, most of which are idle.
    // Marking those as stopping left a flag no end event would ever clear, and the next
    // successful run of that task reported itself stopped with an exit code of 0.
    const { runner, entry, stub } = await setup();

    await runner.stop(entry); // never started
    await runner.run(entry);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 0);

    const run = runner.lastRun(entry);
    assert.equal(run?.exitCode, 0);
    assert.equal(run?.status, 'ok', 'exit code 0 is a success, not a stop');
});

test('a stop that never landed does not follow the task into its next run', async () => {
    const { runner, entry, stub } = await setup();

    await runner.run(entry);
    await runner.stop(entry);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 137);
    assert.equal(runner.lastRun(entry)?.status, 'stopped', 'that one really was stopped');

    // The next run is its own; it must not inherit the previous run's stop.
    await runner.run(entry);
    stub.tasks._finish(stub.tasks.taskExecutions[0], 0);
    assert.equal(runner.lastRun(entry)?.status, 'ok');
});
