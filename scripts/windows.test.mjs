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

test('Windows installer packages the Codex launcher without native overlay automation', {
  skip: !enabled && 'Build Windows artifacts and set YISAMA_WINDOWS_TESTS=1 for isolated installer checks.',
  timeout: 90000,
}, async (t) => {
  await fs.access(installer)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-windows-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))

  const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const protectedFiles = ['config.toml', 'auth.json'].map((name) => path.join(realHome, name))
  const before = await Promise.all(protectedFiles.map(digest))

  let dryRun
  try {
    dryRun = await exec(installer, ['--dry-run'])
  } catch (error) {
    assert.equal(error.code, 2)
    dryRun = error
  }
  assert.match(dryRun.stdout, /BLOCKED|Dry run completed/)
  if (/Dry run completed/.test(dryRun.stdout)) assert.match(dryRun.stdout, /shortcuts named Codex - yisama/)
  assert.doesNotMatch(dryRun.stdout, /Would set HKCU/i)

  const unpacked = await exec(installer, ['--extract-test', root])
  const match = /Extracted payload only:\s*(.+)/.exec(unpacked.stdout)
  assert.ok(match, 'Installer must report its isolated extraction directory')
  const extracted = match[1].trim()
  assert.ok((await fs.realpath(extracted)).toLowerCase().startsWith(
    (await fs.realpath(root)).toLowerCase() + path.sep))

  for (const relative of [
    'runtime/node.exe',
    'runtime/Node-LICENSE.txt',
    'scripts/launch-codex.ps1',
    'scripts/codex-assistant.mjs',
    'scripts/codex-panel.mjs',
    'scripts/desktop-bridge.mjs',
    'scripts/update-local.mjs',
    'node_modules/smol-toml/package.json',
  ]) await fs.access(path.join(extracted, relative))
  const license = await fs.readFile(path.join(extracted, 'runtime/Node-LICENSE.txt'), 'utf8')
  assert.ok(license.length > 10000, 'the runtime must include its complete distribution license')
  assert.match(license, /MIT License/)
  await assert.rejects(fs.access(path.join(extracted, 'Host.exe')))
  for (const name of ['launch-codex.ps1', 'codex-assistant.mjs', 'codex-panel.mjs',
    'desktop-bridge.mjs', 'yisama.mjs', 'codex-config.mjs', 'update-local.mjs']) {
    assert.equal(await digest(path.join(extracted, 'scripts', name)),
      await digest(path.join(repository, 'scripts', name)), `${name} must match the final source`)
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
