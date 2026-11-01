import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { REMOVE_ASSISTANT_SCRIPT, installAssistantUI, makeAssistantScript } from './codex-panel.mjs'
import { syncNativeModels } from './codex-assistant.mjs'

const output = fileURLToPath(new URL('../output/playwright/', import.meta.url))

const loggedOut = {
  loggedIn: false, configured: false, username: '', quota: '', group: '', groupLabel: '', groups: [], model: '', models: [],
  message: '', restartRequired: false,
}
const authOptions = (overrides = {}) => ({ auth: {
  passwordLoginEnabled: true, registrationEnabled: true, emailVerificationEnabled: false, ...overrides,
} })
const signedIn = (overrides = {}) => ({
  loggedIn: true,
  configured: true,
  username: 'demo-user',
  quota: '$12.50',
  group: 'auto',
  groupLabel: 'All',
  groups: [{ value: 'auto', label: 'All' }, { value: 'premium', label: 'premium' }],
  model: 'gpt-5-codex',
  models: ['gpt-5-codex', 'gpt-5'],
  message: '已准备就绪',
  restartRequired: false,
  ...overrides,
})

async function fixture(t, viewport = { width: 1280, height: 800 }, options = {}) {
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.YISAMA_TEST_BROWSER || undefined })
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`)
    return null
  }
  const page = await browser.newPage({ viewport })
  const commands = []
  await page.exposeFunction('yisamaAssistantCommand', (serialized) => {
    commands.push(JSON.parse(serialized))
  })
  await page.route('http://assistant.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<main id="codex-wallpaper-engine-skin-controls"><span data-wallpaper-sentinel="keep">wallpaper sentinel</span></main>',
  }))
  await page.goto('http://assistant.test/')
  await page.evaluate(installAssistantUI, { allowTestLocation: true, ...options })
  t.after(async () => { await browser.close() })
  const next = async (action) => {
    for (let index = 0; index < 80; index += 1) {
      const command = commands.find((item) => item.action === action && !item.used)
      if (command) {
        command.used = true
        return command
      }
      await page.waitForTimeout(10)
    }
    assert.fail(`Expected ${action} command`)
  }
  const respond = (command, response) => page.evaluate((payload) => window.__yisamaInfiniteAssistant.receive(payload), {
    id: command.id,
    ...response,
  })
  const open = async (data) => {
    await page.locator('[data-testid="assistant-badge"]').click()
    await respond(await next('status'), { ok: true, data })
  }
  return { page, commands, next, respond, open }
}

test('badge, sidebar actions, stale state, and screenshots', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  const initial = await next('status')
  await respond(initial, { ok: true, data: signedIn() })
  await assert.doesNotReject(page.locator('[data-testid="badge-balance"]').textContent())
  assert.match(await page.locator('[data-testid="badge-balance"]').textContent(), /\$12\.50/)
  assert.equal(await page.locator('[data-testid="badge-stale"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="assistant-badge"]').evaluate(
    (node) => getComputedStyle(node).webkitAppRegion,
  ), 'no-drag')
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-badge"]').screenshot({ path: path.join(output, 'assistant-badge.png') })

  await open(signedIn())
  await assert.doesNotReject(page.locator('[data-testid="assistant-panel"]').waitFor({ state: 'visible' }))
  assert.equal(await page.locator('[data-testid="username"]').textContent(), 'demo-user')
  assert.equal(await page.locator('[data-testid="logged-out"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="stale-note"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="model-select"]').count(), 0)
  assert.equal(await page.locator('[data-testid="apply-selection"]').isHidden(), true)
  assert.doesNotMatch(await page.locator('[data-testid="assistant-panel"]').textContent(), /应用模型/)
  await page.screenshot({ path: path.join(output, 'assistant-desktop.png') })
  await page.locator('[data-testid="assistant-panel"]').screenshot({ path: path.join(output, 'assistant-panel.png') })

  await page.locator('[data-testid="group-select"] [data-value="premium"]').click()
  const groupChange = await next('select')
  assert.deepEqual({ action: groupChange.action, group: groupChange.group, model: groupChange.model }, {
    action: 'select', group: 'premium', model: undefined,
  })
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('aria-disabled'), 'true')
  await respond(groupChange, { ok: true, data: signedIn({
    group: 'premium', groupLabel: 'premium', models: ['gpt-5.1'], model: 'gpt-5.1', restartRequired: true,
  }) })
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('data-value'), 'premium')
  assert.equal(await page.locator('[data-testid="apply-selection"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="restart-note"]').count(), 0)
  const selectedRow = page.locator('[data-testid="group-select"] [data-value="premium"]')
  assert.equal(await selectedRow.getAttribute('data-state'), 'pending')
  assert.match(await selectedRow.textContent(), /切换中/)
  await page.evaluate(() => window.__yisamaInfiniteAssistant.nativeStatus('synced'))
  assert.equal(await selectedRow.getAttribute('data-state'), 'current')
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().restartRequired), false)

  await page.waitForTimeout(600)
  const mainBox = await page.locator('[data-testid="assistant-panel"]').boundingBox()
  await page.locator('[data-testid="recharge"]').click()
  const recharge = await next('rechargeInfo')
  await respond(recharge, {
    ok: true,
    data: {
      paymentMethods: [{ name: '支付宝', type: 'alipay', minTopup: 1 }],
      minTopup: 1,
      currency: 'USD',
    },
  })
  assert.equal(await page.locator('[data-testid="recharge-amount"]').inputValue(), '')
  await page.locator('[data-testid="recharge-amount"]').fill('10')
  await page.locator('[data-testid="recharge-amount"]').dispatchEvent('change')
  const rechargeAmount = await next('rechargeAmount')
  await respond(rechargeAmount, { ok: true, data: { paymentAmount: 10 } })
  assert.equal(await page.locator('[data-testid="wallet-page"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="main-view"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="wallet-balance"]').textContent(), '$12.50')
  await page.waitForTimeout(600)
  const sameSize = async (label) => {
    const box = await page.locator('[data-testid="assistant-panel"]').boundingBox()
    assert.equal(box.width, mainBox.width, `${label} width`)
    assert.ok(Math.abs(box.height - mainBox.height) < 1, `${label} height ${box.height} vs ${mainBox.height}`)
  }
  await sameSize('wallet')
  assert.equal(await page.locator('[data-testid="redeem-pane"]').isHidden(), true)
  await page.locator('[data-testid="tab-redeem"]').click()
  assert.equal(await page.locator('[data-testid="recharge-panel"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="redeem-submit"]').isDisabled(), true)
  assert.equal(await page.locator('[data-testid="shop-link"]').getAttribute('href'), 'https://wzyp.cn/shop/IIIYMQU4')
  assert.equal(await page.locator('[data-testid="shop-link"]').getAttribute('target'), '_blank')
  await page.locator('[data-testid="redeem-code"]').fill('  YS-TEST-0001  ')
  await page.locator('[data-testid="redeem-submit"]').click()
  const redeem = await next('redeem')
  assert.equal(redeem.redeemCode, 'YS-TEST-0001')
  await respond(redeem, { ok: false, code: 'REDEEM_FAILED' })
  assert.match(await page.locator('[data-testid="wallet-message"]').textContent(), /兑换失败/)
  assert.equal(await page.locator('[data-testid="redeem-code"]').inputValue(), '  YS-TEST-0001  ')
  await page.locator('[data-testid="redeem-submit"]').click()
  await respond(await next('redeem'), { ok: true, data: signedIn({ quota: '$22.50' }) })
  assert.equal(await page.locator('[data-testid="redeem-code"]').inputValue(), '')
  assert.equal(await page.locator('[data-testid="wallet-balance"]').textContent(), '$22.50')
  assert.match(await page.locator('[data-testid="wallet-message"]').textContent(), /兑换成功/)
  await page.locator('[data-testid="tab-pay"]').click()
  await page.locator('[data-testid="wallet-back"]').click()
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: signedIn() })
  assert.equal(await page.locator('[data-testid="wallet-page"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="main-view"]').isVisible(), true)
  await sameSize('main again')
  await page.locator('[data-testid="help"]').click()
  assert.equal(await page.locator('[data-testid="qq-page"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="main-view"]').isHidden(), true)
  assert.match(await page.locator('[data-testid="qq-number"]').textContent(), /1125690897/)
  assert.equal(await page.locator('[data-testid="qq-image"]').evaluate((img) => img.complete && img.naturalWidth > 0), true)
  await page.waitForTimeout(500)
  await sameSize('qq')
  await page.locator('[data-testid="qq-back"]').click()
  assert.equal(await page.locator('[data-testid="main-view"]').isVisible(), true)
  await page.locator('[data-testid="refresh"]').click()
  const failedStatus = await next('status')
  await respond(failedStatus, { ok: false, error: 'Bearer sk-should-not-be-shown' })
  assert.match(await page.locator('[data-testid="badge-balance"]').textContent(), /\$12\.50/)
  assert.equal(await page.locator('[data-testid="badge-stale"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="badge-stale"]').getAttribute('title'), '余额可能已过期')
  assert.equal(await page.locator('[data-testid="stale-note"]').isVisible(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /无法刷新账户状态/)
  assert.doesNotMatch(await page.locator('[data-testid="message"]').textContent(), /sk-|Bearer/)
  assert.equal(await page.locator('[data-wallpaper-sentinel="keep"]').count(), 1)
})

test('login, restore confirmation, reinjection, dispose, and location guard', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond, open } = app
  const initial = await next('status')
  await respond(initial, { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(loggedOut)
  assert.equal(await page.locator('[data-testid="badge-balance"]').textContent(), '登录')
  await page.locator('[data-testid="auth-username"]').fill('demo')
  await page.locator('[data-testid="auth-password"]').fill('test-password')
  await page.locator('[data-testid="login"]').click()
  assert.equal(await page.locator('[data-testid="login"]').isDisabled(), true)
  await page.locator('[data-testid="login"]').dispatchEvent('click')
  const login = await next('login')
  assert.equal(login.username, 'demo')
  assert.equal(login.password, 'test-password')
  assert.equal(await page.locator('[data-testid="auth-password"]').inputValue(), '')
  assert.equal(commands.filter((command) => command.action === 'login').length, 1)
  await respond(login, { ok: true, data: signedIn() })
  await page.locator('[data-testid="restore"]').click()
  await assert.doesNotReject(page.locator('[data-testid="restore-confirmation"]').waitFor({ state: 'visible' }))
  await page.locator('[data-testid="confirm-restore"]').click()
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('aria-disabled'), 'true')
  const restore = await next('restore')
  await respond(restore, { ok: true, data: { ...loggedOut, restartRequired: true } })
  assert.equal(await page.locator('[data-testid="login"]').count(), 1)

  const before = commands.length
  await page.evaluate(installAssistantUI, { allowTestLocation: true })
  assert.equal(await page.locator('#yisama-infinite-assistant-ui').count(), 1)
  assert.equal(commands.length, before, 'reinjection reuses the existing runtime without a second status request')
  assert.match(REMOVE_ASSISTANT_SCRIPT, /window\.location\.href !== 'app:\/\/-\/index\.html'/)
  await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
  assert.equal(await page.locator('#yisama-infinite-assistant-ui').count(), 0)
  assert.equal(await page.locator('[data-wallpaper-sentinel="keep"]').count(), 1)
  await page.evaluate(installAssistantUI, { allowTestLocation: true })
  await next('status')
  await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
  assert.equal(await page.locator('#yisama-infinite-assistant-ui').count(), 0)

  const guard = await page.evaluate(makeAssistantScript())
  assert.equal(guard, null)
  assert.equal(await page.locator('#yisama-infinite-assistant-ui').count(), 0)
})

test('cached logged-in account can configure its only available group', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  const initial = await next('status')
  const unconfigured = signedIn({
    configured: false,
    group: 'auto',
    groupLabel: 'All',
    groups: [{ value: 'auto', label: 'All' }],
    model: '',
    models: [],
    message: '账户已登录',
  })
  await respond(initial, { ok: true, data: unconfigured })
  await open(unconfigured)
  assert.equal(await page.locator('[data-testid="login"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="apply-selection"]').textContent(), '使用此分组')
  assert.equal(await page.locator('[data-testid="apply-selection"]').isDisabled(), false)
  await page.locator('[data-testid="apply-selection"]').click()
  const configure = await next('select')
  assert.deepEqual({ action: configure.action, group: configure.group, model: configure.model }, {
    action: 'select', group: 'auto', model: undefined,
  })
  await respond(configure, { ok: true, data: signedIn({ restartRequired: true }) })
  assert.equal(await page.locator('[data-testid="apply-selection"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="model-select"]').count(), 0)
})

test('background refresh keeps controls available and cannot overwrite a newer selection', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.locator('[data-testid="refresh"]').click()
  const refresh = await next('status')
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('aria-disabled'), 'false')
  for (const testId of ['recharge', 'restore']) {
    assert.equal(await page.locator(`[data-testid="${testId}"]`).isDisabled(), false, `${testId} remains available during refresh`)
  }
  await page.locator('[data-testid="group-select"] [data-value="premium"]').click()
  const selection = await next('select')
  await respond(selection, { ok: true, data: signedIn({
    group: 'premium', groupLabel: 'premium', models: ['gpt-5.1'], model: 'gpt-5.1',
  }) })
  await respond(refresh, { ok: true, data: signedIn() })
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('data-value'), 'premium')
  assert.equal(await page.locator('[data-testid="model-select"]').count(), 0)
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-panel"]').screenshot({ path: path.join(output, 'assistant-refresh-race.png') })
})

test('opening refreshes account state and reuses an in-flight refresh without blocking controls', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await page.locator('[data-testid="assistant-badge"]').click()
  const refresh = await next('status')
  assert.match(await page.locator('[data-testid="panel-balance"]').textContent(), /\$12\.50/)
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('aria-disabled'), 'false')
  assert.equal(await page.locator('[data-testid="recharge"]').isDisabled(), false)
  await page.locator('[data-testid="close"]').click()
  await page.locator('[data-testid="assistant-badge"]').click()
  assert.equal(commands.filter((command) => command.action === 'status').length, 2)
  await respond(refresh, { ok: true, data: signedIn({
    quota: '$11.25', group: 'premium', groupLabel: 'premium',
  }) })
  assert.match(await page.locator('[data-testid="panel-balance"]').textContent(), /\$11\.25/)
  assert.match(await page.locator('[data-testid="badge-balance"]').textContent(), /\$11\.25/)
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('data-value'), 'premium')
  await page.locator('[data-testid="close"]').click()
  await page.locator('[data-testid="assistant-badge"]').click()
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$10.00' }) })
  assert.match(await page.locator('[data-testid="panel-balance"]').textContent(), /\$10\.00/)
  assert.equal(commands.filter((command) => command.action === 'status').length, 3)
  assert.equal(await page.locator('[data-testid="model-select"]').count(), 0)
  assert.equal(await page.locator('[data-testid="apply-selection"]').isHidden(), true)
})

test('native catalogs reload immediately without restarting or hiding a failed sync', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.evaluate(() => {
    const fixture = { active: true, restarts: 0, invalidations: 0, sequence: 0, models: ['gemini-3-flash'], methods: [] }
    window.nativeFixture = fixture
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `isolated-native-test-${++fixture.sequence}` })
    const queryClient = {
      getQueryCache() {},
      async invalidateQueries({ predicate }) {
        if (!predicate({ queryKey: ['models', 'list', 'local'] }) ||
          !predicate({ queryKey: ['config', 'local'] }) ||
          predicate({ queryKey: ['unrelated'] })) throw new Error('invalid scope')
        fixture.invalidations++
      },
    }
    window.__codexRoot = { _internalRoot: { current: { memoizedProps: { client: queryClient } } } }
    window.electronBridge = { async sendMessageFromView({ hostId, request }) {
      fixture.methods.push(request.method)
      const result = request.method === 'getAuthStatus'
        ? { authMethod: 'apikey', authToken: 'isolated-native-test-key' }
        : request.method === 'account/login/start' ? { type: 'apiKey' }
          : { data: fixture.models.map((model) => ({ model })), nextCursor: null }
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'mcp-response', hostId, message: { id: request.id, result },
      } }))
    } }
  })
  const sync = (version, models, apiKey) => page.evaluate(
    ({ source, settings }) => (0, eval)(`(${source})`)(settings, {
      allowTestLocation: true,
    }), { source: syncNativeModels.toString(), settings: { version, models, apiKey } })
  assert.equal((await sync('first', ['gemini-3-flash'])).status, 'synced')
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.methods),
    ['getAuthStatus', 'account/login/start', 'model/list'],
    'synchronization must not inspect or wait for running chats')
  assert.doesNotMatch(await page.locator('[data-testid="status-line"]').textContent(), /等待对话空闲/)
  assert.equal(await page.evaluate(() => window.nativeFixture.restarts), 0)
  const calls = await page.evaluate(() => window.nativeFixture.methods.length)
  await sync('first', ['gemini-3-flash'])
  assert.deepEqual(await page.evaluate((start) => window.nativeFixture.methods.slice(start), calls),
    ['getAuthStatus'], 'a synced catalog only rechecks account ownership, without logging in or rereading models')
  assert.equal(await page.evaluate(() => window.nativeFixture.invalidations), 1)
  assert.equal((await sync('second', ['claude-opus-4-6'])).status, 'error')
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /尚未同步/)
  const failedRestarts = await page.evaluate(() => window.nativeFixture.restarts)
  await sync('second', ['claude-opus-4-6'])
  assert.equal(await page.evaluate(() => window.nativeFixture.restarts), failedRestarts,
    'a verification failure must not create an automatic restart loop')
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: signedIn() })
  await page.evaluate(() => { window.nativeFixture.models = ['claude-opus-4-6'] })
  assert.equal((await sync('second', ['claude-opus-4-6'])).status, 'synced')
  const loginCalls = await page.evaluate(() => window.nativeFixture.methods.filter(
    (method) => method === 'account/login/start').length)
  assert.equal((await sync('other-account', ['claude-opus-4-6'], 'different-configured-test-key')).status,
    'account-change')
  assert.equal(await page.evaluate(() => window.nativeFixture.methods.filter(
    (method) => method === 'account/login/start').length), loginCalls,
  'a different in-memory account must not overwrite saved authentication or cancel active replies')
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /主实例尚未接管/)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /Ultra.*Fast/)
  assert.equal(await page.locator('[data-testid="takeover"]').isVisible(), true)
  await page.locator('[data-testid="takeover"]').click()
  const takeover = await next('reconfigure')
  assert.equal(takeover.action, 'reconfigure')
  await respond(takeover, { ok: true, data: signedIn({
    message: '接管配置已准备。请重启 Codex 后使用 Ultra、Fast 等能力。',
    restartRequired: true,
  }) })
  assert.match(await page.locator('[data-testid="message"]').textContent(), /Ultra.*Fast/)
  assert.equal(await page.evaluate(syncNativeModels, { version: 'third', models: [] }), null,
    'production synchronization is forbidden outside the Codex main page')
})

test('native synchronization updates subsequent turns only for assistant-owned providers', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await page.evaluate(() => {
    const fixture = { calls: [], updates: [], staleTier: false }
    window.nativeFixture = fixture
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `isolated-native-${fixture.calls.length}` })
    window.__codexRoot = { _internalRoot: { current: { memoizedProps: { client: {
      getQueryCache() {}, async invalidateQueries() {},
    } } } } }
    const threads = {
      replace: { id: 'replace', modelProvider: 'yisama', model: 'old-model', status: { type: 'active' } },
      keep: { id: 'keep', modelProvider: 'yisama', model: 'gemini-3-flash' },
      external: { id: 'external', modelProvider: 'personal', model: 'personal-model' },
    }
    window.electronBridge = { async sendMessageFromView({ hostId, request }) {
      fixture.calls.push(request.method)
      const { method, params } = request
      let result
      if (method === 'getAuthStatus') result = { authMethod: 'apikey', authToken: 'isolated-native-test-key' }
      else if (method === 'account/login/start') result = { type: 'apiKey' }
      else if (method === 'model/list') result = { data: [
        { model: 'gpt-5.5', serviceTiers: fixture.staleTier ? [] : [{ id: 'priority', name: 'Fast' }],
          defaultServiceTier: 'priority' },
        { model: 'gemini-3-flash', serviceTiers: [], defaultServiceTier: null },
      ], nextCursor: null }
      else if (method === 'thread/loaded/list') result = params.cursor
        ? { data: ['external'], nextCursor: null } : { data: ['replace', 'keep'], nextCursor: 'second-page' }
      else if (method === 'thread/read') result = { thread: threads[params.threadId] }
      else if (method === 'thread/settings/update') { fixture.updates.push(params); result = {} }
      else throw new Error(`Unexpected native method: ${method}`)
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'mcp-response', hostId, message: { id: request.id, result },
      } }))
    } }
  })
  const sync = (version) => page.evaluate(({ source, version }) => (0, eval)(`(${source})`)({
    version, provider: 'yisama', apiKey: 'isolated-native-test-key', model: 'gpt-5.5',
    models: ['gpt-5.5', 'gemini-3-flash'], modelSettings: {
      'gpt-5.5': { serviceTier: 'priority', effort: 'high' },
      'gemini-3-flash': { serviceTier: null, effort: 'none' },
    },
  }, { allowTestLocation: true }), { source: syncNativeModels.toString(), version })
  assert.equal((await sync('owned-threads')).status, 'synced')
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.updates), [
    { threadId: 'keep', model: 'gemini-3-flash', serviceTier: null },
  ])
  const calls = await page.evaluate(() => window.nativeFixture.calls)
  assert.equal(calls.filter((method) => method === 'thread/loaded/list').length, 2)
  assert.ok(!calls.some((method) => /interrupt|restart|turn\/settings/.test(method)))
  await page.evaluate(() => { window.nativeFixture.staleTier = true })
  assert.equal((await sync('stale-tier')).status, 'error')
  assert.equal(await page.evaluate(() => window.nativeFixture.updates.length), 1,
    'an unverified Fast catalog must not be reported as synchronized')
})

test('an outdated background refresh timeout cannot replace an active selection state', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { requestTimeouts: { status: 50 } })
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.locator('[data-testid="refresh"]').click()
  await next('status')
  await page.locator('[data-testid="group-select"] [data-value="premium"]').click()
  const selection = await next('select')
  await page.waitForTimeout(75)
  assert.doesNotMatch(await page.locator('[data-testid="message"]').textContent(), /无法刷新账户状态/)
  await respond(selection, { ok: true, data: signedIn({
    group: 'premium', groupLabel: 'premium', models: ['gpt-5.1'], model: 'gpt-5.1',
  }) })
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('data-value'), 'premium')
})

test('failed group selection explains the failure without a persistent restart banner', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn({ restartRequired: true }) })
  await open(signedIn({ restartRequired: true }))
  assert.equal(await page.locator('[data-testid="restart-note"]').count(), 0)
  await page.locator('[data-testid="group-select"] [data-value="premium"]').click()
  await respond(await next('select'), { ok: false, code: 'GROUP_NO_TEXT_MODEL', error: 'Bearer sk-secret' })
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('data-value'), 'auto')
  assert.match(await page.locator('[data-testid="message"]').textContent(), /没有可自动选择的对话模型.*原分组未改动/)
  assert.doesNotMatch(await page.locator('[data-testid="message"]').textContent(), /Bearer|sk-secret/)
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: signedIn({ restartRequired: false }) })
  assert.equal(await page.locator('[data-testid="restart-note"]').count(), 0)
})

test('login setup continues without credentials, times out safely, and accepts its late success', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { requestTimeouts: { login: 50 } })
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(loggedOut)
  await page.locator('[data-testid="auth-username"]').fill('demo')
  await page.locator('[data-testid="auth-password"]').fill('test-password')
  await page.locator('[data-testid="login"]').click()
  const credentials = await next('login')
  await respond(credentials, { ok: true, data: signedIn({ configured: false, setupPending: true, message: '' }) })
  assert.equal(await page.locator('[data-testid="logged-out"]').isHidden(), true)
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /正在准备配置/)
  const setup = await next('login')
  assert.deepEqual({ username: setup.username, password: setup.password, loginId: setup.loginId, twoFactorCode: setup.twoFactorCode }, {
    username: undefined, password: undefined, loginId: undefined, twoFactorCode: undefined,
  })
  await page.waitForTimeout(75)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /仍可能完成/)
  assert.equal(await page.locator('[data-testid="apply-selection"]').isDisabled(), false)
  assert.doesNotMatch(await page.locator('[data-testid="assistant-panel"]').textContent(), /test-password/)
  await respond(setup, { ok: true, data: signedIn({ setupPending: false, message: '已准备就绪' }) })
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /正在同步/)
  await page.evaluate(() => window.__yisamaInfiniteAssistant.nativeStatus('synced'))
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /已准备就绪/)
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-panel"]').screenshot({ path: path.join(output, 'assistant-login-setup.png') })
})

test('setup failure keeps the successful login visible without exposing credential errors', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(loggedOut)
  await page.locator('[data-testid="auth-username"]').fill('demo')
  await page.locator('[data-testid="auth-password"]').fill('test-password')
  await page.locator('[data-testid="login"]').click()
  await respond(await next('login'), { ok: true, data: {
    ...loggedOut, loggedIn: true, username: 'demo-user', setupPending: true,
  } })
  const setup = await next('login')
  await respond(setup, { ok: false, code: 'CONFIG_FAILED', error: 'test-password Bearer sk-secret' })
  assert.equal(await page.locator('[data-testid="logged-out"]').isHidden(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /账户已登录，准备配置未完成/)
  assert.equal(await page.locator('[data-testid="apply-selection"]').isDisabled(), false)
  assert.equal(await page.locator('[data-testid="apply-selection"]').textContent(), '重试准备')
  assert.doesNotMatch(await page.locator('[data-testid="assistant-panel"]').textContent(), /test-password|Bearer|sk-secret/)
  await page.locator('[data-testid="apply-selection"]').click()
  const retried = await next('login')
  assert.equal(retried.password, undefined)
  assert.equal(retried.username, undefined)
  await respond(retried, { ok: true, data: signedIn() })
  assert.equal(await page.locator('[data-testid="apply-selection"]').isHidden(), true)
})

test('narrow viewport keeps the panel within the document and supports Escape', async (t) => {
  const app = await fixture(t, { width: 320, height: 568 })
  if (!app) return
  const { page, next, respond, open } = app
  const initial = await next('status')
  await respond(initial, { ok: true, data: signedIn({ quota: 'CUSTOM-CURRENCY-12345678901234567890' }) })
  const badge = page.locator('[data-testid="assistant-badge"]')
  const badgeBox = await badge.boundingBox()
  assert.ok(badgeBox.width <= 128)
  assert.equal(await page.locator('[data-testid="badge-balance"]').evaluate((node) => node.scrollWidth > node.clientWidth), true)
  await page.mouse.move(badgeBox.x + 12, badgeBox.y + 12)
  await page.mouse.down()
  await page.mouse.move(22, 22)
  await page.mouse.up()
  const savedPosition = await page.evaluate(() => JSON.parse(window.localStorage.getItem(
    'yisama-infinite-assistant-ui-position-v1',
  )))
  assert.ok(savedPosition.left >= 8 && savedPosition.top >= 8)
  assert.equal(await page.locator('[data-testid="assistant-panel"]').isHidden(), true)
  await open(signedIn({ quota: 'CUSTOM-CURRENCY-12345678901234567890' }))
  const panel = page.locator('[data-testid="assistant-panel"]')
  const box = await panel.boundingBox()
  assert.ok(box.x >= 0 && box.y >= 0)
  assert.ok(box.x + box.width <= 320)
  assert.ok(box.y + box.height <= 568)
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'assistant-mobile.png') })
  await page.keyboard.press('Escape')
  assert.equal(await panel.isHidden(), true)
})

test('badge position adapts to viewport changes and survives reinjection', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 })
  if (!app) return
  const { page, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$9061.92' }) })
  const badge = page.locator('[data-testid="assistant-badge"]')
  const initialBox = await badge.boundingBox()
  assert.ok(initialBox)
  await page.evaluate(({ left, top, width, height }) => {
    localStorage.setItem('yisama-infinite-assistant-ui-position-v1', JSON.stringify({
      left, top, viewportWidth: 1280, viewportHeight: 800, badgeWidth: width, badgeHeight: height,
    }))
  }, { left: 1120, top: 700, width: initialBox.width, height: initialBox.height })
  await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
  await page.setViewportSize({ width: 800, height: 500 })
  await page.evaluate(installAssistantUI, { allowTestLocation: true })
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$9061.92' }) })
  await page.waitForTimeout(50)
  const resizedBox = await badge.boundingBox()
  assert.ok(resizedBox)
  assert.ok(resizedBox.x >= 8 && resizedBox.y >= 8)
  assert.ok(resizedBox.x + resizedBox.width <= 792)
  assert.ok(resizedBox.y + resizedBox.height <= 492)
  const savedPosition = await page.evaluate(() => JSON.parse(localStorage.getItem(
    'yisama-infinite-assistant-ui-position-v1',
  )))
  assert.equal(savedPosition.viewportWidth, 800)
  assert.equal(savedPosition.viewportHeight, 500)
  assert.ok(Number.isFinite(savedPosition.badgeWidth))
  assert.ok(Number.isFinite(savedPosition.badgeHeight))
})

test('inline login validates inputs, handles errors and two-factor verification without browser navigation', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond, open } = app
  let popups = 0
  page.on('popup', () => { popups++ })
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(loggedOut)
  await page.locator('[data-testid="login"]').click()
  assert.equal(commands.filter((value) => value.action === 'login').length, 0)
  await page.locator('[data-testid="auth-password"]').focus()
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-panel"]').screenshot({ path: path.join(output, 'assistant-login.png') })
  await page.locator('[data-testid="auth-username"]').fill('demo')
  await page.locator('[data-testid="auth-password"]').fill('wrong-password')
  await page.locator('[data-testid="auth-password"]').press('Enter')
  const wrong = await next('login')
  assert.equal(wrong.password, 'wrong-password')
  await respond(wrong, { ok: false, error: 'echo wrong-password Bearer sk-secret', code: 'AUTH_REJECTED' })
  assert.equal(await page.locator('[data-testid="auth-password"]').inputValue(), '')
  assert.match(await page.locator('[data-testid="message"]').textContent(), /账号或密码错误/)
  // The error is shown next to the button that was just pressed, not at the top of the panel.
  assert.equal(await page.locator('[data-testid="auth-form"] [data-testid="message"] + [data-testid="login"]').isVisible(), true)
  assert.doesNotMatch(await page.locator('[data-testid="assistant-panel"]').textContent(), /wrong-password|sk-secret|Bearer/)
  for (const code of ['AUTH_CONNECTION', 'AUTH_UNAVAILABLE']) {
    await page.locator('[data-testid="auth-password"]').fill('valid-password')
    await page.locator('[data-testid="login"]').click()
    await respond(await next('login'), { ok: false, code, error: 'valid-password Bearer sk-secret' })
    assert.match(await page.locator('[data-testid="message"]').textContent(), /连接|不可用/)
    assert.doesNotMatch(await page.locator('[data-testid="message"]').textContent(), /密码|valid-password|Bearer|sk-secret/)
  }
  await page.locator('[data-testid="auth-password"]').fill('valid-password')
  await page.locator('[data-testid="login"]').click()
  await respond(await next('login'), { ok: true, data: { auth: { step: 'twoFactor', loginId: 'opaque-challenge' } } })
  assert.equal(await page.locator('[data-testid="two-factor-form"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="auth-form"]').isHidden(), true)
  assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot())), /password|opaque-challenge/)
  await page.locator('[data-testid="auth-two-factor"]').fill('123456')
  await page.locator('[data-testid="verify-login"]').click()
  const verify = await next('login')
  assert.deepEqual({ loginId: verify.loginId, code: verify.twoFactorCode, password: verify.password }, {
    loginId: 'opaque-challenge', code: '123456', password: undefined,
  })
  assert.equal(await page.locator('[data-testid="auth-two-factor"]').inputValue(), '')
  await respond(verify, { ok: false, code: 'AUTH_EXPIRED', error: 'private flow' })
  assert.equal(await page.locator('[data-testid="two-factor-form"]').isHidden(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /过期/)
  await page.locator('[data-testid="auth-password"]').fill('unsent-password')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-testid="auth-password"]').inputValue(), '')
  assert.equal(popups, 0)
  assert.equal(page.url(), 'http://assistant.test/')
  assert.equal(await page.locator('iframe').count(), 0)
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => /password|auth|login/i.test(key))), false)
})

test('registration and email-code steps stay in the sidebar and fit narrow dark viewports', async (t) => {
  const app = await fixture(t, { width: 320, height: 568 })
  if (!app) return
  const { page, commands, next, respond, open } = app
  await page.emulateMedia({ colorScheme: 'dark' })
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions({ emailVerificationEnabled: true }) })
  await open(loggedOut)
  await page.locator('[data-testid="register-tab"]').click()
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-panel"]').screenshot({ path: path.join(output, 'assistant-register-mobile.png') })
  await page.locator('[data-testid="auth-username"]').fill('new-user')
  await page.locator('[data-testid="auth-password"]').fill('new-password')
  await page.locator('[data-testid="auth-confirm-password"]').fill('different-password')
  await page.locator('[data-testid="auth-email"]').fill('demo@example.test')
  await page.locator('[data-testid="send-verification"]').click()
  const send = await next('sendVerification')
  assert.equal(send.email, 'demo@example.test')
  await respond(send, { ok: true, data: { verificationSent: true } })
  assert.equal(await page.locator('[data-testid="send-verification"]').isDisabled(), true)
  await page.locator('[data-testid="auth-verification-code"]').fill('654321')
  await page.locator('[data-testid="login"]').click()
  assert.equal(commands.filter((value) => value.action === 'register').length, 0)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /不一致/)
  await page.locator('[data-testid="auth-confirm-password"]').fill('new-password')
  const panelBox = await page.locator('[data-testid="assistant-panel"]').boundingBox()
  for (const input of await page.locator('[data-testid="auth-form"] input:visible').all()) {
    const box = await input.boundingBox()
    assert.ok(box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width)
  }
  await page.locator('[data-testid="login"]').click()
  const registration = await next('register')
  assert.deepEqual({ username: registration.username, email: registration.email,
    verificationCode: registration.verificationCode, password: registration.password }, {
    username: 'new-user', email: 'demo@example.test', verificationCode: '654321', password: 'new-password',
  })
  await respond(registration, { ok: true, data: { registered: true } })
  assert.equal(await page.locator('[data-testid="auth-password"]').inputValue(), '')
  assert.equal(await page.locator('[data-testid="auth-confirm-password"]').inputValue(), '')
  assert.equal(await page.locator('[data-testid="auth-verification-code"]').inputValue(), '')
  assert.equal(await page.locator('[data-testid="login"]').textContent(), '登录')
  assert.match(await page.locator('[data-testid="message"]').textContent(), /注册成功/)
  await page.locator('[data-testid="auth-password"]').fill('new-password')
  await page.locator('[data-testid="login"]').click()
  await respond(await next('login'), { ok: true, data: signedIn({ username: 'new-user' }) })
  assert.equal(await page.locator('[data-testid="logged-out"]').isHidden(), true)
  assert.equal(await page.locator('[data-testid="username"]').textContent(), 'new-user')
})

test('group rows show optional ratios and mark cheaper routes', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  const data = signedIn({ groups: [
    { value: 'auto', label: 'All', ratio: 1 }, { value: 'cn', label: 'cn', ratio: '0.2' }, { value: 'plain', label: 'plain' },
    { value: 'free', label: 'free', ratio: 0 },
  ] })
  await respond(await next('status'), { ok: true, data })
  await open(data)
  const ratio = (value) => page.locator(`[data-testid="group-select"] [data-value="${value}"] .y-group__ratio`)
  assert.equal(await ratio('auto').textContent(), '×1')
  assert.equal(await ratio('cn').textContent(), '×0.2')
  assert.equal(await ratio('cn').getAttribute('data-cheap'), 'true')
  assert.equal(await ratio('plain').textContent(), '')
  assert.equal(await ratio('free').textContent(), '免费')
  assert.equal(await page.locator('[data-testid="status-line"]').textContent(), 'LIVE已准备就绪')
})

test('long group lists scroll to the current route and can be searched', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  const groups = Array.from({ length: 12 }, (_, index) => ({ value: `g${index}`, label: `线路 ${index}`, ratio: 1 }))
  const data = signedIn({ groups, group: 'g10', groupLabel: '线路 10' })
  await respond(await next('status'), { ok: true, data })
  await open(data)
  const list = page.locator('[data-testid="group-select"]')
  const listBox = await list.boundingBox()
  assert.ok(listBox.height <= 220, 'the route list stays compact')
  const current = await page.locator('.y-group[data-value="g10"]').boundingBox()
  assert.ok(current.y >= listBox.y && current.y + current.height <= listBox.y + listBox.height + 1,
    'the current route is scrolled into view')
  const search = page.locator('[data-testid="group-search"]')
  assert.equal(await search.isVisible(), true)
  await search.fill('线路 3')
  assert.equal(await page.locator('[data-testid="group-select"] .y-group:visible').count(), 1)
  await search.press('Enter')
  assert.equal((await next('select')).group, 'g3')
})

test('short group lists do not show a search field', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  assert.equal(await page.locator('[data-testid="group-search"]').isHidden(), true)
})

test('one click on create order still creates it while the typed amount is being priced', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.locator('[data-testid="recharge"]').click()
  await respond(await next('rechargeInfo'), { ok: true, data: {
    amountOptions: [10], paymentMethods: [{ name: '支付宝', type: 'alipay', minTopup: 0 }], minTopup: 1, currency: 'USD',
  } })
  await page.locator('[data-testid="recharge-amount"]').fill('5')
  // Clicking blurs the amount field, which starts pricing before the click lands.
  await page.locator('[data-testid="recharge-submit"]').click()
  const pricing = await next('rechargeAmount')
  assert.equal(commands.filter((value) => value.action === 'rechargePay').length, 0)
  assert.equal(await page.locator('[data-testid="recharge-submit"]').textContent(), '正在创建…')
  await respond(pricing, { ok: true, data: { paymentAmount: 5 } })
  const pay = await next('rechargePay')
  assert.deepEqual({ amount: pay.amount, method: pay.paymentMethod }, { amount: 5, method: 'alipay' })
  await respond(pay, { ok: true, data: { paymentUrl: 'https://pay.example.test/checkout/1', fields: {}, amount: 5 } })
  assert.equal(await page.locator('[data-testid="recharge-payment"]').isVisible(), true)
})
