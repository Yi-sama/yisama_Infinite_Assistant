import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
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
  const protectedFiles = ['config.toml', 'auth.json'].map((name) => path.join(realHome, name))
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
  assert.deepEqual(releasePackage.dependencies, { playwright: '1.64.1' })
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.sourceIncluded, false)
  assert.equal(manifest.sourceMapsIncluded, false)
  assert.equal(manifest.testFilesIncluded, false)
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
    await assert.rejects(exec(bootstrap, args), /cached package was damaged/)
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
