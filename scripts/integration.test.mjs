import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'smol-toml'
import { chromium } from 'playwright'
import { configureCodex, makeModelCatalog, readOptional, replaceFile, restoreCodex } from './codex-config.mjs'
import { waitForPortalLogin } from './yisama.mjs'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('./yisama.mjs', import.meta.url))
const apiKey = 'sk-0123456789abcdefghijklmnopqrstuv'
const dashboardToken = 'dashboard-token-for-local-tests-only'

test('original backups survive group changes and restore preserves later personal edits and the original catalog', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-backup-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    session: path.join(root, 'data/session.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const personalCatalog = path.join(root, 'personal-catalog.json')
  const originalConfig = stringify({ model: 'personal-model', model_catalog_json: personalCatalog,
    profile: 'work', profiles: { work: { model: 'personal-model', model_catalog_json: personalCatalog } } })
  const originalAuth = '{"auth_mode":"chatgpt","personal":"original"}\n'
  await replaceFile(personalCatalog, '{"models":[]}\n')
  await replaceFile(files.codexConfig, originalConfig)
  await replaceFile(files.codexAuth, originalAuth)
  let state = await configureCodex({
    files, apiKey: 'sk-test-group-one', model: 'gemini-3-flash', reasoning: null,
    catalog: makeModelCatalog(['gemini-3-flash']),
  })
  const firstCatalog = state.catalogPath
  state = await configureCodex({
    files, state, apiKey: 'sk-test-group-two', model: 'claude-opus-4-6', reasoning: null,
    catalog: makeModelCatalog(['claude-opus-4-6']),
  })
  assert.equal(await fs.readFile(state.backups.config, 'utf8'), originalConfig)
  assert.equal(await fs.readFile(state.backups.auth, 'utf8'), originalAuth)
  assert.equal(await fs.readFile(personalCatalog, 'utf8'), '{"models":[]}\n')
  const current = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(current.model_catalog_json, state.catalogPath)
  assert.equal(current.profiles.work.model_catalog_json, state.catalogPath)
  current.personal_after_install = true
  await replaceFile(files.codexConfig, stringify(current))
  const auth = JSON.parse(await fs.readFile(files.codexAuth, 'utf8'))
  auth.later_personal_setting = true
  await replaceFile(files.codexAuth, JSON.stringify(auth))
  await replaceFile(firstCatalog, '{"personally_edited":true}\n')
  await restoreCodex(files, state)
  const restored = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(restored.model, 'personal-model')
  assert.equal(restored.model_catalog_json, personalCatalog)
  assert.equal(restored.profiles.work.model_catalog_json, personalCatalog)
  assert.equal(restored.personal_after_install, true)
  assert.deepEqual(JSON.parse(await fs.readFile(files.codexAuth, 'utf8')), {
    auth_mode: 'chatgpt', personal: 'original', later_personal_setting: true,
  })
  assert.equal(await fs.readFile(firstCatalog, 'utf8'), '{"personally_edited":true}\n')
  assert.equal(await fs.readFile(personalCatalog, 'utf8'), '{"models":[]}\n')
  await assert.rejects(fs.access(state.catalogPath), { code: 'ENOENT' })
  await assert.rejects(fs.access(files.state), { code: 'ENOENT' })
})

test('missing original backup stops further configuration changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-backup-missing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const state = await configureCodex({ files, apiKey: 'sk-test-original', model: 'gpt-test' })
  const before = await Promise.all([files.codexConfig, files.codexAuth, files.state].map((file) => fs.readFile(file, 'utf8')))
  await fs.rm(state.backups.config)
  await assert.rejects(configureCodex({ files, state, apiKey: 'sk-test-other', model: 'gemini-test' }), /备份不完整/)
  assert.deepEqual(await Promise.all([files.codexConfig, files.codexAuth, files.state].map((file) => fs.readFile(file, 'utf8'))), before)
})

