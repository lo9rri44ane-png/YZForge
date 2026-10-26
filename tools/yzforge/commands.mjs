import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import diagnosticTools from './validation/diagnostics.cjs';

const option = (type = 'string') => ({ type });
const common = { project: option(), help: option('boolean'), json: option('boolean') };
export const commandOptions = {
    doctor: {},
    config: {
        channel: option(),
        mode: option(),
        environment: option(),
        'app-version': option(),
        'expected-hash': option(),
        platform: option(),
    },
    create: {
        kind: option(),
        module: option(),
        id: option(),
        delivery: option(),
        'code-only': option('boolean'),
        plan: option(),
        bundle: option(),
    },
    generate: { 'dry-run': option('boolean'), platform: option(), 'preview-formulas': option('boolean') },
    check: { platform: option() },
    watch: { debounce: option() },
    recovery: { id: option(), signature: option() },
    'formula-status': {},
    recalculate: { source: option() },
    'audit-build': { output: option(), platform: option() },
    'init-state': {},
    'preview-language-rename': { module: option(), bundle: option(), from: option(), to: option() },
};

function usage(command) {
    const examples = [
        'doctor',
        'config show',
        'config set --channel web_local --mode debug --environment dev',
        'create plan --kind service --module workshop --id Inventory',
        'create plan --kind module --id inventory --delivery eager --code-only',
        'create apply --plan <signature>',
        'generate --dry-run',
        'generate',
        'check',
        'watch',
        'recovery list',
        'recovery inspect --id <id>',
        'recovery apply --id <id> --signature <signature>',
    ];
    return {
        command: command ?? 'help',
        commands: command ? undefined : Object.keys(commandOptions),
        options: { ...common, ...(commandOptions[command] ?? {}) },
        examples,
        native: 'Prefab、绑定、资源包和主项目构建管理尚未接通 PinK 直接接口；独立构建验收使用 npm run test:pink-build，不转调 Creator MCP。',
    };
}

