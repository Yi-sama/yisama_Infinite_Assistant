import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { replaceFile } from './codex-config.mjs'
import { UPDATE_FILES, updateLocal } from './update-local.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const requiredExistingFiles = UPDATE_FILES.filter((file) => file !== 'scripts/update-local.mjs')
const exec = promisify(execFile)

async function makeInstallation(t) {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-local-update-'))
  t.after(() => fs.rm(target, { recursive: true, force: true, maxRetries: 3 }))
  await fs.mkdir(path.join(target, 'runtime'), { recursive: true })
  await fs.writeFile(path.join(target, 'runtime', 'node.exe'), '')
  await fs.copyFile(path.join(repository, 'package.json'), path.join(target, 'package.json'))
  for (const relative of requiredExistingFiles) {
    const destination = path.join(target, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(path.join(repository, relative), destination)
  }
  await fs.mkdir(path.join(target, 'account'), { recursive: true })
  await fs.mkdir(path.join(target, 'logs'), { recursive: true })
  await fs.mkdir(path.join(target, '.codex'), { recursive: true })
  await fs.mkdir(path.join(target, 'node_modules', 'kept'), { recursive: true })
  await fs.writeFile(path.join(target, 'account', 'session.json'), '{"token":"keep"}\n')
  await fs.writeFile(path.join(target, 'logs', 'assistant.log'), 'keep log\n')
  await fs.writeFile(path.join(target, '.codex', 'auth.json'), '{"auth":"keep"}\n')
  await fs.writeFile(path.join(target, 'node_modules', 'kept', 'package.json'), '{"keep":true}\n')
  return target
}

async function content(file) {
  return fs.readFile(file, 'utf8')
}

test('updates only allowlisted local runtime files and leaves user data alone', async (t) => {
  const target = await makeInstallation(t)
  for (const relative of requiredExistingFiles) await fs.writeFile(path.join(target, relative), `old ${relative}\n`)
  await fs.writeFile(path.join(target, 'scripts', 'legacy.mjs'), 'legacy\n')
  const preserved = await Promise.all([
    content(path.join(target, 'account', 'session.json')),
    content(path.join(target, 'logs', 'assistant.log')),
    content(path.join(target, '.codex', 'auth.json')),
    content(path.join(target, 'node_modules', 'kept', 'package.json')),
  ])

  const result = await updateLocal({ target })
  assert.deepEqual(result.changedFiles, [...UPDATE_FILES, 'update.json'])
  assert.match(result.generation, /^[a-f0-9]{64}$/)
  assert.equal(result.reload, 'pending')
  for (const relative of UPDATE_FILES) {
    assert.deepEqual(await fs.readFile(path.join(target, relative)), await fs.readFile(path.join(repository, relative)))
  }
  assert.equal(await content(path.join(target, 'scripts', 'legacy.mjs')), 'legacy\n')
  assert.deepEqual(await Promise.all([
    content(path.join(target, 'account', 'session.json')),
    content(path.join(target, 'logs', 'assistant.log')),
    content(path.join(target, '.codex', 'auth.json')),
    content(path.join(target, 'node_modules', 'kept', 'package.json')),
  ]), preserved)
})

test('rejects an incompatible package before changing the target', async (t) => {
  const target = await makeInstallation(t)
  const packageFile = path.join(target, 'package.json')
  const pkg = JSON.parse(await content(packageFile))
  pkg.dependencies.playwright = '0.0.0'
  await fs.writeFile(packageFile, JSON.stringify(pkg))
  const before = await content(path.join(target, 'scripts', 'codex-assistant.mjs'))

  await assert.rejects(updateLocal({ target }), /package is incompatible/)
  assert.equal(await content(path.join(target, 'scripts', 'codex-assistant.mjs')), before)
  await assert.rejects(fs.access(path.join(target, 'update.json')))
})

test('rejects the source repository as an update target', async () => {
  await assert.rejects(updateLocal({ target: repository }), /cannot be the source repository/)
})

test('rejects a symbolic link in the installation tree', async (t) => {
  const target = await makeInstallation(t)
  const linked = path.join(target, 'scripts', 'codex-panel.mjs')
  const outside = path.join(target, 'outside.mjs')
  await fs.writeFile(outside, 'outside\n')
  await fs.rm(linked)
  try {
    await fs.symlink(outside, linked, 'file')
  } catch (error) {
    if (error.code === 'EPERM') t.skip('This Windows environment does not permit file symlinks.')
    else throw error
    return
  }

  await assert.rejects(updateLocal({ target }), /target is unsafe/)
  assert.equal(await content(outside), 'outside\n')
})

test('dry run reports changes without writing and a second run is idempotent', async (t) => {
  const target = await makeInstallation(t)
  const assistant = path.join(target, 'scripts', 'codex-assistant.mjs')
  await fs.writeFile(assistant, 'old assistant\n')

  const dryRun = await updateLocal({ target, dryRun: true })
  assert.ok(dryRun.changedFiles.includes('scripts/codex-assistant.mjs'))
  assert.ok(dryRun.changedFiles.includes('update.json'))
  assert.equal(await content(assistant), 'old assistant\n')
  await assert.rejects(fs.access(path.join(target, 'update.json')))

  await updateLocal({ target })
  const marker = path.join(target, 'update.json')
  const before = await content(marker)
  const beforeStat = await fs.stat(marker)
  const repeated = await updateLocal({ target })
  assert.deepEqual(repeated.changedFiles, [])
  assert.equal(await content(marker), before)
  assert.equal((await fs.stat(marker)).mtimeMs, beforeStat.mtimeMs)
})

test('CLI accepts an absolute target and prints the update result', async (t) => {
  const target = await makeInstallation(t)
  const { stdout, stderr } = await exec(process.execPath, [
    path.join(repository, 'scripts', 'update-local.mjs'), '--target', target, '--dry-run',
  ])
  const result = JSON.parse(stdout)
  assert.equal(stderr, '')
  assert.ok(result.changedFiles.includes('scripts/update-local.mjs'))
  assert.match(result.generation, /^[a-f0-9]{64}$/)
  assert.equal(result.reload, 'pending')
  await assert.rejects(fs.access(path.join(target, 'update.json')))
})

test('writes the marker last and rolls back copied files when a write fails', async (t) => {
  const target = await makeInstallation(t)
  const assistant = path.join(target, 'scripts', 'codex-assistant.mjs')
  const panel = path.join(target, 'scripts', 'codex-panel.mjs')
  await fs.writeFile(assistant, 'old assistant\n')
  const writes = []
  await updateLocal({
    target,
    write: async (file, text) => {
      writes.push(path.relative(target, file))
      await replaceFile(file, text)
    },
  })
  assert.equal(writes.at(-1), 'update.json')

  await fs.writeFile(assistant, 'rollback assistant\n')
  await fs.writeFile(panel, 'rollback panel\n')
  const marker = path.join(target, 'update.json')
  const markerBefore = await content(marker)
  let failed = false
  await assert.rejects(updateLocal({
    target,
    write: async (file, text) => {
      if (path.relative(target, file).split(path.sep).join('/') === 'scripts/codex-panel.mjs') {
        failed = true
        throw new Error('simulated write failure')
      }
      await replaceFile(file, text)
    },
  }), /simulated write failure/)
  assert.equal(failed, true)
  assert.equal(await content(assistant), 'rollback assistant\n')
  assert.equal(await content(panel), 'rollback panel\n')
  assert.equal(await content(marker), markerBefore)
})
