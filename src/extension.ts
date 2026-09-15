import * as path from 'path';
import * as vscode from 'vscode';
import { Proposal, buildProposals, tagsAsText, writeDetails } from './annotate';
import { SECTION } from './config';
import { DerivationRule, validateTagText } from './derive';
import { collectTagKeys, parseDetail } from './facets';
import { TaskRunner, isBlocked } from './runner';
import { RunHistory, formatDuration, formatRelative } from './runHistory';
import { TaskEntry } from './taskSource';
import { tasksUnder } from './tree';
import { Node, TaskHierarchyProvider } from './treeProvider';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Task Hierarchy');
    // Kept in workspaceState so "last run" survives a window reload, which is most of
    // what makes it worth showing at all.
    const history = new RunHistory(context.workspaceState);
    const runner = new TaskRunner(history);
    const provider = new TaskHierarchyProvider(runner);

    const view = vscode.window.createTreeView('taskHierarchy.tree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    provider.attachView(view);

    // Nothing has been searched yet, so the empty-state welcome must stay hidden.
    void vscode.commands.executeCommand('setContext', 'taskHierarchy.loaded', false);

    const syncRunningContext = (): void => {
        void vscode.commands.executeCommand(
            'setContext',
            'taskHierarchy.anyRunning',
            runner.anyRunning
        );
    };

    // Any tasks.json anywhere in the workspace feeds the tree, not just the ones at a
    // folder root, so the watcher has to be just as broad as discovery is.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/tasks.json');
    const onTasksChanged = (): void => void provider.refresh();

    context.subscriptions.push(
        view,
        provider,
        runner,
        output,
        watcher,
        watcher.onDidChange(onTasksChanged),
        watcher.onDidCreate(onTasksChanged),
        watcher.onDidDelete(onTasksChanged),
        vscode.workspace.onDidChangeWorkspaceFolders(onTasksChanged),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(SECTION)) {
                void provider.refresh();
            }
        }),
        runner.onDidChangeRunning(() => {
            syncRunningContext();
            provider.rebuild();
        }),
        // A task started from the tree scrolls its terminal away behind whatever runs
        // next, so a failure that is not surfaced here is a failure nobody sees.
        runner.onDidFail(async (record) => {
            logRun(output, record);
            if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('notifyOnFailure', true)) {
                return;
            }
            const choice = await vscode.window.showErrorMessage(
                `Task "${record.label}" failed with exit code ${record.exitCode}.`,
                'Show Details',
                'Show Terminal'
            );
            if (choice === 'Show Details') {
                output.show(true);
            } else if (choice === 'Show Terminal') {
                await vscode.commands.executeCommand('workbench.action.tasks.showTasks');
            }
        })
    );

    const register = (command: string, handler: (...args: never[]) => unknown): void => {
        context.subscriptions.push(
            vscode.commands.registerCommand(command, handler as (...args: unknown[]) => unknown)
        );
    };

    register('taskHierarchy.refresh', () => provider.refresh());

    register('taskHierarchy.setFilter', async () => {
        const filter = await vscode.window.showInputBox({
            title: 'Filter Tasks',
            prompt: 'Matches labels, descriptions and facet values. Space-separated terms all have to match.',
            placeHolder: 'staging web',
            value: provider.activeFilter,
        });
        if (filter !== undefined) {
            provider.setFilter(filter);
            view.description = filter.trim() ? `filter: ${filter.trim()}` : undefined;
        }
    });

    register('taskHierarchy.clearFilter', () => {
        provider.setFilter('');
        view.description = undefined;
    });

    register('taskHierarchy.runTask', async (node: Node) => {
        const entry = entryOf(node);
        if (entry) {
            resetStatuses(runner, provider, affectedBy(entry, provider));
            await runner.run(entry);
        }
    });

    register('taskHierarchy.stopTask', async (node: Node) => {
        const entry = entryOf(node);
        if (entry) {
            await runner.stop(entry);
        }
    });

    register('taskHierarchy.runGroup', (node: Node) => runGroup(node, provider, runner));

    register('taskHierarchy.stopGroup', async (node: Node) => {
        // Cancel the run itself first. Terminating the tasks alone only ends the one
        // that is executing, and the group moves on to the next.
        runner.cancelGroup(node.id);
        for (const entry of tasksUnder(node)) {
            await runner.stop(entry);
        }
    });

    register('taskHierarchy.stopAll', () => runner.stopAll());

    register('taskHierarchy.revealInTasksJson', (node: Node) => reveal(entryOf(node)));

    register('taskHierarchy.editTags', (node: Node) => editTags(entryOf(node), provider));

    register('taskHierarchy.annotateFromLabels', () => annotateFromLabels(provider));

    register('taskHierarchy.openTasksJson', () => openTasksJson(provider));

    register('taskHierarchy.addProjectFolder', (target: Node | TaskEntry | undefined) =>
        addProjectFolder(target, provider)
    );

    register('taskHierarchy.showDiagnostics', () => showDiagnostics(provider, runner, output));

    register('taskHierarchy.showRunDetails', (node: Node) =>
        showRunDetails(entryOf(node), runner, output)
    );

    register('taskHierarchy.clearRunHistory', async () => {
        history.clear();
        provider.rebuild();
        vscode.window.showInformationMessage('Task Hierarchy: run history cleared.');
    });

    syncRunningContext();
    void provider.refresh();
}

