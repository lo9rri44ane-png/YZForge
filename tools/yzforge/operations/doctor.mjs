import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectPink } from '../project/pink.mjs';
import { inspectPinkEnvironment } from '../project/pink-environment.mjs';
import { inspectEditorProcesses } from '../project/editor-processes.mjs';
import { pendingTransactions } from '../project/project.mjs';
import { inspectConfiguration } from './configuration.mjs';
import diagnosticTools from '../validation/diagnostics.cjs';

export async function doctor(root, { fetchImpl, queryProcesses } = {}) {
    const exists = async (path) =>
        access(resolve(root, path)).then(
            () => true,
            () => false,
        );
    const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const [major, minor] = process.versions.node.split('.').map(Number);
    const checks = {
        node: (major === 22 && minor >= 13) || major >= 24,
        assets: await exists('assets'),
        configuration: await exists('project-settings/game-config.json'),
        resourceIdentities: await exists('project-settings/state/resource-identities.json'),
        generatedOwnership: await exists('project-settings/state/generated-files.json'),
    };
    const diagnostics = [];
    try {
        await inspectConfiguration(root);
    } catch (error) {
        checks.configuration = false;
        diagnostics.push(...diagnosticTools.diagnosticsFromError(error));
    }
    let pink;
    try {
        pink = await inspectPink(root, { fetchImpl });
    } catch (error) {
        pink = { state: 'unavailable', code: error.code, message: error.message, sceneAvailable: false };
    }
    const environment = await inspectPinkEnvironment(root, project);
    const editors = await inspectEditorProcesses(root, pink, { query: queryProcesses });
    diagnostics.push(...environment.diagnostics);
    delete environment.diagnostics;
    const add = (code, message, severity = 'warning') =>
        diagnostics.push(diagnosticTools.diagnostic(code, message, { severity }));
    if (pink.state === 'unavailable') add(pink.code, pink.message);
    if (editors.conflict)
        add(
            'YZ_PINK_EDITOR_CONFLICT',
            `同一项目正被 PinK 与 Creator 同时打开（Creator PID: ${editors.creators.map((item) => item.pid).join(', ')}）。请正常关闭此项目的 Creator 窗口，再重载 PinK；不要强杀未保存的编辑器。`,
            'error',
        );
    else if (editors.creators.length)
        add('YZ_PINK_CREATOR_OPEN', '此项目仍被 Creator 打开；切换到 PinK 前请先正常关闭此项目的 Creator 窗口。');
    if (editors.state !== 'checked')
        add(
            'YZ_PINK_PROCESS_UNVERIFIED',
            `编辑器进程检查为 ${editors.state}，不能据此排除重复打开项目。当前自动识别仅支持 Windows Creator 的 --project 参数。`,
        );
    checks.environment = !diagnostics.some((item) => item.severity === 'error');
    return {
        valid: Object.values(checks).every(Boolean),
        scope: 'source-tools-and-local-environment',
        diagnostics,
        project: root,
        node: process.versions.node,
        declaredEngine: environment.declaredEngine,
        typesPresent: await exists('temp/tsconfig.cocos.json'),
        checks,
        pink,
        environment,
        editors,
        capabilities: {
            sourceCreation: true,
            config: true,
            generation: true,
            nativeCreation: false,
            nativeBuild: false,
        },
        pending: await pendingTransactions(root),
        note: '引擎来源取自本机类型声明、脚本索引及对应 package.json，不代表活服务选项或运行时验收。warning 表示尚未验证；本命令不启动服务、不删除缓存、不结束进程。',
    };
}
