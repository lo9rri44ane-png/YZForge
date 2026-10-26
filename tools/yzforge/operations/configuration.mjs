import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import config from '../project/game-config.cjs';
import { withProjectLock, writeBatch, digest, pendingTransactions } from '../project/project.mjs';

export async function inspectConfiguration(root) {
    const bytes = await readFile(resolve(root, config.sourcePath), 'utf8');
    const source = config.validate(JSON.parse(bytes));
    const snapshot = config.resolveConfig(source, source.selection);
    return { selection: source.selection, configHash: snapshot.configHash, sourceHash: digest(bytes) };
}

/** Export native builder input only after current outputs pass validation. */
export async function buildOptions(root, platform) {
    const before = await inspectConfiguration(root);
    const snapshot = await config.readConfig(root);
    platform ??= snapshot.buildTargets[0];
    const { generate } = await import('../generators/generate.mjs');
    await generate(root, { check: true, platform });
    const after = await inspectConfiguration(root);
    if (before.sourceHash !== after.sourceHash || before.configHash !== snapshot.configHash)
        throw Object.assign(Error('导出期间配置已变化，请重新检查'), { code: 'YZ_CONFIG_CONFLICT' });
    const scene = JSON.parse(await readFile(resolve(root, config.bootstrapPath + '.meta'), 'utf8'));
    if (typeof scene.uuid !== 'string' || !scene.uuid) throw Error('启动场景缺少已导入的 UUID');
    const options = {
        platform,
        debug: snapshot.mode === 'debug',
        name: `yzforge-${snapshot.channel}`,
        buildPath: 'project://build',
        outputName: `${snapshot.channel}-${snapshot.environment}-${snapshot.mode}`,
        startScene: scene.uuid,
        scenes: [{ uuid: scene.uuid, url: 'db://' + config.bootstrapPath }],
        packages: {},
    };
    if (['wechat', 'douyin'].includes(snapshot.platform))
        options.packages[platform] = { appid: snapshot.platformAppId };
    config.assertBuild(snapshot, options);
    return { configHash: snapshot.configHash, selection: before.selection, options };
}

/** Update one authoritative source under the same lock used by generation and creation. */
export async function updateConfiguration(root, patch, expectedHash) {
    return withProjectLock(root, async () => {
        await config.assertUnlocked(root);
        if ((await pendingTransactions(root)).length) throw Error('存在未完成事务，请先执行 recovery');
        const before = await readFile(resolve(root, config.sourcePath), 'utf8');
        if (expectedHash && digest(before) !== expectedHash)
            throw Object.assign(Error('配置已变化，请重新查询'), { code: 'YZ_CONFIG_CONFLICT' });
        const source = config.validate(JSON.parse(before));
        if (!Object.keys(patch).length) throw Error('至少提供一个启动选择');
        source.selection = config.validateSelection({ ...source.selection, ...patch });
        const snapshot = config.resolveConfig(source, source.selection);
        const result = await writeBatch(
            root,
            { [config.sourcePath]: JSON.stringify(source, null, 2) + '\n' },
            'config',
        );
        return { ...result, selection: source.selection, configHash: snapshot.configHash, status: 'needs-generation' };
    });
}
