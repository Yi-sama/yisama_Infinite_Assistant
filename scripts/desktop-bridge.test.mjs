import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parse, stringify } from 'smol-toml'

const bridgeScript = fileURLToPath(new URL('./desktop-bridge.mjs', import.meta.url))
const apiKey = 'sk-bridge-test-key-that-must-never-reach-stdio'
const dashboardToken = 'dashboard-token-that-must-never-reach-stdio'

async function fixture(t, { groups = { auto: { desc: 'All' }, premium: { ratio: 2 } },
  cached = true, twoFactor = false, emailVerification = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-desktop-bridge-'))
  const pluginData = path.join(root, 'data')
  const codexHome = path.join(root, 'codex')
  let origin
  const state = {
    keys: [],
    calls: [],
    groups, groupModels: {}, fastUnavailableGroups: [],
    models: ['gpt-5-codex', 'gpt-5'],
    account: { id: 7, username: 'demo', display_name: 'Demo', quota: 6250000 },
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) : undefined
    state.calls.push({ path: url.pathname, method: req.method, body, email: url.searchParams.get('email') })
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/status') {
      return reply({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
    }
    if (url.pathname === '/api/assistant/auth/options') {
      return reply({ success: true, data: {
        password_login_enabled: true, register_enabled: true, email_verification_enabled: emailVerification,
      } })
    }
    const authBundle = () => {
      res.setHeader('set-cookie', 'new_api_refresh=desktop-refresh; Path=/api/user/auth; HttpOnly; SameSite=Strict')
      return reply({ success: true, data: {
        access_token: dashboardToken, access_expires_at: Math.floor(Date.now() / 1000) + 600,
        session: { sid: 'desktop-session' }, user: state.account,
      } })
    }
    if (url.pathname === '/api/assistant/auth/login') {
      if (state.authFailure) return reply({ success: false, message: dashboardToken }, state.authFailure)
      if (body.username !== 'demo' || body.password !== 'local-password') {
        return reply({ success: false, message: `Wrong password: ${body.password}; ${dashboardToken}` })
      }
      return twoFactor ? reply({ success: true, data: {
        require_2fa: true, flow_token: 'private-two-factor-flow', expires_at: Math.floor(Date.now() / 1000) + 300,
      } }) : authBundle()
    }
    if (url.pathname === '/api/assistant/auth/login/2fa') {
      if (body.flow_token !== 'private-two-factor-flow' || body.code !== '123456') {
        return reply({ success: false, message: `Bad code ${body.code}; private-two-factor-flow` })
      }
      return authBundle()
    }
    if (url.pathname === '/api/assistant/auth/register') {
      if (body.username !== 'new-user' || (emailVerification && body.verification_code !== '654321')) {
        return reply({ success: false, message: `Registration rejected: ${body.password}` })
      }
      return reply({ success: true })
    }
    if (url.pathname === '/api/assistant/auth/verification') return reply({ success: true })
    if (url.pathname === '/api/assistant/auth/password-reset/verification') {
      return state.resetSendFailure
        ? reply({ success: false, message: dashboardToken }, state.resetSendFailure)
        : reply({ success: true })
    }
    if (url.pathname === '/api/assistant/auth/password-reset') {
      if (body.verification_code !== '987654') {
        return reply({ success: false, message: `Bad code ${body.verification_code}; ${body.password}; ${dashboardToken}` })
      }
      return reply({ success: true })
    }
    if (url.pathname === '/api/user/auth/refresh') {
      if (req.headers.cookie !== 'new_api_refresh=desktop-refresh' || req.headers.origin !== origin ||
        req.headers['x-auth-session'] !== 'desktop-session') return reply({ success: false }, 401)
      return authBundle()
    }
    if (url.pathname === '/v1/models') {
      const key = state.keys.find((item) => req.headers.authorization === `Bearer ${apiKey}-${item.id}`)
      if (!key) return reply({ success: false }, 401)
      return reply({ object: 'list', data: (state.groupModels[key.group] || state.models)
        .map((id) => ({ id, ...state.modelMetadata?.[key.group]?.[id] })) })
    }
    if (req.headers.authorization !== `Bearer ${dashboardToken}`) return reply({ success: false }, 401)
    if (url.pathname === '/api/user/self' || url.pathname === '/api/user/self/balance') {
      if (state.accountFailure) return reply({ success: false }, state.accountFailure)
      return reply({ success: true, data: state.account })
    }
    if (url.pathname === '/api/user/topup' && req.method === 'POST') {
      if (body?.key !== 'valid-redeem-code') return reply({ success: false, message: 'redeem failed' })
      state.account.quota += 500000
      return reply({ success: true, data: 500000 })
    }
    if (url.pathname === '/api/user/self/groups') {
      return reply({ success: true, data: state.groups })
    }
    if (url.pathname === '/api/token/search') {
      return reply({ success: true, data: {
        items: state.keys.filter((item) => !url.searchParams.get('keyword') || item.name === url.searchParams.get('keyword')),
      } })
    }
    if (url.pathname === '/api/token/' && req.method === 'POST') {
      if (state.createKeyFailure) return reply({ success: false }, 503)
      state.keys.push({ ...body, id: state.keys.length + 1, status: 1,
        user_id: state.account.id,
        fast_mode_available: !state.fastUnavailableGroups.includes(body.group) })
      return reply({ success: true })
    }
    if (url.pathname === '/api/token/' && req.method === 'PUT') {
      if (url.searchParams.get('fast_mode_only') === 'true') {
        if (state.fastUpdateFailure) return reply({ success: false }, 503)
        const key = state.keys.find((item) => item.id === body.id)
        if (!state.ignoreFastUpdate) key.fast_mode = body.fast_mode
        return reply({ success: true, data: { ...key } })
      }
      Object.assign(state.keys.find((item) => item.id === body.id), body)
      return reply({ success: true })
    }
    if (/^\/api\/token\/\d+\/key$/.test(url.pathname)) {
      return reply({ success: true, data: { key: `${apiKey}-${url.pathname.split('/').at(-2)}` } })
    }
    if (/^\/api\/token\/\d+$/.test(url.pathname)) {
      const key = state.keys.find((item) => item.id === Number(url.pathname.split('/').at(-1)))
      return reply({ success: true, data: { ...key,
        fast_mode_available: !state.fastUnavailableGroups.includes(key.group) } })
    }
    return reply({ success: false }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const files = {
    session: path.join(pluginData, 'session.json'),
    state: path.join(pluginData, 'state.json'),
    config: path.join(codexHome, 'config.toml'),
  }
  const originalConfig = 'model = "personal-model"\nmodel_reasoning_effort = "low"\n'
  await fs.mkdir(pluginData, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  if (cached) await fs.writeFile(files.session, JSON.stringify({ origin, token: dashboardToken }), 'utf8')
  await fs.writeFile(files.config, originalConfig, 'utf8')
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-5-codex', supported_reasoning_levels: ['low', 'high', 'xhigh', 'max', 'ultra']
      .map((effort) => ({ effort })) },
    { slug: 'gpt-5', supported_reasoning_levels: ['low', 'high', 'xhigh'].map((effort) => ({ effort })) },
  ] }), 'utf8')
  t.after(async () => {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    files,
    originalConfig,
    state,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PLUGIN_DATA: pluginData,
      YISAMA_PORTAL_URL: origin,
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
    },
  }
}

