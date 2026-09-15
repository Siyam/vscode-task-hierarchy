/**
 * Validates the GitHub Actions workflows.
 *
 * GitHub only reports a malformed workflow after it has been pushed, as a run that fails
 * in zero seconds and is listed by filename instead of by its name. That happened to
 * publish.yml: it used `secrets` in a step `if:`, which is not an available context
 * there, and the whole file failed validation - so the one workflow that must be
 * trustworthy was silently broken from the moment it was written.
 *
 * These checks catch that class of mistake locally instead.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/**
 * Contexts GitHub allows inside a step-level `if:`. Notably absent: `secrets`. Test a
 * secret's presence inside the step body instead, with the secret bound through `env`.
 * https://docs.github.com/actions/learn-github-actions/contexts#context-availability
 */
const ALLOWED_IN_STEP_IF = new Set([
    'github',
    'needs',
    'strategy',
    'matrix',
    'job',
    'runner',
    'env',
    'vars',
    'steps',
    'inputs',
    'always',
    'success',
    'failure',
    'cancelled',
    'hashFiles',
    'contains',
    'startsWith',
    'endsWith',
    'format',
    'join',
    'toJSON',
    'fromJSON',
]);

function load(file) {
    // YAML 1.1 reads a bare `on:` key as the boolean true, which is a quirk of the
    // parser rather than anything wrong with the file.
    const doc = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf8'));
    return { ...doc, triggers: doc.on ?? doc[true] };
}

test('every workflow file is valid YAML', () => {
    for (const file of FILES) {
        assert.doesNotThrow(() => load(file), `${file} does not parse`);
    }
});

test('every workflow declares a name, triggers and jobs', () => {
    for (const file of FILES) {
        const doc = load(file);
        assert.ok(doc.name, `${file} has no name:, so GitHub lists it by filename`);
        assert.ok(doc.triggers, `${file} has no triggers`);
        assert.ok(Object.keys(doc.jobs ?? {}).length > 0, `${file} has no jobs`);
    }
});

test('no step condition uses a context GitHub does not allow there', () => {
    const offenders = [];

    for (const file of FILES) {
        const doc = load(file);
        for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
            for (const step of job.steps ?? []) {
                if (typeof step.if !== 'string') {
                    continue;
                }
                for (const [, context] of step.if.matchAll(/\b([a-zA-Z]+)\s*\./g)) {
                    if (!ALLOWED_IN_STEP_IF.has(context)) {
                        offenders.push(`${file} › ${jobName} › "${step.name ?? step.uses}": ${context}`);
                    }
                }
            }
        }
    }

    assert.deepEqual(offenders, []);
});

test('only the publish workflow can reach a marketplace, and only by hand', () => {
    for (const file of FILES) {
        const doc = load(file);
        const body = fs.readFileSync(path.join(DIR, file), 'utf8');
        const publishes = /vsce publish|ovsx publish/.test(body);

        if (file !== 'publish.yml') {
            assert.ok(!publishes, `${file} publishes, but only publish.yml may`);
            continue;
        }

        // The whole point of the three-stage split: pushing code, even a tag, must never
        // be able to ship. Publishing has to be someone deliberately starting it.
        assert.deepEqual(
            Object.keys(doc.triggers),
            ['workflow_dispatch'],
            'publish.yml must be manual only'
        );
    }
});

test('the publish job is pinned to an environment, so it can require approval', () => {
    const doc = load('publish.yml');
    for (const [name, job] of Object.entries(doc.jobs)) {
        assert.ok(job.environment, `publish.yml › ${name} has no environment: to gate it`);
    }
});

test('no workflow hardcodes a credential', () => {
    // Long opaque strings that look like tokens rather than references to secrets.
    const suspicious = /(gh[pousr]_[A-Za-z0-9]{20,}|[A-Za-z0-9+/]{40,}={0,2}\s*$)/m;
    for (const file of FILES) {
        const body = fs.readFileSync(path.join(DIR, file), 'utf8');
        assert.ok(!suspicious.test(body), `${file} may contain a hardcoded credential`);
    }
});
