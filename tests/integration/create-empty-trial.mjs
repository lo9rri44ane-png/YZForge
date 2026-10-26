import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 完整独立项目保留资源 UUID；源工程不清理、不改配置。每次使用新的空目录。
const source = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const trials = join(source, '.yzforge/trials');
await mkdir(trials, { recursive: true });
const directory = await mkdtemp(join(trials, 'empty-'));
const project = join(directory, 'project');
await mkdir(project);
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: source,
    encoding: 'utf8',
    windowsHide: true,
})
    .split('\0')
    .filter(Boolean);
for (const file of new Set(files)) {
    const local = relative(source, resolve(source, file));
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Source path escaped the repository');
    assert.ok((await lstat(join(source, file))).isFile(), 'Only regular source files can be copied');
    await mkdir(dirname(join(project, file)), { recursive: true });
    await copyFile(join(source, file), join(project, file));
}
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const sourceUuid = pkg.uuid;
pkg.uuid = randomUUID();
pkg.name = 'YZForge-Empty-Trial';
await writeFile(join(project, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
lock.name = pkg.name;
if (lock.packages?.['']) lock.packages[''].name = pkg.name;
await writeFile(join(project, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
// 阻止嵌套副本的 Git 命令意外读取源工程提交或修改状态。
execFileSync('git', ['init', '--quiet', '--initial-branch=trial', project], { windowsHide: true });
await mkdir(join(project, '.yzforge'));
const marker = {
    kind: 'yzforge-empty-trial',
    project: await realpath(project),
    source,
    sourceUuid,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
        windowsHide: true,
    }).trim(),
    sourceDirty:
        execFileSync('git', ['status', '--porcelain'], {
            cwd: source,
            encoding: 'utf8',
            windowsHide: true,
        }).trim().length > 0,
    projectUuid: pkg.uuid,
    appId: 'com.yzforge.trial.' + pkg.uuid.slice(0, 8),
    createdAt: new Date().toISOString(),
};
await writeFile(join(project, '.yzforge/empty-trial.json'), JSON.stringify(marker, null, 2) + '\n');
console.log(
    JSON.stringify(
        { project, next: 'npm ci; open this copy in Creator; node tests/integration/verify-empty-project.mjs' },
        null,
        2,
    ),
);