function bridgeClient(env) {
  const args = env.YISAMA_TEST_BUNDLED_ASSISTANT ? ['--input-type=module', '-e', `
    import readline from 'node:readline';
    import { createRequestQueue } from ${JSON.stringify(pathToFileURL(env.YISAMA_TEST_BUNDLED_ASSISTANT).href)};
    const request = createRequestQueue();
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity }))
      process.stdout.write(JSON.stringify(await request(line)) + '\\n');
  `] : [bridgeScript]
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const pending = []
  const responses = []
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  output.on('line', (line) => {
    const response = JSON.parse(line)
    const resolve = pending.shift()
    if (resolve) resolve(response)
    else responses.push(response)
  })
  const next = () => new Promise((resolve) => {
    const response = responses.shift()
    if (response) resolve(response)
    else pending.push(resolve)
  })
  return {
    child,
    async request(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`)
      return next()
    },
    async raw(line) {
      child.stdin.write(`${line}\n`)
      return next()
    },
    async close() {
      child.stdin.end()
      const [code] = await once(child, 'exit')
      return { code, stderr }
    },
  }
}

test('desktop bridge names groups by the relay display name', async (t) => {
  const { env } = await fixture(t, { groups: { auto: { desc: '自动' }, plus: { ratio: 0.2, desc: '测试中', display_name: ' GPT ' },
    cn: { ratio: 0.15, desc: '国模', display_name: '' }, claude: { ratio: 0.9, display_name: 'Claude' } } })
  const bridge = bridgeClient(env)
  t.after(async () => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  const { data } = await bridge.request({ id: 1, action: 'status' })
  assert.deepEqual(data.groups.map(({ value, label }) => [value, label]).sort(),
    [['claude', 'Claude'], ['plus', 'GPT']])
  await bridge.close()
})

test('desktop balance refresh reads wallet snapshots without caching or estimating request charges', async (t) => {
  const { env, state } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  let id = 0
  for (const [quota, expected] of [[500000, '$1.00'], [390000, '$0.78'], [405000, '$0.81']]) {
    state.account.quota = quota
    const response = await bridge.request({ id: ++id, action: 'status' })
    assert.equal(response.ok, true)
    assert.equal(response.data.quota, expected)
  }
  assert.equal(state.calls.filter((call) => call.path === '/api/user/self').length, 3)
  const closed = await bridge.close()
  assert.equal(closed.code, 0)
})

test('lightweight balance requests return settled snapshots without reconfiguring models', async (t) => {
  const { env, state } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  state.account.quota = 390000
  Object.assign(state.account, { settled_quota: 500000, pending_quota: 110000, pending_request_count: 1 })
  const pending = await bridge.request({ id: 1, action: 'balance' })
  assert.equal(pending.ok, true)
  assert.deepEqual(pending.data, { quota: '$1.00', balanceMode: 'settled', pendingSettlement: true })
  Object.assign(state.account, { quota: 405000, settled_quota: 405000, pending_quota: 0, pending_request_count: 0 })
  const settled = await bridge.request({ id: 2, action: 'balance' })
  assert.deepEqual(settled.data, { quota: '$0.81', balanceMode: 'settled', pendingSettlement: false })
  assert.equal(state.calls.filter((call) => call.path === '/api/user/self/balance').length, 2)
  assert.equal(state.calls.some((call) => /models|token|groups/.test(call.path)), false)
  assert.equal((await bridge.close()).code, 0)
})

test('desktop bridge offers only named groups in the relay display order', async (t) => {
  const { env } = await fixture(t, { groups: { auto: { desc: '自动' }, plus: { ratio: 0.2, display_name: 'GPT', display_order: 2 },
    cn: { ratio: 0.15, display_name: '国模' }, claude: { ratio: 0.9, display_name: 'Claude', display_order: 1 }, premium: { ratio: 2 } } })
  const bridge = bridgeClient(env)
  t.after(async () => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  const { data } = await bridge.request({ id: 1, action: 'status' })
  assert.deepEqual(data.groups.map(({ value, label }) => [value, label]),
    [['claude', 'Claude'], ['plus', 'GPT'], ['cn', '国模']])
  await bridge.close()
})

test('desktop bridge projects only public state over serialized stdio requests', async (t) => {
  const { files, originalConfig, state, env } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(async () => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })

  const initial = await bridge.request({ id: 1, action: 'status' })
  assert.equal(initial.ok, true)
  assert.equal(initial.data.loggedIn, true)
  assert.equal(initial.data.configured, false)
  assert.equal(initial.data.quota, '$12.50')
  assert.deepEqual(initial.data.groups, [{ value: 'auto', label: 'All' }, { value: 'premium', label: 'premium', ratio: 2 }])
  assert.deepEqual(initial.data.models, [])

  const login = await bridge.request({ id: 2, action: 'login' })
  assert.deepEqual(Object.keys(login.data), [
    'loggedIn', 'configured', 'username', 'quota', 'balanceMode', 'pendingSettlement', 'group', 'groupLabel', 'groups', 'model', 'models',
    'message', 'restartRequired',
  ])
  assert.equal(login.ok, true)
  assert.equal(login.data.group, 'auto')
  assert.equal(login.data.groupLabel, 'All')
  assert.equal(login.data.model, 'gpt-5-codex')
  assert.equal(login.data.restartRequired, true)
  assert.deepEqual(login.data.models, ['gpt-5-codex', 'gpt-5'])
  let config = parse(await fs.readFile(files.config, 'utf8'))
  assert.equal(config.service_tier, 'fast')
  assert.equal(config.model_reasoning_effort, 'ultra')
  assert.equal(state.keys[0].fast_mode, true)

  const takeover = await bridge.request({ id: 3, action: 'reconfigure' })
  assert.equal(takeover.ok, true)
  assert.equal(takeover.data.restartRequired, true)
  assert.match(takeover.data.message, /自动重启 Codex/)

  const externalConfig = (await fs.readFile(files.config, 'utf8')).replace(
    'model_provider = "yisama"', 'model_provider = "custom"',
  )
  await fs.writeFile(files.config, externalConfig, 'utf8')
  const drifted = await bridge.request({ id: 4, action: 'status' })
  assert.equal(drifted.ok, true)
  assert.equal(drifted.data.configured, false)
  assert.deepEqual(drifted.data.models, [])
  assert.equal(await fs.readFile(files.config, 'utf8'), externalConfig)

  const selected = await bridge.request({ id: 5, action: 'select', group: 'premium', model: 'gpt-5' })
  assert.equal(selected.ok, true)
  assert.equal(selected.data.group, 'premium')
  assert.equal(selected.data.model, 'gpt-5')
  config = parse(await fs.readFile(files.config, 'utf8'))
  assert.equal(config.service_tier, 'fast')
  assert.equal(config.model_reasoning_effort, 'xhigh')
  assert.equal(state.keys.length, 1)
  assert.equal(state.keys[0].group, 'premium')

  const invalid = await bridge.raw('{not json')
  assert.deepEqual(invalid, {
    id: null,
    ok: false,
    error: '操作未完成，请检查网络或联系管理员；未输出账号敏感信息。',
  })

  const badGroup = await bridge.request({ id: 6, action: 'select', group: 'missing' })
  assert.equal(badGroup.ok, false)
  assert.doesNotMatch(badGroup.error, /sk-|dashboard|Authorization|Bearer/i)

  const restored = await bridge.request({ id: 7, action: 'restore' })
  assert.equal(restored.ok, true)
  assert.equal(restored.data.loggedIn, false)
  assert.equal(restored.data.configured, false)
  assert.equal(restored.data.restartRequired, true)
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  await assert.rejects(fs.readFile(files.session, 'utf8'), { code: 'ENOENT' })
  const callsBeforeOfflineStatus = state.calls.length
  const offline = await bridge.request({ id: 8, action: 'status' })
  assert.equal(offline.ok, true)
  assert.equal(offline.data.loggedIn, false)
  assert.equal(offline.data.configured, false)
  assert.equal(state.calls.length, callsBeforeOfflineStatus, 'offline status does not open a login flow or call the portal')

  const closed = await bridge.close()
  assert.equal(closed.code, 0)
  assert.equal(closed.stderr, '')
  const publicOutput = JSON.stringify([initial, login, takeover, drifted, selected, invalid, badGroup, restored, offline, closed])
  assert.doesNotMatch(publicOutput, /sk-bridge-test-key|dashboard-token|Authorization|Bearer/i)
})

test('desktop login defaults to the first available group when All is unavailable', async (t) => {
  const { state, env } = await fixture(t, { groups: { premium: { ratio: 2 } } })
  const bridge = bridgeClient(env)
  t.after(async () => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })

  const login = await bridge.request({ id: 1, action: 'login' })
  assert.equal(login.ok, true)
  assert.equal(login.data.group, 'premium')
  assert.equal(login.data.groupLabel, 'premium')
  assert.equal(state.keys.length, 1)
  assert.equal(state.keys[0].group, 'premium')

  const closed = await bridge.close()
  assert.equal(closed.code, 0)
  assert.equal(closed.stderr, '')
})

test('two installations keep independent credentials, Fast settings and groups across logins', async (t) => {
  const { state, env, files } = await fixture(t)
  const secondRoot = path.join(path.dirname(env.PLUGIN_DATA), 'second-device')
  const secondEnv = { ...env, PLUGIN_DATA: path.join(secondRoot, 'data'),
    CODEX_HOME: path.join(secondRoot, 'codex') }
  await fs.mkdir(secondEnv.PLUGIN_DATA, { recursive: true })
  await fs.mkdir(secondEnv.CODEX_HOME, { recursive: true })
  await fs.copyFile(files.session, path.join(secondEnv.PLUGIN_DATA, 'session.json'))
  for (const name of ['config.toml', 'models_cache.json']) {
    await fs.copyFile(path.join(env.CODEX_HOME, name), path.join(secondEnv.CODEX_HOME, name))
  }
  const first = bridgeClient(env)
  const second = bridgeClient(secondEnv)
  t.after(() => {
    for (const bridge of [first, second]) if (bridge.child.exitCode === null) bridge.child.kill()
  })
  assert.equal((await first.request({ id: 1, action: 'login' })).ok, true)
  const firstSaved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.equal((await first.request({ id: 2, action: 'fast', enabled: false,
    keyFingerprint: firstSaved.keyFingerprint })).ok, true)
  const firstConfig = parse(await fs.readFile(files.config, 'utf8'))
  firstConfig.service_tier = 'standard'
  await fs.writeFile(files.config, stringify(firstConfig), 'utf8')

  assert.equal((await second.request({ id: 1, action: 'login' })).ok, true)
  const secondStateFile = path.join(secondEnv.PLUGIN_DATA, 'state.json')
  const secondSaved = JSON.parse(await fs.readFile(secondStateFile, 'utf8'))
  assert.notEqual(secondSaved.keyId, firstSaved.keyId,
    'another computer must never reuse the first computer credential')
  assert.notEqual(secondSaved.keyName, firstSaved.keyName)
  assert.equal(state.keys.length, 2)
  assert.equal(state.keys.find((key) => key.id === firstSaved.keyId).fast_mode, false)
  assert.equal(state.keys.find((key) => key.id === secondSaved.keyId).fast_mode, true)
  assert.equal((await first.request({ id: 3, action: 'status' })).ok, true)
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, 'standard')

  assert.equal((await second.request({ id: 2, action: 'select', group: 'premium' })).ok, true)
  assert.equal(state.keys.find((key) => key.id === firstSaved.keyId).group, 'auto')
  assert.equal((await first.request({ id: 4, action: 'status' })).ok, true)
  const secondConfigFile = path.join(secondEnv.CODEX_HOME, 'config.toml')
  const secondConfig = await fs.readFile(secondConfigFile, 'utf8')
  assert.equal((await first.request({ id: 5, action: 'fast', enabled: true,
    keyFingerprint: firstSaved.keyFingerprint })).ok, true)
  assert.equal((await second.request({ id: 3, action: 'status' })).ok, true)
  assert.equal(await fs.readFile(secondConfigFile, 'utf8'), secondConfig)
  assert.equal(state.keys.find((key) => key.id === secondSaved.keyId).fast_mode, false)

  assert.equal((await second.request({ id: 4, action: 'restore' })).ok, true)
  await fs.copyFile(files.session, path.join(secondEnv.PLUGIN_DATA, 'session.json'))
  assert.equal((await second.request({ id: 5, action: 'login' })).ok, true)
  assert.equal(JSON.parse(await fs.readFile(secondStateFile, 'utf8')).keyId, secondSaved.keyId,
    'logging out must not erase this installation identity')
  assert.equal(state.keys.length, 2)
  assert.equal((await first.close()).stderr, '')
  assert.equal((await second.close()).stderr, '')
})

test('legacy shared credentials migrate without changing another device or the local Fast choice', async (t) => {
  const { state, env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const legacyState = JSON.parse(await fs.readFile(files.state, 'utf8'))
  delete legacyState.keyName
  await fs.writeFile(files.state, JSON.stringify(legacyState), 'utf8')
  state.keys[0].name = 'yisama-infinite-assistant:codex'
  const legacyKey = structuredClone(state.keys[0])
  const config = parse(await fs.readFile(files.config, 'utf8'))
  config.service_tier = 'standard'
  config.model = 'gpt-5'
  config.model_reasoning_effort = 'low'
  await fs.writeFile(files.config, stringify(config), 'utf8')
  const authFile = path.join(env.CODEX_HOME, 'auth.json')
  const originalAuth = await fs.readFile(authFile, 'utf8')
  const originalConfigBackup = await fs.readFile(
    path.join(env.PLUGIN_DATA, 'backups/config.original.toml'), 'utf8')
  const callsBefore = state.calls.length

  const blocked = await bridge.request({ id: 2, action: 'fast', enabled: false,
    keyFingerprint: legacyState.keyFingerprint })
  assert.equal(blocked.ok, false, 'Fast must not mutate a legacy credential shared with another computer')
  assert.deepEqual(state.keys[0], legacyKey)
  state.createKeyFailure = true
  assert.equal((await bridge.request({ id: 3, action: 'status' })).ok, false)
  assert.deepEqual(JSON.parse(await fs.readFile(files.state, 'utf8')), legacyState)
  assert.deepEqual(parse(await fs.readFile(files.config, 'utf8')), config)
  assert.equal(await fs.readFile(authFile, 'utf8'), originalAuth)
  assert.deepEqual(state.keys[0], legacyKey)

  state.createKeyFailure = false
  const migrated = await bridge.request({ id: 4, action: 'status' })
  assert.equal(migrated.ok, true, migrated.error)
  const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.notEqual(saved.keyId, legacyState.keyId)
  assert.notEqual(saved.keyFingerprint, legacyState.keyFingerprint)
  assert.equal(saved.previousKeyFingerprint, legacyState.keyFingerprint)
  assert.match(saved.keyName, /^yisama:codex:[0-9a-f-]{36}$/)
  assert.ok(saved.keyName.length <= 50, 'device names must fit the production API limit')
  assert.deepEqual(state.keys[0], legacyKey, 'old clients must keep their original credential unchanged')
  assert.equal(state.keys.find((key) => key.id === saved.keyId).fast_mode, false)
  const migratedConfig = parse(await fs.readFile(files.config, 'utf8'))
  assert.notEqual(migratedConfig.service_tier, 'fast')
  assert.notEqual(migratedConfig.service_tier, 'priority')
  assert.equal(migratedConfig.model, 'gpt-5')
  assert.equal(migratedConfig.model_reasoning_effort, 'low')
  assert.equal(await fs.readFile(path.join(env.PLUGIN_DATA, 'backups/config.original.toml'), 'utf8'),
    originalConfigBackup)
  assert.ok(state.calls.slice(callsBefore).filter((call) => call.method === 'PUT')
    .every((call) => call.body.id !== legacyState.keyId))
  assert.equal((await bridge.request({ id: 5, action: 'status' })).ok, true)
  assert.equal(state.keys.length, 2, 'later refreshes must reuse the new device credential')
  assert.equal((await bridge.close()).stderr, '')
})

test('native Fast changes only the owned key flag and preserves capability after Standard is saved', async (t) => {
  const { state, env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  const before = await fs.readFile(files.config, 'utf8')
  const keyBefore = structuredClone(state.keys[0])
  const beforeFast = state.calls.length
  const off = await bridge.request({ id: 2, action: 'fast', enabled: false, keyFingerprint: saved.keyFingerprint })
  assert.deepEqual(off, { id: 2, ok: true, data: { enabled: false } })
  assert.equal(state.calls.slice(beforeFast).filter((call) => call.path === '/api/user/self').length, 0,
    'Fast uses the local session and verifies ownership through the assistant key')
  assert.equal(state.calls.slice(beforeFast).filter((call) =>
    call.path === `/api/token/${saved.keyId}` && call.method === 'GET').length, 1,
  'Fast confirms ownership once and validates the update response instead of rereading the key')
  assert.deepEqual(state.keys[0], { ...keyBefore, fast_mode: false })
  assert.deepEqual(state.calls.filter((call) => call.method === 'PUT').at(-1).body,
    { id: saved.keyId, fast_mode: false })
  assert.equal(await fs.readFile(files.config, 'utf8'), before, 'the native setter owns local persistence')
  await fs.writeFile(files.config, before.replace('service_tier = "fast"', 'service_tier = "standard"'), 'utf8')
  assert.equal((await bridge.request({ id: 3, action: 'status' })).ok, true)
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, 'standard')
  const catalog = JSON.parse(await fs.readFile(saved.catalogPath, 'utf8'))
  assert.ok(catalog.models.every((model) => model.service_tiers.some((tier) => tier.id === 'priority')))
  const on = await bridge.request({ id: 4, action: 'fast', enabled: true, keyFingerprint: saved.keyFingerprint })
  assert.deepEqual(on, { id: 4, ok: true, data: { enabled: true } })
  assert.deepEqual(state.keys[0], keyBefore)
  assert.doesNotMatch(JSON.stringify([off, on]), new RegExp(apiKey))
  assert.equal((await bridge.close()).stderr, '')
})

test('native Fast cannot change foreign credentials or claim an unconfirmed server update', async (t) => {
  const { state, env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  const fingerprint = createHash('sha256').update('sk-foreign').digest('hex')
  assert.equal((await bridge.request({ id: 2, action: 'fast', enabled: false, keyFingerprint: fingerprint })).ok, false)
  assert.equal(state.keys[0].fast_mode, true)
  assert.equal(state.calls.filter((call) => call.method === 'PUT').length, 0)
  state.ignoreFastUpdate = true
  assert.equal((await bridge.request({ id: 3, action: 'fast', enabled: false,
    keyFingerprint: saved.keyFingerprint })).ok, false)
  state.ignoreFastUpdate = false
  state.fastUpdateFailure = true
  assert.equal((await bridge.request({ id: 4, action: 'fast', enabled: false,
    keyFingerprint: saved.keyFingerprint })).ok, false)
  assert.equal(state.keys[0].fast_mode, true)
  state.fastUpdateFailure = false
  const before = await fs.readFile(files.config, 'utf8')
  await fs.writeFile(files.config, before.replace('model_provider = "yisama"', 'model_provider = "other"'), 'utf8')
  const writes = state.calls.filter((call) => call.method === 'PUT').length
  assert.equal((await bridge.request({ id: 5, action: 'fast', enabled: false,
    keyFingerprint: saved.keyFingerprint })).ok, false)
  assert.equal(state.calls.filter((call) => call.method === 'PUT').length, writes)
  assert.equal((await bridge.close()).stderr, '')
})

test('status refreshes Fast permission changes without enabling it unexpectedly', async (t) => {
  const { state, env, files } = await fixture(t)
  state.fastUnavailableGroups = ['auto']
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const original = parse(await fs.readFile(files.config, 'utf8'))
  const before = state.calls.length
  const disabled = await bridge.request({ id: 2, action: 'status' })
  assert.match(disabled.data.message, /未开放 Fast/)
  state.fastUnavailableGroups = []
  assert.equal((await bridge.request({ id: 3, action: 'status' })).ok, true)
  let saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  let catalog = JSON.parse(await fs.readFile(saved.catalogPath, 'utf8'))
  assert.equal(saved.fastAvailable, true)
  assert.ok(catalog.models.every((model) => model.service_tiers.some((tier) => tier.id === 'priority')))
  let config = parse(await fs.readFile(files.config, 'utf8'))
  assert.equal(config.service_tier, undefined, 'permission recovery must not turn Fast back on')
  assert.equal(config.model_reasoning_effort, original.model_reasoning_effort)
  state.fastUnavailableGroups = ['auto']
  assert.equal((await bridge.request({ id: 4, action: 'status' })).ok, true)
  saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  catalog = JSON.parse(await fs.readFile(saved.catalogPath, 'utf8'))
  assert.equal(saved.fastAvailable, false)
  assert.ok(catalog.models.every((model) => model.service_tiers.length === 0))
  config = parse(await fs.readFile(files.config, 'utf8'))
  assert.equal(config.service_tier, undefined)
  assert.equal(config.model_reasoning_effort, original.model_reasoning_effort)
  assert.equal(saved.group, 'auto')
  assert.ok(state.calls.slice(before).every((call) => call.method === 'GET'))
  assert.equal(state.keys.length, 1)
  assert.equal(state.keys[0].fast_mode, false)
  assert.equal((await bridge.close()).stderr, '')
})

test('rapid group changes keep one credential and reconcile the server on every switch', async (t) => {
  const { state, env, files } = await fixture(t)
  state.groupModels = { auto: ['gpt-5-codex'], premium: ['claude-opus-4-6'] }
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const authFile = path.join(env.CODEX_HOME, 'auth.json')
  const auth = await fs.readFile(authFile, 'utf8')
  const original = await fs.readFile(path.join(env.PLUGIN_DATA, 'backups/config.original.toml'), 'utf8')
  for (const [index, group] of ['premium', 'auto', 'premium', 'auto'].entries()) {
    const selected = await bridge.request({ id: index + 2, action: 'select', group })
    assert.equal(selected.ok, true, selected.error)
    assert.equal(selected.data.group, group)
    assert.equal(selected.data.restartRequired, true, 'saved settings stay pending until native verification')
    assert.equal(state.keys.length, 1)
    assert.equal(state.keys[0].group, group, 'a cached selection must not skip the server mutation')
    assert.equal(await fs.readFile(authFile, 'utf8'), auth)
    const config = parse(await fs.readFile(files.config, 'utf8'))
    assert.deepEqual(JSON.parse(await fs.readFile(config.model_catalog_json, 'utf8')).models
      .map((model) => model.slug), state.groupModels[group])
    assert.equal(await fs.readFile(path.join(env.PLUGIN_DATA, 'backups/config.original.toml'), 'utf8'), original)
  }
  assert.equal((await bridge.close()).stderr, '')
})

test('switching between Fast-capable groups starts each group in ordinary mode', async (t) => {
  const { state, env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  assert.equal(state.keys[0].fast_mode, true)

  const premium = await bridge.request({ id: 2, action: 'select', group: 'premium' })
  assert.equal(premium.ok, true, premium.error)
  assert.equal(state.keys[0].fast_mode, false)
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, undefined)

  const auto = await bridge.request({ id: 3, action: 'select', group: 'auto' })
  assert.equal(auto.ok, true, auto.error)
  assert.equal(state.keys[0].fast_mode, false)
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, undefined)
  assert.equal((await bridge.close()).stderr, '')
})

test('group changes restore each group last selected model', async (t) => {
  const { state, env, files } = await fixture(t)
  state.groupModels = {
    auto: ['gpt-5-codex', 'gpt-5'],
    premium: ['claude-opus-4-6', 'claude-sonnet-4'],
  }
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).data.model, 'gpt-5-codex')
  assert.equal((await bridge.request({ id: 2, action: 'select', group: 'auto', model: 'gpt-5' })).data.model, 'gpt-5')
  assert.equal((await bridge.request({ id: 3, action: 'select', group: 'premium' })).data.model, 'claude-opus-4-6')
  const restored = await bridge.request({ id: 4, action: 'select', group: 'auto' })
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.data.model, 'gpt-5')
  const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.deepEqual(saved.modelByGroup, { auto: 'gpt-5', premium: 'claude-opus-4-6' })
  assert.equal((await bridge.close()).stderr, '')
})

test('text groups without Fast switch and persist their own model catalog and ordinary mode', async (t) => {
  const { state, env, files } = await fixture(t, { groups: {
    auto: {}, Gemini: {}, domestic: {}, images: {},
  } })
  state.fastUnavailableGroups = ['Gemini', 'domestic', 'images']
  state.groupModels = {
    Gemini: ['Auto', 'gemini-3-flash', 'gemini-3-pro'],
    domestic: ['Auto', 'deepseek-v4-pro', 'qwen3-max'],
    images: ['gpt-image-1', 'gemini-3-pro-image'],
  }
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).data.group, 'auto')
  for (const [index, group] of ['Gemini', 'domestic'].entries()) {
    const selected = await bridge.request({ id: 2 + index, action: 'select', group })
    assert.equal(selected.ok, true, selected.error)
    assert.equal(selected.data.group, group)
    assert.equal(selected.data.model, state.groupModels[group][1])
    assert.deepEqual(selected.data.models, state.groupModels[group])
    assert.match(selected.data.message, /普通模式/)
    assert.equal(state.keys[0].fast_mode, false, 'ordinary group switches must disable the server Fast flag')
    assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, undefined)
    const catalog = JSON.parse(await fs.readFile(parse(await fs.readFile(files.config, 'utf8')).model_catalog_json, 'utf8'))
    assert.ok(catalog.models.every((model) => model.service_tiers.length === 0 &&
      model.default_service_tier === null), 'ordinary groups must not inherit Fast from previous metadata')
    assert.equal(JSON.parse(await fs.readFile(files.state, 'utf8')).group, group)
    const catalogPath = parse(await fs.readFile(files.config, 'utf8')).model_catalog_json
    assert.ok(catalogPath.startsWith(env.PLUGIN_DATA))
    assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, 'utf8')).models.map((model) => model.slug),
      state.groupModels[group], 'the native catalog must contain the selected group, not the previous GPT list')
  }
  const applied = await bridge.request({ id: 4, action: 'select', model: 'qwen3-max' })
  assert.equal(applied.data.group, 'domestic')
  assert.equal(applied.data.model, 'qwen3-max')
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, undefined)
  const before = await fs.readFile(files.config, 'utf8')
  const media = await bridge.request({ id: 5, action: 'select', group: 'images' })
  assert.equal(media.ok, false)
  assert.equal(media.code, 'GROUP_NO_TEXT_MODEL')
  assert.equal(await fs.readFile(files.config, 'utf8'), before)
  assert.equal(state.keys[0].group, 'domestic', 'a rejected group must not change the live route')
  const status = await bridge.request({ id: 6, action: 'status' })
  assert.equal(status.data.group, 'domestic')
  assert.equal(status.data.model, 'qwen3-max')
  const fast = await bridge.request({ id: 7, action: 'select', group: 'auto' })
  assert.equal(fast.data.group, 'auto')
  assert.equal(parse(await fs.readFile(files.config, 'utf8')).service_tier, undefined,
    'switching back must preserve the user disabled Fast setting')
  assert.equal(state.keys[0].fast_mode, false)
  assert.equal((await bridge.close()).stderr, '')
})

test('native acknowledgment clears restart state only for the verified configuration version', async (t) => {
  const { env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const config = parse(await fs.readFile(files.config, 'utf8'))
  const catalog = JSON.parse(await fs.readFile(config.model_catalog_json, 'utf8'))
  assert.ok(catalog.models.every((model) => model.default_service_tier === 'priority'))
  const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
  saved.previousKeyFingerprint = createHash('sha256').update('sk-legacy-ack-test').digest('hex')
  await fs.writeFile(files.state, JSON.stringify(saved), 'utf8')
  const moduleUrl = env.YISAMA_TEST_BUNDLED_ASSISTANT
    ? pathToFileURL(path.join(path.dirname(env.YISAMA_TEST_BUNDLED_ASSISTANT), 'yisama.mjs')).href
    : new URL('./yisama.mjs', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import { desktopNativeConfiguration, desktopNativeSynced } from ${JSON.stringify(moduleUrl)};
    const current = await desktopNativeConfiguration();
    const rejected = await desktopNativeSynced('outdated-version');
    const pending = JSON.parse(await fs.readFile(${JSON.stringify(files.state)}, 'utf8')).previousKeyFingerprint;
    const accepted = await desktopNativeSynced(current.version);
    const cleared = !JSON.parse(await fs.readFile(${JSON.stringify(files.state)}, 'utf8')).previousKeyFingerprint;
    console.log(JSON.stringify({ rejected, accepted, pendingMatches: pending === current.previousKeyFingerprint, cleared }));
  `], { env, windowsHide: true, timeout: 10000 })
  assert.deepEqual(JSON.parse(stdout), { rejected: false, accepted: true, pendingMatches: true, cleared: true })
  assert.equal(JSON.parse(await fs.readFile(files.state, 'utf8')).restartRequired, false)
  assert.equal((await bridge.request({ id: 2, action: 'status' })).data.restartRequired, false)
  assert.equal((await bridge.close()).stderr, '')
})

