import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDetail } from '../src/facets';
import {
    BuildOptions,
    DEFAULT_BUILD_OPTIONS,
    GroupNode,
    GroupableTask,
    TreeNode,
    buildTree,
    matchesFilter,
    shortenLabel,
    tasksUnder,
} from '../src/tree';

function task(label: string, detail = ''): GroupableTask {
    const { tags, description } = parseDetail(detail);
    return { id: label, label, tags, description };
}

function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
    return { ...DEFAULT_BUILD_OPTIONS, ...overrides };
}

function labels<T extends GroupableTask>(nodes: readonly TreeNode<T>[]): string[] {
    return nodes.map((n) => n.label);
}

function group<T extends GroupableTask>(node: TreeNode<T>, label: string): GroupNode<T> {
    assert.equal(node.kind, 'group');
    const found = (node as GroupNode<T>).children.find((c) => c.label === label);
    assert.ok(found, `no child "${label}" under "${node.label}" (have: ${labels((node as GroupNode<T>).children).join(', ')})`);
    assert.equal(found.kind, 'group');
    return found as GroupNode<T>;
}

test('tag order is the hierarchy', () => {
    const roots = buildTree(
        [
            task('publish api (staging)', '@env:staging @tenant:acme @service:web-api'),
            task('publish api (production)', '@env:production @tenant:acme @service:web-api'),
            task('publish orders (staging)', '@env:staging @tenant:globex @service:orders-api'),
        ],
        options()
    );

    assert.deepEqual(labels(roots), ['production', 'staging']);
    const staging = roots.find((r) => r.label === 'staging')!;
    assert.deepEqual(labels((staging as GroupNode<GroupableTask>).children), ['acme', 'globex']);
    // staging > acme > web-api > the task itself, four levels down.
    const service = group(group(staging, 'acme'), 'web-api');
    assert.deepEqual(labels(service.children), ['publish api']);
    assert.equal(service.children[0].kind, 'task');
});

test('reordering the tags in the file reorders the tree, with no setting involved', () => {
    const byEnv = buildTree(
        [task('a', '@env:staging @tenant:acme'), task('b', '@env:production @tenant:acme')],
        options()
    );
    assert.deepEqual(labels(byEnv), ['production', 'staging']);
    assert.deepEqual(labels(group(byEnv[0], 'acme').children), ['b']);

    const byTenant = buildTree(
        [task('a', '@tenant:acme @env:staging'), task('b', '@tenant:acme @env:production')],
        options()
    );
    assert.deepEqual(labels(byTenant), ['acme']);
    assert.deepEqual(labels((byTenant[0] as GroupNode<GroupableTask>).children), [
        'production',
        'staging',
    ]);
});

test('the name before the colon distinguishes levels sharing a value', () => {
    // @env:acme and @tenant:acme are different levels and must not merge.
    const roots = buildTree(
        [task('a', '@env:acme'), task('b', '@tenant:acme')],
        options()
    );
    assert.equal(roots.length, 2, 'same value, different names, two nodes');
    assert.deepEqual(
        roots.map((r) => (r as GroupNode<GroupableTask>).tagKey).sort(),
        ['env', 'tenant']
    );
});

test('a task with fewer tags becomes a leaf where its path ends', () => {
    const roots = buildTree(
        [
            task('deploy everything', '@env:staging'),
            task('publish api', '@env:staging @service:api'),
        ],
        options()
    );

    const staging = roots[0] as GroupNode<GroupableTask>;
    // The group comes first, then the task that stops at this level.
    assert.deepEqual(labels(staging.children), ['api', 'deploy everything']);
    assert.equal(staging.children[0].kind, 'group');
    assert.equal(staging.children[1].kind, 'task');
});

test('unlimited depth: five tags nest five levels', () => {
    const roots = buildTree(
        [task('x', '@a:1 @b:2 @c:3 @d:4 @e:5')],
        options()
    );
    let node = roots[0] as GroupNode<GroupableTask>;
    const seen = [node.label];
    while (node.children[0].kind === 'group') {
        node = node.children[0] as GroupNode<GroupableTask>;
        seen.push(node.label);
    }
    assert.deepEqual(seen, ['1', '2', '3', '4', '5']);
    assert.equal(node.children[0].kind, 'task');
});

test('tasks with no tags at all collect in the ungrouped bucket, listed last', () => {
    const roots = buildTree(
        [task('a', '@env:staging'), task('kill port 4201'), task('kill api ports')],
        options({ ungroupedLabel: 'Ungrouped' })
    );

    assert.deepEqual(labels(roots), ['staging', 'Ungrouped']);
    const ungrouped = roots[1] as GroupNode<GroupableTask>;
    assert.deepEqual(labels(ungrouped.children), ['kill api ports', 'kill port 4201']);
});

