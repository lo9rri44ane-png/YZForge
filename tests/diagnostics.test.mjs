import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generate } from '../tools/yzforge/generators/generate.mjs';
import { initializeState } from '../tools/yzforge/operations/initialize-state.mjs';
import { digest } from '../tools/yzforge/project/project.mjs';
import gameConfig from '../tools/yzforge/project/game-config.cjs';
import { validateLocalizedBindings } from '../tools/yzforge/validation/localized-bindings.mjs';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-diagnostics-'));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (file, value) => {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
    };
    return { root, put };
}

test('生成诊断保留过期检查、先写产物再报告类型错误以及修复后的成功状态', async (t) => {
    const f = await fixture(t);
    // 只复制启动配置输入；所有写入和故障注入均在临时项目中。
    for (const file of ['.prettierrc.json', 'project-settings/framework.json', gameConfig.sourcePath])
        await f.put(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'));
    await f.put('assets/game/boot/GameSettings.ts', 'export {};');
    for (const file of ['app/app', 'assets/asset-types', 'app/game-config', 'modules/module-manager', 'ui/ui-manager'])
        await f.put(`assets/framework/${file}.ts`, 'export {};');
    const consumer = 'assets/game/consumer.ts';
    await f.put('tsconfig.json', {
        compilerOptions: { target: 'ES2020', module: 'ESNext', strict: true, types: [] },
        files: [consumer],
    });
    await f.put(consumer, "export const count: number = 'wrong';");
    await initializeState(f.root);
    await assert.rejects(generate(f.root, { check: true }), (error) => {
        assert.match(error.message, /^Generated output is stale/);
        assert.ok(error.diagnostics.length > 0);
        assert.ok(error.diagnostics.every((item) => item.code === 'YZ_GENERATED_STALE' && item.file));
        return true;
    });
    const result = await generate(f.root);
    assert.equal(result.valid, false);
    assert.equal(result.validationErrors.length, 1, result.validationErrors.join('\n'));
    assert.equal(result.diagnostics[0].code, 'TS2322');
    assert.equal(result.diagnostics[0].file, consumer);
    assert.equal(result.diagnostics[0].line, 1);
    assert.deepEqual(
        result.diagnostics.map((item) => item.message),
        result.validationErrors,
    );
    assert.ok((await readFile(join(f.root, gameConfig.outputPath), 'utf8')).includes('freezeGameConfig'));
    await assert.rejects(generate(f.root, { check: true }), (error) => {
        assert.equal(error.message, result.validationErrors.join('\n'));
        assert.deepEqual(error.diagnostics, result.diagnostics);
        return true;
    });
    await f.put(consumer, 'export const count: number = 1;');
    const checked = await generate(f.root, { check: true });
    assert.equal(checked.valid, true);
    assert.deepEqual(checked.validationErrors, []);
    assert.deepEqual(checked.diagnostics, []);

    const obsolete = 'assets/game/app/generated/old.ts',
        content = '// previous generated output\n';
    const owned = JSON.parse(await readFile(join(f.root, 'project-settings/state/generated-files.json'), 'utf8'));
    await f.put(obsolete, content);
    await f.put('project-settings/state/generated-files.json', { ...owned, [obsolete]: digest(content) });
    await assert.rejects(generate(f.root), (error) => {
        assert.equal(error.diagnostics[0].code, 'YZ_GENERATED_OBSOLETE');
        assert.equal(error.diagnostics[0].file, obsolete);
        return true;
    });
    const preview = await generate(f.root, { preview: true });
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.obsolete, [obsolete]);
    assert.deepEqual(preview.diagnostics, []);
    assert.equal(await readFile(join(f.root, obsolete), 'utf8'), content);
});

test('生命周期错误在写入前仍中止生成，并带有源代码诊断', async (t) => {
    const f = await fixture(t);
    await f.put(
        'project-settings/framework.json',
        await readFile(new URL('../project-settings/framework.json', import.meta.url), 'utf8'),
    );
    await f.put('tsconfig.json', { compilerOptions: { target: 'ES2020', types: [] } });
    await f.put(
        'assets/framework/base.ts',
        'export class Component {} export class GameComponent extends Component {}',
    );
    const file = 'assets/game/Page.ts';
    await f.put(
        file,
        "import { GameComponent } from '../framework/base';\nexport class Page extends GameComponent { onLoad() {} }",
    );
    await assert.rejects(generate(f.root, { check: true }), (error) => {
        assert.match(error.message, /Reserved engine hook onLoad/);
        assert.equal(error.diagnostics[0].code, 'YZ_LIFECYCLE_HOOK');
        assert.equal(error.diagnostics[0].file, file);
        assert.equal(error.diagnostics[0].line, 2);
        return true;
    });
    await assert.rejects(readFile(join(f.root, 'project-settings/state/generated-files.json')), { code: 'ENOENT' });
});

test('序列化绑定的收集和抛错模式保留原文本，附带资产路径且不猜行号', async (t) => {
    const f = await fixture(t),
        file = 'assets/game/broken.prefab';
    await f.put(file, [
        { __type__: 'cc.Node', _name: 'title' },
        { __type__: 'yzforge.LocalizedLabel', node: { __id__: 0 }, key: 'missing', namespace: 'demo/default' },
    ]);
    const metadata = new Map([['prefab', { source: join(f.root, file), importer: 'prefab' }]]);
    const diagnostics = [];
    const errors = await validateLocalizedBindings(f.root, metadata, { output: {} }, [], {
        collect: true,
        diagnostics,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /未登记多语言业务包/);
    assert.equal(diagnostics[0].message, errors[0]);
    assert.equal(diagnostics[0].code, 'YZ_LOCALIZED_BINDING');
    assert.equal(diagnostics[0].file, file);
    assert.equal(Object.hasOwn(diagnostics[0], 'line'), false);
    await assert.rejects(validateLocalizedBindings(f.root, metadata, { output: {} }), (error) => {
        assert.equal(error.message, errors.join('\n'));
        assert.deepEqual(error.diagnostics, diagnostics);
        return true;
    });
});

test('CLI 错误以统一 JSON 写入 stdout 并返回 1', async () => {
    await assert.rejects(
        promisify(execFile)(
            process.execPath,
            [fileURLToPath(new URL('../tools/yzforge/cli.mjs', import.meta.url)), 'unknown-diagnostic-command'],
            { windowsHide: true },
        ),
        (error) => {
            assert.equal(error.code, 1);
            assert.equal(error.stderr, '');
            const report = JSON.parse(error.stdout);
            assert.equal(report.ok, false);
            assert.equal(report.message, '未知命令：unknown-diagnostic-command');
            assert.deepEqual(report.diagnostics, [
                { code: 'YZ_CLI_ARGUMENT', severity: 'error', message: report.message },
            ]);
            return true;
        },
    );
});
