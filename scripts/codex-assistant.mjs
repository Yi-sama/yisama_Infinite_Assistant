import fs from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { handleRequest, validateRequest } from './desktop-bridge.mjs'
import { makeAssistantScript, REMOVE_ASSISTANT_SCRIPT } from './codex-panel.mjs'
import { UserError, safeError, publicErrorCode, desktopNativeConfiguration, desktopNativeSynced, requestApi } from './yisama.mjs'

export const CODEX_PAGE = 'app://-/index.html'
const BINDING = 'yisamaAssistantCommand'
const ASSISTANT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const UPDATE_FILE = path.join(ASSISTANT_ROOT, 'update.json')
const NATIVE_FAST_ASSET = 'app://-/assets/app-initial-*.js'
const NATIVE_FAST_ASSET_URL = /^app:\/\/-\/assets\/app-initial-[0-9a-f]+\.js$/
const NATIVE_I18N_ASSET = 'app://-/assets/initialize-app-host-services-*.js'
const NATIVE_I18N_ASSET_URL = /^app:\/\/-\/assets\/initialize-app-host-services-[0-9a-f]+\.js$/
const NATIVE_RUNTIME_ASSET = 'app://-/assets/renderer-app-server-managers-*.js'
const NATIVE_RUNTIME_ASSET_URL = /^app:\/\/-\/assets\/renderer-app-server-managers-[0-9a-f]+\.js$/
const NATIVE_HOST_ASSET = 'app://-/assets/app-shared-*.js'
const NATIVE_HOST_ASSET_URL = /^app:\/\/-\/assets\/app-shared-[0-9a-f]+\.js$/
const NATIVE_CHUNK_ASSET = 'app://-/assets/async/*.js'
const NATIVE_CHUNK_ASSET_URL = /^app:\/\/-\/assets\/async\/\d+\.[0-9a-f]+\.js$/

// Codex ships its full translations but only uses them once a remote experiment
// (unreachable from mainland China) allows it. Allow them locally; the user's
// language setting still decides which one is shown. Unknown builds load unchanged.
export function adaptNativeI18nSource(source) {
  const gate = /(\.get\((?:`enable_i18n`|"enable_i18n"),)!1\)/g
  const matches = [...source.matchAll(gate)]
  const patched = matches.length === 1 ? source.replace(gate, '$1!0)||!0') : source
  return patched + '\nwindow.__yisamaNativeI18nSourceReady=true;\n'
}

// Browser control, the in-app browser and Computer Use are also held back by remote
// experiments that never load from mainland China. Codex's own settings and the
// organization requirements still decide whether each feature may run.
const NATIVE_FEATURE_GATES = ['410065390', '410262010', '1506311413']

export function adaptNativeGateSource(source) {
  let patched = source
  for (const gate of NATIVE_FEATURE_GATES) {
    const call = new RegExp(String.raw`([\w$]+|\(0,[\w$]+\.[\w$]+\))\(["\x60]${gate}["\x60]\)`, 'g')
    if ([...patched.matchAll(call)].length === 1) patched = patched.replace(call, '$1(!0)')
  }
  return patched + '\nwindow.__yisamaNativeGatesSourceReady=true;\n'
}

// Branching a chat waits for the permission-refresh experiment. Without remote
// assignments it stayed "loading" forever; use the value Codex itself uses when
// its experiments load without one.
export function adaptNativeRuntimeSource(source) {
  const pending = /(\.values\.permissionRefresh\?\?)null/g
  const matches = [...source.matchAll(pending)]
  let patched = matches.length === 1 ? source.replace(pending, '$1!1') : source
  const chunkPlacement = /read:([\w$]+)=>null!=([\w$]+)&&\2\.get\("sidebarCustomSectionsEnabled"===\1\?[\w$.]+:[\w$.]+\)/g
  if ([...patched.matchAll(chunkPlacement)].length === 1) {
    patched = patched.replace(chunkPlacement, (match) => match.replace('=>', '=>(') + ')??!1')
  }
  return patched + '\nwindow.__yisamaNativeRuntimeSourceReady=true;\n'
}

