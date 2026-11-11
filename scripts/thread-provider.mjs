import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { readOptional, replaceFile } from './codex-config.mjs'

const TARGET = 'yisama'
const MAX_HEADER = 1024 * 1024

function pathKey(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? path.toNamespacedPath(resolved).toLowerCase() : resolved
}

function inside(root, relative) {
  const file = path.resolve(root, relative)
  const relation = path.relative(root, file)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error('Unsafe local thread path.')
  }
  return file
}

async function regularFile(root, relative) {
  const file = inside(root, relative)
  let current = root
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('Linked thread paths are not migrated.')
  }
  if (!(await fs.lstat(file)).isFile()) throw new Error('Invalid local thread file.')
  return file
}

async function rolloutFiles(home) {
  const files = []
  const walk = async (directory) => {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) files.push(file)
    }
  }
  for (const name of ['sessions', 'archived_sessions']) {
    const directory = path.join(home, name)
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) continue
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    await walk(directory)
  }
  return files
}

async function readHeader(file) {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_HEADER))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const newline = bytes.subarray(0, bytesRead).indexOf(10)
    if (newline < 0 && stat.size > bytesRead) throw new Error('Unsupported local thread header.')
    const end = newline < 0 ? bytesRead : newline + 1
    const original = bytes.subarray(0, end)
    const text = original.toString('utf8')
    const value = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (value.type !== 'session_meta' || !value.payload ||
        typeof value.payload.id !== 'string' || value.payload.id === '__proto__' ||
        (value.payload.model_provider !== undefined && typeof value.payload.model_provider !== 'string')) {
      throw new Error('Unsupported local thread metadata.')
    }
    return { value, original, stat, newline: text.endsWith('\r\n') ? '\r\n' : newline < 0 ? '' : '\n',
      bom: text.startsWith('\uFEFF') ? '\uFEFF' : '' }
  } finally { await handle.close() }
}

async function replaceHeader(file, previous, bytes) {
  const temporary = `${file}.${randomUUID()}.partial`
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: previous.stat.mode })
    if (previous.stat.size > previous.original.length) {
      await pipeline(createReadStream(file, { start: previous.original.length }),
        createWriteStream(temporary, { flags: 'a' }))
    }
    const current = await fs.stat(file)
    if (current.size !== previous.stat.size || current.mtimeMs !== previous.stat.mtimeMs) {
      throw new Error('The local thread changed during migration.')
    }
    await fs.utimes(temporary, previous.stat.atime, previous.stat.mtime)
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

