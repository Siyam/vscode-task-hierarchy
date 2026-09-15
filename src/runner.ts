import * as vscode from 'vscode';
import { RunHistory, RunRecord } from './runHistory';
import { TaskEntry, entryExecutionKey, executionKey } from './taskSource';

/**
 * Starts tasks and watches what happens to them.
 *
 * The rule this follows: **running a task is always VS Code executing one task.** Nothing
 * here resolves `dependsOn`, sequences steps or decides what runs next. A composite is
 * handed to VS Code exactly as written, and VS Code runs its steps with its own
 * semantics - names resolved across the whole workspace, tasks other extensions provide,
 * the object form of `dependsOn`, waiting on a background step's ready pattern. None of
 * that is reproduced here, because a second task engine that disagrees with the real one
 * in small ways is worse than no second task engine.
 *
 * The cost is that VS Code creates no process for a composite and reports nothing about
 * it, so its status is inferred from the steps it names. That inference can be wrong at
 * the edges - two composites sharing a step, say - and being wrong there costs an
 * inaccurate badge, where being wrong about execution would cost the user a build.
 */
export type EntryResolver = (task: vscode.Task) => TaskEntry | undefined;

/** A task that cannot be handed to VS Code as a single execution. */
export function isBlocked(entry: TaskEntry): boolean {
    return entry.blockedReason !== undefined;
}

/** How one step of a tree-group run turned out. */
interface StepResult {
    readonly exitCode?: number;
    /** Distinct from a non-zero code: a step we refused to start has failed too. */
    readonly failed: boolean;
}

/** A composite in flight, waiting on the steps it names. */
interface CompositeWatch {
    readonly entryId: string;
    /** Step labels not yet seen to finish. */
    readonly pending: Set<string>;
    failed: boolean;
    timer: ReturnType<typeof setTimeout>;
    /** Resolved once the run is judged over, with whether it failed. */
    readonly settle: (failed: boolean) => void;
}

/**
 * How long a composite waits with nothing happening before it records what it saw.
 * VS Code stops a sequence at its first failure, so the steps after it never start and
 * their absence is the only signal that the run is over.
 */
const COMPOSITE_QUIESCENCE_MS = 10_000;

export class TaskRunner implements vscode.Disposable {
    private readonly executions = new Map<string, vscode.TaskExecution[]>();
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly failedEvent = new vscode.EventEmitter<RunRecord>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Exit codes seen on onDidEndTaskProcess, consumed by onDidEndTask. */
    private readonly exitCodes = new Map<string, number | undefined>();
    /** Keys we terminated ourselves, so a stop is not reported as a failure. */
    private readonly stopping = new Set<string>();
    private readonly composites = new Map<string, CompositeWatch>();
    /** In-flight group runs, so stopping one can cancel the loop and not just a task. */
    private readonly groupRuns = new Map<string, vscode.CancellationTokenSource>();

    readonly onDidChangeRunning = this.changed.event;
    readonly onDidFail = this.failedEvent.event;

    constructor(
        readonly history: RunHistory,
        private resolveEntry: EntryResolver = () => undefined
    ) {
        for (const execution of vscode.tasks.taskExecutions) {
            this.track(execution);
        }
        this.disposables.push(
            vscode.tasks.onDidStartTask((e) => {
                this.track(e.execution);
                this.history.started(this.historyKey(e.execution.task), e.execution.task.name);
                this.changed.fire();
            }),
            // Carries the exit code, and fires before onDidEndTask. Tasks with no process
            // never fire it, which is why the code is stored rather than read at the end.
            vscode.tasks.onDidEndTaskProcess((e) => {
                this.exitCodes.set(this.historyKey(e.execution.task), e.exitCode);
            }),
            vscode.tasks.onDidEndTask((e) => this.onTaskEnded(e.execution))
        );
    }

    dispose(): void {
        for (const watch of this.composites.values()) {
            clearTimeout(watch.timer);
        }
        for (const source of this.groupRuns.values()) {
            source.cancel();
            source.dispose();
        }
        this.disposables.forEach((d) => d.dispose());
        this.changed.dispose();
        this.failedEvent.dispose();
    }

    setEntryResolver(resolver: EntryResolver): void {
        this.resolveEntry = resolver;
    }

    lastRun(entry: TaskEntry): RunRecord | undefined {
        return this.history.get(entry.id);
    }

    isRunning(entry: TaskEntry): boolean {
        if (entry.isComposite) {
            return this.composites.has(entry.id);
        }
        return (this.executions.get(entryExecutionKey(entry))?.length ?? 0) > 0;
    }

    get anyRunning(): boolean {
        return this.executions.size > 0 || this.composites.size > 0;
    }

    /** Hand one task to VS Code. Nothing here decides what else should run. */
    async run(entry: TaskEntry): Promise<void> {
        if (isBlocked(entry)) {
            await this.reportBlocked(entry);
            return;
        }
        if (!entry.task) {
            return;
        }
        if (entry.isComposite) {
            void this.watchComposite(entry);
        }
        await vscode.tasks.executeTask(entry.task);
    }

