import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runVerification } from '../tools/yzforge/validation/verification.mjs';
import { distribution, comparePerformance, savePerformance } from '../tools/yzforge/validation/performance.mjs';

test('verification stops on the first failure and preserves evidence for failed and completed steps', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-verification-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
            cocos: { version: '4.0.0-beta.0' },
            cli: { version: '0.2.0-beta.0' },
            pink: { version: '1.127.0' },
        }),
    );
    await assert.rejects(
        runVerification(root, 'probe', [
            { name: 'first', args: ['-e', 'console.log("first-output")'] },
            { name: 'broken', args: ['-e', 'console.error("failure-output");process.exitCode=3'] },
            { name: 'must-not-run', args: ['-e', 'process.exitCode=0'] },
        ]),
        /broken failed/,
    );
    const directory = join(root, '.yzforge/verification', (await readdir(join(root, '.yzforge/verification')))[0]);
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.ok, false);
    assert.deepEqual(
        report.steps.map((step) => step.ok),
        [true, false],
    );
    assert.equal(report.steps[1].exitCode, 3);
    assert.match(await readFile(join(root, report.steps[1].log), 'utf8'), /failure-output/);
    assert.ok(report.finishedAt && report.environment.node);
    assert.equal(report.environment.cocos, '4.0.0-beta.0');
    assert.equal(report.environment.cli, '0.2.0-beta.0');
    assert.equal(report.environment.pink, '1.127.0');
});

test('performance comparison rejects incompatible environments and cannot pass a missing or regressed metric', () => {
    assert.deepEqual(distribution([4, 1, 3, 2]), { samples: 4, medianMs: 2.5, p95Ms: 4, maxMs: 4 });
    assert.equal(distribution([3, 1, 2]).medianMs, 2);
    assert.throws(() => distribution([]));
    assert.throws(() => distribution([NaN]));
    const baseline = {
        ok: true,
        name: 'node',
        profile: { cpu: 'test' },
        metrics: { work: { samples: 10, p95Ms: 10 } },
    };
    assert.deepEqual(comparePerformance(baseline, baseline, 1.3, 2), []);
    assert.equal(
        comparePerformance({ ...baseline, metrics: { work: { samples: 10, p95Ms: 16 } } }, baseline, 1.3, 2).length,
        1,
    );
    assert.throws(
        () => comparePerformance({ ...baseline, profile: { cpu: 'other' } }, baseline, 1.3, 2),
        /profiles differ/,
    );
    assert.throws(() => comparePerformance({ ...baseline, metrics: {} }, baseline, 1.3, 2), /metric/);
    assert.throws(() => comparePerformance(baseline, { ...baseline, ok: false }, 1.3, 2), /baseline/i);
    const malformed = { ...baseline, metrics: { work: { samples: 0, p95Ms: 10 } } };
    assert.throws(() => comparePerformance(malformed, malformed, 1.3, 2), /metric/);
    assert.deepEqual(
        comparePerformance(
            { ...baseline, profile: { cpu: 'test', arch: 'x64' } },
            { ...baseline, profile: { arch: 'x64', cpu: 'test' } },
            1.3,
            2,
        ),
        [],
    );
});

test('verification preserves UTF-8 text split across child-process writes', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-verification-utf8-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), '{}');
    const report = await runVerification(root, 'utf8', [
        {
            name: 'split UTF-8',
            args: [
                '-e',
                'process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),50);',
            ],
        },
    ]);
    assert.equal(await readFile(join(root, report.steps[0].log), 'utf8'), '中');
});

test('Creator verification rejects an empty group selection and Node verification rejects ignored options', () => {
    const cli = fileURLToPath(new URL('../tools/yzforge/verify.mjs', import.meta.url));
    for (const args of [
        ['--tier', 'creator', '--url', 'http://localhost:7457/', '--groups', ''],
        ['--tier', 'creator', '--url', 'http://localhost:7457/', '--groups', ', ,'],
        ['--tier', 'node', '--groups', 'ui'],
    ]) {
        const result = spawnSync(process.execPath, [cli, ...args], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3000,
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /--groups/);
    }
});

test('performance failures retain measurements and cannot become a successful baseline', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-performance-report-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), '{}');
    await mkdir(join(root, 'project-settings'));
    await writeFile(
        join(root, 'project-settings/performance-budgets.json'),
        JSON.stringify({ maxRegressionFactor: 1.3, slackMs: 2 }),
    );
    const metrics = { work: distribution([1, 2, 3]) };
    const baseline = await savePerformance(root, 'probe', {}, metrics, {});
    await assert.rejects(
        savePerformance(
            root,
            'probe',
            {},
            metrics,
            { retained: 9 },
            {
                baseline,
                problems: ['Retained resources did not recover'],
            },
        ),
        /Retained resources/,
    );
    const directory = join(root, '.yzforge/performance');
    const reports = await Promise.all(
        (await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'))),
    );
    const failed = reports.find((report) => !report.ok);
    assert.equal(failed.details.retained, 9);
    assert.deepEqual(failed.metrics, metrics);
    assert.deepEqual(failed.problems, ['Retained resources did not recover']);
    assert.throws(
        () =>
            comparePerformance(
                reports.find((report) => report.ok),
                failed,
                1.3,
                2,
            ),
        /baseline/i,
    );
});
