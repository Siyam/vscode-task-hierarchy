import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VariableContext, resolveDeep, resolveVariables } from '../src/variables';

const CONTEXT: VariableContext = {
    workspaceFolder: '/home/dev/projects/sample-project',
    namedFolders: {
        'sample-project': '/home/dev/projects/sample-project',
        GitHub: '/home/dev/projects',
    },
    userHome: '/home/dev',
    pathSeparator: '/',
    cwd: '/home/dev/projects/sample-project',
    env: { DEPLOY_DIR: '/srv/deploy/staging' },
};

test('${workspaceFolder} is the folder holding .vscode, not the open root', () => {
    // A tasks.json under sample-project/.vscode was written expecting to be opened as
    // its own project, so this has to keep meaning what it meant then.
    const { value, unresolved } = resolveVariables(
        '${workspaceFolder}/orders-api/orders-api.csproj',
        CONTEXT
    );
    assert.equal(
        value,
        '/home/dev/projects/sample-project/orders-api/orders-api.csproj'
    );
    assert.deepEqual(unresolved, []);
});

test('${workspaceRoot} is accepted as the legacy spelling', () => {
    assert.equal(resolveVariables('${workspaceRoot}/x', CONTEXT).value, `${CONTEXT.workspaceFolder}/x`);
});

test('resolves the remaining common variables', () => {
    assert.equal(resolveVariables('${workspaceFolderBasename}', CONTEXT).value, 'sample-project');
    assert.equal(resolveVariables('${userHome}/dev', CONTEXT).value, '/home/dev/dev');
    assert.equal(resolveVariables('a${pathSeparator}b', CONTEXT).value, 'a/b');
    assert.equal(resolveVariables('a${/}b', CONTEXT).value, 'a/b');
    assert.equal(resolveVariables('${cwd}', CONTEXT).value, CONTEXT.cwd);
});

test('${workspaceFolder:name} picks a named folder, and an unknown name is left alone', () => {
    assert.equal(resolveVariables('${workspaceFolder:GitHub}/x', CONTEXT).value, '/home/dev/projects/x');

    const missing = resolveVariables('${workspaceFolder:nope}/x', CONTEXT);
    assert.equal(missing.value, '${workspaceFolder:nope}/x');
    assert.deepEqual(missing.unresolved, ['workspaceFolder:nope']);
});

test('${env:NAME} reads the environment; an unset name is empty, as a shell would have it', () => {
    assert.equal(resolveVariables('${env:DEPLOY_DIR}/x.zip', CONTEXT).value, '/srv/deploy/staging/x.zip');

    const unset = resolveVariables('[${env:NOT_SET}]', CONTEXT);
    assert.equal(unset.value, '[]');
    assert.deepEqual(unset.unresolved, []);
});

test('variables only VS Code can answer are reported, not blanked out', () => {
    // Substituting an empty string here would silently run the wrong command.
    for (const name of ['command:pickProject', 'input:tenant', 'config:some.setting']) {
        const result = resolveVariables(`x \${${name}} y`, CONTEXT);
        assert.equal(result.value, `x \${${name}} y`, `${name} must stay visible`);
        assert.deepEqual(result.unresolved, [name]);
    }
});

test('editor-relative variables are reported too', () => {
    const result = resolveVariables('${file}', CONTEXT);
    assert.equal(result.value, '${file}');
    assert.deepEqual(result.unresolved, ['file']);
});

test('an unknown variable is left in place and reported once', () => {
    const result = resolveVariables('${nope} ${nope}', CONTEXT);
    assert.equal(result.value, '${nope} ${nope}');
    assert.deepEqual(result.unresolved, ['nope']);
});

test('a string with no variables is returned unchanged', () => {
    const result = resolveVariables('dotnet build --no-restore', CONTEXT);
    assert.equal(result.value, 'dotnet build --no-restore');
    assert.deepEqual(result.unresolved, []);
});

test('resolveDeep walks args arrays and options objects', () => {
    const raw = {
        command: 'dotnet',
        args: ['publish', '${workspaceFolder}/api/api.csproj', '-p:PublishDir=bin/staging/'],
        options: { cwd: '${workspaceFolder}/api/bin', env: { OUT: '${env:DEPLOY_DIR}' } },
        isBackground: false,
    };
    const { value, unresolved } = resolveDeep(raw, CONTEXT);

    assert.deepEqual(value.args, [
        'publish',
        '/home/dev/projects/sample-project/api/api.csproj',
        '-p:PublishDir=bin/staging/',
    ]);
    assert.equal(value.options.cwd, '/home/dev/projects/sample-project/api/bin');
    assert.equal(value.options.env.OUT, '/srv/deploy/staging');
    assert.equal(value.isBackground, false, 'non-string values pass through untouched');
    assert.deepEqual(unresolved, []);
});

test('resolveDeep collects unresolved names from anywhere in the structure', () => {
    const { unresolved } = resolveDeep(
        { command: '${command:pick}', args: ['${input:tenant}', '${workspaceFolder}'] },
        CONTEXT
    );
    assert.deepEqual(unresolved, ['command:pick', 'input:tenant']);
});
