import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'
import { createUpdater, newerVersion, validateRelease } from './online-update.mjs'
import { validateRequest } from './desktop-bridge.mjs'
import { buildUpdateManifest } from './build-update.mjs'
import { prepareAutomaticUpdate } from './startup-check.mjs'

const installer = Buffer.from('isolated installer fixture - never executed')
const release = {
  format: 1, version: '1.2.1', url: '/Yisama-Setup-1.2.1.exe',
  sha256: createHash('sha256').update(installer).digest('hex'), size: installer.length,
  notes: 'Update test',
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-online-update-'))
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.0' }))
  const state = { release: { ...release }, bytes: installer, status: 200, downloads: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(state.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state.release))
    } else {
      state.downloads++
      res.end(state.bytes)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/latest.json`
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { state, directory, updater: createUpdater({
    manifestUrl: url, installRoot: directory, cacheRoot: path.join(directory, 'cache'),
  }) }
}

test('update releases compare numeric versions and restrict installer origins and sizes', () => {
  assert.equal(newerVersion('1.10.0', '1.2.0'), true)
  assert.equal(newerVersion('1.2.0', '1.2.0'), false)
  assert.equal(newerVersion('1.1.99', '1.2.0'), false)
  const url = 'https://updates.example.test/latest.json'
  assert.equal(validateRelease(release, url).url, 'https://updates.example.test/Yisama-Setup-1.2.1.exe')
  for (const bad of [
    { version: 'latest' }, { format: 2 }, { size: 0 }, { size: 151 * 1024 * 1024 },
    { sha256: 'bad' }, { url: 'https://attacker.example.test/installer.exe' },
    { url: 'http://updates.example.test/a.exe' }, { url: 'https://user:password@updates.example.test/a.exe' },
  ]) assert.throws(() => validateRelease({ ...release, ...bad }, url))
})

test('checking never downloads or executes; explicit confirmation prepares a verified installer', async (t) => {
  const { updater, state, directory } = await fixture(t)
  await assert.rejects(updater.prepare('a'.repeat(64)), { publicCode: 'UPDATE_CHANGED' })
  const checked = await updater.check()
  assert.equal(checked.available, true)
  assert.equal(checked.currentVersion, '1.2.0')
  assert.equal(state.downloads, 0)
  await assert.rejects(updater.prepare('b'.repeat(64)), { publicCode: 'UPDATE_CHANGED' })
  const prepared = await updater.prepare(checked.updateId)
  assert.equal(prepared.restartRequired, true)
  assert.equal(prepared.updateInstaller.sha256, release.sha256)
  assert.deepEqual(await fs.readFile(prepared.updateInstaller.path), installer)
  assert.equal(await fs.readFile(path.join(directory, 'package.json'), 'utf8'), '{"version":"1.2.0"}')
  await assert.rejects(updater.prepare(checked.updateId), { publicCode: 'UPDATE_CHANGED' })
})

test('1.2.5 detects 1.2.6 while an installed 1.2.6 does not update itself', async (t) => {
  const { updater, state, directory } = await fixture(t)
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"1.2.5"}', 'utf8')
  state.release.version = '1.2.6'
  state.release.url = './Yisama-Setup-1.2.6.exe'
  const checked = await updater.check()
  assert.equal(checked.currentVersion, '1.2.5')
  assert.equal(checked.latestVersion, '1.2.6')
  assert.equal(checked.available, true)
  const prepared = await updater.prepare(checked.updateId)
  assert.deepEqual(await fs.readFile(prepared.updateInstaller.path), installer)
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"1.2.6"}', 'utf8')
  assert.equal((await updater.check()).available, false)
  assert.equal(state.downloads, 1)
})

test('failed checksum, changed release and unavailable service never prepare an installer', async (t) => {
  const { updater, state } = await fixture(t)
  let checked = await updater.check()
  state.bytes = Buffer.alloc(installer.length, 0)
  await assert.rejects(updater.prepare(checked.updateId), { publicCode: 'UPDATE_INVALID' })
  state.bytes = installer
  checked = await updater.check()
  state.release.version = '1.2.2'
  await assert.rejects(updater.prepare(checked.updateId), { publicCode: 'UPDATE_CHANGED' })
  assert.equal(state.downloads, 1)
  state.status = 404
  await assert.rejects(updater.check(), { publicCode: 'UPDATE_UNAVAILABLE' })
})

test('startup automatic updating uses the same checksum gate and falls back offline without execution', async (t) => {
  const { updater, state } = await fixture(t)
  const prepared = await prepareAutomaticUpdate({ updater })
  assert.equal(prepared.status, 'prepared')
  assert.deepEqual(await fs.readFile(prepared.updateInstaller.path), installer)
  assert.equal(state.downloads, 1)
  state.bytes = Buffer.alloc(installer.length, 0)
  assert.deepEqual(await prepareAutomaticUpdate({ updater }), { status: 'unavailable' })
  state.status = 503
  assert.deepEqual(await prepareAutomaticUpdate({ updater }), { status: 'unavailable' })
  assert.equal(state.downloads, 2)
})

test('older or identical releases cannot be installed and bridge does not accept arbitrary installer paths', async (t) => {
  const { updater, state } = await fixture(t)
  state.release.version = '1.2.0'
  assert.equal((await updater.check()).available, false)
  await assert.rejects(updater.prepare('a'.repeat(64)), { publicCode: 'UPDATE_CHANGED' })
  assert.equal(state.downloads, 0)
  assert.deepEqual(validateRequest({ id: 1, action: 'installUpdate', updateId: 'a'.repeat(64),
    installer: 'C:\\attacker.exe' }), { id: 1, action: 'installUpdate', updateId: 'a'.repeat(64) })
  assert.throws(() => validateRequest({ id: 1, action: 'installUpdate' }))
  assert.throws(() => validateRequest({ id: 1, action: 'status', allowInterrupt: true }))
  assert.throws(() => validateRequest({ id: 1, action: 'reconfigure', allowInterrupt: 'yes' }))
})

test('release tooling derives manifest size and checksum from the actual installer', async (t) => {
  const { directory } = await fixture(t)
  const installerPath = path.join(directory, 'Yisama-Setup-1.2.1.exe')
  const output = path.join(directory, 'latest.json')
  await fs.writeFile(installerPath, installer)
  const result = await buildUpdateManifest({ installer: installerPath, version: '1.2.1', output, notes: 'Release' })
  assert.equal(result.sha256, release.sha256)
  assert.equal(result.size, installer.length)
  assert.equal(result.url, './Yisama-Setup-1.2.1.exe')
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), result)
  await assert.rejects(buildUpdateManifest({ installer: installerPath, version: '1.2.1', output }),
    { code: 'EEXIST' })
})
