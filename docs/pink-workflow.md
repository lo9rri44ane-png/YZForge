# PinK 命令工作流

当前项目在 PinK 中开发。框架命令直接操作当前项目的手写源文件，不连接 Creator，不调用 Funplay MCP。场景、Prefab 和资源身份继续由引擎维护；没有已经验证的直接接口时，在写入前报告能力缺失。

## 已实现范围

| 能力                                                            | 当前状态                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 配置查询、修改、校验                                            | JSON 为唯一来源，不读取 Bootstrap 中的旧选择字段                 |
| Service、ViewModel、普通组件脚本                                | 使用现有模板、创建计划及事务记录，不需要编辑器                   |
| eager 纯代码模块、已有业务包的配置表源文件                      | 可通过创建计划执行                                               |
| 生成、检查、公式工具、构建产物审计                              | 共用现有实现；完整类型检查仍需要目标引擎声明                     |
| 源文件监听                                                      | 监听配置、源码和表格；不负责原生资源导入或场景同步               |
| 生成事务恢复、创建记录查询                                      | 可命令调用；涉及资产删除时要求原生引用检查，源命令提前拒绝       |
| PinK 项目身份、引擎缓存和编辑器冲突                             | 验证已有服务身份、类型与脚本来源、缺失分块；Windows 检查重复打开 |
| 独立导入与 Web 构建验收                                         | 使用 PinK 配套运行时和 CocosAPI，在无缓存副本内执行并核验配置    |
| 页面/Part/Prefab 创建、自动绑定、资源包配置、主项目构建任务管理 | 尚未接通可验证的 PinK 直接接口，不使用旧 MCP 兜底                |

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

## 项目配置归属

`package.json` 的 `cocos.version` 和 `cli.version` 分别声明目标引擎与配套 CLI；当前为 Cocos `4.0.0-beta.0` / CLI `0.2.0-beta.0`。SDK 仍会写回 `creator.version`，本项目将它与 `cocos.version` 保持一致，不再声明 Creator 3.8.8 为当前目标。`pink.uuid` 是 PinK 项目身份，必须保留；`pink.version` 是 PinK 写入的 IDE 元数据，不能当作引擎版本。顶层 `version` 为项目包版本，游戏发行版本继续使用 `game-config.json` 的 `selection.appVersion`。

`settings/cocos.config.json` 是应提交的 PinK 项目配置，包含引擎模块、设计分辨率、资源包构建配置及项目场景设置。其 `$schema` 相对引用由 PinK 生成的本机类型描述；不提交 `temp`。`profiles/cocos.config.json` 保存个人界面和本机偏好，继续由 `.gitignore` 排除。提交前应检查新增配置没有本机绝对路径、连接凭据或个人偏好。

同一项目目录只使用一个引擎编辑器。PinK 与 Creator 会写入相同的 `temp` / `library`，不要同时打开；需要对比旧引擎时使用独立项目副本。

## 源命令流程

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

`doctor` 的 `declaredEngine` 读取 `cocos.version`，`typesPresent` 只表示配置文件存在。`environment` 进一步检查 `temp/tsconfig.cocos.json`、`temp/declarations/cc.d.ts` 的实际引用，以及 editor / preview 的脚本索引（含 scopes）：比较引擎目录和版本，确认本机类型引用及编译分块存在。来源证据在 `environment.engines`，各目标缺失文件在 `environment.targets.<目标>.missing`。这些是本机缓存快照，不证明活服务的全部选项或游戏运行时兼容。

| 诊断码                                                    | 含义与处理                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `YZ_PINK_ENGINE_MISMATCH` / `YZ_PINK_ENGINE_VERSION`      | 缓存混用了引擎目录，或与项目声明版本不同；关闭同目录的其他编辑器，在目标 PinK 引擎下重新导入与编译      |
| `YZ_PINK_CHUNKS_MISSING`                                  | 索引引用的脚本分块缺失，可能导致 SystemJS 加载错误；等待编译完成后重查，必要时重载 PinK 窗口            |
| `YZ_PINK_TYPES_REFERENCE_MISSING`                         | 类型配置存在，但它引用的引擎声明文件不存在                                                              |
| `YZ_PINK_TYPES_INVALID` / `YZ_PINK_CACHE_INVALID`         | 缓存无法读取、结构损坏或分块路径无效；按 `file` 定位，不手工拼接生成产物                                |
| `YZ_PINK_EDITOR_CONFLICT`                                 | 经项目服务身份验证，确认当前项目同时被 PinK 和 Creator 打开；正常关闭此项目的 Creator 窗口，再重载 PinK |
| `YZ_PINK_TYPES_MISSING` / `YZ_PINK_SCRIPTS_MISSING`       | 尚未完整导入，返回 warning；纯源码命令仍可使用                                                          |
| `YZ_PINK_ENGINE_UNVERIFIED` / `YZ_PINK_ENGINE_UNDECLARED` | 缺少可核对的引擎来源或项目声明，不能视为引擎已匹配                                                      |
| `YZ_PINK_CACHE_CHANGING`                                  | 检查时索引正在变化，等待编译完成后重新执行                                                              |
| `YZ_PINK_PROCESS_UNVERIFIED`                              | 平台不支持、权限不足或进程参数无法明确识别，不能据此排除编辑器冲突                                      |

