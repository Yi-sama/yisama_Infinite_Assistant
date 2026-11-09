---
name: yisama-setup
description: Set up and manage yisama 无限助手 for Codex. Use when the user asks to log in, switch groups or models, discover available image models, adjust reasoning levels including Ultra, view remaining quota, enable Fast, recharge, restore, or remove the yisama integration.
---

# yisama 无限助手

这是 Codex 的首个 yisama 客户端适配器。它与官方中转站账号互通：用户使用同一组账号登录后，插件自动完成 Codex 配置。

## 操作规则

- 不要让用户输入或查看 API Key、Endpoint、JSON、Header。
- 不要在聊天消息、终端输出、错误信息或日志中打印令牌。
- 账号、密码、验证码只由用户在助手侧栏填写；不要在聊天、终端、命令参数或环境变量中收集，不要代填或读取用户输入。密码不落盘、不写日志。桌面入口使用站点授权的独立认证接口，不打开浏览器，不回退到网页登录。
- 助手登录、注册不要求人机验证；保留服务端频率限制、注册开放策略、邮箱验证（站点启用时）及账号已有的二次验证。不要关闭网站原有验证。
- 登录成功后自动开启 Fast，不要求用户手动改设置。明确说明支持线路按 1.5x 计费，不承诺所有模型都能加速。
- 默认优先使用 `All` 分组；用户指定分组时使用指定分组。
- 支持查看、选择模型思考等级，包括模型列出的 `max` 和 `ultra`；不要把 Ultra 替换成 XHigh，也不要默认将所有模型设为最高等级。
- 额度、分组、模型和充值只用普通用户能理解的名称说明。

## 首次设置

先将下文的 `PLUGIN_ROOT` 替换为当前插件实际的绝对路径：本技能所在文件夹向上两层即插件根目录。不要假定此名称一定存在于环境变量中。

检查本机 Node.js 为 22 或更高版本。缺少依赖时由助手在插件根目录运行下面的命令，保持 TLS 证书校验开启；不用把这些内部命令交给普通用户：

```text
npm ci --prefix "PLUGIN_ROOT" --ignore-scripts --no-audit --no-fund
```

普通用户通过已安装的 `Codex - yisama` 快捷方式启动 Codex，点击余额按钮，在侧栏直接填写账号和密码。未安装桌面入口时，使用本项目构建的一次性安装包；安装要求用户先关闭 Codex，不得擅自结束或重启正在运行的客户端。

侧栏可切换登录与注册。新用户注册成功后在同一侧栏登录；站点启用邮箱验证时，通过侧栏发送和填写邮箱验证码。账号启用二次验证时，侧栏继续显示验证码或备用码输入框，不得跳过。

登录后会依次完成：

1. 说明与官方中转站（https://api.yisama.asia）账号互通，使用同一组账号。
2. 在本地侧栏完成登录及账号要求的二次验证。
3. 显示可用分组，并允许选择具体分组或 `All`。
4. 自动准备对应的内部访问凭证。
5. 自动写入 Codex 配置，并保留原配置备份。
6. 自动开启 Fast 并向站点确认开关和分组权限。
7. 显示账户剩余额度，提供官方钱包的自定义充值入口。
8. 自动配置系统 `$imagegen`，生图使用无限助手的独立配置，默认 `gpt-image-2`，不跟随聊天服务商切换。用户不需要额外填写密钥或安装 Python。

用户有有效登录状态时直接复用；到期后自动续期。登录失败不会被当成成功，也不会改写 Codex 配置。不要将状态文件或认证文件读入聊天。

保留的 `setup` 命令是维护者的旧版网页登录流程，不用于普通用户的桌面登录。不要为了收集账号密码扩展命令行参数，也不要在本地登录失败时自动调用它。

## 后续操作

```text
node "PLUGIN_ROOT/scripts/yisama.mjs" status
node "PLUGIN_ROOT/scripts/yisama.mjs" select --group all
node "PLUGIN_ROOT/scripts/yisama.mjs" groups
node "PLUGIN_ROOT/scripts/yisama.mjs" models
node "PLUGIN_ROOT/scripts/yisama.mjs" model --name <模型名称>
node "PLUGIN_ROOT/scripts/yisama.mjs" reasoning
node "PLUGIN_ROOT/scripts/yisama.mjs" reasoning --level ultra
node "PLUGIN_ROOT/scripts/yisama.mjs" reasoning --level auto
node "PLUGIN_ROOT/scripts/yisama.mjs" recharge
node "PLUGIN_ROOT/scripts/yisama.mjs" restore
```

