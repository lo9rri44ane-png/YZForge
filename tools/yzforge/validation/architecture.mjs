import { resolve, relative } from 'node:path';
import { dependencyResolver } from './dependencies.mjs';
import { files } from '../project/project.mjs';
import diagnosticTools from './diagnostics.cjs';

const { diagnostic, validationError } = diagnosticTools;

const forward = (file) => file.replaceAll('\\', '/');
/** 验证真正发出的值导入；类型导入另由公开契约和 core 边界检查。 */
export async function architectureCheck(root, modules) {
    const framework = forward(resolve(root, 'assets/framework')) + '/';
    const dependencies = dependencyResolver(root);
    const graph = new Map(),
        sources = new Map(),
        errors = [],
        diagnostics = [];
    const imports = (file) => {
        if (!sources.has(file)) sources.set(file, dependencies.imports(file));
        return sources.get(file);
    };
    // 转译会删除类型和移动行号；仅在源引用唯一时定位运行时导入。
    const sourceEdge = (file, edge) => {
        const matches = imports(file).filter((source) => source.spec === edge.spec);
        return matches.length === 1 ? matches[0] : undefined;
    };
    const issue = (code, message, file, edge, hint) => {
        errors.push(message);
        diagnostics.push(
            diagnostic(code, message, {
                root,
                file,
                ...(edge ? { line: edge.line, column: edge.column } : {}),
                ...(hint ? { hint } : {}),
                docs: 'docs/architecture.md',
            }),
        );
    };
    const runtime = (file) => {
        if (!graph.has(file)) graph.set(file, dependencies.imports(file, { runtime: true }));
        return graph.get(file);
    };
    for (const file of await files(resolve(root, 'assets/framework'), '.ts')) {
        const from = forward(file),
            core = from.startsWith(framework + 'core/');
        for (const edge of imports(file)) {
            if (
                from.startsWith(framework + 'components/') &&
                edge.target &&
                [
                    'assets/asset-manager.ts',
                    'config/config-manager.ts',
                    'audio/audio-manager.ts',
                    'time/time-service.ts',
                    'ui/localization/localized-ui.ts',
                ].some((file) => edge.target === framework + file)
            )
                issue(
                    'YZ_COMPONENT_SERVICE_IMPORT',
                    `${relative(root, file)}: 组件基础设施应依赖能力接口，不能引用具体服务实现：${edge.spec}`,
                    file,
                    edge,
                );
            if (edge.target?.includes('/assets/game/'))
                issue(
                    'YZ_FRAMEWORK_PROJECT_IMPORT',
                    `${relative(root, file)}: 框架不能依赖项目实现：${edge.spec}`,
                    file,
                    edge,
                );
            if (!edge.target && edge.spec.startsWith('.'))
                issue(
                    'YZ_DEPENDENCY_UNRESOLVED',
                    `${relative(root, file)}: 无法解析模块边界：${edge.spec}`,
                    file,
                    edge,
                );
            if (
                core &&
                (edge.spec === 'cc' ||
                    edge.spec.startsWith('cc/') ||
                    (edge.target && !edge.target.startsWith(framework + 'core/')))
            )
                issue(
                    'YZ_CORE_DEPENDENCY',
                    `${relative(root, file)}: core 只能依赖自身基础机制：${edge.spec}`,
                    file,
                    edge,
                );
        }
        for (const edge of runtime(from))
            if (
                from.startsWith(framework + 'components/') &&
                edge.target?.startsWith(framework) &&
                !['components/', 'core/'].some((dir) => edge.target.startsWith(framework + dir))
            )
                issue(
                    'YZ_COMPONENT_RUNTIME_IMPORT',
                    `${relative(root, file)}: 组件基础设施不能加载上层实现：${edge.spec}`,
                    file,
                    sourceEdge(file, edge),
                );
    }
    const visited = new Set(),
        visiting = new Set();
    const walk = (file, chain) => {
        if (visiting.has(file)) {
            issue(
                'YZ_FRAMEWORK_CYCLE',
                '框架运行时循环依赖：' + [...chain, file].map((f) => relative(root, f)).join(' -> '),
                file,
            );
            return;
        }
        if (visited.has(file)) return;
        visiting.add(file);
        for (const edge of runtime(file)) if (edge.target?.startsWith(framework)) walk(edge.target, [...chain, file]);
        visiting.delete(file);
        visited.add(file);
    };
    for (const file of graph.keys()) walk(file, []);
    for (const module of modules) {
        if (module.code?.mode === 'none' && (await files(resolve(module.directory, 'code'))).length)
            issue(
                'YZ_RESOURCE_MODULE_CODE',
                `${module.id}: 纯资源模块不允许 code 目录内容`,
                resolve(module.directory, 'module.json'),
            );
        const seen = new Set();
        const contract = (file) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const edge of runtime(file)) {
                if (
                    edge.spec === 'cc' ||
                    edge.spec.startsWith('cc/') ||
                    (edge.target?.includes('/assets/game/modules/') && edge.target.includes('/code/'))
                ) {
                    issue(
                        'YZ_PUBLIC_RUNTIME_IMPORT',
                        `${module.id}: 公开入口会加载实现或引擎组件：${relative(root, file)} -> ${edge.spec}`,
                        file,
                        sourceEdge(file, edge),
                    );
                    continue;
                }
                if (edge.target && edge.target.startsWith(forward(resolve(root, 'assets')) + '/'))
                    contract(edge.target);
            }
        };
        contract(forward(resolve(module.directory, 'public.ts')));
        // ViewModel 的全部传递依赖（包括 type-only）都必须与渲染层隔离。
        // 组合工厂使用 *.model.ts 或独立功能文件，不能放回模型中隐藏 UI 依赖。
        const checkModel = (file, seen = new Set()) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const edge of imports(file)) {
                if (
                    edge.spec === 'cc' ||
                    edge.spec.startsWith('cc/') ||
                    edge.target?.startsWith(framework + 'ui/') ||
                    edge.target?.startsWith(framework + 'components/')
                ) {
                    issue(
                        'YZ_VIEWMODEL_UI_DEPENDENCY',
                        `${relative(root, file)}: ViewModel 不能依赖引擎或显示层：${edge.spec}`,
                        file,
                        edge,
                        '将节点和 UI 协议留在 View 或交互适配中，ViewModel 只接收纯数据与交互端口。',
                    );
                    continue;
                }
                if (edge.target?.startsWith(forward(resolve(module.directory, 'code')) + '/'))
                    checkModel(edge.target, seen);
            }
        };
        for (const file of await files(resolve(module.directory, 'code'), '.ts'))
            if (file.endsWith('ViewModel.ts')) checkModel(forward(file));
    }
    if (errors.length)
        throw validationError([...new Set(errors)].join('\n'), [
            ...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values(),
        ]);
}