确认的错误会使 `doctor` 返回 `ok: false` 和非零退出码。warning 表示检查不完整，不作为纯源码工具的阻断条件；因此 `ok: true` 也应结合各项 `state` 和诊断阅读。首次未导入时不会删除缓存或强行启动引擎。编译过程中检查只是瞬时观察，出现分块缺失应在编译完成后复查。

`editors` 目前在 Windows 通过 Creator 进程的明确 `--project` 参数和规范路径匹配本项目，再结合已验证的 PinK 服务判断冲突；不会将其他项目的 Creator 窗口误判为冲突。macOS / Linux、不可读或复杂进程参数会明确返回未验证。输出不包含原始进程命令行或连接凭据。

`pink.state` 来自本地服务登记，不代表界面所有工具的工作状态；`sceneAvailable` 也不等于绑定/构建接口已通过验收。`doctor` 不启动服务、不结束进程、不自动删除 `temp` 或 `library`。若重载仍不能恢复，先保存工作并正常关闭项目、确认所有写入者退出，再处理可重建缓存；不能在活服务运行时清理。

独立构建验收使用下列命令。`--sdk` 指向 PinK 实际使用的引擎包（包含 `dist/api/index.js`），`--runtime` 指向 PinK 可执行文件；不要使用 ABI 不匹配的系统 Node 直接加载引擎原生模块。

```sh
npm run test:pink-build -- --sdk "引擎包目录" --runtime "PinK可执行文件"
```

此命令要求当前选择为 Web 渠道，并已生成最新运行配置。每次在 `.yzforge/trials/pink-*/project` 建立新的完整副本，保留资源 UUID，排除 `temp`、`library`、构建产物、旧扩展与 MCP 配置；使用 `npm ci` 安装依赖，通过 `CocosAPI.buildProject` 构建，等待任务完成并退出独立进程，再检查新类型声明和生成一致性。它不占用主项目的资源数据库。报告、源文件摘要和日志在对应 trial 目录；只有全部步骤退出成功才返回 `ok: true`。

Ctrl+C 请求停止后，验收会等待当前子进程真实退出并保存报告，跳过后续步骤，以非零状态结束。SDK 没有可靠中止接口时，当前构建会继续到清理完成；不会提前释放构建锁或把取消标记为验收成功。逐步报告记录 PID、退出码和状态；进程被强制结束而没有最终报告时，不能把 `running` 当作完成。

2026-10-26 已在 Windows / PinK 0.0.2.0 / Cocos 4.0.0-beta.0 完成上述验收，并在 Edge 打开构建产物，确认首页和训练任务页面显示正常、未捕获到页面错误。`tsconfig.json` 显式启用严格空值、隐式 any 和属性初始化检查，避免新引擎基础配置中的 `false` 覆盖项目严格模式。同日主项目关闭重复打开的 Creator 并重载 PinK 后，类型引用与两套脚本索引均来自 Cocos 4.0.0-beta.0，缺失分块为 0；用户确认场景正常打开。缓存状态可能随环境变化，当前状态使用 `doctor` 重新检查。

页面创建、自动绑定及 PinK 主项目的预览/构建任务管理仍需直接接口验收；该 Web 冒烟检查不覆盖全部交互和小游戏真机。旧 Creator 集成脚本只记录历史验证方式，不用于当前 PinK 验收。

本轮配置整理与 `doctor` 增强已在主项目通过 `npm run verify`（395 项测试），本机 `doctor` 无诊断。包含 `settings/cocos.config.json` 的新副本完成无缓存导入、Web 构建、类型与框架检查。编辑器进程识别在 Windows 实测；其他操作系统只报告未验证，本轮没有新增浏览器交互或真机验收。
