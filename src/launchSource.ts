import * as path from 'path';
import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { Tag, parseDetail } from './facets';
import { DefinitionSite, displayFolderName } from './taskSource';

/**
 * Finding the debug configurations to show.
 *
 * The grouping tags live in `presentation.group`. `launch.json` has no free-form string
 * the way `tasks.json` has `detail` - a debug configuration's schema comes from whichever
 * extension provides its `type`, and an unknown property is flagged there. `presentation`
 * is the one part of the schema that already exists to say how a configuration should be
 * shown, so the tags extend a field that already means this rather than squatting on one
 * that means something else.
 *
 * Its other two fields are read as VS Code defines them: `order` sets sibling order
 * within a level, and `hidden` keeps a configuration out of the tree exactly as it keeps
 * it out of the debug dropdown.
 *
 * Careful: `presentation.group` in `tasks.json` is an unrelated field about sharing
 * terminal panes. Tags belong in `detail` there, and in `presentation.group` here.
 */

export type LaunchOrigin =
    /** In a launch.json at a workspace folder root, so VS Code can start it by name. */
    | 'workspace'
    /** In a launch.json VS Code has not loaded. */
    | 'discovered';

export interface LaunchEntry {
    /** Stable across refreshes: the tree item id, and the run history key. */
    readonly id: string;
    /** The configuration's `name`, which is also how VS Code is asked to start it. */
    readonly label: string;
    /** Grouping levels in written order, read from `presentation.group`. */
    readonly tags: readonly Tag[];
    /** Shown beside the row until it has been started - the debug type. */
    readonly description: string;
    /** `presentation.order`, for sibling order within a level. */
    readonly order: number | undefined;
    /** Debug type (`coreclr`, `debugpy`, …); undefined for a compound. */
    readonly type: string | undefined;
    /** A compound names other configurations instead of describing one itself. */
    readonly isCompound: boolean;
    /** For a compound, the configuration names it starts. */
    readonly configurations: readonly string[];
    /** The task VS Code runs before this starts, if any. */
    readonly preLaunchTask: string | undefined;
    readonly origin: LaunchOrigin;
    readonly folder: vscode.WorkspaceFolder | undefined;
    /** Absolute path of the folder holding the `.vscode` directory. */
    readonly projectFolder: string;
    readonly folderName: string;
    readonly fileKey: string;
    readonly definition: DefinitionSite | undefined;
    /** Why this cannot be started from here, or undefined when it can. */
    readonly blockedReason: string | undefined;
}

export interface DiscoveredLaunchFile {
    readonly uri: vscode.Uri;
    readonly projectFolder: string;
    readonly folder: vscode.WorkspaceFolder | undefined;
    readonly count: number;
    readonly error: string | undefined;
}

export interface LaunchLoadResult {
    readonly entries: readonly LaunchEntry[];
    readonly files: readonly DiscoveredLaunchFile[];
}

export const DEFAULT_LAUNCH_INCLUDE = '**/.vscode/launch.json';

export async function loadLaunchConfigurations(
    tagPrefix: string,
    include: string,
    exclude: string,
    maxFiles: number
): Promise<LaunchLoadResult> {
    if (!vscode.workspace.workspaceFolders?.length) {
        return { entries: [], files: [] };
    }

    const uris = await vscode.workspace.findFiles(include, exclude || undefined, maxFiles);
    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    const entries: LaunchEntry[] = [];
    const files: DiscoveredLaunchFile[] = [];

    for (const uri of uris) {
        const projectFolder = path.dirname(path.dirname(uri.fsPath));
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const parsed = await parseLaunchFile(uri);

        // VS Code reads launch.json only at a workspace folder root. Anywhere else, it
        // has never heard of these names and cannot be asked to start one.
        const origin: LaunchOrigin =
            folder && folder.uri.fsPath === projectFolder ? 'workspace' : 'discovered';

        for (const raw of parsed.entries) {
            if (raw.hidden) {
                continue;
            }
            entries.push(
                toEntry(raw, { uri, projectFolder, folder, origin }, tagPrefix)
            );
        }

        files.push({
            uri,
            projectFolder,
            folder,
            count: parsed.entries.length,
            error: parsed.error,
        });
    }

    return { entries, files };
}

