import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename, readdir, realpath, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import formatting from '../../tools/yzforge/generators/format.cjs';
import { runVerification } from '../../tools/yzforge/validation/verification.mjs';

// 必须先验证专用副本身份，再加载 MCP 或执行任何工程修改。
const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const marker = JSON.parse(
    await readFile(resolve(root, '.yzforge/empty-trial.json'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT')
            throw Error('请先运行 create-empty-trial.mjs，并在它创建的专用副本中验收；禁止在源工程执行。');
        throw error;
    }),
);
assert.equal(marker.kind, 'yzforge-empty-trial');
assert.equal(await realpath(marker.project), root, 'Trial marker belongs to another project');
assert.notEqual(await realpath(marker.source), root, 'Never run the trial in its source project');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(pkg.uuid, marker.projectUuid);
assert.notEqual(pkg.uuid, marker.sourceUuid);
assert.ok(/^com\.yzforge\.trial\.[a-f0-9]{8}$/.test(marker.appId));
assert.deepEqual(process.argv.slice(2), [], 'Create a fresh trial for each full acceptance run');
await access(resolve(root, 'temp/tsconfig.cocos.json'));
await assert.rejects(access(resolve(root, '.yzforge/empty-project-report.json')), { code: 'ENOENT' });
const { call } = await import('../../tools/yzforge/mcp.mjs');
const { writeCatalogSources, composeCatalog, verifyCatalog } = await import('./empty-project-fixture.mjs');
const editor = async (code, args = {}) => (await call('execute_javascript', { context: 'editor', code, args })).data;
const action = (name, input) =>
    editor('return Editor.Message.request("yzforge-editor","dispatch",args.name,args.input);', { name, input });
const report = { marker, startedAt: new Date().toISOString(), ok: false, stage: 'preflight', deleted: [], created: [] };
const save = () =>
    writeFile(resolve(root, '.yzforge/empty-project-report.json'), JSON.stringify(report, null, 2) + '\n');
const stage = async (name) => {
    report.stage = name;
    await save();
    console.log(name);
};
const previewURL = async () => {
    const preview = (await call('get_preview_mode')).data;
    const url = new URL(preview.localUrl ?? preview.url);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    url.hostname = '127.0.0.1';
    return url.href;
};
try {
    report.editor = (await call('get_project_info')).data;
    assert.equal(
        await editor('return Editor.Message.request("asset-db","query-ready");'),
        true,
        'Wait for Creator import',
    );
    assert.equal(
        await editor('return Editor.Message.request("scene","query-dirty");'),
        false,
        'Save the trial scene first',
    );
    const modules = (await readdir(resolve(root, 'assets/game/modules'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    assert.deepEqual(modules, ['common', 'lobby', 'profile', 'showcase', 'workshop']);
    await stage('empty-template');
    await call('open_scene', { target: 'db://assets/game/boot/Bootstrap.scene' });
    await action('generate');
    const entry = resolve(root, 'assets/game/app/start-game.ts');
    await writeFile(
        entry,
        await formatting.formatScript(
            entry,
            `import type { App } from '../../framework/app/app';
import type { BootContext } from '../../framework/app/boot';
/** 项目的空启动入口。 */
export function startGame(_app: App, _boot: BootContext): void {}
`,
        ),
    );
    const settingsFile = resolve(root, 'project-settings/framework.json');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    settings.appId = marker.appId;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    await editor('return Editor.Message.request("asset-db","refresh-asset","db://assets/game/app/start-game.ts");');
    for (const module of ['showcase', 'workshop', 'lobby', 'profile', 'common']) {
        const plan = await action('previewDelete', { module, kind: 'module' });
        assert.deepEqual(plan.references, []);
        const result = await action('deleteModule', plan);
        assert.ok(!result.generationError, result.generationError);
        report.deleted.push({ module, ...result });
        await save();
    }
    for (const directory of [
        'config-source/showcase',
        'config-source/workshop',
        'config-source/lobby',
        'config-source/common',
        'tests/examples',
    ]) {
        // 固定相对路径，源和目的地均在身份已核对的独立副本内；不移动序列化资产。
        const destination = resolve(root, '.yzforge/archived-examples', directory);
        await mkdir(dirname(destination), { recursive: true });
        await rename(resolve(root, directory), destination).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
    await action('generate');
    report.empty = await runVerification(root, 'empty-template', [
        {
            name: 'empty boot and cleanup',
            args: ['tests/integration/verify-template.mjs', await previewURL(), marker.appId],
        },
    ]);
    await stage('workbench-create');
    for (const request of [
        { kind: 'module', id: 'catalog', displayName: '目录开发演练' },
        { kind: 'table', module: 'catalog', bundle: 'default', id: 'products' },
        { kind: 'service', module: 'catalog', id: 'Catalog' },
        { kind: 'page', module: 'catalog', bundle: 'default', id: 'Catalog', viewModel: true, visibility: 'public' },
        { kind: 'popup', module: 'catalog', bundle: 'default', id: 'Product', viewModel: true },
        { kind: 'part', module: 'catalog', bundle: 'default', id: 'ProductRow' },
    ]) {
        const plan = await action('previewCreate', request);
        assert.deepEqual(plan.conflicts, []);
        const result = await action('create', { request: plan.request, signature: plan.signature });
        assert.ok(!result.generationError, result.generationError);
        report.created.push({ request, ...result });
        await save();
    }
    await stage('compose-and-bind');
    const workbookPath = resolve(root, 'config-source/catalog/products.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);
    const sheet = workbook.getWorksheet('Products');
    assert.ok(sheet);
    // 重建数据页，保留工作台的配置页和四行表头，避免 spliceRows 遗留空行。
    const headers = [1, 2, 3, 4].map((row) => sheet.getRow(row).values.slice(1));
    workbook.removeWorksheet(sheet.id);
    const products = workbook.addWorksheet('Products');
    products.addRows(headers);
    for (let id = 1; id <= 120; id++) products.addRow([id, '产品 ' + String(id).padStart(3, '0'), true]);
    await workbook.xlsx.writeFile(workbookPath);
    await composeCatalog(call, report.created);
    await writeCatalogSources(root);
    await editor('return Editor.Message.request("asset-db","refresh-asset","db://assets");');
    await action('generate');
    await stage('verify');
    const tests = (await readdir(resolve(root, 'tests'))).filter((file) => /\.test\.(ts|mjs)$/.test(file)).sort();
    report.checks = await runVerification(root, 'empty-project', [
        { name: 'lint', args: ['node_modules/eslint/bin/eslint.js', '.', '--max-warnings', '0'] },
        { name: 'format', args: ['node_modules/prettier/bin/prettier.cjs', '.', '--check'] },
        { name: 'runtime types', args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'] },
        {
            name: 'contract types',
            args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.contracts.json'],
        },
        { name: 'architecture and generated outputs', args: ['tools/yzforge/cli.mjs', 'check'] },
        {
            name: 'framework and tools',
            args: ['--import', './tools/yzforge/register-tests.mjs', '--test', ...tests.map((file) => `tests/${file}`)],
        },
    ]);
    report.diagnostics = (await call('run_script_diagnostics')).data;
    assert.equal(report.diagnostics.ok, true, JSON.stringify(report.diagnostics));
    report.runtime = await verifyCatalog(await previewURL(), marker.appId);
    report.ok = true;
    report.stage = 'complete';
} catch (error) {
    report.error = { message: error.message, stack: error.stack };
    throw error;
} finally {
    report.finishedAt = new Date().toISOString();
    await save();
    console.log('Trial report:', resolve(root, '.yzforge/empty-project-report.json'));
}
