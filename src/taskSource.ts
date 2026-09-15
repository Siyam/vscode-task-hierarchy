import * as path from 'path';
import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { Tag, parseDetail } from './facets';
import { RawTask, synthesize } from './synthesize';

/**
 * Finding the tasks to show.
 *
 * VS Code only reads `.vscode/tasks.json` at each workspace folder root, so opening a
 * folder of checkouts leaves every project's tasks invisible to it. This module searches
 * the whole workspace for tasks.json files instead, and for any it finds that VS Code did
 * not load, builds runnable tasks itself.
 */

export type TaskOrigin =
    /** Declared in a tasks.json at a workspace folder root; VS Code owns it. */
    | 'workspace'
    /** Declared in a tasks.json VS Code does not read; this extension runs it. */
    | 'discovered'
    /** Contributed by another extension (npm, dotnet, ...); no tasks.json entry. */
    | 'extension';

export interface TaskEntry {
    /** Undefined for a pure `dependsOn` aggregate, which has no command of its own. */
    readonly task: vscode.Task | undefined;
    /** Stable across refreshes: used as the tree item id and to track running state. */
    readonly id: string;
    readonly label: string;
    /** Grouping levels in written order; the tree nests by this sequence. */
    readonly tags: readonly Tag[];
    /** `detail` with tags stripped - the prose half, if any. */
    readonly description: string;
    readonly detail: string | undefined;
    readonly origin: TaskOrigin;
    /** Absolute path of the folder holding the `.vscode` directory. */
    readonly projectFolder: string;
    /** Label for the project-folder tree level, e.g. `sample-project/SyncService`. */
    readonly folderName: string;
    /** The tasks.json this came from; also the scope for resolving `dependsOn` labels. */
    readonly fileKey: string;
    readonly folder: vscode.WorkspaceFolder | undefined;
    /** Where in tasks.json this task is declared, when we could find it. */
    readonly definition: DefinitionSite | undefined;
    readonly dependsOn: readonly string[];
    readonly dependsOrder: 'sequence' | 'parallel';
    /**
     * No command of its own - it exists only to run other tasks. VS Code creates no
     * process for one and fires no task events, so its steps have to be run here or
     * nothing ever knows it ran.
     */
    readonly isComposite: boolean;
    /**
     * Why this task cannot be started from here, or undefined when it can. Running is
     * always VS Code executing one task; anything that would require orchestrating
     * several is refused rather than reimplemented.
     */
    readonly blockedReason: string | undefined;
    /** Variables that could not be resolved; running is refused with this explanation. */
    readonly unresolved: readonly string[];
    /** Provider task type (`npm`, `dotnet`, …) this extension cannot run on its own. */
    readonly unsupportedType: string | undefined;
}

export interface DefinitionSite {
    readonly uri: vscode.Uri;
    /** Character offset of the task object within the file. */
    readonly offset: number;
    readonly length: number;
}

export interface ParsedTask {
    readonly raw: RawTask;
    readonly label: string;
    readonly detail: string | undefined;
    readonly hide: boolean;
    readonly site: DefinitionSite;
}

export interface DiscoveredFile {
    readonly uri: vscode.Uri;
    /** Folder containing the `.vscode` directory. */
    readonly projectFolder: string;
    readonly folder: vscode.WorkspaceFolder | undefined;
    readonly tasks: readonly ParsedTask[];
    readonly error: string | undefined;
}

export interface LoadResult {
    readonly entries: readonly TaskEntry[];
    readonly files: readonly DiscoveredFile[];
    readonly nativeCount: number;
}

/**
 * NUL, because it is the one character that cannot appear in a path, a task source or a
 * task name - so no combination of those can collide by spelling the separator itself.
 */
const KEY_SEPARATOR = '\u0000';

export const DEFAULT_INCLUDE = '**/.vscode/tasks.json';
export const DEFAULT_EXCLUDE =
    '**/{node_modules,bower_components,.git,bin,obj,dist,out,build,target,vendor,.venv,venv,Pods}/**';

