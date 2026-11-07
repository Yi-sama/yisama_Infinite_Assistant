import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { REMOVE_ASSISTANT_SCRIPT, installAssistantUI, makeAssistantScript } from './codex-panel.mjs'
import { AssistantTarget, installNativeStartup, syncNativeModels } from './codex-assistant.mjs'

const output = fileURLToPath(new URL('../output/playwright/', import.meta.url))
const { version: installedVersion } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))

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
  balanceMode: 'settled',
  pendingSettlement: false,
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
  if (!options.testDailyUpdate) await page.evaluate(() => {
    const now = new Date()
    window.localStorage.setItem('yisama-infinite-assistant-update-check-day-v1',
      `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`)
  })
  await page.evaluate(installAssistantUI, { allowTestLocation: true, version: installedVersion, ...options })
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
    const badge = page.locator('[data-testid="assistant-badge"]')
    // A signed-out user's panel opens by itself after the first status; the badge would close it.
    if ((await badge.getAttribute('aria-expanded')) === 'true') return
    await badge.click()
    await respond(await next('status'), { ok: true, data })
  }
  return { page, commands, next, respond, open }
}

test('local version shares the logout row, stays right aligned and works offline on small screens', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { version: '2.3.4' })
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  const label = page.locator('[data-testid="assistant-version"]')
  assert.equal(await label.innerText(), 'v.2.3.4')
  await page.locator('[data-testid="update"]').click()
  await respond(await next('checkUpdate'), { ok: false, code: 'UPDATE_CONNECTION' })
  assert.equal(await label.innerText(), 'v.2.3.4')
  await page.locator('[data-testid="cancel-update"]').click()
  await page.locator('[data-testid="help"]').click()
  assert.equal(await label.isVisible(), false)
  await page.locator('[data-testid="qq-back"]').click()
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 360, 280]) {
    await page.setViewportSize({ width, height: 800 })
    await page.locator('[data-testid="restore"]').scrollIntoViewIfNeeded()
    const versionBox = await label.boundingBox()
    const restore = await page.locator('[data-testid="restore"]').boundingBox()
    assert.ok(Math.abs(versionBox.y + versionBox.height / 2 - restore.y - restore.height / 2) < 1)
    assert.ok(versionBox.x >= restore.x + restore.width)
    const row = await page.locator('.y-account-footer').boundingBox()
    const panel = await page.locator('[data-testid="assistant-panel"]').boundingBox()
    assert.ok(Math.abs(restore.x + restore.width / 2 - panel.x - panel.width / 2) < 1,
      'logout must be centered on the full panel, independently of the version width')
    assert.ok(Math.abs(versionBox.x + versionBox.width - row.x - row.width) < 1)
    assert.ok(versionBox.x >= 0 && versionBox.x + versionBox.width <= width && versionBox.y + versionBox.height <= 800)
    assert.equal(await page.locator('.y-head [data-testid="assistant-version"]').count(), 0)
    assert.equal(await page.locator('.y-wordmark small').innerText(), '无限助手')
    assert.equal(await label.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-version-inline-${width}.png`),
    })
  }
})

test('serialized panel reads local package version independently of the update service', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  await next('status')
  await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
  const source = makeAssistantScript().replaceAll("window.location.href !== 'app://-/index.html'", 'false')
  await page.evaluate(source)
  await respond(await next('status'), { ok: true, data: signedIn() })
  await page.locator('[data-testid="assistant-badge"]').click()
  assert.equal(await page.locator('[data-testid="assistant-version"]').innerText(), `v.${installedVersion}`)
  assert.equal(await page.locator('[data-testid="assistant-version"]').isVisible(), true)
})

test('daily update notice stays small and opens confirmation without installing', async (t) => {
  const app = await fixture(t, { width: 390, height: 844 }, { testDailyUpdate: true })
  if (!app) return
  const { page, commands, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  const check = await next('checkUpdate')
  // A pending automatic check must not lock the account controls.
  await page.locator('[data-testid="assistant-badge"]').click()
  await respond(await next('status'), { ok: true, data: signedIn() })
  assert.equal(await page.locator('[data-testid="refresh"]').isEnabled(), true)
  await page.locator('[data-testid="close"]').click()
  await respond(check, { ok: true, data: {
    available: true, currentVersion: '1.2.1', latestVersion: '1.2.2',
    updateId: 'b'.repeat(64), notes: 'Daily update test',
  } })
  const notice = page.locator('[data-testid="update-notice"]')
  assert.equal(await notice.isVisible(), true)
  assert.match(await notice.innerText(), /1\.2\.2/)
  assert.equal(await page.locator('[data-testid="assistant-panel"]').isVisible(), false)
  const box = await notice.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844)
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'assistant-daily-update-mobile.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: path.join(output, 'assistant-daily-update-desktop.png') })
  await page.locator('[data-testid="update-view"]').click()
  assert.equal(await notice.isVisible(), false)
  assert.equal(await page.locator('[data-testid="update-confirmation"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="update-allow-interrupt"]').isChecked(), false)
  assert.match(await page.locator('[data-testid="update-description"]').innerText(), /重启 Codex/)
  assert.equal(commands.filter((item) => item.action === 'installUpdate').length, 0)
})

test('daily update dismissal survives reinjection and checks again on next day startup', async (t) => {
  const app = await fixture(t, undefined, { testDailyUpdate: true })
  if (!app) return
  const { page, commands, next, respond } = app
  await respond(await next('checkUpdate'), { ok: true, data: {
    available: true, currentVersion: '1.2.1', latestVersion: '1.2.2', updateId: 'b'.repeat(64),
  } })
  await page.locator('[data-testid="update-later"]').click()
  const reinstall = async () => {
    await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
    await page.evaluate(installAssistantUI, { allowTestLocation: true })
  }
  await reinstall()
  assert.equal(await page.locator('[data-testid="update-notice"]').isVisible(), false)
  assert.equal(commands.filter((item) => item.action === 'checkUpdate').length, 1)
  await page.clock.setFixedTime(new Date(Date.now() + 86400000))
  await reinstall()
  await respond(await next('checkUpdate'), { ok: true, data: {
    available: true, currentVersion: '1.2.1', latestVersion: '1.2.2', updateId: 'b'.repeat(64),
  } })
  assert.equal(await page.locator('[data-testid="update-notice"]').isVisible(), true)
  assert.equal(commands.filter((item) => item.action === 'checkUpdate').length, 2)
})

test('daily check errors, current versions and disposed responses remain silent', async (t) => {
  const app = await fixture(t, undefined, { testDailyUpdate: true })
  if (!app) return
  const { page, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await respond(await next('checkUpdate'), { ok: false, code: 'UPDATE_UNAVAILABLE' })
  assert.equal(await page.locator('[data-testid="update-notice"]').isVisible(), false)
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().message), '已准备就绪')
  for (const late of [false, true]) {
    await page.evaluate(() => {
      window.__yisamaInfiniteAssistant.dispose()
      window.localStorage.removeItem('yisama-infinite-assistant-update-check-day-v1')
    })
    await page.evaluate(installAssistantUI, { allowTestLocation: true })
    const check = await next('checkUpdate')
    if (late) {
      const accepted = await page.evaluate((id) => {
        const runtime = window.__yisamaInfiniteAssistant
        runtime.dispose()
        return runtime.receive({ id, ok: true, data: {
          available: true, latestVersion: '1.2.2', updateId: 'b'.repeat(64),
        } })
      }, check.id)
      assert.equal(accepted, false)
    } else {
      assert.equal(await respond(check, { ok: true, data: { available: false, currentVersion: '1.2.1' } }), true)
    }
    assert.equal(await page.locator('[data-testid="update-notice"]:visible').count(), 0)
  }
})

test('update icon sits before refresh and requires explicit confirmation without changing login state', async (t) => {
  const app = await fixture(t, { width: 390, height: 844 })
  if (!app) return
  const { page, commands, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  const update = page.locator('[data-testid="update"]')
  const refresh = page.locator('[data-testid="refresh"]')
  assert.ok((await update.boundingBox()).x < (await refresh.boundingBox()).x)
  await update.click()
  await respond(await next('checkUpdate'), { ok: true, data: {
    available: true, currentVersion: '1.2.0', latestVersion: '1.2.1', updateId: 'a'.repeat(64),
    size: 28000000, notes: '<b>literal release notes</b>',
  } })
  assert.equal(commands.filter((item) => item.action === 'installUpdate').length, 0)
  const confirmation = page.locator('[data-testid="update-confirmation"]')
  assert.match(await confirmation.innerText(), /重启 Codex/)
  assert.equal(await confirmation.locator('b').count(), 0)
  await page.locator('[data-testid="cancel-update"]').click()
  assert.equal(await confirmation.isVisible(), false)
  assert.equal(commands.filter((item) => item.action === 'installUpdate').length, 0)
  await update.click()
  await respond(await next('checkUpdate'), { ok: true, data: {
    available: true, currentVersion: '1.2.0', latestVersion: '1.2.1', updateId: 'a'.repeat(64),
    size: 28000000, notes: 'Update test',
  } })
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'assistant-update-mobile.png') })
  await page.locator('[data-testid="confirm-update"]').click()
  const install = await next('installUpdate')
  assert.equal(install.updateId, 'a'.repeat(64))
  assert.equal(install.allowInterrupt, undefined)
  await respond(install, { ok: false, code: 'UPDATE_BLOCKED' })
  assert.match(await confirmation.innerText(), /等待所有 Codex 任务结束/)
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$12.50')
  await page.locator('[data-testid="update-allow-interrupt"]').check()
  await page.locator('[data-testid="confirm-update"]').click()
  const confirmed = await next('installUpdate')
  assert.equal(confirmed.allowInterrupt, true)
  await respond(confirmed, { ok: true, data: { restartRequired: true } })
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().restarting), true)
  await page.evaluate(() => window.__yisamaInfiniteAssistant.restartFailed())
  assert.equal(await update.isEnabled(), true)
  assert.match(await confirmation.innerText(), /重启未完成/)
})

test('update check errors remain visible and never enable installation', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.locator('[data-testid="update"]').click()
  await respond(await next('checkUpdate'), { ok: false, code: 'UPDATE_UNAVAILABLE' })
  assert.match(await page.locator('[data-testid="update-description"]').innerText(), /更新服务暂不可用/)
  assert.equal(await page.locator('[data-testid="confirm-update"]').isVisible(), false)
})

test('login takeover and restore only permit interruptions when their own confirmation is checked', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.evaluate(() => window.__yisamaInfiniteAssistant.nativeStatus('account-change'))
  await page.locator('[data-testid="takeover"]').click()
  const takeover = page.locator('[data-testid="restart-allow-interrupt"]')
  assert.equal(await takeover.isChecked(), false)
  await takeover.check()
  await page.locator('[data-testid="confirm-restart"]').click()
  const restart = await next('reconfigure')
  assert.equal(restart.allowInterrupt, true)
  await respond(restart, { ok: false, code: 'RESTART_CHECK_FAILED' })
  await page.locator('[data-testid="cancel-restart"]').click()
  await page.locator('[data-testid="takeover"]').click()
  assert.equal(await takeover.isChecked(), false)
  await page.locator('[data-testid="cancel-restart"]').click()
  await page.locator('[data-testid="restore"]').click()
  const restore = page.locator('[data-testid="restore-allow-interrupt"]')
  assert.equal(await restore.isChecked(), false)
  await restore.check()
  await page.locator('[data-testid="confirm-restore"]').click()
  const logout = await next('restore')
  assert.equal(logout.allowInterrupt, true)
  await respond(logout, { ok: false, code: 'RESTORE_CHECK_FAILED' })
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'assistant-restart-desktop.png') })
})

test('password recovery completes in the panel without opening a browser or saving secrets', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(loggedOut)
  const recovery = page.locator('[data-testid="forgot-password"]')
  assert.equal(await recovery.count(), 1)
  await page.locator('[data-testid="auth-username"]').fill('demo@example.test')
  await page.locator('[data-testid="auth-password"]').fill('not-to-be-sent')
  await recovery.click()
  const resetForm = page.locator('[data-testid="password-reset-form"]')
  const email = page.locator('[data-testid="auth-reset-email"]')
  const code = page.locator('[data-testid="auth-reset-code"]')
  const password = page.locator('[data-testid="auth-reset-password"]')
  const confirm = page.locator('[data-testid="auth-reset-confirm-password"]')
  assert.equal(await resetForm.isVisible(), true)
  assert.equal(await email.inputValue(), 'demo@example.test')
  assert.equal(await page.locator('[data-testid="auth-password"]').inputValue(), '')
  await page.locator('[data-testid="send-password-reset-verification"]').click()
  const sent = await next('sendPasswordResetVerification')
  assert.deepEqual(Object.keys(sent).sort(), ['action', 'email', 'id', 'used'])
  await respond(sent, { ok: true, data: { passwordResetVerificationSent: true } })
  assert.equal(await page.locator('[data-testid="send-password-reset-verification"]').isDisabled(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /如果邮箱已注册/)
  await code.fill('987654')
  await password.fill('new-password')
  await confirm.fill('different-password')
  await page.locator('[data-testid="reset-password"]').click()
  assert.equal(commands.some((item) => item.action === 'resetPassword'), false)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /密码不一致/)
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 })
    for (const input of await resetForm.locator('input, button').all()) {
      assert.equal(await input.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    }
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-password-recovery-${width}.png`),
    })
  }
  await confirm.fill('new-password')
  await page.locator('[data-testid="reset-password"]').click()
  const reset = await next('resetPassword')
  assert.equal(reset.password, 'new-password')
  assert.equal(reset.verificationCode, '987654')
  assert.equal(await password.inputValue(), '')
  assert.equal(await confirm.inputValue(), '')
  assert.equal(await code.inputValue(), '')
  await respond(reset, { ok: false, code: 'AUTH_REJECTED' })
  assert.equal(await resetForm.isVisible(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /密码重置失败/)
  await code.fill('987654')
  await password.fill('new-password')
  await confirm.fill('new-password')
  await page.locator('[data-testid="reset-password"]').click()
  await respond(await next('resetPassword'), { ok: true, data: { passwordReset: true } })
  assert.equal(await resetForm.isHidden(), true)
  assert.equal(await page.locator('[data-testid="auth-username"]').inputValue(), 'demo@example.test')
  assert.match(await page.locator('[data-testid="message"]').textContent(), /密码已重置.*新密码登录/)
  await recovery.click()
  await password.fill('unsent-password')
  await code.fill('123456')
  await page.locator('[data-testid="password-reset-back"]').click()
  assert.equal(await password.inputValue(), '')
  assert.equal(await code.inputValue(), '')
  assert.equal(commands.some((item) => ['login', 'forgotPassword'].includes(item.action)), false)
  assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('password')), false)
})

