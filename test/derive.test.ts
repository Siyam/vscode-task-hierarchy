import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DerivationRule, deriveTags, mergeTags, tagsToAdd, validateTagText } from '../src/derive';
import { Tag, parseDetail } from '../src/facets';

/** Compact form for asserting on tag sequences. */
function shape(tags: readonly Tag[]): [string, string[]][] {
    return tags.map((tag) => [tag.key, [...tag.values]]);
}

/**
 * An example rule set, of the kind a repo would write for itself. Nothing like this
 * ships with the extension - see test/manifest.test.js - because the levels worth
 * grouping by are particular to each repo.
 */
const ENV_VALUES = 'local|dev|development|staging|stage|prod|production|test|qa|uat';

const RULES: DerivationRule[] = [
    {
        key: 'env',
        pattern: `[-\\s:(\\[]\\s*(${ENV_VALUES})\\s*[)\\]]?\\s*$|^(${ENV_VALUES})\\s*:`,
        value: '$1$2',
        map: { stage: 'staging', prod: 'production', development: 'dev' },
    },
    {
        key: 'action',
        pattern:
            '^\\s*(build|clean|publish|package|deploy|serve|launch|start|stop|kill|restart|test|watch|config|sync|install|run)\\b',
    },
];

const TENANT: DerivationRule = { key: 'tenant', pattern: '\\b(acme|globex|orders)\\b' };

test('rules are applied in declaration order, and that order becomes the hierarchy', () => {
    // env is declared first, so it is the outermost level regardless of where the
    // environment appears in the label.
    assert.deepEqual(shape(deriveTags('publish: web-api (staging)', RULES)), [
        ['env', ['staging']],
        ['action', ['publish']],
    ]);

    const reordered = [RULES[1], RULES[0]];
    assert.deepEqual(shape(deriveTags('publish: web-api (staging)', reordered)), [
        ['action', ['publish']],
        ['env', ['staging']],
    ]);
});

test('the action rule only fires on a leading verb, so a colon alone is not an action', () => {
    // "staging:billing-worker" leads with an environment, not a verb.
    assert.deepEqual(shape(deriveTags('staging:billing-worker', RULES)), [['env', ['staging']]]);
});

test('the map canonicalises abbreviated values', () => {
    assert.deepEqual(deriveTags('deploy: api-prod', RULES)[0].values, ['production']);
    assert.deepEqual(deriveTags('Build (Stage)', RULES)[0].values, ['staging']);
});

test('the env rule is positional, so an env word mid-label is not an environment', () => {
    // A bare-word rule would read "dev server" as the dev environment. These tasks kill
    // a local Angular process and belong to no environment at all.
    assert.deepEqual(shape(deriveTags('kill: web dev server', RULES)), [
        ['action', ['kill']],
    ]);
    assert.deepEqual(shape(deriveTags('kill: all frontend dev servers', RULES)), [
        ['action', ['kill']],
    ]);
});

test('the env rule reads all three conventions in one tasks.json', () => {
    const env = (label: string): readonly string[] | undefined =>
        deriveTags(label, RULES).find((t) => t.key === 'env')?.values;

    assert.deepEqual(env('publish: web-api (staging)'), ['staging']);
    assert.deepEqual(env('production:billing-worker'), ['production']);
    assert.deepEqual(env('deploy: staging'), ['staging']);
    assert.deepEqual(env('publish: all-staging'), ['staging']);
});

test('values are lowercased so casing in labels does not split a level', () => {
    assert.deepEqual(shape(deriveTags('Publish (PRODUCTION)', RULES)), [
        ['env', ['production']],
        ['action', ['publish']],
    ]);
});

test('an added rule slots into the hierarchy where it is declared', () => {
    assert.deepEqual(shape(deriveTags('config: pull acme', [...RULES, TENANT])), [
        ['action', ['config']],
        ['tenant', ['acme']],
    ]);
});

test('a rule may build its value from several capture groups', () => {
    const rule: DerivationRule = { key: 'service', pattern: '^(\\w+)-(\\w+)-api$', value: '$1/$2' };
    assert.deepEqual(deriveTags('orders-web-api', [rule])[0].values, ['orders/web']);
});

test('several matches for one rule become several values at that level', () => {
    const rule: DerivationRule = { key: 'tenant', pattern: '\\b(acme|globex)\\b' };
    assert.deepEqual(shape(deriveTags('config: sync acme and globex', [rule])), [
        ['tenant', ['acme', 'globex']],
    ]);
});

test('a malformed pattern is skipped without taking the other rules down', () => {
    const rules: DerivationRule[] = [{ key: 'x', pattern: '([' }, ...RULES];
    assert.deepEqual(shape(deriveTags('publish (staging)', rules)), [
        ['env', ['staging']],
        ['action', ['publish']],
    ]);
});

test('caseSensitive restricts matching', () => {
    const rule: DerivationRule = { key: 'env', pattern: '\\b(PROD)\\b', caseSensitive: true };
    assert.deepEqual(deriveTags('deploy PROD', [rule])[0].values, ['prod']);
    assert.deepEqual(deriveTags('deploy prod', [rule]), []);
});

test('tagsToAdd never touches a level the task already declares', () => {
    const existing = parseDetail('@env:production').tags;
    const added = tagsToAdd('publish: api (staging)', existing, RULES);

    assert.ok(!added.some((t) => t.key === 'env'), 'a hand-set env must survive a re-run');
    assert.deepEqual(shape(added), [['action', ['publish']]]);
});

test('mergeTags keeps the authored order and appends the new levels', () => {
    const existing = parseDetail('@tenant:acme @env:production').tags;
    const added = parseDetail('@service:api').tags;

    // The author put tenant outermost; annotating must not silently re-nest their tree.
    assert.deepEqual(shape(mergeTags(existing, added)), [
        ['tenant', ['acme']],
        ['env', ['production']],
        ['service', ['api']],
    ]);
});

test('a task with no tags yet takes the rule order exactly', () => {
    const added = tagsToAdd('publish: api (staging)', [], RULES);
    assert.deepEqual(shape(mergeTags([], added)), [
        ['env', ['staging']],
        ['action', ['publish']],
    ]);
});

test('a fallback keeps a level uniform when the pattern matches nothing', () => {
    // Without this, the 21 acme tasks with no environment start their path at their
    // own first tag, so envs, tenants and services end up side by side at the root.
    const rules: DerivationRule[] = [{ ...RULES[0], fallback: 'local' }, RULES[1]];

    assert.deepEqual(shape(deriveTags('kill: web dev server', rules)), [
        ['env', ['local']],
        ['action', ['kill']],
    ]);
    // A real match still wins over the fallback.
    assert.deepEqual(deriveTags('publish: api (staging)', rules)[0].values, ['staging']);
});

test('validateTagText accepts tags and an empty string, rejects stray prose', () => {
    assert.equal(validateTagText('@env:staging @tenant:acme', '@'), undefined);
    assert.equal(validateTagText('   ', '@'), undefined);
    assert.match(validateTagText('staging', '@') ?? '', /No tags found/);
    assert.match(validateTagText('@env:staging oops', '@') ?? '', /Not a tag: "oops"/);
});