// Only provider metadata is backed up. Conversation bodies are copied byte for byte.
export async function synchronizeThreadProviders({
  codexHome, pluginData, migrate = false, writeBackup = replaceFile, writeHeader = replaceHeader,
}) {
  const home = path.resolve(codexHome)
  const tag = createHash('sha256').update(home).digest('hex').slice(0, 16)
  const backupFile = path.join(pluginData, 'backups', `thread-providers-${tag}.json`)
  const saved = await readOptional(backupFile)
  const backup = saved === null ? { format: 1, codexHome: home, entries: {} } : JSON.parse(saved)
  if (backup.format !== 1 || backup.codexHome !== home || !backup.entries ||
      typeof backup.entries !== 'object' || Array.isArray(backup.entries)) {
    throw new Error('Invalid thread provider backup.')
  }
  if (!migrate && !Object.keys(backup.entries).length) return { status: 'unchanged', changed: 0, skipped: 0 }
  let names
  try { names = await fs.readdir(home) } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unchanged', changed: 0, skipped: 0 }
    throw error
  }
  if ((await fs.lstat(home)).isSymbolicLink()) throw new Error('Linked Codex homes are not migrated.')
  const databases = names.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
  let database
  let committed = false
  const written = []
  try {
    let rows = new Map()
    if (databases.length) {
      const { DatabaseSync } = await import('node:sqlite')
      database = new DatabaseSync(await regularFile(home, databases[0]))
      database.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE')
      const columns = database.prepare('PRAGMA table_info(threads)').all().map((row) => row.name)
      if (!['id', 'rollout_path', 'model_provider'].every((name) => columns.includes(name))) {
        throw new Error('Unsupported local thread database.')
      }
      rows = new Map(database.prepare('SELECT id, rollout_path, model_provider FROM threads').all()
        .map((row) => [row.id, row]))
    }
    const plans = []
    let skipped = 0
    const seen = new Set()
    for (const file of await rolloutFiles(home)) {
      const relative = path.relative(home, file)
      await regularFile(home, relative)
      let header
      try { header = await readHeader(file) } catch { skipped++; continue }
      const id = header.value.payload.id
      if (seen.has(id)) throw new Error('Duplicate local thread identity.')
      seen.add(id)
      const row = rows.get(id)
      if (row && (typeof row.rollout_path !== 'string' || pathKey(row.rollout_path) !== pathKey(file))) {
        skipped++
        continue
      }
      const provider = header.value.payload.model_provider
      const original = Object.hasOwn(backup.entries, id) ? backup.entries[id] : null
      if (!migrate && !original) continue
      const nextProvider = migrate ? TARGET : original.provider
      const nextDatabaseProvider = migrate ? TARGET : original.databaseProvider
      const changeHeader = migrate ? provider !== TARGET : provider === TARGET && nextProvider !== TARGET
      const changeDatabase = row && (migrate ? row.model_provider !== TARGET
        : row.model_provider === TARGET && typeof nextDatabaseProvider === 'string' && nextDatabaseProvider !== TARGET)
      if (!changeHeader && !changeDatabase) continue
      if (migrate && (!original || provider !== TARGET)) {
        backup.entries[id] = { file: relative, provider: provider ?? null,
          databaseProvider: original && row?.model_provider === TARGET
            ? original.databaseProvider : row?.model_provider ?? provider ?? 'openai' }
      }
      if (!migrate && nextProvider !== null && typeof nextProvider !== 'string') {
        throw new Error('Invalid original thread provider.')
      }
      const value = structuredClone(header.value)
      if (nextProvider === null) delete value.payload.model_provider
      else value.payload.model_provider = nextProvider
      plans.push({ file, id, header, changeHeader, changeDatabase, nextDatabaseProvider,
        bytes: Buffer.from(header.bom + JSON.stringify(value) + header.newline) })
    }
    for (const row of rows.values()) {
      if (!seen.has(row.id) && (migrate ? row.model_provider !== TARGET
        : Object.hasOwn(backup.entries, row.id) && row.model_provider === TARGET)) skipped++
    }
    if (!plans.length) {
      database?.exec('ROLLBACK')
      return { status: skipped ? 'partial' : 'unchanged', changed: 0, skipped }
    }
    // Save originals before the first mutation; rerunning also completes an interrupted migration.
    if (migrate) await writeBackup(backupFile, JSON.stringify(backup, null, 2) + '\n')
    for (const plan of plans) {
      if (plan.changeHeader) {
        await writeHeader(plan.file, plan.header, plan.bytes)
        written.push(plan)
      }
      if (plan.changeDatabase) {
        database.prepare('UPDATE threads SET model_provider = ? WHERE id = ?')
          .run(plan.nextDatabaseProvider, plan.id)
      }
    }
    database?.exec('COMMIT')
    committed = true
    return { status: skipped ? 'partial' : 'complete', changed: plans.length, skipped }
  } catch (error) {
    if (!committed) {
      const failures = []
      if (database) {
        try { database.exec('ROLLBACK') } catch (failure) { failures.push(failure) }
      }
      for (const plan of written.reverse()) {
        try { await replaceHeader(plan.file, await readHeader(plan.file), plan.header.original) } catch (failure) {
          failures.push(failure)
        }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Thread migration rollback incomplete.')
    }
    throw error
  } finally { database?.close() }
}