`select` 在有效登录状态下直接切组；先确认有效登录状态，失效时让用户在侧栏重新登录，不要触发旧版网页登录。`models` 显示当前分组的模型，`model` 切换模型。模型是否适合 Codex 编程工具取决于站点线路，不承诺图片、音频或所有厂商模型都兼容 Codex。

`reasoning` 显示当前等级和 Codex 为该模型列出的可选等级。用户说“开启 Ultra”时，先查看等级，再切换；不支持或无法确认时说明情况，不强行开启、不改个人模型目录。可用等级按模型不同，可能包括关闭、最少、低、中、高、超高、Max 和 Ultra。`auto` 恢复模型默认。首次设置、切分组或切模型可附加 `--reasoning <等级>`。切换到不支持原等级的模型时自动恢复默认，并明确告知用户。

当前已验证的 Codex 将 Ultra 转换为 `max` 强度及全会话上下文设置；由 Codex 自行处理，不手动篡改请求。这里只验证了客户端向本地测试服务的真实请求，不能据此保证每条真实中转线路都支持。提醒用户 Ultra 可能增加耗时和额度消耗。查看本地配置不等于真实线路已经生效。

`restore` 只撤回助手管理的配置，保留用户后续改动，清除本机助手登录状态；不删除服务端凭证。设置或恢复完成后提醒用户重启 Codex 或新建会话。

## 生图

Windows 安装器和 `Codex - yisama` 启动入口会自动配置系统 `$imagegen`，不是新增另一个同名技能；同时在当前 Codex home 的全局规则中追加可撤销的生图路由，保留个人内容，并兼容已有 `AGENTS.override.md`。全局规则在新会话中加载，用户不需要点名技能。插件方式安装时，首次登录配置也会接入。生图仍需用户在侧栏登录，未登录时不得回退到官方服务。

正常生图使用系统 `$imagegen`，按照其说明调用安装包自带的运行入口。用户可直接指定“用某模型生图”，将名称原样传为 `--model`。只有用户要求保存默认值时才执行：

```text
node "PLUGIN_ROOT/scripts/yisama.mjs" image model --name <生图模型>
```

用户询问“有哪些生图模型”“你能用什么模型画图”“默认用哪个”等问题时，默认指当前登录的无限助手账号，先执行 `image models` 再回答。简短列出返回的模型及已确认可用的默认模型，说明可以指定模型；默认模型不在清单时告知并请用户选择，不擅自替换。除非用户明确问官方目录或厂商对比，不查官网补清单，不按名字编造模型定位、价格或停用时间。查询失败就用简短易懂的话说明登录、开通或稍后重试，不让用户自行判断官方型号是否有权限，也不堆叠分组、凭据或 API 术语。

查询只列出账号可见模型与站点 `image-generation` 能力目录的交集，不提交生图请求，不产生生图费用。列出的生成线路不保证支持编辑或所有可选参数，只有用户问及或实际操作需要时才解释这些边界。

图片凭据按登录用户和设备独立准备，仅使用账号有权限的 `images` 分组，不复制聊天凭据，不使用管理员凭据，不跨组重试。登录配置和升级后首次图片操作会自动完成准备；没有图片权限时明确说明，不影响普通聊天。真正生图按调用用户的账号计费。切换聊天分组、模型、思考等级或 Fast 不会改变图片凭据和生图默认模型。

退出登录会清除生图凭据，保留技能的助手入口并提示重新登录。卸载时恢复原系统技能、只移除助手添加的全局规则；维护者可用 `image install` / `image uninstall` 配置或恢复入口，助手拥有的内容有后续修改时停止并保留文件。不得为了检查安装自动提交付费生图请求。

登录时要明确告诉用户：这是与官方中转站账号互通的登录，不是另外注册一套账号。

## 结果反馈

完成后只向用户报告：

- 登录是否成功
- 当前分组
- 当前模型和思考等级（调整时报告）
- 1.5x 是否已启用
- 剩余额度
- 是否需要用户打开充值入口

不要报告内部令牌、密钥、请求地址或配置文件内容。
