import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import diagnosticTools from '../validation/diagnostics.cjs';

export function watchedSource(file) {
    file = file.replaceAll('\\', '/');
    if (
        /(^|\/)generated\//.test(file) ||
        /^project-settings\/(state|snapshots)\//.test(file) ||
        /\/dynamic\/(config|i18n)\//.test(file) ||
        /\/(public\.ts|yz-index\.json|yz-locale\.json)(\.meta)?$/.test(file) ||
        /(^|\/)~\$/.test(file)
    )
        return false;
    return /\.(ts|json|xlsx)$/.test(file);
}

/** Serial source generation. Cancellation stops new work and waits for the current transaction. */
export async function watchProject(root, { signal, onEvent = () => {}, debounceMs = 250, generate } = {}) {
    if (!signal) throw Error('watch 需要显式停止信号');
    if (!Number.isInteger(debounceMs) || debounceMs < 20 || debounceMs > 5000)
        throw Error('debounce 必须在 20 到 5000 毫秒之间');
    generate ??= (await import('../generators/generate.mjs')).generate;
    const watchers = new Map();
    let timer,
        running,
        pending = false,
        stopped = signal.aborted,
        last,
        fatal;
    let finish;
    const done = new Promise((resolve) => {
        finish = resolve;
    });
    function stop() {
        stopped = true;
        clearTimeout(timer);
        for (const watcher of watchers.values()) watcher.close();
        if (!running) finish();
    }
    function emit(event) {
        try {
            onEvent(event);
        } catch (error) {
            fatal = error;
            stop();
        }
    }
    function start() {
        if (stopped || running || !pending) return;
        pending = false;
        let retryDelay = debounceMs;
        // Assign running before callbacks can synchronously stop the watcher.
        running = Promise.resolve()
            .then(async () => {
                try {
                    emit({ event: 'generation-started' });
                    if (stopped) return;
                    last = await generate(root);
                    emit({
                        event: 'generation-finished',
                        ok: last.valid !== false,
                        paths: last.paths,
                        diagnostics: last.diagnostics ?? [],
                    });
                } catch (error) {
                    last = { valid: false };
                    const busy = ['GAME_BUILD_BUSY', 'YZ_PROJECT_BUSY'].includes(error.code);
                    if (busy) {
                        pending = true;
                        retryDelay = Math.max(1000, debounceMs);
                    }
                    emit({
                        event: busy ? 'generation-deferred' : 'generation-failed',
                        ok: false,
                        diagnostics: diagnosticTools.diagnosticsFromError(error),
                    });
                }
            })
            .finally(() => {
                running = undefined;
                if (stopped) finish();
                else if (pending) {
                    clearTimeout(timer);
                    timer = setTimeout(start, retryDelay);
                }
            });
    }
    function changed(file, directory = false) {
        if (stopped || !(watchedSource(file) || (directory && watchedSource(file + '/source.ts')))) return;
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(start, debounceMs);
    }
    function watchFailed(error) {
        fatal = error;
        stop();
        emit({ event: 'watch-failed', ok: false, diagnostics: diagnosticTools.diagnosticsFromError(error) });
    }
    async function attach(directory) {
        if (stopped || watchers.has(directory)) return;
        if (
            !(await access(join(root, directory)).then(
                () => true,
                () => false,
            )) ||
            stopped
        )
            return;
        // Another directory event may have attached the same watcher during access().
        if (watchers.has(directory)) return;
        const watcher = watch(join(root, directory), { recursive: true }, (event, name) => {
            if (name)
                changed(directory + '/' + name, event === 'rename' && !String(name).split(/[\\/]/).pop().includes('.'));
        });
        watcher.on('error', watchFailed);
        watchers.set(directory, watcher);
    }
    signal.addEventListener('abort', stop, { once: true });
    try {
        if (stopped) return { status: 'stopped', valid: true };
        const directories = ['project-settings', 'config-source', 'assets'];
        const rootWatcher = watch(root, (event, name) => {
            const directory = String(name);
            if (event !== 'rename' || !directories.includes(directory) || stopped) return;
            watchers.get(directory)?.close();
            watchers.delete(directory);
            changed(directory, true);
            void attach(directory).catch(watchFailed);
        });
        rootWatcher.on('error', watchFailed);
        watchers.set('.', rootWatcher);
        for (const directory of directories) await attach(directory);
        if (stopped) return { status: 'stopped', valid: !fatal };
        emit({
            event: 'watching',
            scope: 'source-files',
            note: '原生资源导入、场景和 Prefab 同步不在此监听范围内。',
        });
        pending = true;
        start();
        await done;
        return {
            status: 'stopped',
            valid: !fatal && last?.valid !== false,
            ...(fatal ? { diagnostics: diagnosticTools.diagnosticsFromError(fatal) } : {}),
        };
    } finally {
        stop();
        signal.removeEventListener('abort', stop);
        if (running) await running;
    }
}
