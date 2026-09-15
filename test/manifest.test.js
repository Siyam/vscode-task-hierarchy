/**
 * The extension ships no opinionated defaults.
 *
 * `env`, `tenant`, `service` and `staging`/`production` are one repo's vocabulary, not
 * everyone's. Seeding them as defaults would put a stranger's tree in terms they never
 * chose, and quietly reward that one shape over any other. Settings that name a level or
 * a value therefore start empty, and only the structural ones carry a value.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const pkg = require('../package.json');

const props = pkg.contributes.configuration.properties;

/** Settings whose value would presume a particular repo's vocabulary. */
const MUST_BE_EMPTY = [
    'taskHierarchy.tagIcons',
    'taskHierarchy.tagValueIcons',
    'taskHierarchy.sortTagValues',
    'taskHierarchy.derivationRules',
];

/** Settings that must keep a value, because the extension cannot work without one. */
const MUST_HAVE_VALUE = [
    'taskHierarchy.tagPrefix',
    'taskHierarchy.discoveryInclude',
    'taskHierarchy.clickAction',
    'taskHierarchy.groupRunMode',
];

for (const name of MUST_BE_EMPTY) {
    test(`${name} ships empty`, () => {
        const value = props[name]?.default;
        assert.ok(value !== undefined, `${name} is missing from the manifest`);
        const size = Array.isArray(value) ? value.length : Object.keys(value).length;
        assert.equal(size, 0, `${name} ships ${JSON.stringify(value)}`);
    });
}

for (const name of MUST_HAVE_VALUE) {
    test(`${name} keeps a working value`, () => {
        const value = props[name]?.default;
        assert.ok(value !== undefined && value !== '', `${name} needs a default to function`);
    });
}

test('no setting default mentions a vocabulary the user did not choose', () => {
    // A value like "staging" or a key like "tenant" anywhere in a default is the
    // regression this guards against, wherever it is nested.
    const vocabulary = /\b(env|tenant|service|action|staging|production|acme|globex|sample|orders)\b/i;
    const offenders = [];

    for (const [name, schema] of Object.entries(props)) {
        if (MUST_HAVE_VALUE.includes(name) || schema.default === undefined) {
            continue;
        }
        const serialised = JSON.stringify(schema.default);
        if (vocabulary.test(serialised)) {
            offenders.push(`${name} = ${serialised}`);
        }
    }

    assert.deepEqual(offenders, []);
});

test('every contributed command and setting is namespaced to the extension', () => {
    for (const command of pkg.contributes.commands) {
        assert.match(command.command, /^taskHierarchy\./);
    }
    for (const name of Object.keys(props)) {
        assert.match(name, /^taskHierarchy\./);
    }
});