test('missing applied snapshots stop restoration without deleting the remaining backups', async (t) => {
  for (const missing of ['appliedConfig', 'appliedAuth']) {
    await t.test(missing, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-restore-missing-'))
      t.after(() => fs.rm(root, { recursive: true, force: true }))
      const files = {
        pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
        session: path.join(root, 'data/session.json'),
        codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
      }
      const state = await configureCodex({ files, apiKey: 'sk-test-original', model: 'gpt-test' })
      await replaceFile(files.session, '{"test_session":true}\n')
      await fs.rm(state.backups[missing])
      const protectedFiles = [files.codexConfig, files.codexAuth, files.state, files.session,
        ...['config', 'auth', 'appliedConfig', 'appliedAuth']
          .filter((name) => name !== missing).map((name) => state.backups[name])]
      const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8')))
      await assert.rejects(restoreCodex(files, state), /快照缺失/)
      assert.deepEqual(await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8'))), before)
    })
  }
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const files = {
    pluginData: path.join(root, 'data'),
    state: path.join(root, 'data', 'state.json'),
    session: path.join(root, 'data', 'session.json'),
    codexConfig: path.join(root, 'codex', 'config.toml'),
    codexAuth: path.join(root, 'codex', 'auth.json'),
  }
  const state = {
    keys: [], calls: [], fastAvailable: true, fast: true, quota: 6250000,
    account: { id: 7, username: 'demo', display_name: 'Demo' },
  }
  let origin
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : undefined
    state.calls.push({ path: url.pathname, method: req.method, body, headers: req.headers })
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/status') return reply({
      success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' },
    })
    if (url.pathname === '/sign-in') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><html><title>Local portal test</title><button id="login">Login</button></html>')
    }
    if (url.pathname === '/api/user/login') return reply({ success: false, message: 'Wrong password' })
    if (url.pathname === '/api/user/login/2fa') {
      return reply({ success: true, data: { access_token: dashboardToken } })
    }
    if (url.pathname === '/api/user/auth/refresh') {
      if (req.headers.cookie !== 'new_api_refresh=old-refresh' || req.headers.origin !== origin ||
        req.headers['x-auth-session'] !== 'session-7') return reply({ success: false }, 401)
      res.setHeader('set-cookie', 'new_api_refresh=new-refresh; Path=/api/user/auth; HttpOnly; SameSite=Strict')
      return reply({ success: true, data: {
        access_token: dashboardToken, access_expires_at: Math.floor(Date.now() / 1000) + 600,
        session: { sid: 'session-7' }, user: { ...state.account, quota: state.quota },
      } })
    }
    if (url.pathname === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return reply({ success: false }, 401)
      return reply({ object: 'list', data: [{ id: 'gpt-5-codex' }, { id: 'gpt-5' }] })
    }
    if (req.headers.authorization !== `Bearer ${dashboardToken}`) return reply({ success: false }, 401)
    if (url.pathname === '/api/user/self') return reply({
      success: true, data: { ...state.account, quota: state.quota },
    })
    if (url.pathname === '/api/user/self/groups') return reply({
      success: true, data: { auto: { desc: 'All' }, premium: { ratio: 2 } },
    })
    if (url.pathname === '/api/token/search') return reply({ success: true, data: { items: state.keys } })
    if (url.pathname === '/api/token/' && req.method === 'POST') {
      state.keys.push({ ...body, id: state.keys.length + 1, status: 1,
        fast_mode_available: state.fastAvailable })
      return reply({ success: true })
    }
    if (url.pathname === '/api/token/' && req.method === 'PUT') {
      Object.assign(state.keys.find((item) => item.id === body.id), body)
      state.fast = body.fast_mode
      return reply({ success: true, data: state.keys.find((item) => item.id === body.id) })
    }
    if (/^\/api\/token\/\d+\/key$/.test(url.pathname)) return reply({ success: true, data: { key: apiKey } })
    if (/^\/api\/token\/\d+$/.test(url.pathname)) {
      const key = state.keys.find((item) => item.id === Number(url.pathname.split('/').at(-1)))
      return reply({ success: true, data: { ...key, fast_mode: state.fast, fast_mode_available: state.fastAvailable } })
    }
    reply({ success: false }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), PLUGIN_DATA: files.pluginData,
    YISAMA_PORTAL_URL: origin, NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  await replaceFile(path.join(env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-5-codex', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      .map((effort) => ({ effort })) },
    { slug: 'gpt-5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  ] }))
  await replaceFile(files.session, JSON.stringify({ origin, token: dashboardToken }))
  const cli = (...args) => exec(process.execPath, [script, ...args], { env, timeout: 30000 })
  return { root, files, state, origin, env, cli }
}

test('setup, status, group/model switching and restore use isolated local files and wallet data', async (t) => {
  const { files, state, cli } = await fixture(t)
  const originalConfig = '# personal config\nmodel = "old-model"\nmodel_reasoning_effort = "high"\n[features]\nexample = true\n'
  const originalAuth = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { test: 'original' } })
  await replaceFile(files.codexConfig, originalConfig)
  await replaceFile(files.codexAuth, originalAuth)
  const setup = await cli('setup', '--group', 'all')
  assert.match(setup.stdout, /当前分组：All/)
  assert.match(setup.stdout, /剩余额度：\$12.50/)
  assert.match(setup.stdout, /Fast：已开启/)
  assert.match(setup.stdout, /思考等级：高/)
  assert.doesNotMatch(setup.stdout + setup.stderr, /sk-012345|dashboard-token|Endpoint|Header/)
  assert.deepEqual(state.keys[0].auto_groups, [])
  assert.equal(state.keys[0].model_limits_enabled, false)
  let config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(config.model_provider, 'yisama')
  assert.equal(config.service_tier, 'fast')
  assert.equal(config.model_reasoning_effort, 'high')
  assert.equal(config.model_providers.yisama.requires_openai_auth, true)
  assert.equal(config.model_providers.yisama.env_key, undefined)
  assert.equal(JSON.parse(await fs.readFile(files.codexAuth, 'utf8')).auth_mode, 'apikey')
  assert.doesNotMatch(await fs.readFile(files.state, 'utf8'), /sk-012345|dashboard-token/)
  state.quota = 5000000
  state.fast = false
  const status = await cli('status')
  assert.match(status.stdout, /剩余额度：\$10.00/)
  assert.match(status.stdout, /Fast：未就绪/)
  assert.match(status.stdout, /思考等级：高/)
  state.fast = true
  const levels = await cli('reasoning')
  assert.match(levels.stdout, /ultra/)
  assert.match(levels.stdout, /auto/)
  const ultra = await cli('reasoning', '--level', 'ultra')
  assert.match(ultra.stdout, /思考等级：极致（Ultra）/)
  assert.match(ultra.stdout, /额度消耗/)
  assert.doesNotMatch(ultra.stdout + ultra.stderr, /sk-012345|dashboard-token/)
  await cli('select', '--group', 'premium')
  assert.equal(state.keys.length, 1)
  assert.equal(state.keys[0].group, 'premium')
  assert.equal(state.keys[0].fast_mode, false)
  assert.equal(parse(await fs.readFile(files.codexConfig, 'utf8')).service_tier, undefined)
  assert.equal(parse(await fs.readFile(files.codexConfig, 'utf8')).model_reasoning_effort, 'ultra')
  await cli('select', '--group', 'all')
  assert.equal(state.keys.length, 1, 'existing assistant credential is reused')
  const switched = await cli('model', '--name', 'gpt-5')
  assert.match(switched.stdout, /思考等级：自动/)
  assert.match(switched.stdout, /恢复模型默认/)
  config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(config.model, 'gpt-5')
  assert.equal(config.model_reasoning_effort, undefined)
  const beforeInvalid = await fs.readFile(files.codexConfig, 'utf8')
  for (const args of [
    ['reasoning', '--level', 'ultra'],
    ['model', '--name', 'gpt-5', '--reasoning', 'ultra'],
  ]) {
    await assert.rejects(cli(...args), (error) => {
      assert.match(error.stderr, /此模型未列出/)
      return true
    })
    assert.equal(await fs.readFile(files.codexConfig, 'utf8'), beforeInvalid)
  }
  await cli('model', '--name', 'gpt-5-codex', '--reasoning', 'ultra')
  assert.equal(parse(await fs.readFile(files.codexConfig, 'utf8')).model_reasoning_effort, 'ultra')
  await cli('reasoning', '--level', 'auto')
  assert.equal(parse(await fs.readFile(files.codexConfig, 'utf8')).model_reasoning_effort, undefined)
  config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  config.features.user_added = true
  await replaceFile(files.codexConfig, stringify(config))
  await cli('restore')
  config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(config.model, 'old-model')
  assert.equal(config.model_reasoning_effort, 'high')
  assert.equal(config.model_provider, undefined)
  assert.equal(config.model_providers, undefined)
  assert.equal(config.features.user_added, true)
  assert.equal(await fs.readFile(files.codexAuth, 'utf8'), originalAuth)
  assert.equal(await readOptional(files.session), null)
  assert.equal(await readOptional(files.state), null)
})

