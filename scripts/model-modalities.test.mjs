import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { promisify } from 'node:util'
import { configureCodex, makeModelCatalog } from './codex-config.mjs'

test('unknown input capabilities do not become a text-only declaration', () => {
  const catalog = makeModelCatalog(['unknown-chat-model'])
  assert.equal(Object.hasOwn(catalog.models[0], 'input_modalities'), false)
})

test('capability metadata merges by field without replacing explicit input modalities', () => {
  for (const input_modalities of [['text'], ['text', 'image']]) {
    const catalog = makeModelCatalog(['known-chat-model'], [
      { slug: 'known-chat-model', input_modalities },
      { slug: 'known-chat-model', display_name: 'Known chat model' },
    ])
    assert.deepEqual(catalog.models[0].input_modalities, input_modalities)
    assert.equal(catalog.models[0].display_name, 'Known chat model')
  }
})

test('real Codex distinguishes omitted input capabilities from explicit text-only models', {
  skip: !process.env.YISAMA_CODEX_BIN && 'Set YISAMA_CODEX_BIN to verify native catalog defaults.',
  timeout: 30000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-modalities-'))
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  let child
  let closed
  let lines
  t.after(async () => {
    if (child) {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2500)
      try { await closed } finally { clearTimeout(timer); lines.close() }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const catalog = makeModelCatalog(['unknown-chat-model', 'text-only-model', 'vision-chat-model'], [
    { slug: 'text-only-model', input_modalities: ['text'] },
    { slug: 'vision-chat-model', input_modalities: ['text', 'image'] },
  ])
  // Probe the native schema independently of the generator's current default.
  delete catalog.models[0].input_modalities
  await configureCodex({
    files, apiKey: 'sk-isolated-modality-test', origin: 'http://127.0.0.1:1',
    model: 'unknown-chat-model', reasoning: null, fast: false, catalog,
  })
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_WINDOWS_REGISTERED_CORE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(process.env.YISAMA_CODEX_BIN, [
    '--no-daemon', '--disable', 'plugins', '-c', 'chatgpt_base_url="http://127.0.0.1:1"',
    'app-server', '--stdio',
  ], { cwd: root, env, windowsHide: true })
  closed = new Promise((resolve) => child.once('close', resolve))
  lines = createInterface({ input: child.stdout })
  child.stderr.resume()
  let sequence = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const receive = (line) => {
      const message = JSON.parse(line)
      if (message.id !== id) return
      clearTimeout(timer)
      lines.off('line', receive)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    const timer = setTimeout(() => {
      lines.off('line', receive)
      reject(new Error(`Modality RPC timed out: ${method}`))
    }, 10000)
    lines.on('line', receive)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  await rpc('initialize', { clientInfo: { name: 'yisama_modality_test', version: '0.1.0' } })
  child.stdin.write('{"method":"initialized"}\n')
  const models = (await rpc('model/list', { includeHidden: true })).data
  const modalities = Object.fromEntries(models.map((model) => [model.model, model.inputModalities]))
  assert.deepEqual(modalities, {
    'unknown-chat-model': ['text', 'image'],
    'text-only-model': ['text'],
    'vision-chat-model': ['text', 'image'],
  })
})

test('real Codex sends an image through a catalog without invented input restrictions', {
  skip: !process.env.YISAMA_CODEX_BIN && 'Set YISAMA_CODEX_BIN to verify image requests.',
  timeout: 30000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-modality-request-'))
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] !== '/v1/responses') {
      res.writeHead(404)
      res.end('{}')
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const response = {
      id: 'resp_modality_test', object: 'response', status: 'completed', created_at: 1,
      model: body.model,
      output: [{ id: 'msg_modality_test', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'IMAGE_REQUEST_OK', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: response.output[0] },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const files = {
    pluginData: path.join(root, 'data'), state: path.join(root, 'data/state.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  await configureCodex({
    files, apiKey: 'sk-isolated-modality-request', origin, model: 'unknown-chat-model',
    reasoning: null, fast: false, catalog: makeModelCatalog(['unknown-chat-model']),
  })
  const image = path.join(root, 'pixel.png')
  const imageBytes = await fs.readFile(new URL('../windows/assets/icon-16.png', import.meta.url))
  await fs.writeFile(image, imageBytes)
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_WINDOWS_REGISTERED_CORE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  const pending = promisify(execFile)(process.env.YISAMA_CODEX_BIN, [
    '--no-daemon', '--disable', 'plugins', '-c', `chatgpt_base_url="${origin}"`,
    'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json',
    '--image', image,
  ], { cwd: root, env, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 })
  pending.child.stdin.end('Reply IMAGE_REQUEST_OK. Do not use tools.\n')
  const { stdout, stderr } = await pending
  assert.equal(pending.child.killed, false)
  assert.match(stdout, /IMAGE_REQUEST_OK/)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'unknown-chat-model')
  const images = requests[0].input.flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((item) => item.type === 'input_image')
  assert.equal(images.length, 1, `the client must not drop the attached image: ${stderr}`)
  assert.match(images[0].image_url, /^data:image\/png;base64,/)
})
