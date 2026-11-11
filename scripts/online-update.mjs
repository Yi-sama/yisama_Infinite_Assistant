import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError } from './yisama.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export const UPDATE_URL = typeof __YISAMA_UPDATE_URL__ === 'undefined'
  ? 'https://api-cn.yisama.asia/assistant/updates/windows-x64/latest.json'
  : __YISAMA_UPDATE_URL__
const MAX_INSTALLER = 150 * 1024 * 1024

function failure(code, message) {
  const error = new UserError(message)
  error.publicCode = code
  return error
}

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) {
    throw failure('UPDATE_INVALID', '更新版本信息无效，未安装更新。')
  }
  return value.split('.').map(Number)
}

export function newerVersion(latest, current) {
  const a = versionParts(latest)
  const b = versionParts(current)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

function trustedUrl(value, origin) {
  const url = new URL(value, origin)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.origin !== new URL(origin).origin || url.username || url.password || url.hash) {
    throw failure('UPDATE_INVALID', '更新下载地址无效，未安装更新。')
  }
  return url.href
}

export function validateRelease(value, manifestUrl) {
  versionParts(value?.version)
  if (value?.format !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_INSTALLER ||
    typeof value.url !== 'string' || !value.url || value.url.length > 2000 ||
    (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000))) {
    throw failure('UPDATE_INVALID', '更新信息无效，未安装更新。')
  }
  const url = trustedUrl(value.url, manifestUrl)
  return { format: 1, version: value.version, url, sha256: value.sha256, size: value.size, notes: value.notes || '' }
}

async function readBounded(response, limit) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw failure('UPDATE_INVALID', '更新文件大小不正确，未安装更新。')
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw failure('UPDATE_CONNECTION', '更新下载中断，未安装更新，请稍后重试。')
  }
  return Buffer.concat(chunks)
}

export function createUpdater({
  manifestUrl = UPDATE_URL, fetchImpl = globalThis.fetch, installRoot = root,
  cacheRoot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'yisama-infinite-assistant-cache', 'updates'),
  manifestTimeoutMs = 15000,
} = {}) {
  let checked = null
  const request = async (url, timeout) => {
    try {
      const response = await fetchImpl(url, {
        redirect: 'error', signal: AbortSignal.timeout(timeout), credentials: 'omit',
        headers: { Accept: url === manifestUrl ? 'application/json' : 'application/octet-stream' },
      })
      if (!response.ok) throw failure('UPDATE_UNAVAILABLE', '更新服务暂不可用，当前版本未改动。')
      return response
    } catch (error) {
      if (error instanceof UserError) throw error
      throw failure('UPDATE_CONNECTION', '暂时无法连接更新服务，请稍后重试。')
    }
  }
  const loadRelease = async () => {
    trustedUrl(manifestUrl, manifestUrl)
    const response = await request(manifestUrl, manifestTimeoutMs)
    try {
      return validateRelease(JSON.parse((await readBounded(response, 16384)).toString('utf8')), manifestUrl)
    } catch (error) {
      if (error instanceof UserError) throw error
      throw failure('UPDATE_INVALID', '更新信息无效，未安装更新。')
    }
  }
  const currentVersion = async () => JSON.parse(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8')).version
  return {
    async check() {
      checked = null
      const [release, current] = await Promise.all([loadRelease(), currentVersion()])
      const available = newerVersion(release.version, current)
      const updateId = createHash('sha256').update(JSON.stringify(release)).digest('hex')
      if (available) checked = { release, updateId }
      return { currentVersion: current, latestVersion: release.version, available,
        notes: release.notes, size: release.size, ...(available ? { updateId } : {}) }
    },
    async prepare(updateId) {
      if (!checked || updateId !== checked.updateId) {
        throw failure('UPDATE_CHANGED', '请先检查更新并确认新版本。')
      }
      const release = checked.release
      const latest = await loadRelease()
      if (JSON.stringify(latest) !== JSON.stringify(release)) {
        checked = null
        throw failure('UPDATE_CHANGED', '更新版本已变化，请重新检查后确认。')
      }
      if (!cacheRoot || !path.isAbsolute(cacheRoot)) throw failure('UPDATE_INVALID', '无法准备更新缓存目录。')
      const directory = path.join(cacheRoot, release.sha256)
      await fs.mkdir(directory, { recursive: true })
      // Unique names prevent two open Codex windows from overwriting each other's download.
      const installer = path.join(directory, `Yisama-Setup-${randomUUID()}.exe`)
      const response = await request(release.url, 120000)
      const bytes = await readBounded(response, release.size)
      if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
        throw failure('UPDATE_INVALID', '更新文件校验失败，未安装更新。')
      }
      await fs.writeFile(installer, bytes, { flag: 'wx' })
      checked = null
      return { restartRequired: true, updateInstaller: { path: installer, sha256: release.sha256 },
        message: '更新包已校验，正在准备重启 Codex。' }
    },
  }
}

const updater = createUpdater()
export const checkForUpdates = () => updater.check()
export const prepareUpdate = (updateId) => updater.prepare(updateId)
