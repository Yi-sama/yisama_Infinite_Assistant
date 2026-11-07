import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLED_ENTRIES = Object.freeze([
  ['scripts/codex-assistant.mjs', 'codex-assistant.mjs'],
  ['scripts/yisama.mjs', 'yisama.mjs'],
])

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function parseArguments(args) {
  let sourceRoot = repository
  let outputRoot
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--source-root' && args[index + 1]) sourceRoot = args[++index]
    else if (args[index] === '--out' && args[index + 1]) outputRoot = args[++index]
    else throw new Error('Usage: node scripts/build-release.mjs [--source-root <path>] --out <path>')
  }
  if (!outputRoot) throw new Error('Release output directory is required.')
  return { sourceRoot: path.resolve(sourceRoot), outputRoot: path.resolve(outputRoot) }
}

async function buildEntry(sourceRoot, outputRoot, source, name) {
  const requireLicense = process.env.YISAMA_REQUIRE_LICENSE === '1'
  await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.join(sourceRoot, source)],
    outfile: path.join(outputRoot, 'scripts', name),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    charset: 'ascii',
    treeShaking: true,
    external: ['playwright'],
    define: {
      ...(name === 'codex-assistant.mjs' ? { __YISAMA_CLI_ENTRY__: 'false' } : {}),
      __YISAMA_LICENSE_REQUIRED__: String(requireLicense),
    },
    logLevel: 'silent',
  })
}

async function digest(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function main({ sourceRoot, outputRoot }) {
  const packageFile = path.join(sourceRoot, 'package.json')
  const licenseFile = path.join(sourceRoot, 'LICENSE.txt')
  const launcherFile = path.join(sourceRoot, 'scripts', 'launch-codex.ps1')
  for (const file of [packageFile, licenseFile, launcherFile]) {
    if (!(await exists(file))) throw new Error(`Required release file is missing: ${file}`)
  }

  if (await exists(outputRoot)) {
    const entries = await fs.readdir(outputRoot)
    if (entries.length) throw new Error(`Release output directory is not empty: ${outputRoot}`)
  }
  await fs.mkdir(path.join(outputRoot, 'scripts'), { recursive: true })

  for (const [source, name] of BUNDLED_ENTRIES) {
    await buildEntry(sourceRoot, outputRoot, source, name)
  }
  await fs.copyFile(launcherFile, path.join(outputRoot, 'scripts', 'launch-codex.ps1'))

  const sourcePackage = JSON.parse(await fs.readFile(packageFile, 'utf8'))
  const releasePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: 'module',
    engines: sourcePackage.engines,
    dependencies: { playwright: sourcePackage.dependencies?.playwright },
  }
  await fs.writeFile(path.join(outputRoot, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`, 'utf8')
  await fs.copyFile(licenseFile, path.join(outputRoot, 'LICENSE.txt'))

  const manifest = {
    format: 1,
    version: sourcePackage.version,
    sourceIncluded: false,
    sourceMapsIncluded: false,
    testFilesIncluded: false,
    deviceScopedCredentials: true,
    licenseRequired: process.env.YISAMA_REQUIRE_LICENSE === '1',
    entries: Object.fromEntries(await Promise.all(
      BUNDLED_ENTRIES.map(async ([, name]) => [name, await digest(path.join(outputRoot, 'scripts', name))]),
    )),
  }
  await fs.writeFile(path.join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

try {
  await main(parseArguments(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`Release build failed: ${error.message}\n`)
  process.exitCode = 1
}
