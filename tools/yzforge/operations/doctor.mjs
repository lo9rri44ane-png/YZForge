import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectPink } from '../project/pink.mjs';
import { pendingTransactions } from '../project/project.mjs';
import { inspectConfiguration } from './configuration.mjs';
import diagnosticTools from '../validation/diagnostics.cjs';

export async function doctor(root) {
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
        pink = await inspectPink(root);
    } catch (error) {
        pink = { state: 'unavailable', code: error.code, message: error.message, sceneAvailable: false };
    }
    return {
        valid: Object.values(checks).every(Boolean),
        scope: 'source-tools',
        diagnostics,
        project: root,
        node: process.versions.node,
        declaredEngine: project.creator?.version,
        typesPresent: await exists('temp/tsconfig.cocos.json'),
        checks,
        pink,
        capabilities: {
            sourceCreation: true,
            config: true,
            generation: true,
            nativeCreation: false,
            nativeBuild: false,
        },
        pending: await pendingTransactions(root),
        note: '现存类型声明不证明与当前 PinK 引擎匹配；原生操作仍需直接接口验收。',
    };
}
