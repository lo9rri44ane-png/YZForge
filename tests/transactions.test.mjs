import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
    writeBatch,
    pendingTransactions,
    previewTransaction,
    recoverTransaction,
} from '../tools/yzforge/project/project.mjs';

test('generation recovery restores only its own outputs and refuses changed previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-journal-'));
    assert.ok(root.startsWith(resolve(tmpdir()) + sep));
    try {
        const id = '1790000000000-abcd',
            base = join(root, '.yzforge/changes', id);
        await mkdir(base, { recursive: true });
        await writeFile(join(root, 'one.ts'), 'generated');
        await writeFile(join(root, 'two.ts'), 'old two');
        await writeFile(
            join(base, 'transaction.json'),
            JSON.stringify({
                formatVersion: 2,
                id,
                status: 'prepared',
                entries: [
                    { path: 'one.ts', previous: 'old one', content: 'generated' },
                    { path: 'two.ts', previous: 'old two', content: 'new two' },
                ],
            }),
        );
        assert.equal((await pendingTransactions(root)).length, 1);
        const original = await previewTransaction(root, id);
        await writeFile(join(root, 'one.ts'), 'user change');
        await assert.rejects(recoverTransaction(root, original), /条件变化|用户修改/);
        assert.equal(await readFile(join(root, 'one.ts'), 'utf8'), 'user change');
        await writeFile(join(root, 'one.ts'), 'generated');
        const lock = join(root, '.yzforge/generation.lock');
        const lockOwner = JSON.stringify({ pid: process.pid });
        await writeFile(lock, lockOwner);
        await assert.rejects(recoverTransaction(root, await previewTransaction(root, id)), /仍在运行/);
        assert.equal(await readFile(lock, 'utf8'), lockOwner);
        await unlink(lock);
        await recoverTransaction(root, await previewTransaction(root, id));
        assert.equal(await readFile(join(root, 'one.ts'), 'utf8'), 'old one');
        assert.equal(await readFile(join(root, 'two.ts'), 'utf8'), 'old two');
        assert.equal((await pendingTransactions(root)).length, 0);
        await writeBatch(root, { 'one.ts': 'ready', 'three.ts': 'third' });
        assert.equal(await readFile(join(root, 'three.ts'), 'utf8'), 'third');
        assert.equal((await pendingTransactions(root)).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('写入后响应丢失时自动回滚也保留新资产及整笔事务', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-auto-rollback-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'config.json'), 'old');
    const nativeRename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
        await nativeRename(from, to);
        if (to === join(root, 'assets/generated.ts')) throw Error('lost write response');
    });
    syncBuiltinESMExports();
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    await assert.rejects(
        writeBatch(root, { 'config.json': 'new', 'assets/generated.ts': 'generated' }),
        /lost write response/,
    );
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'new');
    assert.equal(await readFile(join(root, 'assets/generated.ts'), 'utf8'), 'generated');
    const [pending] = await pendingTransactions(root);
    assert.equal(pending.status, 'interrupted');
    assert.deepEqual((await previewTransaction(root, pending.id)).nativeRequired, ['assets/generated.ts']);
});

test('生成恢复涉及资源删除时在任何回滚前拒绝，保留文件和事务', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-native-recovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const id = '1790000000000-abcd',
        base = join(root, '.yzforge/changes', id);
    await mkdir(base, { recursive: true });
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets/generated.ts'), 'new asset');
    await writeFile(join(root, 'config.json'), 'new config');
    await writeFile(
        join(base, 'transaction.json'),
        JSON.stringify({
            formatVersion: 2,
            id,
            status: 'interrupted',
            entries: [
                { path: 'assets/generated.ts', previous: null, content: 'new asset' },
                { path: 'config.json', previous: 'old config', content: 'new config' },
            ],
        }),
    );
    const preview = await previewTransaction(root, id);
    assert.deepEqual(preview.nativeRequired, ['assets/generated.ts']);
    await assert.rejects(recoverTransaction(root, preview), { code: 'YZ_PINK_CAPABILITY' });
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'new config');
    assert.equal(await readFile(join(root, 'assets/generated.ts'), 'utf8'), 'new asset');
    assert.equal((await pendingTransactions(root)).length, 1);
});