export function deactivate(): void {
    // Everything is owned by context.subscriptions.
}

function entryOf(node: Node | undefined): TaskEntry | undefined {
    return node?.kind === 'task' ? node.task : undefined;
}

async function runGroup(
    node: Node,
    provider: TaskHierarchyProvider,
    runner: TaskRunner
): Promise<void> {
    const entries = tasksUnder(node);
    if (entries.length === 0) {
        return;
    }

    const threshold = provider.confirmGroupRunThreshold;

    // These groups routinely contain deploy and publish tasks, so starting a batch of
    // them is worth one deliberate click - especially under a "production" node.
    if (threshold >= 0 && entries.length > threshold) {
        const preview = entries
            .slice(0, 10)
            .map((e) => `• ${e.label}`)
            .join('\n');
        const more = entries.length > 10 ? `\n… and ${entries.length - 10} more` : '';
        const confirm = await vscode.window.showWarningMessage(
            `Run ${entries.length} tasks in "${node.label}"?`,
            {
                modal: true,
                detail: `${provider.groupRunMode === 'sequential' ? 'Sequentially' : 'In parallel'}:\n${preview}${more}`,
            },
            'Run'
        );
        if (confirm !== 'Run') {
            return;
        }
    }

    // Clear what the last run left behind, so the marks on screen belong to this run.
    resetStatuses(runner, provider, entries);
    await runner.runGroup(entries, provider.groupRunMode, node.label, node.id);
}

/**
 * The tasks whose status a run invalidates: the task itself, and for one that only lists
 * other tasks, the steps it is about to run.
 */
function affectedBy(entry: TaskEntry, provider: TaskHierarchyProvider): TaskEntry[] {
    if (!entry.isComposite) {
        return [entry];
    }
    const steps = provider.allEntries.filter(
        (candidate) =>
            candidate.fileKey === entry.fileKey && entry.dependsOn.includes(candidate.label)
    );
    return [entry, ...steps];
}

function resetStatuses(
    runner: TaskRunner,
    provider: TaskHierarchyProvider,
    entries: readonly TaskEntry[]
): void {
    runner.history.forget(entries.map((entry) => entry.id));
    provider.rebuild();
}

