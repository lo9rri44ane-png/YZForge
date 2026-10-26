import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { verificationEnvironment } from './verification.mjs';

export function distribution(samples) {
    if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0))
        throw Error('Performance samples must be finite non-negative values');
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
    const middle = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
    return { samples: samples.length, medianMs, p95Ms: percentile(0.95), maxMs: sorted.at(-1) };
}

export function comparePerformance(current, baseline, factor, slackMs) {
    if (!Number.isFinite(factor) || factor < 1 || !Number.isFinite(slackMs) || slackMs < 0)
        throw Error('Invalid performance tolerance');
    if (baseline.ok !== true || baseline.problems?.length) throw Error('Performance baseline did not pass its checks');
    if (current.name !== baseline.name || !isDeepStrictEqual(current.profile, baseline.profile))
        throw Error('Performance profiles differ; record a baseline on the same runtime, hardware and scenario');
    const problems = [];
    for (const [key, expected] of Object.entries(baseline.metrics)) {
        const actual = current.metrics[key];
        if (
            !actual ||
            !Number.isFinite(actual.p95Ms) ||
            !Number.isFinite(expected.p95Ms) ||
            expected.p95Ms < 0 ||
            actual.p95Ms < 0 ||
            !Number.isSafeInteger(actual.samples) ||
            actual.samples < 1 ||
            actual.samples !== expected.samples
        )
            throw Error(`Missing or incompatible metric: ${key}`);
        const limit = expected.p95Ms * factor + slackMs;
        if (actual.p95Ms > limit) problems.push(`${key}.p95Ms: ${actual.p95Ms.toFixed(2)} > ${limit.toFixed(2)}`);
    }
    if (
        !Object.keys(baseline.metrics).length ||
        Object.keys(current.metrics).length !== Object.keys(baseline.metrics).length
    )
        throw Error('Performance metrics differ');
    return problems;
}

export async function savePerformance(root, name, profile, metrics, details, { baseline, problems = [] } = {}) {
    const config = JSON.parse(await readFile(resolve(root, 'project-settings/performance-budgets.json'), 'utf8'));
    const environment = await verificationEnvironment(root);
    const report = {
        name,
        recordedAt: new Date().toISOString(),
        environment,
        profile: JSON.parse(
            JSON.stringify({
                platform: environment.platform,
                arch: environment.arch,
                cpu: cpus()[0]?.model,
                logicalCpus: cpus().length,
                ...profile,
            }),
        ),
        metrics,
        details,
        problems: [...problems],
    };
    if (
        !Number.isFinite(config.maxRegressionFactor) ||
        config.maxRegressionFactor < 1 ||
        !Number.isFinite(config.slackMs) ||
        config.slackMs < 0
    )
        report.problems.push('Invalid performance tolerance');
    if (baseline !== undefined) {
        try {
            if (!baseline.trim()) throw Error('Performance baseline path must not be empty');
            report.problems.push(
                ...comparePerformance(
                    report,
                    JSON.parse(await readFile(resolve(root, baseline), 'utf8')),
                    config.maxRegressionFactor,
                    config.slackMs,
                ),
            );
        } catch (error) {
            report.problems.push(error.message);
        }
    }
    report.baseline = baseline;
    report.ok = !report.problems.length;
    const directory = resolve(root, '.yzforge/performance');
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: file, metrics, problems: report.problems }, null, 2));
    if (report.problems.length) throw Error('Performance check failed: ' + report.problems.join('; '));
    return file;
}
