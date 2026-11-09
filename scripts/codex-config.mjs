import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
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

export function imagegenPaths(files) {
  return {
    config: path.join(files.pluginData, 'imagegen.json'),
    snapshot: path.join(files.pluginData, 'imagegen-skill.json'),
    instructions: path.join(files.pluginData, 'imagegen-instructions.json'),
    skill: path.join(path.dirname(files.codexConfig), 'skills', '.system', 'imagegen', 'SKILL.md'),
  }
}

function imagegenSkill(files) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`
  const node = quote(process.execPath)
  const entry = quote(fileURLToPath(new URL('./yisama.mjs', import.meta.url)))
  const data = quote(files.pluginData)
  const home = quote(path.dirname(files.codexConfig))
  return `---
name: imagegen
description: Generate or edit images and query the signed-in user's available image models through yisama Infinite Assistant. Use for image requests, image model selection, defaults, and questions like 有哪些生图模型.
---

# Image Generation

<!-- yisama-managed-imagegen:v1 -->

This system imagegen skill is managed by the installed yisama Infinite Assistant.
Use its bundled runtime below, not the built-in image tool or another image skill.
It uses the assistant's dedicated image configuration, not Codex's active chat provider.
Never read or print authentication files, keys, sessions, or response URLs in chat.
If not signed in, ask the user to sign in through the assistant sidebar.
Never silently switch providers or models, or fall back to the official image tool.

## Run

Use these absolute paths in PowerShell; Python and additional packages are not needed:

\`\`\`powershell
$env:PLUGIN_DATA = ${data}
$env:CODEX_HOME = ${home}
& ${node} ${entry} image generate --prompt "..." --out "output/imagegen/result.png"
& ${node} ${entry} image edit --image "input.png" --prompt "..." --out "output/imagegen/edited.png"
& ${node} ${entry} image models
\`\`\`

The requested model is passed exactly as \`--model <id>\`; otherwise use the saved
image default (\`gpt-image-2\` initially; this is not an availability guarantee).
Never derive it from the dialogue model.
Changing the default requires an explicit user request:
\`image model --name <id>\`.

## Model Discovery

Questions like "有哪些生图模型？", "你能用什么模型画图？", or "默认用哪个？"
mean this signed-in Infinite Assistant account, unless the user explicitly asks
for an official provider catalogue or comparison. Run \`image models\` before
answering, even when the user does not name this skill. Do not answer from this
file's initial default, web searches, an official model catalogue, or memory.

On success, briefly list the returned IDs and the default only if the command
confirms it is available. Say that the user can specify a model. Do not invent
quality, speed, price, editing support, or retirement dates from model names.
If the saved default is unavailable, say so and ask the user to choose from the
returned models; do not silently select a replacement.
On failure, give the short actionable reason in the user's language, such as
signing in, requesting image access, or trying the query later. Do not replace
a failed query with a catalogue from another source.

Keep implementation details out of ordinary replies: credentials, groups,
API protocols, capability metadata, and "official models may not work on your
relay" caveats are not a model-selection answer. Explain them only when asked
or needed to resolve the reported problem. A successful answer can be as short as:
"你当前可用的生图模型：<返回的模型>。默认使用 <已确认可用的默认模型>，也可以指定模型。"

The command intersects the account's authorized models with the station's
\`image-generation\` capability metadata for the Images API. It does not generate
images or incur image-generation charges. Listed models are generation routes,
not a promise that all of them support editing or every optional parameter.

The assistant prepares a separate image credential for the signed-in account and
this device in the \`images\` group. It never reuses the chat credential, an
administrator credential, or another user's quota. Actual generation is charged
to the calling account according to station billing.

## Workflow

1. Understand the subject, intended use, composition, style, lighting, exact text,
   and invariants. Preserve the user's requirements in the prompt.
2. For input images, inspect them first. Use \`edit\` with repeated \`--image\` flags
   for references or edits, and explain each image's role in the prompt.
   A reference image is not necessarily an edit target. Use \`--mask\` if supplied.
3. Use \`generate\` for new images and \`edit\` for image inputs. For distinct assets,
   run separate commands; \`--n\` requests variants of one prompt.
4. Pass only requested controls: \`--size WIDTHxHEIGHT|auto\`,
   \`--quality low|medium|high|auto\`, \`--background transparent|opaque|auto\`,
   \`--output-format png|jpeg|webp\`, \`--output-compression 0..100\`,
   \`--input-fidelity high|low\` (edits only), \`--prompt-file <UTF-8-file>\`.
   \`--dry-run\` does not send requests and does not prove a model works.
5. Save finals under \`output/imagegen/\` or the user's chosen destination.
   Never overwrite without permission (\`--force\`). Do not alter this skill for
   an ordinary image request. Normal generation may incur station usage.
6. Inspect every result. Verify content, exact text, actual size, alpha, and edit
   invariants. Do not claim requested dimensions were delivered unless checked.
   A model name alone does not prove a provider's underlying model identity.
7. Show the saved image inline with its absolute path and report the selected model.

Generation uses \`/v1/images/generations\`; editing additionally requires a
compatible \`/v1/images/edits\` endpoint. Do not silently translate protocols.
For \`gpt-image-2\`, do not request transparent backgrounds or input fidelity.
Do not generate images solely to test installation without explicit approval.
`
}

const IMAGE_RULE_START = '<!-- yisama-image-routing:begin -->'
const IMAGE_RULE_END = '<!-- yisama-image-routing:end -->'

