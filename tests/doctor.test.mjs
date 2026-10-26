import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectPinkEnvironment } from '../tools/yzforge/project/pink-environment.mjs';
import { inspectEditorProcesses, queryEditorProcesses } from '../tools/yzforge/project/editor-processes.mjs';
import { runCommand } from '../tools/yzforge/commands.mjs';

const targetPath = (name) => `temp/programming/packer-driver/targets/${name}`;
const typesFile = 'temp/tsconfig.cocos.json';
const declarationFile = 'temp/declarations/cc.d.ts';
const version = '4.0.0-beta.0';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'yz doctor 中文 '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (file, data) => {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), typeof data === 'string' ? data : JSON.stringify(data));
    };
    const project = { name: 'doctor-fixture', cocos: { version } };
    const sdk = join(root, 'engine');
    await put('package.json', project);
    await put('engine/package.json', { version });
    await put('engine/bin/.declarations/cc.d.ts', 'declare module "cc" {}');
    await put('engine/editor/assets/pass.ts', 'export {};');
    await put(typesFile, { compilerOptions: { paths: { 'db://internal/*': [join(sdk, 'editor/assets/*')] } } });
    await put(declarationFile, `/// <reference path="${join(sdk, 'bin/.declarations/cc.d.ts')}" />`);
    for (const target of ['editor', 'preview']) {
        await put(`${targetPath(target)}/import-map.json`, {
            imports: { [pathToFileURL(join(sdk, 'editor/assets/pass.ts')).href]: './chunks/builtin.js' },
            scopes: { 'project:///': { 'app:///entry': './chunks/app.js', 'app:///alias': './chunks/app.js' } },
        });
        await put(`${targetPath(target)}/chunks/builtin.js`, 'System.register([],()=>({}));');
        await put(`${targetPath(target)}/chunks/app.js`, 'System.register([],()=>({}));');
    }
    return { root, put, project, sdk, inspect: () => inspectPinkEnvironment(root, project) };
}

test('doctor accepts matching engine evidence, JSONC and scoped import maps without changing files', async (t) => {
    const f = await fixture(t);
    const config = await readFile(join(f.root, typesFile), 'utf8');
    await f.put(typesFile, '// generated types\n' + config);
    const result = await f.inspect();
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.engines.length, 1);
    assert.equal(result.engines[0].version, version);
    assert.equal(result.types.state, 'checked');
    assert.equal(result.targets.preview.chunks, 2);
    assert.equal(await readFile(join(f.root, typesFile), 'utf8'), '// generated types\n' + config);
});

test('doctor reports missing builtin and scoped application chunks without attempting cache repair', async (t) => {
    const f = await fixture(t);
    const file = `${targetPath('preview')}/import-map.json`;
    const before = await readFile(join(f.root, file), 'utf8');
    await rm(join(f.root, targetPath('preview'), 'chunks/builtin.js'));
    await rm(join(f.root, targetPath('preview'), 'chunks/app.js'));
    const result = await f.inspect();
    assert.equal(result.targets.preview.state, 'incomplete');
    assert.deepEqual(result.targets.preview.missing.sort(), ['chunks/app.js', 'chunks/builtin.js']);
    assert.equal(result.targets.editor.state, 'checked');
    const diagnostic = result.diagnostics.find((item) => item.code === 'YZ_PINK_CHUNKS_MISSING');
    assert.equal(diagnostic.severity, 'error');
    assert.equal(diagnostic.file, file);
    assert.match(diagnostic.message, /不要在活服务运行时删除/);
    assert.equal(await readFile(join(f.root, file), 'utf8'), before);
});

test('doctor compares the actual cc declaration reference as well as the tsconfig path', async (t) => {
    const f = await fixture(t);
    await f.put('old-engine/package.json', { version: '3.8.8' });
    await f.put('old-engine/bin/.declarations/cc.d.ts', 'declare module "cc" {}');
    await f.put(declarationFile, `/// <reference path="${join(f.root, 'old-engine/bin/.declarations/cc.d.ts')}" />`);
    const result = await f.inspect();
    assert.ok(result.diagnostics.some((item) => item.code === 'YZ_PINK_ENGINE_MISMATCH'));
    assert.ok(result.diagnostics.some((item) => item.code === 'YZ_PINK_ENGINE_VERSION'));
});

test('doctor detects different engine directories even when their versions match', async (t) => {
    const f = await fixture(t);
    await f.put('second-engine/package.json', { version });
    await f.put(`${targetPath('editor')}/import-map.json`, {
        imports: { [pathToFileURL(join(f.root, 'second-engine/editor/assets/pass.ts')).href]: './chunks/builtin.js' },
    });
    assert.ok((await f.inspect()).diagnostics.some((item) => item.code === 'YZ_PINK_ENGINE_MISMATCH'));
});

