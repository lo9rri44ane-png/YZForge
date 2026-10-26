import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const entry = new URL('../extensions/yzforge-editor/build-hooks.js', import.meta.url);
const source = await readFile(entry, 'utf8'),
    require = createRequire(entry);
function fixture({ cli = false, compileError, registered = true } = {}) {
    const commands = [],
        messages = [],
        ended = [],
        exported = {};
    const lease = {};
    vm.runInNewContext(source, {
        exports: exported,
        require: (name) => {
            if (name === 'child_process')
                return {
                    execFile: (_file, args, _options, done) => {
                        commands.push(args);
                        done(commands.length === 2 ? compileError : null, '', compileError?.message ?? '');
                    },
                };
            if (name === '../../tools/yzforge/operations/game-build.cjs')
                return {
                    begin: async () => lease,
                    end: async (value) => {
                        if (value) ended.push(value);
                    },
                };
            if (name === 'fs/promises')
                return {
                    readdir: async () => [{ name: 'sample', isDirectory: () => true }],
                    readFile: async () => JSON.stringify({ views: { page: { className: 'sample.Page' } } }),
                };
            return require(name);
        },
        Editor: {
            Project: { path: 'fixture' },
            App: { args: cli ? { build: '' } : {} },
            Message: {
                request: async (...args) => {
                    messages.push(args);
                    return registered;
                },
            },
        },
    });
    return { hooks: exported, commands, messages, ended };
}

test('CLI 构建仍检查源码和 TS，且不依赖未启动的编辑场景类注册表', async () => {
    const f = fixture({ cli: true });
    await f.hooks.onBeforeBuild({ platform: 'web-desktop' });
    assert.ok(f.commands[0].includes('check') && f.commands[0].includes('web-desktop'));
    assert.ok(f.commands[1].includes('--noEmit'));
    assert.equal(f.messages.length, 0);
    assert.equal(f.ended.length, 0);
    await f.hooks.onError();
    assert.equal(f.ended.length, 1);
});

test('编辑器构建仍拒绝缺失的原生注册，CLI 编译失败也会释放构建锁', async () => {
    const editor = fixture({ registered: false });
    await assert.rejects(editor.hooks.onBeforeBuild({ platform: 'web-desktop' }), /尚未注册界面脚本 sample.Page/);
    assert.equal(editor.messages.length, 1);
    assert.equal(editor.ended.length, 1);
    const cli = fixture({ cli: true, compileError: Error('type error') });
    await assert.rejects(cli.hooks.onBeforeBuild({ platform: 'web-desktop' }), /type error/);
    assert.equal(cli.ended.length, 1);
});
