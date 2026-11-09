import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configureCodex, imagegenPaths, installImagegen, makeModelCatalog, readOptional,
  replaceFile, restoreCodex, uninstallImagegen } from './codex-config.mjs'
import { initializeCodexSkills, runImagegen } from './imagegen.mjs'
import { safeError } from './yisama.mjs'

const exec = promisify(execFile)
const entry = fileURLToPath(new URL('./yisama.mjs', import.meta.url))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrS0AAAAASUVORK5CYII=', 'base64')
const apiKey = 'sk-local-image-test-only'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-image-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const files = {
    pluginData: path.join(root, 'assistant'),
    state: path.join(root, 'assistant', 'state.json'),
    session: path.join(root, 'assistant', 'session.json'),
    codexConfig: path.join(root, 'codex', 'config.toml'),
    codexAuth: path.join(root, 'codex', 'auth.json'),
  }
  const calls = []
  let mode = 'base64'
  const state = { userId: 7, imagesAllowed: true, keys: [], metadataFailure: false }
  const pricing = { success: true,
    supported_endpoint: { 'image-generation': { path: '/v1/images/generations', method: 'POST' } }, data: [
    { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'], enable_groups: ['images'] },
    { model_name: 'nano-banana-2', supported_endpoint_types: ['image-generation'], enable_groups: ['images'] },
    { model_name: 'neutral-alias', supported_endpoint_types: ['image-generation'], enable_groups: ['images'] },
    { model_name: 'chat-image-looking', supported_endpoint_types: ['openai'], enable_groups: ['images'] },
    { model_name: 'not-authorized', supported_endpoint_types: ['image-generation'], enable_groups: ['images'] },
    { model_name: 'admin-only', supported_endpoint_types: ['image-generation'], enable_groups: ['owner-all'] },
  ] }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, origin)
    const bytes = Buffer.concat(chunks)
    const body = bytes.length && req.headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : null
    calls.push({ path: url.pathname, method: req.method, headers: req.headers, bytes, body })
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.url === '/download.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(png)
    }
    if (url.pathname === '/v1/responses') {
      const item = { id: 'msg_image_rule_test', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'IMAGE_RULES_LOADED', annotations: [] }] }
      const response = { id: 'resp_image_rule_test', object: 'response', status: 'completed', created_at: 1,
        model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      return res.end()
    }
    if (url.pathname === '/api/pricing') {
      return state.metadataFailure ? reply({}, 503) : reply(pricing)
    }
    if (url.pathname.startsWith('/api/')) {
      const userId = Number(req.headers.authorization?.match(/^Bearer dashboard-test-user-(\d+)$/)?.[1])
      if (userId !== state.userId) return reply({ success: false }, 401)
      if (url.pathname === '/api/user/self') {
        return reply({ success: true, data: { id: userId, username: `user-${userId}` } })
      }
      if (url.pathname === '/api/user/self/groups') {
        return reply({ success: true, data: { auto: {}, ...(state.imagesAllowed ? { images: {} } : {}) } })
      }
      if (url.pathname === '/api/token/search') {
        return reply({ success: true, data: { items: state.keys.filter((key) =>
          key.user_id === userId && key.name === url.searchParams.get('keyword')) } })
      }
      if (url.pathname === '/api/token/' && req.method === 'POST') {
        if (body.name.length > 50) return reply({ success: false, message: 'Token name is too long' })
        state.keys.push({ ...body, id: state.keys.length + 1, user_id: userId,
          status: 1, fast_mode_available: false })
        return reply({ success: true })
      }
      if (url.pathname === '/api/token/' && req.method === 'PUT') {
        const key = state.keys.find((key) => key.user_id === userId && key.id === body.id)
        if (!key) return reply({ success: false }, 404)
        Object.assign(key, body)
        return reply({ success: true })
      }
      const id = Number(url.pathname.match(/^\/api\/token\/(\d+)(?:\/key)?$/)?.[1])
      const key = state.keys.find((key) => key.id === id && key.user_id === userId)
      if (!key) return reply({ success: false }, 404)
      return reply({ success: true, data: url.pathname.endsWith('/key')
        ? { key: `${apiKey}-${userId}-${key.id}` } : key })
    }
    if (mode === 'failure') return reply({ error: { message: apiKey } }, 403)
    if (mode === 'redirect') {
      res.writeHead(307, { location: `${origin}/official-trap` })
      return res.end()
    }
    if (req.url === '/v1/models') return reply({ data:
      ['gpt-image-2', 'nano-banana-2', 'neutral-alias', 'chat-image-looking', 'admin-only'].map((id) => ({ id })) })
    if (mode === 'url') return reply({ data: [{ url: `${origin}/download.png` }] })
    const n = req.headers['content-type']?.includes('application/json')
      ? JSON.parse(Buffer.concat(chunks)).n : 1
    reply({ data: Array.from({ length: n }, () => ({ b64_json: png.toString('base64') })) })
  })
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const locations = imagegenPaths(files)
  const env = { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), PLUGIN_DATA: files.pluginData,
    YISAMA_PORTAL_URL: origin, NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  const cli = (...args) => exec(process.execPath, [entry, 'image', ...args], {
    env, windowsHide: true, timeout: 20000,
  })
  const configure = async () => {
    await installImagegen(files)
    const configured = await configureCodex({
      files, apiKey, origin, model: 'chat-model',
      statePatch: { origin, userId: state.userId, group: 'auto',
        keyFingerprint: createHash('sha256').update(apiKey).digest('hex') },
    })
    await replaceFile(files.session, JSON.stringify({ origin, token: `dashboard-test-user-${state.userId}` }))
    await cli('model')
    calls.length = 0
    return configured
  }
  return { root, files, locations, origin, calls, state, pricing, env, configure, cli,
    setMode: (value) => { mode = value } }
}

