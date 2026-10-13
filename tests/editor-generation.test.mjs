import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const entry = new URL('../extensions/yzforge-editor/main.js', import.meta.url);
const require = createRequire(entry);
const source = await readFile(entry, 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function editor(
    generate,
    execFile = () => {
        throw Error('Unexpected process');
    },
) {
    const timers = new Set();
    const watchers = new Map();
    const warnings = [];
    const requests = [];
    const exported = {};
    const context = vm.createContext({
        exports: exported,
        require: (name) => {
            if (name === 'fs')
                return {
                    ...require('fs'),
                    watchFile: (path, _options, listener) => watchers.set(path, listener),
                    unwatchFile: (path) => watchers.delete(path),
                    existsSync: () => false,
                };
            if (name === './bundle-config') return { ensurePresets: async () => {} };
            if (name === './game-settings') return { refreshChannels: async () => {} };
            if (name === '../../tools/yzforge/project/game-config.cjs')
                return { ...require(name), assertUnlocked: async () => {} };
            if (name === 'child_process') return { execFile };
            return require(name);
        },
        Editor: {
            Project: { path: fileURLToPath(new URL('../', import.meta.url)) },
            Message: {
                addBroadcastListener() {},
                removeBroadcastListener() {},
                request: async (...args) => {
                    requests.push(args);
                },
            },
        },
        setTimeout: (callback) => {
            timers.add(callback);
            return callback;
        },
        clearTimeout: (callback) => timers.delete(callback),
        console: { warn: (message) => warnings.push(message) },
        generate,
    });
    vm.runInContext(source, context);
    const generateOnce = vm.runInContext('actions.generate', context);
    // 仅替换耗时的资源生成；实际监听、串行队列、错误分类及重试代码完整运行。
    vm.runInContext('actions.generate = generate;', context);
    exported.load();
    return {
        async advance() {
            const timer = timers.values().next().value;
            assert.ok(timer, 'expected scheduled generation');
            timers.delete(timer);
            timer();
            await tick();
        },
        change() {
            for (const listener of watchers.values()) listener();
        },
        status: () => JSON.parse(vm.runInContext('JSON.stringify(autoStatus)', context)),
        pending: () => timers.size,
        unload: () => exported.unload(),
        processError: () => vm.runInContext('runTool("generate")', context),
        generateOnce,
        dispatch: exported.methods.dispatch,
        stubAction(action, implementation) {
            context.stubbedAction = implementation;
            vm.runInContext(`actions[${JSON.stringify(action)}] = stubbedAction;`, context);
        },
        requests,
        warnings,
    };
}

test('自动生成：构建锁期间合并修改，释放锁后无需再次保存即可生成最新配置', async () => {
    let busy = true;
    let version = 1;
    const generated = [];
    const editorState = editor(async () => {
        if (busy) throw Object.assign(Error('build locked'), { code: 'GAME_BUILD_BUSY' });
        generated.push(version);
    });
    try {
        await editorState.advance();
        assert.equal(editorState.status().state, 'waiting');
        version = 2;
        editorState.change();
        editorState.change();
        assert.equal(editorState.pending(), 1);
        await editorState.advance();
        assert.deepEqual(generated, []);
        busy = false;
        await editorState.advance();
        assert.deepEqual(generated, [2]);
        assert.equal(editorState.status().state, 'ready');
        assert.equal(editorState.pending(), 0);
        assert.deepEqual(editorState.warnings, []);
    } finally {
        editorState.unload();
    }
});

test('工作台保留子进程结构化诊断与原有错误码', async () => {
    const diagnostics = [{ code: 'GAME_BUILD_BUSY', severity: 'error', message: 'build locked' }];
    const editorState = editor(
        async () => {},
        (_file, _args, _options, callback) =>
            callback(
                Error('failed'),
                '',
                JSON.stringify({ code: 'GAME_BUILD_BUSY', message: 'build locked', diagnostics }),
            ),
    );
    try {
        await assert.rejects(editorState.processError(), (error) => {
            assert.equal(error.code, 'GAME_BUILD_BUSY');
            assert.equal(error.message, 'build locked');
            assert.deepEqual(JSON.parse(JSON.stringify(error.diagnostics)), diagnostics);
            return true;
        });
    } finally {
        editorState.unload();
    }
});

test('使用方错误仍在刷新生成资产后抛出，创建成功后生成失败仍返回创建成果', async () => {
    const diagnostics = [
        { code: 'TS2322', severity: 'error', message: 'bad type', file: 'assets/game/test.ts', line: 3, column: 1 },
    ];
    let generationError;
    const editorState = editor(
        async () => {
            throw generationError;
        },
        (_file, args, _options, callback) => {
            assert.ok(args.includes('--editor'));
            const result =
                args[1] === 'preview'
                    ? { ok: true, obsolete: [], outputPaths: [] }
                    : { ok: false, valid: false, validationErrors: ['bad type'], diagnostics, obsolete: [] };
            callback(null, JSON.stringify(result), '');
        },
    );
    try {
        await assert.rejects(editorState.generateOnce(), (error) => {
            generationError = error;
            assert.equal(error.message, '资源索引和 Key 已更新，请修复以下引用后重新检查：\nbad type');
            assert.deepEqual(JSON.parse(JSON.stringify(error.diagnostics)), diagnostics);
            assert.deepEqual(editorState.requests, [['asset-db', 'refresh-asset', 'db://assets']]);
            return true;
        });
        let creations = 0;
        editorState.stubAction('create', async () => {
            creations++;
            return { created: ['assets/game/NewPage.ts'] };
        });
        const result = await editorState.dispatch('create');
        assert.equal(creations, 1);
        assert.deepEqual(result.created, ['assets/game/NewPage.ts']);
        assert.equal(result.generationError, generationError.message);
        assert.deepEqual(JSON.parse(JSON.stringify(result.generationDiagnostics)), diagnostics);
        assert.deepEqual(editorState.status().diagnostics, diagnostics);
        assert.equal(editorState.pending(), 0);
    } finally {
        editorState.unload();
    }
});

test('自动生成：无效配置不循环重试；卸载后迟到的构建忙错误不再启动任务', async () => {
    let fail;
    let mode = 'invalid';
    const editorState = editor(() => {
        if (mode === 'invalid') throw Error('invalid JSON');
        return new Promise((_resolve, reject) => {
            fail = reject;
        });
    });
    try {
        await editorState.advance();
        assert.equal(editorState.status().state, 'error');
        assert.equal(editorState.pending(), 0);
        assert.equal(editorState.warnings.length, 1);
        mode = 'pending';
        editorState.change();
        await editorState.advance();
        editorState.unload();
        fail(Object.assign(Error('locked'), { code: 'GAME_BUILD_BUSY' }));
        await tick();
        assert.equal(editorState.pending(), 0);
    } finally {
        editorState.unload();
    }
});

test('自动生成：子进程保留构建忙错误码，生成期间的新修改在完成后补做', async () => {
    let finish;
    let calls = 0;
    const editorState = editor(
        () => {
            calls++;
            if (calls === 1)
                return new Promise((resolve) => {
                    finish = resolve;
                });
        },
        (_file, _args, _options, callback) =>
            callback(
                Error('failed'),
                '',
                JSON.stringify({
                    code: 'GAME_BUILD_BUSY',
                    message: 'build locked',
                }),
            ),
    );
    try {
        await assert.rejects(editorState.processError(), { code: 'GAME_BUILD_BUSY', message: 'build locked' });
        await editorState.advance();
        editorState.change();
        finish();
        await tick();
        assert.equal(editorState.pending(), 1);
        await editorState.advance();
        assert.equal(calls, 2);
        assert.equal(editorState.pending(), 0);
    } finally {
        editorState.unload();
    }
});
