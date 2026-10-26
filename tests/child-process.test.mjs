import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { drainChild } from '../tools/yzforge/validation/child-process.mjs';

test('子进程取消等待物理退出，保留真实退出码和最后输出', async () => {
    const controller = new AbortController();
    let child,
        ready,
        settled = false,
        output = '';
    const started = new Promise((resolve) => {
        ready = resolve;
    });
    const work = drainChild(
        process.execPath,
        [
            '-e',
            "process.send('ready'); process.on('message',()=>{console.log('drained');process.exitCode=7;process.disconnect();});",
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            signal: controller.signal,
            onStart: (value) => {
                child = value;
                child.once('message', ready);
                child.stdout.on('data', (bytes) => {
                    output += bytes.toString();
                });
            },
        },
    ).then(
        (result) => {
            settled = true;
            return result;
        },
        (error) => {
            settled = true;
            throw error;
        },
    );
    const rejected = assert.rejects(work, (error) => error.code === 'YZ_CANCELLED' && error.exitCode === 7);
    await started;
    controller.abort();
    await setImmediate();
    assert.equal(settled, false);
    child.send('finish');
    await rejected;
    assert.match(output, /drained/);
});

test('启动失败会等到 close 后报告，已取消任务不启动子进程', async () => {
    await assert.rejects(drainChild(process.execPath + '-missing', [], { stdio: 'ignore' }), { code: 'ENOENT' });
    await assert.rejects(
        drainChild(process.execPath, ['-e', 'process.exit(0)'], {
            signal: AbortSignal.abort(),
            onStart: () => assert.fail('cancelled task started'),
        }),
        { name: 'AbortError' },
    );
});