const generations = (f) => f.calls.filter((call) => call.path.startsWith('/v1/images/'))

test('installation configures the existing system skill without logging in or changing chat settings', async (t) => {
  const f = await fixture(t)
  await replaceFile(f.locations.skill, 'original system skill\n')
  await replaceFile(f.files.codexConfig, 'model = "untouched-chat"\n')
  await replaceFile(f.files.codexAuth, '{"personal":"untouched"}\n')
  const before = await Promise.all([f.files.codexConfig, f.files.codexAuth].map(readOptional))
  const result = await f.cli('install')
  assert.match(result.stdout, /imagegen/)
  const installed = await readOptional(f.locations.skill)
  assert.match(installed, /name: imagegen/)
  assert.ok(installed.includes(entry))
  assert.match(installed, /yisama-managed-imagegen/)
  assert.doesNotMatch(installed, /sk-|apiKey|Bearer/)
  assert.deepEqual(await Promise.all([f.files.codexConfig, f.files.codexAuth].map(readOptional)), before)
  assert.equal(await readOptional(f.locations.config), null)
  await assert.rejects(f.cli('generate', '--prompt', 'red cube'), (error) => {
    assert.match(error.stderr, /侧栏登录/)
    return true
  })
  assert.equal(f.calls.length, 0)
  await f.cli('install')
  assert.equal(JSON.parse(await readOptional(f.locations.snapshot)).original, 'original system skill\n')
  await f.cli('uninstall')
  assert.equal(await readOptional(f.locations.skill), 'original system skill\n')
})

