# yisama 无限助手

一个面向普通用户的 Codex 客户端适配插件。

它与官方中转站 `https://api.yisama.asia` 账号互通。桌面助手在侧栏直接登录、注册和选择分组，插件自动准备 Codex 配置并开启 Fast。普通用户不需要接触内部凭证、请求地址或配置文件。

当前 Windows 主版本为 **1.2.0**，作为本轮完整版本，包含分组显示、模型同步、Codex 26.1027 的原生 Fast / Ultra 兼容修复、控件加载引起的意外页面刷新修复，以及多设备共享凭证导致 Fast 串改的修复。Fast 是站点支持线路的优先处理能力，适用时按 1.5x 计费，不代表所有模型都保证提速 1.5 倍。

## Codex 内余额入口

一次性安装包为 `release/Yisama-Setup-1.2.2.exe`。先关闭 Codex，再双击安装。安装后通过桌面或开始菜单的 `Codex - yisama` 入口启动客户端，安装器无需再次运行。不添加 Windows 登录启动项，不覆盖原来的 Codex 或壁纸快捷方式。

小按钮直接显示剩余额度，可拖动并记住位置；点击在 Codex 内展开右侧面板，可登录、选择分组和模型、刷新余额、打开官方钱包自定义充值。未登录时不显示模拟余额，暂时读取失败时标记上次余额。首次配置时默认开启 Fast；切换分组后从普通模式开始，用户可按需手动开启 Fast，其他文本分组使用普通模式。思考等级使用本地模型目录已列出的最高等级，无法确认时保留模型默认。分组和模型保存后不再常驻显示重启提示；保存成功不代表已经打开的 Codex 会话实时切换，真实线路的对话和工具兼容性仍需单独验证。

同一账号在不同电脑登录时，内部凭证、Fast 和分组设置按设备隔离。升级时自动迁移旧共享凭证，保留本机 Fast 选择、模型、思考等级和原始恢复备份；存在运行中的任务时等待全部空闲后切换，不中断回复。重新登录不会替另一台设备修改 Fast。

界面通过只绑定本机的调试连接插入 Codex 主页面，不再使用外部 WinForms 悬浮窗口，不修改 Codex 安装文件。该方式属于实验集成，不应当作官方原生界面接口。普通、不带调试连接的 Codex 启动方式不会显示按钮；安装器不会在正在运行的客户端中强制启用或重启。页面重新加载后重新挂载入口，关闭 Codex 后对应连接组件退出。

安装不登录、不改变当前模型或认证信息。用户登录后才写入相关配置，并保留原始备份；退出账号可恢复原配置。卸载只移除本助手拥有的入口，不擅自删除登录和备份数据。

维护者运行 `npm run build:windows` 构建安装包，需要先安装 Inno Setup 6（`winget install JRSoftware.InnoSetup`，或用 `YISAMA_ISCC` 指定 `ISCC.exe`）。安装器脚本在 `installer/yisama.iss`，图标由 `node scripts/build-icon.mjs` 从 `brand-logo/v5/final` 生成到 `windows/assets/`。安装包只包含压缩后的运行入口、启动脚本和生产依赖，不包含测试文件、源码地图或交接文档；用户无需另装 Node.js。安装到当前用户目录、无需管理员权限，会出现在“应用和功能”中；卸载前先恢复原 Codex 配置，恢复失败则取消卸载。安装包测试需先构建，再设置 `YISAMA_WINDOWS_TESTS=1` 运行 `npm test`，测试以 `/YISAMATEST=1` 安装到临时目录，不创建快捷方式和卸载项。界面截图使用模拟账号与余额，不代表真实账号联调通过。

在线授权默认关闭；打包时设置 `YISAMA_REQUIRE_LICENSE=1` 才会启用，启用前须先在实际处理流量的服务端部署授权接口和私钥。

正式发布时可通过 `YISAMA_SIGNTOOL`、`YISAMA_SIGN_CERT`、`YISAMA_SIGN_CERT_PASSWORD`
和可选的 `YISAMA_SIGN_TIMESTAMP_URL` 配置 Windows 签名；设置
`YISAMA_REQUIRE_SIGNATURE=1` 会拒绝生成未签名安装包。

本机开发更新使用 `npm run update:local`，不再运行安装器。该命令只替换助手脚本，并在助手空闲、面板关闭时重新加载助手进程，不重启 Codex、不改账号或 Codex 配置。可先用 `npm run update:local -- --dry-run` 查看变更；运行环境或依赖变化时会拒绝脚本更新。旧版助手首次接入更新机制需由维护者重载助手进程，之后自动接收本地更新通知。当前未提供在线自动下载更新，正式发布前需配置可信更新源。

本次安装包尚未签名。原生控件、模型同步及真实请求的 Fast 参数传递已完成本轮验证；充值流程和实际提速幅度不包含在本轮验收中。正式签名版本仍需配置受信任的代码签名证书。

