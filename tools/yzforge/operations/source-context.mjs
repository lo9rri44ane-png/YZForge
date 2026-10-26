import { readFile, writeFile, mkdir, stat, unlink, rmdir, realpath } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { within, pendingTransactions } from '../project/project.mjs';
import config from '../project/game-config.cjs';
import creation from './creation.cjs';
import planning from './create-plan.cjs';
import execution from './execute-creation.cjs';

/** Ordinary source files only. Asset identity and serialization remain owned by PinK. */
export async function sourceContext(project) {
    const root = await realpath(project);
    function inside(value) {
        const target = within(root, value);
        let ancestor = target;
        while (!existsSync(ancestor)) ancestor = dirname(ancestor);
        within(root, realpathSync(ancestor));
        return target;
    }
    const unsupported = () => {
        throw Object.assign(Error('此操作需要 PinK 的直接资源接口'), { code: 'YZ_PINK_CAPABILITY' });
    };
    function source(url) {
        if (!url.startsWith('db://assets/')) throw Error('资源操作必须使用 db://assets/ 路径');
        const file = inside(url.slice(5));
        if (/\.(meta|prefab|scene)$/.test(file)) unsupported();
        return file;
    }
    const db = async (method, url, content) => {
        const file = source(url);
        if (method === 'query-asset-info') {
            const info = await stat(file).catch((error) => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            return info ? { file, url, isDirectory: info.isDirectory() } : null;
        }
        if (method === 'save-asset') return writeFile(file, content);
        if (method === 'delete-asset') {
            // Imported assets require native reference/UUID checks before deletion.
            if (existsSync(inside(file + '.meta'))) unsupported();
            return (await stat(file)).isDirectory() ? rmdir(file) : unlink(file);
        }
        unsupported();
    };
    const ctx = {
        sourceOnly: true,
        beforeApply: async () => {
            await config.assertUnlocked(root);
            if ((await pendingTransactions(root)).length) throw Error('存在未完成事务，请先执行 recovery');
        },
        root: () => root,
        inside,
        rel: (file) => relative(root, file).replaceAll('\\', '/'),
        url: (file) => 'db://' + relative(root, file).replaceAll('\\', '/'),
        designResolution: async () => null,
        assertBindingSceneSaved: unsupported,
        scene: unsupported,
        db,
        references: async (_record, changes) => {
            // Preflight the complete cleanup before restoring even one manifest.
            // Without the native graph, source-only cleanup cannot prove that a
            // newly imported script is unused, even when its bytes are unchanged.
            const blocked = changes.filter(
                (change) =>
                    change.path.startsWith('assets/') &&
                    (/\.(meta|prefab|scene)$/.test(change.path) ||
                        existsSync(inside(change.path + '.meta')) ||
                        (change.action === 'delete' && !change.directory)),
            );
            return blocked.map(
                (change) => `${change.path} 的资源引用无法由源命令确认；保留创建记录，等待 PinK 直接资源接口清理`,
            );
        },
        request: async (service, ...args) => {
            if (service !== 'asset-db') unsupported();
            return db(...args);
        },
    };
    ctx.creation = creation.createCreationTracker(ctx);
    return ctx;
}

export async function planSourceCreation(root, request) {
    if (
        !['service', 'viewmodel', 'component', 'module', 'table'].includes(request.kind) ||
        (request.kind === 'module' && (!request.codeOnly || request.delivery !== 'eager'))
    )
        throw Object.assign(
            Error(
                '当前源命令支持 Service、ViewModel、组件脚本、配置表，以及 eager --code-only 模块；页面和资源包需要 PinK 直接接口',
            ),
            { code: 'YZ_PINK_CAPABILITY' },
        );
    const ctx = await sourceContext(root);
    const plan = await planning.planCreation(ctx, request);
    const directory = ctx.inside('.yzforge/creation-plans');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, plan.signature + '.json'), JSON.stringify(plan, null, 2) + '\n');
    return { ...plan, valid: !plan.conflicts.length, status: 'planned' };
}

export async function applySourceCreation(root, signature) {
    if (!/^[a-f0-9]{64}$/.test(signature ?? '')) throw Error('请提供 create plan 返回的计划签名');
    const ctx = await sourceContext(root);
    const plan = JSON.parse(await readFile(ctx.inside(`.yzforge/creation-plans/${signature}.json`), 'utf8'));
    if (plan.signature !== signature || !plan.sourceOnly) throw Error('创建计划不属于源文件命令');
    const result = await execution.executeCreation(ctx, plan);
    return { ...result, status: 'needs-generation', files: plan.files, next: 'generate' };
}