async function reveal(entry: TaskEntry | undefined): Promise<void> {
    if (!entry) {
        return;
    }
    if (!entry.definition) {
        vscode.window.showInformationMessage(
            `"${entry.label}" is contributed by ${entry.task?.source ?? 'an extension'}, not declared in a tasks.json.`
        );
        return;
    }
    const { uri, offset, length } = entry.definition;
    const document = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + length)
    );
    const editor = await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(range.start, range.start),
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function editTags(
    entry: TaskEntry | undefined,
    provider: TaskHierarchyProvider
): Promise<void> {
    if (!entry) {
        return;
    }
    if (!entry.definition) {
        vscode.window.showWarningMessage(
            `"${entry.label}" is contributed by ${entry.task?.source ?? 'an extension'} and has no tasks.json entry to edit.`
        );
        return;
    }

    const prefix = provider.tagPrefix;
    const value = await vscode.window.showInputBox({
        title: `Grouping for "${entry.label}"`,
        prompt: `Order is the hierarchy: ${prefix}env:staging ${prefix}tenant:acme nests staging › acme.`,
        placeHolder: `${prefix}env:staging ${prefix}tenant:acme`,
        value: tagsAsText(entry, prefix),
        validateInput: (text) => validateTagText(text, prefix),
    });
    if (value === undefined) {
        return;
    }

    const { tags } = parseDetail(value, prefix);
    const detail = [tags.length > 0 ? value.trim() : '', entry.description]
        .filter((part) => part.length > 0)
        .join(' ');

    await writeDetails([{ uri: entry.definition.uri, label: entry.label, detail }]);
    await provider.refresh();
}

/**
 * Bulk-annotate existing tasks by reading their labels.
 *
 * This is the migration path off `:`-and-parenthesis label conventions: the rules turn
 * `publish: web-api (staging)` into facets once, and from then on the facets are
 * what the tree reads. Every proposal is shown and individually deselectable, because a
 * regex over dozens of hand-written labels will always get a few wrong.
 */