export async function loadTasks(tagPrefix: string): Promise<LoadResult> {
    const config = vscode.workspace.getConfiguration('taskHierarchy');
    const [native, files] = await Promise.all([
        fetchNativeTasks(),
        discoverTaskFiles(
            config.get<string>('discoveryInclude', DEFAULT_INCLUDE),
            config.get<string>('discoveryExclude', DEFAULT_EXCLUDE),
            config.get<number>('discoveryMaxFiles', 200)
        ),
    ]);

    // A native task is keyed by the folder it is scoped to, which for a root tasks.json
    // is exactly that file's project folder - that is how the two sources are matched up.
    const nativeByKey = new Map<string, vscode.Task>();
    for (const task of native) {
        nativeByKey.set(nativeKey(folderPathOf(task), task.name), task);
    }

    const entries: TaskEntry[] = [];
    const claimed = new Set<string>();

    for (const file of files) {
        for (const parsed of file.tasks) {
            if (parsed.hide) {
                continue;
            }

            const key = nativeKey(file.projectFolder, parsed.label);
            const nativeTask = nativeByKey.get(key);
            if (nativeTask) {
                claimed.add(key);
            }

            // VS Code's own task is always preferred when it has one: it resolves
            // variables, honours inline problem matchers and runs dependsOn itself.
            const built = nativeTask
                ? undefined
                : synthesize(
                      parsed.raw,
                      file.projectFolder,
                      file.folder ?? vscode.TaskScope.Workspace
                  );

            if (!nativeTask && !built) {
                continue; // No command and no dependencies - nothing runnable to show.
            }

            const detail = parsed.detail ?? nativeTask?.detail;
            const { tags, description } = parseDetail(detail, tagPrefix);

            // Read from the file rather than from whichever task object we ended up with:
            // VS Code's Task carries no dependsOn, so a natively-loaded composite would
            // otherwise look like an ordinary task with nothing to run.
            const dependsOn = asStringArray(parsed.raw.dependsOn);
            // VS Code runs dependsOn in parallel unless the file says otherwise, and
            // these steps have to behave the same way whoever is running them.
            const dependsOrder = parsed.raw.dependsOrder === 'sequence' ? 'sequence' : 'parallel';
            const hasOwnExecution = nativeTask ? nativeTask.execution !== undefined : !!built?.task;
            const isComposite = !hasOwnExecution && dependsOn.length > 0;

            entries.push({
                task: nativeTask ?? built?.task,
                id: `${file.uri.toString()}#${parsed.label}`,
                label: parsed.label,
                tags,
                description,
                detail,
                origin: nativeTask ? 'workspace' : 'discovered',
                projectFolder: file.projectFolder,
                folderName: displayFolderName(file.projectFolder, file.folder),
                fileKey: file.uri.toString(),
                folder: file.folder,
                definition: parsed.site,
                dependsOn,
                dependsOrder,
                isComposite,
                blockedReason: blockedReason(
                    built?.unresolved ?? [],
                    built?.unsupportedType,
                    isComposite && !nativeTask
                ),
                unresolved: built?.unresolved ?? [],
                unsupportedType: built?.unsupportedType,
            });
        }
    }

    // Whatever is left is contributed by another extension rather than by a tasks.json.
    for (const task of native) {
        if (claimed.has(nativeKey(folderPathOf(task), task.name))) {
            continue;
        }
        const folder = workspaceFolderOf(task);
        const { tags, description } = parseDetail(task.detail, tagPrefix);
        entries.push({
            task,
            id: `extension:${task.source}#${folder?.uri.toString() ?? ''}#${task.name}`,
            label: task.name,
            tags,
            description,
            detail: task.detail,
            origin: 'extension',
            projectFolder: folder?.uri.fsPath ?? '',
            folderName: folder?.name ?? '',
            fileKey: '',
            folder,
            definition: undefined,
            dependsOn: [],
            dependsOrder: 'parallel',
            isComposite: false,
            blockedReason: undefined,
            unresolved: [],
            unsupportedType: undefined,
        });
    }

    return { entries, files, nativeCount: native.length };
}

async function fetchNativeTasks(): Promise<vscode.Task[]> {
    try {
        return await vscode.tasks.fetchTasks();
    } catch {
        // A misbehaving task provider must not take the whole tree down with it.
        return [];
    }
}

/** Search the workspace for tasks.json files and parse each one. */
export async function discoverTaskFiles(
    include: string,
    exclude: string,
    maxFiles: number
): Promise<DiscoveredFile[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
        return [];
    }

    const uris = await vscode.workspace.findFiles(include, exclude || undefined, maxFiles);
    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    return Promise.all(
        uris.map(async (uri) => {
            // <project>/.vscode/tasks.json -> <project>
            const projectFolder = path.dirname(path.dirname(uri.fsPath));
            const parsed = await parseTasksFile(uri);
            return {
                uri,
                projectFolder,
                folder: vscode.workspace.getWorkspaceFolder(uri),
                tasks: parsed.tasks,
                error: parsed.error,
            };
        })
    );
}