test('an explicit model catalog overrides cached Ultra support, including active profiles', async (t) => {
  const { files, cli } = await fixture(t)
  await replaceFile(path.join(path.dirname(files.codexConfig), 'catalog.json'), JSON.stringify({ models: [
    { slug: 'gpt-5-codex', supported_reasoning_levels: [{ effort: 'high' }] },
  ] }))
  const original = `profile = "work"
model_reasoning_effort = "low"
[profiles.work]
model_catalog_json = "catalog.json"
model_reasoning_effort = "high"
`
  await replaceFile(files.codexConfig, original)
  await assert.rejects(cli('setup', '--group', 'all', '--reasoning', 'ultra'), (error) => {
    assert.match(error.stderr, /此模型未列出/)
    return true
  })
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), original)
  assert.equal(await readOptional(files.codexAuth), null)
  await cli('setup', '--group', 'all', '--reasoning', 'high')
  const levels = await cli('reasoning')
  assert.doesNotMatch(levels.stdout, /ultra/)
  await cli('reasoning', '--level', 'auto')
  const config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(config.model_reasoning_effort, undefined)
  assert.equal(config.profiles.work.model_reasoning_effort, undefined)
  await cli('model', '--name', 'gpt-5')
  const unknown = await cli('reasoning')
  assert.match(unknown.stdout, /暂无法确认/)
  await assert.rejects(cli('reasoning', '--level', 'ultra'), (error) => {
    assert.match(error.stderr, /暂无法确认/)
    return true
  })
})

