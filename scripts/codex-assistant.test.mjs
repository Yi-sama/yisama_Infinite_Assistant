import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  allowedTarget, AssistantTarget, CdpConnection, CODEX_PAGE, codexStartedAt, createRequestQueue, readUpdateMarker,
  restartAssistant, runAssistant, shouldReload, validateEndpoint, validateUpdateMarker,
} from './codex-assistant.mjs'

const generation = (letter) => letter.repeat(64)
const marker = (letter) => ({ generation: generation(letter), updatedAt: '2026-10-29T02:30:00.000Z' })
const closedPanel = () => ({ open: false, busy: false, unsent: false })

test('replacement detaches from the old helper and waits until spawning succeeds', async () => {
  let unreferenced = false
  await restartAssistant(['--endpoint-file', 'test.json', '--process-id', '7'], (executable, args, options) => {
    assert.equal(executable, process.execPath)
    assert.equal(path.basename(args[0]), 'codex-assistant.mjs')
    assert.deepEqual(args.slice(1), ['--endpoint-file', 'test.json', '--process-id', '7'])
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true })
    const child = new EventEmitter()
    child.unref = () => { unreferenced = true }
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  assert.equal(unreferenced, true)
  await assert.rejects(restartAssistant([], () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('spawn failed')))
    return child
  }), /spawn failed/)
})

test('Codex start time uses the verified desktop PID without WMI or a visible shell', {
  skip: process.platform !== 'win32',
}, async () => {
  const startedAt = await codexStartedAt(4216, async (file, args, options) => {
    assert.equal(file, 'powershell.exe')
    assert.ok(args.includes('-NonInteractive'))
    assert.match(args.at(-1), /Get-Process -Id 4216/)
    assert.equal(options.windowsHide, true)
    return { stdout: '2026-10-29T02:31:12.7108919Z\r\n' }
  })
  assert.equal(startedAt, '2026-10-29T02:31:12.710Z')
  assert.ok(Number.isFinite(Date.parse(await codexStartedAt(process.pid))))
})

function sequence(values) {
  let index = 0
  return async () => values[Math.min(index++, values.length - 1)]
}

function makeConnectionFactory({ state = closedPanel, onEnable } = {}) {
  const connections = []
  return {
    connections,
    factory(_url, onEvent) {
      const calls = []
      const connection = {
        socket: { readyState: WebSocket.OPEN },
        closed: 0,
        async connect() {},
        async call(method, params = {}) {
          calls.push({ method, params })
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: CODEX_PAGE } } }
          if (method === 'Runtime.enable') {
            onEvent({ method: 'Runtime.executionContextCreated',
              params: { context: { id: 1, auxData: { isDefault: true, frameId: 'main' } } } })
            onEnable?.(onEvent)
          }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `script-${connections.length}` }
          if (method === 'Runtime.evaluate' && params.expression.includes('const runtime =')) {
            return { result: { value: state() } }
          }
          return {}
        },
        close() { connection.closed++ },
      }
      connection.calls = calls
      connections.push(connection)
      return connection
    },
  }
}