test('login configures images automatically and later chat changes cannot redirect image requests', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const config = JSON.parse(await readOptional(f.locations.config))
  assert.equal(config.baseUrl, `${f.origin}/v1`)
  assert.equal(config.version, 2)
  assert.equal(config.userId, 7)
  assert.equal(config.group, 'images')
  assert.ok(config.keyName.length <= 50, 'image device names must fit the production API limit')
  assert.notEqual(config.apiKey, apiKey)
  assert.equal(config.model, 'gpt-image-2')
  await replaceFile(f.files.codexConfig, 'model_provider = "other"\nmodel = "other-chat"\n')
  await replaceFile(f.files.codexAuth, '{"OPENAI_API_KEY":"sk-other-provider"}')
  const out = path.join(f.root, 'result.png')
  const result = await f.cli('generate', '--prompt', 'red cube', '--size', '1024x1024', '--out', out)
  assert.deepEqual(await fs.readFile(out), png)
  const report = JSON.parse(result.stdout)
  assert.equal(report.model, 'gpt-image-2')
  assert.equal(report.requestedSize, '1024x1024')
  assert.equal(report.images[0].width, 1, 'actual dimensions must not be replaced with requested dimensions')
  assert.equal(generations(f)[0].headers.authorization, `Bearer ${config.apiKey}`)
  assert.equal(generations(f)[0].path, '/v1/images/generations')
  assert.doesNotMatch(result.stdout + result.stderr, /sk-local|sk-other|Bearer|127\.0\.0\.1/)
})

test('an upgrade provisions a dedicated image key and never migrates the applied chat credential', async (t) => {
  const f = await fixture(t)
  await f.configure()
  await fs.rm(f.locations.config)
  await replaceFile(f.files.codexAuth, '{"OPENAI_API_KEY":"sk-other-provider"}')
  await f.cli('install')
  assert.equal(await readOptional(f.locations.config), null)
  await replaceFile(f.locations.config, JSON.stringify({
    version: 1, baseUrl: `${f.origin}/v1`, apiKey, model: 'nano-banana-2',
  }))
  await f.cli('model')
  const migrated = JSON.parse(await readOptional(f.locations.config))
  assert.equal(migrated.version, 2)
  assert.equal(migrated.group, 'images')
  assert.notEqual(migrated.apiKey, apiKey)
  assert.equal(migrated.model, 'nano-banana-2')
  assert.equal(f.state.keys.length, 1, 'the image credential must be reused on the same device')
  assert.equal(generations(f).length, 0)
})

test('model overrides and saved image defaults do not alter the chat model or Fast', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const before = await readOptional(f.files.codexConfig)
  await f.cli('model', '--name', 'nano-banana-2')
  await f.cli('generate', '--prompt', 'cube', '--out', path.join(f.root, 'default.png'))
  await f.cli('generate', '--prompt', 'cube', '--model', 'gpt-image-2', '--out', path.join(f.root, 'override.png'))
  assert.deepEqual(generations(f).map((call) => JSON.parse(call.bytes).model), ['nano-banana-2', 'gpt-image-2'])
  assert.equal(await readOptional(f.files.codexConfig), before)
  const state = JSON.parse(await readOptional(f.files.state))
  await configureCodex({ files: f.files, state, origin: f.origin, apiKey, model: 'another-chat' })
  assert.equal(JSON.parse(await readOptional(f.locations.config)).model, 'nano-banana-2')
})

test('multipart edits include all image inputs and the mask with the exact chosen model', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const source = path.join(f.root, 'input.png')
  const mask = path.join(f.root, 'mask.png')
  await fs.writeFile(source, png)
  await fs.writeFile(mask, png)
  await f.cli('edit', '--prompt', 'change the cube', '--model', 'nano-banana-pro',
    '--image', source, '--image', source, '--mask', mask, '--out', path.join(f.root, 'edit.png'))
  const [call] = generations(f)
  assert.equal(call.path, '/v1/images/edits')
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/)
  const form = await new Response(call.bytes, { headers: { 'Content-Type': call.headers['content-type'] } }).formData()
  assert.equal(form.get('model'), 'nano-banana-pro')
  assert.equal(form.getAll('image[]').length, 2)
  assert.deepEqual(Buffer.from(await form.get('mask').arrayBuffer()), png)
})