test('restore keeps a later personal reasoning change instead of reverting it', async (t) => {
  const { files, cli } = await fixture(t)
  await replaceFile(files.codexConfig, 'model = "old-model"\nmodel_reasoning_effort = "low"\n')
  await cli('setup', '--group', 'all', '--reasoning', 'ultra')
  const config = parse(await fs.readFile(files.codexConfig, 'utf8'))
  config.model_reasoning_effort = 'high'
  await replaceFile(files.codexConfig, stringify(config))
  await cli('restore')
  const restored = parse(await fs.readFile(files.codexConfig, 'utf8'))
  assert.equal(restored.model, 'old-model')
  assert.equal(restored.model_reasoning_effort, 'high')
})

test('unavailable Fast stops before changing Codex configuration', async (t) => {
  const { files, state, cli } = await fixture(t)
  state.fastAvailable = false
  const config = 'model = "original"\n'
  await replaceFile(files.codexConfig, config)
  await assert.rejects(cli('setup', '--group', 'all'), (error) => {
    assert.match(error.stderr, /暂不能启用 Fast/)
    assert.doesNotMatch(error.stderr, /sk-012345|dashboard-token/)
    return true
  })
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), config)
  assert.equal(await readOptional(files.codexAuth), null)
})

test('expired dashboard login refreshes its scoped cookie and persists rotation', async (t) => {
  const { files, origin, cli, state } = await fixture(t)
  await replaceFile(files.session, JSON.stringify({
    origin, token: 'expired-dashboard-token', expiresAt: 1, sessionId: 'session-7',
    cookies: [{
      name: 'new_api_refresh', value: 'old-refresh', domain: '127.0.0.1',
      path: '/api/user/auth', httpOnly: true, secure: false, sameSite: 'Strict', expires: -1,
    }],
  }))
  const result = await cli('groups')
  assert.match(result.stdout, /All/)
  assert.match(result.stdout, /premium/)
  const session = JSON.parse(await fs.readFile(files.session, 'utf8'))
  assert.equal(session.token, dashboardToken)
  assert.equal(session.cookies[0].value, 'new-refresh')
  assert.equal(state.calls.filter((call) => call.path === '/api/user/auth/refresh').length, 1)
  assert.doesNotMatch(result.stdout + result.stderr, /old-refresh|new-refresh|dashboard-token/)
})

test('failed authentication write rolls config back and leaves the original backup recoverable', async (t) => {
  const { files, origin } = await fixture(t)
  const original = 'model = "personal"\n'
  await replaceFile(files.codexConfig, original)
  await assert.rejects(configureCodex({
    files, apiKey, origin, model: 'gpt-5-codex',
    write: async (file, text) => {
      if (file === files.codexAuth) throw new Error('simulated disk failure')
      await replaceFile(file, text)
    },
  }), /simulated disk failure/)
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), original)
  assert.equal(await readOptional(files.codexAuth), null)
  const state = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.equal(await fs.readFile(state.backups.config, 'utf8'), original)
  await restoreCodex(files, state)
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), original)
})

test('browser login accepts a later successful 2FA response, not the first failed login', async (t) => {
  const { origin } = await fixture(t)
  const browser = await chromium.launch({
    headless: true, channel: process.env.YISAMA_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
  })
  t.after(() => browser.close())
  const context = await browser.newContext()
  const page = await context.newPage()
  const pending = waitForPortalLogin(context, origin, 15000)
  await page.goto(`${origin}/sign-in`)
  await page.evaluate(() => fetch('/api/user/login?turnstile=test', { method: 'POST' }))
  await page.evaluate(() => fetch('/api/user/login/2fa', { method: 'POST', body: JSON.stringify({ code: '123456' }) }))
  const result = await pending.promise
  assert.equal(result.data.access_token, dashboardToken)
  assert.equal(context.listenerCount('response'), 0)
  const canceled = waitForPortalLogin(context, origin, 15000)
  await context.close()
  await assert.rejects(canceled.promise, /已取消/)
})
