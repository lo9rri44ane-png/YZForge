import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../tools/yzforge/commands.mjs';
import { inspectPink } from '../tools/yzforge/project/pink.mjs';
import config from '../tools/yzforge/project/game-config.cjs';
import { sourceContext } from '../tools/yzforge/operations/source-context.mjs';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (file, value) => {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
    };
    await put('package.json', { name: 'test' });
    await put('.prettierrc.json', '{}');
    await put('project-settings/framework.json', '{}');
    await put(
        config.sourcePath,
        await readFile(new URL('../project-settings/game-config.json', import.meta.url), 'utf8'),
    );
    await put('assets/game/modules/demo/module.json', {
        id: 'demo',
        layoutVersion: 3,
        code: { mode: 'eager' },
        dependencies: {},
        bundles: {},
        views: {},
    });
    return { root, put, run: (args) => runCommand(args, root) };
}

test('配置修改不读取场景或类型缓存，拒绝错参、非法选择和过期的文件摘要', async (t) => {
    const f = await fixture(t);
    const before = await f.run(['config', 'show']);
    assert.equal(before.ok, true);
    for (const args of [
        ['config', 'set', '--mode', 'unknown'],
        ['config', 'set', '--mode'],
        ['config', 'set', '--mod', 'release'],
        ['config', 'show', '--mode', 'release'],
        ['generate', '--unknown'],
        ['preview'],
        ['recovery', 'list', '--id', 'unused'],
        ['create', 'plan', '--kind', 'service', '--module', 'demo', '--id', 'A', '--bundle', 'default'],
    ])
        assert.equal((await f.run(args)).ok, false, args.join(' '));
    assert.equal((await f.run(['config', 'show'])).sourceHash, before.sourceHash);
    const changed = await f.run([
        'config',
        'set',
        '--mode',
        'release',
        '--environment',
        'prod',
        '--expected-hash',
        before.sourceHash,
    ]);
    assert.equal(changed.ok, true);
    assert.equal(changed.status, 'needs-generation');
    assert.equal((await config.readConfig(f.root)).mode, 'release');
    const conflict = await f.run(['config', 'set', '--mode', 'debug', '--expected-hash', before.sourceHash]);
    assert.equal(conflict.code, 'YZ_CONFIG_CONFLICT');
    await assert.rejects(access(join(f.root, 'assets/game/boot/Bootstrap.scene')));
    await assert.rejects(access(join(f.root, 'temp')));
});

test('失败创建的资源清理在修改任何文件前拒绝；构建锁同样阻止恢复', async (t) => {
    const f = await fixture(t);
    const ctx = await sourceContext(f.root);
    const asset = 'assets/game/modules/demo/code/Test.ts';
    const manifest = 'assets/game/modules/demo/module.json';
    const before = await readFile(join(f.root, manifest), 'utf8');
    await assert.rejects(
        ctx.creation.run(
            { request: { kind: 'component', module: 'demo' }, files: [{ path: asset }, { path: manifest }] },
            async (checkpoint) => {
                await mkdir(dirname(join(f.root, asset)), { recursive: true });
                for (const [file, content] of [
                    [asset, 'export class Test {}'],
                    [manifest, '{"incomplete":true}'],
                ]) {
                    await checkpoint(
                        { label: 'write', expected: { [file]: { content: Buffer.from(content).toString('base64') } } },
                        () => writeFile(join(f.root, file), content),
                    );
                }
                throw Error('interrupted');
            },
        ),
        /interrupted/,
    );
    const [record] = await ctx.creation.list();
    const preview = await ctx.creation.previewCleanup({ id: record.id });
    assert.ok(preview.references.length);
    const result = await f.run(['recovery', 'creation-cleanup', '--id', record.id, '--signature', preview.signature]);
    assert.equal(result.ok, false);
    assert.equal(await readFile(join(f.root, manifest), 'utf8'), '{"incomplete":true}');
    assert.notEqual(await readFile(join(f.root, manifest), 'utf8'), before);
    await access(join(f.root, asset));
    await f.put('.yzforge/game-build.lock', { channel: 'web_local', mode: 'debug', environment: 'dev' });
    assert.equal(
        (await f.run(['recovery', 'creation-cleanup', '--id', record.id, '--signature', preview.signature])).code,
        'GAME_BUILD_BUSY',
    );
});

test('配置表创建使用既有模板，写入可重新读取的工作簿', async (t) => {
    const f = await fixture(t);
    await f.put('assets/game/modules/demo/module.json', {
        id: 'demo',
        layoutVersion: 3,
        code: { mode: 'eager' },
        dependencies: {},
        bundles: { default: { id: 'm-demo' } },
        views: {},
    });
    const plan = await f.run(['create', 'plan', '--kind', 'table', '--module', 'demo', '--id', 'Items']);
    assert.equal(plan.ok, true, plan.message);
    const result = await f.run(['create', 'apply', '--plan', plan.signature]);
    assert.equal(result.ok, true, result.message);
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(f.root, 'config-source/demo/items.xlsx'));
    assert.ok(workbook.getWorksheet('Items'));
});

