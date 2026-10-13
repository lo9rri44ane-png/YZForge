import { relative, resolve } from 'node:path';
import ts from 'typescript';
import diagnosticTools from './diagnostics.cjs';

const { diagnostic, validationError } = diagnosticTools;

const forward = (file) => file.replaceAll('\\', '/');

/** 在生成文件写入后检查使用方，别名和解构交给 TypeScript。 */
export function typeDiagnostics(root, diagnostics = []) {
    const report = (item, message, file = item.file?.fileName) => {
        const position =
            item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : undefined;
        diagnostics.push(
            diagnostic(`TS${item.code}`, message, {
                root,
                file,
                ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
                docs: 'docs/development.md',
            }),
        );
        return message;
    };
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    if (config.error)
        return [
            report(
                config.error,
                ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
                resolve(root, 'tsconfig.json'),
            ),
        ];
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) => {
        const location =
            diagnostic.file && diagnostic.start !== undefined
                ? `${relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
                : '';
        return report(
            diagnostic,
            `${location}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        );
    });
}

/** 所有边界检查共用同一套语法与路径解析；动态模块名不具备可验证的边界。 */
export function dependencySpecifiers(file, text, root) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const result = [];
    const add = (node, argument) => {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
            const message = `${file}:${position.line + 1}: 模块路径必须为静态字符串；动态内容请通过框架资源/模块入口加载`;
            throw validationError(message, [
                diagnostic('YZ_DEPENDENCY_DYNAMIC', message, {
                    root,
                    file,
                    line: position.line + 1,
                    column: position.character + 1,
                    hint: '使用静态模块路径；动态资源或模块使用框架入口加载。',
                    docs: 'docs/architecture.md',
                }),
            ]);
        }
        result.push({ spec: argument.text, line: position.line + 1, column: position.character + 1 });
    };
    const visit = (node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
            add(node, node.moduleSpecifier);
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
            add(node, node.moduleReference.expression);
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal);
        else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
            add(node, node.arguments[0]);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

export function dependencyResolver(root) {
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const cache = ts.createModuleResolutionCache(root, forward, options);
    const targetOf = (file, spec) => {
        const target = ts.resolveModuleName(spec, file, options, ts.sys, cache).resolvedModule?.resolvedFileName;
        return target && forward(resolve(target));
    };
    return {
        targetOf,
        imports(file, { runtime = false } = {}) {
            const text = ts.sys.readFile(file);
            if (text === undefined) return [];
            // 先扫描源文件，类型擦除不能隐藏无法审查的动态模块路径。
            const source = dependencySpecifiers(relative(root, file), text);
            const references = runtime
                ? dependencySpecifiers(
                      relative(root, file),
                      ts.transpileModule(text, {
                          compilerOptions: {
                              ...options,
                              noEmit: false,
                              declaration: false,
                              emitDeclarationOnly: false,
                          },
                          fileName: file,
                      }).outputText,
                  )
                : source;
            return references.map((edge) => ({ ...edge, target: targetOf(file, edge.spec) }));
        },
    };
}