test('URL responses download the image without forwarding the assistant credential', async (t) => {
  const f = await fixture(t)
  await f.configure()
  f.setMode('url')
  const out = path.join(f.root, 'url.png')
  await f.cli('generate', '--prompt', 'cube', '--out', out)
  assert.deepEqual(await fs.readFile(out), png)
  assert.equal(f.calls.at(-1).path, '/download.png')
  assert.equal(f.calls.at(-1).headers.authorization, undefined)
})

test('HTTP rejection and redirects never fall back, retry generation, or disclose server errors', async (t) => {
  const f = await fixture(t)
  await f.configure()
  for (const mode of ['failure', 'redirect']) {
    f.setMode(mode)
    await assert.rejects(f.cli('generate', '--prompt', 'cube', '--out', path.join(f.root, `${mode}.png`)), (error) => {
      assert.match(error.stderr, /未切换/)
      assert.doesNotMatch(error.stderr, /sk-local|Bearer|127\.0\.0\.1|official-trap/)
      return true
    })
  }
  assert.deepEqual(generations(f).map((call) => call.path), ['/v1/images/generations', '/v1/images/generations'])
})

test('logout removes image credentials and uninstall restores only unmodified owned skill content', async (t) => {
  const f = await fixture(t)
  await replaceFile(f.locations.skill, 'original\n')
  const state = await f.configure()
  await restoreCodex(f.files, state)
  assert.equal(await readOptional(f.locations.config), null)
  assert.match(await readOptional(f.locations.skill), /yisama-managed-imagegen/)
  const changed = (await readOptional(f.locations.skill)) + '\npersonal edits\n'
  await replaceFile(f.locations.skill, changed)
  await assert.rejects(installImagegen(f.files), /后续修改/)
  await assert.rejects(uninstallImagegen(f.files), /后续修改/)
  assert.equal(await readOptional(f.locations.skill), changed)
  assert.equal(JSON.parse(await readOptional(f.locations.snapshot)).original, 'original\n')
  const snapshot = JSON.parse(await readOptional(f.locations.snapshot))
  await replaceFile(f.locations.skill, snapshot.applied)
  await uninstallImagegen(f.files)
  assert.equal(await readOptional(f.locations.skill), 'original\n')
})

test('chat login rollback cannot rewrite the independent image credential or saved model', async (t) => {
  const f = await fixture(t)
  let state = await f.configure()
  await f.cli('model', '--name', 'nano-banana-2')
  const before = await readOptional(f.locations.config)
  await assert.rejects(configureCodex({
    files: f.files, state, origin: f.origin, apiKey: 'sk-changed-local',
    write: async (file, text) => {
      if (file === state.backups.appliedAuth) throw new Error('test disk failure')
      await replaceFile(file, text)
    },
  }), /test disk failure/)
  assert.equal(await readOptional(f.locations.config), before)
  state = JSON.parse(await readOptional(f.files.state))
  assert.equal(state.configured, true)
})

test('shared configuration waits for native system initialization before taking over imagegen', async (t) => {
  const f = await fixture(t)
  const state = await configureCodex({ files: f.files, apiKey, origin: f.origin, model: 'first-chat' })
  assert.equal(await readOptional(f.locations.skill), null)
  assert.equal(await readOptional(f.locations.config), null)
  await replaceFile(path.join(path.dirname(f.locations.skill), '..', '.codex-system-skills.marker'), 'native-version')
  await replaceFile(f.locations.skill, 'original native imagegen\n')
  await configureCodex({ files: f.files, state, apiKey, origin: f.origin, model: 'second-chat' })
  assert.match(await readOptional(f.locations.skill), /yisama-managed-imagegen/)
  assert.equal(JSON.parse(await readOptional(f.locations.snapshot)).original, 'original native imagegen\n')
})

