/**
 * VS Code variable substitution for tasks this extension runs itself.
 *
 * A tasks.json in a subfolder is invisible to VS Code - it only reads the file at each
 * workspace folder root - so those tasks are built and launched here instead, and their
 * `${...}` variables have to be resolved by hand.
 *
 * `${workspaceFolder}` is deliberately resolved to the folder that *contains* the
 * .vscode directory, not to the open workspace root. A tasks.json under
 * `my-project/.vscode/` was written expecting to be opened as its own project, so
 * `${workspaceFolder}/api/...` has to mean the path it meant then.
 */

export interface VariableContext {
    /** Folder containing the `.vscode` directory this tasks.json lives in. */
    readonly workspaceFolder: string;
    /** Path of each open workspace folder by name, for `${workspaceFolder:name}`. */
    readonly namedFolders: Readonly<Record<string, string>>;
    readonly userHome: string;
    readonly pathSeparator: string;
    /** Effective working directory, for `${cwd}`. */
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The file the task came from, for `${file}`-family fallbacks. */
    readonly execPath?: string;
}

/** Variables this resolver cannot know, which must not be silently mangled. */
const UNRESOLVABLE_PREFIXES = ['command:', 'input:', 'config:'];

/** Variables that only make sense relative to an active editor. */
const EDITOR_VARIABLES = [
    'file',
    'fileBasename',
    'fileBasenameNoExtension',
    'fileDirname',
    'fileExtname',
    'relativeFile',
    'relativeFileDirname',
    'lineNumber',
    'selectedText',
];

export interface ResolveResult {
    readonly value: string;
    /** Variable names left in place because they could not be resolved. */
    readonly unresolved: readonly string[];
}

export function resolveVariables(input: string, context: VariableContext): ResolveResult {
    const unresolved: string[] = [];

    const value = input.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
        const resolved = resolveOne(name, context);
        if (resolved === undefined) {
            if (!unresolved.includes(name)) {
                unresolved.push(name);
            }
            return whole; // Leave it visible rather than substituting an empty string.
        }
        return resolved;
    });

    return { value, unresolved };
}

function resolveOne(name: string, context: VariableContext): string | undefined {
    if (name.startsWith('env:')) {
        // An unset variable is legitimately empty, which is what a shell would do too.
        return context.env[name.slice('env:'.length)] ?? '';
    }
    if (name.startsWith('workspaceFolder:')) {
        return context.namedFolders[name.slice('workspaceFolder:'.length)];
    }
    if (UNRESOLVABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return undefined;
    }
    if (EDITOR_VARIABLES.includes(name)) {
        return undefined;
    }

    switch (name) {
        case 'workspaceFolder':
        case 'workspaceRoot':
            return context.workspaceFolder;
        case 'workspaceFolderBasename':
            return basename(context.workspaceFolder);
        case 'userHome':
            return context.userHome;
        case 'pathSeparator':
        case '/':
            return context.pathSeparator;
        case 'cwd':
            return context.cwd;
        case 'execPath':
            return context.execPath;
        default:
            return undefined;
    }
}

function basename(p: string): string {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
}

/** Resolve every string in a value, recursing through arrays and objects. */
export function resolveDeep<T>(value: T, context: VariableContext): { value: T; unresolved: string[] } {
    const unresolved: string[] = [];

    const walk = (node: unknown): unknown => {
        if (typeof node === 'string') {
            const result = resolveVariables(node, context);
            for (const name of result.unresolved) {
                if (!unresolved.includes(name)) {
                    unresolved.push(name);
                }
            }
            return result.value;
        }
        if (Array.isArray(node)) {
            return node.map(walk);
        }
        if (node && typeof node === 'object') {
            return Object.fromEntries(
                Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)])
            );
        }
        return node;
    };

    return { value: walk(value) as T, unresolved };
}
