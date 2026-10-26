import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { watchProject, watchedSource } from '../tools/yzforge/operations/watch.mjs';
import gameConfig from '../tools/yzforge/project/game-config.cjs';
import projectLock from '../tools/yzforge/project/project-lock.cjs';

test('源监听排除自身生成物、元数据和 Excel 临时文件', () => {
    for (const file of [
        'project-settings/game-config.json',
        'assets/game/modules/demo/module.json',
        'config-source/demo.xlsx',
        'assets/game/modules/demo/code/Home.ts',
    ])
        assert.equal(watchedSource(file), true, file);
    for (const file of [
        'project-settings/state/generated-files.json',
        'assets/game/app/generated/game-config.ts',
        'assets/game/modules/demo/public.ts',
        'assets/game/modules/demo/bundles/default/dynamic/config/table.json',
        'config-source/~$demo.xlsx',
        'assets/game/a.ts.meta',
        'assets/game/a.prefab',
    ])
        assert.equal(watchedSource(file), false, file);
});

test('watch 等待真实占用释放后自动补做，不需要再次修改源文件', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-watch-lock-'));
    await mkdir(join(root, '.yzforge'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const kind of ['build', 'generation']) {
        const file = join(root, kind === 'build' ? gameConfig.buildLockPath : '.yzforge/generation.lock');
        await writeFile(file, JSON.stringify({ pid: process.pid }));
        const controller = new AbortController();
        let deferred,
            calls = 0;
        const waiting = new Promise((resolve) => {
            deferred = resolve;
        });
        const timeout = setTimeout(() => controller.abort(), 5000);
        t.after(() => {
            clearTimeout(timeout);
            controller.abort();
        });
        const work = watchProject(root, {
            signal: controller.signal,
            generate: async () => {
                calls++;
                await projectLock.withProjectLock(root, () => gameConfig.assertUnlocked(root));
                return { valid: true };
            },
            onEvent: (event) => {
                if (event.event === 'generation-deferred') deferred();
                if (event.event === 'generation-finished') controller.abort();
            },
        });
        await waiting;
        await unlink(file);
        assert.equal((await work).valid, true, kind);
        assert.equal(calls, 2, kind);
        clearTimeout(timeout);
    }
});

test('watch 事件消费者异常会停止并等待生成收尾，且不重试状态不明的锁', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-watch-events-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const failed = await watchProject(root, {
        signal: new AbortController().signal,
        generate: async () => {
            calls++;
            return { valid: true };
        },
        onEvent: (event) => {
            if (event.event === 'generation-finished') throw Error('broken consumer');
        },
    });
    assert.equal(failed.valid, false);
    assert.match(failed.diagnostics[0].message, /broken consumer/);
    const controller = new AbortController();
    await mkdir(join(root, '.yzforge'));
    await writeFile(join(root, '.yzforge/generation.lock'), '{}');
    const events = [];
    const locked = await watchProject(root, {
        signal: controller.signal,
        generate: async () => {
            calls++;
            await projectLock.withProjectLock(root, () => assert.fail('must stay locked'));
        },
        onEvent: (event) => {
            events.push(event);
            if (event.event === 'generation-failed') controller.abort();
        },
    });
    assert.equal(locked.valid, false);
    assert.equal(calls, 2);
    assert.equal(
        events.some((event) => event.event === 'generation-deferred'),
        false,
    );
    assert.equal(await readFile(join(root, '.yzforge/generation.lock'), 'utf8'), '{}');
});

test('watch 生成失败后继续工作，并监听启动后新增的配置表目录', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-watch-new-'));
    const controller = new AbortController();
    let ready, seen;
    const started = new Promise((resolve) => {
        ready = resolve;
    });
    const imported = new Promise((resolve) => {
        seen = resolve;
    });
    const file = join(root, 'config-source/new.xlsx');
    let count = 0;
    const timeout = setTimeout(() => controller.abort(), 3000);
    t.after(async () => {
        clearTimeout(timeout);
        controller.abort();
        await rm(root, { recursive: true, force: true });
    });
    const work = watchProject(root, {
        signal: controller.signal,
        debounceMs: 20,
        generate: async () => {
            if (++count === 1) throw Error('initial validation failure');
            const value = await readFile(file, 'utf8');
            if (value === 'created') seen();
            if (value === 'updated') controller.abort();
            return { valid: true };
        },
        onEvent: (event) => {
            if (event.event === 'generation-failed') ready();
        },
    });
    await started;
    await mkdir(join(root, 'config-source'));
    await writeFile(file, 'created');
    await imported;
    await writeFile(file, 'updated');
    assert.equal((await work).valid, true);
    assert.ok(count >= 3);
});

test('watch 串行处理真实文件事件，停止时等待当前生成退出', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yzforge-watch-'));
    const controller = new AbortController();
    await mkdir(join(root, 'project-settings'));
    await writeFile(join(root, 'project-settings/game-config.json'), '{}');
    let release, started;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const ready = new Promise((resolve) => {
        started = resolve;
    });
    let count = 0,
        active = 0,
        maxActive = 0,
        finished = false;
    const timeout = setTimeout(() => controller.abort(), 3000);
    t.after(async () => {
        clearTimeout(timeout);
        controller.abort();
        release();
        await rm(root, { recursive: true, force: true });
    });
    const work = watchProject(root, {
        signal: controller.signal,
        debounceMs: 20,
        generate: async () => {
            active++;
            count++;
            maxActive = Math.max(maxActive, active);
            if (count === 1) {
                started();
                await gate;
            }
            active--;
            return { valid: true, paths: [] };
        },
        onEvent: (event) => {
            if (event.event === 'generation-finished' && count === 2) controller.abort();
        },
    }).then((value) => {
        finished = true;
        return value;
    });
    await ready;
    await writeFile(join(root, 'project-settings/game-config.json'), '{"changed":true}');
    assert.equal(finished, false);
    release();
    assert.equal((await work).status, 'stopped');
    assert.equal(count, 2);
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
    // Cancellation cannot report physical completion while generation still holds the transaction.
    const cancel = new AbortController();
    let exitGeneration;
    const wait = new Promise((resolve) => {
        exitGeneration = resolve;
    });
    let enter;
    const entered = new Promise((resolve) => {
        enter = resolve;
    });
    let settled = false;
    const stopped = watchProject(root, {
        signal: cancel.signal,
        generate: async () => {
            enter();
            await wait;
            return { valid: true };
        },
    }).then(() => {
        settled = true;
    });
    await entered;
    cancel.abort();
    await setImmediate();
    assert.equal(settled, false);
    exitGeneration();
    await stopped;
});
