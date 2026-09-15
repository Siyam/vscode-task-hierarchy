import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { VariableContext, resolveDeep } from './variables';

/**
 * Builds runnable `vscode.Task` objects from raw tasks.json entries.
 *
 * VS Code only loads `.vscode/tasks.json` at a workspace folder root. When a repo is
 * opened one level up - a folder of checkouts, say - every project's tasks are invisible
 * to it, so this recreates them well enough to run.
 *
 * What is faithfully reproduced: shell and process execution, args, cwd, env, OS-specific
 * overrides, background flag, named problem matchers, and `dependsOn` ordering (expanded
 * by the runner rather than by VS Code). What is not: inline problem matcher objects, and
 * `${command:...}` / `${input:...}` variables, which need machinery only VS Code has.
 */

export interface RawTask {
    label?: unknown;
    type?: unknown;
    script?: unknown;
    command?: unknown;
    args?: unknown;
    options?: unknown;
    isBackground?: unknown;
    problemMatcher?: unknown;
    dependsOn?: unknown;
    dependsOrder?: unknown;
    detail?: unknown;
    hide?: unknown;
    group?: unknown;
    presentation?: unknown;
    osx?: unknown;
    windows?: unknown;
    linux?: unknown;
}

export interface SynthesizedTask {
    readonly task: vscode.Task | undefined;
    /** Labels this task runs first, in order. Empty when it has no dependencies. */
    readonly dependsOn: readonly string[];
    readonly dependsOrder: 'sequence' | 'parallel';
    /** Variables left unresolved; running is blocked and the reason shown. */
    readonly unresolved: readonly string[];
    /** Set when the task's `type` belongs to a provider extension we cannot stand in for. */
    readonly unsupportedType: string | undefined;
}

export const SYNTHETIC_TASK_TYPE = 'taskHierarchy';
export const SYNTHETIC_SOURCE = 'Task Hierarchy';

/** Build the substitution context for a tasks.json at `<projectFolder>/.vscode/tasks.json`. */
export function contextFor(projectFolder: string, cwd?: string): VariableContext {
    const namedFolders: Record<string, string> = {};
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        namedFolders[folder.name] = folder.uri.fsPath;
    }
    return {
        workspaceFolder: projectFolder,
        namedFolders,
        userHome: os.homedir(),
        pathSeparator: path.sep,
        cwd: cwd ?? projectFolder,
        env: process.env,
    };
}

export function synthesize(
    raw: RawTask,
    projectFolder: string,
    scope: vscode.WorkspaceFolder | vscode.TaskScope
): SynthesizedTask | undefined {
    const label = typeof raw.label === 'string' ? raw.label : undefined;
    if (!label) {
        return undefined;
    }

    const merged = applyPlatformOverride(raw);
    const context = contextFor(projectFolder);
    const { value: resolved, unresolved } = resolveDeep(merged, context);

    const dependsOn = toStringArray(resolved.dependsOn);
    // Parallel is VS Code's default for dependsOn; only "sequence" opts out.
    const dependsOrder = resolved.dependsOrder === 'sequence' ? 'sequence' : 'parallel';

    const execution = buildExecution(resolved, projectFolder);
    if (!execution) {
        // No command of its own: either a pure `dependsOn` aggregate - valid, and common
        // for the "do the whole pipeline" tasks - or a provider task type we cannot
        // reproduce. The latter is still listed, greyed out, rather than vanishing.
        if (dependsOn.length > 0) {
            return { task: undefined, dependsOn, dependsOrder, unresolved, unsupportedType: undefined };
        }
        const type = typeof resolved.type === 'string' ? resolved.type : undefined;
        return type
            ? { task: undefined, dependsOn: [], dependsOrder, unresolved, unsupportedType: type }
            : undefined;
    }

    const definition: vscode.TaskDefinition = { type: SYNTHETIC_TASK_TYPE, label };
    const task = new vscode.Task(
        definition,
        scope,
        label,
        SYNTHETIC_SOURCE,
        execution,
        namedProblemMatchers(resolved.problemMatcher)
    );
    task.isBackground = resolved.isBackground === true;
    task.detail = typeof resolved.detail === 'string' ? resolved.detail : undefined;
    task.presentationOptions = presentationOf(resolved);

    return { task, dependsOn, dependsOrder, unresolved, unsupportedType: undefined };
}

/**
 * Fold the current platform's override block into the task, the way VS Code does:
 * `osx`/`windows`/`linux` replace the keys they name and leave the rest alone.
 */
function applyPlatformOverride(raw: RawTask): RawTask {
    const key = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
    const override = raw[key];
    if (!override || typeof override !== 'object') {
        return raw;
    }
    return { ...raw, ...(override as RawTask) };
}

function buildExecution(
    raw: RawTask,
    projectFolder: string
): vscode.ShellExecution | vscode.ProcessExecution | undefined {
    const options = raw.options && typeof raw.options === 'object' ? (raw.options as Record<string, unknown>) : {};
    const cwd = typeof options.cwd === 'string' ? options.cwd : projectFolder;
    const env = options.env && typeof options.env === 'object'
        ? (options.env as Record<string, string>)
        : undefined;

    // npm is the one provider type worth standing in for: it is everywhere, and the
    // translation is exact. Every other provider type needs its own extension.
    if (raw.type === 'npm' && typeof raw.script === 'string') {
        const script = raw.script;
        const argv = script === 'install' ? ['install'] : ['run', script];
        return new vscode.ShellExecution('npm', argv, { cwd, env });
    }

    const command = raw.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
        return undefined;
    }

    const args = toStringArray(raw.args);

    // "process" runs the command verbatim with no shell; anything else (including a task
    // with no type at all, which VS Code treats as a shell task) goes through the shell.
    if (raw.type === 'process') {
        return new vscode.ProcessExecution(command, args, { cwd, env });
    }
    return args.length > 0
        ? new vscode.ShellExecution(command, args, { cwd, env })
        : new vscode.ShellExecution(command, { cwd, env });
}

/**
 * Only named matchers (`$msCompile`) survive. An inline matcher is an object the Task API
 * cannot accept, and dropping it costs problem squiggles, not the ability to run.
 */
function namedProblemMatchers(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
    }
    return [];
}

function presentationOf(raw: RawTask): vscode.TaskPresentationOptions {
    const presentation =
        raw.presentation && typeof raw.presentation === 'object'
            ? (raw.presentation as Record<string, unknown>)
            : {};

    const reveal = presentation.reveal;
    return {
        reveal:
            reveal === 'silent'
                ? vscode.TaskRevealKind.Silent
                : reveal === 'never'
                  ? vscode.TaskRevealKind.Never
                  : vscode.TaskRevealKind.Always,
        panel:
            presentation.panel === 'dedicated'
                ? vscode.TaskPanelKind.Dedicated
                : presentation.panel === 'new'
                  ? vscode.TaskPanelKind.New
                  : vscode.TaskPanelKind.Shared,
        echo: presentation.echo !== false,
        focus: presentation.focus === true,
        clear: presentation.clear === true,
    };
}

function toStringArray(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
    }
    return [];
}