test('dry-run, invalid parameters, and existing outputs never submit a generation', async (t) => {
  const f = await fixture(t)
  const result = await f.cli('generate', '--prompt', 'cube', '--dry-run')
  assert.equal(JSON.parse(result.stdout).payload.model, 'gpt-image-2')
  assert.equal(f.calls.length, 0)
  await f.configure()
  const output = path.join(f.root, 'existing.png')
  await fs.writeFile(output, png)
  for (const flags of [
    ['--out', output],
    ['--n', '0'],
    ['--background', 'transparent'],
    ['--input-fidelity', 'high'],
    ['--size', 'bad'],
    ['--out', path.join(f.root, 'wrong.jpeg')],
  ]) await assert.rejects(f.cli('generate', '--prompt', 'cube', ...flags))
  assert.deepEqual(await fs.readFile(output), png)
  assert.equal(generations(f).length, 0)
  assert.ok(f.calls.every((call) => call.method === 'GET'), 'invalid inputs must not mutate a credential or generate')
})

test('multiple variants, UTF-8 prompt files, and model listing use the station route', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const prompt = path.join(f.root, 'prompt.txt')
  await fs.writeFile(prompt, '\u7ea2\u8272\u65b9\u5757', 'utf8')
  await f.cli('generate', '--prompt-file', prompt, '--n', '2', '--out', path.join(f.root, 'variant.png'))
  assert.deepEqual(await fs.readFile(path.join(f.root, 'variant-1.png')), png)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'variant-2.png')), png)
  assert.equal(JSON.parse(generations(f)[0].bytes).prompt, '\u7ea2\u8272\u65b9\u5757')
  const result = await f.cli('models')
  assert.match(result.stdout, /gpt-image-2/)
  assert.match(result.stdout, /nano-banana-2/)
  assert.match(result.stdout, /neutral-alias/)
  assert.doesNotMatch(result.stdout, /chat-image-looking|not-authorized|admin-only/)
  assert.equal(f.calls.at(-1).path, '/api/pricing')
})

test('model discovery reports the live choices and confirms defaults without silently replacing an unavailable default', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const first = await f.cli('models')
  assert.deepEqual(first.stdout.trim().split(/\r?\n/), [
    '你当前可用的生图模型：', 'gpt-image-2', 'nano-banana-2', 'neutral-alias',
    '默认生图模型：gpt-image-2',
  ])
  await f.cli('model', '--name', 'neutral-alias')
  assert.match((await f.cli('models')).stdout, /默认生图模型：neutral-alias/)
  f.pricing.data = f.pricing.data.filter((item) => item.model_name !== 'neutral-alias')
  const unavailable = await f.cli('models')
  assert.deepEqual(unavailable.stdout.trim().split(/\r?\n/), [
    '你当前可用的生图模型：', 'gpt-image-2', 'nano-banana-2',
    '已保存的默认模型 neutral-alias 目前不可用，请从以上模型中选择。',
  ])
  assert.equal(JSON.parse(await readOptional(f.locations.config)).model, 'neutral-alias')
  assert.doesNotMatch(first.stdout + unavailable.stdout, /Images API|凭据|分组|能力目录/)
  assert.equal(generations(f).length, 0)
  assert.ok(f.calls.every((call) => call.method === 'GET'))
})

test('unexpected network errors are sanitized before being shown to the user', async (t) => {
  const f = await fixture(t)
  await f.configure()
  await assert.rejects(runImagegen(f.files, ['generate', '--prompt', 'cube',
    '--out', path.join(f.root, 'network.png')], {
    fetchImpl: async () => { throw new Error(`Authorization: Bearer ${apiKey}`) },
  }), (error) => {
    assert.doesNotMatch(safeError(error), /sk-local|Bearer|Authorization/)
    assert.match(safeError(error), /未切换/)
    return true
  })
})

