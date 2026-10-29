// Kept self-contained because this function is serialized into Codex through CDP.
export function installAssistantUI(options = {}) {
  const ROOT_ID = 'yisama-infinite-assistant-ui'
  const topFrame = (() => {
    try { return window.top === window } catch { return false }
  })()
  if (!topFrame || (window.location.href !== 'app://-/index.html' && options.allowTestLocation !== true)) return null

  const existing = window.__yisamaInfiniteAssistant
  if (existing?.receive && document.getElementById(ROOT_ID)) return existing
  existing?.dispose?.()

  const cleanups = []
  const pending = new Map()
  const storageKey = 'yisama-infinite-assistant-ui-position-v1'
  const state = {
    open: false,
    loggedIn: false,
    configured: false,
    username: '',
    quota: '',
    group: '',
    groupLabel: '',
    groups: [],
    model: '',
    models: [],
    message: '',
    restartRequired: false,
    setupPending: false,
    staleQuota: false,
    pendingGroup: '',
    error: '',
    authReady: false,
    authMode: 'login',
    registrationEnabled: false,
    passwordLoginEnabled: false,
    emailVerificationEnabled: false,
    loginId: '',
    verificationRetryAt: 0,
    nativeSync: '',
  }
  let disposed = false
  let sequence = 0
  let foregroundVersion = 0
  let latestStatusId = 0
  let dragging = null
  let suppressClick = false

  const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }
  const addListener = (node, event, listener, options) => {
    node.addEventListener(event, listener, options)
    cleanups.push(() => node.removeEventListener(event, listener, options))
  }
  const el = (tag, attributes = {}, content = null) => {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined) continue
      if (name === 'className') node.className = value
      else if (name === 'text') node.textContent = value
      else node.setAttribute(name, String(value))
    }
    if (content !== null) node.textContent = content
    return node
  }
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
  const timeoutFor = (action) => {
    const override = options.requestTimeouts?.[action]
    if (Number.isFinite(override) && override > 0) return override
    if (action === 'status') return 90 * 1000
    return 120 * 1000
  }
  const cleanText = (value, maximum = 240) => typeof value === 'string' ? value.slice(0, maximum) : ''
  const selectValues = (values, mapper) => Array.isArray(values) ? values.map(mapper).filter(Boolean) : []

  const root = el('div', { id: ROOT_ID, className: 'yisama-assistant-ui' })
  const style = el('style')
  style.textContent = `
    #${ROOT_ID}{position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:#26312f;font:13px/1.45 "Segoe UI",system-ui,sans-serif}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} [hidden]{display:none!important}
    #${ROOT_ID} button,#${ROOT_ID} select,#${ROOT_ID} input{font:inherit}
    #${ROOT_ID} button{border:0;cursor:pointer}
    #${ROOT_ID} button:focus-visible,#${ROOT_ID} select:focus-visible,#${ROOT_ID} input:focus-visible{outline:2px solid #2b796d;outline-offset:2px}
    #${ROOT_ID} .yisama-badge{position:fixed;display:inline-flex;align-items:center;gap:6px;width:min(128px,calc(100vw - 16px));height:32px;padding:0 9px;border:1px solid rgba(39,77,70,.26);border-radius:6px;background:#f7fbf9;color:#173f39;box-shadow:0 3px 12px rgba(18,43,39,.15);font-size:12px;font-variant-numeric:tabular-nums;pointer-events:auto;touch-action:none;user-select:none;-webkit-app-region:no-drag}
    #${ROOT_ID} .yisama-badge:hover{background:#edf7f3}
    #${ROOT_ID} .yisama-badge[data-stale="true"]{border-color:#bd8a3b;color:#78531b;background:#fffaf0}
    #${ROOT_ID} .yisama-badge__mark{display:grid;place-items:center;width:16px;height:16px;flex:0 0 auto;color:#287967;font-size:17px;line-height:1}
    #${ROOT_ID} .yisama-badge__text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .yisama-badge__stale{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#b77e2b}
    #${ROOT_ID} .yisama-panel{position:fixed;top:0;right:0;bottom:0;display:flex;width:min(368px,100vw);min-width:0;flex-direction:column;border:1px solid #c7d1ce;border-radius:0;background:#f8fbfa;box-shadow:-7px 0 24px rgba(21,42,38,.16);pointer-events:auto;overflow:hidden;-webkit-app-region:no-drag}
    #${ROOT_ID} .yisama-panel[hidden]{display:none}
    #${ROOT_ID} .yisama-header{padding:18px 20px 0;border-bottom:1px solid #d7dfdc;background:rgba(255,255,255,.45)}
    #${ROOT_ID} .yisama-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px}
    #${ROOT_ID} .yisama-brand{display:flex;align-items:center;min-width:0;gap:9px}
    #${ROOT_ID} .yisama-brand__mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #b9d2ca;border-radius:6px;background:#ecf7f2;color:#247462;font-size:20px;line-height:1}
    #${ROOT_ID} .yisama-brand strong{display:block;overflow:hidden;font-size:16px;font-weight:650;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .yisama-brand small{display:block;color:#65716e;font-size:10px;overflow-wrap:anywhere}
    #${ROOT_ID} .yisama-header-actions{display:flex;gap:4px;flex:0 0 auto}
    #${ROOT_ID} .yisama-icon{display:grid;place-items:center;width:30px;height:30px;padding:0;border-radius:5px;background:transparent;color:#52615d;font-size:18px;line-height:1}
    #${ROOT_ID} .yisama-icon:hover{background:#e8f0ed;color:#173f39}
    #${ROOT_ID} .yisama-status{display:flex;align-items:center;gap:6px;min-height:38px;margin-top:12px;color:#64716e;font-size:11px}
    #${ROOT_ID} .yisama-status:before{width:6px;height:6px;border-radius:50%;background:#34836f;content:""}
    #${ROOT_ID} .yisama-status[data-kind="warning"]:before{background:#ba8534}
    #${ROOT_ID} .yisama-content{min-height:0;flex:1 1 auto;overflow:auto;padding:18px 20px}
    #${ROOT_ID} .yisama-balance{padding:14px 0 16px;border-bottom:1px solid #d7dfdc}
    #${ROOT_ID} .yisama-balance span{display:block;color:#65716e;font-size:11px}
    #${ROOT_ID} .yisama-balance strong{display:block;margin-top:3px;overflow:hidden;color:#173f39;font-size:25px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .yisama-balance small{display:block;margin-top:6px;color:#946722;font-size:11px}
    #${ROOT_ID} .yisama-account{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #d7dfdc}
    #${ROOT_ID} .yisama-account span{color:#65716e;font-size:11px}
    #${ROOT_ID} .yisama-account strong{min-width:0;color:#22302d;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .yisama-fields{display:grid;gap:14px;padding:16px 0}
    #${ROOT_ID} .yisama-field{display:grid;gap:6px}
    #${ROOT_ID} .yisama-field label{color:#52615d;font-size:11px}
    #${ROOT_ID} .yisama-field select{width:100%;height:34px;border:1px solid #c7d1ce;border-radius:5px;background:#fff;color:#22302d;padding:0 8px}
    #${ROOT_ID} .yisama-field select:disabled{background:#eef2f0;color:#89938f;cursor:not-allowed}
    #${ROOT_ID} .yisama-button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:0 11px;border:1px solid #b8cec6;border-radius:5px;background:#e8f4ef;color:#17463c;font-size:12px;font-weight:600}
    #${ROOT_ID} .yisama-button:hover:not(:disabled){background:#dcefe8}
    #${ROOT_ID} .yisama-button:disabled{opacity:.56;cursor:not-allowed}
    #${ROOT_ID} .yisama-button--wide{width:100%}
    #${ROOT_ID} .yisama-button--plain{border-color:#cbd4d1;background:#fff;color:#4b5c57}
    #${ROOT_ID} .yisama-button--danger{border-color:#d6c3b8;background:#fff8f4;color:#7d4a32}
    #${ROOT_ID} .yisama-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:2px}
    #${ROOT_ID} .yisama-note{margin:0 0 14px;padding:9px 10px;border-left:3px solid #b98436;background:#fffaf1;color:#715421;font-size:11px;line-height:1.5}
    #${ROOT_ID} .yisama-confirm{margin-top:14px;padding:12px;border:1px solid #d6c3b8;border-radius:5px;background:#fff8f4}
    #${ROOT_ID} .yisama-confirm p{margin:0;color:#654d42;font-size:12px;line-height:1.5}
    #${ROOT_ID} .yisama-confirm div{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}
    #${ROOT_ID} .yisama-logged-out{display:grid;gap:14px;padding-top:4px}
    #${ROOT_ID} .yisama-logged-out p{margin:0;color:#586762;font-size:12px;line-height:1.65}
    #${ROOT_ID} .yisama-auth-tabs{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #d7dfdc}
    #${ROOT_ID} .yisama-auth-tabs button{min-height:36px;border-bottom:2px solid transparent;background:transparent;color:inherit}
    #${ROOT_ID} .yisama-auth-tabs button[aria-selected="true"]{border-bottom-color:#287967;color:#287967;font-weight:600}
    #${ROOT_ID} .yisama-auth-form{display:grid;gap:14px;margin:0}
    #${ROOT_ID} .yisama-auth-form input{width:100%;min-width:0;height:36px;border:1px solid #c7d1ce;border-radius:5px;background:#fff;color:#22302d;padding:0 10px}
    #${ROOT_ID} .yisama-auth-form input:disabled{opacity:.6}
    #${ROOT_ID} .yisama-verification-row{display:grid;grid-template-columns:minmax(0,1fr) 106px;gap:8px}
    #${ROOT_ID} .yisama-auth-form label{color:#52615d;font-size:12px}
    #${ROOT_ID} .yisama-auth-form h2{margin:0;color:inherit;font-size:15px;font-weight:600}
    @media (prefers-color-scheme:dark){#${ROOT_ID} .yisama-auth-form input{border-color:#4b625c;background:#273834;color:#e5efeb}#${ROOT_ID} .yisama-auth-form label{color:#aebdb7}#${ROOT_ID} .yisama-auth-tabs{border-color:#405450}#${ROOT_ID} .yisama-auth-tabs button[aria-selected="true"]{color:#91d0bb;border-bottom-color:#91d0bb}}
    #${ROOT_ID} .yisama-footer{min-height:42px;padding:11px 20px;border-top:1px solid #d7dfdc;background:rgba(255,255,255,.38);color:#65716e;font-size:11px;line-height:1.4;overflow-wrap:anywhere}
    #${ROOT_ID} .yisama-footer[data-error="true"]{color:#8b5b21}
    @media (max-width:380px){#${ROOT_ID} .yisama-header{padding-right:16px;padding-left:16px}#${ROOT_ID} .yisama-content{padding-right:16px;padding-left:16px}#${ROOT_ID} .yisama-footer{padding-right:16px;padding-left:16px}#${ROOT_ID} .yisama-actions{grid-template-columns:1fr}}
    @media (max-height:500px){#${ROOT_ID} .yisama-header{padding-top:12px}#${ROOT_ID} .yisama-status{min-height:30px;margin-top:6px}#${ROOT_ID} .yisama-content{padding-top:12px;padding-bottom:12px}}
    @media (prefers-color-scheme:dark){#${ROOT_ID}{color:#e7efec}#${ROOT_ID} .yisama-badge{border-color:#477068;background:#20312d;color:#e5f2ed;box-shadow:0 3px 14px rgba(0,0,0,.34)}#${ROOT_ID} .yisama-badge:hover{background:#294039}#${ROOT_ID} .yisama-badge[data-stale="true"]{border-color:#93713c;background:#382f20;color:#f4e7ca}#${ROOT_ID} .yisama-panel{border-color:#405450;background:#1f2d2a;box-shadow:-7px 0 24px rgba(0,0,0,.34)}#${ROOT_ID} .yisama-header,#${ROOT_ID} .yisama-footer{border-color:#405450;background:rgba(10,19,17,.2)}#${ROOT_ID} .yisama-icon{color:#b9c8c2}#${ROOT_ID} .yisama-icon:hover{background:#30433e;color:#eff8f4}#${ROOT_ID} .yisama-brand__mark{border-color:#427568;background:#29473f;color:#91d0bb}#${ROOT_ID} .yisama-brand small,#${ROOT_ID} .yisama-status,#${ROOT_ID} .yisama-balance span,#${ROOT_ID} .yisama-account span,#${ROOT_ID} .yisama-field label,#${ROOT_ID} .yisama-footer{color:#aebdb7}#${ROOT_ID} .yisama-balance,#${ROOT_ID} .yisama-account{border-color:#405450}#${ROOT_ID} .yisama-balance strong,#${ROOT_ID} .yisama-account strong{color:#e5efeb}#${ROOT_ID} .yisama-field select{border-color:#4b625c;background:#273834;color:#e5efeb}#${ROOT_ID} .yisama-field select:disabled{background:#26322f;color:#83908b}#${ROOT_ID} .yisama-button{border-color:#457367;background:#29463e;color:#dff3eb}#${ROOT_ID} .yisama-button:hover:not(:disabled){background:#33584d}#${ROOT_ID} .yisama-button--plain{border-color:#4b625c;background:#263632;color:#d2dfda}#${ROOT_ID} .yisama-button--danger{border-color:#805b4b;background:#382a25;color:#f4d9cb}#${ROOT_ID} .yisama-note{background:#362c1e;color:#ebd9b5}#${ROOT_ID} .yisama-confirm{border-color:#805b4b;background:#382a25}#${ROOT_ID} .yisama-confirm p{color:#f0d8ca}#${ROOT_ID} .yisama-logged-out p{color:#bdcbc6}}
    @media (prefers-reduced-motion:reduce){#${ROOT_ID} *{scroll-behavior:auto!important;transition:none!important}}
  `
  root.appendChild(style)

  const badge = el('button', {
    type: 'button', className: 'yisama-badge', 'aria-label': '打开 yisama 无限助手', 'aria-expanded': 'false',
    'data-testid': 'assistant-badge',
  })
  const badgeMark = el('span', { className: 'yisama-badge__mark', 'aria-hidden': 'true' }, '∞')
  const badgeText = el('span', { className: 'yisama-badge__text', 'data-testid': 'badge-balance' }, '登录')
  const badgeStale = el('span', { className: 'yisama-badge__stale', hidden: '', title: '余额可能已过期', 'aria-label': '余额可能已过期', 'data-testid': 'badge-stale' })
  badge.append(badgeMark, badgeText, badgeStale)

  const panel = el('aside', {
    className: 'yisama-panel', role: 'dialog', 'aria-label': 'yisama 无限助手', 'aria-modal': 'false',
    hidden: '', 'data-testid': 'assistant-panel',
  })
  const header = el('header', { className: 'yisama-header' })
  const titleRow = el('div', { className: 'yisama-title-row' })
  const brand = el('div', { className: 'yisama-brand' })
  brand.append(
    el('span', { className: 'yisama-brand__mark', 'aria-hidden': 'true' }, '∞'),
    el('span', {}, null),
  )
  const brandText = brand.lastChild
  brandText.append(el('strong', { text: 'yisama 无限助手' }), el('small', { text: '与 api.yisama.asia 共用账户' }))
  const headerActions = el('div', { className: 'yisama-header-actions' })
  const refreshButton = el('button', {
    type: 'button', className: 'yisama-icon', title: '刷新账户状态', 'aria-label': '刷新账户状态',
    'data-testid': 'refresh',
  }, '↻')
  const closeButton = el('button', {
    type: 'button', className: 'yisama-icon', title: '关闭', 'aria-label': '关闭', 'data-testid': 'close',
  }, '×')
  headerActions.append(refreshButton, closeButton)
  titleRow.append(brand, headerActions)
  const statusLine = el('div', { className: 'yisama-status', 'data-testid': 'status-line' }, '正在读取账户状态')
  header.append(titleRow, statusLine)

  const content = el('main', { className: 'yisama-content' })
  const balance = el('section', { className: 'yisama-balance' })
  const balanceLabel = el('span', {}, '账户余额')
  const balanceValue = el('strong', { 'data-testid': 'panel-balance' }, '—')
  const balanceStale = el('small', { hidden: '', 'data-testid': 'stale-note' }, '余额可能已过期')
  balance.append(balanceLabel, balanceValue, balanceStale)
  const account = el('section', { className: 'yisama-account', hidden: '' })
  account.append(el('span', {}, '账号'), el('strong', { 'data-testid': 'username' }))
  const fields = el('section', { className: 'yisama-fields', hidden: '' })
  const groupField = el('div', { className: 'yisama-field' })
  const groupLabel = el('label', { for: 'yisama-assistant-group' }, '分组')
  const groupSelect = el('select', { id: 'yisama-assistant-group', 'data-testid': 'group-select' })
  groupField.append(groupLabel, groupSelect)
  const applyButton = el('button', {
    type: 'button', className: 'yisama-button yisama-button--wide', 'data-testid': 'apply-selection',
  }, '使用此分组')
  fields.append(groupField, applyButton)
  const actions = el('section', { className: 'yisama-actions', hidden: '' })
  const rechargeButton = el('button', { type: 'button', className: 'yisama-button', 'data-testid': 'recharge' }, '充值')
  const restoreButton = el('button', { type: 'button', className: 'yisama-button yisama-button--danger', 'data-testid': 'restore' }, '退出并恢复')
  actions.append(rechargeButton, restoreButton)
  const confirmation = el('section', { className: 'yisama-confirm', hidden: '', 'data-testid': 'restore-confirmation' })
  const confirmationText = el('p', {}, '退出账户并恢复之前的 Codex 配置？')
  const confirmationActions = el('div')
  const cancelRestore = el('button', { type: 'button', className: 'yisama-button yisama-button--plain', 'data-testid': 'cancel-restore' }, '取消')
  const confirmRestore = el('button', { type: 'button', className: 'yisama-button yisama-button--danger', 'data-testid': 'confirm-restore' }, '恢复')
  confirmationActions.append(cancelRestore, confirmRestore)
  confirmation.append(confirmationText, confirmationActions)
  const loggedOut = el('section', { className: 'yisama-logged-out', 'data-testid': 'logged-out' })
  const loggedOutText = el('p', {}, '与官方中转站 https://api.yisama.asia 账号互通。')
  const authTabs = el('div', { className: 'yisama-auth-tabs', role: 'tablist', 'aria-label': '账号', 'data-testid': 'auth-tabs' })
  const loginTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'true', 'data-testid': 'login-tab' }, '登录')
  const registerTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-testid': 'register-tab' }, '注册')
  authTabs.append(loginTab, registerTab)
  const authForm = el('form', { className: 'yisama-auth-form', 'data-testid': 'auth-form' })
  const inputField = (name, label, attributes) => {
    const field = el('div', { className: 'yisama-field' })
    const id = `yisama-auth-${name}`
    const input = el('input', { id, name, 'data-testid': `auth-${name}`, ...attributes })
    field.append(el('label', { for: id }, label), input)
    return { field, input }
  }
  const usernameField = inputField('username', '账号', { type: 'text', autocomplete: 'username', maxlength: 200, required: '' })
  const passwordField = inputField('password', '密码', { type: 'password', autocomplete: 'current-password', maxlength: 1024, required: '' })
  const confirmField = inputField('confirm-password', '确认密码', { type: 'password', autocomplete: 'new-password', maxlength: 20 })
  const emailField = inputField('email', '邮箱', { type: 'email', autocomplete: 'email', maxlength: 254 })
  const verificationField = inputField('verification-code', '邮箱验证码', { type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6 })
  const verificationRow = el('div', { className: 'yisama-verification-row' })
  const sendVerificationButton = el('button', { type: 'button', className: 'yisama-button yisama-button--plain', 'data-testid': 'send-verification' }, '发送验证码')
  verificationRow.append(verificationField.input, sendVerificationButton)
  verificationField.field.append(verificationRow)
  const loginButton = el('button', { type: 'submit', className: 'yisama-button yisama-button--wide', 'data-testid': 'login' }, '登录')
  authForm.append(usernameField.field, passwordField.field, confirmField.field, emailField.field, verificationField.field, loginButton)
  const twoFactorForm = el('form', { className: 'yisama-auth-form', hidden: '', 'data-testid': 'two-factor-form' })
  const twoFactorField = inputField('two-factor', '二次验证码或备用码', { type: 'text', autocomplete: 'one-time-code', maxlength: 100, required: '' })
  const twoFactorButton = el('button', { type: 'submit', className: 'yisama-button yisama-button--wide', 'data-testid': 'verify-login' }, '验证并登录')
  const backToLogin = el('button', { type: 'button', className: 'yisama-button yisama-button--plain', 'data-testid': 'back-to-login' }, '返回登录')
  twoFactorForm.append(el('h2', {}, '二次验证'), twoFactorField.field, twoFactorButton, backToLogin)
  loggedOut.append(loggedOutText, authTabs, authForm, twoFactorForm)
  content.append(balance, account, fields, actions, confirmation, loggedOut)
  const footer = el('footer', { className: 'yisama-footer', 'data-testid': 'message' })
  panel.append(header, content, footer)
  root.append(badge, panel)
  document.documentElement.appendChild(root)

  const publicState = (data) => ({
    loggedIn: data?.loggedIn === true,
    configured: data?.configured === true,
    username: cleanText(data?.username, 120),
    quota: cleanText(data?.quota, 80),
    group: cleanText(data?.group, 200),
    groupLabel: cleanText(data?.groupLabel, 200),
    groups: selectValues(data?.groups, (group) => {
      const value = cleanText(group?.value, 200)
      const label = cleanText(group?.label, 200)
      return value && label ? { value, label } : null
    }),
    model: cleanText(data?.model, 200),
    models: selectValues(data?.models, (model) => cleanText(model, 200)),
    message: cleanText(data?.message),
    restartRequired: data?.restartRequired === true,
    setupPending: data?.setupPending === true,
  })
  const setOptions = (select, values, selected) => {
    select.replaceChildren()
    for (const item of values) {
      const option = el('option', { value: item.value ?? item })
      option.textContent = item.label ?? item
      option.selected = (item.value ?? item) === selected
      select.appendChild(option)
    }
  }
  const quotaLabel = () => state.quota || '—'
  const statusText = () => {
    if (state.error) return state.error
    if (state.nativeSync === 'pending') return '正在同步 Codex 模型。'
    if (state.nativeSync === 'syncing') return '正在同步 Codex 模型。'
    if (state.nativeSync === 'account-change') return 'Codex 仍使用原账号，助手尚未接管；未中断当前对话。'
    if (state.nativeSync === 'error') return '配置已保存，Codex 模型尚未同步。'
    if (state.setupPending || hasActivePending('login')) return '登录成功，正在准备配置。'
    if (state.message) return state.message
    if (state.loggedIn && state.configured) return '已准备就绪'
    if (state.loggedIn) return '账户已登录'
    return '未登录'
  }
  const hasActivePending = (action) => [...pending.values()].some((entry) => entry.action === action && !entry.timedOut)
  const hasForegroundPending = () => [...pending.values()].some((entry) => entry.action !== 'status' && !entry.timedOut)
  const render = () => {
    const quota = quotaLabel()
    const badgeLabel = state.loggedIn ? `余额 ${quota}` : '登录'
    badgeText.textContent = badgeLabel
    badgeText.title = badgeLabel
    badgeStale.hidden = !(state.staleQuota && Boolean(state.quota))
    badge.dataset.stale = String(state.staleQuota && Boolean(state.quota))
    badge.setAttribute('aria-label', state.staleQuota && state.quota
      ? `${badgeLabel}，余额可能已过期。打开 yisama 无限助手`
      : `${badgeLabel}。打开 yisama 无限助手`)
    badge.setAttribute('aria-expanded', String(state.open))
    panel.hidden = !state.open
    balanceValue.textContent = quota
    balance.hidden = !state.loggedIn
    balanceStale.hidden = !(state.staleQuota && Boolean(state.quota))
    statusLine.textContent = statusText()
    statusLine.dataset.kind = state.error || state.staleQuota ? 'warning' : 'normal'
    footer.textContent = state.error || state.message || ''
    footer.dataset.error = String(Boolean(state.error))
    account.hidden = !state.loggedIn
    fields.hidden = !state.loggedIn
    actions.hidden = !state.loggedIn
    loggedOut.hidden = state.loggedIn
    confirmation.hidden = confirmation.dataset.open !== 'true' || !state.loggedIn
    if (state.loggedIn) {
      const selectedGroup = state.pendingGroup || state.group
      setOptions(groupSelect, state.groups, selectedGroup)
      groupSelect.disabled = hasForegroundPending() || !state.groups.length
      applyButton.hidden = state.configured
      applyButton.textContent = state.groups.length ? '使用此分组' : '重试准备'
      applyButton.disabled = hasForegroundPending() || Boolean(state.pendingGroup)
        || (state.groups.length > 0 && !selectedGroup)
      account.lastChild.textContent = state.username || '—'
      rechargeButton.disabled = hasForegroundPending()
      restoreButton.disabled = hasForegroundPending()
      confirmRestore.disabled = hasForegroundPending()
    }
    refreshButton.disabled = hasActivePending('status')
    const registering = state.authMode === 'register'
    const busy = hasForegroundPending()
    const secondStep = Boolean(state.loginId)
    authTabs.hidden = secondStep
    authForm.hidden = secondStep
    twoFactorForm.hidden = !secondStep
    loginTab.setAttribute('aria-selected', String(!registering))
    registerTab.setAttribute('aria-selected', String(registering))
    loginTab.disabled = busy
    registerTab.disabled = busy || !state.registrationEnabled
    usernameField.input.maxLength = registering ? 20 : 200
    passwordField.input.maxLength = registering ? 20 : 1024
    passwordField.input.minLength = registering ? 8 : 1
    passwordField.input.autocomplete = registering ? 'new-password' : 'current-password'
    confirmField.field.hidden = !registering
    confirmField.input.required = registering
    const verifyEmail = registering && state.emailVerificationEnabled
    emailField.field.hidden = !verifyEmail
    emailField.input.required = verifyEmail
    verificationField.field.hidden = !verifyEmail
    verificationField.input.required = verifyEmail
    for (const field of [usernameField, passwordField, confirmField, emailField, verificationField, twoFactorField]) {
      field.input.disabled = busy
    }
    loginButton.disabled = busy || !state.authReady || !(registering ? state.registrationEnabled : state.passwordLoginEnabled)
    loginButton.textContent = hasActivePending('login') ? '正在登录…' : hasActivePending('register') ? '正在注册…' : registering ? '注册' : '登录'
    twoFactorButton.disabled = busy
    twoFactorButton.textContent = hasActivePending('login') ? '正在验证…' : '验证并登录'
    backToLogin.disabled = busy
    const retryAfter = Math.max(0, Math.ceil((state.verificationRetryAt - Date.now()) / 1000))
    sendVerificationButton.disabled = busy || retryAfter > 0
    sendVerificationButton.textContent = hasActivePending('sendVerification') ? '正在发送…' : retryAfter ? `${retryAfter}s 后重发` : '发送验证码'
  }
  const applyData = (data, preserveDrafts = false) => {
    const next = publicState(data)
    const drafts = { pendingGroup: preserveDrafts ? state.pendingGroup : '' }
    Object.assign(state, next, drafts, { staleQuota: false, error: '' })
    if (!state.loggedIn) confirmation.dataset.open = 'false'
    if (state.loggedIn) {
      clearAuthSecrets()
      state.loginId = ''
    }
  }
  const clearAuthSecrets = () => {
    passwordField.input.value = ''
    confirmField.input.value = ''
    verificationField.input.value = ''
    twoFactorField.input.value = ''
  }
  const failure = (entry, code) => {
    if (entry.action === 'status') {
      state.staleQuota = Boolean(state.quota)
      state.error = '无法刷新账户状态'
    } else if (entry.setup) {
      state.setupPending = false
      state.error = '账户已登录，准备配置未完成，请重试准备。'
    } else if (entry.action === 'login') {
      state.error = '登录未完成，请检查账号、密码或二次验证码。'
    } else if (entry.action === 'register') {
      state.error = '注册未完成，请检查账号、密码和邮箱验证码。'
    } else if (entry.action === 'authOptions') {
      state.error = '无法连接助手登录服务，请稍后刷新。'
    } else if (entry.action === 'sendVerification') {
      state.error = '验证码发送失败，请检查邮箱或稍后重试。'
    } else if (entry.action === 'select') {
      state.pendingGroup = ''
      state.error = code === 'GROUP_NO_TEXT_MODEL'
        ? '此分组没有可自动选择的对话模型，原分组未改动。'
        : '切换未完成，原分组未改动，请重试。'
    } else {
      state.error = '操作未完成，请稍后重试。'
    }
    const authErrors = {
      AUTH_RATE_LIMIT: '操作过于频繁，请稍后再试。',
      AUTH_UNAVAILABLE: '账号服务暂时不可用，请稍后重试。',
      AUTH_CONNECTION: '暂时无法连接账号服务，请检查网络后重试。',
      AUTH_SESSION_LIMIT: '登录设备过多，请先退出其他设备。',
      AUTH_EXPIRED: '二次验证已过期，请重新输入账号和密码。',
    }
    if (['login', 'register', 'authOptions', 'sendVerification'].includes(entry.action) && authErrors[code]) {
      state.error = authErrors[code]
      if (code === 'AUTH_EXPIRED') state.loginId = ''
    }
    if (['login', 'register'].includes(entry.action)) clearAuthSecrets()
  }
  const settleTimeout = (id) => {
    const entry = pending.get(id)
    if (!entry || disposed) return
    if (entry.action !== 'status') {
      entry.timedOut = true
      if (entry.setup) {
        state.setupPending = false
        state.error = '账户已登录，准备配置等待较久，仍可能完成。'
      } else state.error = '操作仍在等待完成。'
      render()
      return
    }
    pending.delete(id)
    if (entry.id !== latestStatusId || hasForegroundPending() || entry.foregroundVersion !== foregroundVersion) return
    failure(entry)
    render()
  }
  const request = (action, details = {}) => {
    if (disposed || (action === 'status' ? hasActivePending('status') : hasForegroundPending())) return null
    const id = ++sequence
    if (action !== 'status') foregroundVersion += 1
    const command = { id, action }
    if (typeof details.group === 'string' && details.group) command.group = details.group
    const authFields = action === 'login' ? ['username', 'password', 'loginId', 'twoFactorCode']
      : action === 'register' ? ['username', 'password', 'email', 'verificationCode']
        : action === 'sendVerification' ? ['email'] : []
    for (const name of authFields) {
      if (typeof details[name] === 'string' && details[name]) command[name] = details[name]
    }
    if (action === 'select' && command.group) {
      state.pendingGroup = command.group
    }
    state.error = ''
    const entry = {
      id,
      action,
      setup: action === 'login' && !command.username && !command.password && !command.loginId,
      foregroundVersion,
      timer: window.setTimeout(() => settleTimeout(id), timeoutFor(action)),
      timedOut: false,
    }
    pending.set(id, entry)
    if (action === 'status') latestStatusId = id
    render()
    try {
      const result = window.yisamaAssistantCommand?.(JSON.stringify(command))
      result?.catch?.(() => {
        const active = pending.get(id)
        if (!active) return
        pending.delete(id)
        window.clearTimeout(active.timer)
        failure(active)
        if (active.action !== 'status') foregroundVersion += 1
        render()
      })
      if (typeof window.yisamaAssistantCommand !== 'function') throw new Error('bridge unavailable')
    } catch {
      const active = pending.get(id)
      if (active) {
        pending.delete(id)
        window.clearTimeout(active.timer)
        failure(active)
        if (active.action !== 'status') foregroundVersion += 1
        render()
      }
    }
    return id
  }
  const setOpen = (open) => {
    const opening = open && !state.open
    state.open = open
    if (!open) clearAuthSecrets()
    render()
    if (opening) request('status')
    if (open) window.setTimeout(() => closeButton.focus(), 0)
  }
  const storedPosition = safe(() => JSON.parse(window.localStorage.getItem(storageKey) || 'null'), null)
  const defaultPosition = () => ({ left: Math.max(8, window.innerWidth - 138), top: Math.max(8, window.innerHeight - 56) })
  const badgePosition = {
    left: Number.isFinite(storedPosition?.left) ? storedPosition.left : defaultPosition().left,
    top: Number.isFinite(storedPosition?.top) ? storedPosition.top : defaultPosition().top,
  }
  const placeBadge = () => {
    const width = badge.offsetWidth || 120
    const height = badge.offsetHeight || 32
    badgePosition.left = clamp(badgePosition.left, 8, Math.max(8, window.innerWidth - width - 8))
    badgePosition.top = clamp(badgePosition.top, 8, Math.max(8, window.innerHeight - height - 8))
    badge.style.left = `${Math.round(badgePosition.left)}px`
    badge.style.top = `${Math.round(badgePosition.top)}px`
  }
  const saveBadgePosition = () => safe(() => window.localStorage.setItem(storageKey, JSON.stringify(badgePosition)))

  addListener(badge, 'pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: badgePosition.left, top: badgePosition.top, moved: false }
    badge.setPointerCapture?.(event.pointerId)
  })
  addListener(badge, 'pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return
    const dx = event.clientX - dragging.startX
    const dy = event.clientY - dragging.startY
    if (Math.abs(dx) + Math.abs(dy) > 5) dragging.moved = true
    if (!dragging.moved) return
    badgePosition.left = dragging.left + dx
    badgePosition.top = dragging.top + dy
    placeBadge()
  })
  const finishDrag = (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return
    if (dragging.moved) {
      suppressClick = true
      saveBadgePosition()
      window.setTimeout(() => { suppressClick = false }, 0)
    }
    dragging = null
  }
  addListener(badge, 'pointerup', finishDrag)
  addListener(badge, 'pointercancel', finishDrag)
  addListener(badge, 'click', () => {
    if (suppressClick) return
    setOpen(!state.open)
  })
  addListener(closeButton, 'click', () => setOpen(false))
  addListener(refreshButton, 'click', () => {
    if (state.nativeSync === 'error') delete window.__yisamaNativeModelSync
    request('status')
  })
  const setAuthMode = (mode) => {
    if (hasForegroundPending()) return
    state.authMode = mode
    state.loginId = ''
    state.error = ''
    state.message = ''
    clearAuthSecrets()
    render()
    usernameField.input.focus()
  }
  addListener(loginTab, 'click', () => setAuthMode('login'))
  addListener(registerTab, 'click', () => {
    if (state.registrationEnabled) setAuthMode('register')
  })
  addListener(backToLogin, 'click', () => setAuthMode('login'))
  addListener(authForm, 'submit', (event) => {
    event.preventDefault()
    if (hasForegroundPending() || !state.authReady || !authForm.reportValidity()) return
    const registering = state.authMode === 'register'
    if (!(registering ? state.registrationEnabled : state.passwordLoginEnabled)) return
    if (registering && passwordField.input.value !== confirmField.input.value) {
      state.error = '两次输入的密码不一致。'
      render()
      confirmField.input.focus()
      return
    }
    const details = { username: usernameField.input.value.trim(), password: passwordField.input.value }
    if (registering && state.emailVerificationEnabled) {
      details.email = emailField.input.value.trim()
      details.verificationCode = verificationField.input.value.trim()
    }
    clearAuthSecrets()
    request(registering ? 'register' : 'login', details)
  })
  addListener(twoFactorForm, 'submit', (event) => {
    event.preventDefault()
    if (hasForegroundPending() || !state.loginId || !twoFactorForm.reportValidity()) return
    const details = { loginId: state.loginId, twoFactorCode: twoFactorField.input.value.trim() }
    clearAuthSecrets()
    request('login', details)
  })
  addListener(sendVerificationButton, 'click', () => {
    if (hasForegroundPending() || Date.now() < state.verificationRetryAt || !emailField.input.reportValidity()) return
    request('sendVerification', { email: emailField.input.value.trim() })
  })
  addListener(loggedOut, 'keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation()
  })
  addListener(groupSelect, 'change', () => {
    if (groupSelect.value && groupSelect.value !== state.group) request('select', { group: groupSelect.value })
  })
  addListener(applyButton, 'click', () => {
    if (state.configured || state.pendingGroup) return
    if (!state.groups.length) request('login')
    else if (groupSelect.value) request('select', { group: groupSelect.value })
  })
  addListener(rechargeButton, 'click', () => request('recharge'))
  addListener(restoreButton, 'click', () => {
    confirmation.dataset.open = 'true'
    render()
    cancelRestore.focus()
  })
  addListener(cancelRestore, 'click', () => {
    confirmation.dataset.open = 'false'
    render()
  })
  addListener(confirmRestore, 'click', () => request('restore'))
  addListener(document, 'keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      event.preventDefault()
      setOpen(false)
      badge.focus()
    }
  })
  addListener(document, 'visibilitychange', () => {
    if (!document.hidden) request('status')
  })
  addListener(window, 'resize', placeBadge)
  const pollTimer = window.setInterval(() => {
    if (!document.hidden) request('status')
  }, 60 * 1000)
  cleanups.push(() => window.clearInterval(pollTimer))
  const authTimer = window.setInterval(() => {
    if (state.open && !state.loggedIn && state.verificationRetryAt) render()
  }, 1000)
  cleanups.push(() => window.clearInterval(authTimer))

  const runtime = {
    nativeStatus(status) {
      if (disposed || !['pending', 'syncing', 'synced', 'error', 'account-change'].includes(status)) return
      if (state.nativeSync === status) return
      state.nativeSync = status
      render()
    },
    receive(response) {
      if (disposed || !response || !Number.isFinite(response.id)) return false
      const entry = pending.get(response.id)
      if (!entry) return false
      pending.delete(response.id)
      window.clearTimeout(entry.timer)
      if (entry.action === 'status' && (entry.id !== latestStatusId || hasForegroundPending() || entry.foregroundVersion !== foregroundVersion)) return true
      if (entry.action !== 'status' && entry.foregroundVersion !== foregroundVersion) return true
      let startSetup = false
      if (response.ok === true && response.data && typeof response.data === 'object') {
        const data = response.data
        state.error = ''
        if (entry.action === 'authOptions') {
          state.authReady = true
          state.passwordLoginEnabled = data.auth?.passwordLoginEnabled === true
          state.registrationEnabled = data.auth?.registrationEnabled === true
          state.emailVerificationEnabled = data.auth?.emailVerificationEnabled === true
          state.message = !state.passwordLoginEnabled ? '站点暂未开放密码登录。' : ''
        } else if (entry.action === 'login' && data.auth?.step === 'twoFactor') {
          state.loginId = cleanText(data.auth.loginId, 100)
          state.message = '请完成账号的二次验证。'
          clearAuthSecrets()
          window.setTimeout(() => twoFactorField.input.focus(), 0)
        } else if (entry.action === 'register' && data.registered === true) {
          state.authMode = 'login'
          clearAuthSecrets()
          state.message = '注册成功，请使用新账号登录。'
        } else if (entry.action === 'sendVerification' && data.verificationSent === true) {
          state.verificationRetryAt = Date.now() + 60 * 1000
          state.message = '验证码已发送，请查看邮箱。'
        } else {
          applyData(data, entry.action === 'status')
          startSetup = entry.action === 'login' && !entry.setup && state.loggedIn && state.setupPending
          if (startSetup) state.message = '登录成功，正在准备配置。'
        }
      } else failure(entry, response.code)
      if (entry.action !== 'status') foregroundVersion += 1
      render()
      if (startSetup) request('login')
      if (entry.action === 'status' && response.ok === true && !state.loggedIn && !state.authReady) request('authOptions')
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) window.clearTimeout(entry.timer)
      pending.clear()
      clearAuthSecrets()
      state.loginId = ''
      cleanups.splice(0).reverse().forEach((cleanup) => safe(cleanup))
      root.remove()
      if (window.__yisamaInfiniteAssistant === runtime) delete window.__yisamaInfiniteAssistant
    },
    snapshot() {
      return {
        loggedIn: state.loggedIn, configured: state.configured, username: state.username, quota: state.quota,
        group: state.group, groupLabel: state.groupLabel, groups: state.groups.map((group) => ({ ...group })),
        model: state.model, models: [...state.models], message: state.message, restartRequired: state.restartRequired,
        open: state.open, staleQuota: state.staleQuota, setupPending: state.setupPending,
      }
    },
  }
  window.__yisamaInfiniteAssistant = runtime
  render()
  placeBadge()
  request('status')
  return runtime
}

export function makeAssistantScript() {
  return `(() => {
    const install = ${installAssistantUI.toString()};
    let topFrame = false;
    try { topFrame = window.top === window; } catch {}
    if (!topFrame || window.location.href !== 'app://-/index.html') return null;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => install(), { once: true });
      return null;
    }
    return install();
  })()`
}

export const REMOVE_ASSISTANT_SCRIPT = `(() => {
  let topFrame = false;
  try { topFrame = window.top === window; } catch {}
  if (!topFrame || window.location.href !== 'app://-/index.html') return;
  window.__yisamaInfiniteAssistant?.dispose?.();
})()`
