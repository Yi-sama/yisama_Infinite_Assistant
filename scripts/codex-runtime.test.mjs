import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { configureCodex, makeModelCatalog, replaceFile, restoreCodex } from './codex-config.mjs'
import { CODEX_PAGE, runAssistant } from './codex-assistant.mjs'

async function exec(...args) {
  const pending = promisify(execFile)(...args)
  pending.child.stdin.end()
  const result = await pending
  assert.equal(pending.child.killed, false, 'Codex must exit without being killed by the command timeout')
  return result
}
const binary = process.env.YISAMA_CODEX_BIN

test('real Codex restore keeps original credentials through assistant polling and a fresh service launch', {
  skip: !binary && 'Set YISAMA_CODEX_BIN to run the real restore test.',
  timeout: 90000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-real-restore-'))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    session: path.join(root, 'data/session.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const personalKey = 'sk-isolated-original-restore-only'
  const helperKey = 'sk-isolated-assistant-restore-only'
  const originalConfig = [
    'model = "gpt-5-codex"', 'cli_auth_credentials_store = "file"', 'model_provider = "personal"',
    '[model_providers.personal]', 'name = "Personal"', 'base_url = "http://127.0.0.1:1/v1"',
    'wire_api = "responses"', 'requires_openai_auth = true', '',
  ].join('\n')
  const originalAuth = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: personalKey }) + '\n'
  await replaceFile(files.codexConfig, originalConfig)
  await replaceFile(files.codexAuth, originalAuth)
  const state = await configureCodex({
    files, apiKey: helperKey, origin: 'http://127.0.0.1:1', model: 'gpt-5-codex',
    fast: false, catalog: makeModelCatalog(['gpt-5-codex'], [], { fast: false }),
  })
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_WINDOWS_REGISTERED_CORE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  let host
  const start = async () => {
    const child = spawn(binary, ['--no-daemon', '-c', 'chatgpt_base_url="http://127.0.0.1:1"',
      'app-server', '--stdio'], { cwd: root, env, windowsHide: true })
    const closed = new Promise((resolve) => child.once('close', resolve))
    const lines = createInterface({ input: child.stdout })
    child.stderr.resume()
    let sequence = 0
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        lines.off('line', receive)
        reject(new Error(`Restore RPC timed out: ${method}`))
      }, 10000)
      const receive = (line) => {
        const response = JSON.parse(line)
        if (response.id !== id) return
        clearTimeout(timer)
        lines.off('line', receive)
        if (response.error) reject(new Error(`Restore RPC failed: ${method}`))
        else resolve(response.result)
      }
      lines.on('line', receive)
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    const stop = async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2500)
      try { await closed } finally { clearTimeout(timer); lines.close() }
    }
    host = { rpc, stop }
    await rpc('initialize', {
      clientInfo: { name: 'yisama_restore_test', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write('{"method":"initialized"}\n')
    return host
  }
  t.after(async () => {
    await host?.stop()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await start()
  const auth = () => host.rpc('getAuthStatus', { includeToken: true, refreshToken: false })
  assert.equal((await auth()).authToken, helperKey)
  const listeners = new Set()
  const nativeMethods = []
  let reply
  const renderer = {
    __yisamaInfiniteAssistant: {
      nativeStatus() {}, snapshot: () => ({ loggedIn: !reply, configured: !reply }),
      receive: (response) => { reply = response },
    },
    __codexRoot: { _internalRoot: { current: { memoizedProps: {
      client: { getQueryCache() {}, async invalidateQueries() {} },
    } } } },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    electronBridge: { async sendMessageFromView({ hostId, request }) {
      nativeMethods.push(request.method)
      const message = { id: request.id }
      try { message.result = await host.rpc(request.method, request.params) }
      catch { message.error = { message: 'Isolated native request failed.' } }
      for (const listener of listeners) listener({ data: { type: 'mcp-response', hostId, message } })
    } },
  }
  renderer.top = renderer
  const context = { window: renderer, location: { href: CODEX_PAGE }, crypto: { randomUUID },
    setTimeout, clearTimeout, document: { querySelectorAll: () => [] } }
  let send
  let afterReply = 0
  const result = await runAssistant({
    endpointFile: path.join(root, 'endpoint.json'), processId: 7,
    readEndpoint: async () => ({ port: 9222, processId: 7 }),
    discover: async () => [{ id: 'isolated-restore', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/restore' }],
    isRunning: () => !reply || ++afterReply <= 3,
    handler: async (command) => {
      assert.equal(command.action, 'restore')
      await restoreCodex(files, state)
      assert.equal(await fs.readFile(files.codexAuth, 'utf8'), originalAuth)
      assert.equal((await auth()).authToken, helperKey, 'the running service still caches the assistant account')
      return { loggedIn: false, configured: false, restartRequired: true }
    },
    nativeConfiguration: async () => null, readUpdate: async () => null,
    restartDelayMs: 60000, pollMs: 0, signal: AbortSignal.timeout(15000),
    report: (message) => assert.fail(message),
    connectionFactory: (_url, onEvent) => {
      send = onEvent
      return {
        socket: { readyState: WebSocket.OPEN }, async connect() {}, close() {},
        async call(method, params = {}) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: CODEX_PAGE } } }
          if (method === 'Runtime.enable') onEvent({ method: 'Runtime.executionContextCreated',
            params: { context: { id: 1, auxData: { isDefault: true, frameId: 'main' } } } })
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'isolated-restore-ui' }
          if (method === 'Runtime.evaluate' &&
            (/^\(async function (syncNativeModels|codexRestartBlocker)/.test(params.expression) ||
              params.expression.includes('__yisamaInfiniteAssistant?.receive'))) {
            return { result: { value: await runInNewContext(params.expression, context) } }
          }
          return {}
        },
      }
    },
    onReady() {
      send({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"restore"}', executionContextId: 1,
      } })
    },
  })
  assert.equal(result, undefined, 'the isolated test never restarts the real desktop app')
  assert.equal(reply?.ok, true)
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), originalConfig)
  assert.equal(await fs.readFile(files.codexAuth, 'utf8'), originalAuth)
  assert.ok(!nativeMethods.includes('account/login/start'), 'no stale account may overwrite restored credentials')
  await host.stop()
  host = null
  await start()
  assert.equal((await auth()).authToken, personalKey, 'a fresh service loads the restored personal account')
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), originalConfig)
  assert.equal(await fs.readFile(files.codexAuth, 'utf8'), originalAuth)
})