test('global routing preserves personal instructions and an active global override across upgrades and removal', async (t) => {
  const f = await fixture(t)
  const home = path.dirname(f.files.codexConfig)
  const agents = path.join(home, 'AGENTS.md')
  const override = path.join(home, 'AGENTS.override.md')
  const personal = '# Personal\nKeep my settings.\n'
  const preferred = '# Override\r\nMy own rules.\r\n'
  await replaceFile(agents, personal)
  await replaceFile(override, preferred)
  await installImagegen(f.files)
  for (const file of [agents, override]) {
    const text = await readOptional(file)
    assert.match(text, /yisama-image-routing:begin/)
    assert.ok(text.includes(f.locations.skill))
    assert.match(text, /image models/)
    assert.doesNotMatch(text, /sk-|apiKey|Bearer/)
  }
  await replaceFile(agents, (await readOptional(agents)) + '\nLater personal rule.\n')
  await replaceFile(override, (await readOptional(override)) + '\nLater override.\n')
  await installImagegen(f.files)
  await installImagegen(f.files)
  assert.equal((await readOptional(agents)).split('yisama-image-routing:begin').length, 2)
  await uninstallImagegen(f.files)
  assert.equal(await readOptional(agents), personal + '\nLater personal rule.\n')
  assert.equal(await readOptional(override), preferred + '\nLater override.\n')
  assert.equal(await readOptional(f.locations.instructions), null)
})

test('global routing covers a later override and does not leave empty files after uninstall', async (t) => {
  const f = await fixture(t)
  const home = path.dirname(f.files.codexConfig)
  const agents = path.join(home, 'AGENTS.md')
  const override = path.join(home, 'AGENTS.override.md')
  await installImagegen(f.files)
  assert.equal(await readOptional(override), null, 'installation must not create a global override')
  await replaceFile(override, 'New personal override.\n')
  await installImagegen(f.files)
  assert.match(await readOptional(override), /image models/)
  await uninstallImagegen(f.files)
  assert.equal(await readOptional(agents), null)
  assert.equal(await readOptional(override), 'New personal override.\n')
})

test('modified owned global instructions stop removal without losing the skill or credential', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const agents = path.join(path.dirname(f.files.codexConfig), 'AGENTS.md')
  const changed = (await readOptional(agents)).replace('Image Requests', 'Personal Image Requests')
  await replaceFile(agents, changed)
  const before = await readOptional(f.locations.config)
  await assert.rejects(uninstallImagegen(f.files), /后续修改/)
  await assert.rejects(installImagegen(f.files), /后续修改/)
  assert.equal(await readOptional(agents), changed)
  assert.equal(await readOptional(f.locations.config), before)
  assert.match(await readOptional(f.locations.skill), /yisama-managed-imagegen/)
})

test('global instruction write failure rolls back the system skill and all managed snapshots', async (t) => {
  const f = await fixture(t)
  const agents = path.join(path.dirname(f.files.codexConfig), 'AGENTS.md')
  await replaceFile(f.locations.skill, 'Original image skill.\n')
  await replaceFile(agents, 'Personal rules.\n')
  await assert.rejects(installImagegen(f.files, { write: async (file, text) => {
    if (file === f.locations.instructions) throw new Error('isolated write failure')
    await replaceFile(file, text)
  } }), /isolated write failure/)
  assert.equal(await readOptional(f.locations.skill), 'Original image skill.\n')
  assert.equal(await readOptional(agents), 'Personal rules.\n')
  assert.equal(await readOptional(f.locations.snapshot), null)
  assert.equal(await readOptional(f.locations.instructions), null)
})

test('a missing global ownership snapshot stops uninstall instead of leaving a broken routing rule', async (t) => {
  const f = await fixture(t)
  await installImagegen(f.files)
  await fs.rm(f.locations.instructions)
  await assert.rejects(uninstallImagegen(f.files), /备份缺失/)
  assert.match(await readOptional(f.locations.skill), /yisama-managed-imagegen/)
})