/** The label shown at the project-folder level: path relative to its workspace folder. */
export function displayFolderName(
    projectFolder: string,
    folder: vscode.WorkspaceFolder | undefined
): string {
    if (!folder) {
        return path.basename(projectFolder);
    }
    const relative = path.relative(folder.uri.fsPath, projectFolder);
    // A tasks.json at the workspace folder root has no relative path of its own.
    return relative.length === 0 ? folder.name : relative;
}

function nativeKey(folderPath: string, label: string): string {
    return [folderPath, label].join(KEY_SEPARATOR);
}

function folderPathOf(task: vscode.Task): string {
    return workspaceFolderOf(task)?.uri.fsPath ?? '';
}

export function workspaceFolderOf(task: vscode.Task): vscode.WorkspaceFolder | undefined {
    const scope = task.scope;
    if (scope && typeof scope === 'object' && 'uri' in scope) {
        return scope as vscode.WorkspaceFolder;
    }
    return undefined;
}

/**
 * Identity for a running execution. Task lifecycle events hand back a `vscode.Task`, not
 * the entry it came from, so both sides are reduced to source + folder + name to match.
 */
export function executionKey(task: vscode.Task): string {
    return [task.source, folderPathOf(task), task.name].join(KEY_SEPARATOR);
}

export function entryExecutionKey(entry: TaskEntry): string {
    // An aggregate has no execution, so it gets a key in the same shape that no
    // real execution can produce: empty source and folder.
    return entry.task ? executionKey(entry.task) : ['', '', entry.label].join(KEY_SEPARATOR);
}

interface ParseResult {
    readonly tasks: ParsedTask[];
    readonly error: string | undefined;
}

/**
 * The three things that stop a task being handed to VS Code.
 *
 * The last is the interesting one: a composite only names other tasks, and running it
 * means running those. VS Code does that correctly - resolving names across the whole
 * workspace, including tasks other extensions provide and the object form of
 * `dependsOn`, and waiting for a background step to signal readiness. Reproducing any of
 * that here would be a second, worse task engine, so a composite VS Code has not loaded
 * is refused with the remedy that makes it load it.
 */
function blockedReason(
    unresolved: readonly string[],
    unsupportedType: string | undefined,
    compositeWithoutHost: boolean
): string | undefined {
    if (unresolved.length > 0) {
        const names = unresolved.map((n) => `\${${n}}`).join(', ');
        return `uses ${names}, which only VS Code can resolve`;
    }
    if (unsupportedType) {
        return `is a "${unsupportedType}" task, which needs the extension that provides that type`;
    }
    if (compositeWithoutHost) {
        return 'only lists other tasks to run, and VS Code has not loaded this tasks.json, so it cannot run them';
    }
    return undefined;
}

function asStringArray(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Parse one tasks.json. Reports a problem rather than throwing, so a bad file is visible. */
export async function parseTasksFile(uri: vscode.Uri): Promise<ParseResult> {
    let text: string;
    try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (error) {
        return { tasks: [], error: `could not be read (${String(error)})` };
    }

    // parseTree keeps offsets, which the plain parse() loses - and tasks.json is JSONC,
    // so the comments in a hand-maintained file must not break this.
    const errors: jsonc.ParseError[] = [];
    const root = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    const tasksNode = root && jsonc.findNodeAtLocation(root, ['tasks']);

    // The parser recovers, so a truncated file can still yield a usable `tasks` array.
    // Reporting the syntax error either way matters: without it a half-saved file loads
    // some of its tasks and silently omits the rest, with nothing to say why.
    const syntaxError =
        errors.length > 0
            ? `contains a JSON syntax error (${errors.length} problem${errors.length === 1 ? '' : 's'}); some tasks may be missing`
            : undefined;

    if (!tasksNode || tasksNode.type !== 'array' || !tasksNode.children) {
        return { tasks: [], error: syntaxError ?? 'has no "tasks" array' };
    }

    const tasks: ParsedTask[] = [];
    for (const node of tasksNode.children) {
        const value = jsonc.getNodeValue(node) as RawTask | undefined;
        const label = value && typeof value.label === 'string' ? value.label : undefined;
        if (!value || !label) {
            continue;
        }
        tasks.push({
            raw: value,
            label,
            detail: typeof value.detail === 'string' ? value.detail : undefined,
            hide: value.hide === true,
            site: { uri, offset: node.offset, length: node.length },
        });
    }
    return { tasks, error: syntaxError };
}
