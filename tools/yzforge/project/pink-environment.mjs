import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import diagnosticTools from '../validation/diagnostics.cjs';

const packer = 'temp/programming/packer-driver/targets';
const typeConfig = 'temp/tsconfig.cocos.json';
const typeEntry = 'temp/declarations/cc.d.ts';
const recover =
    '先关闭同目录的其他编辑器，等待 PinK 编译完成后重跑 doctor；仍异常时重载 PinK 窗口。不要在活服务运行时删除 temp 或 library。';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = (value) => value.replaceAll('\\', '/').replace(/(?<!^)\/{2,}/g, '/');
const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

async function optionalText(file) {
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function isFile(file) {
    try {
        return (await stat(file)).isFile();
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

function engineRoot(path) {
    const normalized = normalize(path);
    const match = /^(.*)\/(?:editor\/assets(?:\/|$)|bin\/\.declarations\/cc\.d\.ts$)/.exec(normalized);
    return match?.[1];
}

/** Inspect generated evidence without loading an SDK or modifying a live compiler's files. */
export async function inspectPinkEnvironment(root, project) {
    const diagnostics = [];
    const add = (code, message, file, severity = 'error', details = {}) =>
        diagnostics.push(diagnosticTools.diagnostic(code, message, { file, severity, ...details }));
    const engines = new Map();
    async function engine(path, source) {
        const directory = engineRoot(path);
        if (!directory) return null;
        const actual = await realpath(directory).catch(() => resolve(directory));
        const id = key(actual);
        if (!engines.has(id)) {
            const entry = { path: actual, version: null, sources: [] };
            engines.set(id, entry);
            try {
                const pkg = JSON.parse(await readFile(resolve(actual, 'package.json'), 'utf8'));
                if (typeof pkg.version === 'string') entry.version = pkg.version;
            } catch {
                // A copied cache may refer to an engine that is not installed on this machine.
            }
        }
        const info = engines.get(id);
        if (!info.sources.includes(source)) info.sources.push(source);
        return id;
    }

    const types = { state: 'absent', engines: [] };
    try {
        const text = await optionalText(resolve(root, typeConfig));
        const declaration = await optionalText(resolve(root, typeEntry));
        if (text === null || declaration === null) {
            add(
                'YZ_PINK_TYPES_MISSING',
                '目标引擎类型声明尚未完整生成；请在 PinK 打开项目并等待导入。',
                typeConfig,
                'warning',
            );
        } else {
            types.state = 'checked';
            const parsed = ts.parseConfigFileTextToJson(typeConfig, text);
            if (parsed.error || !record(parsed.config)) throw Error('类型配置不是有效的 JSONC 对象');
            const paths = parsed.config.compilerOptions?.paths?.['db://internal/*'] ?? [];
            if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
                throw Error('db://internal/* 类型路径无效');
            const references = ts.preProcessFile(declaration).referencedFiles.map((item) => item.fileName);
            for (const path of paths) {
                const id = await engine(resolve(root, 'temp', normalize(path)), typeConfig);
                if (id && !types.engines.includes(id)) types.engines.push(id);
            }
            for (const path of references) {
                const target = resolve(root, dirname(typeEntry), normalize(path));
                const id = await engine(target, typeEntry);
                if (id && !types.engines.includes(id)) types.engines.push(id);
                if (!(await isFile(target)))
                    add('YZ_PINK_TYPES_REFERENCE_MISSING', `引擎类型引用不存在：${path}。${recover}`, typeEntry);
            }
            if (!types.engines.length || !references.length) {
                types.state = 'unverified';
                add(
                    'YZ_PINK_ENGINE_UNVERIFIED',
                    '无法从类型声明确认引擎来源，文件存在不代表类型有效。',
                    typeEntry,
                    'warning',
                );
            }
        }
    } catch (error) {
        types.state = 'invalid';
        add('YZ_PINK_TYPES_INVALID', `无法检查类型声明：${error.message}`, typeConfig);
    }

    const targets = {};
    for (const target of ['editor', 'preview']) {
        const file = `${packer}/${target}/import-map.json`;
        const base = resolve(root, packer, target);
        const report = { state: 'absent', chunks: 0, missing: [], engines: [] };
        targets[target] = report;
        try {
            const text = await optionalText(resolve(root, file));
            if (text === null) {
                add('YZ_PINK_SCRIPTS_MISSING', `${target} 脚本索引尚未生成，请等待 PinK 导入与编译。`, file, 'warning');
                continue;
            }
            const map = JSON.parse(text);
            if (!record(map) || !record(map.imports) || (map.scopes !== undefined && !record(map.scopes)))
                throw Error('脚本索引结构无效');
            const tables = [map.imports, ...Object.values(map.scopes ?? {})];
            const chunkFiles = new Set();
            const sourcePaths = [];
            for (const table of tables) {
                if (!record(table)) throw Error('脚本索引 scope 无效');
                for (const [source, destination] of Object.entries(table)) {
                    if (typeof destination !== 'string') throw Error('脚本映射目标必须是字符串');
                    if (source.startsWith('file:')) sourcePaths.push(fileURLToPath(source));
                    if (!destination.startsWith('./chunks/')) continue;
                    const path = resolve(base, decodeURIComponent(destination));
                    const local = relative(resolve(base, 'chunks'), path);
                    if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep))
                        throw Error('脚本分块路径越出 chunks 目录');
                    chunkFiles.add(path);
                }
            }
            for (const path of chunkFiles) {
                if (!(await isFile(path))) report.missing.push(normalize(relative(base, path)));
            }
            report.chunks = chunkFiles.size;
            // Import maps are rewritten during compilation. Do not diagnose that intermediate snapshot as corruption.
            if ((await optionalText(resolve(root, file))) !== text) {
                report.state = 'changing';
                report.missing = [];
                add(
                    'YZ_PINK_CACHE_CHANGING',
                    `${target} 编译索引在检查期间发生变化，请等待编译完成后重跑 doctor。`,
                    file,
                    'warning',
                );
                continue;
            }
            for (const path of sourcePaths) {
                const id = await engine(path, file);
                if (id && !report.engines.includes(id)) report.engines.push(id);
            }
            if (report.missing.length) {
                // Confirm missing files again after the map read, allowing concurrent output completion.
                report.missing = await Promise.all(
                    report.missing.map(async (path) => ((await isFile(resolve(base, path))) ? null : path)),
                ).then((files) => files.filter(Boolean));
                if (report.missing.length)
                    add(
                        'YZ_PINK_CHUNKS_MISSING',
                        `${target} 索引引用了 ${report.missing.length} 个缺失分块。${recover}`,
                        file,
                    );
            }
            report.state = report.missing.length ? 'incomplete' : 'checked';
            if (!report.engines.length)
                add('YZ_PINK_ENGINE_UNVERIFIED', `${target} 索引未提供可识别的引擎脚本来源。`, file, 'warning');
        } catch (error) {
            report.state = 'invalid';
            add('YZ_PINK_CACHE_INVALID', `无法检查 ${target} 脚本索引：${error.message}。${recover}`, file);
        }
    }
    const observed = [...engines.values()];
    if (engines.size > 1)
        add('YZ_PINK_ENGINE_MISMATCH', `类型声明与脚本索引引用了不同引擎目录。${recover}`, typeConfig);
    for (const item of observed) {
        if (!item.version)
            add('YZ_PINK_ENGINE_UNVERIFIED', `无法读取引擎版本：${item.path}`, item.sources[0], 'warning');
        else if (project.cocos?.version && item.version !== project.cocos.version)
            add(
                'YZ_PINK_ENGINE_VERSION',
                `项目声明 Cocos ${project.cocos.version}，缓存来自 ${item.version}。${recover}`,
                'package.json',
            );
    }
    if (!project.cocos?.version)
        add(
            'YZ_PINK_ENGINE_UNDECLARED',
            'package.json 未声明 cocos.version，无法确认项目要求的引擎版本。',
            'package.json',
            'warning',
        );
    return { declaredEngine: project.cocos?.version ?? null, types, targets, engines: observed, diagnostics };
}
