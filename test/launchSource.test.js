/**
 * Reading debug configurations out of launch.json.
 *
 * The grouping tags live in presentation.group, because a debug configuration's schema
 * comes from whichever extension provides its type and an unknown property is flagged
 * there. presentation already exists to say how a configuration is shown, so the tags
 * extend it rather than squat on something unrelated.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { makeVscodeStub, loadWithStub, writeFixture } = require('./harness');

const TMP = path.join(os.tmpdir(), 'task-hierarchy-launch');

async function load({ files, folders }) {
    const root = writeFixture(path.join(TMP, `l-${Math.random().toString(36).slice(2)}`), files);
    const stub = makeVscodeStub({ folders: folders.map((f) => (f === '.' ? root : path.join(root, f))) });
    const { loadLaunchConfigurations, DEFAULT_LAUNCH_INCLUDE } = loadWithStub('launchSource.js', stub);
    const result = await loadLaunchConfigurations('@', DEFAULT_LAUNCH_INCLUDE, '', 100);
    return { root, stub, ...result };
}

const byName = (entries, name) => entries.find((e) => e.label === name);

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('tags in presentation.group give the hierarchy', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [
                    {
                        name: 'api',
                        type: 'coreclr',
                        request: 'launch',
                        presentation: { group: '@env:staging @service:api', order: 2 },
                    },
                ],
            },
        },
    });

    const api = byName(entries, 'api');
    assert.deepEqual(
        api.tags.map((t) => [t.key, t.values]),
        [['env', ['staging']], ['service', ['api']]]
    );
    assert.equal(api.order, 2);
    assert.equal(api.type, 'coreclr');
});

test('a plain group name, as VS Code documents it, becomes one level', async () => {
    // A launch.json already using the native field should group sensibly untouched.
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [
                    { name: 'web', type: 'node', request: 'launch', presentation: { group: 'servers' } },
                ],
            },
        },
    });

    assert.deepEqual(
        byName(entries, 'web').tags.map((t) => [t.key, t.values]),
        [['group', ['servers']]]
    );
});

test('presentation.hidden keeps a configuration out, as it does the dropdown', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [
                    { name: 'shown', type: 'node', request: 'launch' },
                    { name: 'helper', type: 'node', request: 'launch', presentation: { hidden: true } },
                ],
            },
        },
    });

    assert.deepEqual(entries.map((e) => e.label), ['shown']);
});

test('compounds are read alongside configurations', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [
                    { name: 'api', type: 'coreclr', request: 'launch' },
                    { name: 'worker', type: 'coreclr', request: 'launch' },
                ],
                compounds: [
                    { name: 'everything', configurations: ['api', 'worker'], presentation: { group: '@env:local' } },
                ],
            },
        },
    });

    const compound = byName(entries, 'everything');
    assert.equal(compound.isCompound, true);
    assert.deepEqual([...compound.configurations], ['api', 'worker']);
    assert.equal(compound.description, 'compound');
    assert.equal(byName(entries, 'api').isCompound, false);
});

test('preLaunchTask is kept, since it links a configuration to a task', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [
                    { name: 'api', type: 'coreclr', request: 'launch', preLaunchTask: 'build api' },
                ],
            },
        },
    });
    assert.equal(byName(entries, 'api').preLaunchTask, 'build api');
});

test('a launch.json VS Code has not loaded is found but cannot be started', async () => {
    // Starting it by name needs VS Code to know the name, and it only reads launch.json
    // at a workspace folder root.
    const { entries } = await load({
        folders: ['.'],
        files: {
            'nested/.vscode/launch.json': {
                version: '0.2.0',
                configurations: [{ name: 'api', type: 'coreclr', request: 'launch' }],
            },
        },
    });

    const api = byName(entries, 'api');
    assert.equal(api.origin, 'discovered');
    assert.match(String(api.blockedReason), /has not loaded/);
    assert.equal(api.folderName, 'nested');
});

test('a launch.json at the workspace root is startable', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [{ name: 'api', type: 'coreclr', request: 'launch' }],
            },
        },
    });

    assert.equal(byName(entries, 'api').origin, 'workspace');
    assert.equal(byName(entries, 'api').blockedReason, undefined);
});

test('comments and trailing commas parse, as a hand-maintained file needs', async () => {
    const { entries, files } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': `{
                // The one everyone uses.
                "version": "0.2.0",
                "configurations": [
                    { "name": "api", "type": "coreclr", "request": "launch", },
                ],
            }`,
        },
    });
    assert.equal(files[0].error, undefined);
    assert.deepEqual(entries.map((e) => e.label), ['api']);
});

test('a broken launch.json is reported rather than thrown', async () => {
    const { files } = await load({
        folders: ['.'],
        files: { '.vscode/launch.json': '{ "version": "0.2.0", "configurations": [ { "name": ' },
    });
    assert.match(String(files[0].error), /syntax error/);
});

test('a configuration with no name is skipped', async () => {
    const { entries } = await load({
        folders: ['.'],
        files: {
            '.vscode/launch.json': {
                version: '0.2.0',
                configurations: [{ type: 'node', request: 'launch' }, { name: 'ok', type: 'node' }],
            },
        },
    });
    assert.deepEqual(entries.map((e) => e.label), ['ok']);
});
