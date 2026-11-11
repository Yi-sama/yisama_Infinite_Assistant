import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { checkLocalStartup, prepareAutomaticUpdate } from './startup-check.mjs'
import { synchronizeThreadProviders } from './thread-provider.mjs'
import { replaceFile } from './codex-config.mjs'

const ids = ['019a7b18-3000-7000-8000-000000000001', '019a7b18-3000-7000-8000-000000000002']

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-startup-check-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const codexHome = path.join(root, 'codex')
  const pluginData = path.join(root, 'data')
  await fs.mkdir(codexHome)
  await fs.mkdir(pluginData)
  const files = { pluginData, state: path.join(pluginData, 'state.json'),
    codexConfig: path.join(codexHome, 'config.toml') }
  await fs.writeFile(files.state, '{"configured":true}', 'utf8')
  await fs.writeFile(files.codexConfig, 'model_provider = "yisama"\n', 'utf8')
  const databaseFile = path.join(codexHome, 'state_5.sqlite')
  const database = new DatabaseSync(databaseFile)
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT)')
  const rollouts = []
  for (const [index, provider] of ['custom', 'openai'].entries()) {
    const file = path.join(codexHome, index ? 'archived_sessions' : 'sessions/2026/11/11',
      `rollout-2026-11-11-${ids[index]}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const header = { timestamp: '2026-11-11T00:00:00Z', type: 'session_meta',
      payload: { id: ids[index], model_provider: provider, cwd: root, git: { branch: 'kept' } } }
    const body = '\r\n{"type":"response_item","payload":{"role":"user","content":"keep custom and openai verbatim"}}\n'
    const bytes = JSON.stringify(header) + body
    await fs.writeFile(file, bytes, 'utf8')
    database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)')
      .run(ids[index], file, provider, `Title ${index}`)
    rollouts.push({ file, bytes, provider })
  }
  database.close()
  const rows = () => {
    const db = new DatabaseSync(databaseFile)
    try { return db.prepare('SELECT * FROM threads ORDER BY id').all() } finally { db.close() }
  }
  return { root, codexHome, pluginData, files, rollouts, rows, databaseFile }
}

test('startup migrates active and archived providers without changing IDs, titles or conversation bodies', async (t) => {
  const f = await fixture(t)
  const before = f.rows()
  assert.deepEqual(await checkLocalStartup(f.files), {
    local: true, paidCalls: 0, configured: true, threads: { status: 'complete', changed: 2, skipped: 0 },
  })
  const after = f.rows()
  assert.deepEqual(after.map((row) => ({ ...row, model_provider: 'original' })),
    before.map((row) => ({ ...row, model_provider: 'original' })))
  assert.ok(after.every((row) => row.model_provider === 'yisama'))
  for (const { file, bytes } of f.rollouts) {
    const changed = await fs.readFile(file, 'utf8')
    assert.equal(changed.slice(changed.indexOf('\n')), bytes.slice(bytes.indexOf('\n')))
    assert.equal(JSON.parse(changed.split('\n')[0]).payload.model_provider, 'yisama')
  }
  assert.equal((await checkLocalStartup(f.files)).threads.changed, 0)
  const backups = await fs.readdir(path.join(f.pluginData, 'backups'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(f.pluginData, 'backups', backups[0]), 'utf8'))
  assert.deepEqual(ids.map((id) => backup.entries[id].provider), ['custom', 'openai'])
})

test('restoring providers preserves newer messages and follows a conversation moved into the archive', async (t) => {
  const f = await fixture(t)
  await checkLocalStartup(f.files)
  const original = f.rollouts[0]
  const moved = path.join(f.codexHome, 'archived_sessions', path.basename(original.file))
  await fs.rename(original.file, moved)
  const db = new DatabaseSync(f.databaseFile)
  db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(moved, ids[0])
  db.close()
  const appended = '{"type":"response_item","payload":{"content":"a newer message"}}\n'
  await fs.appendFile(moved, appended, 'utf8')
  await fs.writeFile(f.files.codexConfig, 'model_provider = "custom"\n', 'utf8')
  await fs.writeFile(f.files.state, '{}', 'utf8')
  assert.equal((await checkLocalStartup(f.files)).threads.changed, 2)
  assert.deepEqual(f.rows().map((row) => row.model_provider), ['custom', 'openai'])
  assert.equal(await fs.readFile(moved, 'utf8'), original.bytes + appended)
  assert.equal((await checkLocalStartup(f.files, { restore: true })).threads.changed, 0)
})

test('first installation without login inspects locally but does not migrate or contact a service', async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('local startup checks must not call a service'))
  await fs.rm(f.files.state)
  const result = await checkLocalStartup(f.files)
  assert.equal(result.configured, false)
  assert.equal(result.paidCalls, 0)
  assert.equal(result.threads.changed, 0)
  assert.deepEqual(f.rows().map((row) => row.model_provider), ['custom', 'openai'])
  await assert.rejects(fs.access(path.join(f.pluginData, 'backups')))
  await fs.writeFile(f.files.state, '{"configured":true}', 'utf8')
  await fs.writeFile(f.files.codexConfig,
    'model_provider="yisama"\nprofile="personal"\n[profiles.personal]\nmodel_provider="custom"\n', 'utf8')
  assert.equal((await checkLocalStartup(f.files)).configured, false)
})

test('a failed backup makes no changes, and a failed later write rolls back files and database', async (t) => {
  const f = await fixture(t)
  const before = f.rows()
  await assert.rejects(synchronizeThreadProviders({ ...f, migrate: true,
    writeBackup: async () => { throw new Error('fixture backup failure') } }), /fixture backup failure/)
  let writes = 0
  await assert.rejects(synchronizeThreadProviders({ ...f, migrate: true,
    writeHeader: async (file, header, bytes) => {
      if (++writes === 2) throw new Error('fixture write failure')
      const original = await fs.readFile(file)
      await fs.writeFile(file, Buffer.concat([bytes, original.subarray(header.original.length)]))
    },
  }), /fixture write failure/)
  assert.deepEqual(f.rows(), before)
  for (const { file, bytes } of f.rollouts) assert.equal(await fs.readFile(file, 'utf8'), bytes)
  assert.equal((await checkLocalStartup(f.files)).threads.changed, 2)
})

test('unsupported or unavailable history is reported without changing that record', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.rollouts[0].file, 'not json\nkeep this file\n', 'utf8')
  const result = await checkLocalStartup(f.files)
  assert.equal(result.threads.status, 'partial')
  assert.equal(result.threads.changed, 1)
  assert.equal(f.rows()[0].model_provider, 'custom')
  assert.equal(await fs.readFile(f.rollouts[0].file, 'utf8'), 'not json\nkeep this file\n')
  const db = new DatabaseSync(f.databaseFile)
  db.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT)')
  db.close()
  const before = await fs.readFile(f.rollouts[1].file)
  await assert.rejects(checkLocalStartup(f.files), /Unsupported local thread database/)
  assert.deepEqual(await fs.readFile(f.rollouts[1].file), before)
})

test('an interrupted migration is completed using the already saved original provider', async (t) => {
  const f = await fixture(t)
  await synchronizeThreadProviders({ ...f, migrate: true })
  const db = new DatabaseSync(f.databaseFile)
  db.prepare('UPDATE threads SET model_provider = ? WHERE id = ?').run('custom', ids[0])
  db.close()
  await checkLocalStartup(f.files)
  assert.equal(f.rows()[0].model_provider, 'yisama')
  await checkLocalStartup(f.files, { restore: true })
  assert.equal(f.rows()[0].model_provider, 'custom')
})

test('migrating after an interrupted restore retains the original database provider backup', async (t) => {
  const f = await fixture(t)
  await checkLocalStartup(f.files)
  await fs.writeFile(f.rollouts[0].file, f.rollouts[0].bytes, 'utf8')
  await checkLocalStartup(f.files)
  await checkLocalStartup(f.files, { restore: true })
  assert.deepEqual(f.rows().map((row) => row.model_provider), ['custom', 'openai'])
})

test('Windows extended-length rollout paths identify the same local conversation', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const f = await fixture(t)
  const db = new DatabaseSync(f.databaseFile)
  for (const row of db.prepare('SELECT id, rollout_path FROM threads').all()) {
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?')
      .run(path.toNamespacedPath(row.rollout_path), row.id)
  }
  db.close()
  assert.equal((await checkLocalStartup(f.files)).threads.changed, 2)
  assert.ok(f.rows().every((row) => row.model_provider === 'yisama'))
})

test('provider-only restore does not overwrite a later manually selected provider', async (t) => {
  const f = await fixture(t)
  await checkLocalStartup(f.files)
  const file = f.rollouts[0].file
  const bytes = await fs.readFile(file, 'utf8')
  const split = bytes.indexOf('\n')
  const header = JSON.parse(bytes.slice(0, split))
  header.payload.model_provider = 'personal'
  await replaceFile(file, JSON.stringify(header) + bytes.slice(split))
  const db = new DatabaseSync(f.databaseFile)
  db.prepare('UPDATE threads SET model_provider = ? WHERE id = ?').run('personal', ids[0])
  db.close()
  await checkLocalStartup(f.files, { restore: true })
  assert.equal(f.rows()[0].model_provider, 'personal')
  assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]).payload.model_provider, 'personal')
})

test('automatic updating prepares a verified newer release once and never schedules an in-use restart', async () => {
  const calls = []
  const updateInstaller = { path: 'C:/fixture/cache/update.exe', sha256: 'a'.repeat(64) }
  const updater = {
    async check() { calls.push('check'); return { available: true, updateId: 'checked', latestVersion: '1.2.5' } },
    async prepare(id) { calls.push(id); return { updateInstaller } },
  }
  assert.deepEqual(await prepareAutomaticUpdate({ updater }), {
    status: 'prepared', version: '1.2.5', updateInstaller,
  })
  assert.deepEqual(calls, ['check', 'checked'])
  updater.check = async () => ({ available: false })
  assert.deepEqual(await prepareAutomaticUpdate({ updater }), { status: 'current' })
  updater.check = async () => { throw new Error('fixture offline') }
  assert.deepEqual(await prepareAutomaticUpdate({ updater }), { status: 'unavailable' })
  assert.deepEqual(calls, ['check', 'checked'])
})
