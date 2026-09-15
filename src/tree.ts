import { Tag, escapeRegExp, tagId } from './facets';

/**
 * The tree is a trie over each task's tag sequence: level 1 is every task's first tag,
 * level 2 its second, and so on. Nothing is configured - reordering the tags in
 * tasks.json reorders the tree, and adding a fourth tag adds a fourth level.
 *
 * Nothing here touches the vscode API, so the grouping rules are unit-testable on plain
 * objects.
 */

/** The minimum a task must expose to be placed in the tree. */
export interface GroupableTask {
    readonly id: string;
    readonly label: string;
    /** Ordered: this is the path from the root down to the task. */
    readonly tags: readonly Tag[];
    readonly description: string;
    /** Project folder name, for the optional top-level folder grouping. */
    readonly folderName?: string;
}

export interface GroupNode<T extends GroupableTask> {
    readonly kind: 'group';
    /** Unique within the tree; also the tree item id. */
    readonly id: string;
    /** The tag key at this level, or `'folder'` for the project-folder level. */
    readonly tagKey: string;
    readonly label: string;
    /** Levels from the root down to and including this node. */
    readonly path: readonly PathSegment[];
    readonly children: readonly TreeNode<T>[];
    /** Total tasks anywhere beneath this node. */
    readonly taskCount: number;
}

export interface TaskNode<T extends GroupableTask> {
    readonly kind: 'task';
    readonly id: string;
    /** Label with ancestor tag values stripped, when shortening is on. */
    readonly label: string;
    readonly task: T;
    readonly path: readonly PathSegment[];
}

export interface PathSegment {
    readonly key: string;
    readonly value: string;
}

export type TreeNode<T extends GroupableTask> = GroupNode<T> | TaskNode<T>;

export interface BuildOptions {
    /** Name of the node collecting tasks with no tags at all. */
    readonly ungroupedLabel: string;
    readonly shortenLabels: boolean;
    readonly collapseSingleChildGroups: boolean;
    readonly groupByFolder: boolean;
    readonly hideUnannotatedTasks: boolean;
    /** Per-key sibling ordering; values not listed sort alphabetically after. */
    readonly sortTagValues: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
    ungroupedLabel: 'Ungrouped',
    shortenLabels: true,
    collapseSingleChildGroups: false,
    groupByFolder: false,
    hideUnannotatedTasks: false,
    sortTagValues: {},
};

export function buildTree<T extends GroupableTask>(
    tasks: readonly T[],
    options: BuildOptions
): TreeNode<T>[] {
    const visible = options.hideUnannotatedTasks
        ? tasks.filter((task) => task.tags.length > 0)
        : tasks;

    const roots = options.groupByFolder
        ? groupByFolder(visible, options)
        : group(visible, 0, [], 'root', options);

    return options.collapseSingleChildGroups ? roots.map(collapse) : roots;
}

function groupByFolder<T extends GroupableTask>(
    tasks: readonly T[],
    options: BuildOptions
): TreeNode<T>[] {
    const byFolder = new Map<string, T[]>();
    for (const task of tasks) {
        const name = task.folderName ?? '';
        const bucket = byFolder.get(name) ?? [];
        bucket.push(task);
        byFolder.set(name, bucket);
    }

    return [...byFolder.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, folderTasks]) => {
            const id = `folder:${name}`;
            return {
                kind: 'group' as const,
                id,
                tagKey: 'folder',
                label: name || '(no folder)',
                path: [{ key: 'folder', value: name }],
                children: group(folderTasks, 0, [], id, options),
                taskCount: folderTasks.length,
            };
        });
}

/**
 * Partition on the tag at `depth`, then recurse.
 *
 * A task with fewer tags than `depth` has reached the end of its own path and becomes a
 * leaf right here - which is meaningful, not an error: `@env:staging` alone puts the task
 * directly under staging, beside the groups its longer-tagged siblings create.
 */
function group<T extends GroupableTask>(
    tasks: readonly T[],
    depth: number,
    path: readonly PathSegment[],
    idPrefix: string,
    options: BuildOptions
): TreeNode<T>[] {
    const leaves: T[] = [];
    const untagged: T[] = [];
    const buckets = new Map<string, { key: string; value: string; tasks: T[] }>();

    for (const task of tasks) {
        if (depth === 0 && task.tags.length === 0) {
            untagged.push(task);
            continue;
        }
        const tag = task.tags[depth];
        if (!tag) {
            leaves.push(task);
            continue;
        }
        // A tag carrying several values genuinely belongs under each of them.
        for (const value of tag.values) {
            const id = tagId(tag.key, value);
            const bucket = buckets.get(id) ?? { key: tag.key, value, tasks: [] };
            bucket.tasks.push(task);
            buckets.set(id, bucket);
        }
    }

    const groups: TreeNode<T>[] = [...buckets.values()]
        .sort((a, b) => compareSiblings(a, b, options))
        .map(({ key, value, tasks: bucketTasks }) => {
            const id = `${idPrefix}/${tagId(key, value)}`;
            const childPath = [...path, { key, value }];
            return {
                kind: 'group' as const,
                id,
                tagKey: key,
                label: value,
                path: childPath,
                children: group(bucketTasks, depth + 1, childPath, id, options),
                taskCount: bucketTasks.length,
            };
        });

    // Folders first, then tasks that end at this level, matching the file explorer.
    const nodes: TreeNode<T>[] = [
        ...groups,
        ...leaves.map((task) => leaf(task, path, idPrefix, options)).sort(byLabel),
    ];

    if (untagged.length > 0) {
        const id = `${idPrefix}/untagged`;
        nodes.push({
            kind: 'group',
            id,
            tagKey: '',
            label: options.ungroupedLabel,
            path,
            children: untagged.map((task) => leaf(task, path, id, options)).sort(byLabel),
            taskCount: untagged.length,
        });
    }

    return nodes;
}

