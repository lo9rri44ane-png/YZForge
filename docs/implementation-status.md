# 实现范围与验证

本文维护当前实现的边界与验证入口。使用方法从 [README 文档目录](../README.md#文档) 进入；检查是否通过，以目标版本当次执行的日志和产物为准。

最近一次实测记录：[2026-10-26 Web 发布、空项目试跑与虚拟列表验收](acceptance-2026-10-26.md)。

## 能力边界

| 范围         | 当前约定与限制                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块与资源   | 代码加载和业务初始化分开；模块持有归零后清理业务，不卸载已注册的 JavaScript。Bundle 输出、实际下载量和运行内存分别验证。                                                                                                                     |
| 生命周期     | Scope 协作式取消并等待任务及清理完成，不能强制终止任意 Promise。UI 清理超时会隔离故障实例；任务仍需响应取消。                                                                                                                                |
| 批量资源与池 | 批量进度按条目计数；取消不强制终止引擎共享下载。PrefabPool 只复用普通预制体/Part，达到容量拒绝借用，游戏状态由业务重置；完整 UIView 由 UIManager 管理。                                                                                      |
| 多语言       | 工作台维护各语言 Bundle、Excel 与生成合同；面板选择语言后手动应用到界面。首次显示等待绑定就绪，运行时新增组件显式 bindComponents；滚动文字和倒计时格式可代码绑定。支持停用恢复及构建审计，不含 ICU 复数、地区格式、RTL，语言偏好由项目接入。 |
| 配置表       | XLSX 导出 JSON 和 TypeScript 合同，未实现二进制数据格式。公式重算仅提供 Windows 桌面 Excel COM 适配；复杂公式及外部工作簿联动需使用项目实际数据验收。                                                                                        |
| 时间         | 固定 UTC 偏移，不支持 IANA 时区或夏令时。服务器时间源由项目注入；跨重启计划、补算和结算去重由业务保存。                                                                                                                                      |
| HTTP 与 SDK  | HTTP 支持 XHR、wx/tt 请求及自定义传输；不含 WebSocket、自动重连或令牌刷新。SDK 提供平台与渠道组合入口，发行商、真实登录和广告需项目接入。                                                                                                    |
| UI 组件      | 虚拟列表支持纵向固定网格、数据决定行高的纵向单列和横向固定单行；不自动测量异步内容高度。SafeWidget 和聚焦引导限同一正交 Canvas 的轴对齐布局；MarqueeLabel 为单行普通文本。详细限制见各组件文档。                                             |
| 制作恢复     | 创建中断可整次检查、清理残留；创建完成后的生成错误保留成果并正常重新生成。生成写入、删除和构建各有恢复流程；冲突会停止，不保证任意崩溃时刻自动恢复。包内移动保持资源身份，跨包迁移和全项目重命名需要另行处理引用。                           |
| 静态检查     | 可检查显式导入、序列化引用、已知逻辑名及配置引用；不能完整证明反射、字符串拼接和动态表达式的行为。                                                                                                                                           |
| 交付审计     | 检查 Bundle/代码入口归属、未压缩输出字节、完整文件重复和体积预算；不分析图集/合并 JSON 内部的语义重复，不提供 CDN 发布、原生代码热更新或跨版本补丁系统。                                                                                     |

微信、抖音及 Android/iOS 等目标平台需要分别验证开发者工具、发布构建与真机。浏览器预览和注入适配器测试不能证明后台恢复、音频权限、下载缓存、真实 SDK 或设备性能已通过验收。

## 命令行检查

先执行 `npm ci`，用 Creator 3.8.8 打开本项目并等待导入完成。`npm run typecheck` 依赖 Creator 生成的 `temp/tsconfig.cocos.json` 和引擎声明。

```powershell
npm run verify
npm run test:showcase
```

`verify` 依次检查 ESLint、格式、运行时/合同类型、框架规则、生成一致性和框架/工具测试。`test:showcase` 单独检查示例业务，移除示例后不再执行。测试脚本定义见 [package.json](../package.json)，环境设置见 [开发环境与代码规范](development.md)。

自动验证分为两层：

| 入口                                          | 环境与覆盖                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run verify:node`                         | 无需 Creator；全仓库格式、工具/测试/扩展 ESLint、框架/工具单元测试和现存示例测试                         |
| `npm run verify:creator -- --url 当前项目URL` | 先完成项目导入并连接 MCP；全仓库 ESLint、格式、两套类型检查、架构/生成一致性、上述测试和默认运行时集成组 |

[CI 工作流](../.github/workflows/verify.yml) 在 Windows、macOS、Linux 的 Node 22/24 上执行 Node 层，记录 Node 性能样本并上传报告；托管机器之间不自动比较耗时。Node 层不检查依赖 Creator 声明的运行时类型及架构/生成一致性，Creator 层需在已准备编辑器的环境中另行运行。`verify:creator` 可用 `--groups diagnostics,presentation,ui` 缩小集成范围；工作台资产操作、特定构建配置与真机验收仍单独执行。

两层入口和集成组入口均把每步输出及 `report.json` 写入 `.yzforge/verification/`。子进程直接写入日志文件，保留 UTF-8 原始字节；报告记录命令参数、退出码、耗时、Node/操作系统/项目所需 Creator 版本、提交与工作区是否有未提交内容，Git 信息不可用时省略。首个失败停止，保留已执行步骤和失败日志。`verify:creator --groups` 必须选择至少一个功能组，Node 层不接受此参数。缓存目录不提交，应将 CI artifact 或本次报告随验收记录保存。机器进程被强制终止时不能保证报告完整。

## Creator 与运行时检查

集成脚本使用项目根目录的本机 MCP 配置，并校验连接的 Creator 项目路径。先确认当前编辑器就是待测项目；复制项目后重新生成连接配置。只运行本次改动涉及的脚本。

运行时检查可按功能选择，多个功能组串行执行，首个失败停止并返回非零退出码：

```powershell
npm run test:integration -- --list
npm run test:integration -- ui startup --url http://localhost:7456/
```

`--list` 列出各组需要保留的示例；`ui` 包含排序、生命周期和清理回归，`startup` 检查启动反馈及重试屏障，`presentation` 检查状态、准备与页面组合。其余可选组为 `diagnostics`、`performance`、`components`、`resources`、`localization`、`audio`、`network`、`list` 和 `showcase`。此入口不自动运行会修改项目资产的工作台检查，也不替代需要特定构建配置的检查。未传功能组时只显示用法。

| 入口（位于 `tests/integration/`）                                                                                                                | 前置条件与覆盖范围                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [verify-observability.mjs](../tests/integration/verify-observability.mjs)                                                                        | 当前项目预览或 Web URL；验证 App 错误/日志出口、模块/事件上下文和取消后任务保留                                                                  |
| [verify-performance.mjs](../tests/integration/verify-performance.mjs)                                                                            | 保留展示模块；记录真实页面打开、滚动耗时、实例上限及关闭后持有数量                                                                               |
| [创建副本](../tests/integration/create-empty-trial.mjs)、[验收空项目](../tests/integration/verify-empty-project.mjs)                             | 专用副本完成首次导入后，验证清空示例、空启动、工作台创建/绑定、120 行列表交互与完整检查；步骤见 [复制项目](copy-project.md#验证副本)。           |
| [verify-workbench.mjs](../tests/integration/verify-workbench.mjs)                                                                                | Creator 与 MCP 已连接；创建临时模块，检查脚本、Part、绑定、XLSX、删除及恢复。成功后回收，失败保留现场；`--keep-for-build` 可保留夹具供构建检查。 |
| [verify-creation.mjs](../tests/integration/verify-creation.mjs)                                                                                  | Creator 与 MCP 已连接；创建中断、残留清理、后续修改冲突、生成错误与创建成果分离。                                                                |
| [verify-panel.mjs](../tests/integration/verify-panel.mjs)                                                                                        | 保留示例数据；检查真实工作台预览、页面公开范围、草稿、设置及生成恢复。                                                                           |
| [verify-preview.mjs](../tests/integration/verify-preview.mjs)                                                                                    | Bootstrap 已在 Game View 运行且保留大厅示例；检查 UI、结果与生命周期。                                                                           |
| [verify-build.mjs](../tests/integration/verify-build.mjs)                                                                                        | 保留大厅示例，用 `serve-build.mjs` 启动构建产物并传入 URL；可选第二个参数为工作台测试模块 ID，额外检查 Part 代码按需加载。                       |
| [verify-runtime.mjs](../tests/integration/verify-runtime.mjs)                                                                                    | 参数传入 Web 运行 URL，保留大厅示例；在独立窗口执行底层运行时回归。                                                                              |
| [verify-framework-lifecycle.mjs](../tests/integration/verify-framework-lifecycle.mjs)                                                            | 参数传入预览或 Web 运行 URL，保留展示模块；验证 UI 加载/显示取消、透明度、缓存复用、动态组件宿主和滚动文字/倒计时语言绑定，不修改编辑场景。      |
| [verify-ui-ordering.mjs](../tests/integration/verify-ui-ordering.mjs)                                                                            | 参数传入本机预览或 Web URL，保留默认首屏；真实鼠标检查三个弹窗的全部加载顺序、缓存重开、无变化不移动节点、慢清理期间输入恢复及跨层遮挡。         |
| [verify-startup-feedback.mjs](../tests/integration/verify-startup-feedback.mjs)                                                                  | 参数传入本机预览或 Web URL，保留默认 GameRoot 与首屏；检查 SDK 超时、同步构造失败、业务启动失败的提前反馈、重入防护与清理后的重试。              |
| [verify-audio.mjs](../tests/integration/verify-audio.mjs)                                                                                        | 参数传入预览或 Web 构建 URL，保留大厅音频示例；验证前后台恢复、BGM 并发容量、取消和失败后的名额及引用回收，不保存编辑场景。                      |
| [verify-ui-cleanup.mjs](../tests/integration/verify-ui-cleanup.mjs)                                                                              | 参数传入本机预览或 Web 构建 URL，保留展示模块；验证缓存界面清理失败后仍释放其他实例、UI 层和资源。                                               |
| [verify-showcase.mjs](../tests/integration/verify-showcase.mjs)                                                                                  | 参数传入 Web 运行 URL，保留全部示例；检查业务、导航、分包、持有回收及屏幕适配。                                                                  |
| [verify-virtual-list.mjs](../tests/integration/verify-virtual-list.mjs)、[verify-list-layouts.mjs](../tests/integration/verify-list-layouts.mjs) | 参数传入预览或 Web 运行 URL；检查列表窗口、复用、定位、Part 清理、横向真实拖动、变高几何及横竖屏变化。                                           |
| [verify-resources-localization.mjs](../tests/integration/verify-resources-localization.mjs)                                                      | 参数传入预览或 Web 运行 URL；检查批量资源失败回收、Prefab 池实际任务屏障、按需语言 Bundle、文本与图标、默认语言回退、页面关闭和屏幕适配。        |
| [verify-ui-components.mjs](../tests/integration/verify-ui-components.mjs)                                                                        | 参数传入预览或 Web 运行 URL；检查真实输入、原生组件、资源、计时和安全区。                                                                        |
| [verify-network-guide.mjs](../tests/integration/verify-network-guide.mjs)                                                                        | 参数传入预览或 Web 运行 URL；检查红点、真实本机 XHR、聚焦、输入、恢复与清理。                                                                    |
| [verify-game-settings.mjs](../tests/integration/verify-game-settings.mjs)                                                                        | 需两份指定配置的 Web 构建，步骤见 [游戏设置与 SDK](game-settings-sdk.md#验证)。                                                                  |
| [verify-template.mjs](../tests/integration/verify-template.mjs)                                                                                  | 需已清空示例的独立副本构建，步骤见 [复制项目](copy-project.md#验证副本)。                                                                        |

传入的 URL 必须属于当前项目。浏览器集成脚本通过 MCP 创建测试窗口；手工启动的静态服务由启动者停止。工作台脚本会实际创建、删除或恢复自己的测试资产，不是只读检查。截图通常写入忽略目录 `temp/mcp-captures`，不作为可在新检出中直接查看的证据。

Web 构建检查示例：

```powershell
# 先构建到自己选择的目录；服务会输出实际 URL。
node tests/integration/serve-build.mjs build/web-mobile
# 另一个终端，将下列地址替换为服务输出的本机 URL。
node tests/integration/verify-runtime.mjs "http://127.0.0.1:实际端口/"
node tests/integration/verify-audio.mjs "http://127.0.0.1:实际端口/"
```

## 性能基线

```powershell
npm run benchmark:node
npm run benchmark:runtime -- http://localhost:7456/
# 使用上述命令输出的历史报告路径，比较同一环境下的后续运行。
npm run benchmark:node -- --baseline .yzforge/performance/此前的Node报告.json
npm run benchmark:runtime -- http://localhost:7456/ --baseline .yzforge/performance/此前的运行时报告.json
```

URL 换成当前项目的实际地址。Node 基线检查 250 个派生分支在 2000 次无关源更新中不额外计算，以及十万条固定高度列表在跳转中保持有限实例数。Creator 基线预热后多次打开/关闭真实列表页，分别采集纵向固定、横向固定和纵向变高列表的滚动帧间隔，检查实例上限及资源/配置/界面持有回到预热后的基准。首轮冷打开单独记录；有缓存的持有基准不要求为零。

报告保存到 `.yzforge/performance/`，包含 median、p95、max、样本数、环境和场景参数。第一次运行仅记录时间基线，结构性预算仍会校验；实例数、持有回落或耗时检查失败也会保存已采集的数据和原因。传入 `--baseline` 才比较耗时，失败报告不能作为基线。[performance-budgets.json](../project-settings/performance-budgets.json) 默认允许 p95 不超过旧值的 1.3 倍加 2 ms，并设置运行时采样和实例上限。Node/浏览器/引擎、预览或构建模式、CPU、视口和场景配置不同会拒绝比较；先在对应环境重建基线，不跨设备混用。

预览模式读取 `cc/env`；发布包的环境常量被编译器内联，基线脚本改为读取 `yzforge-build.json` 并核对运行中配置哈希。无法识别环境时停止，不把构建误记为预览。

耗时受系统负载、温度和渲染环境影响，应在稳定设备上采样。Electron 测试窗口的数据只验证该运行环境；持有数量回落不等于引擎 GPU 或原生堆无泄漏。目标设备的内存、帧率、下载和启动时间仍需发布构建与真机验收。

## 构建与结果判定

保存 `Bootstrap/GameRoot/GameSettings` 后导出构建参数，构建流程见 [游戏设置与 SDK](game-settings-sdk.md#构建与预览模拟)。构建钩子检查配置一致性、TypeScript、模块边界和产物归属，报告写入 `.yzforge/build-reports`。编辑器构建额外检查 UI 类注册；命令行构建不启动编辑器脚本运行时，因此不以编辑场景注册表判断脚本有效性。两种入口都必须经过 Creator 编译，并在构建 URL 上运行对应集成组。已有构建还可单独审计：

```powershell
node tools/yzforge/cli.mjs audit-build --output build/web-mobile --platform web-mobile
```

[build-budgets.json](../project-settings/build-budgets.json) 按 `default` 与 `platforms` 合并预算；`maxTotalBytes`、`maxLocalRootBytes`、`maxDuplicateBytes` 单位均为字节，`null` 不限制。模板默认分别限制为 16 MiB、12 MiB 和 128 KiB；超限使审计失败。这是模板的开发预算，项目应按实际内容和目标平台重设，审计通过不表示满足平台压缩包/发行限制。完整同内容重复检查只统计至少 1 KiB 的文件。

记录结果时注明版本、命令、目标平台及实际运行环境。Creator 当前脚本诊断、实际预览、构建成功和真机运行是不同层次；历史日志和故障注入记录不能冒充本次结果。检查新增错误，并保留失败原因及尚未执行的目标。