test('all balance surfaces show settled balance while in-flight precharges stay hidden', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$1.00' }) })
  await open(signedIn({ quota: '$1.00', pendingSettlement: true }))
  assert.equal(await page.locator('[data-testid="quota-note"]').textContent(), '结算中')
  assert.match(await page.locator('[data-testid="assistant-badge"]').getAttribute('title'), /已结算余额.*不扣除/)
  assert.match(await page.locator('[data-testid="badge-balance"]').getAttribute('title'), /已结算余额/)
  assert.equal(await page.locator('[data-testid="badge-balance"]').textContent(), '$1.00')
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$1.00')
  assert.doesNotMatch(await page.locator('[data-testid="assistant-panel"]').textContent(), /0\.22|0\.78/)
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$0.81' }) })
  assert.equal(await page.locator('[data-testid="badge-balance"]').textContent(), '$0.81')
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$0.81')
  await page.locator('[data-testid="recharge"]').click()
  await respond(await next('rechargeInfo'), { ok: true, data: { paymentMethods: [], minTopup: 1 } })
  assert.equal(await page.locator('[data-testid="wallet-balance"]').textContent(), '$0.81')
})

test('background balance polling updates settlement without blocking controls or replacing model state', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { balancePollMs: 50, settlementPollMs: 50 })
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$1.00' }) })
  await open(signedIn({ quota: '$1.00', pendingSettlement: true }))
  const pending = await next('balance')
  assert.equal(await page.locator('[data-testid="restore"]').isEnabled(), true)
  await respond(pending, { ok: true, data: { quota: '$0.81', balanceMode: 'settled', pendingSettlement: false } })
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$0.81')
  assert.equal(await page.locator('[data-testid="quota-note"]').textContent(), '已结算')
  assert.equal((await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot())).group, 'auto')
  const failed = await next('balance')
  await respond(failed, { ok: false })
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$0.81')
  assert.equal(await page.locator('[data-testid="stale-note"]').isVisible(), true)
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 })
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-settled-balance-${width}.png`),
    })
  }
})

test('late balance responses cannot replace a newer snapshot or revive a logged-out account', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { balancePollMs: 50, settlementPollMs: 50 })
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$1.00' }) })
  await open(signedIn({ quota: '$1.00' }))
  const older = await next('balance')
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: signedIn({ quota: '$0.81' }) })
  await respond(older, { ok: true, data: { quota: '$1.00', balanceMode: 'settled', pendingSettlement: true } })
  assert.equal(await page.locator('[data-testid="panel-balance"]').textContent(), '$0.81')
  const beforeLogout = await next('balance')
  await page.locator('[data-testid="refresh"]').click()
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(beforeLogout, { ok: true, data: { quota: '$0.80', balanceMode: 'settled' } })
  const state = await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot())
  assert.equal(state.loggedIn, false)
  assert.equal(state.quota, '')
  assert.equal(await page.locator('[data-testid="badge-balance"]').textContent(), '登录')
})

test('balance polling pauses while hidden and stops after disposal', async (t) => {
  const app = await fixture(t, { width: 1280, height: 800 }, { balancePollMs: 50 })
  if (!app) return
  const { page, commands, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  await page.waitForTimeout(1200)
  assert.equal(commands.filter((item) => item.action === 'balance').length, 0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await respond(await next('status'), { ok: true, data: signedIn() })
  await respond(await next('balance'), { ok: true, data: { quota: '$0.81', balanceMode: 'settled' } })
  await page.evaluate(() => window.__yisamaInfiniteAssistant.dispose())
  const count = commands.length
  await page.waitForTimeout(1200)
  assert.equal(commands.length, count)
})

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
  assert.equal(await page.locator('[data-testid="restore"]').textContent(), '退出登录并恢复原配置')
  await page.locator('[data-testid="restore"]').click()
  await assert.doesNotReject(page.locator('[data-testid="restore-confirmation"]').waitFor({ state: 'visible' }))
  assert.match(await page.locator('[data-testid="restore-confirmation"]').textContent(), /退出.*停用.*自动.*重新打开 Codex/)
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 })
    assert.equal(await page.locator('[data-testid="confirm-restore"]').evaluate(
      (node) => node.scrollWidth <= node.clientWidth,
    ), true)
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-restore-confirmation-${width}.png`),
    })
  }
  await page.locator('[data-testid="cancel-restore"]').click()
  assert.equal(commands.filter((command) => command.action === 'restore').length, 0)
  await page.locator('[data-testid="restore"]').click()
  await page.locator('[data-testid="confirm-restore"]').click()
  assert.equal(await page.locator('[data-testid="group-select"]').getAttribute('aria-disabled'), 'true')
  const restore = await next('restore')
  await respond(restore, { ok: true, data: {
    ...loggedOut, restartRequired: true, message: '已退出登录并恢复原配置，正在自动重启 Codex…',
  } })
  assert.equal(await page.locator('[data-testid="login"]').count(), 1)
  assert.equal(await page.locator('[data-testid="login"]').isDisabled(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /自动重启 Codex/)

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

test('one restore action remains available after login expiry and explains blocked restoration', async (t) => {
  const app = await fixture(t, { width: 360, height: 800 })
  if (!app) return
  const { page, commands, next, respond, open } = app
  const expired = { ...loggedOut, configured: true }
  await respond(await next('status'), { ok: true, data: expired })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  await open(expired)
  const restore = page.locator('[data-testid="restore"]')
  assert.equal(await restore.isVisible(), true)
  assert.equal(await restore.count(), 1)
  assert.equal(await restore.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
  await restore.click()
  await page.locator('[data-testid="confirm-restore"]').click()
  await respond(await next('restore'), { ok: false, code: 'RESTORE_BLOCKED' })
  assert.match(await page.locator('[data-testid="message"]').textContent(), /草稿|运行中的任务/)
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().configured), true)
  assert.equal(await page.locator('[data-testid="confirm-restore"]').isDisabled(), false)
  assert.equal(commands.filter((command) => command.action === 'restore').length, 1)
  await page.locator('[data-testid="confirm-restore"]').click()
  await respond(await next('restore'), { ok: false, code: 'RESTORE_CHECK_FAILED' })
  assert.match(await page.locator('[data-testid="message"]').textContent(), /无法确认 Codex/)
  await fs.mkdir(output, { recursive: true })
  await page.locator('[data-testid="assistant-panel"]').screenshot({
    path: path.join(output, 'assistant-restore-mobile.png'),
  })
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
  assert.equal(await page.locator('[data-testid="apply-selection"]').textContent(), '使用此模型')
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

test('native catalogs sync without restarting and account changes require restart confirmation', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, commands, next, respond, open } = app
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
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /需重启.*生效/)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /自动.*重新打开 Codex/)
  assert.equal(await page.locator('[data-testid="takeover"]').isVisible(), true)
  await page.locator('[data-testid="takeover"]').click()
  assert.equal(commands.filter((item) => item.action === 'reconfigure').length, 0)
  assert.equal(await page.locator('[data-testid="restart-confirmation"]').isVisible(), true)
  assert.equal(await page.locator('[data-testid="message"]').isHidden(), true)
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 })
    assert.equal(await page.locator('[data-testid="confirm-restart"]').evaluate(
      (node) => node.scrollWidth <= node.clientWidth,
    ), true)
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-relogin-confirmation-${width}.png`),
    })
  }
  await page.locator('[data-testid="cancel-restart"]').click()
  assert.equal(commands.filter((item) => item.action === 'reconfigure').length, 0)
  await page.locator('[data-testid="takeover"]').click()
  await page.locator('[data-testid="confirm-restart"]').click()
  await respond(await next('reconfigure'), { ok: false, code: 'RESTART_BLOCKED' })
  assert.match(await page.locator('[data-testid="message"]').textContent(), /保存草稿.*任务完成.*未重启/)
  await page.locator('[data-testid="confirm-restart"]').click()
  const takeover = await next('reconfigure')
  assert.equal(takeover.action, 'reconfigure')
  await respond(takeover, { ok: true, data: signedIn({
    message: '接管配置已准备，正在自动重启 Codex…',
    restartRequired: true,
  }) })
  assert.match(await page.locator('[data-testid="message"]').textContent(), /自动重启 Codex/)
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /正在重启/)
  assert.equal(await page.locator('[data-testid="refresh"]').isDisabled(), true)
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().restarting), true)
  assert.equal(await page.evaluate(syncNativeModels, { version: 'third', models: [] }), null,
    'production synchronization is forbidden outside the Codex main page')
})

test('a fresh desktop startup loads controls without a click and completes after one real browser reload', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  const startupScript = `(${installNativeStartup.toString()})(${JSON.stringify(new Date().toISOString())}, {allowTestLocation: true})`
  await page.addInitScript(startupScript)
  await page.evaluate(startupScript)
  const prepareNative = (ready) => page.evaluate((ready) => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => `startup-${Math.random()}` })
    window.__codexRoot = { _internalRoot: { current: {} } }
    window.__yisamaNativeModelSync = { version: 'startup-test', status: 'synced' }
    window.__yisamaNativeFast = { authorize() {}, isBusy: () => false, needsReload: () => !ready }
    window.electronBridge = { async sendMessageFromView({ hostId, request }) {
      const result = request.method === 'getAuthStatus'
        ? { authMethod: 'apikey', authToken: 'isolated-startup-key' } : { data: [], nextCursor: null }
      window.postMessage({ type: 'mcp-response', hostId, message: { id: request.id, result } }, '*')
    } }
  }, ready)
  await prepareNative(false)
  let reloads = 0
  const reports = []
  const target = new AssistantTarget({}, null, {
    report: (message) => reports.push(message),
    connectionFactory: () => ({
      async call(method, params) {
        if (method === 'Page.reload') {
          reloads++
          await page.reload()
          return {}
        }
        assert.equal(method, 'Runtime.evaluate')
        // Production remains restricted to app://; only the browser fixture opts in.
        const expression = params.expression.startsWith('(async function syncNativeModels')
          ? params.expression.slice(0, -1) + ', {allowTestLocation: true})' : params.expression
        return { result: { value: await page.evaluate(expression) } }
      },
    }),
  })
  target.allowed = true
  target.mainFrameId = 'isolated'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'isolated' } })
  const settings = { version: 'startup-test', provider: 'yisama', apiKey: 'isolated-startup-key' }
  assert.equal((await target.syncModels(settings)).status, 'pending')
  assert.equal(reloads, 1, 'the helper reloads automatically without clicking the refresh control')
  assert.match(reports[0], /Native model controls: startup page reload\.$/)
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type), 'reload')
  assert.equal(await page.evaluate(() => window.__yisamaNativeStartup.pending()), false)
  await page.evaluate(installAssistantUI, { allowTestLocation: true })
  await prepareNative(true)
  assert.equal((await target.syncModels(settings)).status, 'synced')
  assert.equal(await page.evaluate(() => window.__yisamaInfiniteAssistant.snapshot().nativeSync), 'synced')
  assert.equal(await page.locator('[data-testid="native-reload"]').isHidden(), true)
  assert.equal(reloads, 1, 'normal polling must never repeat the startup reload')
})

test('native controls reload only after a click and never queue behind a draft or active turn', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond, open } = app
  await respond(await next('status'), { ok: true, data: signedIn() })
  await open(signedIn())
  await page.evaluate(() => {
    const fixture = window.nativeFixture = { active: true, ready: false, sequence: 0, methods: [] }
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => `reload-test-${++fixture.sequence}` })
    window.__codexRoot = { _internalRoot: { current: {} } }
    window.__yisamaNativeModelSync = { version: 'reload-test', status: 'synced' }
    window.__yisamaNativeFast = { authorize() {}, isBusy: () => false, needsReload: () => !fixture.ready }
    window.electronBridge = { async sendMessageFromView({ hostId, request }) {
      fixture.methods.push(request.method)
      const result = request.method === 'getAuthStatus'
        ? { authMethod: 'apikey', authToken: 'isolated-reload-key' }
        : request.method === 'thread/loaded/list' ? { data: ['isolated-thread'], nextCursor: null }
          : { thread: { status: { type: fixture.active ? 'active' : 'idle' } } }
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'mcp-response', hostId, message: { id: request.id, result },
      } }))
    } }
    const draft = document.createElement('textarea')
    draft.id = 'isolated-draft'
    document.body.append(draft)
    document.querySelector('[data-testid="logged-out"] input').value = 'retained-login-name'
  })
  const sync = () => page.evaluate(({ source }) => (0, eval)(`(${source})`)({
    version: 'reload-test', apiKey: 'isolated-reload-key', provider: 'yisama',
  }, { allowTestLocation: true }), { source: syncNativeModels.toString() })
  const button = page.locator('[data-testid="native-reload"]')
  assert.equal((await sync()).reloadNativeFast, undefined)
  assert.equal(await button.isVisible(), true)
  assert.match(await page.locator('[data-testid="message"]').textContent(), /刷新 Codex/)
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.methods), ['getAuthStatus'])
  await fs.mkdir(output, { recursive: true })
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForTimeout(200)
    assert.equal(await button.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    await page.locator('[data-testid="assistant-panel"]').screenshot({
      path: path.join(output, `assistant-native-reload-${width}.png`),
    })
  }
  await button.click()
  assert.equal((await sync()).reloadNativeFast, undefined)
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /还有草稿或运行中的任务/)
  await page.evaluate(() => { window.nativeFixture.active = false })
  assert.equal((await sync()).reloadNativeFast, undefined, 'a finished turn cannot trigger a deferred reload')
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /尚未刷新/)
  await page.locator('#isolated-draft').fill('unsent message')
  await button.click()
  assert.equal((await sync()).reloadNativeFast, undefined)
  assert.equal(await page.locator('#isolated-draft').inputValue(), 'unsent message')
  await page.locator('#isolated-draft').fill('')
  assert.equal((await sync()).reloadNativeFast, undefined, 'clearing a draft cannot trigger a deferred reload')
  await button.click()
  await page.evaluate(installAssistantUI, { allowTestLocation: true })
  assert.equal((await sync()).reloadNativeFast, undefined, 'reattaching cannot execute a stale click')
  await button.click()
  assert.equal((await sync()).reloadNativeFast, true,
    'an explicit idle reload works despite retained text in the hidden signed-out form')
  assert.equal((await sync()).reloadNativeFast, undefined, 'a click is consumed once')
  await page.evaluate(() => { window.nativeFixture.ready = true })
  assert.equal((await sync()).status, 'synced')
  assert.equal(await button.isHidden(), true)
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
      native: { id: 'native', modelProvider: 'yisama', model: 'native-extra' },
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
        { model: 'native-extra', serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: 'priority' },
      ], nextCursor: null }
      else if (method === 'thread/loaded/list') result = params.cursor
        ? { data: ['external'], nextCursor: null } : { data: ['replace', 'keep', 'native'], nextCursor: 'second-page' }
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
  assert.match(await page.locator('[data-testid="status-line"]').textContent(), /已准备就绪/)
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
  assert.match(await page.locator('[data-testid="message"]').textContent(), /暂无可用的对话模型.*原设置未改动/)
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

test('signed-out users get the panel opened and the page dimmed so the official sign-in is not used', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  const gate = page.locator('[data-testid="login-gate"]')
  // Nothing covers the page before the first status answer, so a signed-in user never sees a flash.
  assert.equal(await gate.isVisible(), false)
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  assert.equal(await page.locator('.yisama-panel, [data-testid="assistant-badge"]').first().isVisible(), true)
  assert.equal(await gate.isVisible(), true)
  const box = await gate.boundingBox()
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 1280, 800])
  assert.match(await gate.textContent(), /YisamaAPI 账号登录/)
  assert.match(await gate.textContent(), /Sign in/)
  // The panel stays above the dim layer and clicking the layer does not dismiss it.
  await gate.click({ position: { x: 100, y: 100 } })
  assert.equal(await page.locator('[data-testid="auth-username"]').isVisible(), true)
  assert.equal(await gate.isVisible(), true)
  await page.locator('[data-testid="auth-username"]').click()
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'login-gate.png') })
  // Closing the panel releases the page; it is not re-opened by later status polls.
  await page.locator('[data-testid="close"]').click()
  assert.equal(await gate.isVisible(), false)
  await page.evaluate(() => window.__yisamaInfiniteAssistant.receive({ id: -1, ok: true }))
})

test('the dim layer disappears after sign-in and never appears for a signed-in user', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  const gate = page.locator('[data-testid="login-gate"]')
  await respond(await next('status'), { ok: true, data: signedIn() })
  assert.equal(await gate.isVisible(), false)
  assert.equal(await page.locator('[data-testid="auth-username"]').isVisible(), false)
})

test('the sign-in hint can be turned off for good', async (t) => {
  const app = await fixture(t)
  if (!app) return
  const { page, next, respond } = app
  const gate = page.locator('[data-testid="login-gate"]')
  await respond(await next('status'), { ok: true, data: loggedOut })
  await respond(await next('authOptions'), { ok: true, data: authOptions() })
  assert.equal(await gate.isVisible(), true)
  await page.locator('[data-testid="login-gate-dismiss"]').click()
  assert.equal(await gate.isVisible(), false)
  // The panel itself stays open so the user can still sign in.
  assert.equal(await page.locator('[data-testid="auth-username"]').isVisible(), true)
  assert.equal(await page.evaluate(() => localStorage.getItem('yisama-infinite-assistant-login-hint-dismissed-v1')), '1')
})