function leaf<T extends GroupableTask>(
    task: T,
    path: readonly PathSegment[],
    idPrefix: string,
    options: BuildOptions
): TaskNode<T> {
    return {
        kind: 'task',
        id: `${idPrefix}/task:${task.id}`,
        label: options.shortenLabels ? shortenLabel(task.label, path) : task.label,
        task,
        path,
    };
}

function byLabel<T extends GroupableTask>(a: TreeNode<T>, b: TreeNode<T>): number {
    return a.label.localeCompare(b.label, undefined, { numeric: true });
}

function compareSiblings(
    a: { key: string; value: string },
    b: { key: string; value: string },
    options: BuildOptions
): number {
    const order = options.sortTagValues[a.key];
    if (order && a.key === b.key) {
        const ia = order.indexOf(a.value);
        const ib = order.indexOf(b.value);
        if (ia !== -1 || ib !== -1) {
            // Unlisted values sort after every listed one, then among themselves by name.
            return (
                (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) ||
                a.value.localeCompare(b.value)
            );
        }
    }
    return a.value.localeCompare(b.value, undefined, { numeric: true });
}

/**
 * Drop from a leaf label the tag values its ancestors already state, so
 * `publish: web-api (staging)` reads as `publish` under staging > web-api.
 * Falls back to the full label whenever stripping would leave nothing useful.
 */
export function shortenLabel(label: string, path: readonly PathSegment[]): string {
    let out = label;
    for (const segment of path) {
        if (segment.value) {
            // The value has to be a whole token, not a fragment of a longer hyphenated
            // word: `\b` treats `-` as a boundary, so a level named `install` would carve
            // `npm: install-local` down to `npm-local`, and `types` would turn
            // `check-types` into `check`. Excluding `-` and `_` on either side keeps a
            // compound word intact while still matching a value that is itself hyphenated.
            const value = escapeRegExp(segment.value);
            out = out.replace(new RegExp(`(?<![\\w-])${value}(?![\\w-])`, 'gi'), '');
        }
    }

    const tidied = out
        .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '') // brackets left empty by the removal
        .replace(/\s+/g, ' ')
        .replace(/([:/|,>-])\s*(?=[:/|,>-])/g, '') // runs of separators collapsed to one
        .replace(/^[\s:/|,>-]+|[\s:/|,>-]+$/g, '')
        .trim();

    return tidied.length > 0 ? tidied : label;
}

/** Merge a chain of single-child groups into one node, e.g. `staging > acme`. */
function collapse<T extends GroupableTask>(node: TreeNode<T>): TreeNode<T> {
    if (node.kind === 'task') {
        return node;
    }
    let current: GroupNode<T> = node;
    while (current.children.length === 1 && current.children[0].kind === 'group') {
        const child = current.children[0] as GroupNode<T>;
        current = { ...child, label: `${current.label} \u203a ${child.label}`, id: current.id };
    }
    return { ...current, children: current.children.map(collapse) };
}

/** Depth-first list of every task under a node, each appearing once. */
export function tasksUnder<T extends GroupableTask>(node: TreeNode<T>): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    const walk = (n: TreeNode<T>): void => {
        if (n.kind === 'task') {
            if (!seen.has(n.task.id)) {
                seen.add(n.task.id);
                out.push(n.task);
            }
            return;
        }
        n.children.forEach(walk);
    };
    walk(node);
    return out;
}

/**
 * Case-insensitive match over a task's label, prose description and tags, so
 * `staging web` narrows to tasks matching both terms and `tenant:globex` works too.
 */
export function matchesFilter(task: GroupableTask, filter: string): boolean {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
        return true;
    }
    const haystack = [
        task.label,
        task.description,
        ...task.tags.flatMap((tag) => tag.values.flatMap((v) => [v, tagId(tag.key, v)])),
    ]
        .join(' ')
        .toLowerCase();

    return terms.every((term) => haystack.includes(term));
}