// Serialized into the renderer. Codex's desktop process returns no execution assignments
// when its experiment client cannot reach OpenAI, and branching, scheduled work and
// project setup then wait forever. After a short grace period, answer with the same
// all-off assignments Codex itself uses when experiments load without values.
export function installHostFallback(host) {
  const evaluations = host?.statsigEvaluations
  if (!evaluations || evaluations.__yisamaFallback) return host
  const startedAt = Date.now()
  const late = () => Date.now() - startedAt > 10000
  const defaults = () => ({
    identity: { userId: null, accountId: null, authMethod: null, stableId: null },
    values: { experimentalFeatureGates: {}, toolCatalog: { restrictedGates: {}, gates: {}, configs: {} },
      permissionRefresh: false, personality: {}, instructions: {} },
    defaultEnableFeatures: {},
  })
  const wrapped = new Proxy(evaluations, {
    get(target, key) {
      if (key === '__yisamaFallback') return true
      if (key === 'readExecutionAssignments') {
        return async (...args) => (await target.readExecutionAssignments(...args)) ?? (late() ? defaults() : null)
      }
      if (key === 'hasReadyExecutionAssignments') {
        return async (...args) => (await target.hasReadyExecutionAssignments(...args)) || late()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  try {
    host.statsigEvaluations = wrapped
    if (host.statsigEvaluations === wrapped) return host
  } catch {}
  // A frozen host cannot be changed or proxied directly; forward through an empty target instead.
  return new Proxy({}, {
    get: (_target, key) => key === 'statsigEvaluations' ? wrapped : Reflect.get(host, key, host),
    has: (_target, key) => key in host,
  })
}

// The host services object is the module value read with ?.performanceTelemetry; wrap it where it is stored.
export function adaptNativeHostSource(source) {
  const chunkSetter = /setAppServices:function\(([\w$]+)\)\{([\w$]+)=\1\}/g
  if ([...source.matchAll(chunkSetter)].length === 1) {
    return source.replace(chunkSetter, (_match, argument, name) =>
      `setAppServices:function(${argument}){${name}=(${installHostFallback.toString()})(${argument})}`) +
      '\nwindow.__yisamaNativeHostSourceReady=true;\n'
  }
  const names = new Set([...source.matchAll(/([\w$]+)\?\.performanceTelemetry/g)].map((match) => match[1]))
  let patched = source
  if (names.size === 1) {
    const [name] = names
    const escaped = name.replace(/\$/g, '\\$')
    const setter = new RegExp(String.raw`function ([\w$]+)\(e\)\{${escaped}=e\}`, 'g')
    if ([...source.matchAll(setter)].length === 1) {
      patched = source.replace(setter, (_match, fn) =>
        `function ${fn}(e){${name}=(${installHostFallback.toString()})(e)}`)
    }
  }
  return patched + '\nwindow.__yisamaNativeHostSourceReady=true;\n'
}

// Codex's minified names change between builds, so each hook is found by its code shape
// and must match exactly once. Neither UI markup nor authentication is replaced.
function uniqueMatch(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))]
  if (matches.length !== 1) throw new ConnectionError(`This Codex build does not support the native Fast adapter (${label}).`)
  return matches[0]
}

function enclosingFunction(source, index) {
  return source.slice(source.lastIndexOf('function', index), index)
}

function lastCapture(text, pattern, label) {
  const match = [...text.matchAll(new RegExp(pattern.source, 'g'))].at(-1)
  if (!match) throw new ConnectionError(`This Codex build does not support the native Fast adapter (${label}).`)
  return match
}

function nativeFastEdits(source) {
  const n = String.raw`[\w$]+`
  const access = uniqueMatch(source, new RegExp(
    String.raw`let (${n})=(${n})(?:,(${n}))?;return (${n}\[\d+\])!==(${n})\|\|(${n}\[\d+\])!==\1\?\((${n})=\{serviceTierAccess:\1,isLoading:\5\}`), 'access')
  if (access[3] && access[3] !== access[7]) {
    throw new ConnectionError('This Codex build does not support the native Fast adapter (access).')
  }
  const [, accessMethod, accessHost] = lastCapture(enclosingFunction(source, access.index),
    new RegExp(String.raw`\{authMethod:(${n}),hostId:(${n})\}`), 'access auth')

  const setter = uniqueMatch(source, new RegExp(
    String.raw`serviceTierAccess:(${n}),serviceTierSettings:(${n}),setServiceTier:(${n})\}`), 'setter')
  const setterScope = enclosingFunction(source, setter.index)
  const [, setterHost] = uniqueMatch(setterScope, new RegExp(String.raw`\{hostId:(${n}),conversationId:${n}\}`), 'setter host')
  const [, setterMethod] = uniqueMatch(setterScope, new RegExp(String.raw`\{authMethod:(${n}),hostId:${n}\}`), 'setter auth')

  return [
    [access, `let ${access[1]}=window.__yisamaNativeFast?.access(${accessHost},${accessMethod})??${access[2]}` +
      access[0].slice(`let ${access[1]}=${access[2]}`.length)],
    [setter, `serviceTierAccess:${setter[1]},serviceTierSettings:${setter[2]},` +
      `setServiceTier:window.__yisamaNativeFast?.wrap(${setterHost},${setterMethod},${setter[3]})??${setter[3]}}`],
  ]
}

function nativeReasoningEdit(source) {
  const n = String.raw`[\w$]+`
  const select = uniqueMatch(source, new RegExp(
    String.raw`select:(?<head>\(\{data:${n}(?:,isTeamCatalog:(?<team>${n})=!1)?\}\)=>)(?<spread>\(\{\.\.\.)?(?<transform>${n}|\(0,${n}\.${n}\))\((?<options>\{additionalAvailableModels:new Set\(${n}\),apiKeyDaybreakSupported:[^{}]*?useHiddenModels:[\w$.]+\})\)(?<tail>,isTeamCatalog:\k<team>\}\))?`), 'models')
  const { head, team, spread, transform, options, tail } = select.groups
  if (Boolean(team) !== Boolean(spread) || Boolean(team) !== Boolean(tail)) {
    throw new ConnectionError('This Codex build does not support the native Fast adapter (models).')
  }
  const query = lastCapture(source.slice(Math.max(0, select.index - 4000), select.index),
    /\(\{additionalAvailableModels:[^{}]*?\}/, 'models query')[0]
  const field = (name) => new RegExp(String.raw`[{,]${name}:(${n})(?:=![01])?[,}]`).exec(query)?.[1]
  const [selectHost, selectMethod, selectUltra] = [field('hostId'), field('authMethod'), field('includeUltraReasoningEffort')]
  if (!selectHost || !selectMethod || !selectUltra) {
    throw new ConnectionError('This Codex build does not support the native Fast adapter (models query).')
  }

  // Capture query arguments before the isTeamCatalog parameter shadows hostId.
  return [select, `select:((yisamaHost,yisamaMethod,yisamaUltra)=>${head}{` +
      `const yisamaOptions=${options};return ${spread || ''}${transform}(` +
      `window.__yisamaNativeFast?.modelOptions(yisamaHost,yisamaMethod,yisamaOptions,yisamaUltra)??yisamaOptions)` +
      `${tail || ''}})(${selectHost},${selectMethod},${selectUltra})`]
}

function applyNativeEdits(source, edits) {
  let patched = source
  for (const [match, replacement] of edits.sort((a, b) => b[0].index - a[0].index)) {
    patched = patched.slice(0, match.index) + replacement + patched.slice(match.index + match[0].length)
  }
  return patched
}

export function adaptNativeFastSource(source) {
  return applyNativeEdits(source, [...nativeFastEdits(source), nativeReasoningEdit(source)]) +
    '\nwindow.__yisamaNativeFastSourceReady=true;window.__yisamaNativeReasoningSourceReady=true;\n'
}

// Rspack splits these hooks into independent ESM chunks. Ignore unrelated chunks.
export function adaptNativeChunkSource(source) {
  let patched = source
  if (source.includes('setAppServices:function(')) patched = adaptNativeHostSource(patched)
  if (source.includes('"enable_i18n"')) patched = adaptNativeI18nSource(patched)
  if (NATIVE_FEATURE_GATES.some((gate) => source.includes(`"${gate}"`))) patched = adaptNativeGateSource(patched)
  if (source.includes('.values.permissionRefresh??null')) patched = adaptNativeRuntimeSource(patched)
  if (source.includes('hasManagedNewThreadSettings:') && source.includes('setServiceTier:')) {
    patched = applyNativeEdits(patched, nativeFastEdits(patched)) +
      '\nwindow.__yisamaNativeFastSourceReady=true;\n'
  }
  if (source.includes('select:({data:') && source.includes('additionalAvailableModels:new Set(')) {
    patched = applyNativeEdits(patched, [nativeReasoningEdit(patched)]) +
      '\nwindow.__yisamaNativeReasoningSourceReady=true;\n'
  }
  return patched
}

// A late helper attachment may miss the initial assets. Only a fresh desktop
// launch, before any user interaction, may automatically load them once.
export function installNativeStartup(startedAt, options = {}) {
  if (window !== window.top || (location.href !== 'app://-/index.html' && options.allowTestLocation !== true) ||
    window.__yisamaNativeStartup) return
  const started = Date.parse(startedAt)
  const deadline = started + 30000
  let eligible = Number.isFinite(started) && Date.now() >= started && Date.now() < deadline &&
    window.performance?.getEntriesByType('navigation')[0]?.type === 'navigate'
  const events = ['pointerdown', 'keydown', 'input']
  let timer
  const cancel = () => {
    eligible = false
    window.clearTimeout(timer)
    for (const event of events) window.removeEventListener(event, cancel, true)
  }
  window.__yisamaNativeStartup = {
    pending: () => eligible && Date.now() < deadline,
    cancel,
  }
  if (eligible) {
    for (const event of events) window.addEventListener(event, cancel, true)
    timer = window.setTimeout(cancel, deadline - Date.now())
  }
}

// Serialized into the renderer. The existing native setter still owns UI and persistence.
export function installNativeFast() {
  if (window !== window.top || location.href !== 'app://-/index.html') return
  window.__yisamaNativeFast?.dispose()
  let authorization = null
  let busy = false
  let disposed = false
  const access = { fast: true, ultrafast: false }
  const wrappers = new WeakMap()
  const pending = new Map()
  const nativeAuth = () => new Promise((resolve, reject) => {
    const id = `yisama-fast-auth-${crypto.randomUUID()}`
    const finish = (callback, value) => {
      window.clearTimeout(timer)
      window.removeEventListener('message', receive)
      callback(value)
    }
    const receive = (event) => {
      const data = event.data
      if (data?.type !== 'mcp-response' || data.hostId !== 'local' || data.message?.id !== id) return
      if (data.message.error) finish(reject, new Error('Native authentication failed.'))
      else finish(resolve, data.message.result)
    }
    const timer = window.setTimeout(() => finish(reject, new Error('Native authentication timed out.')), 8000)
    window.addEventListener('message', receive)
    window.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local',
      request: { id, method: 'getAuthStatus', params: { includeToken: true, refreshToken: false } },
      priority: 'critical',
    }).catch(() => finish(reject, new Error('Native authentication failed.')))
  })
  const send = (enabled, keyFingerprint) => new Promise((resolve, reject) => {
    const id = 1e12 + crypto.getRandomValues(new Uint32Array(1))[0]
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error('Fast setting timed out.'))
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    try { window.yisamaAssistantCommand(JSON.stringify({ id, action: 'fast', enabled, keyFingerprint })) }
    catch (error) { window.clearTimeout(timer); pending.delete(id); reject(error) }
  })
  const controller = {
    authorize(settings) { authorization = settings ? { ...settings } : null },
    needsReload() {
      const catalogReasoning = authorization?.provider === 'yisama' &&
        Object.values(authorization.modelSettings || {}).some((model) =>
          model.reasoningEfforts?.length)
      // Only Chinese users need a reload for the translation switch.
      const chinese = /^zh(-|$)/i.test(globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '')
      return !disposed && ((chinese && (window.__yisamaNativeI18nSourceReady !== true ||
        window.__yisamaNativeGatesSourceReady !== true ||
        window.__yisamaNativeRuntimeSourceReady !== true ||
        window.__yisamaNativeHostSourceReady !== true)) ||
        (authorization?.fastAvailable === true && window.__yisamaNativeFastSourceReady !== true) ||
        (catalogReasoning && window.__yisamaNativeReasoningSourceReady !== true))
    },
    access(host, method) {
      return !disposed && window.__yisamaNativeFastSourceReady && authorization?.fastAvailable === true &&
        host === 'local' && method === 'apikey' ? access : null
    },
    modelOptions(host, method, options, includeUltra = true) {
      if (disposed || !window.__yisamaNativeReasoningSourceReady || authorization?.provider !== 'yisama' ||
        host !== 'local' || method !== 'apikey') return options
      const enabled = new Set(options.enabledReasoningEfforts)
      const models = options.models.map((model) => {
        const settings = authorization.modelSettings?.[model.model]
        const supported = [...new Set([
          ...(model.supportedReasoningEfforts || []).map(({ reasoningEffort }) => reasoningEffort),
          ...(settings?.reasoningEfforts || []),
        ].filter(Boolean))]
        const known = new Set((model.supportedReasoningEfforts || []).map(({ reasoningEffort }) => reasoningEffort))
        const additions = supported.filter((reasoningEffort) => !known.has(reasoningEffort)).map((reasoningEffort) => ({
          reasoningEffort,
          description: settings.reasoningDescriptions?.[reasoningEffort] || `${reasoningEffort} effort`,
        }))
        return additions.length ? {
          ...model,
          supportedReasoningEfforts: [...(model.supportedReasoningEfforts || []), ...additions],
        } : model
      })
      let ultra = false
      for (const model of models) {
        const supported = [...new Set([
          ...(model.supportedReasoningEfforts || []).map(({ reasoningEffort }) => reasoningEffort),
          ...(authorization.modelSettings?.[model.model]?.reasoningEfforts || []),
        ].filter(Boolean))]
        for (const reasoningEffort of supported) {
          enabled.add(reasoningEffort)
          if (reasoningEffort === 'ultra' && includeUltra) ultra = true
        }
      }
      return { ...options, models, enabledReasoningEfforts: enabled,
        includeUltraReasoningEffort: options.includeUltraReasoningEffort || ultra }
    },
    isBusy() { return busy },
    wrap(host, method, nativeSet) {
      if (host !== 'local' || method !== 'apikey') return nativeSet
      if (wrappers.has(nativeSet)) return wrappers.get(nativeSet)
      const wrapped = async (tier, source) => {
        if (!controller.access(host, method)) return nativeSet(tier, source)
        if (busy || (tier !== null && tier !== 'priority')) return false
        const own = authorization
        const previousEnabled = own.fastEnabled === true
        const enabled = tier === 'priority'
        busy = true
        let nativeChanged = false
        const setLocalFast = (value) => {
          own.fastEnabled = value
          if (authorization?.apiKey === own.apiKey) authorization.fastEnabled = value
        }
        const rollbackNative = async () => {
          if (!nativeChanged) return
          try {
            await nativeSet(previousEnabled ? 'priority' : null, 'yisama_fast_rollback')
            setLocalFast(previousEnabled)
          } catch { authorization = null }
        }
        let nativeResult
        try {
          // Start the native setter now, but do not make the picker await its persistence.
          nativeResult = nativeSet(tier, source)
          if (nativeResult === false) throw new Error('Native Fast setting failed.')
          nativeChanged = true
          setLocalFast(enabled)
        } catch {
          busy = false
          window.__yisamaInfiniteAssistant?.nativeStatus?.('error')
          return false
        }
        void (async () => {
          let changed = false
          let fingerprint
          try {
            if (await nativeResult !== true) throw new Error('Native Fast setting failed.')
            const auth = await nativeAuth()
            if (auth.authMethod !== 'apikey' || auth.authToken !== own.apiKey ||
              authorization?.apiKey !== own.apiKey || disposed) {
              authorization = null
              throw new Error('Fast account changed.')
            }
            const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(own.apiKey))
            fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
            const response = await send(enabled, fingerprint)
            changed = response.enabled === enabled
            if (response.enabled !== enabled || authorization?.apiKey !== own.apiKey || disposed) {
              throw new Error('Fast account changed.')
            }
          } catch {
            if (changed) {
              try {
                await send(previousEnabled, fingerprint)
              } catch { authorization = null }
            }
            await rollbackNative()
            window.__yisamaInfiniteAssistant?.nativeStatus?.('error')
          } finally { busy = false }
        })()
        return true
      }
      wrappers.set(nativeSet, wrapped)
      return wrapped
    },
    receive(response) {
      const entry = pending.get(response?.id)
      if (!entry) return
      pending.delete(response.id)
      window.clearTimeout(entry.timer)
      if (response.ok) entry.resolve(response.data)
      else entry.reject(new Error('The server did not confirm Fast.'))
    },
    dispose() {
      disposed = true
      authorization = null
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer)
        entry.reject(new Error('Fast adapter disconnected.'))
      }
      pending.clear()
    },
  }
  window.__yisamaNativeFast = controller
}

