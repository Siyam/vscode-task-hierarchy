import * as vscode from 'vscode';
import { Settings, iconFor, readSettings, shouldGroupByFolder } from './config';
import { TaskRunner, isBlocked } from './runner';
import { RunRecord, describeRun, formatDuration, formatRelative } from './runHistory';
import { DiscoveredFile, TaskEntry, loadTasks, workspaceFolderOf } from './taskSource';
import { GroupNode, TaskNode, TreeNode, buildTree, matchesFilter } from './tree';

export type Node = TreeNode<TaskEntry>;

export class TaskHierarchyProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private settings: Settings = readSettings();
    private entries: TaskEntry[] = [];
    private files: readonly DiscoveredFile[] = [];
    private nativeCount = 0;
    private roots: Node[] = [];
    private parents = new Map<string, Node>();
    private filter = '';
    private loading: Promise<void> | undefined;
    /** False until the first load finishes, so "nothing found" is never claimed early. */
    private loaded = false;
    private view: vscode.TreeView<Node> | undefined;

    constructor(private readonly runner: TaskRunner) {
        runner.setEntryResolver((task) => this.entryForTask(task));
    }

    /**
     * Match a running task back to its tree entry.
     *
     * Object identity first, which is exact for anything started from the tree. A task
     * started elsewhere - the build shortcut, the task Quick Pick - arrives as a
     * different object, so fall back to the folder and name it was declared with, and
     * finally to the name alone when it is unambiguous.
     */
    private entryForTask(task: vscode.Task): TaskEntry | undefined {
        const byIdentity = this.entries.find((entry) => entry.task === task);
        if (byIdentity) {
            return byIdentity;
        }

        const folderPath = workspaceFolderOf(task)?.uri.fsPath;
        const sameName = this.entries.filter((entry) => entry.label === task.name);
        return (
            sameName.find((entry) => entry.projectFolder === folderPath) ??
            (sameName.length === 1 ? sameName[0] : undefined)
        );
    }

    dispose(): void {
        this.changed.dispose();
    }

    /** The view is needed to show progress and a message while the first load runs. */
    attachView(view: vscode.TreeView<Node>): void {
        this.view = view;
    }

    get hasLoaded(): boolean {
        return this.loaded;
    }

    /** Every task currently known, regardless of filter. */
    get allEntries(): readonly TaskEntry[] {
        return this.entries;
    }

    get discoveredFiles(): readonly DiscoveredFile[] {
        return this.files;
    }

    get nativeTaskCount(): number {
        return this.nativeCount;
    }

    get activeFilter(): string {
        return this.filter;
    }

    get tagPrefix(): string {
        return this.settings.tagPrefix;
    }

    get groupRunMode(): 'sequential' | 'parallel' {
        return this.settings.groupRunMode;
    }

    get confirmGroupRunThreshold(): number {
        return this.settings.confirmGroupRunThreshold;
    }

    /** Re-read settings and tasks from scratch. */
    async refresh(): Promise<void> {
        // Collapse concurrent refreshes - a tasks.json save plus a config change plus a
        // task ending can easily land in the same tick, and discovery is not cheap.
        this.loading ??= this.reload().finally(() => {
            this.loading = undefined;
        });
        await this.loading;
    }

    /** Rebuild the tree from cached tasks - for cheap changes like filter or run state. */
    rebuild(): void {
        this.roots = this.build();
        this.indexParents();
        this.changed.fire(undefined);
    }

    setFilter(filter: string): void {
        this.filter = filter.trim();
        void vscode.commands.executeCommand(
            'setContext',
            'taskHierarchy.filtered',
            this.filter.length > 0
        );
        this.rebuild();
    }

    private async reload(): Promise<void> {
        this.settings = readSettings();

        // Searching the workspace takes a moment, and an empty tree in the meantime is
        // indistinguishable from a workspace with no tasks - so say which it is. The
        // progress bar is the one VS Code draws in this view's own title.
        if (!this.loaded && this.view) {
            this.view.message = 'Looking for tasks…';
        }

        await vscode.window.withProgress(
            { location: { viewId: 'taskHierarchy.tree' } },
            async () => {
                try {
                    const result = await loadTasks(this.settings.tagPrefix);
                    this.entries = [...result.entries];
                    this.files = result.files;
                    this.nativeCount = result.nativeCount;
                } catch (error) {
                    this.entries = [];
                    this.files = [];
                    vscode.window.showErrorMessage(
                        `Task Hierarchy could not load tasks: ${String(error)}`
                    );
                }
            }
        );

        this.loaded = true;
        if (this.view) {
            this.view.message = undefined;
        }
        // Gates the "no tasks found" welcome, which must not appear before this point.
        void vscode.commands.executeCommand('setContext', 'taskHierarchy.loaded', true);

        this.rebuild();
    }

    private build(): Node[] {
        const tasks = this.filter
            ? this.entries.filter((entry) => matchesFilter(entry, this.filter))
            : this.entries;

        const distinctFolders = new Set(this.entries.map((e) => e.folderName)).size;
        return buildTree(tasks, {
            ...this.settings,
            groupByFolder: shouldGroupByFolder(this.settings, distinctFolders),
        });
    }

    private indexParents(): void {
        this.parents = new Map();
        const walk = (node: Node, parent: Node | undefined): void => {
            if (parent) {
                this.parents.set(node.id, parent);
            }
            if (node.kind === 'group') {
                node.children.forEach((child) => walk(child, node));
            }
        };
        this.roots.forEach((root) => walk(root, undefined));
    }

    getChildren(element?: Node): Node[] {
        if (!element) {
            return this.roots;
        }
        return element.kind === 'group' ? [...element.children] : [];
    }

    getParent(element: Node): Node | undefined {
        return this.parents.get(element.id);
    }

    getTreeItem(node: Node): vscode.TreeItem {
        return node.kind === 'group' ? this.groupItem(node) : this.taskItem(node);
    }

    private groupItem(node: GroupNode<TaskEntry>): vscode.TreeItem {
        const running = node.children.some((child) => this.isRunningNode(child));
        // A filter is a search: showing the hits requires the path to them to be open.
        const state = this.filter
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;

        const item = new vscode.TreeItem(node.label, state);
        item.id = node.id;
        item.description = `${node.taskCount}`;
        item.contextValue = running ? 'groupRunning' : 'group';
        item.iconPath = new vscode.ThemeIcon(iconFor(this.settings, node.tagKey, node.label));
        const level = node.path.filter((s) => s.key !== 'folder').length;
        item.tooltip = new vscode.MarkdownString(
            [
                node.tagKey === 'folder'
                    ? `**Project folder**: \`${node.label}\``
                    : node.tagKey === ''
                      ? '_Tasks with no grouping tags._'
                      : `Level ${level} — **${node.tagKey}**: \`${node.label}\``,
                '',
                `${node.taskCount} task${node.taskCount === 1 ? '' : 's'}`,
            ].join('\n')
        );
        return item;
    }

    private taskItem(node: TaskNode<TaskEntry>): vscode.TreeItem {
        const entry = node.task;
        const running = this.runner.isRunning(entry);
        const blocked = isBlocked(entry);
        const run = this.runner.lastRun(entry);

        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;

        // What happened last takes the visible slot, because it changes and the prose
        // does not; the prose stays in the tooltip.
        item.description = describeRun(run) ?? (entry.description || undefined);
        item.contextValue = running ? 'taskRunning' : 'task';
        item.iconPath = this.taskIcon({ running, blocked, run, isAggregate: !entry.task });
        item.tooltip = this.taskTooltip(entry, node.label, run);

        const click = this.settings.clickAction;
        if (click === 'run') {
            item.command = { command: 'taskHierarchy.runTask', title: 'Run Task', arguments: [node] };
        } else if (click === 'runDetails' && run) {
            item.command = {
                command: 'taskHierarchy.showRunDetails',
                title: 'Show Last Run',
                arguments: [node],
            };
        } else if ((click === 'reveal' || click === 'runDetails') && entry.definition) {
            // Nothing has run yet, so the definition is the only thing worth opening.
            item.command = {
                command: 'taskHierarchy.revealInTasksJson',
                title: 'Go to Definition',
                arguments: [node],
            };
        }
        return item;
    }

    private taskIcon(state: {
        running: boolean;
        blocked: boolean;
        run: RunRecord | undefined;
        isAggregate: boolean;
    }): vscode.ThemeIcon {
        if (state.running) {
            return new vscode.ThemeIcon('sync~spin');
        }
        if (state.blocked) {
            return new vscode.ThemeIcon('warning');
        }
        if (state.run?.status === 'failed') {
            return new vscode.ThemeIcon(
                'error',
                new vscode.ThemeColor('problemsErrorIcon.foreground')
            );
        }
        if (state.run?.status === 'ok') {
            return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        }
        return new vscode.ThemeIcon(state.isAggregate ? 'list-ordered' : 'terminal');
    }

    private taskTooltip(
        entry: TaskEntry,
        shortLabel: string,
        run: RunRecord | undefined
    ): vscode.MarkdownString {
        const lines = [`**${entry.label}**`];
        if (shortLabel !== entry.label) {
            lines.push('', `_shown as_ \`${shortLabel}\``);
        }
        if (entry.description) {
            lines.push('', entry.description);
        }

        if (entry.tags.length > 0) {
            lines.push(
                '',
                'Grouped as:',
                ...entry.tags.map(
                    (tag, index) => `${index + 1}. \`${tag.key}\` → ${tag.values.join(', ')}`
                )
            );
        } else {
            lines.push('', '_No grouping tags. Use_ **Edit Tags…** _to add some._');
        }

        if (entry.dependsOn.length > 0) {
            lines.push(
                '',
                `VS Code runs ${entry.dependsOrder === 'parallel' ? 'in parallel' : 'in order'}:`,
                ...entry.dependsOn.map((label) => `1. ${label}`)
            );
        }

        if (run) {
            lines.push('', '---', '', describeLastRun(run));
        }

        lines.push('', `Folder: \`${entry.folderName}\``, originNote(entry));

        if (entry.blockedReason) {
            lines.push(
                '',
                `⚠ Cannot be started from here: it ${entry.blockedReason}. ` +
                    'Add this project folder to the workspace and VS Code will run it.'
            );
        }

        const tooltip = new vscode.MarkdownString(lines.join('\n'));
        tooltip.supportThemeIcons = true;
        return tooltip;
    }

    private isRunningNode(node: Node): boolean {
        if (node.kind === 'task') {
            return this.runner.isRunning(node.task);
        }
        return node.children.some((child) => this.isRunningNode(child));
    }
}

/** The run summary shown in a task's tooltip. */
export function describeLastRun(run: RunRecord): string {
    const when = `${formatRelative(run.startedAt)} (${new Date(run.startedAt).toLocaleString()})`;
    switch (run.status) {
        case 'running':
            return `**Running** since ${when}`;
        case 'failed':
            return `**Failed** — exit code ${run.exitCode}, after ${formatDuration(run.durationMs ?? 0)}, ${when}`;
        case 'stopped':
            return `**Stopped** after ${formatDuration(run.durationMs ?? 0)}, ${when}`;
        case 'ok':
            return `**Succeeded** in ${formatDuration(run.durationMs ?? 0)}, ${when}`;
        default:
            return `**Finished** after ${formatDuration(run.durationMs ?? 0)}, ${when}`;
    }
}

function originNote(entry: TaskEntry): string {
    switch (entry.origin) {
        case 'workspace':
            return 'Source: tasks.json (run by VS Code)';
        case 'discovered':
            return 'Source: discovered tasks.json (run by Task Hierarchy)';
        default:
            return `Source: ${entry.task?.source ?? 'extension'}`;
    }
}
