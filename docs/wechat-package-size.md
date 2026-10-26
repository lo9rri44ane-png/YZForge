# 微信主包减包记录

2026-10-27：原调试包在微信工具中报告主包 5061 KB，超过 4096 KB。

## 已验证构建方案

- 游戏配置选择 `wechat_self / release / dev`，修改后执行现有生成命令。
- 平台 `wechatgame`，`debug: false`，`sourceMaps: false`。
- `experimentalEraseModules: true`。
- **`mainBundleCompressionType: "subpackage"`**：使用平台构建流程将 main 和 internal 移到分包，而不是手动移动产物。
- `nativeCodeBundleMode: "asmjs"`。
- `packages.wechatgame.wasmSubpackage: false`、`separateEngine: false`。
- 输出目录：build/wechat_self-dev-release。

仅关闭调试及映射后，按分包声明排除分包的磁盘主包仍为 4501.9 KB；追加主业务分包后构建成功，主包为 **2837.4 KB**，全部产物为 4805.7 KB。所有统计使用 1024 字节为 KB；最终微信上传统计仍以微信开发者工具为准。

请重新导入此新目录，清理工具缓存后编译和真机预览，不要复用旧 debug 目录。当前 environment 仍为 dev；正式发布前另行核对生产环境、AppID、网络域名与平台服务。

## 已知限制

本机启用 `wasmSubpackage: true` 后，引擎构建遇到 Babel preset 缺少 filename 的错误，因此最终方案未使用此开关，也没有修改引擎安装文件绕过。当前使用 main/internal 普通分包完成减包。

构建成功和磁盘主包低于限制不代替微信开发者工具运行及真机验收；需验证启动时分包下载成功。
