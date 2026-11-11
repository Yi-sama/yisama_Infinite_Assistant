import path from 'node:path'
import { parse } from 'smol-toml'
import { readOptional } from './codex-config.mjs'
import { synchronizeThreadProviders } from './thread-provider.mjs'

export async function checkLocalStartup(files, { restore = false, synchronize = synchronizeThreadProviders } = {}) {
  const [configText, stateText] = await Promise.all([
    readOptional(files.codexConfig), readOptional(files.state),
  ])
  const config = parse(configText || '')
  const state = JSON.parse(stateText || '{}')
  const active = config.profile && config.profiles?.[config.profile] || config
  const provider = active.model_provider ?? config.model_provider ?? 'openai'
  const migrate = !restore && state.configured === true && provider === 'yisama'
  const threads = await synchronize({ codexHome: path.dirname(files.codexConfig),
    pluginData: files.pluginData, migrate })
  if (restore && threads.skipped) throw new Error('Some original thread providers could not be restored.')
  return { local: true, paidCalls: 0, configured: migrate, threads }
}

export async function prepareAutomaticUpdate({ updater } = {}) {
  if (!updater) {
    const { createUpdater } = await import('./online-update.mjs')
    updater = createUpdater({ manifestTimeoutMs: 5000 })
  }
  try {
    const checked = await updater.check()
    if (!checked.available) return { status: 'current' }
    const prepared = await updater.prepare(checked.updateId)
    return { status: 'prepared', version: checked.latestVersion, updateInstaller: prepared.updateInstaller }
  } catch {
    // An offline or untrusted update must not prevent starting the installed version.
    return { status: 'unavailable' }
  }
}
