# 开发环境与代码规范

当前 PinK 开发使用 [命令工作流](pink-workflow.md)。下文 Creator 工作台、MCP 和 Inspector 的说明属于尚待替换的旧入口，不是 PinK 的操作步骤。启动配置以 `project-settings/game-config.json` 为唯一来源。

适用于本仓库及其项目副本。Creator 3.8.8；Node.js 22.13+（22.x）或 24+。代码质量工具属于开发依赖，不进入游戏运行包；版本要求以 [package.json](../package.json) 为准。

## 安装

用 VS Code 打开项目根目录，执行 `npm ci`，并安装工作区推荐的插件：

- ESLint：`dbaeumer.vscode-eslint`。
- Prettier：`esbenp.prettier-vscode`。

工作区使用 Prettier 格式化，ESLint 通过保存时 Code Action 修复代码问题。设置保留在项目内。

ESLint、TypeScript ESLint、Prettier 及配套依赖使用精确版本和 package-lock，CLI 与编辑器共享本地依赖。ESLint 使用 flat config；eslint-config-prettier 关闭与 Prettier 冲突的格式规则。项目规则见 [eslint.config.mjs](../eslint.config.mjs) 和 [.prettierrc.json](../.prettierrc.json)。

## 格式与检查规则

| 项目                                | 规则                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TypeScript / JavaScript / MJS / CJS | 4 个空格，不使用 Tab                                                                                        |
| JSON / Markdown / YAML              | 2 个空格                                                                                                    |
| 字符串与语句                        | 单引号、分号、可用位置保留尾逗号                                                                            |
| 箭头函数                            | 参数始终带括号                                                                                              |
| 行长度                              | 120 列软限制；不强行拆开长字符串                                                                            |
| 编码与换行                          | UTF-8、LF、文件末尾换行                                                                                     |
| 模板字符串                          | 不自动改写其中嵌入的 HTML/CSS/JS；避免影响 Creator 面板与 MCP 脚本                                          |
| 基础质量                            | ESLint / TypeScript ESLint 推荐规则；禁止 debugger 和 var，优先 const，严格相等比较（允许有意的 null 检查） |
| 未使用代码                          | 报错；有意保留的未使用参数或变量用 `_` 前缀                                                                 |
| 运行时异步                          | 启用类型感知的未处理 Promise、错误 Promise 回调、无效 await 检查                                            |
| 测试夹具                            | 仅 tests 下允许显式 any，以构造残缺上下文或错误输入；运行时代码仍检查                                       |
| 编辑器环境                          | Node 工具、Creator 主进程/场景进程、面板分别声明全局变量                                                    |

异步工作应 await；有使用期限的业务代码也可明确使用 `void operation().catch(owner.report)`，将故障交给该 Scope 的错误出口。仅写 void 不会处理失败。引擎生命周期与框架依赖方向仍由 `npm run check` 检查，ESLint 不替代这些架构规则。

`.prettierrc.json` 是格式规则来源，`.editorconfig` 为其他编辑器提供相同基础规则。工作台新建模块、UI、普通脚本、Binding，以及 CLI 生成的 TS 都调用同一份 Prettier 配置；生成器先格式化再比较内容和计算文件摘要，重复生成不会因缩进反复产生差异。

`.gitattributes` 固定脚本、JSON、Markdown 和 YAML 的 LF 换行，避免不同 Git 客户端的 `core.autocrlf` 设置影响格式检查与生成摘要。场景、预制体和 meta 保留仓库中的原始字节，由 Creator / AssetDB 维护。

`.prettierignore` 和 ESLint 排除 Creator 缓存、构建输出、第三方依赖及生成产物。生成 TS 由生成流程格式化，生成 JSON 保持生成器规定的输出；命令行批量格式化不会重写 scene、prefab、meta 或生成数据。VS Code 将这些引擎资产与生成文件标为只读，日常通过 Creator 或工作台修改。

## VS Code 工作区

[工作区设置](../.vscode/settings.json) 使用以下 TypeScript 配置：

```json
{
  "js/ts.tsdk.path": "node_modules/typescript/lib",
  "js/ts.tsdk.promptToUseWorkspaceVersion": true,
  "js/ts.preferences.importModuleSpecifier": "relative",
  "js/ts.preferences.preferTypeOnlyAutoImports": true,
  "js/ts.preferences.quoteStyle": "single",
  "js/ts.updateImportsOnFileMove.enabled": "prompt"
}
```

第一次打开项目时，按提示选择工作区 TypeScript。较旧的 VS Code 如不识别 `js/ts` 设置，应升级编辑器。

项目根 [tsconfig.json](../tsconfig.json) 显式使用 `moduleResolution: "bundler"`，其余基础设置继承 Creator 生成的 `temp/tsconfig.cocos.json`。项目覆盖项维护在根配置中，不修改 `temp` 内文件；命令行与编辑器都使用工作区编译器。

如果修改配置后仍显示旧诊断，执行命令面板中的“TypeScript: Restart TS Server”；需要切换编译器时，打开 TS 文件，执行“TypeScript: Select TypeScript Version”并选择工作区版本。

工作区同时配置了：

- 手动保存时格式化和 ESLint 修复；关闭自动保存以避免频繁触发 Creator 导入。
- 不在保存时自动整理导入，保留 Cocos 脚本的明确导入意图；移动脚本时提示是否更新导入。
- 隐藏 meta 与大型缓存，排除缓存/构建目录的全文搜索与文件监听，保持源码和声明导航可用。
- 推荐插件与公共任务随项目提交；其他个人 VS Code 文件继续忽略。