function imagegenInstructions(files) {
  const skill = imagegenPaths(files).skill
  return `${IMAGE_RULE_START}
## Image Requests

For image generation, editing, or questions about available image models, use
the system $imagegen skill at "${skill}", including when the user does not name
the skill. Unless the user explicitly asks for an official provider catalogue,
image-model questions mean the signed-in Infinite Assistant account. Run its
"image models" command before answering and report only the returned model IDs
and a confirmed available default. Never substitute web searches, an official
catalogue, the dialogue model list, or remembered IDs, including after a failed
query. Do not infer model strengths or prices from names. Keep ordinary replies
brief and user-facing; on failure, state the actionable reason without internal
group, credential, or API terminology.
Use the signed-in user's yisama image route; do not inspect credentials or
silently fall back to another provider. Discovery is not a paid generation.
${IMAGE_RULE_END}
`
}

async function imagegenInstructionEntries(files, uninstall = false) {
  const locations = imagegenPaths(files)
  const home = path.dirname(files.codexConfig)
  const targets = ['AGENTS.md', 'AGENTS.override.md'].map((name) => path.join(home, name))
  const text = await readOptional(locations.instructions)
  const snapshots = text === null ? [] : JSON.parse(text).files
  if (!Array.isArray(snapshots) || snapshots.some((item) => !targets.includes(item.target)) ||
      new Set(snapshots.map((item) => item.target)).size !== snapshots.length) {
    throw new ConfigRecoveryError('全局生图规则备份无效，未修改个人规则。')
  }
  const entries = []
  const next = []
  for (const target of targets) {
    const current = await readOptional(target)
    const saved = snapshots.find((item) => item.target === target)
    if (uninstall && !saved) {
      if (current?.includes(IMAGE_RULE_START) || current?.includes(IMAGE_RULE_END)) {
        throw new ConfigRecoveryError('全局生图规则备份缺失，卸载已停止，未修改个人规则。')
      }
      continue
    }
    let original = current
    if (saved) {
      if (typeof saved.block !== 'string' || !saved.block.includes(IMAGE_RULE_START)) {
        throw new ConfigRecoveryError('全局生图规则备份无效，未修改个人规则。')
      }
      if (current === saved.applied) original = saved.original
      else if (current?.includes(saved.block)) original = current.replace(saved.block, '')
    }
    if (original?.includes(IMAGE_RULE_START) || original?.includes(IMAGE_RULE_END)) {
      throw new ConfigRecoveryError('全局生图规则有后续修改，已保留，请先确认再安装或卸载。')
    }
    if (uninstall) {
      if (original !== current) entries.push([target, original])
      continue
    }
    // A nonempty global override takes precedence; cover it without creating a new override.
    if (target === targets[1] && !current?.trim()) continue
    const block = (original?.length ? (original.endsWith('\n') ? '\n' : '\n\n') : '') +
      imagegenInstructions(files)
    const applied = (original || '') + block
    next.push({ target, original, applied, block })
    if (current !== applied) entries.push([target, applied])
  }
  entries.push([locations.instructions, uninstall ? null : JSON.stringify({ files: next }, null, 2) + '\n'])
  return entries
}

export async function installImagegen(files, { initialize, write } = {}) {
  const locations = imagegenPaths(files)
  let current = await readOptional(locations.skill)
  const snapshotText = await readOptional(locations.snapshot)
  const snapshot = snapshotText === null ? null : JSON.parse(snapshotText)
  if (snapshot && (snapshot.target !== locations.skill ||
      (current !== null && current !== snapshot.applied))) {
    throw new ConfigRecoveryError('系统 imagegen 有后续修改，已保留，请先确认后再重新安装生图配置。')
  }
  if (initialize) {
    await initialize()
    current = await readOptional(locations.skill)
  }
  const applied = imagegenSkill(files)
  const entries = []
  if (current !== applied || !snapshot) {
    entries.push([locations.snapshot, JSON.stringify({
      target: locations.skill,
      original: snapshot && current === snapshot.applied ? snapshot.original : current, applied,
    }, null, 2) + '\n'], [locations.skill, applied])
  }
  entries.push(...await imagegenInstructionEntries(files))
  await writeTransaction(entries, write)
}

export async function uninstallImagegen(files) {
  const locations = imagegenPaths(files)
  const snapshotText = await readOptional(locations.snapshot)
  const entries = [[locations.config, null]]
  if (snapshotText !== null) {
    const snapshot = JSON.parse(snapshotText)
    if (snapshot.target !== locations.skill) throw new ConfigRecoveryError('生图备份位置不匹配，未删除备份。')
    const current = await readOptional(locations.skill)
    if (current === snapshot.applied || current === null) {
      entries.push([locations.skill, snapshot.original], [locations.snapshot, null])
    } else {
      throw new ConfigRecoveryError('系统 imagegen 有后续修改，卸载已停止，原始生图备份已保留。')
    }
  }
  entries.push(...await imagegenInstructionEntries(files, true))
  await writeTransaction(entries)
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
  // A first Codex launch replaces uninitialized system skills; the installer primes them first.
  const systemMarker = path.join(path.dirname(files.codexConfig), 'skills', '.system', '.codex-system-skills.marker')
  if (await readOptional(systemMarker) !== null) await installImagegen(files)
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
  entries.push([imagegenPaths(files).config, null], [files.state, null], [files.session, null])
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
