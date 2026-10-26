import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { drainChild } from '../../tools/yzforge/validation/child-process.mjs';

const { values } = parseArgs({
    options: { sdk: { type: 'string' }, runtime: { type: 'string' }, project: { type: 'string' } },
});
if (!values.sdk || !values.runtime) throw Error('需要 --sdk <PinK 引擎包目录> 和 --runtime <PinK 可执行文件>');
const source = await realpath(values.project ?? fileURLToPath(new URL('../../', import.meta.url)));
const sdk = await realpath(values.sdk),
    runtime = await realpath(values.runtime);
await lstat(join(sdk, 'dist/api/index.js'));
const trials = join(source, '.yzforge/trials');
await mkdir(trials, { recursive: true });
const realTrials = await realpath(trials);
function inside(parent, child) {
    const local = relative(parent, child);
    if (
        !local ||
        isAbsolute(local) ||
        local === '..' ||
        local.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    )
        throw Error('验收路径超出预期目录：' + child);
}
inside(source, realTrials);
const directory = await mkdtemp(join(realTrials, 'pink-'));
const project = join(directory, 'project');
await mkdir(project);
const report = {
    source,
    project,
    sdk,
    runtime,
    startedAt: new Date().toISOString(),
    scope: 'cold-import-build-types',
    ok: false,
    steps: [],
};
const controller = new AbortController();
const reportPath = join(directory, 'report.json');
const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
function cancel() {
    if (controller.signal.aborted || report.completedAt) return;
    report.cancelRequestedAt = new Date().toISOString();
    controller.abort();
    console.error('已请求停止验收；等待当前步骤退出后保存报告，不再启动后续步骤。');
}
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
async function command(name, executable, args, env = process.env) {
    controller.signal.throwIfAborted();
    const log = join(directory, name + '.log'),
        fd = openSync(log, 'w');
    const step = { name, log, status: 'running' };
    report.steps.push(step);
    try {
        await saveReport();
        const result = await drainChild(executable, args, {
            cwd: project,
            env,
            stdio: ['ignore', fd, fd],
            signal: controller.signal,
            onStart: (child) => {
                step.pid = child.pid;
            },
        });
        step.code = result.exitCode;
        step.signal = result.signal;
        if (step.code !== 0) throw Error(`${name} 失败，查看 ${log}`);
        step.status = 'completed';
    } catch (error) {
        step.status = controller.signal.aborted ? 'cancelled' : 'failed';
        step.code ??= error.exitCode;
        step.signal ??= error.signal;
        step.message = error.message;
        throw error;
    } finally {
        closeSync(fd);
        await saveReport();
    }
}
try {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: source,
        encoding: 'utf8',
        windowsHide: true,
    })
        .split('\0')
        .filter(Boolean);
    const hashes = {};
    for (const file of new Set(files)) {
        controller.signal.throwIfAborted();
        if (
            /^(extensions|\.agents|\.codex|temp|library|build|node_modules|\.yzforge)\//.test(file) ||
            file === 'funplay-cocos-mcp.config.json'
        )
            continue;
        const target = resolve(source, file);
        inside(source, target);
        // Deleted working-tree files are not copied; symlinks never escape into the trial.
        const stat = await lstat(target).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!stat) continue;
        if (!stat.isFile()) throw Error('验收只复制普通文件：' + file);
        inside(source, await realpath(target));
        await mkdir(dirname(join(project, file)), { recursive: true });
        await copyFile(target, join(project, file));
        hashes[file] = createHash('sha256')
            .update(await readFile(join(project, file)))
            .digest('hex');
    }
    const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    pkg.uuid = randomUUID();
    await writeFile(join(project, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=trial', project], { windowsHide: true });
    await writeFile(join(directory, 'source-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    await command('install', process.execPath, [npm, 'ci', '--no-audit', '--no-fund']);
    // No project host, cached declarations, Creator extension or MCP server is copied.
    await command(
        'build',
        runtime,
        [join(project, 'tests/integration/pink-build-worker.cjs'), project, sdk, join(directory, 'build-result.json')],
        { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    );
    report.build = JSON.parse(await readFile(join(directory, 'build-result.json'), 'utf8'));
    if (!report.build.ok) throw Error(report.build.message);
    const tsc = join(project, 'node_modules/typescript/lib/tsc.js');
    await command('types', process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json']);
    await command('contracts', process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.contracts.json']);
    await command('check', process.execPath, [
        join(project, 'tools/yzforge/cli.mjs'),
        'check',
        '--platform',
        'web-mobile',
    ]);
    report.ok = !controller.signal.aborted;
} catch (error) {
    report.message = error.message;
    process.exitCode = controller.signal.aborted ? 130 : 1;
}
report.status = controller.signal.aborted ? 'cancelled' : report.ok ? 'completed' : 'failed';
report.completedAt = new Date().toISOString();
report.unverified = ['PinK 场景创建与绑定', '浏览器交互', '小游戏真机'];
try {
    await saveReport();
    console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
} finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
}
