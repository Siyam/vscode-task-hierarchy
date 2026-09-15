/**
 * What happened last time each task ran.
 *
 * VS Code's task API reports that a task started, that its process exited, and with what
 * code - but it does not expose the task's output. So a record here can say which task
 * failed, when, how long it took and with what exit code, and can point at the terminal,
 * but it cannot quote the error text. Anything claiming otherwise would be invented.
 *
 * Nothing in this file imports vscode, so the formatting and retention rules are
 * unit-testable directly.
 */

export type RunStatus =
    /** Started and not yet finished. */
    | 'running'
    /** Exited zero. */
    | 'ok'
    /** Exited non-zero. */
    | 'failed'
    /** Terminated from the tree, or by the user. */
    | 'stopped'
    /** Finished with no process to report a code - an aggregate, or a background task. */
    | 'ended';

export interface RunRecord {
    readonly key: string;
    readonly label: string;
    /** Epoch milliseconds. */
    readonly startedAt: number;
    /** Undefined while still running. */
    readonly durationMs?: number;
    readonly exitCode?: number;
    readonly status: RunStatus;
}

/** The slice of `vscode.Memento` this needs, so tests can pass a plain object. */
export interface HistoryStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

const STORAGE_KEY = 'taskHierarchy.runHistory';

/** Enough to cover a workspace's tasks without letting stored state grow unbounded. */
const MAX_RECORDS = 500;

export class RunHistory {
    private records = new Map<string, RunRecord>();

    constructor(private readonly store?: HistoryStore) {
        for (const record of store?.get<RunRecord[]>(STORAGE_KEY) ?? []) {
            // A record left as `running` belongs to a previous session whose end we never
            // saw, so it is not running now - anything else would show a permanent spinner.
            this.records.set(
                record.key,
                record.status === 'running' ? { ...record, status: 'ended' } : record
            );
        }
    }

    get(key: string): RunRecord | undefined {
        return this.records.get(key);
    }

    all(): RunRecord[] {
        return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
    }

    started(key: string, label: string, now = Date.now()): RunRecord {
        return this.set({ key, label, startedAt: now, status: 'running' });
    }

    finished(key: string, outcome: RunOutcome, now = Date.now()): RunRecord | undefined {
        const started = this.records.get(key);
        if (!started) {
            return undefined;
        }
        return this.set({
            ...started,
            durationMs: Math.max(0, now - started.startedAt),
            exitCode: outcome.exitCode,
            status: statusOf(outcome),
        });
    }

    clear(): void {
        this.records.clear();
        void this.store?.update(STORAGE_KEY, []);
    }

    /**
     * Drop the records for these tasks, so a new run starts from a clean slate rather
     * than leaving the previous run's ticks and crosses standing next to it.
     */
    forget(keys: Iterable<string>): void {
        let removed = false;
        for (const key of keys) {
            removed = this.records.delete(key) || removed;
        }
        if (removed) {
            void this.store?.update(STORAGE_KEY, [...this.records.values()]);
        }
    }

    private set(record: RunRecord): RunRecord {
        this.records.set(record.key, record);

        if (this.records.size > MAX_RECORDS) {
            // Drop the oldest, so a long-lived workspace does not accumulate forever.
            const oldest = [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
            for (const stale of oldest.slice(0, this.records.size - MAX_RECORDS)) {
                this.records.delete(stale.key);
            }
        }

        void this.store?.update(STORAGE_KEY, [...this.records.values()]);
        return record;
    }
}

export interface RunOutcome {
    readonly exitCode?: number;
    readonly stopped?: boolean;
    /**
     * Set for a task that has no process of its own - an aggregate - where the outcome
     * comes from whether its steps succeeded rather than from an exit code.
     */
    readonly failed?: boolean;
}

export function statusOf(outcome: RunOutcome): RunStatus {
    if (outcome.stopped) {
        return 'stopped';
    }
    if (outcome.failed !== undefined) {
        return outcome.failed ? 'failed' : 'ok';
    }
    if (outcome.exitCode === undefined) {
        return 'ended';
    }
    return outcome.exitCode === 0 ? 'ok' : 'failed';
}

/** `350ms`, `2.4s`, `1m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
        // One decimal below ten seconds, where the tenth is still meaningful.
        return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, then a date. */
export function formatRelative(then: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 45) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    if (days <= 7) {
        return `${days}d ago`;
    }
    return new Date(then).toLocaleDateString();
}

/** The dimmed text beside a task in the tree. */
export function describeRun(record: RunRecord | undefined, now = Date.now()): string | undefined {
    if (!record) {
        return undefined;
    }
    if (record.status === 'running') {
        return 'running…';
    }

    const parts: string[] = [];
    if (record.status === 'failed') {
        // An aggregate fails because a step failed, not with a code of its own.
        parts.push(record.exitCode === undefined ? 'failed' : `exit ${record.exitCode}`);
    } else if (record.status === 'stopped') {
        parts.push('stopped');
    }
    if (record.durationMs !== undefined) {
        parts.push(formatDuration(record.durationMs));
    }
    parts.push(formatRelative(record.startedAt, now));
    return parts.join(' · ');
}
