import { spawn } from 'node:child_process';

/** Cancellation stops the pipeline; it never reports completion before the child closes. */
export async function drainChild(executable, args, { signal, onStart = () => {}, ...options } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { ...options, windowsHide: true });
        let failure;
        child.once('error', (error) => {
            failure = error;
        });
        child.once('close', (exitCode, exitSignal) => {
            const state = { pid: child.pid, exitCode, signal: exitSignal };
            if (failure) reject(Object.assign(failure, state));
            else if (signal?.aborted)
                reject(Object.assign(new Error('已取消；当前子进程已退出'), { code: 'YZ_CANCELLED', ...state }));
            else resolve(state);
        });
        try {
            onStart(child);
        } catch (error) {
            failure = error;
        }
    });
}
