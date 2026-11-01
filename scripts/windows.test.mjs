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
const installer = path.join(repository, 'dist', 'Yisama-Setup.exe')
const enabled = process.platform === 'win32' && process.env.YISAMA_WINDOWS_TESTS === '1'

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

test('Windows installer installs the bundled launcher payload', {
  skip: !enabled && 'Build Windows artifacts and set YISAMA_WINDOWS_TESTS=1 for isolated installer checks.',
  timeout: 180000,
}, async (t) => {
  await fs.access(installer)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-windows-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))

  const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const protectedFiles = ['config.toml', 'auth.json'].map((name) => path.join(realHome, name))
  const before = await Promise.all(protectedFiles.map(digest))

  // Test mode installs files only: no Codex check, shortcuts, registry or uninstaller.
  const extracted = path.join(root, 'app')
  await exec(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/YISAMATEST=1',
    `/DIR=${extracted}`, `/LOG=${path.join(root, 'setup.log')}`], { timeout: 120000 })
  await assert.rejects(fs.access(path.join(extracted, 'unins000.exe')))
  await fs.access(path.join(extracted, 'yisama.ico'))
  await assert.rejects(exec('reg.exe', ['query',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2FEC2B14-5ABC-420F-A522-A943ACC9B195}_is1']),
  'test mode must not register an uninstaller')

  for (const relative of [
    'runtime/node.exe',
    'runtime/Node-LICENSE.txt',
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

  assert.deepEqual(await Promise.all(protectedFiles.map(digest)), before,
    'Installer checks must not modify real Codex configuration or authentication')
})
