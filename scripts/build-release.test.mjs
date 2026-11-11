import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'

const repository = fileURLToPath(new URL('..', import.meta.url))
const exec = promisify(execFile)

test('release builder emits only bundled runtime entries', async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-release-test-'))
  t.after(() => fs.rm(output, { recursive: true, force: true, maxRetries: 3 }))

  const result = await exec(process.execPath, [
    path.join(repository, 'scripts', 'build-release.mjs'), '--out', output,
  ], { cwd: repository })
  assert.equal(result.stderr, '')

  assert.deepEqual((await fs.readdir(path.join(output, 'scripts'))).sort(), [
    'codex-assistant.mjs', 'launch-codex.ps1', 'yisama.mjs',
  ])
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest.json'), 'utf8'))
  const sourcePackage = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'))
  const releasePackage = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'))
  assert.equal(releasePackage.version, sourcePackage.version)
  assert.equal(manifest.version, sourcePackage.version)
  assert.equal(manifest.sourceIncluded, false)
  assert.equal(manifest.sourceMapsIncluded, false)
  assert.equal(manifest.testFilesIncluded, false)
  assert.equal(manifest.deviceScopedCredentials, true)
  assert.equal(manifest.managedSystemImagegen, true)

  const assistant = await fs.readFile(path.join(output, 'scripts', 'codex-assistant.mjs'), 'utf8')
  const yisama = await fs.readFile(path.join(output, 'scripts', 'yisama.mjs'), 'utf8')
  assert.doesNotMatch(assistant, /sourceMappingURL|from\s+["']\.\/(?:codex|desktop|yisama)/)
  assert.doesNotMatch(yisama, /sourceMappingURL|from\s+["']\.\/(?:codex|desktop|yisama)/)
  // The bundled assistant must not read stdin as the desktop bridge would, or it never exits.
  await fs.symlink(path.join(repository, 'node_modules'), path.join(output, 'node_modules'), 'junction')
  const imageHome = path.join(output, 'test-codex')
  const imageData = path.join(output, 'test-data')
  const imageEnv = { ...process.env, CODEX_HOME: imageHome, PLUGIN_DATA: imageData }
  const bundledEntry = path.join(output, 'scripts', 'yisama.mjs')
  const startup = await exec(process.execPath,
    ['--disable-warning=ExperimentalWarning', bundledEntry, 'startup', 'local'], { env: imageEnv })
  assert.equal(startup.stderr, '')
  assert.deepEqual(JSON.parse(startup.stdout), {
    local: true, paidCalls: 0, configured: false, threads: { status: 'unchanged', changed: 0, skipped: 0 },
  })
  await exec(process.execPath, [bundledEntry, 'image', 'install'], { env: imageEnv })
  const skill = await fs.readFile(path.join(imageHome, 'skills', '.system', 'imagegen', 'SKILL.md'), 'utf8')
  assert.ok(skill.includes(bundledEntry), 'the installed skill must use the distributed entry, not the source checkout')
  const imagePreview = await exec(process.execPath,
    [bundledEntry, 'image', 'generate', '--prompt', 'cube', '--dry-run'], { env: imageEnv })
  assert.equal(JSON.parse(imagePreview.stdout).payload.model, 'gpt-image-2')
  await exec(process.execPath, [bundledEntry, 'image', 'uninstall'], { env: imageEnv })
  await assert.rejects(fs.access(path.join(imageHome, 'skills', '.system', 'imagegen', 'SKILL.md')))
  const child = spawn(process.execPath, [path.join(output, 'scripts', 'codex-assistant.mjs'), '--help'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let help = ''
  child.stdout.on('data', (chunk) => { help += chunk })
  const code = await Promise.race([once(child, 'exit').then(([exitCode]) => exitCode), delay(10000).then(() => 'running')])
  assert.equal(code, 0, 'bundled assistant kept running while stdin stayed open')
  assert.match(help, /in-Codex assistant/)
  // Online licensing is opt-in (YISAMA_REQUIRE_LICENSE=1); default releases skip it.
  assert.equal(manifest.licenseRequired, false)

  const bundled = await import(pathToFileURL(path.join(output, 'scripts', 'codex-assistant.mjs')).href)
  const listeners = new Set()
  const methods = []
  const window = {
    __yisamaInfiniteAssistant: { snapshot: () => ({ loggedIn: true }) },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    electronBridge: { async sendMessageFromView({ hostId, request }) {
      methods.push(request.method)
      for (const listener of listeners) listener({ data: { type: 'mcp-response', hostId,
        message: { id: request.id, result: { data: [], nextCursor: null } } } })
    } },
  }
  window.top = window
  assert.equal(await runInNewContext(`(${bundled.codexRestartBlocker.toString()})()`, {
    window, location: { href: 'app://-/index.html' }, crypto: webcrypto,
    setTimeout, clearTimeout, document: { querySelectorAll: () => [] },
  }), null, 'the minified restart check must execute independently inside the renderer')
  assert.deepEqual(methods, ['thread/loaded/list'])
})

test('silent assistant-only updates retain detection, first-install consent and running-task protection', async () => {
  const installer = await fs.readFile(path.join(repository, 'installer/yisama.iss'), 'utf8')
  const policy = installer.slice(installer.indexOf('function IsAssistantOnlyUpdate:'),
    installer.indexOf('function Quote('))
  assert.match(policy, /YISAMAUPDATE/)
  for (const file of ['codex-location.json', 'release-manifest.json', 'launch-codex.ps1']) {
    assert.ok(policy.includes(file))
  }
  assert.match(policy, /CODEXPATH/)
  assert.match(installer, /WizardSilent and not SelectionTested and not IsAssistantOnlyUpdate/)
  assert.match(installer, /if SelectionRunning or CodexDesktopRunning then/)
  assert.match(installer, /if not WizardSilent or \(ExpandConstant\('\{param:INSTALLCODEX\|0\}'\) <> '1'\) then/)
})
