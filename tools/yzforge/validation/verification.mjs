import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function verificationEnvironment(root) {
    const git = (...args) => {
        try {
            return execFileSync('git', args, {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            }).trim();
        } catch {
            return undefined;
        }
    };
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const status = git('status', '--porcelain');
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        creator: pkg.creator?.version,
        commit: git('rev-parse', 'HEAD'),
        dirty: status === undefined ? undefined : status.length > 0,
        project: root,
    };
}

/** 所有入口共用的串行执行和留证；即使子进程启动失败，也保存已执行步骤与失败原因。 */
export async function runVerification(root, name, steps, details = {}) {
    const directory = resolve(
        root,
        '.yzforge/verification',
        `${new Date().toISOString().replaceAll(':', '-')}-${name}-${randomUUID().slice(0, 8)}`,
    );
    await mkdir(directory, { recursive: true });
    const report = {
        name,
        startedAt: new Date().toISOString(),
        environment: await verificationEnvironment(root),
        details,
        ok: false,
        steps: [],
    };
    try {
        for (const [index, step] of steps.entries()) {
            const started = performance.now();
            const file = resolve(directory, `${index + 1}.log`);
            const record = {
                name: step.name,
                args: step.args,
                log: relative(root, file).replaceAll('\\', '/'),
                startedAt: new Date().toISOString(),
                ok: false,
            };
            report.steps.push(record);
            console.log(`[${index + 1}/${steps.length}] ${step.name}`);
            let log;
            try {
                // 子进程直接写文件：不逐块解码 UTF-8，也不把全部输出积压在内存中。
                log = await open(file, 'w+');
                await new Promise((yes, no) => {
                    const child = spawn(process.execPath, step.args, {
                        cwd: root,
                        windowsHide: true,
                        stdio: ['ignore', log.fd, log.fd],
                    });
                    let spawnError;
                    child.once('error', (error) => {
                        spawnError = error;
                    });
                    child.once('close', (code, signal) => {
                        record.exitCode = code;
                        record.signal = signal;
                        if (spawnError) no(spawnError);
                        else if (code === 0) yes();
                        else no(Error(`${step.name} failed (${signal ?? code})`));
                    });
                });
                record.ok = true;
            } catch (error) {
                record.error = error.message;
                if (log) {
                    const size = (await log.stat()).size;
                    const tail = Buffer.alloc(Math.min(size, 16000));
                    await log.read(tail, 0, tail.length, size - tail.length);
                    console.error(tail.toString('utf8').slice(-8000));
                }
                throw error;
            } finally {
                record.durationMs = Math.round(performance.now() - started);
                await log?.close();
            }
        }
        report.ok = true;
        return report;
    } finally {
        report.finishedAt = new Date().toISOString();
        await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(`Verification report: ${relative(root, resolve(directory, 'report.json'))}`);
    }
}