class ConnectionError extends Error {}
const connectionMessage = (error) => error instanceof ConnectionError ? error.message : safeError(error)

export async function codexStartedAt(processId, execute = promisify(execFile)) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(processId) || processId <= 0) return null
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${processId} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
  { windowsHide: true, timeout: 10000 })
  const timestamp = Date.parse(stdout.trim())
  if (!Number.isFinite(timestamp)) throw new ConnectionError('The Codex start time could not be determined.')
  return new Date(timestamp).toISOString()
}

export async function restartAssistant(args, spawnChild = spawn) {
  const child = spawnChild(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true, stdio: 'ignore', windowsHide: true,
  })
  await once(child, 'spawn')
  child.unref()
}

export async function restartCodex(spawnChild = spawn, { installer } = {}) {
  const launcher = fileURLToPath(new URL('./launch-codex.ps1', import.meta.url))
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', launcher, '-Supervise', '-Restart']
  if (installer) {
    if (!path.isAbsolute(installer.path) || !/^[a-f0-9]{64}$/.test(installer.sha256)) {
      throw new ConnectionError('Invalid prepared update installer.')
    }
    args.push('-UpdateInstaller', installer.path, '-UpdateSha256', installer.sha256)
  }
  const child = spawnChild(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args, {
      // PowerShell hands off outside Node's kill-on-exit job before closing Codex.
      detached: false, stdio: 'ignore', windowsHide: true,
    })
  await once(child, 'spawn')
  // Keep startup failures observable instead of assuming that spawn means success.
  const [code] = await once(child, 'close')
  if (code !== 0) throw new ConnectionError('Codex could not restart. Open Codex - yisama again.')
}

export function validateEndpoint(value) {
  if (!value || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    !Number.isSafeInteger(value.processId) || value.processId <= 0) {
    throw new ConnectionError('Invalid local Codex endpoint.')
  }
  return { port: value.port, processId: value.processId }
}

export function allowedTarget(target, port) {
  if (target?.type !== 'page' || target.url !== CODEX_PAGE) return false
  try {
    const url = new URL(target.webSocketDebuggerUrl)
    return url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      Number(url.port) === port && !url.username && !url.password &&
      !url.search && !url.hash && /^\/devtools\/page\/[^/]+$/.test(url.pathname)
  } catch {
    return false
  }
}

export async function discoverCodexTargets(port) {
  for (const host of ['127.0.0.1', '[::1]']) {
    let response
    try {
      response = await fetch(`http://${host}:${port}/json`, {
        signal: AbortSignal.timeout(2000), redirect: 'error',
      })
    } catch {
      continue
    }
    if (!response.ok) throw new ConnectionError('The local Codex connection was rejected.')
    const targets = await response.json()
    if (!Array.isArray(targets)) throw new ConnectionError('Invalid local Codex target list.')
    return targets.filter((target) => allowedTarget(target, port))
  }
  throw new ConnectionError('The local Codex connection is unavailable.')
}

function parseRequest(payload) {
  if (typeof payload !== 'string' || payload.length > 16 * 1024) return null
  try {
    return validateRequest(JSON.parse(payload))
  } catch {
    return null
  }
}

export function createRequestQueue(handler = handleRequest) {
  let queue = Promise.resolve()
  let pending = 0
  let quiesced = false
  const updateChecks = new Set()
  const deferred = []
  const run = (payload, client) => {
    const request = parseRequest(payload)
    if (!request) return Promise.resolve(null)
    pending++
    const result = (request.action === 'checkUpdate' ? Promise.resolve() : queue).then(async () => {
      try {
        return { id: request.id, ok: true, data: await handler(request, client) }
      } catch (error) {
        return { id: request.id, ok: false, error: safeError(error),
          ...(publicErrorCode(error) ? { code: publicErrorCode(error) } : {}) }
      }
    })
    const settled = result.then(() => { pending-- }, () => { pending-- })
    if (request.action === 'checkUpdate') {
      updateChecks.add(settled)
      settled.then(() => updateChecks.delete(settled))
    } else queue = settled
    return result
  }
  const request = (payload, client) => {
    if (!quiesced) return run(payload, client)
    return new Promise((resolve) => deferred.push(() => resolve(run(payload, client))))
  }
  request.isIdle = () => pending === 0 && deferred.length === 0
  request.drain = () => Promise.all([queue, ...updateChecks])
  request.quiesce = () => { quiesced = true }
  request.resume = () => {
    quiesced = false
    deferred.splice(0).forEach((next) => next())
  }
  return request
}