    async stop(entry: TaskEntry): Promise<void> {
        if (entry.isComposite) {
            // Terminating only the running step lets VS Code start the next one - the
            // composite's own execution is what drives the chain, so it has to go too.
            const watch = this.composites.get(entry.id);
            for (const execution of vscode.tasks.taskExecutions) {
                const isTheComposite = this.resolveEntry(execution.task)?.id === entry.id;
                const isOneOfItsSteps = watch?.pending.has(execution.task.name) ?? false;
                if (isTheComposite || isOneOfItsSteps) {
                    this.stopping.add(this.historyKey(execution.task));
                    execution.terminate();
                }
            }
            return;
        }

        // Marked before terminating so the end event reports "stopped" rather than
        // whatever exit code killing the process happens to produce.
        this.stopping.add(entry.id);
        for (const execution of this.executions.get(entryExecutionKey(entry)) ?? []) {
            execution.terminate();
        }
    }

    stopAll(): void {
        for (const execution of vscode.tasks.taskExecutions) {
            this.stopping.add(this.historyKey(execution.task));
            execution.terminate();
        }
    }

    /**
     * Run the tasks under a tree group.
     *
     * This is the extension's own feature, over a set the user picked by clicking a node -
     * not an interpretation of anything written in tasks.json. Sequential stops at the
     * first failure, because these groups are usually pipelines where a later step
     * consumes an earlier step's output.
     */
    /** Cancel an in-flight group run started under this key. */
    cancelGroup(runKey: string): void {
        this.groupRuns.get(runKey)?.cancel();
    }

    async runGroup(
        entries: readonly TaskEntry[],
        mode: 'sequential' | 'parallel',
        groupLabel: string,
        runKey = groupLabel
    ): Promise<boolean> {
        if (entries.length === 0) {
            return true;
        }

        // Its own source, so stopping the group from the tree cancels the loop. Without
        // it, terminating the running task only lets the next one start.
        const source = new vscode.CancellationTokenSource();
        this.groupRuns.set(runKey, source);

        try {
            return await this.runGroupWithin(entries, mode, groupLabel, source);
        } finally {
            this.groupRuns.delete(runKey);
            source.dispose();
        }
    }