export async function runCommand(argv, defaultRoot = fileURLToPath(new URL('../../', import.meta.url)), runtime = {}) {
    const command = argv[0] ?? 'help';
    try {
        if (['help', '--help', '-h'].includes(command)) return { ok: true, status: 'completed', ...usage() };
        if (!Object.hasOwn(commandOptions, command))
            throw Object.assign(Error(`未知命令：${command}`), { code: 'YZ_CLI_ARGUMENT' });
        const { values, positionals } = parseArgs({
            args: argv.slice(1),
            options: { ...common, ...commandOptions[command] },
            allowPositionals: true,
            strict: true,
        });
        if (values.help) return { ok: true, status: 'completed', ...usage(command) };
        if (positionals.length > (['config', 'create', 'recovery'].includes(command) ? 1 : 0))
            throw Error('存在多余的位置参数');
        const root = await realpath(resolve(values.project ?? defaultRoot));
        const action = positionals[0];
        let result;
        if (command === 'doctor') result = await (await import('./operations/doctor.mjs')).doctor(root, runtime);
        else if (command === 'watch')
            result = await (
                await import('./operations/watch.mjs')
            ).watchProject(root, {
                ...runtime,
                debounceMs: values.debounce === undefined ? 250 : Number(values.debounce),
            });
        else if (command === 'config') {
            const tools = await import('./operations/configuration.mjs');
            if (!action || action === 'show') {
                if (Object.keys(values).some((key) => !Object.hasOwn(common, key)))
                    throw Error('config show 不接受修改选项');
                result = await tools.inspectConfiguration(root);
            } else if (action === 'set') {
                if (values.platform) throw Error('config set 不接受 --platform');
                const patch = Object.fromEntries(
                    ['channel', 'mode', 'environment']
                        .filter((key) => values[key] !== undefined)
                        .map((key) => [key, values[key]]),
                );
                if (values['app-version'] !== undefined) patch.appVersion = values['app-version'];
                result = await tools.updateConfiguration(root, patch, values['expected-hash']);
            } else if (action === 'build-options') {
                if (Object.keys(values).some((key) => !Object.hasOwn(common, key) && key !== 'platform'))
                    throw Error('config build-options 只接受 --platform');
                result = await tools.buildOptions(root, values.platform);
            } else throw Error('使用 config show、config set 或 config build-options');
        } else if (command === 'create') {
            const tools = await import('./operations/source-context.mjs');
            if (action === 'plan') {
                if (values.plan || !values.kind || !values.id)
                    throw Error('create plan 需要 --kind 和 --id，不接受 --plan');
                if (values.kind !== 'module' && (values.delivery || values['code-only']))
                    throw Error('--delivery 和 --code-only 只用于 module');
                if (values.kind === 'module' && values.module) throw Error('创建 module 使用 --id，不接受 --module');
                if (values.kind !== 'table' && values.bundle) throw Error('--bundle 只用于 table');
                if (values.kind !== 'module' && !values.module) throw Error('创建此类型需要 --module');
                result = await tools.planSourceCreation(root, {
                    kind: values.kind,
                    id: values.id,
                    ...(values.module ? { module: values.module } : {}),
                    ...(values.delivery ? { delivery: values.delivery } : {}),
                    ...(values['code-only'] ? { codeOnly: true } : {}),
                    ...(values.bundle ? { bundle: values.bundle } : {}),
                });
            } else if (action === 'apply') {
                if (Object.keys(values).some((key) => !Object.hasOwn(common, key) && key !== 'plan'))
                    throw Error('create apply 只接受 --plan');
                result = await tools.applySourceCreation(root, values.plan);
            } else throw Error('使用 create plan 或 create apply');
        } else if (command === 'recovery') {
            const allowed = {
                list: [],
                inspect: ['id'],
                apply: ['id', 'signature'],
                'creation-inspect': ['id'],
                'creation-cleanup': ['id', 'signature'],
            }[action ?? 'list'];
            if (!allowed || Object.keys(values).some((key) => !Object.hasOwn(common, key) && !allowed.includes(key)))
                throw Error('recovery 子命令或参数无效');
            if (allowed.some((key) => !values[key])) throw Error('recovery 缺少参数：' + allowed.join(', '));
            const project = await import('./project/project.mjs');
            if (!action || action === 'list') {
                const ctx = await (await import('./operations/source-context.mjs')).sourceContext(root);
                result = {
                    transactions: await project.pendingTransactions(root),
                    creations: await ctx.creation.list(),
                };
            } else if (action === 'inspect') result = await project.previewTransaction(root, values.id);
            else if (action === 'apply')
                result = await project.recoverTransaction(root, { id: values.id, signature: values.signature });
            else if (action === 'creation-inspect' || action === 'creation-cleanup') {
                const ctx = await (await import('./operations/source-context.mjs')).sourceContext(root);
                result =
                    action === 'creation-inspect'
                        ? await ctx.creation.previewCleanup({ id: values.id })
                        : await ctx.creation.cleanup({ id: values.id, signature: values.signature });
            } else throw Error('使用 recovery list、inspect、apply、creation-inspect 或 creation-cleanup');
        } else if (command === 'formula-status' || command === 'recalculate') {
            const tools = await import('./operations/recalculate.mjs');
            if (command === 'recalculate' && !values.source) throw Error('recalculate 需要 --source');
            result =
                command === 'formula-status'
                    ? await tools.formulaEnvironment()
                    : await tools.recalculate(root, values.source);
        } else if (command === 'audit-build') {
            if (!values.output) throw Error('audit-build 需要 --output');
            result = await (
                await import('./validation/build-audit.cjs')
            ).default.auditProjectBuild(root, values.output, values.platform);
            result.valid = result.problems.length === 0;
        } else if (command === 'init-state')
            result = await (await import('./operations/initialize-state.mjs')).initializeState(root);
        else if (command === 'preview-language-rename') {
            if (!values.module || !values.from || !values.to) throw Error('语言改名预览需要 --module、--from 和 --to');
            result = await (
                await import('./operations/language-rename.mjs')
            ).planLanguageRename(root, {
                module: values.module,
                bundle: values.bundle ?? 'default',
                from: values.from,
                to: values.to,
            });
        } else
            result = await (
                await import('./generators/generate.mjs')
            ).generate(root, {
                check: command === 'check',
                preview: !!values['dry-run'],
                platform: values.platform,
                previewFormulas: !!values['preview-formulas'],
            });
        const ok = result.valid !== false;
        return {
            ...result,
            command,
            ok,
            status: ok ? (result.status ?? 'completed') : result.transaction ? 'applied-needs-fix' : 'failed',
            diagnostics: result.diagnostics ?? [],
        };
    } catch (error) {
        return {
            ok: false,
            status: 'failed',
            command,
            code: error.code ?? 'YZ_TOOL_ERROR',
            message: error.message,
            diagnostics: diagnosticTools.diagnosticsFromError(error),
        };
    }
}