test('real Codex reads assistant catalogs for Gemini and Claude after an isolated service restart', {
  skip: !binary && 'Set YISAMA_CODEX_BIN to run the real catalog test.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-model-catalog-'))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    session: path.join(root, 'data/session.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig) }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key]
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const readModels = async () => {
    const child = spawn(binary, ['--no-daemon', 'app-server', '--stdio'], {
      env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    const lines = createInterface({ input: child.stdout })
    child.stderr.resume()
    let sequence = 0
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        lines.off('line', receive)
        reject(new Error(`Catalog RPC timed out: ${method}`))
      }, 10000)
      const receive = (line) => {
        const response = JSON.parse(line)
        if (response.id !== id) return
        clearTimeout(timer)
        lines.off('line', receive)
        if (response.error) reject(new Error(JSON.stringify(response.error)))
        else resolve(response.result)
      }
      lines.on('line', receive)
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    try {
      await rpc('initialize', { clientInfo: { name: 'yisama_catalog_test', version: '0.1.0' } })
      child.stdin.write('{"method":"initialized"}\n')
      return (await rpc('model/list', { includeHidden: true })).data
    } finally {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 3000)
      await closed
      clearTimeout(timer)
      lines.close()
    }
  }
  let state = {}
  for (const models of [['gemini-3-flash', 'gemini-3-pro'], ['claude-opus-4-6']]) {
    state = await configureCodex({
      files, state, apiKey: 'sk-local-catalog-test', origin: 'http://127.0.0.1:1',
      model: models[0], reasoning: null, fast: false, catalog: makeModelCatalog(models),
    })
    const actual = await readModels()
    assert.deepEqual(actual.map((model) => model.model), models)
    assert.ok(actual.every((model) => model.supportedReasoningEfforts.length === 0),
      'unknown reasoning capabilities must not be copied from GPT')
  }
  await restoreCodex(files, state)
  await assert.rejects(fs.access(files.codexConfig), { code: 'ENOENT' })
  for (const file of state.catalogFiles) await assert.rejects(fs.access(file), { code: 'ENOENT' })
})