资源移动仍使用 Creator/工作台以保留 UUID，不能因为 VS Code 能更新 TS 导入就用它直接搬动场景资产。

## 常用命令与快捷入口

| 命令                                        | 用途                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| npm run lint                                | ESLint 检查，错误或警告均返回失败                                                  |
| npm run lint:fix                            | 自动修复能够安全修复的问题；其余问题仍需处理                                       |
| npm run format                              | 格式化受管理的手写代码与文本                                                       |
| npm run format:check                        | 检查格式，不修改文件                                                               |
| npm run typecheck                           | 游戏/框架脚本及类型合同两套 TypeScript 检查                                        |
| npm run check                               | 生命周期/模块/生成产物一致性检查                                                   |
| npm run generate                            | 生成目录、配置与类型；需回收旧文件时使用工作台                                     |
| npm test                                    | 自动化测试                                                                         |
| npm run test:showcase                       | 单独运行示例业务测试，需要保留示例模块                                             |
| npm run verify                              | 依次执行 ESLint、格式、类型、框架检查与自动化测试                                  |
| npm run verify:node                         | 无 Creator 环境的工具/测试 ESLint、全仓库格式、框架/工具与现存示例测试，并保存报告 |
| npm run verify:creator -- --url 当前项目URL | 完整静态检查、测试和默认 Creator 集成组，并保存报告                                |
| npm run benchmark:node                      | 记录派生状态与十万条列表控制器基线                                                 |
| npm run benchmark:runtime -- 当前项目URL    | 记录真实页面打开、滚动和资源回落基线                                               |

`verify:node` 不使用 `temp` 类型声明，不执行游戏/框架脚本的类型感知 ESLint、TypeScript 或依赖/生成一致性检查；这些由 `verify` 或 `verify:creator` 执行。CI 在 Windows、macOS、Linux 的 Node 22/24 上执行 Node 层，保存 `.yzforge/verification/` 日志与 JSON 报告。Creator 层仍需已导入的项目、MCP 和当前预览/构建 URL，不能以 Node CI 通过代替。性能比较与报告说明见[实现范围与验证](implementation-status.md#性能基线)。

**Ctrl+Shift+B** 调用完整检查；“终端 → 运行任务”可单独格式化、修复、导出或测试。脚本错误会进入 VS Code 的问题列表。

**F5** 选择“YZForge: 调试 Creator 浏览器预览”：先在 Creator 启动浏览器预览，再粘贴完整 URL。URL 在启动时输入，未写死本机端口或项目哈希。使用 VS Code 内置 Edge 调试器；此入口不会自动启动 Creator，也不用于微信/原生真机调试。

完整检查依赖 Creator 已生成 temp 中的 Cocos 类型声明。新检出项目先用 Creator 打开并等待导入完成，再运行检查。编辑器、浏览器集成脚本和平台验证范围见 [实现范围与验证](implementation-status.md)。

## 结构化诊断

自动化调用使用 `node tools/yzforge/cli.mjs check`（或 `generate` / `generate --dry-run`）直接读取 JSON，避免 npm 命令前缀混入输出。所有结果包含 `ok`、`status`、`command` 和 `diagnostics`；具体操作可能附带 `valid`、`validationErrors`、`message` 和 `code`。

每条诊断包含 `code`、`severity: "error"` 和可读 `message`；可选字段为项目根相对路径 `file`、从 1 开始的 `line` / `column`、修复提示 `hint` 和文档路径 `docs`。路径使用 `/`。位置来自源码或实际资产，无法准确定位时省略；不解析错误文本来猜行号。

```json
{
  "code": "YZ_VIEWMODEL_UI_DEPENDENCY",
  "severity": "error",
  "message": "ViewModel 不能依赖引擎或显示层：cc",
  "file": "assets/game/modules/demo/code/HomeViewModel.ts",
  "line": 1,
  "column": 1,
  "hint": "将节点和 UI 协议留在 View 或交互适配中，ViewModel 只接收纯数据与交互端口。",
  "docs": "docs/architecture.md"
}
```

目前生命周期、模块与架构边界、TypeScript、序列化多语言绑定、生成物过期检查提供分类诊断。例如 `YZ_LIFECYCLE_HOOK`、`YZ_MODULE_BOUNDARY`、`YZ_VIEWMODEL_UI_DEPENDENCY`、`TS2322`、`YZ_LOCALIZED_BINDING`、`YZ_GENERATED_STALE`。其他异常保留已有错误码（例如 `GAME_BUILD_BUSY`），没有错误码时使用 `YZ_TOOL_ERROR`。消费者应容忍新增代码和可选字段，不依赖 `message` 的措辞匹配。

成功和失败均向 stdout 写 JSON；失败退出码为 1，没有 `--editor` 特例。`generate` 已更新产物但使用方校验失败时返回 `status: applied-needs-fix`，修复诊断后重新生成。`generate --dry-run` 不执行完整 TypeScript 检查，正式验证仍用 `check`。长驻 `watch` 使用逐行 JSON 事件，其他命令输出单个对象。

工作台继续显示原有错误文本，并在子进程错误对象中保留诊断。创建或修改源文件成功、后续生成失败时，返回原有 `generationError` 以及新增的 `generationDiagnostics`；这表示源操作已完成，应修复诊断后重新生成，避免重复创建。自动生成失败的状态可通过 `autoStatus.diagnostics` 查看。运行时排错沿用 [API 指南中的现有诊断入口](api-guide.md)。