export function validateUpdateMarker(value) {
  if (!value || typeof value !== 'object' || !/^[0-9a-f]{64}$/.test(value.generation) ||
    typeof value.updatedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt))) return null
  return { generation: value.generation, updatedAt: value.updatedAt }
}

export async function readUpdateMarker(updateFile, readFile = fs.readFile) {
  try {
    return validateUpdateMarker(JSON.parse(await readFile(updateFile, 'utf8')))
  } catch {
    return null
  }
}

export function shouldReload(previousGeneration, marker) {
  return Boolean(marker && marker.generation !== previousGeneration)
}

// Serialized into the renderer; inspect activity without refreshing authentication.
export async function codexRestartBlocker() {
  if (window.top !== window || location.href !== 'app://-/index.html' ||
    !window.__yisamaInfiniteAssistant || !window.electronBridge?.sendMessageFromView) return 'unavailable'
  const hasDraft = () => {
    const state = window.__yisamaInfiniteAssistant.snapshot?.()
    return [...document.querySelectorAll(
      '[contenteditable=true],textarea,input:not([type]),input[type=text],input[type=password],input[type=email]',
    )].some((node) => {
      if (node.disabled || node.readOnly || node.closest?.('[hidden],[aria-hidden="true"]') ||
        (node.getClientRects && node.getClientRects().length === 0)) return false
      if (state?.loggedIn && node.closest?.('#yisama-infinite-assistant-ui [data-testid="logged-out"]')) return false
      return node.isContentEditable ? node.textContent.trim() : node.value?.trim()
    })
  }
  if (hasDraft()) return 'draft'
  if (window.__yisamaInfiniteAssistant.snapshot?.().setupPending ||
    window.__yisamaNativeFast?.isBusy()) return 'busy'
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `yisama-restart-${crypto.randomUUID()}`
    const finish = (callback, value) => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      callback(value)
    }
    const receive = (event) => {
      const data = event.data
      if (data?.type !== 'mcp-response' || data.hostId !== 'local' || data.message?.id !== id) return
      if (data.message.error) finish(reject, new Error('Restart activity check failed.'))
      else finish(resolve, data.message.result)
    }
    const timer = setTimeout(() => finish(reject, new Error('Restart activity check timed out.')), 8000)
    window.addEventListener('message', receive)
    Promise.resolve().then(() => window.electronBridge.sendMessageFromView({
      type: 'mcp-request', hostId: 'local', request: { id, method, params }, priority: 'critical',
    })).catch(() => finish(reject, new Error('Restart activity check failed.')))
  })
  try {
    let cursor = null
    do {
      const loaded = await rpc('thread/loaded/list', { cursor, limit: 100 })
      if (!Array.isArray(loaded?.data)) return 'unavailable'
      for (const threadId of loaded.data) {
        const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
        if (thread?.status?.type !== 'idle') return 'busy'
      }
      cursor = loaded.nextCursor
    } while (cursor)
    return hasDraft() ? 'draft' : null
  } catch {
    return 'unavailable'
  }
}

export class CdpConnection {
  constructor(url, onEvent = () => {}) {
    this.url = url
    this.onEvent = onEvent
    this.pending = new Map()
    this.nextId = 0
    this.socket = null
  }

  async connect() {
    const socket = this.socket = new WebSocket(this.url)
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error) pending.reject(new ConnectionError('Codex could not complete a local UI command.'))
        else pending.resolve(message.result || {})
      } else this.onEvent(message)
    })
    socket.addEventListener('close', () => this.rejectPending())
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close()
        reject(new ConnectionError('The local Codex connection timed out.'))
      }, 5000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new ConnectionError('The local Codex connection failed.'))
      }, { once: true })
    })
  }

  call(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new ConnectionError('Codex is disconnected.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new ConnectionError('A local Codex UI command timed out.'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new ConnectionError('Codex is disconnected.'))
    }
    this.pending.clear()
  }

  close() {
    this.rejectPending()
    this.socket?.close()
  }
}

export class AssistantTarget {
  constructor(target, request, { connectionFactory = (url, onEvent) => new CdpConnection(url, onEvent),
    report = () => {} } = {}) {
    this.target = target
    this.request = request
    this.report = report
    this.contexts = new Map()
    this.mainFrameId = null
    this.allowed = false
    this.disposed = false
    this.nativeFastReloadAttempted = false
    this.nativeAdapterFailed = false
    this.replies = new Set()
    this.connection = connectionFactory(target.webSocketDebuggerUrl, (event) => this.onEvent(event))
  }

  topContext() {
    for (const [id, context] of this.contexts) {
      if (context.auxData?.isDefault === true && context.auxData.frameId === this.mainFrameId) return id
    }
    return null
  }

  onEvent(event) {
    if (event.method === 'Fetch.requestPaused') {
      const reply = this.adaptNativeScript(event.params)
      this.replies.add(reply)
      reply.catch((error) => this.report(connectionMessage(error))).finally(() => this.replies.delete(reply))
    } else if (event.method === 'Runtime.executionContextCreated') {
      this.contexts.set(event.params.context.id, event.params.context)
    } else if (event.method === 'Runtime.executionContextDestroyed') {
      this.contexts.delete(event.params.executionContextId)
    } else if (event.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear()
    } else if (event.method === 'Page.frameNavigated' && !event.params.frame.parentId) {
      this.mainFrameId = event.params.frame.id
      this.allowed = event.params.frame.url === CODEX_PAGE
    } else if (event.method === 'Runtime.bindingCalled' && event.params.name === BINDING &&
      event.params.executionContextId === this.topContext() && this.allowed && !this.disposed) {
      const reply = this.reply(event.params)
      this.replies.add(reply)
      reply.catch((error) => this.report(connectionMessage(error))).finally(() => this.replies.delete(reply))
    }
  }

  isIdle() {
    return this.replies.size === 0
  }

  async adaptNativeScript(params) {
    try {
      const fast = NATIVE_FAST_ASSET_URL.test(params.request.url)
      const adapt = fast ? adaptNativeGateSource
        : NATIVE_I18N_ASSET_URL.test(params.request.url) ? adaptNativeI18nSource
          : NATIVE_RUNTIME_ASSET_URL.test(params.request.url) ? adaptNativeRuntimeSource
            : NATIVE_HOST_ASSET_URL.test(params.request.url) ? adaptNativeHostSource
              : NATIVE_CHUNK_ASSET_URL.test(params.request.url) ? adaptNativeChunkSource : null
      if (!adapt || params.responseStatusCode !== 200) {
        throw new ConnectionError('The native Fast module could not be adapted.')
      }
      const response = await this.connection.call('Fetch.getResponseBody', { requestId: params.requestId })
      const source = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
      let patched = adapt(source)
      if (patched === source) {
        await this.connection.call('Fetch.continueRequest', { requestId: params.requestId })
        return
      }
      let fastError = null
      // An incompatible Fast adapter must not also drop the feature gates.
      if (fast) try { patched = adaptNativeFastSource(patched) } catch (error) { fastError = error }
      await this.connection.call('Fetch.fulfillRequest', {
        requestId: params.requestId, responseCode: 200,
        responseHeaders: (params.responseHeaders || []).filter((header) =>
          !['content-length', 'content-encoding'].includes(header.name.toLowerCase())),
        body: Buffer.from(patched).toString('base64'),
      })
      if (fastError) {
        this.nativeAdapterFailed = true
        this.report(connectionMessage(fastError))
      }
    } catch (error) {
      if (error instanceof ConnectionError && /does not support the native Fast adapter/.test(error.message)) {
        this.nativeAdapterFailed = true
      }
      await this.connection.call('Fetch.continueRequest', { requestId: params.requestId })
      throw error
    }
  }