    private async runGroupWithin(
        entries: readonly TaskEntry[],
        mode: 'sequential' | 'parallel',
        groupLabel: string,
        source: vscode.CancellationTokenSource
    ): Promise<boolean> {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Task Hierarchy: ${groupLabel}`,
                cancellable: true,
            },
            async (progress, progressToken) => {
                // The notification's own cancel button feeds the same source, so there is
                // one thing to check no matter where the stop came from.
                progressToken.onCancellationRequested(() => source.cancel());
                const token = source.token;

                if (mode === 'parallel') {
                    progress.report({ message: `${entries.length} tasks in parallel` });
                    const results = await Promise.all(
                        entries.map((entry) => this.runAndWait(entry, token))
                    );
                    const failures = results.filter((r) => r.failed).length;
                    if (failures > 0) {
                        vscode.window.showErrorMessage(
                            `${failures} of ${entries.length} tasks in "${groupLabel}" failed.`
                        );
                    }
                    return failures === 0;
                }

                let succeeded = true;
                for (const [index, entry] of entries.entries()) {
                    if (token.isCancellationRequested) {
                        vscode.window.showWarningMessage(
                            `Stopped after ${index} of ${entries.length} tasks in "${groupLabel}".`
                        );
                        return false;
                    }
                    progress.report({
                        message: `(${index + 1}/${entries.length}) ${entry.label}`,
                        increment: index === 0 ? 0 : 100 / entries.length,
                    });

                    const result = await this.runAndWait(entry, token);
                    if (result.failed) {
                        succeeded = false;
                        const why =
                            result.exitCode === undefined
                                ? 'could not be run'
                                : `exited with code ${result.exitCode}`;
                        const choice = await vscode.window.showErrorMessage(
                            `"${entry.label}" ${why}. ` +
                                `${entries.length - index - 1} task(s) not started.`,
                            'Continue Anyway',
                            'Stop'
                        );
                        if (choice !== 'Continue Anyway') {
                            return false;
                        }
                    }
                }
                return succeeded;
            }
        );
    }

    /** Start one task and resolve once it has finished. */
    private async runAndWait(
        entry: TaskEntry,
        token: vscode.CancellationToken
    ): Promise<StepResult> {
        if (isBlocked(entry)) {
            await this.reportBlocked(entry);
            return { failed: true };
        }
        if (!entry.task) {
            return { failed: false };
        }

        if (entry.isComposite) {
            // VS Code runs the steps; this waits for the watch rather than tracking them.
            const settled = this.watchComposite(entry);
            await vscode.tasks.executeTask(entry.task);
            return { failed: await settled };
        }

        const execution = await vscode.tasks.executeTask(entry.task);
        if (entry.task.isBackground) {
            // Not meant to exit, so there is nothing to wait for.
            return { failed: false };
        }

        return new Promise<StepResult>((resolve) => {
            let exitCode: number | undefined;
            const subscriptions: vscode.Disposable[] = [];
            const finish = (code: number | undefined): void => {
                subscriptions.forEach((d) => d.dispose());
                resolve({ exitCode: code, failed: code !== undefined && code !== 0 });
            };

            subscriptions.push(
                vscode.tasks.onDidEndTaskProcess((e) => {
                    if (e.execution === execution) {
                        exitCode = e.exitCode;
                    }
                }),
                vscode.tasks.onDidEndTask((e) => {
                    if (e.execution === execution) {
                        finish(exitCode);
                    }
                }),
                token.onCancellationRequested(() => {
                    execution.terminate();
                    finish(undefined);
                })
            );
        });
    }

    /**
     * Watch a composite's steps. Resolves with whether it failed.
     *
     * Purely observational: it records what the steps did and changes nothing about how
     * VS Code runs them.
     */
    private watchComposite(entry: TaskEntry): Promise<boolean> {
        const existing = this.composites.get(entry.id);
        if (existing) {
            clearTimeout(existing.timer);
            this.composites.delete(entry.id);
        }

        this.history.started(entry.id, entry.label);

        return new Promise<boolean>((resolve) => {
            const watch: CompositeWatch = {
                entryId: entry.id,
                pending: new Set(entry.dependsOn),
                failed: false,
                settle: resolve,
                timer: setTimeout(
                    () => this.settleComposite(entry.id),
                    COMPOSITE_QUIESCENCE_MS
                ),
            };
            this.composites.set(entry.id, watch);
            this.changed.fire();
        });
    }

    private settleComposite(entryId: string): void {
        const watch = this.composites.get(entryId);
        if (!watch) {
            return;
        }
        clearTimeout(watch.timer);
        this.composites.delete(entryId);

        const record = this.history.finished(entryId, { failed: watch.failed });
        if (record?.status === 'failed') {
            this.failedEvent.fire(record);
        }
        this.changed.fire();
        watch.settle(watch.failed);
    }

    /** Feed a finished task into any composite waiting on it. */
    private updateComposites(task: vscode.Task, failed: boolean): void {
        for (const watch of [...this.composites.values()]) {
            if (!watch.pending.has(task.name)) {
                continue;
            }
            watch.pending.delete(task.name);
            watch.failed ||= failed;
            clearTimeout(watch.timer);

            if (watch.pending.size === 0 || watch.failed) {
                // Either every named step finished, or one failed and VS Code will not
                // start the rest of a sequence.
                this.settleComposite(watch.entryId);
            } else {
                watch.timer = setTimeout(
                    () => this.settleComposite(watch.entryId),
                    COMPOSITE_QUIESCENCE_MS
                );
            }
        }
    }

    private onTaskEnded(execution: vscode.TaskExecution): void {
        const entry = this.resolveEntry(execution.task);

        // VS Code does raise start and end for a composite, it just never reports an exit
        // code because there is no process. Writing the generic "finished, code unknown"
        // record here would overwrite the outcome its steps established - which is what
        // left a completed composite showing neither a tick nor a cross. Its own end
        // event is the best signal that it is over, so settle the watch on it instead.
        if (entry?.isComposite) {
            this.untrack(execution);
            this.settleComposite(entry.id);
            return;
        }

        const key = this.historyKey(execution.task);
        const record = this.history.finished(key, {
            exitCode: this.exitCodes.get(key),
            stopped: this.stopping.has(key),
        });
        this.exitCodes.delete(key);
        this.stopping.delete(key);
        this.untrack(execution);

        if (record?.status === 'failed') {
            this.failedEvent.fire(record);
        }
        this.updateComposites(execution.task, record?.status === 'failed');
        this.changed.fire();
    }

    /** History key for a task: the tree entry it belongs to, when we can find one. */
    private historyKey(task: vscode.Task): string {
        return this.resolveEntry(task)?.id ?? executionKey(task);
    }

    private async reportBlocked(entry: TaskEntry): Promise<void> {
        const choice = await vscode.window.showErrorMessage(
            `"${entry.label}" ${entry.blockedReason}. ` +
                `Add ${entry.folderName} to the workspace to run it.`,
            'Add Folder to Workspace'
        );
        if (choice) {
            await vscode.commands.executeCommand('taskHierarchy.addProjectFolder', entry);
        }
    }

    private track(execution: vscode.TaskExecution): void {
        const key = executionKey(execution.task);
        const list = this.executions.get(key) ?? [];
        list.push(execution);
        this.executions.set(key, list);
    }

    private untrack(execution: vscode.TaskExecution): void {
        const key = executionKey(execution.task);
        const list = (this.executions.get(key) ?? []).filter((e) => e !== execution);
        if (list.length > 0) {
            this.executions.set(key, list);
        } else {
            this.executions.delete(key);
        }
    }
}
