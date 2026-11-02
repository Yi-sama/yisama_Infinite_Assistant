# 中转站分组显示名：后端需求说明（给 new-api 后端）

## 背景

yisama 无限助手的 Codex 面板里有一个分组列表，标题是"Models · 模型"。站长希望这里只显示 GPT、Claude、Gemini、国模这样的名字，并且**在后台用表格选择每个名字对应哪个分组**，而不是手写 JSON。

第一版（`GroupDisplayNames`，JSON 编辑框，已部署在 release `group-display-names-20261102-150331`）能用，但要手写分组名，太麻烦。这一版改成表格。

**助手这边已经做完**，只要后端按下面的约定返回字段就行。

## 后台界面：表格

把现在"分组显示名"的 JSON 编辑框换成表格，每一行是助手里显示的一项：

| 列 | 说明 |
|---|---|
| 显示名 | 文本输入框，例如 GPT、Claude、Gemini、国模 |
| 分组 | 下拉框，选项是所有可选分组（`UserUsableGroups` 的 key，加上 `auto`）。每个选项旁边带上描述和倍率，方便辨认 |
| 排序 | 上移 / 下移按钮（能拖拽更好）。表格从上到下的顺序就是助手里的显示顺序 |
| 操作 | 删除这一行 |

表格下面有"添加一行"按钮。表格为空时，可以给一个"填入 GPT / Claude / Gemini / 国模 四行"的快捷按钮，分组留空让站长去选。

保存时校验，不通过就提示，不保存：

- 显示名和分组都必须填；显示名去掉首尾空格，最多 200 字。
- 同一个分组只能出现在一行里。
- 显示名不能重复，否则助手里会出现两个一样的名字。
- `images`、`video` 这类图片、视频分组可以不放进下拉框；放进去也没关系，助手会自动隐藏它们。

页面位置可以留在现在的"额外设置"里。

## 存储

继续用系统选项 `GroupDisplayNames`。为了能表达顺序，值改成数组：

```json
[
  { "group": "不降智plus", "name": "GPT" },
  { "group": "满血ccm 正价", "name": "Claude" },
  { "group": "Gemini", "name": "Gemini" },
  { "group": "各种国模", "name": "国模" }
]
```

- 数组顺序就是显示顺序。
- 线上现在存的是空对象 `{}`，而且数据库里还没写过这个选项。读取时如果遇到旧的对象格式 `{"分组":"显示名"}`，按 key 顺序转成数组就行，不需要单独迁移。
- 分组以后被删掉、或者不在 `UserUsableGroups` 里了，这一行在接口里直接忽略，不要报错。

## 接口约定（助手已实现）

接口是 `GET /api/user/self/groups`，也就是 `controller/group.go` 的 `GetUserGroups`。表格里配置过的分组，在分组对象里加两个字段：

- `display_name`：显示名（字符串）。第一版已经有了。
- `display_order`：表格里的行号，从 1 开始（整数）。这是这一版新加的。

```json
{
  "success": true,
  "message": "",
  "data": {
    "不降智plus":   { "ratio": 0.2,  "desc": "真满血不降智", "display_name": "GPT",    "display_order": 1 },
    "满血ccm 正价": { "ratio": 0.9,  "desc": "",             "display_name": "Claude", "display_order": 2 },
    "Gemini":       { "ratio": 1,    "desc": "",             "display_name": "Gemini", "display_order": 3 },
    "各种国模":     { "ratio": 0.15, "desc": "",             "display_name": "国模",   "display_order": 4 },
    "稳定gpt_plus": { "ratio": 0.3,  "desc": "稳定的plus，缓存高" }
  }
}
```

没配置的分组照常返回，不带这两个字段。`desc`、`ratio`、`ratio_min`、`ratio_max` 都不变。

助手的处理规则：

| 情况 | 助手面板 |
|---|---|
| 所有分组都没有 `display_name` | 跟以前一样，显示全部分组和分组名 |
| 至少一个分组有 `display_name` | **只显示有 `display_name` 的分组**，按 `display_order` 从小到大排 |
| 用户当前正在用的分组没被配置 | 仍然显示这一项（用原分组名，排在最后），让用户知道自己在哪个分组；切走之后就不再出现 |
| `ratio` 为 0 / 其它数字 | 显示"免费" / `×0.2` |

其它说明：

- **切换时提交的还是分组名**，显示名只用于显示。
- **只影响助手，不影响网站。**网站的令牌分组选择照常显示全部分组，所以不能用"不返回分组"的办法来隐藏。
- 助手对分组列表有 30 秒缓存，后台保存后最多 30 秒左右生效。
- **兼容：**旧版助手会忽略 `display_order`，只是按分组名字母顺序显示；新版助手遇到没有这些字段的后端，照旧显示全部分组。

## 测试

- 表格保存后，`GroupDisplayNames` 存成数组，顺序正确。
- 校验：缺显示名或分组、分组重复、显示名重复，都拒绝保存。
- 接口：配置过的分组带 `display_name` 和 `display_order`，没配置的不带；原有字段不变。
- 旧对象格式和空值 `{}` 都能正常读取。
- 表格里引用了已删除的分组时，接口忽略这一行，不报错。

## 源码和部署

- 继续在分支 `feat/group-display-names-20261102` 上改（GitHub `Yi-sama/new-api-custom`）。线上第一版的源码已经备份成这个分支上的提交 `2bdbb6b`。
- **部署前先把源码提交并推送**，并把提交号写进 build manifest。不要再用"未提交的工作区"去构建上线的程序，否则下次改 new-api 时这个功能可能被覆盖。
- 部署方式和第一版一样，`new-api` 和 `new-api-accrual` 都要换。

## 参考位置

- `setting/group_display_names.go`：第一版的存储和校验。
- `controller/group.go` 的 `GetUserGroups`：输出 `display_name`，在这里加 `display_order`。
- `web/src/features/system-settings/extra/group-display-names.tsx`：第一版的 JSON 编辑框，换成表格。
- 助手读取这些字段的位置：`yisama_Infinite_Assistant/scripts/yisama.mjs` 的 `fetchGroupInfo` 和 `desktopGroupInfo`。
