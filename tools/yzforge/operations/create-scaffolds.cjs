'use strict';
const path = require('node:path');
const naming = require('../project/naming.cjs');
const layout = require('../project/layout.cjs');
const localizationLayout = require('../project/localization-layout.cjs');
const { localizationSettings } = require('../project/settings.cjs');
const pascal = (id) => naming.named(id, 'component').className.replace(/Component$/, '');
const validId = (id) => {
    if (naming.slug(id) !== id || ['shared', 'default', 'constructor', 'prototype'].includes(id))
        throw Error('无效标识：' + id);
    return id;
};
/** 只描述创建步骤，不直接写磁盘或调用编辑器；模板与顺序只有此处一份。 */
exports.scaffold = async function (p, args) {
    const {
        root,
        inside,
        rel,
        url,
        moduleInfo,
        ensureFolder,
        saveJson,
        writeScript,
        waitClass,
        scene,
        request,
        bindingSource,
        resolveBindingFields,
        bindingPlan,
        workbookTools,
        read,
        bundleFolder,
        assertBindingSceneSaved,
    } = p;
    const tools = () => workbookTools();
    async function createPublicEntry(directory, manifest) {
        const { publicContracts } = await import('../generators/public-contracts.mjs');
        const output = { ...p.scriptSources };
        await publicContracts(root(), [{ ...manifest, code: manifest.code ?? { mode: 'eager' }, directory }], output);
        const target = path.join(directory, 'public.ts');
        await writeScript('create-asset', target, output[rel(target)]);
    }

    async function createModule(args) {
        if (args.delivery === 'none') args = { ...args, codeOnly: false, dependencies: {} };
        const id = validId(naming.slug(args.id)),
            directory = inside(`assets/game/modules/${id}`);
        if (await request('asset-db', 'query-asset-info', url(directory))) throw Error(`模块已存在：${id}`);
        await ensureFolder(directory);
        if (args.delivery !== 'none') {
            await ensureFolder(path.join(directory, 'code/generated'));
        }
        const manifest = {
            id,
            layoutVersion: layout.layoutVersion,
            displayName: args.displayName || id,
            dependencies: naming.dependencies([...p.modules, { id, dependencies: [] }], id, args.dependencies ?? []),
            ...(args.delivery === 'none' ? { code: { mode: 'none' } } : {}),
            bundles: args.codeOnly ? {} : { default: { id: `m-${id}`, root: 'bundles/default' } },
            views: {},
            audio: {},
        };
        if (manifest.bundles.default) {
            await bundleFolder(directory, manifest.bundles.default);
            await ensureFolder(path.join(directory, 'bundles/default/dynamic'));
            await ensureFolder(path.join(directory, 'bundles/default/static'));
        }
        await ensureFolder(path.join(directory, 'contracts'));
        if (args.delivery === 'none') {
            await createPublicEntry(directory, manifest);
            await saveJson(path.join(directory, 'module.json'), manifest);
            return { id, directory: rel(directory) };
        }
        const type = pascal(id),
            framework = path.relative(path.join(directory, 'code'), inside('assets/framework')).replaceAll('\\', '/');
        const dependencyImports = Object.entries(manifest.dependencies)
            .map(
                ([, dependency], index) =>
                    `import { ${pascal(dependency)}Module as dependency${index} } from '../../../${dependency}/public';`,
            )
            .join('\n');
        const dependencyRefs = Object.entries(manifest.dependencies)
            .map(([alias], index) => `'${alias}': dependency${index}`)
            .join(', ');
        await writeScript(
            'create-asset',
            path.join(directory, 'code/generated/dependencies.ts'),
            `// 自动生成：依赖只在 module.json 维护。\n${dependencyImports}\nexport const dependencies = { ${dependencyRefs} } as const;\n`,
        );
        await writeScript(
            'create-asset',
            path.join(directory, `code/${type}Module.ts`),
            `import { defineModule } from '${framework}/modules/module-manager';\nimport { ${type}Module } from '../public';\nimport { dependencies } from './generated/dependencies';\n/**\n * 显式装配模块服务，返回值在编译期匹配 public.ts 的 API 合同。\n * dependencies 按 module.json 的声明提供完整类型；无需 unknown 强制转换。\n * 需要内部服务时，在 code 中定义 moduleServices 合同，传入 services 选项并返回 services 对象。\n * UI 通过 this.ctx.services(服务合同) 读取；清理登记到 ctx.scope。\n */\nexport const create${type}Module = defineModule(${type}Module, { dependencies }, (ctx, _dependencies) => {\n  return { api: { /** 当前模块的稳定 ID。 */ get moduleId() { return ctx.id; } } };\n});\n`,
        );
        await writeScript(
            'create-asset',
            path.join(directory, 'contracts/api.ts'),
            `/** 人工维护的模块公开业务 API；实现留在 code。 */\nexport interface ${type}Api {\n  /** 当前模块的稳定 ID。 */\n  readonly moduleId: string;\n}\n`,
        );
        await createPublicEntry(directory, manifest);
        await ensureFolder(path.join(directory, 'contracts'));
        if (args.delivery !== 'eager') {
            await writeScript(
                'create-asset',
                path.join(directory, `code/${type}ModuleEntry.ts`),
                `import { _decorator } from 'cc';\nimport { ModuleEntry } from '${framework}/modules/module-entry';\nimport { create${type}Module } from './${type}Module';\nconst { ccclass } = _decorator;\n/** @internal 本地按需代码包入口；加载器读取工厂，业务不使用引擎生命周期启动模块。 */\n@ccclass('${id}.${type}ModuleEntry')\nexport class ${type}ModuleEntry extends ModuleEntry {\n    /** @internal 与 module.json 对应的模块 ID。 */\n    get moduleId(): string { return '${id}'; }\n    /** @internal 返回工厂函数，读取此属性不会执行业务初始化。 */\n    get factory() { return create${type}Module; }\n}\n`,
            );
            await waitClass(`${id}.${type}ModuleEntry`);
            const content = await scene('createPrefab', `${id}.${type}ModuleEntry`, `${type}ModuleEntry`, false);
            await request('asset-db', 'create-asset', url(path.join(directory, 'code/entry.prefab')), content);
            manifest.code = { mode: 'bundled', root: 'code', bundle: `code-${id}`, entryPath: 'entry' };
            await bundleFolder(directory, { root: 'code', id: manifest.code.bundle }, 'code');
        }
        // 源文件、原生绑定和资源包设置就绪后，最后登记模块。
        await saveJson(path.join(directory, 'module.json'), manifest);
        return { id, directory: rel(directory) };
    }

    async function createBundle(args) {
        const { directory, manifest } = await moduleInfo(args.module),
            group = args.id === 'default' ? 'default' : validId(args.id);
        if (manifest.bundles[group]) throw Error('资源包已存在');
        const definition = {
            id: group === 'default' ? `m-${manifest.id}` : `${manifest.id}-${group}`,
            root: `bundles/${group}`,
        };
        if (localizationLayout.physicalBundles(manifest)[group]) throw Error('此分组已由语言包使用');
        await bundleFolder(directory, definition);
        await ensureFolder(path.join(directory, definition.root, 'dynamic'));
        await ensureFolder(path.join(directory, definition.root, 'static'));
        manifest.bundles[group] = definition;
        await saveJson(path.join(directory, 'module.json'), manifest);
        return definition;
    }

    async function createScript(args) {
        const { directory, manifest } = await moduleInfo(args.module),
            type = naming.named(args.id, args.kind).className;
        const component = args.kind === 'component',
            folder = path.join(
                directory,
                component
                    ? layout.itemPaths('component', naming.named(args.id, args.kind).id, { className: type }).directory
                    : 'code/services',
            );
        await ensureFolder(folder);
        const framework = path.relative(folder, inside('assets/framework')).replaceAll('\\', '/');
        const content = component
            ? `import { _decorator } from 'cc';\nimport { GameComponent, ActivationContext } from '${framework}/components/game-component';\nconst { ccclass } = _decorator;\n/** 普通框架组件；业务使用 onInit/onActivate/onTick 等钩子，不覆盖引擎 onLoad/update。 */\n@ccclass('${manifest.id}.${type}')\nexport class ${type} extends GameComponent {\n  /** 绑定与模块上下文就绪后执行一次，同步初始化组件自身状态。 */\n  protected onInit(): void {}\n  /**\n   * 每次业务激活执行；异步工作放入 _activation.run，并通过 task.commit 安全提交结果。\n   * @param _activation - 本次激活上下文；失活时取消，下一次激活会得到新的上下文。\n   */\n  protected onActivate(_activation: ActivationContext): void {\n    // 不把钩子改成 async：使用 _activation.run(async task => { ...; task.commit(() => { ... }); });\n  }\n}\n`
            : `import type { ModuleContext } from '${framework}/modules/module-manager';\n/** 普通业务服务，用于可被多个界面共享的状态和业务规则；不依赖 Cocos 组件生命周期。 */\nexport class ${type} {\n  /**\n   * 创建服务；由模块工厂持有实例，需释放的监听或资源登记到对应 Scope。\n   * @param ctx - 宿主模块上下文；ctx.scope 覆盖本次模块业务实例。\n   */\n  constructor(private readonly ctx: ModuleContext) {}\n}\n`;
        const target = path.join(folder, `${type}.ts`);
        return writeScript('create-asset', target, content);
    }

    async function createView(args) {
        const { directory, manifest } = await moduleInfo(args.module),
            { id, className } = naming.named(args.id, args.kind || 'popup');
        if (manifest.views[id]) throw Error('界面已存在');
        if (args.visibility !== undefined && !['public', 'internal'].includes(args.visibility))
            throw Error('请选择正确的界面公开范围');
        const group = args.bundle || 'default',
            bundle = manifest.bundles[group];
        if (!bundle) throw Error('请先创建目标资源包，再创建界面');
        const resolution = p.resolution;
        if (!(resolution?.width > 0 && resolution?.height > 0)) throw Error('请先在 Creator 项目设置中配置设计分辨率');
        const paths = layout.itemPaths('view', id, { className, visibility: args.visibility ?? 'internal' });
        const code = path.join(directory, paths.directory),
            generated = path.join(code, 'generated');
        await ensureFolder(generated);
        const uiFolder = 'dynamic/ui';
        await ensureFolder(path.join(directory, bundle.root, uiFolder));
        const files = {
            [path.join(directory, paths.types)]:
                `// 界面参数与结果合同；公开范围由 module.json 的 visibility 决定。需要数据时将 void 替换为明确的只读对象类型。\n/** ui.open/pushPage 的参数类型，在 onShow 中通过 show.params 读取。 */\nexport type ${className}Params = void;\n/** show.finish 提交的业务结果类型，调用方在 handle.result 的 completed 分支读取。 */\nexport type ${className}Result = void;\n`,
            [path.join(generated, `${className}Binding.ts`)]: bindingSource(
                manifest.id,
                className,
                [],
                generated,
                false,
                layout.importPath(paths.binding, paths.types),
            ),
            [path.join(code, `${className}.ts`)]:
                `import { _decorator } from 'cc';\nimport { ${className}Binding } from './generated/${className}Binding';\nconst { ccclass } = _decorator;\n/** 完整 UI 的渲染与输入入口；节点来自 Binding，可按复杂度把业务规则委托给 Service/ViewModel。 */\n@ccclass('${manifest.id}.${className}')\nexport class ${className} extends ${className}Binding {\n  // 按需重写 onCreate/onShow/onHide/onDispose，不覆盖引擎生命周期。\n  // onShow(show: ViewShowContext<本界面Params, 本界面Result>) 可异步加载。\n  // 临时资源优先用 show.assets/show.config/show.audio，await 后通过 show.commit 同步修改节点。\n  // 点击监听使用 show.listen；成功用 show.finish(result)，取消用 show.dismiss()，返回用 show.ui.back()。\n}\n`,
        };
        if (args.viewModel || args.presenter) {
            const core = path.relative(code, inside('assets/framework/core')).replaceAll('\\', '/');
            const ui = path.relative(code, inside('assets/framework/ui/ui-view')).replaceAll('\\', '/');
            const types = layout.importPath(paths.script, paths.types);
            files[path.join(code, `${className}ViewModel.ts`)] = `import { State } from '${core}/state';
import type { Lifetime } from '${core}/scope';
/** 语义状态；不包含节点、显示资源或排版文本。 */
export interface ${className}State { readonly ready: boolean; }
/** 可供多个皮肤复用的展示逻辑；共享业务规则通过构造参数注入 Service。 */
export class ${className}ViewModel {
    private readonly data = new State<${className}State>({ ready: false });
    /** View 只能读取和订阅；输入通过本类的明确方法调用。 */
    readonly state = this.data.readonly;
    private started = false;
    /** @param owner 页面会话期限；导航挂起不结束，真正关闭才回收。 */
    constructor(private readonly owner: Lifetime) {}
    /** 明确的必需数据准备；独立区域不要放进整页屏障。稳定异步操作使用 Command。 */
    start(): void {
        this.owner.signal.throwIfAborted();
        if (this.started) return;
        this.started = true;
        this.data.set({ ready: true });
    }
}
`;
            files[path.join(code, `${className}.model.ts`)] =
                `import type { ViewModelFactory } from '${ui.replace(/ui-view$/, 'view-session')}';
import type { ${className}Params } from '${types}';
import { ${className}ViewModel } from './${className}ViewModel';
/** 同步组合依赖；通过 ctx.services 显式取得 Service，只向模型传入所需依赖。 */
export const create${className}Model: ViewModelFactory<${className}ViewModel, ${className}Params> = ({ scope }) =>
    new ${className}ViewModel(scope);
`;
            files[path.join(code, `${className}.ts`)] = `import { _decorator } from 'cc';
import type { ViewShowContext } from '${ui}';
import type { ${className}Params, ${className}Result } from '${types}';
import { ${className}Binding } from './generated/${className}Binding';
import type { ${className}State } from './${className}ViewModel';
import { create${className}Model } from './${className}.model';
const { ccclass } = _decorator;
/** View 负责节点和输入；ViewModel 提供语义状态及操作。 */
@ccclass('${manifest.id}.${className}')
export class ${className} extends ${className}Binding {
    /** 返回页面复用模型；每次显示独立绑定，复杂资源区域使用 show.bindings.prepare。 */
    protected onShow(show: ViewShowContext<${className}Params, ${className}Result>): void {
        const model = show.session.use(create${className}Model);
        show.bindings.watch(model.state, state => state, state => this.render(state));
        model.start();
        // 同步输入用 show.listen；异步操作用 show.bindings.command，交互端口随每次调用传入。
    }
    /** 只同步更新节点。按区域选择状态，避免余额变化重建整张列表。 */
    private render(_state: ${className}State): void { /* 使用自动绑定的节点。 */ }
}
`;
        }
        for (const [target, text] of Object.entries(files)) await writeScript('create-asset', target, text);
        await waitClass(`${manifest.id}.${className}`);
        const content = await scene('createView', `${manifest.id}.${className}`, className, {
            width: resolution.width,
            height: resolution.height,
        });
        const prefab = await request(
            'asset-db',
            'create-asset',
            url(path.join(directory, bundle.root, `${uiFolder}/${className}.prefab`)),
            content,
        );
        const assetId = `${manifest.id}/${group}/prefab/ui/${id}`;
        manifest.views[id] = {
            visibility: args.visibility ?? 'internal',
            prefab: assetId,
            kind: args.kind || 'popup',
            cache: 'none',
            duplicate: 'reject',
            className: `${manifest.id}.${className}`,
            ...paths,
        };
        await saveJson(path.join(directory, 'module.json'), manifest);
        return { id: `${manifest.id}.${id}`, uuid: prefab.uuid, className: `${manifest.id}.${className}` };
    }

    async function createTableTemplate(args) {
        const { manifest } = await moduleInfo(args.module),
            id = naming.slug(args.id),
            bundle = args.bundle || 'default';
        if (!localizationLayout.businessBundles(manifest)[bundle]) throw Error('请选择模块已有业务资源包');
        const source = `config-source/${manifest.id}/${id}.xlsx`;
        const tool = await workbookTools();
        const result = await tool.createWorkbook(root(), source, {
            module: manifest.id,
            bundle,
            enabled: true,
            tables: [
                { id, sheet: pascal(id), primaryKey: 'id', enabled: true, public: manifest.code?.mode === 'none' },
            ],
        });
        return { source, hash: result.hash, config: result.config };
    }

    async function createPrefab(args) {
        const { directory, manifest } = await moduleInfo(args.module),
            bundle = manifest.bundles[args.bundle];
        if (!bundle) throw Error('请选择已有资源包');
        const named = naming.named(args.id, args.kind),
            className =
                args.kind === 'prefab'
                    ? naming.named(named.id.replace(/-prefab$/, ''), 'component').className
                    : named.className;
        const paths = layout.itemPaths('component', named.id, { className });
        const code = path.join(directory, paths.directory),
            generated = path.join(code, 'generated');
        await ensureFolder(generated);
        const binding = path.join(generated, `${className}Binding.ts`);
        const settings = await read(inside('project-settings/framework.json'));
        const fields = args.prefabUUID
            ? await resolveBindingFields(await p.inspectPrefab(args.prefabUUID, settings.bindingPrefixes), generated)
            : [];
        await writeScript('create-asset', binding, bindingSource(manifest.id, className, fields, generated, true));
        await writeScript(
            'create-asset',
            path.join(code, `${className}.ts`),
            `import { _decorator } from 'cc';\nimport { ${className}Binding } from './generated/${className}Binding';\nconst { ccclass } = _decorator;\n/** 可组合的预制体部件；节点由 Binding 自动绑定，使用父对象传入的数据和回调，不进入 UI 页面栈。 */\n@ccclass('${manifest.id}.${className}')\nexport class ${className} extends ${className}Binding {\n    /** 绑定和宿主上下文就绪后同步执行一次，适合初始化部件自身状态。 */\n    protected onInit(): void {}\n    // 按需重写 onActivate/onDeactivate/onDispose；异步任务放在 activation.run。\n    // 动态实例使用 ctx.assets.in(owner).instantiate，并由 owner 管理生命周期。\n}\n`,
        );
        await waitClass(`${manifest.id}.${className}`);
        let info;
        if (args.prefabUUID) {
            info = await request('asset-db', 'query-asset-info', args.prefabUUID);
            if (
                info?.importer !== 'prefab' ||
                !Object.values(manifest.bundles).some((bundle) =>
                    info.url.startsWith(url(path.join(directory, bundle.root)) + '/'),
                )
            )
                throw Error('请选择当前模块的已有预制体');
            await assertBindingSceneSaved();
            const content = await scene(
                'attachComponent',
                info.uuid,
                `${manifest.id}.${className}`,
                settings.bindingPrefixes,
                bindingPlan(fields),
            );
            await request('asset-db', 'save-asset', info.url, content);
        } else {
            const folder = path.join(directory, bundle.root, 'dynamic/prefabs');
            await ensureFolder(folder);
            const content = await scene(
                'createPrefab',
                `${manifest.id}.${className}`,
                named.className,
                args.kind === 'part',
            );
            info = await request(
                'asset-db',
                'create-asset',
                url(path.join(folder, `${named.className}.prefab`)),
                content,
            );
        }
        (manifest.components ??= {})[named.id] = {
            uuid: info.uuid,
            className: `${manifest.id}.${className}`,
            binding: rel(binding).slice(rel(directory).length + 1),
        };
        await saveJson(path.join(directory, 'module.json'), manifest);

        return { id: named.id, uuid: info.uuid, className: `${manifest.id}.${className}` };
    }

    async function planLocalization(args) {
        const { manifest } = await moduleInfo(args.module),
            base = args.bundle;
        const config = localizationSettings(await read(inside('project-settings/framework.json')));
        if (!config) throw Error('请先在项目设置登记默认语言和支持语言');
        if (!localizationLayout.businessBundles(manifest)[base]) throw Error('请选择业务资源包');
        if (!config.locales.includes(args.locale)) throw Error('请选择有效语言');
        const previous = manifest.bundles[base].localization;
        const source =
            previous?.source ??
            (args.texts === true ? `config-source/${manifest.id}/localization-${base}.xlsx` : undefined);
        const locales = {
            [config.defaultLocale]: {},
            ...previous?.locales,
            [args.locale]: previous?.locales?.[args.locale] ?? {},
        };
        const next = {
            ...manifest,
            bundles: {
                ...manifest.bundles,
                [base]: { ...manifest.bundles[base], localization: { ...(source ? { source } : {}), locales } },
            },
        };
        localizationLayout.physicalBundles(next);
        const prefix = `assets/game/modules/${manifest.id}`,
            paths = [],
            folders = [],
            updates = [`${prefix}/module.json`];
        const exists =
            source &&
            (await p.stat(inside(source)).then(
                () => true,
                (error) => {
                    if (error.code === 'ENOENT') return false;
                    throw error;
                },
            ));
        let hash;
        if (previous?.source && !exists) throw Error('源工作簿丢失，请先恢复文件');
        if (exists) {
            if (!previous?.source) throw Error('同名工作簿已存在，请从删除记录恢复，不能覆盖');
            const workbook = await (await workbookTools()).readWorkbook(root(), source);
            if (workbook.kind !== 'localization' || !workbook.config.enabled)
                throw Error('多语言工作簿无效或已停用，请从删除记录恢复');
            hash = workbook.hash;
            updates.push(source);
        } else if (source) paths.push(source);
        for (const locale of Object.keys(locales)) {
            const target = localizationLayout.languageBundle(manifest, base, locale);
            if (!previous?.locales?.[locale]) {
                if (
                    await p.stat(inside(`${prefix}/${target.root}`)).then(
                        () => true,
                        (error) => {
                            if (error.code === 'ENOENT') return false;
                            throw error;
                        },
                    )
                )
                    throw Error('语言目录已存在，不能自动认领：' + target.root);
                folders.push(
                    `${prefix}/${target.root}`,
                    `${prefix}/${target.root}/dynamic`,
                    `${prefix}/${target.root}/static`,
                );
            }
            updates.push(
                `${prefix}/${target.root}/yz-index.json`,
                `${prefix}/${target.root}/yz-locale.json`,
                `${prefix}/contracts/generated/resources-${target.group}.ts`,
            );
        }
        updates.push(`${prefix}/contracts/generated/localization-${base}.ts`, 'settings/v2/packages/builder.json');
        return {
            request: {
                kind: 'localization',
                module: manifest.id,
                bundle: base,
                locale: args.locale,
                id: base,
                source,
                texts: !!source,
                hash,
                locales,
            },
            paths,
            folders,
            updates,
        };
    }
    async function createLocalization(args) {
        const { request } = await planLocalization(args);
        const { directory, manifest } = await moduleInfo(request.module);
        for (const locale of Object.keys(request.locales)) {
            const target = localizationLayout.languageBundle(manifest, request.bundle, locale);
            await bundleFolder(directory, target);
            await ensureFolder(path.join(directory, target.root, 'dynamic'));
            await ensureFolder(path.join(directory, target.root, 'static'));
        }
        const config = localizationSettings(await read(inside('project-settings/framework.json')));
        const columns = [config.defaultLocale, ...config.locales.filter((locale) => locale !== config.defaultLocale)];
        if (request.hash)
            await (
                await workbookTools()
            ).writeLocalizationWorkbook(root(), request.source, { locales: columns }, request.hash);
        else if (request.source) await (await tools()).createLocalizationWorkbook(root(), request.source, columns);
        manifest.bundles[request.bundle].localization = {
            ...(request.source ? { source: request.source } : {}),
            locales: request.locales,
        };
        await saveJson(path.join(directory, 'module.json'), manifest);
        return { source: request.source, module: request.module, bundle: request.bundle, locale: request.locale };
    }

    const methods = {
        module: createModule,
        bundle: createBundle,
        table: createTableTemplate,
        localization: createLocalization,
        service: createScript,
        component: createScript,
        part: createPrefab,
        prefab: createPrefab,
        page: createView,
        popup: createView,
        overlay: createView,
    };
    if (!methods[args.kind]) throw Error('未知创建类型：' + args.kind);
    return methods[args.kind](args);
};
