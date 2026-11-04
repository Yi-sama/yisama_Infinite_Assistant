import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'smol-toml'

export const DEFAULT_ORIGIN = 'https://api.yisama.asia'
export const PROVIDER_ID = 'yisama'
export class ConfigRecoveryError extends Error {}

export function providerConfig(origin = DEFAULT_ORIGIN) {
  return {
    name: 'yisama',
    base_url: `${origin}/v1`,
    wire_api: 'responses',
    requires_openai_auth: true,
  }
}

export function patchCodexConfig(text, origin = DEFAULT_ORIGIN, model, reasoning, fast = true, catalogPath) {
  const config = parse(text || '')
  const settings = {
    model_provider: PROVIDER_ID,
  }
  if (fast) settings.service_tier = 'fast'
  if (model) settings.model = model
  if (reasoning !== undefined) settings.model_reasoning_effort = reasoning
  if (catalogPath !== undefined) settings.model_catalog_json = catalogPath
  Object.assign(config, settings, { cli_auth_credentials_store: 'file' })
  if (!fast) delete config.service_tier
  if (reasoning === null) delete config.model_reasoning_effort
  if (config.profile && config.profiles?.[config.profile]) {
    Object.assign(config.profiles[config.profile], settings)
    if (!fast) delete config.profiles[config.profile].service_tier
    if (reasoning === null) delete config.profiles[config.profile].model_reasoning_effort
  }
  config.model_providers ||= {}
  config.model_providers[PROVIDER_ID] = providerConfig(origin)
  return stringify(config)
}