## 当前版本

- 首个适配客户端：Codex
- 支持账号可用的 `All` 和具体分组；`All` 继承站点自动分组策略
- 登录后自动准备本设备独立的内部访问凭证，多台电脑互不改写 Fast 和分组
- 首次配置默认开启 Fast，并重新确认服务端状态
- 显示账户钱包余额，而不是内部凭证限额
- 读取当前分组模型列表并切换模型
- 提供自定义充值入口
- 修改前自动备份 Codex 配置
- 恢复时保留用户在设置后增加或修改的个人配置
- 桌面侧栏直接登录、注册，使用独立认证接口，不打开浏览器、不要求人机验证
- 保留站点邮箱验证和账号二次验证，支持登录续期；网站原有验证不变

## 授权与安全提示

本项目及其安装包为专有软件，不是开源项目。使用、分发和反向工程限制见
[LICENSE.txt](LICENSE.txt)。

请勿将安装目录、源代码、配置文件、会话数据、API Key、日志或反编译结果
上传到 AI 服务、代码分析服务或其他第三方服务。这些内容可能包含私密凭
证和未公开的实现细节。

## 安装

维护者需准备 Node.js 22+、支持插件的 Codex，以及 Edge、Chrome 或已安装的 Playwright Chromium。

本地测试安装：

```text
codex plugin marketplace add <本仓库绝对路径>
codex plugin add yisama-infinite-assistant@yisama
```

仓库提交并推送后，可将第一条命令的路径改为 `Yi-sama/yisama_Infinite_Assistant`。安装不会自动运行登录或改写现有 Codex 配置。

## 安装后使用

桌面安装后，通过 `Codex - yisama` 快捷方式启动客户端，点击余额按钮，在侧栏自行填写账号信息。注册成功后在同一侧栏登录；账号要求邮箱或二次验证时，相应输入框直接显示在侧栏。

以下为维护者保留的旧版命令行流程，`setup` 会打开官方登录页，不作为桌面登录的回退。直接运行时，先在仓库根目录安装依赖：

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/yisama.mjs setup --group all
```

常用命令：

```text
node scripts/yisama.mjs status
node scripts/yisama.mjs select --group all
node scripts/yisama.mjs groups
node scripts/yisama.mjs models
node scripts/yisama.mjs model --name <模型名称>
node scripts/yisama.mjs recharge
node scripts/yisama.mjs restore
```

## 安全边界

- 桌面密码和验证码只由用户在助手侧栏填写，经本机后台直接发送到站点；不写文件、日志、命令参数或聊天。保留的维护者命令行流程仍在官方页面填写。
- API Key 只写入 Codex 本地认证文件，不打印到终端或聊天。
- `state.json` 只保存非密钥状态。登录会话及续期信息单独保存在本机 `session.json`，认证文件与备份均属于敏感文件，不应共享或提交。
- 数据默认位于用户目录 `.yisama-infinite-assistant`；支持宿主的 `PLUGIN_DATA`。Codex 配置使用 `CODEX_HOME`，默认 `.codex`。
- 本地 `device-id` 标识当前安装，退出登录后保留；不要在不同电脑之间复制认证、会话或整个助手数据目录。
- 使用结构化 TOML 修改配置，保留无关配置值，但可能重新排版及移除注释。未发生其他修改时，恢复会还原原始文件文本。
- 写入中途失败会回滚本次已写文件，原始备份在改动前持久化。
- 恢复操作不会删除服务端 API Key，只恢复本机 Codex 配置。
- 助手使用站点专用的 `/api/assistant/auth/` 登录、注册接口，不要求人机验证；不伪造验证结果、不关闭网站的原有验证。该入口仍是公网接口，保留始终启用的频率限制、注册开关、邮箱验证及二次验证，不把可分发程序中的固定字符串当成安全凭证。

## 验证

```text
npm test
```

测试使用临时配置目录和本地模拟站点，不连接真实账号。浏览器测试需要本机 Edge（Windows）或 Playwright Chromium，可通过 `YISAMA_TEST_BROWSER` 指定浏览器通道。

指定 `YISAMA_CODEX_BIN` 为本机 Codex 可执行文件的绝对路径后，还会运行真实 Codex 的隔离安装和请求测试。真实站点的登录、充值和模型线路仍需使用测试账号联调。

插件仅承诺配置当前分组可见的模型。Codex 的编程工具兼容性及 Fast 生效范围由具体模型和站点线路决定，不能将站点全部模型一概视为兼容。

## 后续适配

通用登录、分组、额度和内部凭证逻辑已经独立在脚本中。后续支持 Claude Code、Antigravity 时，新增对应客户端配置适配器，不改变 yisama 账号和服务端逻辑。

## 1.2.2

新增软件内更新入口、每日首次进入时的新版本提示和更新二次确认；修复重启流程。当前版本显示在退出登录同一行的右侧，退出登录保持面板居中。