test('doctor rejects a missing engine declaration and an incompatible declared version', async (t) => {
    const f = await fixture(t);
    f.project.cocos.version = '4.1.0';
    await rm(join(f.sdk, 'bin/.declarations/cc.d.ts'));
    const codes = (await f.inspect()).diagnostics.map((item) => item.code);
    assert.ok(codes.includes('YZ_PINK_TYPES_REFERENCE_MISSING'));
    assert.ok(codes.includes('YZ_PINK_ENGINE_VERSION'));
});

test('doctor distinguishes absent cold caches from malformed caches and rejects escaping chunk paths', async (t) => {
    const f = await fixture(t);
    await rm(join(f.root, 'temp'), { recursive: true });
    const absent = await f.inspect();
    assert.equal(absent.types.state, 'absent');
    assert.equal(absent.targets.preview.state, 'absent');
    assert.ok(absent.diagnostics.every((item) => item.severity === 'warning'));
    await f.put(typesFile, '{broken');
    await f.put(declarationFile, '');
    await f.put(`${targetPath('editor')}/import-map.json`, '{broken');
    await f.put(`${targetPath('preview')}/import-map.json`, { imports: { app: './chunks/%2e%2e/%2e%2e/outside.js' } });
    const invalid = await f.inspect();
    assert.equal(invalid.types.state, 'invalid');
    assert.equal(invalid.targets.editor.state, 'invalid');
    assert.equal(invalid.targets.preview.state, 'invalid');
    assert.ok(invalid.diagnostics.some((item) => item.code === 'YZ_PINK_CACHE_INVALID' && /越出/.test(item.message)));
});

test('editor conflict detection matches complete project arguments and never exposes raw command lines', async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, 'other'));
    const result = await inspectEditorProcesses(
        f.root,
        { state: 'initializing', pid: 10 },
        {
            query: async () => ({
                state: 'checked',
                processes: [
                    {
                        ProcessId: 11,
                        CommandLine: `"C:/Creator/CocosCreator.exe" --project "${f.root}" --secret=private-token`,
                    },
                    { ProcessId: 12, CommandLine: `CocosCreator.exe --project="${join(f.root, 'other')}"` },
                    { ProcessId: 13, CommandLine: `CocosCreator.exe --title "example --project ${f.root}"` },
                    { ProcessId: 14, CommandLine: `CocosCreator.exe --project="${f.root}"` },
                ],
            }),
        },
    );
    assert.equal(result.conflict, true);
    assert.deepEqual(
        result.creators.map((item) => item.pid),
        [11, 14],
    );
    assert.doesNotMatch(JSON.stringify(result), /private-token|CommandLine|--project/);
});

test('unavailable process metadata is unverified; unrelated Creator and a closed PinK are not conflicts', async (t) => {
    const f = await fixture(t);
    const query = async () => ({
        state: 'checked',
        processes: [{ ProcessId: 11, CommandLine: `Creator.exe --project "${f.root}"` }],
    });
    assert.equal((await inspectEditorProcesses(f.root, { state: 'absent' }, { query })).conflict, false);
    assert.equal(
        (
            await inspectEditorProcesses(
                f.root,
                {},
                {
                    query: async () => {
                        throw Error('access denied');
                    },
                },
            )
        ).state,
        'unavailable',
    );
    assert.equal(
        (
            await inspectEditorProcesses(
                f.root,
                {},
                {
                    query: async () => ({ state: 'checked', processes: [{ ProcessId: 11, CommandLine: null }] }),
                },
            )
        ).state,
        'partial',
    );
    assert.deepEqual(await queryEditorProcesses('darwin'), { state: 'unsupported', processes: [] });
});

test('doctor CLI remains usable offline but returns failure for damaged generated caches', async (t) => {
    const f = await fixture(t);
    await f.put(
        'project-settings/game-config.json',
        await readFile(new URL('../project-settings/game-config.json', import.meta.url), 'utf8'),
    );
    await f.put('project-settings/state/resource-identities.json', {});
    await f.put('project-settings/state/generated-files.json', {});
    await mkdir(join(f.root, 'assets'));
    const runtime = { queryProcesses: async () => ({ state: 'checked', processes: [] }) };
    const healthy = await runCommand(['doctor'], f.root, runtime);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.pink.state, 'absent');
    await rm(join(f.root, targetPath('preview'), 'chunks/app.js'));
    const broken = await runCommand(['doctor'], f.root, runtime);
    assert.equal(broken.ok, false);
    assert.equal(broken.status, 'failed');
    assert.ok(broken.diagnostics.some((item) => item.code === 'YZ_PINK_CHUNKS_MISSING'));
});