test('image credentials stay scoped to the signed-in user and device without mutating the chat key', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const first = JSON.parse(await readOptional(f.locations.config))
  const chat = { ...f.state.keys[0], id: 2, name: first.keyName.replace('yisama:images:', 'yisama:codex:'),
    group: 'chat-plus', fast_mode: true, fast_mode_available: true }
  f.state.keys.push(chat)
  const before = structuredClone(chat)
  const secondData = path.join(f.root, 'second-device')
  await replaceFile(path.join(secondData, 'session.json'), await readOptional(f.files.session))
  await exec(process.execPath, [entry, 'image', 'models'], { env: { ...f.env, PLUGIN_DATA: secondData } })
  const second = JSON.parse(await readOptional(path.join(secondData, 'imagegen.json')))
  assert.notEqual(second.keyName, first.keyName)
  assert.notEqual(second.apiKey, first.apiKey)
  f.state.userId = 8
  await replaceFile(f.files.session, JSON.stringify({ origin: f.origin, token: 'dashboard-test-user-8' }))
  await f.cli('models')
  const switched = JSON.parse(await readOptional(f.locations.config))
  assert.equal(switched.userId, 8)
  assert.notEqual(switched.apiKey, first.apiKey)
  assert.equal(switched.keyName, first.keyName, 'server token ownership, not a copied device name, separates accounts')
  assert.deepEqual(chat, before)
  for (const config of [first, second, switched]) {
    const key = f.state.keys.find((key) => key.id === config.keyId)
    assert.equal(key.user_id, config.userId)
    assert.equal(key.group, 'images')
    assert.equal(key.fast_mode, false)
    assert.equal(key.cross_group_retry, false)
    assert.deepEqual(key.auto_groups, [])
  }
  assert.equal(generations(f).length, 0)
})

test('a revoked image permission cannot use a stale credential, chat group, or owner-all', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const before = await readOptional(f.files.codexConfig)
  f.state.imagesAllowed = false
  await assert.rejects(f.cli('models'), (error) => {
    assert.match(error.stderr, /尚未开通生图.*联系站点管理员/)
    assert.doesNotMatch(error.stderr, /sk-|Bearer|images|凭据|分组/)
    return true
  })
  assert.equal(await readOptional(f.locations.config), null)
  assert.equal(await readOptional(f.files.codexConfig), before)
  assert.equal(generations(f).length, 0)
  assert.ok(f.calls.every((call) => call.method === 'GET'))
})

test('model discovery uses only GETs and reports unavailable metadata separately from an empty catalog', async (t) => {
  const f = await fixture(t)
  await f.configure()
  await f.cli('models')
  assert.ok(f.calls.every((call) => call.method === 'GET'))
  assert.equal(f.calls.find((call) => call.path === '/api/pricing').headers.authorization, undefined)
  f.state.metadataFailure = true
  await assert.rejects(f.cli('models'), (error) => {
    assert.match(error.stderr, /暂时查不到你的生图模型.*稍后重试/)
    assert.doesNotMatch(error.stdout, /gpt-image|chat-image/)
    assert.doesNotMatch(error.stderr, /Images API|凭据|分组|能力目录/)
    return true
  })
  f.state.metadataFailure = false
  f.pricing.data = []
  const empty = await f.cli('models')
  assert.equal(empty.stdout.trim(), '你的账号目前没有可用的生图模型。')
  f.pricing.data = [{ model_name: 'gpt-image-2' }]
  await assert.rejects(f.cli('models'), (error) => {
    assert.match(error.stderr, /无法读取你的生图模型清单.*稍后重试/)
    assert.equal(error.stdout, '')
    return true
  })
  f.setMode('failure')
  await assert.rejects(f.cli('models'), (error) => {
    assert.match(error.stderr, /暂时查不到你的生图模型.*稍后重试/)
    assert.equal(error.stdout, '')
    assert.doesNotMatch(error.stderr, /Images API|凭据|分组|能力目录|sk-|Bearer/)
    return true
  })
  assert.equal(generations(f).length, 0)
})

