// 简洁模式：?demo 保留本地演示；正式页面使用同源 new-api 接口。
(() => {
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const demo = new URLSearchParams(location.search).has('demo')
  const ORIGIN = 'https://api.yisama.asia'
  const PRICING_URL = demo ? 'api/pricing' : '/api/pricing'
  const KEY_NAME = '简洁模式'
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms))
  const fmt = (n, dec = 0) => n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  let sessionPromise = null
  let firstRequestTimer = null
  // 单价太小时 “¥0.00001” 看着像免费，改说 1 块钱能用多少次
  const price = (c) => (c >= 0.001 ? `每次约 ¥${c.toFixed(c >= 0.01 ? 3 : 4)}` : `¥1 约 ${short(Math.floor(1 / c))} 次`)
  const short = (n) => (n >= 1e8 ? fmt(n / 1e8, 1) + ' 亿' : n >= 1e4 ? fmt(n / 1e4, n >= 1e5 ? 0 : 1) + ' 万' : fmt(n))

  // ---------- 厂商 / 用途 ----------
  // 厂商按模型名归类（pricing 里国产模型没有 vendor_id）。图片、视频模型不在这里，放到“站里直接能用”。
  const VENDORS = [
    { id: 'openai', name: 'GPT', by: 'OpenAI', mono: 'G', re: /^(gpt|codex|o\d)/i, model: 'gpt-6-luna', group: '不降智plus', blurb: '写代码、Codex 首选' },
    { id: 'claude', name: 'Claude', by: 'Anthropic', mono: 'C', re: /^claude/i, model: 'claude-sonnet-5', blurb: '写作、长文、Claude Code' },
    { id: 'gemini', name: 'Gemini', by: 'Google', mono: 'G', re: /^gemini/i, blurb: '多模态、长上下文' },
    { id: 'cn', name: '国产模型', by: 'DeepSeek · GLM · Kimi · 通义', mono: '国', re: /^(deepseek|glm|kimi|qwen|minimax|mimo|hy\d)/i, model: 'deepseek-v4.1-flash', blurb: '便宜、中文好' },
  ]
  const USES = [
    // short：标题里用；step2 / step3：首页三步的第 2、3 步；tip：第 2 步下面的一句说明
    { id: 'codex', name: 'Codex', app: '你的 Codex', short: 'Codex', hint: 'OpenAI 的写代码工具',
      step2: '填进 Codex', step3: '在 Codex 里发一句“你好”', tip: '' },
    { id: 'claude-code', name: 'Claude Code', app: '你的 Claude Code', short: 'Claude Code', hint: 'Anthropic 的写代码工具',
      step2: '在 PowerShell 里运行 3 行命令', step3: '重新打开终端，输入 claude，发一句“你好”', tip: '展开下面的命令，复制后粘贴到 PowerShell 回车即可。' },
    { id: 'chat', name: '聊天软件', app: '你的软件', short: '聊天软件', hint: 'Cherry Studio、Chatbox 等',
      step2: '填进聊天软件', step3: '在软件里选一个模型，发一句“你好”', tip: '在软件设置里添加服务商，类型选“OpenAI 兼容”，把上面的 Key 和地址粘贴进去。' },
    { id: 'code', name: '自己写程序', app: '你的程序', short: '程序', hint: 'Python / Node 调接口',
      step2: '在程序里调用', step3: '运行一次，发一句“你好”', tip: '和调用 OpenAI 一样，只需改 base_url 和 api_key。' },
  ]
  // 估算场景：每次调用的输入 / 输出 token 数。cached = 其中命中缓存的输入。
  const SCENES = [
    { id: 'hi', name: '发一句 hi', in: 20, out: 20, cached: 0, desc: '你发 “hi”，它回一句问候。最便宜的情况。' },
    { id: 'qa', name: '日常问答', in: 600, out: 800, cached: 0, desc: '问一个问题，它回大约 500 字。像在聊天软件里正常提问。' },
    { id: 'agent', name: '让 Codex 改代码', in: 40000, out: 1500, cached: 32000, desc: '在 Codex / Claude Code 里改一次代码：会带上项目文件，输入很长，其中大部分命中缓存。' },
  ]
  const DEMO_USAGE = {
    today: { todayCalls: 12, calls: 12, tokens: 18420, spent: .18, bars: [18420], labels: ['今天'] },
    '3d': { todayCalls: 12, calls: 38, tokens: 59600, spent: .46, bars: [19800, 21400, 18420], labels: ['前天', '昨天', '今天'] },
    '7d': { todayCalls: 12, calls: 111, tokens: 172400, spent: 1.27, bars: [15400, 28100, 22600, 31800, 20400, 35700, 18420], labels: ['一', '二', '三', '四', '五', '六', '日'] },
    month: { todayCalls: 12, calls: 482, tokens: 812000, spent: 6.43, bars: [19200, 26400, 33800, 22100, 41500, 29600, 36200, 48700, 25100, 32800, 44700, 39100, 52600, 31400, 28400, 46300, 57200, 38500, 41800, 62400, 35900, 48700, 54100, 29600, 38200, 44700, 51300, 29800, 40600, 18420], labels: ['1', '', '', '', '5', '', '', '', '', '10', '', '', '', '', '15', '', '', '', '', '20', '', '', '', '', '25', '', '', '', '', '30'] },
    all: { todayCalls: 12, calls: 1284, tokens: 2240000, spent: 18.83, bars: [128000, 176000, 142000, 214000, 168000, 246000, 198000, 286000, 224000, 312000, 184000, 162000], labels: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'] },
  }
  const EMPTY_USAGE = { todayCalls: 0, calls: 0, tokens: 0, spent: 0, bars: [], labels: [] }

  // ---------- 接口 ----------
  const api = {
    async request(path, { method = 'GET', body, headers = {}, redirectOnAuth = true } = {}) {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(state.userId ? { 'New-Api-User': String(state.userId) } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status === 401 && redirectOnAuth && !demo) {
        const redirect = `${location.pathname}${location.search}`
        location.assign(`/sign-in?redirect=${encodeURIComponent(redirect)}`)
        throw new Error('AUTH_REQUIRED')
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.success === false) throw new Error(`API_${response.status}`)
      return payload
    },
    async session() {
      if (demo) return { id: 1, username: 'demo' }
      if (!sessionPromise) {
        sessionPromise = (async () => {
          const response = await fetch('/api/user/auth/refresh', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { Accept: 'application/json' },
          })
          if (response.status === 401) {
            location.assign(`/sign-in?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`)
            return null
          }
          const payload = await response.json().catch(() => null)
          const user = payload?.data?.user
          if (!response.ok || !payload?.success || !Number.isInteger(user?.id)) throw new Error('SESSION_INVALID')
          state.userId = user.id
          return user
        })().catch((error) => {
          sessionPromise = null
          throw error
        })
      }
      return sessionPromise
    },
    async pricing() { return (await fetch(PRICING_URL, { cache: 'no-store' })).json() },
    async findKey() {
      if (demo) return state.keyId ? { id: state.keyId, group: state.group, name: KEY_NAME } : null
      const keyword = encodeURIComponent(KEY_NAME)
      const payload = await this.request(`/api/token/search?keyword=${keyword}&p=1&size=100`)
      const items = payload.data?.items?.filter((item) => item?.name === KEY_NAME && item.status !== 0) || []
      return items.find((item) => item.group === state.group) || items[0] || null
    },
    async readKey(key) {
      if (demo) return state.key
      const payload = await this.request(`/api/token/${key.id}/key`, { method: 'POST' })
      const value = payload.data?.key
      if (typeof value !== 'string' || value.length < 8) throw new Error('KEY_INVALID')
      return value.startsWith('sk-') ? value : `sk-${value}`
    },
    async createKey() {
      if (demo) { await wait(700); state.keyId = 1; return 'sk-ys7Hq2Lm9Vb4Xc1Np8Rt6Wz3Kd5Jf0Ga3f2a' }
      await this.session()
      let key = await this.findKey()
      if (!key) {
        await this.request('/api/token/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            name: KEY_NAME, remain_quota: 0, expired_time: -1, unlimited_quota: true,
            model_limits_enabled: false, model_limits: '', allow_ips: '', group: state.group,
            auto_groups: [], cross_group_retry: state.group === 'auto',
          },
        })
        key = await this.findKey()
      }
      if (!key?.id) throw new Error('KEY_CREATE_FAILED')
      state.keyId = key.id
      return this.readKey(key)
    },
    async setGroup(group) {
      if (demo) { await wait(200); return }
      await this.session()
      const key = await this.findKey()
      if (!key?.id) throw new Error('KEY_NOT_FOUND')
      await this.request('/api/token/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: key.id, name: KEY_NAME, status: 1, expired_time: -1, remain_quota: 0,
          unlimited_quota: true, model_limits_enabled: false, model_limits: '',
          allow_ips: '', group, auto_groups: [], cross_group_retry: group === 'auto',
        },
      })
      state.keyId = key.id
    },
    async balance() {
      if (demo) return state.balance
      await this.session()
      const payload = await this.request('/api/user/self')
      const quota = Number(payload.data?.quota)
      return Number.isFinite(quota) ? quota / 500000 : 0
    },
    async usage(range) {
      if (demo) return state.live ? DEMO_USAGE[range] : EMPTY_USAGE
      await this.session()
      const days = { today: 1, '3d': 3, '7d': 7, month: 30 }
      const start = days[range] ? Math.floor(Date.now() / 1000) - days[range] * 86400 : 0
      const callsByDay = new Map()
      let calls = 0
      let tokens = 0
      let quota = 0
      let hasQuota = true
      for (let page = 1; page <= 100; page += 1) {
        const params = new URLSearchParams({ token_name: KEY_NAME, p: String(page), size: '100' })
        if (start) params.set('start_timestamp', String(start))
        const payload = await this.request(`/api/log/self?${params}`)
        const rows = Array.isArray(payload.data) ? payload.data
          : payload.data?.items || payload.data?.logs || []
        if (!rows.length) break
        for (const row of rows) {
          if (Number(row?.type) !== 2) continue
          calls += 1
          if (row.quota === undefined || row.quota === null || row.quota === '') hasQuota = false
          else quota += Number(row.quota) || 0
          tokens += Number(row.total_tokens ?? row.tokens ?? 0) ||
            Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0)
          const rawTime = row.timestamp ?? row.created_at ?? row.createdAt
          const date = rawTime ? new Date(typeof rawTime === 'number' ? rawTime * 1000 : rawTime) : null
          if (date && !Number.isNaN(date.getTime())) {
            const key = date.toISOString().slice(0, 10)
            callsByDay.set(key, (callsByDay.get(key) || 0) + 1)
          }
        }
        if (rows.length < 100) break
      }
      const ordered = [...callsByDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      return {
        calls, tokens, spent: hasQuota ? Math.abs(quota) / 500000 : null,
        callsByDay: ordered.map(([, value]) => value),
      }
    },
    async week() {
      const usage = await this.usage('7d')
      return { calls: usage.callsByDay || [], spent: usage.spent }
    },
  }

  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem('ys.start.' + k)) ?? d } catch { return d } },
    set: (k, v) => localStorage.setItem('ys.start.' + k, JSON.stringify(v)),
  }
  const KEEP = ['live', 'vendor', 'use', 'model', 'group', 'balance', 'keyId', ...(demo ? ['key'] : []), 'scene', 'accessOpen']
  if (!demo) localStorage.removeItem('ys.start.key')
  const state = Object.assign({
    live: false, vendor: null, use: null, model: null, group: null, balance: 5,
    keyId: null, key: null, userId: null, scene: 'qa', accessOpen: false,
  },
    Object.fromEntries(KEEP.map((k) => [k, store.get(k, undefined)]).filter(([, v]) => v !== undefined)))
  const save = () => KEEP.forEach((k) => store.set(k, state[k]))

  // ---------- 价格 ----------
  let P = null // { models, groups }
  function loadPricing(raw) {
    const usable = raw.usable_group || {}
    const ratio = raw.group_ratio || {}
    const groups = Object.keys(usable).filter((g) => g in ratio).map((g) => ({ id: g, ratio: ratio[g], desc: usable[g] }))
    const models = raw.data
      .filter((m) => !(m.quota_type === 1 && m.model_price > 0)) // 按次计费的图片 / 视频
      .filter((m) => m.billing_expr || m.model_ratio > 0) // 没定价的（如 gpt-reserve）不展示
      .map((m) => ({ ...m, vendor: VENDORS.find((v) => v.re.test(m.model_name))?.id, groups: m.enable_groups.filter((g) => g in usable && ratio[g] > 0) }))
      .filter((m) => m.vendor && m.groups.length)
    P = { models, groups, version: raw.pricing_version }
  }
  // 一次调用多少美元（= 元，站内 1:1），不含分组倍率
  function baseCost(m, s) {
    const fresh = s.in - s.cached
    if (m.billing_expr) {
      const tier = m.billing_expr.match(/tier\("[^"]*",\s*([^)]+)\)/)[1] // 第一档（短上下文）
      const k = (name) => +((tier.match(new RegExp(`\\b${name}\\s*\\*\\s*([\\d.]+)`)) || [])[1] || 0)
      return (fresh * k('p') + s.out * k('c') + s.cached * (k('cr') || k('p'))) / 1e6
    }
    const inPrice = m.model_ratio * 2 // 美元 / 百万 token
    return (fresh * inPrice + s.out * inPrice * m.completion_ratio + s.cached * inPrice * 0.1) / 1e6
  }
  const groupRatio = (g) => P.groups.find((x) => x.id === g)?.ratio ?? 1
  const costOf = (m, g = state.group, s = scene()) => baseCost(m, s) * groupRatio(g)
  const scene = () => SCENES.find((s) => s.id === state.scene) || SCENES[1]
  const vendorOf = (id) => VENDORS.find((v) => v.id === id)
  const modelsOf = (vendor, group) => P.models.filter((m) => m.vendor === vendor && (!group || m.groups.includes(group)))
  const groupsOf = (vendor) => P.groups.filter((g) => modelsOf(vendor, g.id).length)
  function defaults(vendor, preferredGroup = null) {
    const v = vendorOf(vendor)
    const gs = groupsOf(vendor)
    const group = gs.find((g) => g.id === preferredGroup)?.id ||
      gs.find((g) => g.id === v.group)?.id ||
      [...gs].sort((a, b) => b.ratio - a.ratio)[0]?.id
    const ms = modelsOf(vendor, group)
    const model = ms.find((m) => m.model_name === v.model)?.model_name || ms.sort((a, b) => costOf(a, group) - costOf(b, group))[0]?.model_name
    return { group, model }
  }

  // ---------- Q&A ----------
  function paintVendors(box, current, onPick) {
    box.innerHTML = VENDORS.map((v) => {
      const gs = groupsOf(v.id)
      const ms = P.models.filter((m) => m.vendor === v.id)
      const cheapest = ms.length ? Math.min(...ms.map((m) => Math.min(...m.groups.map((g) => costOf(m, g, SCENES[1]))))) : 0
      const off = !ms.length
      return `<button class="vendor${v.id === current ? ' is-on' : ''}${off ? ' is-off' : ''}" role="radio" aria-checked="${v.id === current}" data-vendor="${v.id}" ${off ? 'disabled' : ''}>
        <span class="vendor__mono" data-v="${v.id}">${v.mono}</span>
        <b>${v.name}</b><span class="vendor__by">${v.by}</span>
        <span class="vendor__meta">${off ? '暂未上架' : `${ms.length} 个模型 · ${v.blurb}`}</span>
        ${off ? '' : `<span class="vendor__price">日常问答 ${price(cheapest)} 起</span>`}
      </button>`
    }).join('')
    $$('[data-vendor]', box).forEach((b) => b.addEventListener('click', () => onPick(b.dataset.vendor)))
  }
  function pickVendor(id) {
    state.vendor = id
    Object.assign(state, defaults(id))
    state.use ||= id === 'claude' ? 'claude-code' : id === 'openai' ? 'codex' : 'chat'
    $$('.js-vendors .vendor').forEach((b) => { b.classList.toggle('is-on', b.dataset.vendor === id); b.setAttribute('aria-checked', b.dataset.vendor === id) })
    $('.ask').classList.add('has-vendor')
    $('.ask__q2').hidden = false
    paintUses()
    paintAskSum()
  }
  function paintUses() {
    $('.js-uses').innerHTML = USES.map((u) => `<button class="use${u.id === state.use ? ' is-on' : ''}" role="radio" aria-checked="${u.id === state.use}" data-use="${u.id}"><b>${u.name}</b><span>${u.hint}</span></button>`).join('')
    $$('[data-use]').forEach((b) => b.addEventListener('click', () => {
      state.use = b.dataset.use
      $$('.use').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', x === b) })
      paintAskSum()
    }))
  }
  function paintAskSum() {
    $('.ask__go').hidden = false
    const v = vendorOf(state.vendor)
    const u = USES.find((x) => x.id === state.use)
    const mismatch = (state.use === 'codex' && state.vendor !== 'openai') || (state.use === 'claude-code' && state.vendor !== 'claude')
    $('.js-ask-sum').innerHTML = `将创建一个 <b>${v.name}</b> 的 Key，线路 <b>${state.group}</b>，默认模型 <code>${state.model}</code>，用在 <b>${u.name}</b>。`
      + (mismatch ? `<br><span class="warn">${u.name} 主要配合 ${state.use === 'codex' ? 'GPT' : 'Claude'} 使用，选别家的模型可能用不了。</span>` : '')
  }
  $('.js-make-key').addEventListener('click', async (e) => {
    const b = e.currentTarget
    b.disabled = true
    b.textContent = '正在生成…'
    try {
      state.key = await api.createKey()
      save()
      await collapseAsk()
      showReady({ fresh: true })
    } catch (error) {
      if (error.message !== 'AUTH_REQUIRED') toast('API Key 暂时没有生成成功，请稍后重试')
      b.disabled = false
      b.textContent = '生成我的 API Key'
    }
  })
  async function collapseAsk() {
    const a = $('.ask')
    if (reduced) { a.hidden = true; return }
    a.style.height = a.offsetHeight + 'px'
    a.classList.add('is-closing')
    await new Promise((r) => requestAnimationFrame(r))
    a.style.height = '0px'
    await wait(450)
    a.hidden = true
    a.classList.remove('is-closing')
    a.style.height = ''
  }

  // ---------- 首页 ----------
  const keyEl = $('.js-key')
  const mask = (k) => k.slice(0, 5) + '•'.repeat(6) + k.slice(-4)
  const renderKey = () => (keyEl.textContent = keyEl.dataset.masked === '1' ? mask(state.key) : state.key)
  async function scramble(el, final) {
    if (reduced) { el.textContent = final; return }
    const pool = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    for (let f = 0; f <= 22; f++) {
      el.textContent = [...final].map((c, i) => (i < (f / 22) * final.length || c === '•' ? c : pool[(Math.random() * pool.length) | 0])).join('')
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 24)))
    }
    el.textContent = final
  }
  $('.eye').addEventListener('click', (e) => {
    keyEl.dataset.masked = keyEl.dataset.masked === '1' ? '0' : '1'
    e.currentTarget.textContent = keyEl.dataset.masked === '1' ? '显示' : '隐藏'
    renderKey()
  })
  function countUp(el, to, { dec = 0, ms = 900 } = {}) {
    if (reduced) { el.textContent = fmt(to, dec); return }
    const from = parseFloat(el.textContent.replace(/,/g, '')) || 0
    const t0 = performance.now()
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / ms)
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 4)), dec)
      if (k < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  async function showReady({ fresh = false } = {}) {
    $('.ask').hidden = true
    $('.ready').hidden = false
    paintAccess()
    paintHub()
    watchFirstRequest()
    if (fresh) { keyEl.classList.add('is-decoding'); await scramble(keyEl, mask(state.key)); keyEl.classList.remove('is-decoding') }
    else renderKey()
  }

  function paintAccess() {
    const u = USES.find((x) => x.id === state.use) || USES[0]
    $('.js-app-name').textContent = u.app
    $('.js-group-tag').textContent = `${vendorOf(state.vendor).name} · ${state.group}`
    $$('.js-model-inline').forEach((el) => (el.textContent = state.model))
    const claude = state.use === 'claude-code'
    $('.js-base').textContent = claude ? ORIGIN : ORIGIN + '/v1'
    const key = state.key || 'sk-你的Key'
    const rootConfig = [
      `<span class="k">model_provider</span> = <span class="s">"yisama"</span>`,
      `<span class="k">model</span> = <span class="s">"${state.model}"</span>`]
    const providerConfig = [
      `<span class="h">[model_providers.yisama]</span>`,
      `<span class="k">name</span> = <span class="s">"yisama"</span>`,
      `<span class="k">base_url</span> = <span class="s">"${ORIGIN}/v1"</span>`,
      `<span class="k">wire_api</span> = <span class="s">"responses"</span>`,
      `<span class="k">env_key</span> = <span class="s">"YISAMA_API_KEY"</span>`]
    const codexConfig = [...rootConfig, '', ...providerConfig]
    const sn = {
      codex: { title: 'Codex 配置片段', file: 'config.toml', note: '仅供新文件使用；已有配置请按下方教程合并，不要直接追加。Key 使用环境变量 YISAMA_API_KEY。', code: codexConfig },
      'claude-code': { title: 'Claude Code 环境变量', file: 'PowerShell', note: '运行后重新打开终端，再输入 claude', code: [
        `<span class="k">setx</span> ANTHROPIC_BASE_URL <span class="s">"${ORIGIN}"</span>`,
        `<span class="k">setx</span> ANTHROPIC_AUTH_TOKEN <span class="s">"${key}"</span>`,
        `<span class="k">setx</span> ANTHROPIC_MODEL <span class="s">"${state.model}"</span>`] },
      code: { title: '调用示例', file: 'curl', note: 'OpenAI SDK 也一样：改 base_url 和 api_key 即可', code: [
        `curl ${ORIGIN}/v1/chat/completions \\`,
        `  -H <span class="s">"Authorization: Bearer ${key}"</span> \\`,
        `  -H <span class="s">"Content-Type: application/json"</span> \\`,
        `  -d <span class="s">'{"model":"${state.model}","messages":[{"role":"user","content":"hi"}]}'</span>`] },
    }[state.use]
    $('.js-snippet').hidden = !sn
    if (sn) {
      $('.js-snippet-title').textContent = sn.title
      $('.js-snippet-file').textContent = sn.file
      $('.js-snippet-note').textContent = sn.note
      $$('.js-toml').forEach((el) => (el.innerHTML = sn.code.join('\n')))
    }
    $$('.guide .js-toml').forEach((el) => (el.innerHTML = codexConfig.join('\n')))
    $('.js-root-toml').innerHTML = rootConfig.join('\n')
    $('.js-provider-toml').innerHTML = providerConfig.join('\n')
    $('.js-setx').textContent = `setx YISAMA_API_KEY "${key}"`
    // 无限助手、Codex 教程只对 Codex 有意义
    const codex = state.use === 'codex'
    $('[data-assist]').hidden = !codex
    $('.help').hidden = !codex
    paintAccessFold()
  }

  // 接通之后接入信息只留 Key 一行，其余收起；还没接通时全部展开
  function paintAccessFold() {
    const folded = state.live && !state.accessOpen
    $('.access').classList.toggle('is-folded', folded)
    const t = $('.js-access-toggle')
    t.hidden = !state.live
    t.setAttribute('aria-expanded', String(!folded))
    t.textContent = folded ? '地址和教程 ›' : '收起'
  }
  $('.js-access-toggle').addEventListener('click', () => { state.accessOpen = !state.accessOpen; save(); paintAccessFold() })

  function paintConn() {
    const u = USES.find((x) => x.id === state.use) || USES[0]
    // 英文名两边留空格，中文名不留：“填进 Codex”“填进聊天软件”
    const name = /^[A-Za-z]/.test(u.short) ? ` ${u.short} ` : u.short
    const low = state.balance < 2
    $('.status').dataset.state = !state.live ? 'new' : low ? 'low' : 'ok'
    $('.js-badge-text').textContent = !state.live ? '未接通' : low ? '余额不多' : '一切正常'
    $('.ready').classList.toggle('is-new', !state.live)
    $('.conn').classList.toggle('is-live', state.live)
    $('.js-headline').textContent = !state.live ? `还差一步：把 Key 填进${name}`.trimEnd() : low ? '余额快用完了' : `你的${name}可以正常使用`
    $('.js-step2').textContent = u.step2
    $('.js-step3').textContent = u.step3
    $('.js-step2-tip').textContent = u.tip
    $('.js-step2-tip').hidden = !u.tip
    $('.js-conn-state').textContent = !state.live
      ? `按下面 3 步来，最后在${name}里发一句话就算通了。`
      : low ? '用完后会直接报错停止，不会欠费。充值后马上就能继续用。' : '直接打开它用就行，这里只看余额和用量。'
    $('.js-assist-title').textContent = state.live ? '无限助手：让 Codex 更快更强' : '嫌麻烦？无限助手帮你一键配好'
  }

  // 这些钱大约能调用：每个模型一根条（对数刻度：便宜和贵的能差上千倍）
  let showAll = false
  // 热门模型始终显示，其余收起
  const HOT = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'deepseek-v4.1-flash', 'deepseek-v4-pro-0813', 'glm-5.3', 'kimi-k3', 'qwen3.8-max']
  function paintScenes() {
    $('.js-scenes').innerHTML = SCENES.map((s) => `<button class="scene__b${s.id === state.scene ? ' is-on' : ''}" role="radio" aria-checked="${s.id === state.scene}" data-scene="${s.id}">${s.name}</button>`).join('')
    $$('[data-scene]').forEach((b) => b.addEventListener('click', () => { state.scene = b.dataset.scene; save(); paintScenes(); paintReach(state.balance) }))
    const s = scene()
    $('.js-scene-desc').innerHTML = `${s.desc} <span class="q" tabindex="0" data-tip="按每次约输入 ${short(s.in)} + 输出 ${short(s.out)} 个 Token 估算">?</span>`
  }
  function paintReach(bal) {
    const rows = modelsOf(state.vendor, state.group)
      .map((m) => ({ id: m.model_name, cost: costOf(m), calls: Math.floor(bal / costOf(m)) }))
      .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id))
    const shown = showAll ? rows : rows.filter((r) => HOT.includes(r.id) || r.id === state.model)
    const top = Math.log10(Math.max(10, rows[0]?.calls || 10) + 1)
    $('.js-reach').innerHTML = shown.map((r, i) => {
      const w = r.calls < 1 ? 0 : Math.max(3, (Math.log10(r.calls + 1) / top) * 100)
      const mine = r.id === state.model
      return `<li class="${mine ? 'is-mine' : ''}${r.calls < 1 ? ' is-zero' : ''}" style="--w:${w}%;--d:${i * 50}ms" data-model="${r.id}" title="点一下设为默认模型">
        <span class="reach__name">${r.id}${mine ? '<em>当前</em>' : ''}</span>
        <span class="reach__n">${r.calls < 1 ? '不够一次' : '约 ' + short(r.calls) + ' 次'}</span>
        <span class="reach__bar"><i></i></span>
        <small>${price(r.cost)}</small>
      </li>`
    }).join('')
    $$('.js-reach li').forEach((li) => li.addEventListener('click', () => setModel(li.dataset.model)))
    const more = $('.js-reach-more')
    const hidden = rows.length - shown.length
    more.hidden = !hidden && !showAll
    more.textContent = showAll ? '收起' : `展开其余 ${hidden} 个模型`
    $('.js-reach-foot').textContent = `按当前价格实时计算（线路 ${state.group} ×${groupRatio(state.group)}）。价格变了这里会自动跟着变；实际花费随内容长短浮动。`
    const mine = rows.find((r) => r.id === state.model)
    $('.js-reach-peek').textContent = `${rows.length} 个模型`
    $('.js-balance-hint').innerHTML = mine
      ? (mine.calls < 1 ? '不够用一次了，充点值吧' : `够${scene().name}约 <b>${short(mine.calls)} 次</b> <span class="q" tabindex="0" data-tip="按当前模型 ${state.model} 估算，换模型请点下面“换个模型”">?</span>`)
      : ''
  }
  $('.js-reach-more').addEventListener('click', () => { showAll = !showAll; paintReach(state.balance) })

  function amtHint(a) {
    const m = P.models.find((x) => x.model_name === state.model)
    return m ? `${scene().name} 约 ${short(Math.floor(a / costOf(m)))} 次` : ''
  }

  let usageRange = 'today'
  // Token 用中文单位：1.84 万、224 万，比 18.4K / 2.2M 好懂
  const tokenParts = (n) => {
    const [v, unit] = n >= 1e8 ? [n / 1e8, '亿'] : n >= 1e4 ? [n / 1e4, '万'] : [n, '']
    return [unit ? (+v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)).toString() : fmt(v), unit]
  }
  async function paintUsage(data = null) {
    data ||= await api.usage(usageRange)
    const hasUsage = data.calls > 0 || data.tokens > 0
    $('.meter--usage').classList.toggle('is-empty', !hasUsage)
    $('.js-week-cost').textContent = hasUsage
      ? (data.spent == null ? '花费待同步' : `已扣费 ¥${fmt(data.spent, 2)}`)
      : ''
    const [num, unit] = tokenParts(data.tokens)
    $('.js-token-total').innerHTML = hasUsage ? [...num].map((c) => `<i${/\d/.test(c) ? '' : ' class="sep"'}>${c}</i>`).join('') : '—'
    $('.js-token-unit').textContent = hasUsage && unit ? unit + ' ' : ''
    $('.js-call-total').textContent = fmt(data.calls)
    $('.js-token-feel').textContent = hasUsage ? tokenFeel(data.tokens) : '还没开始用。调用之后这里会累计。'
    $('.js-usage-meta').hidden = !hasUsage
  }
  // 把 Token 换成能感受到的量：1 Token ≈ 0.75 个汉字
  function tokenFeel(tokens) {
    const chars = Math.round(tokens * 0.75)
    const [size, unit] = [[900000, '套《三体》'], [200000, '本长篇小说'], [8000, '篇论文'], [800, '篇作文']].find(([n]) => chars >= n * .5) || [800, '篇作文']
    const n = chars / size
    return `≈ ${short(chars)}字，约 ${fmt(n, n >= 10 ? 0 : 1)} ${unit}`
  }

  $$('[data-usage-range]').forEach((button) => button.addEventListener('click', async () => {
    usageRange = button.dataset.usageRange
    $$('[data-usage-range]').forEach((item) => {
      const active = item === button
      item.classList.toggle('is-on', active)
      item.setAttribute('aria-selected', active)
    })
    await paintUsage()
  }))

  async function paintHub() {
    paintConn()
    paintAccessFold()
    paintScenes()
    try {
      const [bal, usage] = await Promise.all([api.balance(), api.usage(usageRange)])
      state.balance = bal
      if (!demo) save()
      countUp($('.js-balance'), bal, { dec: 2, ms: 1100 })
      paintReach(bal)
      $('.meter--balance').classList.toggle('is-low', bal < 2)
      paintConn()
      $('.js-low').hidden = bal >= 2
      $$('.amt').forEach((b) => (b.querySelector('span').textContent = amtHint(+b.dataset.amt)))
      await paintUsage(usage)
    } catch (error) {
      if (error.message !== 'AUTH_REQUIRED') toast('余额和用量暂时没读出来，请刷新重试')
    }
  }

  function setModel(id) {
    if (id === state.model) return
    state.model = id
    save()
    paintAccess()
    paintReach(state.balance)
    paintSettings()
    toast(`默认模型换成 ${id}，记得在软件里也改一下模型名`)
  }

  // ---------- 视图切换 ----------
  async function showView(name) {
    const from = name === 'guide' ? $('#hub') : $('#guide')
    const to = name === 'guide' ? $('#guide') : $('#hub')
    if (!from.hidden && !reduced) { from.classList.add('is-leaving'); await wait(220); from.classList.remove('is-leaving') }
    from.hidden = true
    to.hidden = false
    scrollTo({ top: 0, behavior: 'instant' })
    if (name === 'hub') paintHub()
  }
  $$('[data-home]').forEach((b) => b.addEventListener('click', () => showView('hub')))
  $$('[data-guide]').forEach((b) => b.addEventListener('click', () => { pickCodex(b.dataset.guide); showView('guide'); go(0, { instant: true }) }))
  $('[data-assist]').addEventListener('click', (e) => { e.preventDefault(); toast('真实版本这里下载 Yisama-Setup.exe') })

  // ---------- 教程 ----------
  let kind = 'cli'
  let step = 0
  const rail = $('.rail')
  function pickCodex(value) {
    kind = value
    $$('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.pick === kind))
    $$('[data-install]').forEach((el) => (el.hidden = el.dataset.install !== kind))
    $('.js-install-next').textContent = kind === 'cli' ? '我已看到 Codex 版本号，继续' : '我已能打开 Codex 桌面版，继续'
  }
  function paintRail(s) {
    document.documentElement.style.setProperty('--progress', Math.min(s, 3) / 3)
    $$('.station').forEach((el, i) => { el.classList.toggle('is-done', i < s); el.classList.toggle('is-current', i === s) })
    $('.rail__end').classList.toggle('is-on', s >= 3)
    rail.classList.toggle('is-listening', s === 2)
  }
  async function go(s, { instant = false } = {}) {
    const cur = $('.step:not([hidden])')
    const next = $(`.step[data-step="${s}"]`)
    if (cur && cur !== next && !instant && !reduced) { cur.classList.add('is-leaving'); await wait(260); cur.classList.remove('is-leaving') }
    $$('.step').forEach((el) => (el.hidden = el !== next))
    $('.stage').scrollTop = 0
    step = s
    paintRail(s)
    if (s === 1) {
      const desk = kind === 'desktop'
      $('.js-cfg-title').textContent = desk ? '把它填进 Codex 桌面版' : '把它填进 Codex CLI'
      $('.js-desk-note').hidden = !desk
    }
    if (s === 2) {
      $('.js-ask-title').textContent = kind === 'desktop' ? '打开 Codex 桌面版，随便问它一句话' : '在 PowerShell 里输入 codex，随便问它一句话'
      $('.listen').classList.remove('is-got')
      $('.js-listen-state').textContent = '正在等你的第一句话…'
    }
  }
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => pickCodex(b.dataset.pick)))
  $$('[data-next]').forEach((b) => b.addEventListener('click', () => go(step + 1)))
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => go(step - 1)))

  const typed = $('.typed')
  ;(async function typeLoop() {
    const t = typed.dataset.text
    if (reduced) { typed.textContent = t; return }
    for (;;) {
      for (let i = 0; i <= t.length; i++) { typed.textContent = t.slice(0, i); await wait(140) }
      await wait(1800)
      typed.textContent = ''
      await wait(500)
    }
  })()

  // ---------- 第一次调用（真实版本：每 3 秒查一次这个 Key 的日志） ----------
  async function gotFirstRequest() {
    const wasLive = state.live
    state.live = true
    save()
    if (!$('#guide').hidden && step === 2) {
      $('.listen').classList.add('is-got')
      $('.js-listen-state').textContent = '收到了！'
      rail.classList.remove('is-listening')
      rail.classList.add('is-firing')
      for (let i = 0; i < 3; i++) { await wait(300); $$('.station')[i].classList.add('is-done') }
      await wait(250)
      $('.rail__end').classList.add('is-on')
      document.documentElement.style.setProperty('--progress', 1)
      await wait(500)
      rail.classList.remove('is-firing')
      $('.js-latency').textContent = (0.8 + Math.random()).toFixed(1) + 's'
      go(3)
      return
    }
    if (!$('.ready').hidden && !wasLive) {
      const c = $('.status')
      c.classList.add('is-firing')
      paintHub()
      await wait(1200)
      c.classList.remove('is-firing')
      toast('收到你的第一次调用，已连通')
    }
  }

  function watchFirstRequest() {
    if (demo || state.live || firstRequestTimer) return
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        if ((await api.usage('all')).calls > 0) {
          clearInterval(firstRequestTimer)
          firstRequestTimer = null
          await gotFirstRequest()
        }
      } catch {
        // The regular balance refresh will show a visible error if the session is no longer valid.
      } finally {
        checking = false
      }
    }
    firstRequestTimer = setInterval(check, 3000)
    check()
  }

  // ---------- 复制 ----------
  $$('.copy').forEach((b) => b.addEventListener('click', async () => {
    const text = b.hasAttribute('data-copy-key') ? state.key : (b.closest('.snippet, .cmd, .cred, li, .fine') || document).querySelector(b.dataset.copy)?.textContent
    if (!text) return
    const was = b.textContent
    b.disabled = true
    try {
      await navigator.clipboard.writeText(text)
      b.classList.add('is-copied')
      b.textContent = '已复制'
    } catch {
      b.textContent = '复制失败'
      toast('复制失败，请选中内容后手动复制')
    }
    setTimeout(() => { b.classList.remove('is-copied'); b.textContent = was; b.disabled = false }, 1400)
  }))

  // ---------- 弹层 ----------
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.open === 'settings') paintSettings(); $('#' + b.dataset.open).showModal() }))
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'gate') d.close() }))

  const gate = $('#gate')
  gate.addEventListener('cancel', (e) => e.preventDefault())
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    store.set('mode', b.dataset.mode)
    if (b.dataset.mode === 'pro') {
      location.assign('/console')
      return
    }
    gate.close()
  }))
  $('[data-mode-switch="pro"]').addEventListener('click', () => store.set('mode', 'pro'))

  // 充值（真实版本：POST /api/user/pay → 支付宝 → 回到 /start/?paid=1 后轮询余额）
  let amt = 30
  $('.js-amounts').innerHTML = [10, 30, 50, 100].map((a) => `<button class="amt${a === amt ? ' is-on' : ''}" data-amt="${a}"><b>¥${a}</b><span></span></button>`).join('')
  function pick(a) {
    amt = a
    $$('.amt').forEach((x) => x.classList.toggle('is-on', +x.dataset.amt === a))
    $('.js-pay-amt').textContent = a
  }
  $$('.amt').forEach((b) => b.addEventListener('click', () => { $('.js-custom').value = ''; pick(+b.dataset.amt) }))
  $('.js-custom').addEventListener('input', (e) => { const v = Math.floor(+e.target.value); if (v >= 1) pick(v) })
  $('.js-pay').addEventListener('click', async () => {
    $('.js-paid').textContent = amt
    $('.paid').hidden = false
    state.balance += amt
    save()
    await wait(1600)
    $('.paid').hidden = true
    $('#topup').close()
    paintHub()
  })
  $('.js-redeem').addEventListener('click', () => toast('兑换码会调用 /api/user/topup'))

  // 设置：厂商 / 模型 / 线路，全部来自价格表
  function paintSettings() {
    if (!state.vendor) return
    paintVendors($('.js-set-vendors'), state.vendor, async (id) => {
      if (id === state.vendor) return
      state.vendor = id
      Object.assign(state, defaults(id))
      // Codex 只配 GPT，Claude Code 只配 Claude；换厂商后用途跟着换成合适的
      if (state.use === 'codex' && id !== 'openai') state.use = id === 'claude' ? 'claude-code' : 'chat'
      if (state.use === 'claude-code' && id !== 'claude') state.use = id === 'openai' ? 'codex' : 'chat'
      await api.setGroup(state.group)
      afterSettingChange(`换成 ${vendorOf(id).name}，线路 ${state.group}，Key 不变`)
    })
    $('.js-set-models').innerHTML = modelsOf(state.vendor, state.group)
      .map((m) => ({ id: m.model_name, cost: costOf(m, state.group, SCENES[1]) }))
      .sort((a, b) => a.cost - b.cost)
      .map((m) => `<label class="opt"><input type="radio" name="model" value="${m.id}" ${m.id === state.model ? 'checked' : ''} /><span><b>${m.id}</b><small>日常问答 ${price(m.cost)}</small></span></label>`).join('')
    $('.js-set-groups').innerHTML = groupsOf(state.vendor)
      .map((g) => `<label class="opt"><input type="radio" name="group" value="${g.id}" ${g.id === state.group ? 'checked' : ''} /><span><b>${g.id}</b><small>倍率 ×${g.ratio}${g.desc ? ' · ' + g.desc : ''}</small></span></label>`).join('')
  }
  $('#settings').addEventListener('change', async (e) => {
    if (e.target.name === 'model') { setModel(e.target.value); return }
    if (e.target.name === 'group') {
      state.group = e.target.value
      if (!modelsOf(state.vendor, state.group).some((m) => m.model_name === state.model)) state.model = defaults(state.vendor).model
      await api.setGroup(state.group)
      afterSettingChange(`线路换成 ${state.group}，Key 不变`)
    }
  })
  function afterSettingChange(msg) {
    save()
    showAll = false
    paintSettings()
    paintAccess()
    paintHub()
    toast(msg)
  }

  async function restoreFormalState() {
    const user = await api.session()
    if (!user) return false
    const key = await api.findKey()
    if (!key?.id) return false
    state.keyId = key.id
    state.group = key.group || state.group
    const currentModel = state.model
    const currentVendor = state.vendor
    const vendor = currentVendor && modelsOf(currentVendor, state.group).length
      ? currentVendor
      : VENDORS.find((item) => currentModel && modelsOf(item.id, state.group).some((model) => model.model_name === currentModel))?.id ||
        VENDORS.find((item) => modelsOf(item.id, state.group).length)?.id
    if (!vendor) return false
    state.vendor = vendor
    const preferred = defaults(vendor, state.group)
    state.group = state.group || preferred.group
    if (!modelsOf(vendor, state.group).some((model) => model.model_name === state.model)) state.model = preferred.model
    state.use ||= vendor === 'claude' ? 'claude-code' : vendor === 'openai' ? 'codex' : 'chat'
    state.key = await api.readKey(key)
    save()
    return true
  }

  let toastTimer
  function toast(msg) {
    const t = $('.toast')
    t.textContent = msg
    t.classList.add('is-on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600)
  }

  // ---------- 原型控制条 ----------
  $('.demo').hidden = !new URLSearchParams(location.search).has('demo')
  $('.demo').addEventListener('click', (e) => {
    const a = e.target.dataset.demo
    if (a === 'gate') gate.showModal()
    if (a === 'reset') { localStorage.clear(); location.reload() }
    if (a === 'ping') gotFirstRequest()
    if (a === 'low') { state.balance = 0.6; save(); paintHub() }
  })

  // ---------- 启动 ----------
  ;(async () => {
    try {
      loadPricing(await api.pricing())
      if (!store.get('mode')) gate.showModal()
      const restored = demo
        ? Boolean(state.key && state.vendor)
        : await restoreFormalState()
      if (restored) { showReady(); return }
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') return
      toast('页面数据暂时没加载成功，请刷新重试')
    }
    $('.ready').hidden = true
    $('.ask').hidden = false
    paintVendors($('.js-vendors'), state.vendor, pickVendor)
  })()
})()