test('native synchronization ignores model preferences but still tracks Fast and group changes', async (t) => {
  const { env, files } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).ok, true)
  const moduleUrl = new URL('./yisama.mjs', import.meta.url).href
  const snapshot = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { desktopNativeConfiguration } from ${JSON.stringify(moduleUrl)};
      const settings = await desktopNativeConfiguration();
      console.log(JSON.stringify({ version: settings.version, catalogVersion: settings.catalogVersion, model: settings.model,
        fastEnabled: settings.fastEnabled }));
    `], { env, windowsHide: true, timeout: 10000 })
    return JSON.parse(stdout)
  }
  const initial = await snapshot()
  const config = parse(await fs.readFile(files.config, 'utf8'))
  config.service_tier = 'priority'
  await fs.writeFile(files.config, stringify(config), 'utf8')
  assert.equal((await snapshot()).version, initial.version,
    'native priority and the legacy fast alias must not cause two synchronizations')
  for (const preference of [{ model: 'gpt-5' }, { model_reasoning_effort: 'low' }]) {
    Object.assign(config, preference)
    await fs.writeFile(files.config, stringify(config), 'utf8')
    const current = await snapshot()
    assert.equal(current.version, initial.version, 'native preferences must not reload the catalog')
    assert.equal(current.catalogVersion, initial.catalogVersion)
    assert.equal(current.model, config.model, 'the current model is still available as the group fallback')
  }
  config.service_tier = 'default'
  await fs.writeFile(files.config, stringify(config), 'utf8')
  const standard = await snapshot()
  assert.notEqual(standard.version, initial.version, 'Fast changes still synchronize thread settings')
  assert.equal(typeof initial.catalogVersion, 'string')
  assert.equal(standard.catalogVersion, initial.catalogVersion, 'Fast toggles do not change catalog capability')
  assert.equal(standard.fastEnabled, false)
  assert.equal((await bridge.request({ id: 2, action: 'select', group: 'premium' })).ok, true)
  const grouped = await snapshot()
  assert.equal(grouped.fastEnabled, false, 'a group switch must preserve the disabled Fast setting')
  assert.notEqual(grouped.version, initial.version, 'group changes still refresh the catalog')
  assert.notEqual(grouped.catalogVersion, initial.catalogVersion)
  assert.equal((await bridge.close()).stderr, '')
})

test('relay model order changes preserve configuration and the native catalog revision', async (t) => {
  const { state, env, files } = await fixture(t)
  const request = async (action) => {
    const bridge = bridgeClient(env)
    t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
    const response = await bridge.request({ id: 1, action })
    assert.equal((await bridge.close()).stderr, '')
    assert.equal(response.ok, true, response.error)
    return response.data
  }
  await request('login')
  const initial = JSON.parse(await fs.readFile(files.state, 'utf8'))
  const protectedFiles = [files.state, files.config, path.join(env.CODEX_HOME, 'auth.json'),
    initial.backups.appliedConfig, initial.backups.appliedAuth]
  const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8')))

  state.models.reverse()
  const refreshed = await request('status')
  assert.equal(state.calls.filter((call) => call.path === '/v1/models').length, 2,
    'the new bridge must fetch the reordered response rather than reuse its cache')
  assert.equal(refreshed.model, 'gpt-5-codex')
  assert.equal(JSON.parse(await fs.readFile(files.state, 'utf8')).catalogHash, initial.catalogHash,
    'the same models in a different order must not trigger native synchronization')
  assert.deepEqual(await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8'))), before)

  state.models.push('gpt-new')
  await request('status')
  const changed = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.notEqual(changed.catalogHash, initial.catalogHash, 'a genuinely new model still updates the catalog')
  const catalog = JSON.parse(await fs.readFile(changed.catalogPath, 'utf8'))
  assert.deepEqual(catalog.models.map((model) => model.slug), ['gpt-5', 'gpt-5-codex', 'gpt-new'])
})

test('relay input capabilities survive group changes without inheriting the previous route', async (t) => {
  const { state, env, files } = await fixture(t)
  state.groupModels = { auto: ['gpt-5-codex', 'audio-model'], premium: ['gpt-5-codex'] }
  state.modelMetadata = {
    auto: { 'gpt-5-codex': { input_modalities: ['text', 'image'] },
      'audio-model': { input_modalities: ['audio'] } },
    premium: { 'gpt-5-codex': { input_modalities: ['text'] } },
  }
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  for (const [id, group, expected] of [[1, 'auto', ['text', 'image']], [2, 'premium', ['text']],
    [3, 'auto', ['text', 'image']]]) {
    const response = await bridge.request({ id, action: id === 1 ? 'login' : 'select', group })
    assert.equal(response.ok, true, response.error)
    const saved = JSON.parse(await fs.readFile(files.state, 'utf8'))
    const catalog = JSON.parse(await fs.readFile(saved.catalogPath, 'utf8'))
    assert.deepEqual(catalog.models[0].input_modalities, expected)
    assert.deepEqual(response.data.models, ['gpt-5-codex'])
  }
  assert.equal((await bridge.close()).stderr, '')
})

test('status migrates generated text-only defaults while preserving independent capability declarations', async (t) => {
  const { state, env, files } = await fixture(t)
  state.models.push('gpt-unknown')
  const request = async (action) => {
    const bridge = bridgeClient(env)
    t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
    const response = await bridge.request({ id: 1, action })
    assert.equal((await bridge.close()).stderr, '')
    assert.equal(response.ok, true, response.error)
    return response.data
  }
  await request('login')
  const previous = JSON.parse(await fs.readFile(files.state, 'utf8'))
  const legacy = JSON.parse(await fs.readFile(previous.catalogPath, 'utf8'))
  for (const model of legacy.models) model.input_modalities = ['text']
  const catalogText = JSON.stringify(legacy) + '\n'
  const hash = createHash('sha256').update(catalogText).digest('hex')
  const legacyPath = path.join(env.PLUGIN_DATA, 'model-catalogs', `${hash}.json`)
  await fs.writeFile(legacyPath, catalogText, 'utf8')
  const config = parse(await fs.readFile(files.config, 'utf8'))
  config.model_catalog_json = legacyPath
  await fs.writeFile(files.config, stringify(config), 'utf8')
  await fs.writeFile(files.state, JSON.stringify({ ...previous,
    catalogPath: legacyPath, catalogHash: hash, catalogFiles: [...previous.catalogFiles, legacyPath],
  }), 'utf8')
  const cachePath = path.join(env.CODEX_HOME, 'models_cache.json')
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'))
  cache.models[0].input_modalities = ['text', 'image']
  cache.models[1].input_modalities = ['text']
  await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8')
  const protectedFiles = [path.join(env.CODEX_HOME, 'auth.json'),
    previous.backups.config, previous.backups.auth]
  const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8')))
  await request('status')
  const migrated = JSON.parse(await fs.readFile(files.state, 'utf8'))
  assert.notEqual(migrated.catalogHash, hash)
  const catalog = JSON.parse(await fs.readFile(migrated.catalogPath, 'utf8'))
  assert.deepEqual(Object.fromEntries(catalog.models.map((model) => [model.slug, model.input_modalities])),
    { 'gpt-5': ['text'], 'gpt-5-codex': ['text', 'image'], 'gpt-unknown': undefined })
  assert.equal(Object.hasOwn(catalog.models.find((model) => model.slug === 'gpt-unknown'), 'input_modalities'), false)
  assert.deepEqual(await Promise.all(protectedFiles.map((file) => fs.readFile(file, 'utf8'))), before)
  const stable = await fs.readFile(files.state, 'utf8')
  await request('status')
  assert.equal(await fs.readFile(files.state, 'utf8'), stable, 'migration must not rewrite on every refresh')
})

test('invalid relay input capabilities do not silently broaden support or change saved configuration', async (t) => {
  const { state, env, files, originalConfig } = await fixture(t)
  state.modelMetadata = { auto: { 'gpt-5-codex': { input_modalities: ['text', 'invalid'] } } }
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const response = await bridge.request({ id: 1, action: 'login' })
  assert.equal(response.ok, false)
  assert.match(response.error, /输入能力格式无效/)
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  await assert.rejects(fs.access(path.join(env.CODEX_HOME, 'auth.json')), { code: 'ENOENT' })
  assert.equal((await bridge.close()).stderr, '')
})

test('a new Codex launch clears the restart notice without rewriting the saved configuration', async (t) => {
  const { env, files } = await fixture(t)
  const bridge = bridgeClient({ ...env, YISAMA_CODEX_STARTED_AT: new Date(Date.now() - 60000).toISOString() })
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  assert.equal((await bridge.request({ id: 1, action: 'login' })).data.restartRequired, true)
  assert.equal((await bridge.request({ id: 2, action: 'status' })).data.restartRequired, true)
  assert.equal((await bridge.close()).stderr, '')
  const savedState = await fs.readFile(files.state, 'utf8')
  const savedConfig = await fs.readFile(files.config, 'utf8')
  const configuredAt = JSON.parse(savedState).configuredAt
  const reopened = bridgeClient({
    ...env, YISAMA_CODEX_STARTED_AT: new Date(Date.parse(configuredAt) + 1000).toISOString(),
  })
  t.after(() => { if (reopened.child.exitCode === null) reopened.child.kill() })
  const status = await reopened.request({ id: 3, action: 'status' })
  assert.equal(status.data.restartRequired, false)
  assert.doesNotMatch(status.data.message, /重启|重新打开/)
  const same = await reopened.request({ id: 4, action: 'select', group: 'auto', model: status.data.model })
  assert.equal(same.data.restartRequired, false, 'reapplying an unchanged selection must not require another restart')
  assert.equal(await fs.readFile(files.state, 'utf8'), savedState)
  assert.equal(await fs.readFile(files.config, 'utf8'), savedConfig)
  assert.equal((await reopened.close()).stderr, '')
})

test('temporary balance failures are not reported as a logged-out account', async (t) => {
  const { state, env } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  assert.equal((await bridge.request({ id: 1, action: 'status' })).data.loggedIn, true)
  for (const status of [403, 429, 503]) {
    state.accountFailure = status
    const response = await bridge.request({ id: status, action: 'status' })
    assert.equal(response.ok, false)
    assert.equal(response.data, undefined)
  }
  state.accountFailure = 0
  state.account.quota = 500000
  const recovered = await bridge.request({ id: 2, action: 'status' })
  assert.equal(recovered.data.loggedIn, true)
  assert.equal(recovered.data.quota, '$1.00')
  state.accountFailure = 401
  assert.equal((await bridge.request({ id: 3, action: 'status' })).data.loggedIn, false)
  assert.equal((await bridge.close()).code, 0)
})

test('logout before configuration clears the session without touching personal settings', async (t) => {
  const { files, env, originalConfig } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  assert.equal((await bridge.request({ id: 1, action: 'status' })).data.loggedIn, true)
  const response = await bridge.request({ id: 2, action: 'restore' })
  assert.equal(response.ok, true)
  assert.equal(response.data.loggedIn, false)
  await assert.rejects(fs.readFile(files.session, 'utf8'), { code: 'ENOENT' })
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  assert.equal((await bridge.request({ id: 3, action: 'status' })).data.loggedIn, false)
  assert.equal((await bridge.close()).code, 0)
})

test('local password login never opens the portal and saves only the resulting renewable session', async (t) => {
  const { files, env, state, originalConfig } = await fixture(t, { cached: false })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const missing = await bridge.request({ id: 1, action: 'login' })
  assert.equal(missing.ok, false, 'missing local credentials must not launch a browser')
  assert.equal(state.calls.length, 0)
  const options = await bridge.request({ id: 2, action: 'authOptions' })
  assert.deepEqual(options.data, { auth: {
    passwordLoginEnabled: true, registrationEnabled: true, emailVerificationEnabled: false,
  } })
  const wrong = await bridge.request({ id: 3, action: 'login', username: 'demo', password: 'secret-wrong-password' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'AUTH_REJECTED')
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  await assert.rejects(fs.access(files.session), { code: 'ENOENT' })
  const login = await bridge.request({ id: 4, action: 'login', username: 'demo', password: 'local-password' })
  assert.equal(login.ok, true)
  assert.equal(login.data.loggedIn, true)
  assert.equal(login.data.configured, false)
  assert.equal(login.data.setupPending, true)
  assert.equal(state.calls.some((call) => call.path === '/api/user/self'), false,
    'successful authentication is acknowledged before account preparation')
  assert.equal(state.keys.length, 0)
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  const prepared = await bridge.request({ id: 5, action: 'login' })
  assert.equal(prepared.data.configured, true)
  assert.equal(prepared.data.quota, '$12.50')
  const session = JSON.parse(await fs.readFile(files.session, 'utf8'))
  assert.equal(session.cookies[0].name, 'new_api_refresh')
  assert.equal(session.sessionId, 'desktop-session')
  session.expiresAt = 1
  await fs.writeFile(files.session, JSON.stringify(session), 'utf8')
  const refreshed = await bridge.request({ id: 6, action: 'status' })
  assert.equal(refreshed.data.loggedIn, true)
  assert.equal(state.calls.filter((call) => call.path === '/api/user/auth/refresh').length, 1)
  const persisted = (await fs.readFile(files.session, 'utf8')) + (await fs.readFile(files.state, 'utf8'))
  assert.doesNotMatch(persisted, /local-password|secret-wrong-password|private-two-factor-flow/)
  assert.doesNotMatch(JSON.stringify([missing, options, wrong, login, prepared, refreshed]), /local-password|secret-wrong-password|sk-bridge|dashboard-token/)
  assert.equal(state.calls.some((call) => ['/api/user/login', '/sign-in'].includes(call.path)), false)
  assert.equal((await bridge.close()).stderr, '')
})

test('two-factor local login retains its private flow only in memory and permits correcting a code', async (t) => {
  const { files, state, env, originalConfig } = await fixture(t, { cached: false, twoFactor: true })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const challenge = await bridge.request({ id: 1, action: 'login', username: 'demo', password: 'local-password' })
  assert.equal(challenge.ok, true)
  assert.equal(challenge.data.auth.step, 'twoFactor')
  assert.match(challenge.data.auth.loginId, /^[a-f0-9-]{36}$/)
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  await assert.rejects(fs.access(files.session), { code: 'ENOENT' })
  const wrong = await bridge.request({ id: 2, action: 'login',
    loginId: challenge.data.auth.loginId, twoFactorCode: '000000' })
  assert.equal(wrong.ok, false)
  const completed = await bridge.request({ id: 3, action: 'login',
    loginId: challenge.data.auth.loginId, twoFactorCode: '123456' })
  assert.equal(completed.ok, true)
  assert.equal(completed.data.loggedIn, true)
  assert.equal(completed.data.setupPending, true)
  assert.equal(completed.data.configured, false)
  const replay = await bridge.request({ id: 4, action: 'login',
    loginId: challenge.data.auth.loginId, twoFactorCode: '123456' })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'AUTH_EXPIRED')
  assert.equal(state.calls.filter((call) => call.path === '/api/assistant/auth/login').length, 1)
  assert.equal(state.calls.filter((call) => call.path === '/api/assistant/auth/login/2fa').length, 2)
  assert.doesNotMatch(JSON.stringify([challenge, wrong, completed, replay]), /private-two-factor-flow|local-password|000000|123456|dashboard-token/)
  assert.doesNotMatch(await fs.readFile(files.session, 'utf8'), /private-two-factor-flow|local-password|000000|123456/)
  assert.equal((await bridge.close()).stderr, '')
})

test('authentication succeeds independently of a later account-preparation failure', async (t) => {
  const { files, state, env, originalConfig } = await fixture(t, { cached: false })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  state.accountFailure = 503
  const login = await bridge.request({ id: 1, action: 'login',
    username: 'demo', password: 'local-password' })
  assert.equal(login.ok, true)
  assert.equal(login.data.loggedIn, true)
  assert.equal(login.data.setupPending, true)
  assert.deepEqual(state.calls.map((call) => call.path), ['/api/assistant/auth/login'])
  const prepare = await bridge.request({ id: 2, action: 'login' })
  assert.equal(prepare.ok, false)
  assert.notEqual(prepare.code, 'AUTH_REJECTED')
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  assert.equal(JSON.parse(await fs.readFile(files.session, 'utf8')).token, dashboardToken)
  state.accountFailure = 0
  const retried = await bridge.request({ id: 3, action: 'login' })
  assert.equal(retried.data.configured, true)
  assert.equal(state.calls.filter((call) => call.path === '/api/assistant/auth/login').length, 1)
  assert.equal((await bridge.close()).stderr, '')
})

test('account service failures are not reported as an incorrect password', async (t) => {
  const { files, state, env } = await fixture(t, { cached: false })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  state.authFailure = 503
  const unavailable = await bridge.request({ id: 1, action: 'login',
    username: 'demo', password: 'local-password' })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.code, 'AUTH_UNAVAILABLE')
  assert.doesNotMatch(unavailable.error, /密码|local-password|dashboard-token/)
  await assert.rejects(fs.access(files.session), { code: 'ENOENT' })
  state.authFailure = 0
  const wrong = await bridge.request({ id: 2, action: 'login',
    username: 'demo', password: 'wrong-password' })
  assert.equal(wrong.code, 'AUTH_REJECTED')
  const login = await bridge.request({ id: 3, action: 'login',
    username: 'demo', password: 'local-password' })
  assert.equal(login.data.loggedIn, true)
  assert.equal(state.calls.length, 3, 'failed authentication must not automatically retry passwords')
  assert.equal((await bridge.close()).stderr, '')
})

test('model selection reuses its credential and catalog while balance refreshes remain fresh', async (t) => {
  const { state, env } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const prepared = await bridge.request({ id: 1, action: 'login' })
  assert.equal(prepared.data.configured, true)
  for (const route of ['/api/user/self', '/api/user/self/groups', '/api/status', '/v1/models']) {
    assert.equal(state.calls.filter((call) => call.path === route).length, 1,
      `${route} must not be repeated by preparation`)
  }
  assert.equal(state.calls.filter((call) => call.method === 'PUT').length, 0,
    'a newly created healthy credential must not be rewritten')
  const before = state.calls.length
  const selected = await bridge.request({ id: 2, action: 'select', group: 'auto', model: 'gpt-5' })
  assert.equal(selected.data.model, 'gpt-5')
  assert.deepEqual(state.calls.slice(before).map((call) => call.path), ['/api/user/self'],
    'changing only the model must not reveal, rewrite or recreate credentials')
  state.account.quota = 500000
  const refreshed = await bridge.request({ id: 3, action: 'status' })
  assert.equal(refreshed.data.quota, '$1.00')
  assert.equal(refreshed.data.model, 'gpt-5')
  assert.equal(state.calls.filter((call) => call.path === '/api/status').length, 1)
  assert.equal(state.calls.filter((call) => call.path === '/v1/models').length, 1)
  assert.equal((await bridge.close()).stderr, '')
})

test('password reset stays local and never changes saved configuration or sessions', async (t) => {
  const { state, env, files, originalConfig } = await fixture(t, { cached: false })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const email = 'reset+local@example.test'
  const sent = await bridge.request({ id: 1, action: 'sendPasswordResetVerification', email,
    password: 'never-send-this' })
  assert.equal(sent.data.passwordResetVerificationSent, true)
  assert.equal(state.calls[0].email, email)
  assert.equal(state.calls[0].method, 'GET')
  assert.equal(state.calls[0].body, undefined)
  const wrong = await bridge.request({ id: 2, action: 'resetPassword', email,
    verificationCode: '000000', password: 'secret-new-password' })
  assert.equal(wrong.code, 'AUTH_REJECTED')
  assert.match(wrong.error, /密码重置失败/)
  const reset = await bridge.request({ id: 3, action: 'resetPassword', email,
    verificationCode: '987654', password: 'secret-new-password', role: 100 })
  assert.equal(reset.data.passwordReset, true)
  assert.deepEqual(state.calls[2].body, {
    email, verification_code: '987654', password: 'secret-new-password',
  })
  state.resetSendFailure = 400
  const rejected = await bridge.request({ id: 4, action: 'sendPasswordResetVerification', email })
  assert.match(rejected.error, /验证码发送失败/)
  state.resetSendFailure = 429
  const limited = await bridge.request({ id: 5, action: 'sendPasswordResetVerification', email })
  assert.equal(limited.code, 'AUTH_RATE_LIMIT')
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  for (const file of [files.session, files.state, path.join(env.CODEX_HOME, 'auth.json')]) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' })
  }
  assert.equal(state.calls.every((call) => call.path.startsWith('/api/assistant/auth/password-reset')), true)
  assert.doesNotMatch(JSON.stringify([sent, wrong, reset, rejected, limited]), /secret-new-password|000000|987654|dashboard-token/)
  assert.equal((await bridge.close()).stderr, '')
})

test('local registration preserves website email verification and never forwards privileged fields', async (t) => {
  const { state, env, files, originalConfig } = await fixture(t, { cached: false, emailVerification: true })
  const bridge = bridgeClient(env)
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill() })
  const options = await bridge.request({ id: 1, action: 'authOptions' })
  assert.equal(options.data.auth.emailVerificationEnabled, true)
  const sent = await bridge.request({ id: 2, action: 'sendVerification', email: 'demo@example.test' })
  assert.equal(sent.data.verificationSent, true)
  const wrong = await bridge.request({ id: 3, action: 'register', username: 'new-user', password: 'new-password',
    email: 'demo@example.test', verificationCode: '000000' })
  assert.equal(wrong.ok, false)
  const registered = await bridge.request({ id: 4, action: 'register', username: 'new-user', password: 'new-password',
    email: 'demo@example.test', verificationCode: '654321', role: 100, quota: 99999999 })
  assert.equal(registered.data.registered, true)
  assert.deepEqual(state.calls.filter((call) => call.path === '/api/assistant/auth/register').at(-1).body, {
    username: 'new-user', password: 'new-password', email: 'demo@example.test', verification_code: '654321',
  })
  assert.equal(await fs.readFile(files.config, 'utf8'), originalConfig)
  await assert.rejects(fs.access(files.session), { code: 'ENOENT' })
  assert.doesNotMatch(JSON.stringify([options, sent, wrong, registered]), /new-password|000000|654321/)
  assert.equal((await bridge.close()).stderr, '')
})

test('redeem codes top up the account and refresh the shown balance', async (t) => {
  const { state, env } = await fixture(t)
  const bridge = bridgeClient(env)
  t.after(() => {
    if (!bridge.child.killed && bridge.child.exitCode === null) bridge.child.kill()
  })
  state.account.quota = 500000
  assert.equal((await bridge.request({ id: 1, action: 'status' })).data.quota, '$1.00')
  const rejected = await bridge.request({ id: 2, action: 'redeem', redeemCode: 'used-code' })
  assert.equal(rejected.ok, false)
  const redeemed = await bridge.request({ id: 3, action: 'redeem', redeemCode: ' valid-redeem-code ' })
  assert.equal(redeemed.ok, true)
  assert.equal(redeemed.data.quota, '$2.00')
  assert.deepEqual(state.calls.filter((call) => call.path === '/api/user/topup').map((call) => call.body.key),
    ['used-code', 'valid-redeem-code'])
  assert.equal((await bridge.close()).code, 0)
})