async function annotateFromLabels(provider: TaskHierarchyProvider): Promise<void> {
    const rules = vscode.workspace
        .getConfiguration(SECTION)
        .get<DerivationRule[]>('derivationRules', []);

    if (rules.length === 0) {
        // No rules ship with the extension: the levels worth grouping by are particular
        // to each repo, so guessing them would mostly produce a tree nobody wanted.
        const choice = await vscode.window.showWarningMessage(
            'No derivation rules are set. They are regexes that read grouping levels out of ' +
                'your existing task labels, and the order you list them becomes the nesting order.',
            'Open Settings',
            'Show an Example'
        );
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                `${SECTION}.derivationRules`
            );
        } else if (choice === 'Show an Example') {
            await showRuleExample();
        }
        return;
    }

    const scope = await pickAnnotationScope(provider);
    if (!scope) {
        return;
    }

    const proposals = buildProposals(scope.entries, rules, provider.tagPrefix);
    if (proposals.length === 0) {
        vscode.window.showInformationMessage(
            `Nothing to annotate in ${scope.label}: every task already carries the facets these rules derive.`
        );
        return;
    }

    const items = proposals.map((proposal) => ({
        label: proposal.entry.label,
        description: describeAdded(proposal, provider.tagPrefix),
        detail: proposal.entry.folderName || undefined,
        picked: true,
        proposal,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Annotate ${proposals.length} task(s) in ${scope.label}`,
        placeHolder: 'Deselect anything the rules got wrong, then confirm.',
        canPickMany: true,
    });
    if (!picked || picked.length === 0) {
        return;
    }

    const written = await writeDetails(
        picked.map((item) => ({
            uri: item.proposal.entry.definition!.uri,
            label: item.proposal.entry.label,
            detail: item.proposal.newDetail,
        }))
    );

    await provider.refresh();
    vscode.window.showInformationMessage(
        `Annotated ${written} task(s). Review the changes in tasks.json and save.`
    );
}

/**
 * Annotating every discovered tasks.json at once would touch every repo in a folder of
 * checkouts, so the project folder is chosen first.
 */
async function pickAnnotationScope(
    provider: TaskHierarchyProvider
): Promise<{ label: string; entries: readonly TaskEntry[] } | undefined> {
    const editable = provider.allEntries.filter((entry) => entry.definition);
    const folders = [...new Set(editable.map((entry) => entry.folderName))].sort();

    if (folders.length <= 1) {
        return { label: folders[0] ?? 'this workspace', entries: editable };
    }

    const items = [
        { label: 'All project folders', description: `${editable.length} tasks`, folder: undefined },
        ...folders.map((folder) => ({
            label: folder,
            description: `${editable.filter((e) => e.folderName === folder).length} tasks`,
            folder,
        })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Annotate tasks in which project?',
        placeHolder: 'Only the chosen project folder’s tasks.json files are edited.',
    });
    if (!picked) {
        return undefined;
    }
    return {
        label: picked.folder ?? 'all project folders',
        entries: picked.folder
            ? editable.filter((e) => e.folderName === picked.folder)
            : editable,
    };
}

function describeAdded(proposal: Proposal, prefix: string): string {
    return proposal.added.map((tag) => `${prefix}${tag.key}:${tag.values.join(',')}`).join(' ');
}

/**
 * A starting point for derivationRules, opened as an untitled document so it can be
 * copied into settings.json and edited rather than applied blind.
 */
async function showRuleExample(): Promise<void> {
    const example = `// Copy into .vscode/settings.json and edit for your repo.
// Rule order is the hierarchy: the first rule is the outermost level.
"${SECTION}.derivationRules": [
  {
    "key": "env",
    "pattern": "[-\\\\s:(\\\\[]\\\\s*(local|staging|prod|production)\\\\s*[)\\\\]]?\\\\s*$|^(local|staging|prod|production)\\\\s*:",
    "value": "$1$2",
    "map": { "prod": "production" },
    // Without a fallback, a task whose label names no environment starts its path at
    // its own first tag - so environments and services end up side by side at the root.
    "fallback": "local"
  },
  { "key": "service", "pattern": "\\\\b(api|web|worker)\\\\b" },
  { "key": "action",  "pattern": "^\\\\s*(build|clean|publish|package|deploy|serve|test)\\\\b" }
]
`;
    const document = await vscode.workspace.openTextDocument({
        content: example,
        language: 'jsonc',
    });
    await vscode.window.showTextDocument(document);
}

/** Open one of the discovered tasks.json files, or offer to create one. */
async function openTasksJson(provider: TaskHierarchyProvider): Promise<void> {
    const files = provider.discoveredFiles;

    if (files.length === 0) {
        await offerToCreateTasksJson();
        return;
    }
    if (files.length === 1) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0].uri));
        return;
    }

    const picked = await vscode.window.showQuickPick(
        files.map((file) => ({
            label: path.basename(file.projectFolder),
            description: `${file.tasks.length} tasks`,
            detail: vscode.workspace.asRelativePath(file.uri),
            uri: file.uri,
        })),
        { title: 'Open which tasks.json?', matchOnDetail: true }
    );
    if (picked) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(picked.uri));
    }
}

async function offerToCreateTasksJson(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showWarningMessage('Open a folder first, then create a tasks.json in it.');
        return;
    }

    const folder =
        folders.length === 1
            ? folders[0]
            : (
                  await vscode.window.showQuickPick(
                      folders.map((f) => ({ label: f.name, folder: f })),
                      { title: 'Create tasks.json in which folder?' }
                  )
              )?.folder;
    if (!folder) {
        return;
    }

    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
    const template = `{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "example",
            "type": "shell",
            "command": "echo hello",
            "problemMatcher": [],
            // Facets drive the Task Hierarchy tree. Any @key:value pair works.
            "detail": "@env:local @action:run"
        }
    ]
}
`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(template, 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/**
 * Promote a discovered project folder to a real workspace folder.
 *
 * This is the escape hatch for the few things only VS Code can do: `${command:...}` and
 * `${input:...}` variables, and inline problem matchers. Once the folder is part of the
 * workspace, VS Code reads its tasks.json itself and the tree switches to those tasks.
 */
async function addProjectFolder(
    target: Node | TaskEntry | undefined,
    provider: TaskHierarchyProvider
): Promise<void> {
    const folderPath = projectFolderOf(target) ?? (await pickProjectFolder(provider));
    if (!folderPath) {
        return;
    }

    const uri = vscode.Uri.file(folderPath);
    if (vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath === folderPath) {
        vscode.window.showInformationMessage(`${path.basename(folderPath)} is already a workspace folder.`);
        return;
    }

    const added = vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        null,
        { uri }
    );
    if (!added) {
        vscode.window.showErrorMessage(`Could not add ${folderPath} to the workspace.`);
    }
}

function projectFolderOf(target: Node | TaskEntry | undefined): string | undefined {
    if (!target) {
        return undefined;
    }
    if ('kind' in target) {
        return target.kind === 'task' ? target.task.projectFolder : undefined;
    }
    return target.projectFolder;
}

async function pickProjectFolder(provider: TaskHierarchyProvider): Promise<string | undefined> {
    const folders = [...new Set(provider.discoveredFiles.map((f) => f.projectFolder))].sort();
    const picked = await vscode.window.showQuickPick(
        folders.map((folder) => ({
            label: path.basename(folder),
            detail: folder,
            folder,
        })),
        { title: 'Add which project folder to the workspace?', matchOnDetail: true }
    );
    return picked?.folder;
}

/** Explain exactly what was searched and what was found, so an empty tree is debuggable. */
async function showDiagnostics(
    provider: TaskHierarchyProvider,
    runner: TaskRunner,
    output: vscode.OutputChannel
): Promise<void> {
    await provider.refresh();

    const config = vscode.workspace.getConfiguration(SECTION);
    const entries = provider.allEntries;
    const counts = { workspace: 0, discovered: 0, extension: 0 };
    for (const entry of entries) {
        counts[entry.origin]++;
    }

    output.clear();
    output.appendLine('Task Hierarchy diagnostics');
    output.appendLine('='.repeat(60));
    output.appendLine('');
    output.appendLine('Workspace folders:');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        output.appendLine(`  ${folder.name}  ${folder.uri.fsPath}`);
    }
    if (!vscode.workspace.workspaceFolders?.length) {
        output.appendLine('  (none - open a folder for anything to be discovered)');
    }

    output.appendLine('');
    output.appendLine(`Discovery include: ${config.get<string>('discoveryInclude')}`);
    output.appendLine(`Discovery exclude: ${config.get<string>('discoveryExclude')}`);
    output.appendLine('');
    output.appendLine(`tasks.json files found: ${provider.discoveredFiles.length}`);
    for (const file of provider.discoveredFiles) {
        const note = file.error ? `  !! ${file.error}` : '';
        output.appendLine(
            `  ${vscode.workspace.asRelativePath(file.uri)}  (${file.tasks.length} tasks)${note}`
        );
    }

    output.appendLine('');
    output.appendLine(`Tasks VS Code itself reported: ${provider.nativeTaskCount}`);
    output.appendLine(`Tasks shown: ${entries.length}`);
    output.appendLine(`  from a workspace-root tasks.json (VS Code runs them): ${counts.workspace}`);
    output.appendLine(`  discovered (Task Hierarchy runs them):                ${counts.discovered}`);
    output.appendLine(`  contributed by another extension:                     ${counts.extension}`);

    const blocked = entries.filter(isBlocked);
    if (blocked.length > 0) {
        output.appendLine('');
        output.appendLine(`Tasks that cannot be run as discovered (${blocked.length}):`);
        for (const entry of blocked) {
            output.appendLine(
                `  ${entry.folderName} › ${entry.label}  ` +
                    (entry.unsupportedType
                        ? `type "${entry.unsupportedType}" needs its provider extension`
                        : `needs ${entry.unresolved.map((n) => '${' + n + '}').join(', ')}`)
            );
        }
    }

    // Recorded runs, so "nothing is showing" can be answered with data rather than guesswork.
    const runs = entries
        .map((entry) => ({ entry, run: runner.lastRun(entry) }))
        .filter((r) => r.run);
    output.appendLine('');
    output.appendLine(`Tasks with a recorded run: ${runs.length} of ${entries.length}`);
    for (const { entry, run } of runs.slice(0, 15)) {
        const took = run!.durationMs === undefined ? '' : ` in ${formatDuration(run!.durationMs)}`;
        output.appendLine(
            `  ${run!.status.padEnd(8)} ${entry.label}${took}, ${formatRelative(run!.startedAt)}`
        );
    }

    output.appendLine('');
    const keys = collectTagKeys(entries.map((e) => e.tags));
    output.appendLine(`Tag names in use: ${keys.join(', ') || '(none - nothing is tagged yet)'}`);
    const depths = entries.map((e) => e.tags.length);
    output.appendLine(`Nesting depth: ${depths.length ? Math.max(...depths) : 0} level(s) deep`);
    output.appendLine(`Tasks with no tags: ${depths.filter((d) => d === 0).length}`);

    output.show(true);
}

/** One line per finished run, so the channel reads as a log of what happened. */
function logRun(output: vscode.OutputChannel, record: { label: string; status: string; exitCode?: number; durationMs?: number; startedAt: number }): void {
    const time = new Date(record.startedAt).toLocaleTimeString();
    const took = record.durationMs === undefined ? '' : ` in ${formatDuration(record.durationMs)}`;
    const code = record.exitCode === undefined ? '' : ` (exit ${record.exitCode})`;
    output.appendLine(`[${time}] ${record.status.toUpperCase()}${code} ${record.label}${took}`);
}

/**
 * What happened last time this task ran.
 *
 * Exit code, timing and the command, because those are what the task API actually
 * reports. It does not expose a task's output, so the error text itself lives in the
 * task's terminal - which is why this points at it rather than pretending to quote it.
 */
async function showRunDetails(
    entry: TaskEntry | undefined,
    runner: TaskRunner,
    output: vscode.OutputChannel
): Promise<void> {
    if (!entry) {
        return;
    }
    const run = runner.lastRun(entry);
    if (!run) {
        const choice = await vscode.window.showInformationMessage(
            `"${entry.label}" has not run yet.`,
            'Run It'
        );
        if (choice) {
            await runner.run(entry);
        }
        return;
    }

    output.appendLine('');
    output.appendLine('='.repeat(64));
    output.appendLine(entry.label);
    output.appendLine('='.repeat(64));
    output.appendLine(`Status:    ${run.status}`);
    if (run.exitCode !== undefined) {
        output.appendLine(`Exit code: ${run.exitCode}`);
    }
    output.appendLine(
        `Started:   ${new Date(run.startedAt).toLocaleString()} (${formatRelative(run.startedAt)})`
    );
    if (run.durationMs !== undefined) {
        output.appendLine(`Took:      ${formatDuration(run.durationMs)}`);
    }
    output.appendLine(`Folder:    ${entry.folderName}`);
    output.appendLine(`Command:   ${describeCommand(entry)}`);
    if (entry.dependsOn.length > 0) {
        output.appendLine(`Runs:      ${entry.dependsOn.join(' -> ')}`);
    }
    if (run.status === 'failed') {
        output.appendLine('');
        output.appendLine("The task's own output is in its terminal: Terminal > Run Task, or the");
        output.appendLine('terminal dropdown. VS Code does not expose task output to extensions,');
        output.appendLine('so it cannot be shown here.');
    }
    output.show(true);
}

function describeCommand(entry: TaskEntry): string {
    const execution = entry.task?.execution;
    if (execution instanceof vscode.ShellExecution) {
        return execution.commandLine ?? [execution.command, ...(execution.args ?? [])].join(' ');
    }
    if (execution instanceof vscode.ProcessExecution) {
        return [execution.process, ...execution.args].join(' ');
    }
    return entry.dependsOn.length > 0 ? '(runs its dependencies)' : '(unknown)';
}
