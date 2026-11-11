import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { replaceFile, writeTransaction } from './codex-config.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

export const UPDATE_FILES = Object.freeze([
  'scripts/codex-assistant.mjs',
  'scripts/codex-panel.mjs',
  'scripts/codex-config.mjs',
  'scripts/desktop-bridge.mjs',
  'scripts/imagegen.mjs',
  'scripts/yisama.mjs',
  'scripts/launch-codex.ps1',
  'scripts/update-local.mjs',
  'scripts/online-update.mjs',
  'scripts/startup-check.mjs',
  'scripts/thread-provider.mjs',
])

const REQUIRED_TARGET_FILES = UPDATE_FILES.filter((file) =>
  !['scripts/update-local.mjs', 'scripts/imagegen.mjs', 'scripts/online-update.mjs',
    'scripts/startup-check.mjs', 'scripts/thread-provider.mjs'].includes(file))

function inside(root, relative) {
  const candidate = path.resolve(root, relative)
  const relation = path.relative(root, candidate)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error('Local update path is invalid.')
  }
  return candidate
}

async function lstatOptional(file) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function assertSafePath(root, relative, kind) {
  const parts = relative ? relative.split(/[\\/]/) : []
  let current = root
  const rootStat = await fs.lstat(current)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Local update target is unsafe.')
  }
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('Local update target is unsafe.')
  }
  const stat = await fs.lstat(current)
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) {
    throw new Error('Local update target is incomplete.')
  }
  return current
}

async function readOptionalSafe(root, relative) {
  const file = inside(root, relative)
  if (await lstatOptional(file) === null) return null
  await assertSafePath(root, relative, 'file')
  return fs.readFile(file, 'utf8')
}

function packageIdentity(pkg) {
  return { name: pkg?.name, private: pkg?.private, type: pkg?.type }
}

async function validateTarget(target, sourceRoot) {
  await assertSafePath(target, '', 'directory')
  const [resolvedTarget, resolvedSource] = await Promise.all([fs.realpath(target), fs.realpath(sourceRoot)])
  if (path.resolve(resolvedTarget) === path.resolve(resolvedSource)) {
    throw new Error('The local update target cannot be the source repository.')
  }

  const [sourcePackageText, targetPackageText] = await Promise.all([
    fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'),
    readOptionalSafe(target, 'package.json'),
  ])
  if (targetPackageText === null) throw new Error('Local update target is incomplete.')
  const sourcePackage = JSON.parse(sourcePackageText)
  const targetPackage = JSON.parse(targetPackageText)
  if (!isDeepStrictEqual(packageIdentity(sourcePackage), packageIdentity(targetPackage)) ||
      !isDeepStrictEqual(sourcePackage.dependencies || {}, targetPackage.dependencies || {})) {
    throw new Error('Local update target package is incompatible.')
  }

  await assertSafePath(target, 'runtime/node.exe', 'file')
  if (await lstatOptional(inside(target, 'runtime/codex-bootstrap.exe')) === null) {
    throw new Error('This update requires the full Windows installer: the Codex bootstrap runtime is missing.')
  }
  await assertSafePath(target, 'runtime/codex-bootstrap.exe', 'file')
  for (const relative of REQUIRED_TARGET_FILES) await assertSafePath(target, relative, 'file')
  return sourcePackage
}

export function generationFor(files) {
  const hash = createHash('sha256')
  for (const [relative, content] of files) {
    hash.update(relative).update('\0').update(content).update('\0')
  }
  return hash.digest('hex')
}

function hasCurrentMarker(text, generation) {
  if (text === null) return false
  try {
    const marker = JSON.parse(text)
    return marker?.generation === generation && typeof marker.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(marker.updatedAt))
  } catch {
    return false
  }
}

export async function updateLocal({
  target = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'yisama-infinite-assistant'),
  dryRun = false,
  sourceRoot = repository,
  write = replaceFile,
} = {}) {
  if (!target || !path.isAbsolute(target)) throw new Error('Use an absolute local installation path.')
  const targetRoot = path.resolve(target)
  const sourceRootResolved = path.resolve(sourceRoot)
  await validateTarget(targetRoot, sourceRootResolved)

  const sourceFiles = await Promise.all(UPDATE_FILES.map(async (relative) => {
    const file = inside(sourceRootResolved, relative)
    return [relative, await fs.readFile(file)]
  }))
  const generation = generationFor(sourceFiles)
  const changedFiles = []
  const entries = []
  for (const [relative, content] of sourceFiles) {
    const destination = inside(targetRoot, relative)
    const current = await readOptionalSafe(targetRoot, relative)
    if (current === null || !Buffer.from(current).equals(content)) {
      entries.push([destination, content])
      changedFiles.push(relative)
    }
  }

  const marker = await readOptionalSafe(targetRoot, 'update.json')
  if (entries.length || !hasCurrentMarker(marker, generation)) {
    entries.push([inside(targetRoot, 'update.json'), JSON.stringify({
      generation,
      updatedAt: new Date().toISOString(),
    }) + '\n'])
    changedFiles.push('update.json')
  }

  if (!dryRun && entries.length) await writeTransaction(entries, write)
  return { changedFiles, generation, reload: 'pending' }
}

function parseArguments(args) {
  let target
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dry-run') dryRun = true
    else if (args[index] === '--target' && args[index + 1]) target = args[++index]
    else throw new Error('Usage: node scripts/update-local.mjs [--target <absolute installation path>] [--dry-run]')
  }
  return { target, dryRun }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await updateLocal(parseArguments(process.argv.slice(2)))
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write(`Local update failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