test('a real new Codex conversation receives image routing from its active global override', {
  skip: !process.env.YISAMA_CODEX_BIN && 'Set YISAMA_CODEX_BIN for real global-instruction loading.',
  timeout: 45000,
}, async (t) => {
  const f = await fixture(t)
  const home = path.dirname(f.files.codexConfig)
  await replaceFile(path.join(home, 'AGENTS.md'), 'MAIN_ONLY_PERSONAL_SENTINEL\n')
  await replaceFile(path.join(home, 'AGENTS.override.md'), 'OVERRIDE_PERSONAL_SENTINEL\n')
  await installImagegen(f.files, {
    initialize: () => initializeCodexSkills(f.files, process.env.YISAMA_CODEX_BIN),
  })
  const state = await f.configure()
  await configureCodex({ files: f.files, state, apiKey, origin: f.origin,
    model: 'gpt-5.5', fast: false, catalog: makeModelCatalog(['gpt-5.5']) })
  const env = { ...f.env }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_WINDOWS_REGISTERED_CORE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  const pending = exec(process.env.YISAMA_CODEX_BIN, ['--no-daemon', '--disable', 'plugins',
    '-c', `chatgpt_base_url="${f.origin}"`, 'exec', '--strict-config', '--skip-git-repo-check',
    '--ephemeral', '--sandbox', 'read-only', '--json', '\u6709\u54ea\u4e9b\u751f\u56fe\u6a21\u578b\uff1f'],
  { env, cwd: f.root, timeout: 25000, maxBuffer: 2 * 1024 * 1024 })
  pending.child.stdin.end()
  const result = await pending
  assert.match(result.stdout, /IMAGE_RULES_LOADED/)
  const requests = f.calls.filter((call) => call.path === '/v1/responses')
  assert.ok(requests.length)
  for (const request of requests) {
    const text = JSON.stringify(request.body)
    assert.match(text, /yisama-image-routing:begin/)
    assert.match(text, /image models/)
    assert.match(text, /OVERRIDE_PERSONAL_SENTINEL/)
    assert.doesNotMatch(text, /MAIN_ONLY_PERSONAL_SENTINEL/)
  }
  assert.equal(generations(f).length, 0)
})

test('a fresh real Codex discovers the managed system imagegen without replacing it', {
  skip: !process.env.YISAMA_CODEX_BIN && 'Set YISAMA_CODEX_BIN for real system skill discovery.',
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t)
  await installImagegen(f.files, {
    initialize: () => initializeCodexSkills(f.files, process.env.YISAMA_CODEX_BIN),
  })
  assert.notEqual(JSON.parse(await readOptional(f.locations.snapshot)).original, null,
    'the backup must contain the official system skill, even for a brand-new Codex home')
  await f.configure()
  const env = { ...process.env, CODEX_HOME: path.dirname(f.files.codexConfig), PLUGIN_DATA: f.files.pluginData }
  const child = spawn(process.env.YISAMA_CODEX_BIN, ['--no-daemon', '--disable', 'plugins',
    '-c', 'chatgpt_base_url="http://127.0.0.1:1"', 'app-server', '--stdio'], {
    cwd: f.root, env, windowsHide: true,
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })
  child.stderr.resume()
  let id = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { lines.off('line', receive); reject(new Error(`RPC timeout: ${method}`)) }, 10000)
    const receive = (line) => {
      const response = JSON.parse(line)
      if (response.id !== requestId) return
      clearTimeout(timer)
      lines.off('line', receive)
      if (response.error) reject(new Error(`RPC failed: ${method}`))
      else resolve(response.result)
    }
    lines.on('line', receive)
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n')
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'yisama_image_test', version: '0.1.0' } })
    child.stdin.write('{"method":"initialized"}\n')
    const result = await rpc('skills/list', { cwds: [f.root], forceReload: true })
    const skills = result.data.flatMap((item) => item.skills).filter((skill) => skill.name === 'imagegen')
    assert.equal(skills.length, 1)
    assert.match(skills[0].description, /yisama/)
    assert.match(await readOptional(f.locations.skill), /yisama-managed-imagegen/)
  } finally {
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2500)
    try { await closed } finally { clearTimeout(timer); lines.close() }
  }
})
