import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runVerification } from './validation/verification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
try {
    const { values } = parseArgs({
        options: {
            tier: { type: 'string', default: 'node' },
            url: { type: 'string' },
            groups: { type: 'string' },
        },
    });
    if (!['node', 'creator'].includes(values.tier)) throw Error('--tier must be node or creator');
    const groups = (
        values.groups ?? 'diagnostics,presentation,ui,startup,resources,localization,audio,network,list,performance'
    )
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    if (values.tier === 'creator') {
        if (!groups.length) throw Error('--groups must select at least one Creator integration group');
        if (!values.url)
            throw Error('Creator verification requires --url from the current project preview or served build.');
        await access(resolve(root, 'temp/tsconfig.cocos.json'));
    } else {
        if (values.url) throw Error('--url requires --tier creator');
        if (values.groups !== undefined) throw Error('--groups requires --tier creator');
    }
    const step = (name, args) => ({ name, args });
    const tests = async (directory) =>
        (await readdir(resolve(root, directory)))
            .filter((file) => /\.test\.(ts|mjs)$/.test(file))
            .sort()
            .map((file) => `${directory}/${file}`);
    const steps = [
        step('format', ['node_modules/prettier/bin/prettier.cjs', '.', '--check']),
        step('lint', [
            'node_modules/eslint/bin/eslint.js',
            ...(values.tier === 'creator' ? ['.'] : ['tools/', 'tests/', 'extensions/', '*.mjs']),
            '--max-warnings',
            '0',
        ]),
    ];
    if (values.tier === 'creator')
        steps.push(
            step('runtime types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']),
            step('contract types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.contracts.json']),
            step('architecture and generated outputs', ['tools/yzforge/cli.mjs', 'check']),
        );
    steps.push(
        step('framework and tools', [
            '--import',
            './tools/yzforge/register-tests.mjs',
            '--test',
            ...(await tests('tests')),
        ]),
    );
    const examples = await tests('tests/examples').catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    if (examples.length)
        steps.push(step('showcase', ['--import', './tools/yzforge/register-tests.mjs', '--test', ...examples]));
    if (values.tier === 'creator')
        steps.push(step('Creator integration', ['tests/integration/run.mjs', ...groups, '--url', values.url]));
    await runVerification(root, values.tier, steps, {
        url: values.url,
        groups: values.tier === 'creator' ? groups : undefined,
    });
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