interface RawLaunchEntry {
    readonly name: string;
    readonly type: string | undefined;
    readonly group: string | undefined;
    readonly order: number | undefined;
    readonly hidden: boolean;
    readonly isCompound: boolean;
    readonly configurations: string[];
    readonly preLaunchTask: string | undefined;
    readonly site: DefinitionSite;
}

function toEntry(
    raw: RawLaunchEntry,
    where: {
        uri: vscode.Uri;
        projectFolder: string;
        folder: vscode.WorkspaceFolder | undefined;
        origin: LaunchOrigin;
    },
    tagPrefix: string
): LaunchEntry {
    return {
        id: `${where.uri.toString()}#${raw.name}`,
        label: raw.name,
        tags: tagsFrom(raw.group, tagPrefix),
        description: raw.isCompound ? 'compound' : (raw.type ?? ''),
        order: raw.order,
        type: raw.type,
        isCompound: raw.isCompound,
        configurations: raw.configurations,
        preLaunchTask: raw.preLaunchTask,
        origin: where.origin,
        folder: where.folder,
        projectFolder: where.projectFolder,
        folderName: displayFolderName(where.projectFolder, where.folder),
        fileKey: where.uri.toString(),
        definition: raw.site,
        blockedReason:
            where.origin === 'discovered'
                ? 'is in a launch.json VS Code has not loaded, so it cannot be started from here'
                : undefined,
    };
}

/**
 * Read the levels out of `presentation.group`.
 *
 * A group written as tags gives the full hierarchy. A group written the way VS Code
 * documents it - a plain name like `servers` - becomes a single level of that name, so
 * a launch.json already using the native field groups sensibly with no changes at all.
 */
export function tagsFrom(group: string | undefined, tagPrefix: string): readonly Tag[] {
    if (!group?.trim()) {
        return [];
    }
    const { tags } = parseDetail(group, tagPrefix);
    if (tags.length > 0) {
        return tags;
    }
    return [{ key: 'group', values: [group.trim()] }];
}

interface ParsedLaunchFile {
    readonly entries: RawLaunchEntry[];
    readonly error: string | undefined;
}

/** Parse one launch.json. Reports a problem rather than throwing. */
export async function parseLaunchFile(uri: vscode.Uri): Promise<ParsedLaunchFile> {
    let text: string;
    try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (error) {
        return { entries: [], error: `could not be read (${String(error)})` };
    }

    const errors: jsonc.ParseError[] = [];
    const root = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    const syntaxError =
        errors.length > 0
            ? `contains a JSON syntax error (${errors.length} problem${errors.length === 1 ? '' : 's'}); some configurations may be missing`
            : undefined;

    if (!root) {
        return { entries: [], error: syntaxError ?? 'could not be parsed' };
    }

    const entries = [
        ...readArray(root, 'configurations', uri, false),
        ...readArray(root, 'compounds', uri, true),
    ];

    if (entries.length === 0 && !syntaxError) {
        return { entries: [], error: 'has no configurations' };
    }
    return { entries, error: syntaxError };
}

function readArray(
    root: jsonc.Node,
    property: 'configurations' | 'compounds',
    uri: vscode.Uri,
    isCompound: boolean
): RawLaunchEntry[] {
    const node = jsonc.findNodeAtLocation(root, [property]);
    if (!node || node.type !== 'array' || !node.children) {
        return [];
    }

    const out: RawLaunchEntry[] = [];
    for (const child of node.children) {
        const value = jsonc.getNodeValue(child) as Record<string, unknown> | undefined;
        const name = value && typeof value.name === 'string' ? value.name.trim() : '';
        if (!value || !name) {
            continue;
        }

        const presentation =
            value.presentation && typeof value.presentation === 'object'
                ? (value.presentation as Record<string, unknown>)
                : {};

        out.push({
            name,
            type: typeof value.type === 'string' ? value.type : undefined,
            group: typeof presentation.group === 'string' ? presentation.group : undefined,
            order: typeof presentation.order === 'number' ? presentation.order : undefined,
            hidden: presentation.hidden === true,
            isCompound,
            configurations: Array.isArray(value.configurations)
                ? value.configurations.filter((c): c is string => typeof c === 'string')
                : [],
            preLaunchTask:
                typeof value.preLaunchTask === 'string' ? value.preLaunchTask : undefined,
            site: { uri, offset: child.offset, length: child.length },
        });
    }
    return out;
}
