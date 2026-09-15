import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    HistoryStore,
    RunHistory,
    RunRecord,
    describeRun,
    formatDuration,
    formatRelative,
    statusOf,
} from '../src/runHistory';

/** Stands in for vscode.Memento. */
function store(initial: RunRecord[] = []): HistoryStore & { saved: RunRecord[] } {
    const state: { saved: RunRecord[] } = { saved: initial };
    return {
        saved: initial,
        get: <T>() => state.saved as unknown as T,
        update(_key: string, value: unknown) {
            state.saved = value as RunRecord[];
            this.saved = state.saved;
        },
    };
}

const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);

test('a finished run records its duration and exit code', () => {
    const history = new RunHistory();
    history.started('k', 'build', T0);
    const record = history.finished('k', { exitCode: 0 }, T0 + 2400);

    assert.equal(record?.status, 'ok');
    assert.equal(record?.durationMs, 2400);
    assert.equal(history.get('k')?.label, 'build');
});

test('a non-zero exit is a failure and keeps the code', () => {
    const history = new RunHistory();
    history.started('k', 'publish', T0);
    const record = history.finished('k', { exitCode: 1 }, T0 + 500);

    assert.equal(record?.status, 'failed');
    assert.equal(record?.exitCode, 1);
});

test('a task we stopped is not reported as a failure', () => {
    // Killing a process produces an exit code that is not the task failing.
    assert.equal(statusOf({ exitCode: 137, stopped: true }), 'stopped');
    assert.equal(statusOf({ exitCode: 137 }), 'failed');
});

test('no exit code means finished, not succeeded', () => {
    // Aggregates and background tasks have no process to report one, and claiming
    // success for something we did not observe would be a lie.
    assert.equal(statusOf({}), 'ended');
});

test('finishing a run nobody started is ignored', () => {
    const history = new RunHistory();
    assert.equal(history.finished('unknown', { exitCode: 0 }), undefined);
});

test('history is persisted through the store and read back', () => {
    const backing = store();
    const first = new RunHistory(backing);
    first.started('k', 'test', T0);
    first.finished('k', { exitCode: 0 }, T0 + 1000);

    const reloaded = new RunHistory(backing);
    assert.equal(reloaded.get('k')?.status, 'ok');
    assert.equal(reloaded.get('k')?.durationMs, 1000);
});

test('a run left running by a previous session is not shown as still running', () => {
    const backing = store([{ key: 'k', label: 'watch', startedAt: T0, status: 'running' }]);
    const reloaded = new RunHistory(backing);

    // Otherwise the window reopens with a permanent spinner on a task that is not running.
    assert.equal(reloaded.get('k')?.status, 'ended');
});

test('clear empties both memory and the store', () => {
    const backing = store();
    const history = new RunHistory(backing);
    history.started('k', 'x', T0);
    history.clear();

    assert.equal(history.get('k'), undefined);
    assert.deepEqual(backing.saved, []);
});

test('an aggregate takes its outcome from its steps, not an exit code', () => {
    const history = new RunHistory();

    history.started('agg', 'staging:sync-service', T0);
    assert.equal(history.finished('agg', { failed: false }, T0 + 5000)?.status, 'ok');

    history.started('agg2', 'staging:billing-worker', T0);
    const failed = history.finished('agg2', { failed: true }, T0 + 5000);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.exitCode, undefined, 'there is no process to report one');
});

test('a failed aggregate reads as failed rather than "exit undefined"', () => {
    const record = {
        key: 'agg',
        label: 'staging:sync-service',
        startedAt: T0 - 60_000,
        durationMs: 5000,
        status: 'failed' as const,
    };
    assert.equal(describeRun(record, T0), 'failed · 5.0s · 1m ago');
});

test('formatDuration scales with the magnitude', () => {
    assert.equal(formatDuration(350), '350ms');
    assert.equal(formatDuration(2400), '2.4s');
    assert.equal(formatDuration(24000), '24s');
    assert.equal(formatDuration(65000), '1m 05s');
    assert.equal(formatDuration(3_720_000), '1h 02m');
});

test('formatRelative reads as an age, then falls back to a date', () => {
    const now = T0;
    assert.equal(formatRelative(now - 10_000, now), 'just now');
    assert.equal(formatRelative(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatRelative(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(formatRelative(now - 2 * 86_400_000, now), '2d ago');
    assert.match(formatRelative(now - 40 * 86_400_000, now), /\d/);
});

test('the tree description leads with what went wrong', () => {
    const base = { key: 'k', label: 'publish', startedAt: T0 - 300_000 };

    assert.equal(
        describeRun({ ...base, status: 'failed', exitCode: 2, durationMs: 1500 }, T0),
        'exit 2 · 1.5s · 5m ago'
    );
    assert.equal(describeRun({ ...base, status: 'ok', durationMs: 1500 }, T0), '1.5s · 5m ago');
    assert.equal(
        describeRun({ ...base, status: 'stopped', durationMs: 900 }, T0),
        'stopped · 900ms · 5m ago'
    );
    assert.equal(describeRun({ ...base, status: 'running' }, T0), 'running…');
    assert.equal(describeRun(undefined), undefined);
});
