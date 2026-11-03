import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { configureCodex, replaceFile } from './codex-config.mjs'

const installer = process.env.YISAMA_TEST_INSTALLER
const exec = promisify(execFile)
const digest = async (file) => {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

test('the packaged logout restores original files and hands restart to a hidden launcher', {
  skip: (process.platform !== 'win32' || !installer) && 'Set YISAMA_TEST_INSTALLER for isolated package verification.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-account-package-'))
  const previous = Object.fromEntries(['CODEX_HOME', 'PLUGIN_DATA', 'YISAMA_PORTAL_URL'].map((key) => [key, process.env[key]]))
  const realHome = previous.CODEX_HOME || path.join(os.homedir(), '.codex')
  const protectedFiles = ['config.toml', 'auth.json'].map((file) => path.join(realHome, file))
  const before = await Promise.all(protectedFiles.map(digest))
  let launcher
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (launcher && launcher.exitCode === null) {
      const closed = once(launcher, 'close')
      launcher.kill()
      await closed
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
    assert.deepEqual(await Promise.all(protectedFiles.map(digest)), before)
  })
  const app = path.join(root, 'app')
  await exec(path.resolve(installer), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    '/YISAMATEST=1', `/DIR=${app}`, `/LOG=${path.join(root, 'install.log')}`],
  { timeout: 45000, windowsHide: true })
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'release-manifest.json'), 'utf8'))
  for (const [file, hash] of Object.entries(manifest.entries)) {
    assert.equal(await digest(path.join(app, 'scripts', file)), hash)
  }
  process.env.CODEX_HOME = path.join(root, 'codex')
  process.env.PLUGIN_DATA = path.join(root, 'data')
  const files = {
    pluginData: process.env.PLUGIN_DATA, state: path.join(root, 'data/state.json'),
    session: path.join(root, 'data/session.json'),
    codexConfig: path.join(root, 'codex/config.toml'), codexAuth: path.join(root, 'codex/auth.json'),
  }
  const config = '# isolated personal config\nmodel = "personal-model"\n'
  const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-original-package-test"}\n'
  await replaceFile(files.codexConfig, config)
  await replaceFile(files.codexAuth, auth)
  await replaceFile(files.session, '{"token":"isolated-session-only"}\n')
  await configureCodex({ files, apiKey: 'sk-assistant-package-test', model: 'gpt-test' })
  const bundled = await import(pathToFileURL(path.join(app, 'scripts/codex-assistant.mjs')).href)
  const response = await bundled.createRequestQueue()('{"id":1,"action":"restore"}')
  assert.equal(response.ok, true)
  assert.equal(response.data.loggedIn, false)
  assert.equal(response.data.configured, false)
  assert.equal(response.data.restartRequired, true)
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), config)
  assert.equal(await fs.readFile(files.codexAuth, 'utf8'), auth)
  for (const file of [files.state, files.session]) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' })
  }
  // Only the isolated extraction gets a launcher probe; never restart the user's desktop.
  await fs.writeFile(path.join(app, 'scripts/launch-codex.ps1'), [
    'param([switch]$Restart)',
    'if (-not $Restart) { exit 2 }',
    '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "restart-test.txt"), "restart", [Text.UTF8Encoding]::new($false))',
  ].join('\n'), 'utf8')
  let closed
  let launcherOutput = ''
  await bundled.restartCodex((file, args, options) => {
    assert.equal(args.at(-1), '-Restart')
    assert.equal(options.windowsHide, true)
    launcher = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [launcher.stdout, launcher.stderr]) {
      stream.on('data', (chunk) => { launcherOutput += chunk })
    }
    closed = once(launcher, 'close')
    return launcher
  })
  launcher.ref()
  assert.equal((await closed)[0], 0, launcherOutput)
  assert.equal(await fs.readFile(path.join(app, 'scripts/restart-test.txt'), 'utf8')
    .catch((error) => assert.fail(`${error.message}\n${launcherOutput}`)), 'restart')

  const wallet = { quota: 390000, settled_quota: 500000, pending_quota: 110000, pending_request_count: 1 }
  const calls = []
  const server = http.createServer((request, response) => {
    calls.push(request.url)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/user/self/balance' && request.headers.authorization === 'Bearer package-token') {
      response.end(JSON.stringify({ success: true, data: wallet }))
    } else if (request.url === '/api/status') {
      response.end(JSON.stringify({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } }))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ success: false }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  process.env.YISAMA_PORTAL_URL = origin
  await replaceFile(files.session, JSON.stringify({ origin, token: 'package-token' }))
  const queue = bundled.createRequestQueue()
  const held = await queue('{"id":2,"action":"balance"}')
  assert.equal(held.ok, true)
  assert.deepEqual(held.data, { quota: '$1.00', balanceMode: 'settled', pendingSettlement: true })
  Object.assign(wallet, { quota: 405000, settled_quota: 405000, pending_quota: 0, pending_request_count: 0 })
  const settled = await queue('{"id":3,"action":"balance"}')
  assert.equal(settled.ok, true)
  assert.deepEqual(settled.data, { quota: '$0.81', balanceMode: 'settled', pendingSettlement: false })
  assert.deepEqual([...new Set(calls)].sort(), ['/api/status', '/api/user/self/balance'])
  assert.equal(await fs.readFile(files.codexConfig, 'utf8'), config)
  assert.equal(await fs.readFile(files.codexAuth, 'utf8'), auth)
})