  async reloadState() {
    if (this.disposed || !this.allowed || !this.topContext()) return null
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(() => {
        const runtime = window.__yisamaInfiniteAssistant;
        const state = runtime?.snapshot?.();
        const root = document.getElementById('yisama-infinite-assistant-ui');
        if (!state || !root) return { open: false, busy: false, unsent: false };
        const value = (testId) => root.querySelector('[data-testid="' + testId + '"]')?.dataset.value || '';
        const hasText = state.loggedIn !== true && [...root.querySelectorAll('input, textarea')]
          .some((element) => typeof element.value === 'string' && element.value.length > 0);
        return {
          open: state.open === true,
          busy: state.setupPending === true,
          unsent: hasText || Boolean(value('group-select') && value('group-select') !== state.group),
        };
      })()`,
      contextId: this.topContext(), returnByValue: true,
    })
    const state = result?.result?.value
    if (!state || typeof state !== 'object') return null
    return { open: state.open === true, busy: state.busy === true, unsent: state.unsent === true }
  }

  async reply({ payload, executionContextId }) {
    const response = await this.request(payload, this)
    if (!response || this.disposed || !this.allowed || executionContextId !== this.topContext()) return
    await this.connection.call('Runtime.evaluate', {
      expression: `if (window === window.top && location.href === ${JSON.stringify(CODEX_PAGE)}) {
        window.__yisamaNativeFast?.receive(${JSON.stringify(response)});
        window.__yisamaInfiniteAssistant?.receive(${JSON.stringify(response)});
      }`,
      contextId: executionContextId,
      returnByValue: true,
    })
  }

  async restartBlocker() {
    if (this.disposed || !this.allowed || !this.topContext()) return 'unavailable'
    const contextId = this.topContext()
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(${codexRestartBlocker.toString()})()`,
      contextId, returnByValue: true, awaitPromise: true,
    }, { timeoutMs: 45000 })
    if (this.disposed || !this.allowed || contextId !== this.topContext() || result.exceptionDetails) return 'unavailable'
    const blocker = result.result?.value
    return blocker === null || ['draft', 'busy'].includes(blocker) ? blocker : 'unavailable'
  }

  async restartFailed() {
    if (this.disposed || !this.allowed || !this.topContext()) return
    await this.connection.call('Runtime.evaluate', {
      expression: 'window.__yisamaInfiniteAssistant?.restartFailed?.()',
      contextId: this.topContext(), returnByValue: true,
    })
  }

  async checkNative(settings) {
    if (this.disposed || !this.allowed || !this.topContext()) throw new UserError('Codex 页面未就绪，请稍后自检。')
    const contextId = this.topContext()
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(${inspectNativeControls.toString()})(${JSON.stringify(settings)})`,
      contextId, returnByValue: true, awaitPromise: true,
    }, { timeoutMs: 30000 })
    if (this.disposed || contextId !== this.topContext() || result.exceptionDetails || !result.result?.value) {
      throw new UserError('无法读取 Codex 控件状态，未进行修复。')
    }
    const check = result.result.value
    if (this.nativeAdapterFailed && check.status === 'repairable') {
      return { status: 'unsupported', canRepair: false }
    }
    return check
  }

  async prepareNativeRepair(settings) {
    const check = await this.checkNative(settings)
    if (!check.canRepair) return check
    const contextId = this.topContext()
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(() => {
        const runtime = window.__yisamaInfiniteAssistant;
        if (!runtime?.startNativeRepair) return false;
        delete window.__yisamaNativeModelSync;
        delete window.__yisamaNativeAdapterUnsupported;
        runtime.startNativeRepair();
        return true;
      })()`,
      contextId, returnByValue: true,
    })
    if (this.disposed || contextId !== this.topContext() || result.exceptionDetails || result.result?.value !== true) {
      throw new UserError('未能开始本地修复，请稍后重试。')
    }
    // One new reload is allowed only by a fresh, confirmed manual repair.
    this.nativeFastReloadAttempted = false
    return { ...check, status: 'repairing', canRepair: false }
  }

  async syncModels(settings) {
    if (this.disposed || !this.allowed || !this.topContext()) return null
    const contextId = this.topContext()
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(${syncNativeModels.toString()})(${JSON.stringify(settings)})`,
      contextId, returnByValue: true, awaitPromise: true,
    }, { timeoutMs: 45000 })
    if (result.exceptionDetails) throw new ConnectionError('Native model synchronization failed.')
    const synced = result.result?.value
    if (synced?.reloadNativeFast === true || synced?.nativeControlsMissing === true) {
      if (this.disposed || !this.allowed || contextId !== this.topContext()) return { status: 'pending' }
      if (this.nativeFastReloadAttempted) {
        // Keep the rest of the assistant usable and say so, instead of syncing forever.
        await this.connection.call('Runtime.evaluate', {
          expression: `window.__yisamaNativeAdapterUnsupported = true;
            window.__yisamaInfiniteAssistant?.nativeStatus?.('unsupported');`,
          contextId: this.topContext(), returnByValue: true,
        })
        this.report('The native model controls did not load. This Codex build may be incompatible.')
        return { status: 'synced' }
      }
      if (synced.reloadNativeFast !== true) return synced
      this.nativeFastReloadAttempted = true
      this.report(`${new Date().toISOString()} Native model controls: ${synced.startupReload ? 'startup' : 'user-requested'} page reload.`)
      // The renderer's memory cache can return modules adapted by an earlier assistant
      // build even with ignoreCache, so bypass it for this one reload.
      await this.connection.call('Network.enable')
      await this.connection.call('Network.setCacheDisabled', { cacheDisabled: true })
      await this.connection.call('Page.reload', { ignoreCache: true })
      setTimeout(() => this.connection.call('Network.disable').catch(() => {}), 20000).unref?.()
      return { status: 'pending' }
    }
    return synced
  }

  async install() {
    await this.connection.connect()
    await this.connection.call('Page.enable')
    const { frameTree } = await this.connection.call('Page.getFrameTree')
    if (frameTree?.frame.url !== CODEX_PAGE) throw new ConnectionError('The active page is not the Codex workspace.')
    this.mainFrameId = frameTree.frame.id
    this.allowed = true
    await this.connection.call('Runtime.enable')
    await this.connection.call('Runtime.addBinding', { name: BINDING })
    await this.connection.call('Fetch.enable', {
      patterns: [{ urlPattern: NATIVE_FAST_ASSET, requestStage: 'Response' },
        { urlPattern: NATIVE_I18N_ASSET, requestStage: 'Response' },
        { urlPattern: NATIVE_RUNTIME_ASSET, requestStage: 'Response' },
        { urlPattern: NATIVE_HOST_ASSET, requestStage: 'Response' },
        { urlPattern: NATIVE_CHUNK_ASSET, requestStage: 'Response' }],
    })
    const source = `(${installNativeStartup.toString()})(${JSON.stringify(process.env.YISAMA_CODEX_STARTED_AT)});\n` +
      `${makeAssistantScript()}\n;(${installNativeFast.toString()})();`
    const restored = await this.connection.call('Page.addScriptToEvaluateOnNewDocument', { source })
    this.scriptId = restored.identifier
    const result = await this.connection.call('Runtime.evaluate', {
      expression: source, awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails) throw new ConnectionError('The yisama interface could not load inside Codex.')
  }

  async dispose() {
    this.disposed = true
    if (this.allowed && this.connection.socket?.readyState === WebSocket.OPEN) {
      try {
        await this.connection.call('Runtime.removeBinding', { name: BINDING })
        await this.connection.call('Fetch.disable')
        if (this.scriptId) {
          await this.connection.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId })
        }
        await this.connection.call('Runtime.evaluate', {
          expression: `window.__yisamaNativeFast?.dispose();${REMOVE_ASSISTANT_SCRIPT}`,
        })
      } catch {
        // Closing the app also closes its renderer connection.
      }
    }
    this.connection.close()
  }
}

export async function runAssistant({ endpointFile, processId, signal, handler = handleRequest,
  discover = discoverCodexTargets, isRunning = (pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  }, onReady = () => {}, report = console.error, pollMs = 250, updateFile = UPDATE_FILE,
  readUpdate = readUpdateMarker, reloadCheck = shouldReload, restartDelayMs = 1500,
  restart = handler === handleRequest ? restartCodex : null,
  readEndpoint = async (file) => JSON.parse(await fs.readFile(file, 'utf8')),
  connectionFactory = (url, onEvent) => new CdpConnection(url, onEvent),
  nativeConfiguration = handler === handleRequest ? desktopNativeConfiguration : async () => null,
  diagnose = diagnoseNativeControls,
  onNativeSynced = nativeConfiguration === desktopNativeConfiguration ? desktopNativeSynced : async () => {} } = {}) {
  const clients = new Map()
  // Finish account changes by restarting only after the panel has received its reply.
  let restartCodexAt = 0
  let preparedInstaller
  let allowInterrupt = false
  const checkRepairActivity = async () => {
    const blockers = await Promise.all([...clients.values()].map((entry) => entry.restartBlocker()))
    if (!blockers.length || blockers.some((blocker) => blocker !== null)) {
      const error = new UserError('请先保存草稿并等待所有任务完成，再点击修复。未安排延后修复。')
      error.publicCode = 'CODEX_REPAIR_BLOCKED'
      throw error
    }
  }
  const checkRestart = async (action, consent = false) => {
    const restoring = action === 'restore'
    const blockers = await Promise.all([...clients.values()].map((client) => client.restartBlocker()))
    const unavailable = !blockers.length || blockers.includes('unavailable')
    if (unavailable || (!consent && blockers.some(Boolean))) {
      const unchanged = restoring ? '未退出登录或改动配置' : '未重启'
      const error = new UserError(unavailable
        ? `暂时无法确认 Codex 是否空闲，${unchanged}，请稍后重试。`
        : `请先保存草稿并等待运行中的任务完成，再确认${restoring ? '退出' : '重启'}；${unchanged}。`)
      error.publicCode = `${restoring ? 'RESTORE' : action === 'installUpdate' ? 'UPDATE' : 'RESTART'}_${unavailable ? 'CHECK_FAILED' : 'BLOCKED'}`
      throw error
    }
  }
  const request = createRequestQueue(async (command, client) => {
    if (restartCodexAt && !['status', 'authOptions'].includes(command.action)) {
      throw new UserError('Codex 正在重启，请稍候。')
    }
    if (['codexCheck', 'codexRepair'].includes(command.action)) {
      if (!client || clients.get(client.target.id) !== client) throw new UserError('请从当前 Codex 面板发起自检。')
      const repairing = command.action === 'codexRepair'
      if (repairing) await checkRepairActivity()
      const settings = await nativeConfiguration()
      const check = await client.checkNative(settings)
      let data = check
      if (!repairing || check.canRepair) {
        const diagnosis = await diagnose(settings, check, { action: command.action })
        data = { ...check, summary: diagnosis.summary,
          canRepair: check.canRepair === true && diagnosis.repair === true, billing: 'account' }
        if (repairing && data.canRepair) {
          const current = await nativeConfiguration()
          if (current?.version !== settings?.version || current?.apiKey !== settings?.apiKey ||
            current?.model !== settings?.model ||
            clients.get(client.target.id) !== client) {
            const error = new UserError('自检期间配置已变化，未执行修复，请重新手动自检。')
            error.publicCode = 'CODEX_DIAGNOSTIC_CONFIGURATION'
            throw error
          }
          await checkRepairActivity()
          data = { ...data, ...await client.prepareNativeRepair(current) }
        }
      }
      const updateControl = process.env.YISAMA_CODEX_UPDATE_CONTROL
      return { ...data, updates: ['launch-disabled', 'activation-unverified'].includes(updateControl)
        ? updateControl : 'unknown' }
    }
    if (['restore', 'reconfigure', 'installUpdate'].includes(command.action)) {
      await checkRestart(command.action, command.allowInterrupt === true)
    }
    const data = await handler(command)
    if (command.action === 'installUpdate') {
      await checkRestart(command.action, command.allowInterrupt === true)
      preparedInstaller = data.updateInstaller
      delete data.updateInstaller
    }
    if (command.action === 'reconfigure' || (['restore', 'installUpdate'].includes(command.action) && data.restartRequired)) {
      allowInterrupt = command.allowInterrupt === true
      restartCodexAt = Date.now() + restartDelayMs
    }
    return data
  })
  let generation = validateUpdateMarker(await readUpdate(updateFile))?.generation || null
  let ready = false
  let lastFailure = ''
  try {
    while (!signal?.aborted && isRunning(processId)) {
      let reloading = false
      if (restartCodexAt && Date.now() >= restartCodexAt && request.isIdle() &&
        [...clients.values()].every((client) => client.isIdle())) {
        if (!restart) return { restartCodex: true, ...(preparedInstaller ? { installer: preparedInstaller } : {}) }
        try {
          await checkRestart(preparedInstaller ? 'installUpdate' : 'reconfigure', allowInterrupt)
          // Keep the renderer and error channel alive until the launcher actually succeeds.
          await restart(undefined, { installer: preparedInstaller })
          return { restarted: true }
        } catch (error) {
          report(connectionMessage(error))
          restartCodexAt = 0
          preparedInstaller = undefined
          allowInterrupt = false
          for (const client of clients.values()) await client.restartFailed()
        }
      }
      try {
        const endpoint = validateEndpoint(await readEndpoint(endpointFile))
        if (endpoint.processId !== processId) break
        const targets = await discover(endpoint.port)
        const live = new Map(targets.map((target) => [target.id, target]))
        for (const [id, client] of clients) {
          if (live.get(id)?.webSocketDebuggerUrl !== client.target.webSocketDebuggerUrl ||
            client.connection.socket?.readyState !== WebSocket.OPEN) {
            await client.dispose()
            clients.delete(id)
          }
        }
        for (const target of targets) {
          if (clients.has(target.id)) continue
          const client = new AssistantTarget(target, request, { report, connectionFactory })
          try {
            await client.install()
            clients.set(target.id, client)
          } catch (error) {
            await client.dispose()
            throw error
          }
        }
        if (!targets.length) throw new ConnectionError('No Codex workspace is ready for the assistant.')
        if (!restartCodexAt && request.isIdle() && [...clients.values()].every((client) => client.isIdle())) {
          request.quiesce()
          try {
            await request.drain()
            const settings = await nativeConfiguration()
            if (!settings) for (const client of clients.values()) await client.syncModels(null)
            if (settings) {
              let allSynced = true
              for (const client of clients.values()) {
                const synced = await client.syncModels(settings)
                if (synced?.status !== 'synced') allSynced = false
              }
              if (allSynced) await onNativeSynced(settings.version)
            }
          } finally {
            request.resume()
          }
        }
        lastFailure = ''
        const marker = validateUpdateMarker(await readUpdate(updateFile))
        if (!ready) { ready = true; onReady({ generation: marker?.generation || null }) }
        if (reloadCheck(generation, marker)) {
          request.quiesce()
          try {
            await request.drain()
            const states = await Promise.all([...clients.values()].map((client) => client.reloadState()))
            if (request.isIdle() && [...clients.values()].every((client) => client.isIdle()) &&
              states.length === clients.size && states.every((state) => state && !state.open && !state.busy && !state.unsent)) {
              reloading = true
              return { reload: true, generation: marker.generation }
            }
          } finally {
            if (!reloading) request.resume()
          }
        }
      } catch (error) {
        const failure = connectionMessage(error)
        if (failure !== lastFailure) report(failure)
        lastFailure = failure
      }
      try { await delay(pollMs, undefined, { signal }) } catch (error) {
        if (error.name !== 'AbortError') throw error
      }
    }
  } finally {
    for (const client of clients.values()) await client.dispose()
  }
}

export async function diagnoseNativeControls(settings, check, { action = 'codexCheck', send = requestApi } = {}) {
  if (!settings || settings.provider !== 'yisama' || typeof settings.apiKey !== 'string' ||
    !settings.apiKey || typeof settings.model !== 'string' || !settings.model ||
    !Array.isArray(settings.models) || !settings.models.includes(settings.model)) {
    const error = new UserError('请先登录并应用可用的对话模型，再进行 Codex 自检。')
    error.publicCode = 'CODEX_DIAGNOSTIC_CONFIGURATION'
    throw error
  }
  // Only explicit diagnostic clicks reach this paid request. Never send source,
  // configuration, logs, conversations or credentials as model input.
  const evidence = {
    operation: action === 'codexRepair' ? 'repair' : 'check',
    status: ['ready', 'repairable', 'unsupported', 'configuration', 'account-change', 'unavailable',
      'connection', 'not-offered'].includes(check?.status) ? check.status : 'unavailable',
    canResync: check.status === 'repairable' && check.canRepair === true,
    fast: check.fast === true, ultra: check.ultra === true,
  }
  try {
    const payload = await send('/responses', {
      method: 'POST', token: settings.apiKey, apiPrefix: '/v1', timeoutMs: 60000,
      body: {
        model: settings.model, store: false, stream: false, max_output_tokens: 2048,
        ...(settings.modelSettings?.[settings.model]?.reasoningEfforts?.includes('low')
          ? { reasoning: { effort: 'low' } } : {}),
        instructions: '你是无限助手的 Codex 本机诊断助手。只分析给定的结构化状态，用简短中文解释原因和下一步。' +
          'repair 仅表示是否建议重新同步本地控件，只有 status=repairable 且 canResync=true 时才可为 true。' +
          'ready 表示本地已就绪，不代表实际线路测试通过；unsupported 必须提示更新无限助手，不得声称可修复未知版本。' +
          'configuration/account-change 应提示应用登录配置，connection/unavailable 应提示检查本机客户端，' +
          'not-offered 应提示当前模型未提供该能力。不得声称已经修复、保证开启功能或要求用户提供凭证。' +
          '你没有执行代码或修改文件的权限。',
        input: JSON.stringify(evidence),
        text: { format: {
          type: 'json_schema', name: 'codex_diagnostic', strict: true,
          schema: {
            type: 'object', properties: { summary: { type: 'string' }, repair: { type: 'boolean' } },
            required: ['summary', 'repair'], additionalProperties: false,
          },
        } },
      },
    })
    if (payload?.status !== 'completed') throw new Error('Incomplete diagnostic response.')
    const text = payload.output?.filter((item) => item.type === 'message')
      .flatMap((item) => item.content || []).filter((item) => item.type === 'output_text')
      .map((item) => item.text).join('')
    const result = JSON.parse(text)
    if (typeof result?.summary !== 'string' || !result.summary.trim() || typeof result.repair !== 'boolean') {
      throw new Error('Invalid diagnostic response.')
    }
    return {
      summary: result.summary.replaceAll(settings.apiKey, '[已隐藏]').trim().slice(0, 400),
      repair: evidence.canResync && result.repair,
    }
  } catch (cause) {
    const error = new UserError(cause.status === 402
      ? '可用额度不足，未完成 Codex 自检。' : '模型自检未完成，请检查当前模型和网络后手动重试。')
    error.publicCode = cause.status === 402 ? 'CODEX_DIAGNOSTIC_BALANCE' : 'CODEX_DIAGNOSTIC_FAILED'
    throw error
  }
}

// Read-only, no inference requests. Return states only, never native credentials.
export async function inspectNativeControls(settings, options = {}) {
  if (window.top !== window || (location.href !== 'app://-/index.html' && options.allowTestLocation !== true)) return null
  if (!settings || settings.provider !== 'yisama') return { status: 'configuration', canRepair: false }
  if (!window.__yisamaInfiniteAssistant || !window.__codexRoot?._internalRoot?.current ||
    !window.electronBridge?.sendMessageFromView || !window.__yisamaNativeFast) {
    return { status: 'unavailable', canRepair: false }
  }
  const auth = await new Promise((resolve) => {
    const id = `yisama-check-${crypto.randomUUID()}`
    const finish = (value) => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      resolve(value)
    }
    const receive = (event) => {
      const data = event.data
      if (data?.type !== 'mcp-response' || data.hostId !== 'local' || data.message?.id !== id) return
      finish(data.message.error ? null : data.message.result)
    }
    const timer = setTimeout(() => finish(null), 8000)
    window.addEventListener('message', receive)
    Promise.resolve().then(() => window.electronBridge.sendMessageFromView({
      type: 'mcp-request', hostId: 'local', request: { id, method: 'getAuthStatus',
        params: { includeToken: true, refreshToken: false } }, priority: 'critical',
    })).catch(() => finish(null))
  })
  if (!auth || auth.isLoading) return { status: 'connection', canRepair: false }
  if (auth.authMethod !== 'apikey' || !settings.apiKey || auth.authToken !== settings.apiKey) {
    return { status: 'account-change', canRepair: false }
  }
  const currentModel = settings.modelSettings?.[settings.model]
  const fast = currentModel ? currentModel.fastAvailable === true : settings.fastAvailable === true
  const ultra = currentModel ? currentModel.reasoningEfforts?.includes('ultra') === true
    : Object.values(settings.modelSettings || {}).some((model) => model.reasoningEfforts?.includes('ultra'))
  if (!fast && !ultra) return { status: 'not-offered', canRepair: false, fast, ultra }
  const synced = window.__yisamaNativeModelSync
  const loaded = (!fast || window.__yisamaNativeFastSourceReady === true) &&
    (!ultra || window.__yisamaNativeReasoningSourceReady === true)
  const ready = loaded && synced?.status === 'synced' && synced.version === settings.version &&
    window.__yisamaNativeAdapterUnsupported !== true
  return { status: ready ? 'ready' : 'repairable', canRepair: !ready, fast, ultra }
}

// Serialized into the renderer. Re-authentication with the current key refreshes
// the model catalog without restarting the local app-server or interrupting chats.
export async function syncNativeModels(settings, options = {}) {
  if (window.top !== window || (location.href !== 'app://-/index.html' && options.allowTestLocation !== true)) return null
  const runtime = window.__yisamaInfiniteAssistant
  if (!runtime || !window.electronBridge?.sendMessageFromView) return { status: 'unavailable' }
  // A click is valid for this check only, never queued behind a draft or running turn.
  const reloadRequested = runtime.consumeNativeReloadRequest?.() === true
  if (reloadRequested) runtime.nativeStatus?.('reload-required')
  const fast = window.__yisamaNativeFast
  if (!settings) {
    window.__yisamaNativeStartup?.cancel()
    fast?.authorize(null)
    return { status: 'unavailable' }
  }
  if (fast?.isBusy()) return { status: 'pending' }
  if (!window.__codexRoot?._internalRoot?.current) return { status: 'pending' }
  const previous = window.__yisamaNativeModelSync
  if (previous?.version === settings.version && previous.status === 'error') {
    runtime.nativeStatus?.('error')
    return { status: 'error' }
  }
  if (previous?.version === settings.version && previous.nextCheckAt > Date.now()) return { status: 'pending' }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `yisama-sync-${crypto.randomUUID()}`
    const finish = (callback, value) => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      callback(value)
    }
    const receive = (event) => {
      const data = event.data
      if (data?.type !== 'mcp-response' || data.hostId !== 'local' || data.message?.id !== id) return
      if (data.message.error) finish(reject, new Error('Native request failed.'))
      else finish(resolve, data.message.result)
    }
    const timer = setTimeout(() => finish(reject, new Error('Native request timed out.')), 8000)
    window.addEventListener('message', receive)
    window.electronBridge.sendMessageFromView({
      type: 'mcp-request', hostId: 'local', request: { id, method, params }, priority: 'critical',
    }).catch(() => finish(reject, new Error('Native request failed.')))
  })
  const finish = async () => {
    const startup = window.__yisamaNativeStartup
    if (window.__yisamaNativeAdapterUnsupported === true) {
      startup?.cancel()
      runtime.nativeStatus?.('unsupported')
      return { status: 'synced' }
    }
    if (!fast?.needsReload?.()) {
      startup?.cancel()
      runtime.nativeStatus?.('synced')
      return { status: 'synced' }
    }
    const startupReload = startup?.pending() === true
    if (!reloadRequested && !startupReload) {
      if (runtime.snapshot?.().nativeSync !== 'reload-blocked') runtime.nativeStatus?.('reload-required')
      return { status: 'pending', nativeControlsMissing: true }
    }
    const blocked = () => {
      runtime.nativeStatus?.('reload-blocked')
      return { status: 'pending', nativeControlsMissing: true }
    }
    const hasUnsentChanges = () => {
      const panel = runtime.snapshot?.()
      return panel?.setupPending || [...document.querySelectorAll(
        '[contenteditable=true],textarea,input:not([type]),input[type=text],input[type=password],input[type=email]',
      )].some((node) => {
        if (panel?.loggedIn && node.closest?.('#yisama-infinite-assistant-ui [data-testid="logged-out"]')) return false
        return node.isContentEditable ? node.textContent.trim() : node.value?.trim()
      })
    }
    try {
      if (hasUnsentChanges() || (startupReload && runtime.snapshot?.().open)) return blocked()
      let cursor = null
      do {
        const loaded = await rpc('thread/loaded/list', { cursor, limit: 100 })
        for (const threadId of loaded.data) {
          const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
          if (thread.status?.type !== 'idle') return blocked()
        }
        cursor = loaded.nextCursor
      } while (cursor)
      if (hasUnsentChanges() || (!reloadRequested && !startup.pending())) return blocked()
      return { status: 'pending', reloadNativeFast: true, startupReload: startupReload && !reloadRequested }
    } finally {
      startup?.cancel()
    }
  }
  let stage = 'authentication'
  try {
    const auth = await rpc('getAuthStatus', { includeToken: true, refreshToken: false })
    if (auth?.isLoading || auth?.authMethod == null) return { status: 'pending' }
    if (auth?.authMethod !== 'apikey' || typeof auth.authToken !== 'string' ||
      auth.authToken.length < 8) throw new Error('Native authentication unavailable.')
    let migratedCredential = false
    if (typeof settings.apiKey === 'string' && settings.apiKey !== auth.authToken) {
      const fingerprint = settings.provider === 'yisama' && typeof settings.previousKeyFingerprint === 'string'
        ? Array.from(new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth.authToken)),
        ), (byte) => byte.toString(16).padStart(2, '0')).join('') : null
      if (!fingerprint || settings.previousKeyFingerprint !== fingerprint) {
        fast?.authorize(null)
        window.__yisamaNativeModelSync = { version: settings.version, status: 'account-change',
          nextCheckAt: Date.now() + 5000 }
        runtime.nativeStatus?.('account-change')
        return { status: 'account-change' }
      }
      // A different API key resets native sessions; wait until every reply is idle.
      let cursor = null
      do {
        const loaded = await rpc('thread/loaded/list', { cursor, limit: 100 })
        for (const threadId of loaded.data) {
          const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
          if (thread?.status?.type !== 'idle') {
            fast?.authorize(null)
            runtime.nativeStatus?.('pending')
            return { status: 'pending' }
          }
        }
        cursor = loaded.nextCursor
      } while (cursor)
      await rpc('account/login/start', { type: 'apiKey', apiKey: settings.apiKey })
      const confirmed = await rpc('getAuthStatus', { includeToken: true, refreshToken: false })
      if (confirmed?.authMethod !== 'apikey' || confirmed.authToken !== settings.apiKey) {
        throw new Error('Native device credential migration was not confirmed.')
      }
      auth.authToken = confirmed.authToken
      migratedCredential = true
    }
    fast?.authorize(settings.provider === 'yisama' && settings.apiKey === auth.authToken ? settings : null)
    if (previous?.version === settings.version && previous.status === 'synced') {
      return await finish()
    }
    const catalogChanged = !settings.catalogVersion || previous?.status !== 'synced' ||
      previous.catalogVersion !== settings.catalogVersion
    // Fast toggles change the native configuration revision without changing the
    // already-loaded model catalog. The native setter has already updated the
    // active thread, so do not wait on or enumerate every other session here.
    const fastOnly = !catalogChanged && window.__yisamaNativeFastSourceReady === true &&
      window.__yisamaNativeReasoningSourceReady === true
    if (fastOnly) {
      window.__yisamaNativeModelSync = {
        version: settings.version, catalogVersion: settings.catalogVersion, status: 'synced',
      }
      runtime.nativeStatus?.('synced')
      return { status: 'synced' }
    }
    let queryClient
    let models = settings.models
    if (catalogChanged) {
      stage = 'query-cache'
      const nodes = [{ node: window.__codexRoot?._internalRoot?.current, depth: 0 }]
      const visited = new Set()
      while (nodes.length && visited.size < 300) {
        const { node, depth } = nodes.shift()
        if (!node || depth > 20 || visited.has(node)) continue
        visited.add(node)
        for (const key of ['client', 'value']) {
          const value = node.memoizedProps?.[key]
          if (typeof value?.getQueryCache === 'function' && typeof value?.invalidateQueries === 'function') {
            queryClient = value
            break
          }
        }
        if (queryClient) break
        if (node.child) nodes.push({ node: node.child, depth: depth + 1 })
        if (node.sibling) nodes.push({ node: node.sibling, depth })
      }
      if (!queryClient) {
        runtime.nativeStatus?.('pending')
        return { status: 'pending' }
      }
      runtime.nativeStatus?.('syncing')
      stage = 'catalog'
      if (!migratedCredential) await rpc('account/login/start', { type: 'apiKey', apiKey: auth.authToken })
      const catalog = []
      let cursor = null
      do {
        const response = await rpc('model/list', { cursor, includeHidden: true, limit: 100 })
        catalog.push(...response.data)
        cursor = response.nextCursor
      } while (cursor)
      const nativeModels = catalog.map((model) => model.model)
      if (Array.isArray(settings.models) && settings.models.some((model) => !nativeModels.includes(model))) {
        throw new Error('Native model catalog did not change.')
      }
      // Codex can retain native-only entries; manage only the configured catalog.
      models = Array.isArray(settings.models) ? settings.models : nativeModels
      if (settings.modelSettings && settings.provider) {
        stage = 'service-tiers'
        for (const model of catalog) {
          if (!models.includes(model.model)) continue
          const expected = settings.modelSettings[model.model]
          const supported = expected?.fastAvailable ?? Boolean(expected?.serviceTier)
          const inputModalities = model.inputModalities ?? ['text', 'image']
          if (expected?.inputModalities &&
            (expected.inputModalities.length !== inputModalities.length ||
              expected.inputModalities.some((value) => !inputModalities.includes(value)))) {
            throw new Error('Native input modalities did not change.')
          }
          if (expected?.reasoningEfforts?.some((effort) =>
            !model.supportedReasoningEfforts?.some((item) => item.reasoningEffort === effort))) {
            throw new Error('Native reasoning levels did not change.')
          }
          if (supported && (!model.serviceTiers?.some((item) => item.id === 'priority') ||
            model.defaultServiceTier !== 'priority')) throw new Error('Native Fast tier did not change.')
          if (!supported && model.serviceTiers?.length) throw new Error('Native ordinary tier did not change.')
        }
      }
    }
    if (catalogChanged && settings.modelSettings && settings.provider) {
      // A catalog change can replace stale provider threads. Fast-only changes are
      // already persisted by the native setter and must not walk every open thread.
      // Other providers retain their own models and settings.
      stage = 'thread-settings'
      let cursor = null
      do {
        const loaded = await rpc('thread/loaded/list', { cursor, limit: 100 })
        for (const threadId of loaded.data) {
          const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
          if (thread.modelProvider !== settings.provider) continue
          // Keep a thread's model when the new group does not provide it. Replacing
          // it with the group default makes switching back unable to recover it.
          if (!models.includes(thread.model)) continue
          const next = settings.modelSettings[thread.model]
          if (!next) throw new Error('Native thread model unavailable.')
          await rpc('thread/settings/update', { threadId, model: thread.model, serviceTier: next.serviceTier })
        }
        cursor = loaded.nextCursor
      } while (cursor)
    }
    if (catalogChanged) {
      stage = 'query-refresh'
      await queryClient.invalidateQueries({
        predicate: (query) => ['models', 'config', 'user-saved-config'].includes(query.queryKey[0]),
      })
    }
    window.__yisamaNativeModelSync = {
      version: settings.version, catalogVersion: settings.catalogVersion, status: 'synced',
    }
    stage = 'native-fast-readiness'
    return await finish()
  } catch {
    fast?.authorize(null)
    window.__yisamaNativeModelSync = { version: settings.version, status: 'error', stage }
    runtime.nativeStatus?.('error')
    return { status: 'error' }
  }
}

function commandOptions(args) {
  if (args.length === 1 && args[0] === '--help') return null
  if (args.length !== 4 || args[0] !== '--endpoint-file' || args[2] !== '--process-id' ||
    !path.isAbsolute(args[1]) || !Number.isSafeInteger(Number(args[3])) || Number(args[3]) <= 0) {
    throw new ConnectionError('Usage: codex-assistant.mjs --endpoint-file <absolute-file> --process-id <Codex-pid>')
  }
  return { endpointFile: args[1], processId: Number(args[3]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const options = commandOptions(args)
    if (!options) console.log('yisama in-Codex assistant: --endpoint-file <absolute-file> --process-id <Codex-pid>')
    else {
      try {
        const startedAt = await codexStartedAt(options.processId)
        if (startedAt) process.env.YISAMA_CODEX_STARTED_AT = startedAt
      } catch (error) {
        delete process.env.YISAMA_CODEX_STARTED_AT
        console.error(connectionMessage(error))
      }
      const stop = new AbortController()
      process.once('SIGINT', () => stop.abort())
      process.once('SIGTERM', () => stop.abort())
      const result = await runAssistant({ ...options, signal: stop.signal,
        onReady: ({ generation }) => console.log(JSON.stringify({ ready: true, processId: options.processId,
          assistantProcessId: process.pid, generation })) })
      if (result?.reload && !stop.signal.aborted) {
        await restartAssistant(args)
      }
      if (result?.restartCodex && !stop.signal.aborted) await restartCodex(undefined, { installer: result.installer })
    }
  } catch (error) {
    console.error(connectionMessage(error))
    process.exitCode = 1
  }
}
