# 中转站分组显示名：后端需求说明（给 new-api 后端）

## 背景

yisama 无限助手 v1.2.0 起，Codex 面板里的分组列表标题是"Models · 模型"。每一项本来显示的是 new-api 的分组名，比如"不降智plus""各种国模""稳定gpt_plus"。站长希望改成显示 GPT、Claude、Gemini、国模这类名字，并且能在中转站后台随时修改。

**前端已经做完。** 后端只需要按下面的约定，多返回一个字段。

不能直接复用分组描述 `desc`：它现在已经是说明文字了，比如"测试中""每天全站共享1000万Token，用完即止""team+free+plus大杂烩"，网站上也在用。

## 接口约定（前端已实现）

接口是 `GET /api/user/self/groups`，也就是现有的 `controller/group.go` 里的 `GetUserGroups`。在每个分组对象里加一个**可选**字段 `display_name`（字符串）：

```json
{
  "success": true,
  "message": "",
  "data": {
    "不降智plus":   { "ratio": 0.2,  "desc": "测试中", "display_name": "GPT" },
    "满血ccm 正价": { "ratio": 0.9,  "desc": "",       "display_name": "Claude" },
    "Gemini":       { "ratio": 1,    "desc": "",       "display_name": "Gemini" },
    "各种国模":     { "ratio": 0.15, "desc": "",       "display_name": "国模" },
    "每日共享":     { "ratio": 0,    "desc": "每天全站共享1000万Token，用完即止" }
  }
}
```

前端的处理规则：

| 情况 | 面板显示 |
|---|---|
| `display_name` 是非空字符串 | 去掉首尾空格后显示，最多 200 字 |
| 没有这个字段、为空或不是字符串 | 显示原分组名，跟现在一样 |
| `auto` 分组没有 `display_name` | 显示 `All` |
| `ratio` 为 0 | 显示"免费" |
| `ratio` 为其它数字 | 显示 `×0.2` 这种格式 |

其它说明：

- **切换时提交的还是分组名**（对象的 key），`display_name` 只用于显示。所以分组名不要改，改的只是显示名。
- **显示哪些分组**由接口返回哪些分组决定。不想在助手里显示的分组，后端不返回就行。图片、视频分组前端本来就会根据 `/api/pricing` 自动隐藏。
- **兼容性：**旧版助手会忽略这个新字段，新版助手遇到没加字段的老后端，也照常显示分组名。前后端谁先上线都可以。
- `desc`、`ratio`、`ratio_min`、`ratio_max` 这些现有字段保持不变。

## 后端需要做的事

1. **存储：**为每个分组保存一个显示名，形式是"分组名 → 显示名"的映射。

   建议做成一个新的系统选项（比如 `GroupDisplayNames`，值是 JSON 对象，例如 `{"不降智plus":"GPT","各种国模":"国模"}`），和现有的 `UserUsableGroups`（分组名 → 描述）、`GroupRatio` 存法一致。具体怎么存由后端决定，只要接口按上面的约定返回就行。

2. **接口：**在 `GetUserGroups` 组装每个分组时，如果配置了显示名，就加上 `"display_name": <显示名>`。`auto` 分组也可以支持。

3. **后台界面：**在管理后台的分组设置附近（和"用户可选分组"、"分组倍率"放在一起），提供编辑每个分组显示名的地方，保存后立即生效。

   助手端对分组列表有 30 秒缓存，改完之后最多 30 秒左右就会显示出来。

4. **测试：**
   - 配置了显示名的分组会返回 `display_name`。
   - 没配置的分组不返回这个字段，或者返回空字符串。
   - 原有字段的值不变。

## 可选扩展：排序（前端尚未实现，需要时再说）

目前面板按接口返回的顺序显示。Go 的 map 转成 JSON 时会按 key 排序，所以实际顺序就是分组名的字母顺序。

如果希望固定成"GPT、Claude、Gemini、国模"这样的顺序，可以再加一个可选的整数字段，比如 `display_order`，数字越小越靠前。后端加好后告诉助手这边，前端会再出一个版本来支持。在那之前，后端返回这个字段也不会有任何影响。

## 参考位置

以下位置来自本地快照 `new-api-redesign`（2026-10-19），可能和线上代码有差别，请以线上代码为准。

- `controller/group.go` 的 `GetUserGroups`：组装 `ratio` 和 `desc` 的地方，在这里加 `display_name`。
- `setting/user_usable_group.go`：`UserUsableGroups` 的存储和读取，可以照着这个写显示名的存储。
- 助手前端读取这个字段的位置：`yisama_Infinite_Assistant/scripts/yisama.mjs` 的 `fetchGroupInfo`。
