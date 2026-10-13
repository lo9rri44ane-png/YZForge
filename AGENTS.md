# YZForge 协作入口

这是 Cocos Creator 项目。先按任务查阅下列入口，再沿类型定义和现有实现确认契约。

| 任务                                               | 入口                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模块职责、依赖边界、源文件与生成物归属             | [架构](docs/architecture.md)                                                                                                                                                                                                                     |
| Service、ViewModel、Page / Part、Command、使用期限 | [开发工作流](docs/development-workflow.md)、[API 指南](docs/api-guide.md)                                                                                                                                                                        |
| 可运行的页面组合与交互适配                         | [WorkflowPage](assets/game/modules/workshop/code/ui/workflow-page/WorkflowPage.ts)、[workflow](assets/game/modules/workshop/code/presentation/workflow.ts)、[ViewModel](assets/game/modules/workshop/code/presentation/WorkflowPageViewModel.ts) |
| 工具命令、格式、结构化诊断                         | [开发环境](docs/development.md)                                                                                                                                                                                                                  |
| 编辑器、预览、构建与验证范围                       | [实现范围与验证](docs/implementation-status.md)                                                                                                                                                                                                  |

## 修改入口

- 业务代码放在所属模块，跨模块通过 `public.ts`；具体规则以架构文档和现有检查器为准。
- 创建模块、页面、Part、Service 与 Binding 使用现有工作台。`tools/yzforge/operations/` 保存创建预览、执行、恢复与绑定实现；`tools/yzforge/mcp.mjs` 连接当前项目的 Creator。先查询实际工具和参数，不另造一套创建流程。
- 修改手写源声明后使用 `npm run generate` 或工作台更新产物。`generated/`、模块 `public.ts` 与资源索引由生成器维护；资源身份和生成归属状态必须保留。完整清单见架构文档。
- 场景、预制体、元数据与资源移动通过 Creator / AssetDB 操作，保留 UUID 并读回结果。编辑器操作参照 [Cocos MCP 工作流](.agents/skills/funplay-cocos-mcp-workflow/SKILL.md)。
- 生命周期、调用 owner、交互 context 和业务依赖应显式可查；调整便捷写法前先核对取消、导航挂起、复用与清理行为。会话模型和当前显示的交互适配见上述示例。

## 验证与排错

- 工具或框架代码修改后运行相关测试及 `npm run verify`；示例业务改变时另运行 `npm run test:showcase`。纯文档修改检查链接、示例与格式即可。
- 完整检查需要 Creator 已生成 `temp` 类型声明。涉及引擎注册、序列化、界面或运行时行为时，按验证文档运行对应集成脚本，使用当前项目实际预览 URL。
- `check` / `generate` 的 JSON 诊断协议见开发环境文档。优先根据 `code` 和可用的 `file` / `line` / `column` 定位；没有位置时阅读 `message`，不要猜测。修复源文件后重新执行原检查。
- 运行时持有、任务与清理问题先使用现有 `app.inspect()`、`Scope.inspect()` 和 `UIManager.inspect()`；业务上下文使用 `ctx.diagnostics.snapshot()`。具体范围见 API 指南。
- 交付时说明改动、执行的检查及尚未验证的环境，不把静态检查通过当作引擎或真机验证。