function assistantTarget(id) {
  return { id, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` }
}

function assistantOptions(overrides = {}) {
  return {
    endpointFile: 'test-endpoint.json',
    processId: 7,
    readEndpoint: async () => ({ port: 9222, processId: 7 }),
    discover: async () => [assistantTarget('main')],
    isRunning: () => true,
    nativeConfiguration: async () => null,
    pollMs: 0,
    report: () => {},
    ...overrides,
  }
}

test('assistant accepts only local Codex main-page endpoints', () => {
  const target = { type: 'page', url: CODEX_PAGE,
    webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/page/workspace' }
  assert.deepEqual(validateEndpoint({ port: 41234, processId: 15 }), { port: 41234, processId: 15 })
  for (const value of [null, { port: 0, processId: 15 }, { port: 65536, processId: 15 },
    { port: 41234, processId: -1 }]) assert.throws(() => validateEndpoint(value))
  assert.equal(allowedTarget(target, 41234), true)
  for (const replacement of [
    { url: 'https://api.yisama.asia/login' }, { url: `${CODEX_PAGE}?webview` }, { type: 'iframe' },
    { webSocketDebuggerUrl: 'ws://example.com:41234/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://user@127.0.0.1:41234/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/workspace' },
  ]) assert.equal(allowedTarget({ ...target, ...replacement }, 41234), false)
})

test('assistant serializes UI actions and rejects malformed commands before the backend', async () => {
  let active = 0
  let maximum = 0
  const calls = []
  const request = createRequestQueue(async (value) => {
    maximum = Math.max(maximum, ++active)
    calls.push(value)
    await delay(5)
    active--
    return { quota: '$12.50' }
  })
  const result = await Promise.all([
    request(JSON.stringify({ id: 1, action: 'login', token: 'must-be-dropped' })),
    request(JSON.stringify({ id: 2, action: 'select', group: 'auto' })),
    request(JSON.stringify({ id: 3, action: 'status' })),
  ])
  assert.equal(maximum, 1)
  assert.deepEqual(calls.map((value) => value.id), [1, 2, 3])
  assert.equal('token' in calls[0], false)
  assert.equal(result[0].data.quota, '$12.50')
  for (const payload of ['not json', '{}', JSON.stringify({ id: 0, action: 'login' }),
    JSON.stringify({ id: 1, action: 'arbitrary-script' }),
    JSON.stringify({ id: 1, action: 'select', group: '' }), 'x'.repeat(16385)]) {
    assert.equal(await request(payload), null)
  }
  assert.equal(calls.length, 3)
})

test('backend errors are safe responses and do not poison later commands', async () => {
  const request = createRequestQueue(async ({ action }) => {
    if (action === 'login') throw new Error('Bearer sk-secret-do-not-render')
    return { loggedIn: false }
  })
  const failure = await request(JSON.stringify({ id: 1, action: 'login' }))
  assert.equal(failure.ok, false)
  assert.doesNotMatch(failure.error, /sk-secret/)
  assert.equal((await request(JSON.stringify({ id: 2, action: 'status' }))).ok, true)
})

test('request queue drains accepted requests before it resumes a quiesced request', async () => {
  let release
  let calls = 0
  const request = createRequestQueue(() => ++calls === 1
    ? new Promise((resolve) => { release = resolve }) : { loggedIn: false })
  const first = request(JSON.stringify({ id: 1, action: 'status' }))
  request.quiesce()
  const later = request(JSON.stringify({ id: 2, action: 'status' }))
  assert.equal(request.isIdle(), false)
  await delay(0)
  release({ loggedIn: false })
  await first
  await request.drain()
  assert.equal(request.isIdle(), false, 'a request arriving during quiesce remains held, not lost')
  request.resume()
  await later
  await request.drain()
  assert.equal(request.isIdle(), true)
})

test('update marker accepts only the updater contract', async () => {
  assert.deepEqual(validateUpdateMarker(marker('a')), marker('a'))
  for (const value of [null, {}, { generation: generation('A'), updatedAt: marker('a').updatedAt },
    { generation: generation('a'), updatedAt: 'not-a-date' }, { generation: generation('a'), updatedAt: '2026' },
    { generation: generation('a') }]) {
    assert.equal(validateUpdateMarker(value), null)
  }
  assert.equal(shouldReload(generation('a'), marker('a')), false)
  assert.equal(shouldReload(null, marker('a')), true)
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-marker-')), 'update.json')
  await fs.writeFile(file, JSON.stringify(marker('b')))
  assert.deepEqual(await readUpdateMarker(file), marker('b'))
  await fs.rm(path.dirname(file), { recursive: true, force: true })
})

test('marker added after startup reloads exactly once after the helper is ready', async () => {
  const { factory } = makeConnectionFactory()
  const ready = []
  const result = await runAssistant(assistantOptions({
    readUpdate: sequence([null, marker('b'), marker('b')]),
    connectionFactory: factory,
    onReady: (value) => ready.push(value),
  }))
  assert.deepEqual(ready, [{ generation: generation('b') }])
  assert.deepEqual(result, { reload: true, generation: generation('b') })
})

test('an open assistant panel delays marker reload until it is closed', async () => {
  let stateChecks = 0
  const { factory } = makeConnectionFactory({ state: () => stateChecks++ === 0
    ? { open: true, busy: false, unsent: false } : closedPanel() })
  const result = await runAssistant(assistantOptions({
    readUpdate: sequence([null, marker('c'), marker('c')]), connectionFactory: factory,
  }))
  assert.equal(result.reload, true)
  assert.equal(stateChecks, 2)
})

test('an in-flight UI reply prevents reload until its response has been sent', async () => {
  let release
  const { factory } = makeConnectionFactory({
    onEnable(onEvent) {
      onEvent({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: JSON.stringify({ id: 1, action: 'status' }), executionContextId: 1,
      } })
    },
  })
  setTimeout(() => release({ loggedIn: false }), 5)
  const result = await runAssistant(assistantOptions({
    handler: () => new Promise((resolve) => { release = resolve }),
    readUpdate: sequence([null, marker('d'), marker('d'), marker('d')]), connectionFactory: factory,
  }))
  assert.equal(result.reload, true)
})

test('invalid update markers never reload the helper', async () => {
  const { factory } = makeConnectionFactory()
  let polls = 0
  const result = await runAssistant(assistantOptions({
    isRunning: () => ++polls <= 2,
    readUpdate: sequence([marker('e'), { generation: 'bad', updatedAt: 'not-a-date' }]),
    connectionFactory: factory,
  }))
  assert.equal(result, undefined)
})

test('replacing a target releases old and final CDP connections', async () => {
  const { factory, connections } = makeConnectionFactory()
  let polls = 0
  let discovery = 0
  await runAssistant(assistantOptions({
    isRunning: () => ++polls <= 2,
    discover: async () => [assistantTarget(++discovery === 1 ? 'old' : 'new')],
    readUpdate: sequence([null]), connectionFactory: factory,
  }))
  assert.equal(connections.length, 2)
  for (const connection of connections) {
    assert.equal(connection.closed, 1)
    assert.ok(connection.calls.some((call) => call.method === 'Runtime.removeBinding'))
    assert.ok(connection.calls.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument'))
  }
})

test('CDP forwards only the bounded authentication fields for the corresponding action', async () => {
  const calls = []
  const request = createRequestQueue(async (value) => { calls.push(value); return { loggedIn: false } })
  await request(JSON.stringify({ id: 1, action: 'login', username: 'demo', password: 'password', token: 'drop' }))
  assert.deepEqual(calls[0], { id: 1, action: 'login', username: 'demo', password: 'password' })
  await request(JSON.stringify({ id: 2, action: 'login', loginId: 'challenge', twoFactorCode: '123456' }))
  assert.deepEqual(calls[1], { id: 2, action: 'login', loginId: 'challenge', twoFactorCode: '123456' })
  await request(JSON.stringify({ id: 3, action: 'status', password: 'drop' }))
  assert.deepEqual(calls[2], { id: 3, action: 'status' })
  for (const details of [
    { username: 'demo' }, { password: 'password' }, { loginId: 'challenge' },
    { username: 'demo', password: 'password', loginId: 'challenge', twoFactorCode: '123456' },
    { username: 'demo', password: 'a'.repeat(1025) }, { username: {}, password: 'password' },
  ]) assert.equal(await request(JSON.stringify({ id: 4, action: 'login', ...details })), null)
})

test('only the top Codex frame can send account commands and receive replies', async () => {
  const commands = []
  const handled = []
  let onEvent
  const connection = {
    socket: { readyState: WebSocket.OPEN },
    async connect() {},
    async call(method, params) {
      commands.push({ method, params })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: CODEX_PAGE } } }
      if (method === 'Runtime.enable') {
        onEvent({ method: 'Runtime.executionContextCreated',
          params: { context: { id: 1, auxData: { isDefault: true, frameId: 'main' } } } })
        onEvent({ method: 'Runtime.executionContextCreated',
          params: { context: { id: 2, auxData: { isDefault: true, frameId: 'login-frame' } } } })
      }
      return { identifier: 'restore-yisama-ui' }
    },
    close() {},
  }
  const target = new AssistantTarget({ webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/page/main' },
    async (payload) => { handled.push(payload); return { id: 1, ok: true, data: { quota: '$9.50' } } },
    { connectionFactory: (_url, listener) => { onEvent = listener; return connection } })
  await target.install()
  assert.ok(commands.find((value) => value.method === 'Page.addScriptToEvaluateOnNewDocument'))
  assert.equal(commands.some((value) => value.method === 'Page.reload' || value.method === 'Page.setBypassCSP'), false)
  const binding = (executionContextId) => ({ method: 'Runtime.bindingCalled',
    params: { name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"login"}', executionContextId } })
  onEvent(binding(2))
  await delay(0)
  assert.equal(handled.length, 0)
  onEvent(binding(1))
  await delay(0)
  assert.equal(handled.length, 1)
  assert.equal(commands.at(-1).params.contextId, 1)
  assert.match(commands.at(-1).params.expression, /receive/)
  onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: 'https://example.com' } } })
  onEvent(binding(1))
  await delay(0)
  assert.equal(handled.length, 1)
  onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: CODEX_PAGE } } })
  await target.dispose()
  assert.ok(commands.find((value) => value.method === 'Page.removeScriptToEvaluateOnNewDocument'))
})

test('an old document cannot receive the result of a command after reload', async () => {
  let resolve
  const replies = []
  const target = new AssistantTarget({}, () => new Promise((done) => { resolve = done }),
    { connectionFactory: () => ({ call: async (...args) => replies.push(args), close() {} }) })
  target.mainFrameId = 'main'
  target.allowed = true
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'main' } })
  const pending = target.reply({ payload: '{"id":1,"action":"login"}', executionContextId: 1 })
  target.onEvent({ method: 'Runtime.executionContextsCleared' })
  resolve({ id: 1, ok: true, data: { loggedIn: true } })
  await pending
  assert.equal(replies.length, 0)
})

test('local CDP transport exchanges commands and binding events with an isolated real browser', async (t) => {
  const executable = process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : process.env.YISAMA_TEST_CDP_BROWSER
  if (!executable || !await fs.stat(executable).then(() => true, () => false)) {
    t.skip('An installed browser is required for the real CDP transport check.')
    return
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-cdp-test-'))
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${root}`, '--no-first-run',
    '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  const exited = once(browser, 'exit')
  let connection
  t.after(async () => {
    connection?.close()
    if (browser.exitCode === null) browser.kill()
    await exited
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  let port
  const deadline = Date.now() + 15000
  while (!port && Date.now() < deadline && browser.exitCode === null) {
    const record = await fs.readFile(path.join(root, 'DevToolsActivePort'), 'utf8').catch(() => '')
    if (record) port = Number(record.split('\n')[0])
    else await delay(100)
  }
  assert.ok(port, 'the isolated browser publishes its local debug port')
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
  const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank')
  assert.ok(page)
  assert.equal(allowedTarget(page, port), false, 'production must never accept arbitrary browser pages')
  let receiveEvent
  const bindingEvent = new Promise((resolve) => { receiveEvent = resolve })
  connection = new CdpConnection(page.webSocketDebuggerUrl, (event) => {
    if (event.method === 'Runtime.bindingCalled') receiveEvent(event)
  })
  await connection.connect()
  await connection.call('Runtime.enable')
  await connection.call('Runtime.addBinding', { name: 'yisamaTransportTest' })
  const result = await connection.call('Runtime.evaluate', {
    expression: 'yisamaTransportTest("verified"); ({ answer: 6 * 7, url: location.href })',
    returnByValue: true,
  })
  assert.deepEqual(result.result.value, { answer: 42, url: 'about:blank' })
  const event = await Promise.race([bindingEvent, delay(5000).then(() => null)])
  assert.equal(event?.params.payload, 'verified')
  assert.ok(event.params.executionContextId)

  await connection.call('Runtime.evaluate', {
    expression: `document.body.innerHTML = '<section id="yisama-infinite-assistant-ui" hidden><section hidden><input value="demo"></section></section>';
      window.__yisamaInfiniteAssistant = { snapshot: () => ({ loggedIn: true, open: false }) };`,
  })
  const assistant = new AssistantTarget({}, async () => null, { connectionFactory: () => connection })
  assistant.allowed = true
  assistant.mainFrameId = 'test-page'
  assistant.contexts.set(event.params.executionContextId, { auxData: { isDefault: true, frameId: 'test-page' } })
  assert.deepEqual(await assistant.reloadState(), closedPanel(),
    'a retained username in the hidden signed-out form must not block an update after login')
  await connection.call('Runtime.evaluate', {
    expression: 'window.__yisamaInfiniteAssistant.snapshot = () => ({ loggedIn: false, open: false });',
  })
  assert.deepEqual(await assistant.reloadState(), { open: false, busy: false, unsent: true },
    'closing the panel must still preserve an unsent login draft')
})