test('纯源码创建复用现有计划：离线创建、修改后拒绝旧计划、执行后不重复创建', async (t) => {
    const f = await fixture(t);
    const plan = await f.run(['create', 'plan', '--kind', 'service', '--module', 'demo', '--id', 'Inventory']);
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.sourceOnly, true);
    await f.put('project-settings/framework.json', '{"changed":true}');
    const stale = await f.run(['create', 'apply', '--plan', plan.signature]);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /重新预览/);
    const next = await f.run(['create', 'plan', '--kind', 'service', '--module', 'demo', '--id', 'Inventory']);
    const applied = await f.run(['create', 'apply', '--plan', next.signature]);
    assert.equal(applied.ok, true, applied.message);
    assert.equal(applied.status, 'needs-generation');
    const file = join(f.root, 'assets/game/modules/demo/code/services/InventoryService.ts');
    assert.match(await readFile(file, 'utf8'), /class InventoryService/);
    await assert.rejects(access(file + '.meta'));
    assert.equal((await f.run(['create', 'apply', '--plan', next.signature])).ok, false);
    assert.deepEqual((await f.run(['recovery', 'list'])).creations, []);
});

test('原生创建在写入前明确拒绝；纯代码模块与 ViewModel 不依赖编辑器', async (t) => {
    const f = await fixture(t);
    const native = await f.run(['create', 'plan', '--kind', 'page', '--module', 'demo', '--id', 'Home']);
    assert.equal(native.code, 'YZ_PINK_CAPABILITY');
    await assert.rejects(access(join(f.root, '.yzforge/creation-plans')));
    const module = await f.run([
        'create',
        'plan',
        '--kind',
        'module',
        '--id',
        'fresh',
        '--delivery',
        'eager',
        '--code-only',
    ]);
    assert.equal(module.ok, true, module.message);
    assert.equal((await f.run(['create', 'apply', '--plan', module.signature])).ok, true);
    const model = await f.run(['create', 'plan', '--kind', 'viewmodel', '--module', 'fresh', '--id', 'Home']);
    assert.equal(model.ok, true, model.message);
    assert.equal((await f.run(['create', 'apply', '--plan', model.signature])).ok, true);
    assert.match(
        await readFile(join(f.root, 'assets/game/modules/fresh/code/presentation/HomeViewModel.ts'), 'utf8'),
        /class HomeViewModel/,
    );
});

test('纯源码创建拒绝认领孤立元数据，预览后新出现的元数据使计划失效', async (t) => {
    const f = await fixture(t);
    const args = ['create', 'plan', '--kind', 'service', '--module', 'demo', '--id', 'Orphan'];
    const plan = await f.run(args);
    assert.equal(plan.ok, true);
    const file = 'assets/game/modules/demo/code/services/OrphanService.ts';
    await f.put(file + '.meta', { uuid: 'existing-identity' });
    assert.equal((await f.run(['create', 'apply', '--plan', plan.signature])).ok, false);
    assert.equal((await f.run(args)).code, 'YZ_PINK_CAPABILITY');
    await assert.rejects(access(join(f.root, file)));
    assert.equal(JSON.parse(await readFile(join(f.root, file + '.meta'), 'utf8')).uuid, 'existing-identity');
});

test('创建执行和配置变更在构建锁内被拒绝，不产生部分源文件', async (t) => {
    const f = await fixture(t);
    const plan = await f.run(['create', 'plan', '--kind', 'component', '--module', 'demo', '--id', 'Card']);
    assert.equal(plan.ok, true, plan.message);
    await f.put('.yzforge/game-build.lock', { channel: 'web_local', mode: 'debug', environment: 'dev' });
    assert.equal((await f.run(['config', 'set', '--mode', 'release'])).code, 'GAME_BUILD_BUSY');
    assert.equal((await f.run(['create', 'apply', '--plan', plan.signature])).code, 'GAME_BUILD_BUSY');
    assert.equal(
        (await f.run(['recovery', 'apply', '--id', 'missing', '--signature', 'missing'])).code,
        'GAME_BUILD_BUSY',
    );
    await assert.rejects(access(join(f.root, 'assets/game/modules/demo/code/components')));
});

test('PinK 身份验证先于凭据发送，输出不包含连接凭据', async (t) => {
    const f = await fixture(t);
    const actual = await realpath(f.root);
    const project = process.platform === 'win32' ? actual.toLowerCase() : actual;
    const projectKey = createHash('sha256').update(project).digest('hex');
    const identity = { protocol: 1, projectKey, ownerId: 'owner' };
    const descriptor = {
        ...identity,
        project,
        pid: process.pid,
        url: 'http://127.0.0.1:12345',
        token: 'secret-test-token',
        state: 'initializing',
        sceneSession: { token: 'private-session' },
    };
    await f.put('temp/.cocos-cli-backend/rendezvous.json', { protocol: 1, port: 12345 });
    await f.put('temp/.cocos-cli-backend/owner.json', descriptor);
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(url.endsWith('/identity') ? identity : descriptor));
    };
    const status = await inspectPink(f.root, { fetchImpl });
    assert.equal(status.state, 'initializing');
    assert.equal(status.sceneAvailable, false);
    assert.doesNotMatch(JSON.stringify(status), /secret-test-token|private-session/);
    assert.deepEqual(requests[0].options.headers, {});
    assert.equal(requests[1].options.headers.authorization, 'Bearer secret-test-token');
    const conflict = await runCommand(['doctor'], f.root, {
        fetchImpl,
        queryProcesses: async () => ({
            state: 'checked',
            processes: [{ ProcessId: 12, CommandLine: `CocosCreator.exe --project "${f.root}" --token=hidden` }],
        }),
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 'failed');
    assert.ok(
        conflict.diagnostics.some((item) => item.code === 'YZ_PINK_EDITOR_CONFLICT' && item.severity === 'error'),
    );
    assert.doesNotMatch(JSON.stringify(conflict), /secret-test-token|private-session|--token=hidden/);
    requests.length = 0;
    identity.projectKey = 'wrong';
    await assert.rejects(inspectPink(f.root, { fetchImpl }), { code: 'YZ_PINK_IDENTITY' });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].options.headers, {});
});
