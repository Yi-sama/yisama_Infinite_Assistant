import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
  assert.equal(manifest.sourceIncluded, false)
  assert.equal(manifest.sourceMapsIncluded, false)
  assert.equal(manifest.testFilesIncluded, false)

  const assistant = await fs.readFile(path.join(output, 'scripts', 'codex-assistant.mjs'), 'utf8')
  const yisama = await fs.readFile(path.join(output, 'scripts', 'yisama.mjs'), 'utf8')
  assert.doesNotMatch(assistant, /sourceMappingURL|from\s+["']\.\/(?:codex|desktop|yisama)/)
  assert.doesNotMatch(yisama, /sourceMappingURL|from\s+["']\.\/(?:codex|desktop|yisama)/)
  // The bundled assistant must not read stdin as the desktop bridge would, or it never exits.
  await fs.symlink(path.join(repository, 'node_modules'), path.join(output, 'node_modules'), 'junction')
  const child = spawn(process.execPath, [path.join(output, 'scripts', 'codex-assistant.mjs'), '--help'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let help = ''
  child.stdout.on('data', (chunk) => { help += chunk })
  const code = await Promise.race([once(child, 'exit').then(([exitCode]) => exitCode), delay(10000).then(() => 'running')])
  assert.equal(code, 0, 'bundled assistant kept running while stdin stayed open')
  assert.match(help, /in-Codex assistant/)
  // Online licensing is opt-in (YISAMA_REQUIRE_LICENSE=1); default releases skip it.
  assert.equal(manifest.licenseRequired, false)
})
