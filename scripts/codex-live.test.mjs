import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { configureCodex, makeModelCatalog } from './codex-config.mjs'
import { syncNativeModels } from './codex-assistant.mjs'

const binary = process.env.YISAMA_CODEX_BIN

for (const initiallyFast of [false, true]) test(`real Codex switches groups without interrupting an answer (${initiallyFast ? 'Fast catalog at launch' : 'Fast catalog added live'})`, {
  skip: !binary && 'Set YISAMA_CODEX_BIN for the live group test.',
  timeout: 45000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-live-'))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const requests = []
  let releaseFirst
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/v1/responses')) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ body, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const index = requests.length
    const response = {
      id: `resp_${index}`, object: 'response', status: 'completed', created_at: 1,
      model: body.model,
      output: [{ id: `msg_${index}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'LIVE_GROUP_OK', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created', response: { ...response, status: 'in_progress', output: [] },
    })}\n\n`)
    const finish = () => {
      const item = response.output[0]
      for (const event of [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    }
    if (index === 1) releaseFirst = finish
    else finish()
  })
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const initialModel = initiallyFast ? 'gpt-5.5' : 'gemini-3-flash'
  const initialCatalog = makeModelCatalog([initialModel], [], { fast: initiallyFast })
  let state = await configureCodex({
    files, apiKey: 'sk-first-test-group', origin, model: initialModel, reasoning: null,
    fast: initiallyFast, catalog: initialCatalog,
  })
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig) }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  const child = spawn(binary, ['--no-daemon', '-c', `chatgpt_base_url="${origin}"`,
    'app-server', '--stdio'], { cwd: root, env, windowsHide: true })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })
  const settingsUpdates = []
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'thread/settings/updated') settingsUpdates.push(message.params)
  })
  child.stderr.resume()
  t.after(async () => {
    releaseFirst?.()
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2000)
    await closed
    clearTimeout(timer)
    lines.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  let sequence = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const receive = (line) => {
      const message = JSON.parse(line)
      if (message.id !== id) return
      clearTimeout(timer)
      lines.off('line', receive)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    }
    const timer = setTimeout(() => {
      lines.off('line', receive)
      reject(new Error(`RPC timed out: ${method}`))
    }, 10000)
    lines.on('line', receive)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  const until = async (predicate) => {
    const end = Date.now() + 10000
    while (!await predicate()) {
      assert.ok(Date.now() < end, 'live group operation timed out')
      await delay(25)
    }
  }
  await rpc('initialize', {
    clientInfo: { name: 'yisama_live_test', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  child.stdin.write('{"method":"initialized"}\n')
  const listeners = new Set()
  const nativeMethods = []
  let invalidations = 0
  const queryClient = { getQueryCache() {}, async invalidateQueries() { invalidations++ } }
  const renderer = {
    __yisamaInfiniteAssistant: { nativeStatus() {} },
    __codexRoot: { _internalRoot: { current: { memoizedProps: { client: queryClient } } } },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    electronBridge: { async sendMessageFromView({ hostId, request }) {
      nativeMethods.push(request.method)
      const message = { id: request.id }
      try { message.result = await rpc(request.method, request.params) }
      catch (error) { message.error = { message: error.message } }
      for (const listener of listeners) listener({ data: { type: 'mcp-response', hostId, message } })
    } },
  }
  renderer.top = renderer
  const synchronize = (version, catalog, { catalogVersion = version, fast = true } = {}) =>
    runInNewContext(`(${syncNativeModels.toString()})(settings)`, {
    window: renderer, location: { href: 'app://-/index.html' },
    crypto: { randomUUID }, setTimeout, clearTimeout,
    settings: { version, catalogVersion, apiKey: 'sk-first-test-group', provider: 'yisama',
      model: catalog.models[0].slug, models: catalog.models.map((model) => model.slug),
      modelSettings: Object.fromEntries(catalog.models.map((model) => [model.slug, {
        fastAvailable: model.service_tiers.some((tier) => tier.id === 'priority'),
        serviceTier: fast ? model.default_service_tier : null, effort: 'none',
      }])) },
  })
  assert.deepEqual((await rpc('model/list', { includeHidden: true })).data.map((model) => model.model),
    [initialModel])
  const first = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, model: initialModel })
  await rpc('turn/start', { threadId: first.thread.id, input: [{ type: 'text', text: 'Reply OK.' }] })
  await until(() => requests.length === 1)
  const fastCatalog = makeModelCatalog(['gpt-5.5'], [], { fast: true })
  state = await configureCodex({
    files, state, apiKey: 'sk-first-test-group', origin, model: 'gpt-5.5', reasoning: null,
    fast: true, catalog: fastCatalog,
  })
  assert.equal((await synchronize('fast-group', fastCatalog)).status, 'synced')
  const fastModels = (await rpc('model/list', { includeHidden: true })).data
  assert.deepEqual(fastModels.map((model) => model.model), ['gpt-5.5'],
    'the native picker catalog updates while the first answer is still active')
  assert.equal(fastModels[0].serviceTiers[0]?.id, 'priority')
  assert.equal(fastModels[0].serviceTiers[0]?.name, 'Fast')
  assert.equal(fastModels[0].defaultServiceTier, 'priority')
  const fastSettings = settingsUpdates.findLast((update) => update.threadId === first.thread.id)?.threadSettings || first
  assert.equal(fastSettings?.serviceTier ?? null, initiallyFast ? 'priority' : null)
  assert.equal(fastSettings?.model, initialModel,
    'a model outside the new group must stay on the existing thread')
  assert.equal((await rpc('thread/read', { threadId: first.thread.id })).thread.status.type, 'active')
  assert.equal(requests[0].body.model, initialModel, 'the active request must retain its original model')
  assert.equal(requests[0].body.service_tier, initiallyFast ? 'priority' : undefined)
  const beforeToggle = nativeMethods.length
  const beforeInvalidations = invalidations
  const beforeThreadUpdates = settingsUpdates.length
  for (const fast of [false, true]) {
    assert.equal((await synchronize(`fast-toggle-${fast}`, fastCatalog,
      { catalogVersion: 'fast-group', fast })).status, 'synced')
    const current = await rpc('thread/read', { threadId: first.thread.id })
    assert.equal(settingsUpdates.length, beforeThreadUpdates,
      'Fast-only changes must not walk or rewrite active threads')
    assert.equal(current.thread.status.type, 'active',
      'Fast toggles must not interrupt the active response')
    assert.equal(requests.length, 1)
  }
  assert.ok(!nativeMethods.slice(beforeToggle).some((method) =>
    method === 'account/login/start' || method === 'model/list'))
  assert.equal(invalidations, beforeInvalidations, 'Fast toggles must not invalidate native query caches')
  releaseFirst()
  releaseFirst = null
  await until(async () => (await rpc('thread/read', { threadId: first.thread.id })).thread.status.type !== 'active')
  await rpc('turn/start', { threadId: first.thread.id,
    serviceTier: fastSettings.serviceTier,
    input: [{ type: 'text', text: 'Reply OK again.' }] })
  await until(() => requests.length >= 2)
  assert.equal(requests[1].body.model, initialModel,
    'the existing thread must retain its original model while the new group is active')
  // The provider retains its launch-time capabilities even after model/list refreshes.
  // The relay enforces Fast upstream; do not mistake the picker notification for a wire-level refresh.
  assert.equal(requests[1].body.service_tier, initiallyFast ? 'priority' : undefined)
  assert.equal(requests[1].auth, 'Bearer sk-first-test-group')
  await until(async () => (await rpc('thread/read', { threadId: first.thread.id })).thread.status.type !== 'active')
  const fresh = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, model: 'gpt-5.5', serviceTier: fastSettings.serviceTier })
  await rpc('turn/start', { threadId: fresh.thread.id,
    input: [{ type: 'text', text: 'Reply OK.' }] })
  await until(() => requests.length >= 3)
  assert.equal(requests[2].body.model, 'gpt-5.5')
  assert.equal(requests[2].body.service_tier, initiallyFast ? 'priority' : undefined,
    'new threads also retain launch-time provider capabilities; document the native hot-reload limitation')
  await until(async () => (await rpc('thread/read', { threadId: fresh.thread.id })).thread.status.type !== 'active')
  const ordinaryCatalog = makeModelCatalog(['claude-opus-4-6'])
  state = await configureCodex({
    files, state, apiKey: 'sk-first-test-group', origin, model: 'claude-opus-4-6', reasoning: null,
    fast: false, catalog: ordinaryCatalog,
  })
  const beforeOrdinaryUpdates = settingsUpdates.length
  assert.equal((await synchronize('ordinary-group', ordinaryCatalog)).status, 'synced')
  const ordinaryModels = (await rpc('model/list', { includeHidden: true })).data
  assert.deepEqual(ordinaryModels.map((model) => model.model), ['claude-opus-4-6'])
  assert.deepEqual(ordinaryModels[0].serviceTiers, [])
  assert.equal(settingsUpdates.slice(beforeOrdinaryUpdates).some((update) => update.threadId === first.thread.id), false,
    'an unavailable thread model must not be overwritten during the ordinary-group switch')
  const ordinaryThread = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, model: 'claude-opus-4-6' })
  await rpc('turn/start', { threadId: ordinaryThread.thread.id,
    input: [{ type: 'text', text: 'Reply OK once more.' }] })
  await until(() => requests.length >= 4)
  assert.equal(requests[3].body.model, 'claude-opus-4-6')
  assert.notEqual(requests[3].body.service_tier, 'priority', 'ordinary groups must clear the previous Fast tier')
  assert.equal(requests[3].auth, 'Bearer sk-first-test-group')
  await until(async () => (await rpc('thread/read', { threadId: ordinaryThread.thread.id })).thread.status.type !== 'active')

  state = await configureCodex({
    files, state, apiKey: 'sk-first-test-group', origin, model: initialModel, reasoning: null,
    fast: initiallyFast, catalog: initialCatalog,
  })
  const beforeRestoreUpdates = settingsUpdates.length
  assert.equal((await synchronize('initial-group-restored', initialCatalog,
    { fast: initiallyFast })).status, 'synced')
  assert.equal(settingsUpdates.slice(beforeRestoreUpdates).some((update) =>
    update.threadId === first.thread.id && update.threadSettings?.model &&
    update.threadSettings.model !== initialModel), false,
  'restoring the original group must not replace the original thread model')
  assert.equal((await rpc('thread/read', { threadId: first.thread.id })).thread.model, initialModel,
    'switching back must leave the original thread model available')
  await until(async () => (await rpc('thread/read', { threadId: first.thread.id })).thread.status.type !== 'active')
})
