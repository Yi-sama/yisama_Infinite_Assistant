import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateRelease } from './online-update.mjs'

export async function buildUpdateManifest({ installer, version, notes = '', output }) {
  if (!path.isAbsolute(installer) || !path.isAbsolute(output) || path.extname(installer).toLowerCase() !== '.exe') {
    throw new Error('Use absolute installer.exe and output.json paths.')
  }
  const bytes = await fs.readFile(installer)
  const manifest = {
    format: 1, version, url: `./${encodeURIComponent(path.basename(installer))}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, notes,
  }
  validateRelease(manifest, 'https://updates.example.test/latest.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [installer, version, output, notes = ''] = process.argv.slice(2)
    if (!installer || !version || !output) throw new Error('Usage: node scripts/build-update.mjs <installer.exe> <version> <output.json> [notes]')
    const manifest = await buildUpdateManifest({
      installer: path.resolve(installer), version, output: path.resolve(output), notes,
    })
    console.log(JSON.stringify({ version: manifest.version, size: manifest.size, sha256: manifest.sha256 }))
  } catch (error) {
    console.error(`Update manifest build failed: ${error.message}`)
    process.exitCode = 1
  }
}
