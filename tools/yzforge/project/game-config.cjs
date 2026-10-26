'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sourcePath = 'project-settings/game-config.json';
const outputPath = 'assets/game/app/generated/game-config.ts';
const snapshotPath = 'project-settings/generated/game-config.json';
const bootstrapPath = 'assets/game/boot/Bootstrap.scene';
const channelOptionsPath = 'assets/game/app/generated/channel-options.ts';
const buildLockPath = '.yzforge/game-build.lock';
const modes = ['debug', 'release'];
const environments = ['dev', 'staging', 'prod'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function record(value, label, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} 必须是对象`);
    for (const key of Object.keys(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || (keys && !keys.includes(key)))
            throw Error(`${label} 不支持字段 ${key}`);
    }
    return value;
}
function string(value, label, empty = false) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim())
        throw Error(`${label} 必须是${empty ? '' : '非空'}字符串，且没有首尾空格`);
    return value;
}
function identifier(value, label) {
    string(value, label);
    if (!/^[a-z][a-z0-9_-]*$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value))
        throw Error(`${label} 必须是稳定的小写字符串标识`);
    return value;
}
function url(value, label) {
    string(value, label, true);
    if (!value) return;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw Error(`${label} 必须为空或完整的 http(s) 地址`);
    }
    if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
    )
        throw Error(`${label} 不允许凭据、查询参数或片段`);
}
function jsonValue(value, label, depth = 0) {
    if (depth > 12) throw Error(`${label} 嵌套过深`);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
        value.forEach((item) => jsonValue(item, label, depth + 1));
        return;
    }
    record(value, label);
    for (const [key, item] of Object.entries(value)) jsonValue(item, `${label}.${key}`, depth + 1);
}
function validateSelection(selection) {
    record(selection, 'selection', ['appVersion', 'channel', 'mode', 'environment']);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selection.appVersion || ''))
        throw Error('游戏版本必须类似 1.2.0 或 1.2.0-beta.1');
    identifier(selection.channel, 'selection.channel');
    if (!modes.includes(selection.mode)) throw Error('mode 必须是 debug 或 release');
    if (!environments.includes(selection.environment)) throw Error('environment 必须是 dev、staging 或 prod');
    return selection;
}
function validate(source) {
    record(source, 'game-config', ['formatVersion', 'selection', 'modes', 'channels', 'preview', 'platforms']);
    if (source.formatVersion !== 3) throw Error('游戏配置必须使用 formatVersion: 3，并在 selection 中声明启动选择');
    validateSelection(source.selection);
    record(source.platforms, 'platforms');
    for (const [id, targets] of Object.entries(source.platforms)) {
        identifier(id, '平台 ID');
        if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length)
            throw Error(`${id} 的构建目标必须是非空、不重复的数组`);
        for (const target of targets) identifier(target, `${id} 构建目标`);
    }
    record(source.modes, 'modes', modes);
    for (const mode of modes) {
        const value = record(source.modes[mode], `modes.${mode}`, ['logLevel', 'showStats']);
        if (!['debug', 'info', 'warn', 'error', 'silent'].includes(value.logLevel))
            throw Error(`modes.${mode}.logLevel 无效`);
        if (typeof value.showStats !== 'boolean') throw Error(`modes.${mode}.showStats 必须是布尔值`);
    }
    record(source.preview, 'preview', ['mockSdk']);
    if (typeof source.preview.mockSdk !== 'boolean') throw Error('preview.mockSdk 必须是布尔值');
    record(source.channels, 'channels');
    if (!Object.keys(source.channels).length) throw Error('至少配置一个渠道');
    for (const [id, input] of Object.entries(source.channels)) {
        identifier(id, '渠道 ID');
        const channel = record(input, `channels.${id}`, [
            'name',
            'platform',
            'platformAppId',
            'integration',
            'ads',
            'share',
            'environments',
        ]);
        string(channel.name, `${id}.name`);
        if (!own(source.platforms, channel.platform)) throw Error(`${id}.platform 未在 platforms 中登记构建目标`);
        string(channel.platformAppId, `${id}.platformAppId`, true);
        identifier(channel.integration, `${id}.integration`);
        record(channel.ads, `${id}.ads`);
        for (const [placement, adId] of Object.entries(channel.ads)) {
            identifier(placement, '广告位名称');
            string(adId, `${id}.ads.${placement}`, true);
        }
        record(channel.share, `${id}.share`);
        for (const [key, template] of Object.entries(channel.share)) {
            identifier(key, '分享模板名称');
            record(template, `${id}.share.${key}`, ['title', 'imageUrl']);
            string(template.title, '分享标题');
            if (template.imageUrl !== undefined) string(template.imageUrl, '分享图片地址', true);
        }
        record(channel.environments, `${id}.environments`, environments);
        for (const [environment, config] of Object.entries(channel.environments)) {
            const label = `${id}.environments.${environment}`;
            record(config, label, ['apiBaseUrl', 'resourceBaseUrl', 'sdkParameters', 'timeoutMs']);
            url(config.apiBaseUrl, `${label}.apiBaseUrl`);
            url(config.resourceBaseUrl, `${label}.resourceBaseUrl`);
            record(config.sdkParameters, `${label}.sdkParameters`);
            jsonValue(config.sdkParameters, `${label}.sdkParameters`);
            if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2147483647)
                throw Error(`${label}.timeoutMs 必须是有效的正整数毫秒`);
        }
    }
    return source;
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
        );
    return value;
}
function hash(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex');
}
/** 单一解析入口：模式不会选择环境或覆盖服务器地址；只返回被选中的渠道配置。 */
function resolveConfig(source, selection) {
    validate(source);
    validateSelection(selection);
    if (!own(source.channels, selection.channel)) throw Error(`渠道不存在：${selection.channel}`);
    const channel = source.channels[selection.channel];
    if (!own(channel.environments, selection.environment))
        throw Error(`渠道 ${selection.channel} 未配置 ${selection.environment} 环境`);
    const environment = channel.environments[selection.environment];
    const resolved = {
        ...selection,
        channelName: channel.name,
        platform: channel.platform,
        buildTargets: source.platforms[channel.platform],
        platformAppId: channel.platformAppId,
        diagnostics: source.modes[selection.mode],
        endpoints: { apiBaseUrl: environment.apiBaseUrl, resourceBaseUrl: environment.resourceBaseUrl },
        sdk: {
            integration: channel.integration,
            ads: channel.ads,
            share: channel.share,
            parameters: environment.sdkParameters,
            timeoutMs: environment.timeoutMs,
        },
        previewMockSdk: source.preview.mockSdk,
    };
    return JSON.parse(JSON.stringify({ ...resolved, configHash: hash(resolved) }));
}
function assertBuild(config, options) {
    if (!config.buildTargets.includes(options.platform))
        throw Error(`渠道 ${config.channel} 的平台 ${config.platform} 与构建目标 ${options.platform} 不一致`);
    if (options.debug !== (config.mode === 'debug'))
        throw Error(`构建的 Debug 选项与游戏设置 ${config.mode} 不一致，请同步构建参数`);
    if (config.previewMockSdk) throw Error('构建前请在 JSON 中关闭 preview.mockSdk；模拟 SDK 仅用于预览');
    if (['wechat', 'douyin'].includes(config.platform)) {
        if (!config.platformAppId) throw Error('请在 game-config.json 中填写此渠道的真实 platformAppId');
        const platform = options.packages?.[options.platform] ?? {};
        if (platform.appid !== config.platformAppId) throw Error('Creator 平台 AppID 与游戏配置不一致，请同步构建参数');
    }
}
async function readSource(root) {
    return validate(JSON.parse(await fs.readFile(path.join(root, sourcePath), 'utf8')));
}
/** 启动选择与渠道参数来自同一份项目源文件，不读取编辑器场景。 */
async function readSelection(root) {
    return (await readSource(root)).selection;
}
async function readConfig(root) {
    const source = await readSource(root);
    return resolveConfig(source, source.selection);
}
/** 仅公开渠道 ID 和显示名，原生枚举的数值不进入场景存档。 */
function channelOptionsSource(source) {
    const options = Object.entries(validate(source).channels).map(([id, channel]) => ({ id, name: channel.name }));
    return `// 自动生成的原生渠道下拉列表；修改 project-settings/game-config.json。\n/** 组件保存 id，不保存选项的排列位置。 */\nexport const channelOptions: readonly { readonly id: string; readonly name: string }[] = ${JSON.stringify(options, null, 2)};\n`;
}
async function assertUnlocked(root) {
    try {
        const lock = JSON.parse(await fs.readFile(path.join(root, buildLockPath), 'utf8'));
        throw Object.assign(
            Error(
                `游戏构建正在使用配置（${lock.channel} / ${lock.mode} / ${lock.environment}）；请等待真实构建结束，任务状态无法确认时保留锁`,
            ),
            { code: 'GAME_BUILD_BUSY' },
        );
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}
module.exports = {
    sourcePath,
    outputPath,
    snapshotPath,
    bootstrapPath,
    channelOptionsPath,
    buildLockPath,
    modes,
    environments,
    validate,
    validateSelection,
    resolveConfig,
    assertBuild,
    readSource,
    readSelection,
    readConfig,
    channelOptionsSource,
    assertUnlocked,
    hash,
};
