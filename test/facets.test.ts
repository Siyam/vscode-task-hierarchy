import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tag, collectTagKeys, composeDetail, formatTags, parseDetail, valueOf } from '../src/facets';

/** Compact form for asserting on tag sequences. */
function shape(tags: readonly Tag[]): [string, string[]][] {
    return tags.map((tag) => [tag.key, [...tag.values]]);
}

test('tags are returned in written order, since that order is the hierarchy', () => {
    const { tags, description } = parseDetail(
        '@env:staging @tenant:acme @service:web-api Ships the API'
    );
    assert.deepEqual(shape(tags), [
        ['env', ['staging']],
        ['tenant', ['acme']],
        ['service', ['web-api']],
    ]);
    assert.equal(description, 'Ships the API');
});

test('writing the same keys in a different order gives a different hierarchy', () => {
    const a = parseDetail('@env:staging @tenant:acme').tags;
    const b = parseDetail('@tenant:acme @env:staging').tags;

    assert.deepEqual(shape(a), [['env', ['staging']], ['tenant', ['acme']]]);
    assert.deepEqual(shape(b), [['tenant', ['acme']], ['env', ['staging']]]);
});

test('a detail with no tags is all description', () => {
    const { tags, description } = parseDetail('Just a note');
    assert.deepEqual(tags, []);
    assert.equal(description, 'Just a note');
});

test('missing detail yields nothing', () => {
    assert.deepEqual(parseDetail(undefined), { tags: [], description: '' });
});

test('a comma-separated value becomes several values at one level', () => {
    assert.deepEqual(shape(parseDetail('@tenant:acme,globex').tags), [
        ['tenant', ['acme', 'globex']],
    ]);
});

test('a repeated key stays two levels rather than merging', () => {
    // Writing a key twice is how you nest under it twice; merging would lose a level.
    assert.deepEqual(shape(parseDetail('@group:a @group:b').tags), [
        ['group', ['a']],
        ['group', ['b']],
    ]);
});

test('a quoted value may contain spaces and commas', () => {
    assert.deepEqual(shape(parseDetail('@service:"orders api, v2"').tags), [
        ['service', ['orders api, v2']],
    ]);
});

test('the tag prefix is configurable', () => {
    assert.deepEqual(shape(parseDetail('#env:prod', '#').tags), [['env', ['prod']]]);
    // With a different prefix configured, the default prefix is just prose.
    assert.equal(parseDetail('@env:prod', '#').description, '@env:prod');
});

test('an email address in the prose is not mistaken for a tag', () => {
    const { tags, description } = parseDetail('Owned by ops@example.com');
    assert.deepEqual(tags, []);
    assert.equal(description, 'Owned by ops@example.com');
});

test('formatting round-trips through parsing, order intact', () => {
    const tags: Tag[] = [
        { key: 'env', values: ['staging'] },
        { key: 'service', values: ['sample web api'] },
        { key: 'tenant', values: ['a', 'b'] },
    ];
    assert.deepEqual(shape(parseDetail(formatTags(tags)).tags), shape(tags));
});

test('a value needing quotes gets them back when formatted', () => {
    assert.equal(formatTags([{ key: 'service', values: ['orders api'] }]), '@service:"orders api"');
});

test('composeDetail puts tags before prose', () => {
    const tags: Tag[] = [{ key: 'env', values: ['staging'] }];
    assert.equal(composeDetail(tags, 'Ship it'), '@env:staging Ship it');
    assert.equal(composeDetail(tags, ''), '@env:staging');
    assert.equal(composeDetail([], 'Ship it'), 'Ship it');
});

test('valueOf finds a level by name regardless of its position', () => {
    const { tags } = parseDetail('@tenant:acme @env:staging');
    assert.equal(valueOf(tags, 'env'), 'staging');
    assert.equal(valueOf(tags, 'nope'), undefined);
});

test('collectTagKeys reports every name in use, first-seen first', () => {
    const keys = collectTagKeys([
        parseDetail('@env:staging @tenant:acme').tags,
        parseDetail('@env:production @service:api').tags,
    ]);
    assert.deepEqual(keys, ['env', 'tenant', 'service']);
});