export async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function replaceFile(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  if (text === null) {
    await fs.rm(file, { force: true })
    return
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function writeTransaction(entries, write = replaceFile) {
  const originals = await Promise.all(entries.map(async ([file]) => [file, await readOptional(file)]))
  let written = 0
  try {
    for (const [file, text] of entries) {
      await write(file, text)
      written += 1
    }
  } catch (error) {
    try {
      for (const [file, text] of originals.slice(0, written).reverse()) {
        await replaceFile(file, text)
      }
    } catch (rollbackError) {
      throw new ConfigRecoveryError('本地配置写入失败，自动恢复未完成，请运行恢复操作。', {
        cause: new AggregateError([error, rollbackError]),
      })
    }
    throw error
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Date.prototype
}

// Revert only our changes; later edits made by the user take precedence.
export function restoreOwned(original, applied, current) {
  if (isDeepStrictEqual(original, applied)) return current
  if (isDeepStrictEqual(current, applied)) return original
  if (!isObject(applied) || !isObject(current)) return current
  const result = { ...current }
  for (const key of new Set([...Object.keys(original || {}), ...Object.keys(applied)])) {
    const value = restoreOwned(original?.[key], applied[key], current[key])
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  return result
}

export async function configureCodex({
  files, state = {}, apiKey, origin = DEFAULT_ORIGIN, model, reasoning, fast = true, catalog, statePatch = {}, write,
}) {
  const configText = await readOptional(files.codexConfig)
  const authText = await readOptional(files.codexAuth)
  const catalogText = catalog === undefined ? null : JSON.stringify(catalog) + '\n'
  const catalogHash = catalogText === null ? null : createHash('sha256').update(catalogText).digest('hex')
  const catalogPath = catalogHash === null ? undefined
    : path.join(files.pluginData, 'model-catalogs', `${catalogHash}.json`)
  const config = patchCodexConfig(configText, origin, model, reasoning, fast, catalogPath)
  const auth = JSON.parse(authText || '{}')
  if (!isObject(auth)) throw new Error('本地认证信息格式无效。')
  const installedAuth = JSON.stringify({ ...auth, auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2) + '\n'
  const backupRoot = path.join(files.pluginData, 'backups')
  const backups = state.backups || {
    config: path.join(backupRoot, 'config.original.toml'),
    auth: path.join(backupRoot, 'auth.original.json'),
    appliedConfig: path.join(backupRoot, 'config.applied.toml'),
    appliedAuth: path.join(backupRoot, 'auth.applied.json'),
    configExisted: configText !== null,
    authExisted: authText !== null,
  }
  if (!backups.appliedConfig || !backups.appliedAuth) {
    throw new Error('检测到旧版备份，请先使用旧版本恢复，再重新设置。')
  }
  if (state.backups) {
    for (const file of [backups.config, backups.auth,
      ...(state.configured ? [backups.appliedConfig, backups.appliedAuth] : [])]) {
      if (await readOptional(file) === null) throw new ConfigRecoveryError('本地备份不完整，已停止修改配置。')
    }
  }
  if (!state.backups) {
    await writeTransaction([
      [backups.config, configText ?? ''],
      [backups.auth, authText ?? '{}'],
      [files.state, JSON.stringify({ ...state, backups }, null, 2) + '\n'],
    ])
  }
  const next = { ...state, ...statePatch, configured: true, backups,
    ...(catalogPath ? { catalogPath, catalogHash,
      catalogFiles: [...new Set([...(state.catalogFiles || []), catalogPath])] } : {}) }
  await writeTransaction([
    ...(catalogText === null ? [] : [[catalogPath, catalogText]]),
    [files.codexConfig, config],
    [files.codexAuth, installedAuth],
    [backups.appliedConfig, config],
    [backups.appliedAuth, installedAuth],
    [files.state, JSON.stringify(next, null, 2) + '\n'],
  ], write)
  return next
}

export async function restoreCodex(files, state) {
  const backups = state.backups
  if (!backups?.appliedConfig || !backups?.appliedAuth) {
    throw new Error('本地备份不完整，未改动当前配置。')
  }
  const entries = []
  for (const [target, originalFile, appliedFile, existed, decode, encode] of [
    [files.codexConfig, backups.config, backups.appliedConfig, backups.configExisted, parse, stringify],
    [files.codexAuth, backups.auth, backups.appliedAuth, backups.authExisted, JSON.parse, (v) => JSON.stringify(v, null, 2) + '\n'],
  ]) {
    const [originalText, appliedText, currentText] = await Promise.all(
      [originalFile, appliedFile, target].map(readOptional),
    )
    if (originalText === null) throw new Error('原始备份缺失，未改动当前配置。')
    if (appliedText === null) {
      if (state.configured) throw new Error('应用快照缺失，未改动当前配置。')
      continue
    }
    if (currentText === null) continue
    const original = decode(originalText)
    const applied = decode(appliedText)
    const current = decode(currentText)
    const restored = restoreOwned(original, applied, current)
    let text = encode(restored)
    if (isDeepStrictEqual(restored, original)) text = existed ? originalText : null
    entries.push([target, text])
  }
  entries.push([files.state, null], [files.session, null])
  await writeTransaction(entries)
  // Backups contain previous credentials and are no longer needed after a successful restore.
  for (const file of [backups.config, backups.auth, backups.appliedConfig, backups.appliedAuth]) {
    await fs.rm(file, { force: true })
  }
  const catalogRoot = path.resolve(files.pluginData, 'model-catalogs')
  for (const file of state.catalogFiles || []) {
    if (path.dirname(path.resolve(file)) === catalogRoot && /^[a-f0-9]{64}\.json$/.test(path.basename(file))) {
      const text = await readOptional(file)
      if (text !== null && createHash('sha256').update(text).digest('hex') === path.basename(file, '.json')) {
        await fs.rm(file, { force: true })
      }
    }
  }
}

// Match the relay's text-model Fast policy; group permission is checked separately.
const FAST_MODEL = /^(gpt-(4o|4\.1)(-mini)?|gpt-5(\.[0-9]+)?(-mini|-codex|-codex-mini|-codex-max|-sol|-terra|-luna)?|gpt-6(\.[0-9]+)?(-sol|-astra|-luna)?|o3(-mini)?|o4-mini)(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/
const VERIFIED_REASONING_MODELS = new Set([
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol',
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-reserve',
])
const VERIFIED_REASONING_LEVELS = [
  ['low', 'Fast responses with lighter reasoning'],
  ['medium', 'Balances speed and reasoning depth for everyday tasks'],
  ['high', 'Greater reasoning depth for complex problems'],
  ['xhigh', 'Extra high reasoning depth for complex problems'],
  ['max', 'Maximum reasoning depth'],
  ['ultra', 'Maximum reasoning with extended context'],
]

function verifiedReasoningMetadata(slug, existing) {
  if (!VERIFIED_REASONING_MODELS.has(slug)) return existing
  const levels = new Map((existing?.supported_reasoning_levels || [])
    .filter((level) => level && typeof level.effort === 'string')
    .map((level) => [level.effort, level]))
  for (const [effort, description] of VERIFIED_REASONING_LEVELS) {
    if (!levels.has(effort)) levels.set(effort, { effort, description })
  }
  return {
    ...existing,
    default_reasoning_level: existing?.default_reasoning_level || 'medium',
    supported_reasoning_levels: VERIFIED_REASONING_LEVELS.map(([effort]) => levels.get(effort)),
  }
}

export function makeModelCatalog(models, known = [], { fast = false } = {}) {
  const metadata = new Map()
  for (const model of known) {
    metadata.set(model.slug, { ...metadata.get(model.slug), ...model })
  }
  return { models: models
    .filter((id) => !/(?:^|[-_.])(?:image|imagen|audio|tts|video|embedding|rerank)(?:$|[-_.])/i.test(id))
    .map((slug, index) => {
      const existing = verifiedReasoningMetadata(slug, metadata.get(slug))
      const supportsFast = fast && FAST_MODEL.test(slug)
      return {
        default_reasoning_level: 'none', supported_reasoning_levels: [],
        shell_type: 'shell_command', additional_speed_tiers: [], availability_nux: null, upgrade: null,
        base_instructions: 'You are a coding assistant. Follow the user instructions and use the available tools to complete the task.',
        supports_reasoning_summaries: false, default_reasoning_summary: 'none',
        support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform',
        web_search_tool_type: 'text_and_image', truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: false, supports_image_detail_original: false,
        context_window: null, max_context_window: null, effective_context_window_percent: 100,
        experimental_supported_tools: [], supports_search_tool: false,
        auto_compact_token_limit: null, use_responses_lite: false, service_tiers: [],
        ...existing,
        slug, display_name: existing?.display_name || slug, description: existing?.description || slug,
        visibility: 'list', supported_in_api: true, priority: index,
        service_tiers: supportsFast ? [
          { id: 'priority', name: 'Fast', description: 'Priority processing, 1.5x usage' },
        ] : [],
        additional_speed_tiers: supportsFast ? ['fast'] : [],
        default_service_tier: supportsFast ? 'priority' : null,
      }
    }) }
}