test('real Codex installs the marketplace and discovers the plugin skill', {
  skip: !binary && 'Set YISAMA_CODEX_BIN to run the real Codex integration test.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-install-'))
  let host
  let closed
  let lines
  t.after(async () => {
    if (host) {
      host.stdin.end()
      await closed
      lines?.close()
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const env = { ...process.env, CODEX_HOME: root, NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const added = await exec(binary, [
    '--no-daemon', 'plugin', 'marketplace', 'add', repository, '--json',
  ], { env, cwd: repository, timeout: 30000 })
  assert.match(added.stdout, /yisama/)
  const installed = await exec(binary, [
    '--no-daemon', 'plugin', 'add', 'yisama-infinite-assistant@yisama', '--json',
  ], { env, cwd: repository, timeout: 30000 })
  const result = JSON.parse(installed.stdout)
  assert.match(JSON.stringify(result), /yisama-infinite-assistant/)
  const listed = await exec(binary, ['--no-daemon', 'plugin', 'list', '--json'], {
    env, cwd: repository, timeout: 30000,
  })
  assert.match(listed.stdout, /yisama-infinite-assistant/)
  host = spawn(binary, ['--no-daemon', 'app-server', '--stdio'], { env, cwd: repository, windowsHide: true })
  closed = new Promise((resolve) => host.once('close', resolve))
  lines = createInterface({ input: host.stdout })
  host.stderr.resume()
  let id = 0
  async function rpc(method, params) {
    const requestId = ++id
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lines.off('line', onLine)
        reject(new Error(`App-server timed out: ${method}`))
      }, 15000)
      const onLine = (line) => {
        const message = JSON.parse(line)
        if (message.id !== requestId) return
        clearTimeout(timer)
        lines.off('line', onLine)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
      lines.on('line', onLine)
    })
    host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return response
  }
  await rpc('initialize', {
    clientInfo: { name: 'yisama_plugin_test', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  host.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
  const skills = await rpc('skills/list', { cwds: [repository], forceReload: true })
  assert.match(JSON.stringify(skills), /yisama-setup/)
  assert.match(JSON.stringify(skills), /adjust reasoning levels including Ultra/)
})

test('real Codex sends priority Responses and the selected reasoning including Ultra', {
  skip: !binary && 'Set YISAMA_CODEX_BIN to run the real Codex integration test.',
  timeout: 100000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-codex-'))
  const received = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    if (!req.url.startsWith('/v1/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found' } }))
      return
    }
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const item = {
      id: 'msg_local_1', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'YISAMA_TEST_OK', annotations: [] }],
    }
    const response = {
      id: 'resp_local_1', object: 'response', created_at: 1, status: 'completed',
      model: 'gpt-5.6-sol', output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'YISAMA_TEST_OK' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'YISAMA_TEST_OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    })
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const files = {
    pluginData: path.join(root, 'data'),
    state: path.join(root, 'data', 'state.json'),
    codexConfig: path.join(root, 'codex', 'config.toml'),
    codexAuth: path.join(root, 'codex', 'auth.json'),
  }
  const apiKey = 'sk-local-codex-integration-test-only'
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
  let state = {}
  for (const [level, expected] of [
    ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'], ['ultra', 'max'], [null, 'low'],
  ]) {
    await t.test(level || 'auto after Ultra', async () => {
      state = await configureCodex({ files, state, apiKey, origin, model: 'gpt-5.6-sol', reasoning: level })
      const start = received.length
      const result = await exec(binary, [
        // Plugin discovery is verified separately; keep this request fixture offline.
        '--no-daemon', '--disable', 'plugins', '-c', `chatgpt_base_url="${origin}"`,
        'exec', '--strict-config', '--skip-git-repo-check', '--ephemeral',
        '--sandbox', 'read-only', '--json', 'Reply exactly YISAMA_TEST_OK. Do not use tools.',
      ], { env, cwd: root, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
      assert.ok(received.length > start, 'Codex must actually contact the local Responses endpoint')
      for (const request of received.slice(start)) {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`)
        assert.equal(request.body.service_tier, 'priority')
        assert.equal(request.body.model, 'gpt-5.6-sol')
        assert.equal(request.body.reasoning.effort, expected)
        if (level === 'ultra') assert.equal(request.body.reasoning.context, 'all_turns')
      }
      assert.match(result.stdout, /YISAMA_TEST_OK/)
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(apiKey))
    })
  }
})
