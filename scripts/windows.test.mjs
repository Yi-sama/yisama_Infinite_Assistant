import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const repository = fileURLToPath(new URL('..', import.meta.url))
const installer = process.env.YISAMA_TEST_INSTALLER
  ? path.resolve(process.env.YISAMA_TEST_INSTALLER)
  : path.join(repository, 'dist', 'Yisama-Setup.exe')
const enabled = process.platform === 'win32' && process.env.YISAMA_WINDOWS_TESTS === '1'
const uninstallKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2FEC2B14-5ABC-420F-A522-A943ACC9B195}_is1`

const selectedCodexProbe = `
param([string]$AppRoot, [string]$Expected, [string]$Prerequisite)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$bootstrap = Join-Path $AppRoot 'runtime\\codex-bootstrap.exe'
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $AppRoot 'scripts\\launch-codex.ps1'), [ref]$null, [ref]$null)
$function = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Read-SelectedCodex' }, $true)
if (-not $function) { throw 'The package has no saved Codex selection reader.' }
Invoke-Expression $function.Extent.Text
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
$found = Read-SelectedCodex
"selected=$($found.executable -ceq $Expected) exists=$(Test-Path -LiteralPath $found.executable) source=$($found.source)"
"encodingRestored=$([Console]::OutputEncoding.CodePage -eq 936)"
. $Prerequisite
$found = Read-CodexDesktop -Bootstrap $bootstrap -Location (Join-Path $AppRoot 'codex-location.json')
"prerequisite=$($found.executable -ceq $Expected) encodingRestored=$([Console]::OutputEncoding.CodePage -eq 936)"
$bootstrap = Join-Path $AppRoot 'missing-bootstrap.exe'
$failed = $false
try { Read-SelectedCodex | Out-Null } catch { $failed = $true }
"launcherFailed=$failed encodingRestored=$([Console]::OutputEncoding.CodePage -eq 936)"
$failed = $false
try { Read-CodexDesktop -Bootstrap $bootstrap -Location 'unused.json' | Out-Null } catch { $failed = $true }
"prerequisiteFailed=$failed encodingRestored=$([Console]::OutputEncoding.CodePage -eq 936)"
`

function exec(file, args, options = {}) {
  const pending = promisify(execFile)(file, args, {
    cwd: repository, timeout: 45000, windowsHide: true, ...options,
  })
  pending.child.stdin.end()
  return pending
}

async function digest(file) {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function uninstallRegistration() {
  try {
    const { stdout } = await exec('reg.exe', ['query', uninstallKey, '/s'])
    return stdout
  } catch (error) {
    if (error.code === 1) return null
    throw error
  }
}

test('Windows installer initializes the Codex wizard and installs the bundled launcher payload', {
  skip: !enabled && 'Build Windows artifacts and set YISAMA_WINDOWS_TESTS=1 for isolated installer checks.',
  timeout: 180000,
}, async (t) => {
  await fs.access(installer)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-windows-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))

  const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const protectedFiles = ['config.toml', 'auth.json', 'AGENTS.md', 'AGENTS.override.md', 'skills/.system/imagegen/SKILL.md']
    .map((name) => path.join(realHome, name))
  const before = await Promise.all(protectedFiles.map(digest))
  const registrationBefore = await uninstallRegistration()

  // Preview mode exercises detection but never installs Codex or registers the assistant.
  const extracted = path.join(root, 'app')
  const setupLog = path.join(root, 'setup.log')
  await exec(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/YISAMATEST=1',
    '/YISAMAUI=1', `/DIR=${extracted}`, `/LOG=${setupLog}`], { timeout: 120000 })
  const initialization = await fs.readFile(setupLog, 'utf8')
  assert.match(initialization, /Codex preparation page initialized: status=(?:found|missing);/)
  assert.ok(initialization.includes(`assistant=${extracted}`),
    'the wizard must use the selected installation directory before extracting files')
  await assert.rejects(fs.access(path.join(extracted, 'unins000.exe')))
  await fs.access(path.join(extracted, 'yisama.ico'))
  assert.equal(await uninstallRegistration(), registrationBefore,
    'test mode must leave any existing uninstall registration unchanged')

  for (const relative of [
    'runtime/node.exe',
    'runtime/Node-LICENSE.txt',
    'runtime/codex-bootstrap.exe',
    'runtime/Codex-App-Manager-LICENSE.txt',
    'runtime/Bootstrap-THIRD-PARTY-NOTICES.txt',
    'scripts/launch-codex.ps1',
    'scripts/codex-assistant.mjs',
    'scripts/yisama.mjs',
    'package.json',
    'LICENSE.txt',
    'release-manifest.json',
    'node_modules/playwright/package.json',
    'node_modules/playwright-core/package.json',
  ]) await fs.access(path.join(extracted, relative))
  for (const relative of [
    'scripts/codex-panel.mjs',
    'scripts/desktop-bridge.mjs',
    'scripts/codex-config.mjs',
    'scripts/update-local.mjs',
    'node_modules/esbuild/package.json',
    'node_modules/smol-toml/package.json',
  ]) await assert.rejects(fs.access(path.join(extracted, relative)))
  const packagedFiles = await fs.readdir(path.join(extracted, 'scripts'))
  assert.deepEqual(packagedFiles.sort(), ['codex-assistant.mjs', 'launch-codex.ps1', 'yisama.mjs'])
  const releasePackage = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8'))
  const sourcePackage = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'))
  assert.equal(releasePackage.version, sourcePackage.version)
  assert.deepEqual(releasePackage.dependencies, { playwright: '1.64.1' })
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.version, releasePackage.version)
  assert.equal(manifest.sourceIncluded, false)
  assert.equal(manifest.sourceMapsIncluded, false)
  assert.equal(manifest.testFilesIncluded, false)
  assert.equal(manifest.deviceScopedCredentials, true)
  assert.equal(manifest.managedSystemImagegen, true)
  if (process.env.YISAMA_TEST_EXPECTED_BUILD_ID) {
    assert.equal(manifest.buildId, process.env.YISAMA_TEST_EXPECTED_BUILD_ID)
  }
  assert.match(manifest.buildId, /^[a-f0-9]{64}$/)
  assert.equal(manifest.windowsBootstrap.engineRevision, '474658de8b3013d6f2ee68ce0cc0402219de11cc')
  assert.equal(manifest.windowsBootstrap.sha256,
    await digest(path.join(extracted, 'runtime', 'codex-bootstrap.exe')))
  assert.equal(manifest.entries['launch-codex.ps1'],
    await digest(path.join(extracted, 'scripts', 'launch-codex.ps1')))
  await assert.rejects(fs.access(path.join(extracted, 'codex-location.json')),
    'test extraction must not select or change a real Codex installation')
  const license = await fs.readFile(path.join(extracted, 'runtime/Node-LICENSE.txt'), 'utf8')
  assert.ok(license.length > 10000, 'the runtime must include its complete distribution license')
  assert.match(license, /MIT License/)
  await assert.rejects(fs.access(path.join(extracted, 'Host.exe')))
  assert.equal(await digest(path.join(extracted, 'scripts', 'launch-codex.ps1')),
    await digest(path.join(repository, 'scripts', 'launch-codex.ps1')))
  for (const name of ['codex-assistant.mjs', 'yisama.mjs']) {
    assert.notEqual(await digest(path.join(extracted, 'scripts', name)),
      await digest(path.join(repository, 'scripts', name)), `${name} must be bundled`)
    const bundled = await fs.readFile(path.join(extracted, 'scripts', name), 'utf8')
    assert.doesNotMatch(bundled, /sourceMappingURL|from\s+["']\.\/(?:codex|desktop|yisama)/)
  }

  const node = path.join(extracted, 'runtime', 'node.exe')
  const help = await exec(node, [path.join(extracted, 'scripts', 'codex-assistant.mjs'), '--help'], { cwd: extracted })
  assert.equal(help.stdout.trim(), 'yisama in-Codex assistant: --endpoint-file <absolute-file> --process-id <Codex-pid>')
  assert.equal(help.stderr, '')

  const launcher = await exec('powershell.exe', ['-NoProfile', '-File',
    path.join(extracted, 'scripts', 'launch-codex.ps1'), '-ValidateOnly'], { cwd: extracted })
  assert.match(launcher.stdout, /Launcher validation passed\. Shortcut target:/)
  assert.equal(launcher.stderr, '')

  await t.test('the packaged image path installs the system skill and generates through its dedicated station', async () => {
    const home = path.join(root, 'image-codex')
    const data = path.join(root, 'image-data')
    const env = { ...process.env, CODEX_HOME: home, PLUGIN_DATA: data }
    const script = path.join(extracted, 'scripts', 'yisama.mjs')
    await exec(node, [script, 'image', 'install'], { cwd: extracted, env })
    const skillPath = path.join(home, 'skills', '.system', 'imagegen', 'SKILL.md')
    const skill = await fs.readFile(skillPath, 'utf8')
    assert.match(skill, /yisama-managed-imagegen/)
    assert.ok(skill.includes(script))
    assert.ok(skill.includes(node))
    const globalRules = await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')
    assert.match(globalRules, /yisama-image-routing:begin/)
    assert.ok(globalRules.includes(skillPath))
    const snapshot = JSON.parse(await fs.readFile(path.join(data, 'imagegen-skill.json'), 'utf8'))
    assert.match(snapshot.original, /name: "?imagegen"?/,
      'initialization must back up the official skill, even for a new user')
    await assert.rejects(fs.access(path.join(data, 'imagegen.json')),
      'installation must not log in or copy this machine owner credentials')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrS0AAAAASUVORK5CYII=', 'base64')
    const calls = []
    const deviceId = '00000000-0000-4000-8000-000000000001'
    const imageKey = {
      id: 1, user_id: 7, name: `yisama:images:${deviceId}`, group: 'images', status: 1,
      fast_mode: false, fast_mode_available: false, expired_time: -1, remain_quota: 0,
      unlimited_quota: true, model_limits_enabled: false, model_limits: '', allow_ips: '',
      auto_groups: [], cross_group_retry: false,
    }
    const station = http.createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      calls.push({ url: request.url, method: request.method, key: request.headers.authorization,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null })
      response.setHeader('Content-Type', 'application/json')
      const reply = (data) => response.end(JSON.stringify(data))
      if (request.url === '/api/user/self') {
        return reply({ success: true, data: { id: 7, username: 'packaged-test' } })
      }
      if (request.url === '/api/user/self/groups') return reply({ success: true, data: { images: {} } })
      if (request.url.startsWith('/api/token/search?')) {
        return reply({ success: true, data: { items: [imageKey] } })
      }
      if (request.url === '/api/token/1') return reply({ success: true, data: imageKey })
      if (request.url === '/api/token/1/key') {
        return reply({ success: true, data: { key: 'sk-package-image-only' } })
      }
      if (request.url === '/v1/models') {
        return reply({ data: ['gpt-image-2', 'nano-banana-2', 'chat-only'].map((id) => ({ id })) })
      }
      if (request.url === '/api/pricing') {
        return reply({
          supported_endpoint: { 'image-generation': { path: '/v1/images/generations', method: 'POST' } },
          data: ['gpt-image-2', 'nano-banana-2'].map((model_name) => ({
            model_name, supported_endpoint_types: ['image-generation'], enable_groups: ['images'],
          })),
        })
      }
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolve) => station.listen(0, '127.0.0.1', resolve))
    try {
      const baseUrl = `http://127.0.0.1:${station.address().port}/v1`
      env.YISAMA_PORTAL_URL = new URL(baseUrl).origin
      await fs.writeFile(path.join(data, 'device-id'), deviceId, 'utf8')
      await fs.writeFile(path.join(data, 'session.json'),
        JSON.stringify({ origin: env.YISAMA_PORTAL_URL, token: 'packaged-dashboard-test-only' }), 'utf8')
      // An unrelated chat provider must not redirect the packaged image request.
      await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "other"\n', 'utf8')
      await fs.writeFile(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-other-chat"}', 'utf8')
      const out = path.join(root, 'packaged-image.png')
      const result = await exec(node, [script, 'image', 'generate', '--model', 'nano-banana-2',
        '--prompt', 'red cube', '--out', out], { cwd: extracted, env })
      assert.deepEqual(await fs.readFile(out), png)
      assert.equal(JSON.parse(result.stdout).model, 'nano-banana-2')
      assert.deepEqual(calls.filter((call) => call.url.startsWith('/v1/images/'))
        .map((call) => [call.url, call.key, call.body.model]), [
        ['/v1/images/generations', 'Bearer sk-package-image-only', 'nano-banana-2'],
      ])
      assert.doesNotMatch(result.stdout + result.stderr, /sk-package|sk-other|127\.0\.0\.1/)
      const beforeQuery = calls.length
      const listing = await exec(node, [script, 'image', 'models'], { cwd: extracted, env })
      assert.deepEqual(listing.stdout.trim().split(/\r?\n/), [
        '你当前可用的生图模型：', 'gpt-image-2', 'nano-banana-2', '默认生图模型：gpt-image-2',
      ])
      assert.ok(calls.slice(beforeQuery).every((call) => call.method === 'GET'))
      assert.equal(calls.filter((call) => call.url.startsWith('/v1/images/')).length, 1)
      await exec(node, [script, 'image', 'uninstall'], { cwd: extracted, env })
      assert.equal(await fs.readFile(skillPath, 'utf8'), snapshot.original)
      await assert.rejects(fs.access(path.join(data, 'imagegen.json')))
      await assert.rejects(fs.access(path.join(home, 'AGENTS.md')))
    } finally {
      await new Promise((resolve) => { station.closeAllConnections(); station.close(resolve) })
    }
  })

  await t.test('packaged download source resolves to a fixed version without a latest manifest', async () => {
    const pinned = manifest.windowsBootstrap.codexRelease
    const mirror = new URL(pinned.mirrorUrl)
    assert.equal(mirror.protocol, 'https:')
    assert.equal(mirror.pathname, `/codex/${pinned.packageVersion}/${pinned.packageMoniker}.Msix`)
    assert.equal(pinned.manifestUrl, undefined)
    const sourceReport = path.join(root, 'download-source.ini')
    await exec(path.join(extracted, 'runtime', 'codex-bootstrap.exe'),
      ['source', '--report', sourceReport], { timeout: 10000 })
    const report = await fs.readFile(sourceReport, 'utf16le')
    for (const line of [
      'status=ready', `url=${pinned.mirrorUrl}`, `size=${pinned.size}`, `sha256=${pinned.sha256}`,
    ]) assert.ok(report.includes(`${line}\r\n`), `missing source report field: ${line}`)
    assert.doesNotMatch(report, /\/latest\//)
  })

  await t.test('packaged downloader retains paused data and rejects damaged complete caches', async () => {
    const bootstrap = path.join(extracted, 'runtime', 'codex-bootstrap.exe')
    const cache = path.join(root, 'download-cache', 'Codex.msix')
    const report = path.join(root, 'download-result.ini')
    const cancel = path.join(root, 'download.pause')
    const bytes = Buffer.from('isolated partial package')
    await fs.mkdir(path.dirname(cache), { recursive: true })
    await fs.writeFile(`${cache}.part`, bytes)
    await fs.writeFile(cancel, 'pause', 'utf8')
    const args = ['download', '--file', cache, '--report', report, '--cancel', cancel]
    await exec(bootstrap, args)
    const paused = await fs.readFile(report, 'utf16le')
    assert.match(paused, /status=paused\r\n/)
    assert.ok(paused.includes(`downloaded=${bytes.length}\r\n`))
    assert.deepEqual(await fs.readFile(`${cache}.part`), bytes)
    await assert.rejects(fs.access(cache))
    await fs.writeFile(cache, 'damaged complete cache', 'utf8')
    await assert.rejects(exec(bootstrap, args), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /\u5b89\u88c5\u5305\u5df2\u635f\u574f\u5e76\u5df2\u5220\u9664/)
      return true
    })
    assert.match(await fs.readFile(report, 'utf16le'), /status=error\r\n/)
    await assert.rejects(fs.access(cache))
    assert.deepEqual(await fs.readFile(`${cache}.part`), bytes)
  })

  await t.test('packaged launcher reads the saved custom Codex location with a legacy console encoding', async () => {
    const portable = path.join(root, 'Codex \u6d4b\u8bd5')
    const executable = path.join(portable, 'app', 'Codex.exe')
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, 'isolated identity fixture; never executed', 'utf8')
    await fs.writeFile(path.join(portable, 'AppxManifest.xml'), `
      <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
        <Identity Name="OpenAI.Codex" Version="26.1027.3384.0" ProcessorArchitecture="x64"
          Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"/>
        <Applications><Application Id="Codex" Executable="app\\Codex.exe"/></Applications>
      </Package>`, 'utf8')
    const location = path.join(extracted, 'codex-location.json')
    await exec(path.join(extracted, 'runtime', 'codex-bootstrap.exe'),
      ['remember', '--selected', executable, '--location', location])
    const savedText = await fs.readFile(location, 'utf8')
    const saved = JSON.parse(savedText)
    assert.deepEqual(saved, { format: 1, source: 'portable', root: portable })
    const probe = path.join(root, 'selection-probe.ps1')
    await fs.writeFile(probe, selectedCodexProbe, 'utf8')
    const result = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', probe, '-AppRoot', extracted, '-Expected', executable,
      '-Prerequisite', path.join(repository, 'scripts', 'install-codex.ps1')])
    assert.equal(result.stderr, '')
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
      'selected=True exists=True source=portable', 'encodingRestored=True',
      'prerequisite=True encodingRestored=True',
      'launcherFailed=True encodingRestored=True', 'prerequisiteFailed=True encodingRestored=True',
    ])
    assert.equal(await fs.readFile(location, 'utf8'), savedText)
  })

  assert.deepEqual(await Promise.all(protectedFiles.map(digest)), before,
    'Installer checks must not modify real Codex configuration or authentication')
})
