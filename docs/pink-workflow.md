# PinK 命令工作流

当前项目在 PinK 中开发。框架命令直接操作当前项目的手写源文件，不连接 Creator，不调用 Funplay MCP。场景、Prefab 和资源身份继续由引擎维护；没有已经验证的直接接口时，在写入前报告能力缺失。

## 已实现范围

| 能力                                                            | 当前状态                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| 配置查询、修改、校验                                            | JSON 为唯一来源，不读取 Bootstrap 中的旧选择字段              |
| Service、ViewModel、普通组件脚本                                | 使用现有模板、创建计划及事务记录，不需要编辑器                |
| eager 纯代码模块、已有业务包的配置表源文件                      | 可通过创建计划执行                                            |
| 生成、检查、公式工具、构建产物审计                              | 共用现有实现；完整类型检查仍需要目标引擎声明                  |
| 源文件监听                                                      | 监听配置、源码和表格；不负责原生资源导入或场景同步            |
| 生成事务恢复、创建记录查询                                      | 可命令调用；涉及资产删除时要求原生引用检查，源命令提前拒绝    |
| PinK 项目身份和服务状态                                         | 验证已有本地服务，输出过滤连接凭据；不启动第二个实例          |
| 独立导入与 Web 构建验收                                         | 使用 PinK 配套运行时和 CocosAPI，在无缓存副本内执行并核验配置 |
| 页面/Part/Prefab 创建、自动绑定、资源包配置、主项目构建任务管理 | 尚未接通可验证的 PinK 直接接口，不使用旧 MCP 兜底             |

## 命令

在项目根目录使用 `npm run yz -- <命令>`。自动化调用使用 `node tools/yzforge/cli.mjs <命令>`，避免 npm 的前缀污染 JSON。`--project <目录>` 可明确目标项目；参数拼错、缺值和未知命令均返回非零状态。

```sh
npm run yz -- doctor
npm run yz -- config show
npm run yz -- config set --channel web_local --mode debug --environment dev --app-version 1.0.0
npm run yz -- generate --dry-run
npm run yz -- generate
npm run yz -- check
npm run yz -- config build-options --platform web-mobile
```

启动选择保存在 `project-settings/game-config.json` 的 `selection`，与渠道参数一起生成不可变运行配置。修改配置后必须生成并检查，再启动预览。`GameSettings` 仅提供生成的运行快照，不保存四项选择，也不要求 Creator 扩展注入配置。直接点击 PinK 的预览入口目前不会自动执行 YZForge 检查，不能把原生预览启动当作生成一致性已通过。

`config show` 返回 `sourceHash`；将它传给 `config set --expected-hash <摘要>` 可防止覆盖期间发生的修改。配置修改成功返回 `status: needs-generation`，下一步执行 `generate`。

```sh
npm run yz -- create plan --kind service --module workshop --id Inventory
npm run yz -- create apply --plan <上一步返回的signature>
npm run yz -- generate

npm run yz -- create plan --kind viewmodel --module workshop --id Home
npm run yz -- create plan --kind component --module workshop --id Card
npm run yz -- create plan --kind module --id inventory --delivery eager --code-only
npm run yz -- create plan --kind table --module workshop --id Items
```

预览返回确切文件、源码、输入摘要和签名，计划保存在 `.yzforge/creation-plans/`。执行同一份计划，输入或模板变化后必须重新预览。重复执行已完成计划会失败，不重复创建。源命令不生成或复制 `.meta`，脚本导入及类注册不在“源码创建完成”的承诺内。

目标路径只有 `.meta` 而没有资源时，创建会拒绝认领这个身份，需先通过 PinK 核对。预览后新增或改变元数据也会使计划失效。

```sh
npm run yz -- recovery list
npm run yz -- recovery inspect --id <生成事务ID>
npm run yz -- recovery apply --id <生成事务ID> --signature <恢复预览签名>
npm run yz -- recovery creation-inspect --id <创建记录ID>
npm run yz -- recovery creation-cleanup --id <创建记录ID> --signature <清理预览签名>
npm run yz -- watch
```

恢复会重新检查内容和签名；用户后续修改、活动锁或资源操作能力不足会阻止清理。生成恢复预览的 `nativeRequired` 非空表示需要删除资产，整次恢复会在写入前拒绝；自动回滚遇到同样情况会保留整笔部分写入与事务，创建清理也先检查全部改动。不能凭命令进程已经退出就解锁后台构建。

`watch` 合并连续变化、串行生成。遇到构建占用或确认存活的生成进程时输出 `generation-deferred`，保留待办并等待重试，锁释放后无需再次修改源码；状态不明或中断遗留的锁需要先检查恢复，不自动删除。普通生成失败会输出诊断并继续监听。Ctrl+C 停止接收新工作并等待当前生成事务结束。

## 结果与验证

普通命令只向 stdout 输出一个 JSON 对象，成功或失败均包含 `ok`、`status`、`command` 和诊断；失败返回退出码 1。生成写入后出现使用方错误时为 `applied-needs-fix`，修复后重新生成。`watch` 输出逐行 JSON 事件和最终结果。`generate --dry-run` 不执行完整类型检查；正式验收使用 `check` 和 `npm run verify`。

`doctor` 的 `declaredEngine` 是项目声明，`typesPresent` 只表示文件存在。旧 Creator 生成的类型缓存不能证明 PinK 当前引擎兼容。`pink.state` 来自本地服务登记，不代表界面所有工具的工作状态；`sceneAvailable` 也不等于绑定/构建接口已通过验收。

独立构建验收使用下列命令。`--sdk` 指向 PinK 实际使用的引擎包（包含 `dist/api/index.js`），`--runtime` 指向 PinK 可执行文件；不要使用 ABI 不匹配的系统 Node 直接加载引擎原生模块。

```sh
npm run test:pink-build -- --sdk "引擎包目录" --runtime "PinK可执行文件"
```

此命令要求当前选择为 Web 渠道，并已生成最新运行配置。每次在 `.yzforge/trials/pink-*/project` 建立新的完整副本，保留资源 UUID，排除 `temp`、`library`、构建产物、旧扩展与 MCP 配置；使用 `npm ci` 安装依赖，通过 `CocosAPI.buildProject` 构建，等待任务完成并退出独立进程，再检查新类型声明和生成一致性。它不占用主项目的资源数据库。报告、源文件摘要和日志在对应 trial 目录；只有全部步骤退出成功才返回 `ok: true`。

Ctrl+C 请求停止后，验收会等待当前子进程真实退出并保存报告，跳过后续步骤，以非零状态结束。SDK 没有可靠中止接口时，当前构建会继续到清理完成；不会提前释放构建锁或把取消标记为验收成功。逐步报告记录 PID、退出码和状态；进程被强制结束而没有最终报告时，不能把 `running` 当作完成。

2026-10-26 已在 Windows / PinK 0.0.2.0 / Cocos 4.0.0-beta.0 完成上述验收，并在 Edge 打开构建产物，确认首页和训练任务页面显示正常、未捕获到页面错误。`tsconfig.json` 显式启用严格空值、隐式 any 和属性初始化检查，避免新引擎基础配置中的 `false` 覆盖项目严格模式。主项目现有 `temp` 仍来自旧 Creator，不能用它单独代表新引擎验收。

页面创建、自动绑定及 PinK 主项目的预览/构建任务管理仍需直接接口验收；该 Web 冒烟检查不覆盖全部交互和小游戏真机。旧 Creator 集成脚本只记录历史验证方式，不用于当前 PinK 验收。