test('hideUnannotatedTasks drops untagged tasks entirely', () => {
    const roots = buildTree(
        [task('a', '@env:staging'), task('kill port 4201')],
        options({ hideUnannotatedTasks: true })
    );
    assert.deepEqual(labels(roots), ['staging']);
});

test('a multi-valued tag places the task under every value', () => {
    const roots = buildTree([task('config: pull all', '@tenant:acme,globex')], options());
    assert.deepEqual(labels(roots), ['acme', 'globex']);
    assert.equal((roots[0] as GroupNode<GroupableTask>).taskCount, 1);
});

test('sortTagValues orders siblings, unknown values alphabetically after', () => {
    const roots = buildTree(
        [
            task('a', '@env:production'),
            task('b', '@env:staging'),
            task('c', '@env:local'),
            task('d', '@env:sandbox'),
        ],
        options({ sortTagValues: { env: ['local', 'staging', 'production'] } })
    );
    assert.deepEqual(labels(roots), ['local', 'staging', 'production', 'sandbox']);
});

test('leaf labels drop the tag values their ancestors already state', () => {
    const roots = buildTree(
        [task('publish: web-api (staging)', '@env:staging @service:web-api')],
        options({ shortenLabels: true })
    );
    assert.equal(group(roots[0], 'web-api').children[0].label, 'publish');
});

test('shortenLabel falls back to the full label when nothing would be left', () => {
    assert.equal(shortenLabel('staging', [{ key: 'env', value: 'staging' }]), 'staging');
});

test('shortenLabel tidies the separators left behind', () => {
    const path = [
        { key: 'env', value: 'staging' },
        { key: 'service', value: 'web-api' },
    ];
    assert.equal(shortenLabel('clean: web-api (staging)', path), 'clean');
    assert.equal(shortenLabel('staging:web-api', path), 'staging:web-api');
});

test('shortenLabel strips whole tokens, never fragments of a hyphenated word', () => {
    // "-" counts as a word boundary, so a naive \b match carved "npm: install-local"
    // down to "npm-local" and "check-types" down to "check".
    assert.equal(
        shortenLabel('npm: install-local', [{ key: 'action', value: 'install' }]),
        'npm: install-local'
    );
    assert.equal(
        shortenLabel('npm: check-types', [{ key: 'action', value: 'types' }]),
        'npm: check-types'
    );
    // A hyphenated value still matches when the whole of it is present.
    assert.equal(
        shortenLabel('publish: web-api (staging)', [
            { key: 'service', value: 'web-api' },
        ]),
        'publish: (staging)'.replace(' ()', '')
    );
    // Underscores join words the same way.
    assert.equal(
        shortenLabel('run build_all', [{ key: 'action', value: 'build' }]),
        'run build_all'
    );
});

test('collapseSingleChildGroups merges a single-child chain into one node', () => {
    const roots = buildTree(
        [task('publish', '@env:staging @tenant:acme @service:api')],
        options({ collapseSingleChildGroups: true })
    );
    assert.deepEqual(labels(roots), ['staging › acme › api']);
});

test('tasksUnder collects every descendant exactly once', () => {
    const roots = buildTree(
        [task('a', '@env:staging @tenant:acme,globex'), task('b', '@env:staging @tenant:acme')],
        options()
    );
    // "a" sits under both tenants; a group run must not start it twice.
    assert.deepEqual(tasksUnder(roots[0]).map((t) => t.label).sort(), ['a', 'b']);
});

test('the project-folder level sits above the tags', () => {
    const roots = buildTree(
        [
            { ...task('a', '@env:staging'), folderName: 'sample-project' },
            { ...task('b', '@env:staging'), folderName: 'other-project' },
        ],
        options({ groupByFolder: true })
    );
    assert.deepEqual(labels(roots), ['other-project', 'sample-project']);
    assert.deepEqual(labels(group(roots[0], 'staging').children), ['b']);
});

test('filtering matches labels, descriptions, tag names and values', () => {
    const entry = task('publish: web-api (staging)', '@env:staging @tenant:acme Ship it');

    assert.ok(matchesFilter(entry, 'staging'));
    assert.ok(matchesFilter(entry, 'STAGING web'));
    assert.ok(matchesFilter(entry, 'tenant:acme'));
    assert.ok(matchesFilter(entry, 'ship'));
    assert.ok(!matchesFilter(entry, 'staging production'));
    assert.ok(matchesFilter(entry, '   '));
});
