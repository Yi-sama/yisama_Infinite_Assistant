# 交接说明：钱包页兑换码（后端）

写于 2026-11-01。前端已由 Claude 做完并通过测试，**后端只差一个 `redeem` 动作**，请 GPT 补上。

## 用户要的是什么

1. 点面板「充值」进入钱包页，**页面大小和主面板一样，不变形**（已完成）。
2. 钱包页分两个标签：**在线支付**（原有支付宝）和**兑换码**（新增）。
3. 兑换码标签：输入框 + 「兑换」按钮；下面有一个超链接「没有兑换码？去小铺购买」，指向 `https://wzyp.cn/shop/IIIYMQU4`（微信、支付宝都能付，面额 10/20/30/50）。链接在前端写死，用 `<a target="_blank">` 打开，**不走后端**。
4. 主面板底部加了「遇到问题？加入交流群」，点开是 QQ 群二维码页（群号 1125690897，二维码图已内嵌，纯前端，**不用后端做任何事**）。
5. 用户明确不要快捷金额按钮。

## 需要你做的（只有这一件）

新增面板到后端的 `redeem` 动作，调用站点现有兑换接口。

### 面板发来的请求
```json
{ "id": 12, "action": "redeem", "redeemCode": "YS-XXXX-XXXX" }
```
面板已 `trim()`；最长 128 字符。

### 需要改的位置
1. `scripts/desktop-bridge.mjs`
   - `ACTIONS` 加入 `'redeem'`。
   - `validateRequest`：`redeem` 只允许字段 `redeemCode`（加入 `limits`，建议 128）；必填、非空、不得含空白；其它动作不得携带它。
   - `handleRequest` 里增加 `if (action === 'redeem') return desktopRedeem(details)`。
2. `scripts/yisama.mjs`：新增并导出 `desktopRedeem({ redeemCode })`。
   - 和 `desktopRechargePay` 一样用 `authenticatedSession({ interactive: false })`。
   - 调站点接口：`POST /api/user/topup`，body `{ "key": redeemCode }`，带用户 token（参考 `start-mode/app.js` 里 `api.redeem` 的写法；该接口成功时 `data` 是到账额度）。
   - 成功后**刷新余额**，返回 `desktopStatus({ message: '兑换成功，余额已更新。' })`，这样面板能直接拿到新的 `quota`。面板收到 `ok: true` 后会清空输入框，并用返回的数据更新余额。
   - 失败（码不存在、已使用、过期）抛 `UserError`，**不要把兑换码、token 写进错误信息或日志**。面板会显示固定文案「兑换失败，请检查兑换码是否正确、是否已被使用。」。
   - 站点若关闭了兑换功能（`/api/user/topup/info` 的 `enable_redemption === false`），返回明确错误；前端目前不隐藏兑换码标签，如需隐藏，在 `desktopRechargeInfo` 的返回里加 `redemptionEnabled`，告诉 Claude，前端再接。

### 测试（请补）
- `desktop-bridge.test.mjs`：`redeem` 合法请求通过；缺 `redeemCode`、空串、超长、带空白、被别的动作携带，都被 `validateRequest` 拒绝。
- `yisama.test.mjs`：mock 站点 `/api/user/topup`，成功时返回新余额；失败时错误里不含兑换码。

## 前端约定（请勿破坏）
- testid：`wallet-page`、`wallet-back`、`wallet-tabs`、`tab-pay`、`tab-redeem`、`redeem-pane`、`redeem-code`、`redeem-submit`、`shop-link`、`wallet-message`、`help`、`qq-page`、`qq-image`、`qq-number`、`qq-copy`、`qq-back`。
- 面板 action：`rechargeInfo`、`rechargeAmount`、`rechargePay`、`recharge`（旧的打开站点钱包，保留兼容）、新增 `redeem`。
- 面板尺寸固定：不要为了钱包页「更舒服」改回变大。
- `scripts/codex-panel.mjs` 现在是 **LF** 换行（之前已安装版是 CRLF，已统一）；改它请保持 LF，否则 git diff 全是噪声。

## 验收（Claude 没做，需要真机）
1. `npm run update:local`，不用重启 Codex。
2. 登录真实账号 → 点「充值」→ 面板大小不变 → 切到「兑换码」。
3. 去小铺买一个最小面额的码 → 粘贴 → 兑换 → 余额增加；再次兑换同一个码 → 提示失败。
4. 点「遇到问题？加入交流群」→ 用手机 QQ 扫码，确认能加群；点「复制」能复制群号。
5. 窗口很矮（< 540px 高）时钱包页要能在面板内滚动，不被截断。

## 不要做的
- 不要把 `output/`、`work/` 里的截图脚本和备份提交。
- 不要把小铺链接或群二维码改成从后端取；用户选择写死在前端。
