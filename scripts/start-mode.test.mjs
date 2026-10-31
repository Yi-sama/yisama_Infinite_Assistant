import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { parse } from 'smol-toml'

test('start-mode configuration, prerequisites, billing and clipboard regressions', { timeout: 60000 }, async (t) => {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/api/pricing': ['api/pricing', 'application/json'],
    '/site/media/s1-city.jpg': ['site/media/s1-city.jpg', 'image/jpeg'],
    '/site/media/s3-tavern.jpg': ['site/media/s3-tavern.jpg', 'image/jpeg'],
    '/site/media/s2-whale.jpg': ['site/media/s2-whale.jpg', 'image/jpeg'],
  }
  const apiState = {
    quota: 2500000,
    key: { id: 7, name: '简洁模式', group: '不降智plus', status: 1 },
    secret: 'sk-formal-test-key-0123456789',
  }
  const apiCalls = []
  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString() || '{}'
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    apiCalls.push(url.pathname)
    const reply = (payload, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/api/user/auth/refresh') {
      return reply({ success: true, data: { user: { id: 42, username: 'formal-test' } } })
    }
    if (url.pathname === '/api/user/self') {
      return reply({ success: true, data: { id: 42, username: 'formal-test', quota: apiState.quota } })
    }
    if (url.pathname === '/api/token/search') {
      return reply({ success: true, data: { items: [apiState.key] } })
    }
    if (url.pathname === '/api/token/' && req.method === 'POST') {
      apiState.key = { ...apiState.key, id: 7, ...JSON.parse(await readBody(req)) }
      return reply({ success: true })
    }
    if (url.pathname === '/api/token/' && req.method === 'PUT') {
      apiState.key = { ...apiState.key, ...JSON.parse(await readBody(req)) }
      return reply({ success: true, data: apiState.key })
    }
    if (url.pathname === `/api/token/${apiState.key.id}/key`) {
      return reply({ success: true, data: { key: apiState.secret } })
    }
    if (url.pathname === '/api/log/self') return reply({ success: true, data: [] })
    const file = files[url.pathname]
    if (!file) { res.writeHead(404).end(); return }
    try {
      const body = await fs.readFile(new URL('../start-mode/' + file[0], import.meta.url))
      res.writeHead(200, { 'Content-Type': file[1] }).end(body)
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const browser = await chromium.launch({
    headless: true, channel: process.env.YISAMA_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
  })
  t.after(() => browser.close())
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text) {
          if (window.copyDenied) throw new DOMException('Denied', 'NotAllowedError')
          if (window.copyPending) await new Promise((resolve) => { window.finishCopy = resolve })
          window.copiedText = text
        },
      },
    })
  })
  const page = await context.newPage()
  const resizePage = async (viewport) => {
    await page.setViewportSize(viewport)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => document.getAnimations().every((animation) =>
      animation.effect.getTiming().iterations === Infinity || animation.playState === 'finished'))
  }
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/?demo`)
  await page.locator('[data-mode="simple"]').click()
  await page.locator('.js-vendors [data-vendor="openai"]').click()
  await page.locator('.js-make-key').click()
  await page.locator('.ready').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect.getTiming().iterations === Infinity || animation.playState === 'finished'))

  await t.test('homepage omits model credentials and keeps a generic model-service endpoint', async () => {
    assert.deepEqual(await page.locator('.creds dt').allTextContents(), ['API Key', 'Base URL'])
    assert.equal(await page.locator('.conn .conn__node').count(), 3)
    assert.equal(await page.locator('.conn .conn__wire').count(), 2)
    assert.equal(await page.locator('.conn__node--c span').textContent(), '大模型服务')
    assert.equal(await page.locator('.conn .js-model-inline, .creds .js-model').count(), 0)
    const model = parse(await page.locator('.guide .js-toml').textContent()).model
    assert.equal(model, 'gpt-6-luna')
    await page.locator('[data-open="settings"]').click()
    assert.equal(await page.locator('.js-set-models input:checked').inputValue(), model)
    await page.locator('#settings [aria-label="关闭"]').click()
    for (const width of [1440, 390, 320]) {
      await resizePage({ width, height: 900 })
      const connectionFits = await page.locator('.conn').evaluate((connection) => {
        const bounds = connection.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && connection.scrollWidth <= connection.clientWidth
      })
      assert.equal(connectionFits, true, `connection overflow at ${width}px`)
      // 单列版连接线是装饰性的小图，状态由标题和徽章说明，节点文字保留给读屏
      assert.deepEqual(await page.locator('.conn__node span').allTextContents(), [await page.locator('.js-app-name').textContent(), 'YisamaAPI', '大模型服务'])
    }
    await resizePage({ width: 1440, height: 900 })
  })

  await t.test('single-column home has no horizontal overflow and keeps config reachable', async () => {
    for (const [width, height] of [[1440, 900], [1366, 768], [1280, 640], [1024, 768], [390, 844], [320, 640]]) {
      await resizePage({ width, height })
      const layout = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        clipped: [...document.querySelectorAll('#hub .status, #hub .meters, #hub .panel, #hub .assist, #hub .fold, #hub .apps')]
          .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map((el) => el.className),
      }))
      assert.ok(layout.pageWidth <= width, `page widens at ${width}x${height}`)
      assert.deepEqual(layout.clipped, [], `panel clipped at ${width}x${height}`)
      await page.locator('.help button').last().scrollIntoViewIfNeeded()
      assert.equal(await page.locator('.help button').last().isVisible(), true, `tutorial entry hidden at ${width}`)
      await page.locator('.js-snippet summary').click()
      await page.locator('.js-snippet .copy').scrollIntoViewIfNeeded()
      assert.equal(await page.locator('.js-snippet .copy').isVisible(), true)
      await page.locator('.js-snippet summary').click()
    }
    await resizePage({ width: 1440, height: 900 })
  })

  await t.test('model market, applications, assistant and token usage stay visible', async () => {
    assert.equal(await page.locator('.market-link').getAttribute('href'), '/pricing')
    assert.equal(await page.locator('a[href="/rankings"], a[href*="feishu.cn"]').count(), 0)
    assert.deepEqual(await page.locator('#hub .app').evaluateAll((links) => links.map((link) => link.getAttribute('href'))), [
      '/image-studio',
      '/tavern',
      '/video-studio',
    ])
    await page.locator('[data-demo="ping"]').click()
    await page.locator('#hub .apps').waitFor({ state: 'visible' })
    const imagesLoaded = await page.locator('#hub .app').evaluateAll((links) => Promise.all(links.map(async (link) => {
      const image = new Image()
      image.src = getComputedStyle(link, '::before').backgroundImage.slice(5, -2)
      await image.decode()
      return image.naturalWidth > 0
    })))
    assert.deepEqual(imagesLoaded, [true, true, true])
    assert.deepEqual(await page.locator('[data-usage-range]').allTextContents(), ['今天', '3天', '7天', '30天', '全部'])
    assert.equal(await page.locator('[data-usage-range].is-on').getAttribute('data-usage-range'), 'today')
    await page.waitForFunction(() => document.querySelector('.js-token-total').textContent === '1.84')
    assert.equal(await page.locator('.js-token-unit').textContent(), '万 ')
    await page.locator('[data-usage-range="7d"]').click()
    await page.waitForFunction(() => document.querySelector('.js-token-total').textContent === '17.2')
    assert.equal(await page.locator('.usage__stat, .usage__stats, .bars').count(), 0)
    assert.equal(await page.locator('.usage__amount').isVisible(), true)
    assert.match(await page.locator('.js-token-feel').textContent(), /字/)
    const sevenDayTokens = await page.locator('.js-token-total').textContent()
    await page.locator('[data-usage-range="today"]').click()
    await page.waitForFunction((value) => document.querySelector('.js-token-total').textContent !== value, sevenDayTokens)
    assert.equal(await page.locator('[data-usage-range].is-on').getAttribute('data-usage-range'), 'today')
    await page.locator('[data-usage-range="all"]').click()
    await page.waitForFunction(() => document.querySelector('.js-token-total').textContent === '224')
    for (const [width, height] of [[1440, 900], [1280, 600], [390, 844], [320, 640]]) {
      await resizePage({ width, height })
      assert.equal(await page.locator('.apps').isVisible(), true, `applications hidden at ${width}px`)
      assert.equal(await page.locator('.market-link').isVisible(), true, `model market hidden at ${width}px`)
      assert.equal(await page.locator('[data-assist]').isVisible(), true, `assistant hidden at ${width}px`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}px`)
    }
    await resizePage({ width: 1440, height: 900 })
  })

  await t.test('connected users see status first, folded access, and a promoted assistant', async () => {
    assert.equal(await page.locator('.status').getAttribute('data-state'), 'ok')
    assert.match(await page.locator('.js-badge-text').textContent(), /正常/)
    assert.match(await page.locator('.js-assist-title').textContent(), /更快更强/)
    assert.match(await page.locator('.assist__tags').textContent(), /1\.5x/)
    assert.equal(await page.locator('.access').evaluate((el) => el.classList.contains('is-folded')), true)
    assert.equal(await page.locator('.cred--key').isVisible(), true)
    assert.equal(await page.locator('.js-base').isVisible(), false)
    for (const [width, height] of [[1440, 900], [1366, 768]]) {
      await resizePage({ width, height })
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), `connected home scrolls at ${width}x${height}`)
    }
    await page.locator('.js-access-toggle').click()
    assert.equal(await page.locator('.js-base').isVisible(), true)
    assert.equal(await page.locator('.help button').last().isVisible(), true)
    await page.locator('.js-reach-fold summary').click()
    assert.equal(await page.locator('.js-reach li').first().isVisible(), true)
    await page.locator('[data-demo="low"]').click()
    await page.waitForFunction(() => document.querySelector('.status').dataset.state === 'low')
    assert.match(await page.locator('.js-headline').textContent(), /余额/)
    await page.evaluate(() => { localStorage.setItem('ys.start.balance', '5') })
    await page.reload()
    await page.locator('.ready').waitFor({ state: 'visible' })
  })

  await t.test('home steps and headline follow the chosen tool, not only Codex', async () => {
    const cases = [
      ['claude', 'claude-code', /Claude Code/, /PowerShell/, /claude/],
      ['cn', 'chat', /聊天软件/, /聊天软件/, /选一个模型/],
      ['cn', 'code', /程序/, /程序/, /运行/],
    ]
    for (const [vendor, use, headline, step2, step3] of cases) {
      await page.evaluate(([vendor, use]) => {
        localStorage.setItem('ys.start.vendor', JSON.stringify(vendor))
        localStorage.setItem('ys.start.use', JSON.stringify(use))
        localStorage.setItem('ys.start.live', 'false')
      }, [vendor, use])
      await page.reload()
      await page.locator('.ready').waitFor({ state: 'visible' })
      const head = await page.locator('.js-headline').textContent()
      assert.match(head, headline)
      assert.doesNotMatch(head + await page.locator('.js-step2').textContent() + await page.locator('.js-step3').textContent(), /Codex/)
      assert.match(await page.locator('.js-step2').textContent(), step2)
      assert.match(await page.locator('.js-step3').textContent(), step3)
      assert.doesNotMatch(head, / 聊天软件| 程序/)
    }
    await page.evaluate(() => {
      localStorage.setItem('ys.start.vendor', JSON.stringify('openai'))
      localStorage.setItem('ys.start.use', JSON.stringify('codex'))
      localStorage.setItem('ys.start.model', JSON.stringify('gpt-6-luna'))
      localStorage.setItem('ys.start.group', JSON.stringify('不降智plus'))
      localStorage.setItem('ys.start.live', 'true')
    })
    await page.reload()
    await page.locator('.ready').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.js-fuel-pct, .fuel').count(), 0)
  })

  await t.test('both tutorials start with explicit installation confirmation', async () => {
    await page.locator('[data-guide="cli"]').click()
    await page.locator('[data-step="0"]').waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-install="cli"]').isVisible(), true)
    assert.equal(await page.locator('.js-version').textContent(), 'codex --version')
    assert.match(await page.locator('.js-install-next').textContent(), /版本号/)
    await page.locator('[data-step="0"] .js-install-next').click()
    await page.locator('[data-step="1"]').waitFor({ state: 'visible' })
    await page.locator('#guide > [data-home]').click()
    await page.locator('[data-guide="desktop"]').click()
    await page.locator('[data-step="0"]').waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-install="desktop"]').isVisible(), true)
    assert.match(await page.locator('[data-install="desktop"] a').getAttribute('href'), /^https:\/\/developers\.openai\.com\/codex\/app\/windows$/)
    assert.match(await page.locator('.js-install-next').textContent(), /打开 Codex 桌面版/)
    await page.locator('[data-pick="cli"]').click()
    assert.equal(await page.locator('[data-install="cli"]').isVisible(), true)
    await page.locator('.js-install-next').click()
    await page.locator('[data-step="1"]').waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-tab="auto"], .js-oneliner').count(), 0)
    assert.doesNotMatch(await page.content(), /codex\.ps1/)
  })

  await t.test('TOML snippets separate root fields from provider settings and document merging', async () => {
    const full = await page.locator('.guide .js-toml').textContent()
    const root = await page.locator('.js-root-toml').textContent()
    const provider = await page.locator('.js-provider-toml').textContent()
    assert.equal(full, root + '\n\n' + provider)
    const config = parse(full)
    assert.equal(config.model_provider, 'yisama')
    assert.equal(config.model_providers.yisama.env_key, 'YISAMA_API_KEY')
    const help = await page.locator('[data-step="1"]').textContent()
    for (const expected of ['先复制一份备份', '不要直接', '第一个', '缺少的才新增', '不要重复创建同名表', 'CODEX_HOME']) {
      assert.ok(help.includes(expected), expected)
    }
    // Apply the documented placement to files ending in unrelated tables.
    for (const middle of [
      'approval_policy = "on-request"\n\n[mcp_servers.local]\ncommand = "local-tool"',
      'sandbox_mode = "workspace-write"\n\n[profiles.work]\nmodel_reasoning_effort = "high"',
    ]) {
      const merged = parse(root + '\n' + middle + '\n\n' + provider)
      assert.equal(merged.model, config.model)
      assert.equal(merged.model_provider, 'yisama')
      assert.deepEqual(merged.model_providers, config.model_providers)
      for (const [key, value] of Object.entries(parse(middle))) assert.deepEqual(merged[key], value)
    }
    await page.locator('.guide details').filter({ hasText: '没有旧文件：新建配置' }).locator('summary').click()
    await page.locator('.guide [data-copy=".js-toml"]').click()
    await page.waitForFunction((text) => window.copiedText === text, full)
  })

  await t.test('historical spending stays unchanged after model and group changes and reload', async () => {
    await page.locator('#guide > [data-home]').click()
    await page.locator('[data-usage-range="7d"]').click()
    await page.locator('[data-demo="ping"]').click()
    await page.waitForFunction(() => document.querySelector('.js-week-cost').textContent.includes('1.27'))
    const before = await page.locator('.js-week-cost').textContent()
    if (!(await page.locator('.js-reach-fold').getAttribute('open') !== null)) await page.locator('.js-reach-fold summary').click()
    await page.locator('.js-reach [data-model="gpt-6-astra"]').click()
    assert.equal(await page.locator('.conn__node--c span').textContent(), '大模型服务')
    await page.reload()
    assert.equal(await page.locator('.conn__node--c span').textContent(), '大模型服务')
    await page.locator('[data-usage-range="7d"]').click()
    await page.waitForFunction((text) => document.querySelector('.js-week-cost').textContent === text, before)
    await page.locator('[data-open="settings"]').click()
    const group = await page.locator('.js-set-groups input:not(:checked)').first().getAttribute('value')
    await page.locator(`.js-set-groups input[value="${group}"]`).check()
    await page.waitForFunction((value) => document.querySelector('.js-group-tag').textContent.includes(value), group)
    await page.waitForFunction((text) => document.querySelector('.js-week-cost').textContent === text, before)
    await page.locator('#settings [aria-label="关闭"]').click()
    await page.reload()
    await page.locator('[data-usage-range="7d"]').click()
    await page.waitForFunction((text) => document.querySelector('.js-week-cost').textContent === text, before)
    assert.equal(await page.locator('.js-call-total').textContent(), '111')
  })

  await t.test('copy only reports success after completion and shows denied permission', async () => {
    const button = page.locator('[data-copy-key]')
    await page.evaluate(() => { window.copyPending = true })
    await button.click()
    assert.equal(await button.isDisabled(), true)
    assert.doesNotMatch(await button.getAttribute('class'), /is-copied/)
    await page.evaluate(() => window.finishCopy())
    await page.waitForFunction(() => document.querySelector('[data-copy-key]').classList.contains('is-copied'))
    assert.match(await page.evaluate(() => window.copiedText), /^sk-/)
    await page.waitForFunction(() => !document.querySelector('[data-copy-key]').disabled)
    await page.evaluate(() => { window.copyDenied = true })
    await button.click()
    await page.waitForFunction(() => document.querySelector('[data-copy-key]').textContent === '复制失败')
    assert.doesNotMatch(await button.getAttribute('class'), /is-copied/)
    assert.match(await page.locator('.toast').textContent(), /手动复制/)
    await page.waitForFunction(() => !document.querySelector('[data-copy-key]').disabled)
    assert.equal(await button.textContent(), '复制')
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }) })
    await button.click()
    await page.waitForFunction(() => document.querySelector('[data-copy-key]').textContent === '复制失败')
    assert.doesNotMatch(await button.getAttribute('class'), /is-copied/)
  })

  await t.test('installation and expanded configuration fit desktop and narrow screens', async () => {
    await page.goto(page.url().replace('?demo', ''))
    await page.locator('.ready').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => localStorage.getItem('ys.start.key')), null)
    assert.notEqual(await page.locator('.js-key').textContent(), apiState.secret)
    assert.equal(apiCalls.filter((path) => path === '/api/user/auth/refresh').length, 1)
    await page.locator('.eye').click()
    assert.equal(await page.locator('.js-key').textContent(), apiState.secret)
    for (const width of [1440, 390, 320]) {
      await resizePage({ width, height: 900 })
      if (await page.locator('.js-access-toggle').isVisible() && !(await page.locator('.js-base').isVisible())) await page.locator('.js-access-toggle').click()
      await page.locator('[data-guide="cli"]').click()
      await page.locator('[data-step="0"]').waitFor({ state: 'visible' })
      const capture = async (name) => {
        if (!process.env.YISAMA_START_SCREENSHOTS) return
        await fs.mkdir(process.env.YISAMA_START_SCREENSHOTS, { recursive: true })
        await page.evaluate(() => scrollTo(0, 0))
        await page.screenshot({
          path: path.join(process.env.YISAMA_START_SCREENSHOTS, `${name}-${width}.png`),
          fullPage: true, animations: 'disabled',
        })
      }
      await capture('install')
      await page.locator('.js-install-next').click()
      await page.locator('[data-step="1"]').waitFor({ state: 'visible' })
      for (const detail of await page.locator('[data-step="1"] details').all()) {
        if (await detail.getAttribute('open') === null) await detail.locator('summary').click()
      }
      if (width === 1440) {
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'expanded tutorial grows the page')
        await page.locator('[data-step="1"] .actions [data-next]').scrollIntoViewIfNeeded()
        assert.ok(await page.locator('.stage').evaluate((stage) => stage.scrollTop > 0), 'expanded tutorial must scroll inside its stage')
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}px`)
      if (width <= 390) {
        const clippedCode = await page.locator('#guide .cmd code, #guide .code').evaluateAll((blocks) =>
          blocks.filter((block) => block.getClientRects().length && block.scrollWidth > block.clientWidth + 1).map((block) => block.textContent))
        assert.deepEqual(clippedCode, [], `code overflow at ${width}px`)
      }
      const clippedButtons = await page.locator('#guide button').evaluateAll((buttons) =>
        buttons.filter((button) => button.getClientRects().length && button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent))
      assert.deepEqual(clippedButtons, [], `button overflow at ${width}px`)
      await capture('config')
      await page.locator('#guide > [data-home]').click()
      await page.locator('#hub').waitFor({ state: 'visible' })
    }
  })

  assert.deepEqual(errors, [])
})
