import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import operation from '../tools/yzforge/operations/restore-directories.cjs';

test('新检出项目通过 AssetDB 补齐空目录，保留 UUID，忽略丢失的普通文件且可重复运行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-directories-'));
    try {
        await mkdir(join(root, 'assets/module'), { recursive: true });
        const meta = JSON.stringify({ importer: 'directory', uuid: 'original-folder-uuid' });
        await writeFile(join(root, 'assets/module/static.meta'), meta);
        await writeFile(
            join(root, 'assets/module/missing.ts.meta'),
            JSON.stringify({ importer: 'typescript', uuid: 'script' }),
        );
        const calls = [];
        const context = {
            inside: (value) => {
                const target = resolve(root, value);
                assert.ok(!relative(root, target).startsWith('..'));
                return target;
            },
            request: async (channel, method, url, content) => {
                calls.push({ channel, method, url });
                assert.equal(url, 'db://assets/module/static');
                if (method === 'create-asset') {
                    assert.equal(content, null);
                    await mkdir(join(root, 'assets/module/static'));
                } else {
                    assert.equal(method, 'query-asset-info');
                    return { uuid: 'original-folder-uuid', isDirectory: true };
                }
            },
        };
        assert.deepEqual(await operation.restoreDirectories(context), ['db://assets/module/static']);
        assert.equal(await readFile(join(root, 'assets/module/static.meta'), 'utf8'), meta);
        assert.deepEqual(await operation.restoreDirectories(context), []);
        assert.equal(calls.length, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
