import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { configureCodex, makeModelCatalog } from './codex-config.mjs'

const binary = process.env.YISAMA_CODEX_BIN

test('real Codex switches groups without restarting or interrupting an active answer', {
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
  let state = await configureCodex({
    files, apiKey: 'sk-first-test-group', origin, model: 'gemini-3-flash', reasoning: null,
    fast: false, catalog: makeModelCatalog(['gemini-3-flash']),
  })
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig) }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  const child = spawn(binary, ['--no-daemon', '-c', `chatgpt_base_url="${origin}"`,
    'app-server', '--stdio'], { cwd: root, env, windowsHide: true })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })
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
  assert.deepEqual((await rpc('model/list', { includeHidden: true })).data.map((model) => model.model),
    ['gemini-3-flash'])
  const first = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, model: 'gemini-3-flash' })
  await rpc('turn/start', { threadId: first.thread.id, input: [{ type: 'text', text: 'Reply OK.' }] })
  await until(() => requests.length === 1)
  state = await configureCodex({
    files, state, apiKey: 'sk-first-test-group', origin, model: 'claude-opus-4-6', reasoning: null,
    fast: false, catalog: makeModelCatalog(['claude-opus-4-6']),
  })
  await rpc('account/login/start', { type: 'apiKey', apiKey: 'sk-first-test-group' })
  assert.deepEqual((await rpc('model/list', { includeHidden: true })).data.map((model) => model.model),
    ['claude-opus-4-6'], 'the native picker catalog updates while the first answer is still active')
  const second = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, model: 'claude-opus-4-6' })
  await rpc('turn/start', { threadId: second.thread.id, input: [{ type: 'text', text: 'Reply OK.' }] })
  await until(() => requests.length >= 2)
  assert.equal(requests[1].body.model, 'claude-opus-4-6')
  assert.equal(requests[1].auth, 'Bearer sk-first-test-group')
  assert.equal((await rpc('thread/read', { threadId: first.thread.id })).thread.status.type, 'active')
  releaseFirst()
  releaseFirst = null
  await until(async () => (await rpc('thread/read', { threadId: first.thread.id })).thread.status.type !== 'active')
  await rpc('turn/start', { threadId: first.thread.id, model: 'claude-opus-4-6',
    input: [{ type: 'text', text: 'Reply OK again.' }] })
  await until(() => requests.length >= 3)
  assert.equal(requests[2].body.model, 'claude-opus-4-6')
  assert.equal(requests[2].auth, 'Bearer sk-first-test-group')
})
