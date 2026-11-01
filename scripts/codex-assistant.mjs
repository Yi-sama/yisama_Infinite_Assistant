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
import { safeError, publicErrorCode, desktopNativeConfiguration, desktopNativeSynced } from './yisama.mjs'

export const CODEX_PAGE = 'app://-/index.html'
const BINDING = 'yisamaAssistantCommand'
const ASSISTANT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const UPDATE_FILE = path.join(ASSISTANT_ROOT, 'update.json')
const NATIVE_FAST_ASSET = 'app://-/assets/app-initial-*.js'
const NATIVE_FAST_ASSET_URL = /^app:\/\/-\/assets\/app-initial-[0-9a-f]+\.js$/

// Codex's minified names change between builds, so each hook is found by its code shape
// and must match exactly once. Neither UI markup nor authentication is replaced.
function uniqueMatch(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))]
  if (matches.length !== 1) throw new ConnectionError(`This Codex build does not support the native Fast adapter (${label}).`)
  return matches[0]
}

function enclosingFunction(source, index) {
  return source.slice(source.lastIndexOf('function ', index), index)
}

function lastCapture(text, pattern, label) {
  const match = [...text.matchAll(new RegExp(pattern.source, 'g'))].at(-1)
  if (!match) throw new ConnectionError(`This Codex build does not support the native Fast adapter (${label}).`)
  return match
}

export function adaptNativeFastSource(source) {
  const n = String.raw`[\w$]+`
  const access = uniqueMatch(source, new RegExp(
    String.raw`let (${n})=(${n}),(${n});return (${n}\[\d+\])!==(${n})\|\|(${n}\[\d+\])!==\1\?\(\3=\{serviceTierAccess:\1,isLoading:\5\}`), 'access')
  const [, accessMethod, accessHost] = lastCapture(enclosingFunction(source, access.index),
    new RegExp(String.raw`\{authMethod:(${n}),hostId:(${n})\}`), 'access auth')

  const setter = uniqueMatch(source, new RegExp(
    String.raw`serviceTierAccess:(${n}),serviceTierSettings:(${n}),setServiceTier:(${n})\}`), 'setter')
  const setterScope = enclosingFunction(source, setter.index)
  const [, setterHost] = uniqueMatch(setterScope, new RegExp(String.raw`\{hostId:(${n}),conversationId:${n}\}`), 'setter host')
  const [, setterMethod] = uniqueMatch(setterScope, new RegExp(String.raw`\{authMethod:(${n}),hostId:${n}\}`), 'setter auth')

  const select = uniqueMatch(source, new RegExp(
    String.raw`select:\(\{data:(${n})\}\)=>(${n})\((\{additionalAvailableModels:new Set\(${n}\),apiKeyDaybreakSupported:[^{}]*?useHiddenModels:[\w$.]+\})\)`), 'models')
  const query = lastCapture(source.slice(Math.max(0, select.index - 4000), select.index),
    /\(\{additionalAvailableModels:[^{}]*?\}/, 'models query')[0]
  const field = (name) => new RegExp(String.raw`[{,]${name}:(${n})[,}]`).exec(query)?.[1]
  const [selectHost, selectMethod, selectUltra] = [field('hostId'), field('authMethod'), field('includeUltraReasoningEffort')]
  if (!selectHost || !selectMethod || !selectUltra) {
    throw new ConnectionError('This Codex build does not support the native Fast adapter (models query).')
  }

  const edits = [
    [access, `let ${access[1]}=window.__yisamaNativeFast?.access(${accessHost},${accessMethod})??${access[2]}` +
      access[0].slice(`let ${access[1]}=${access[2]}`.length)],
    [setter, `serviceTierAccess:${setter[1]},serviceTierSettings:${setter[2]},` +
      `setServiceTier:window.__yisamaNativeFast?.wrap(${setterHost},${setterMethod},${setter[3]})??${setter[3]}}`],
    [select, `select:({data:${select[1]}})=>{const yisamaOptions=${select[3]};return ${select[2]}(` +
      `window.__yisamaNativeFast?.modelOptions(${selectHost},${selectMethod},yisamaOptions,${selectUltra})??yisamaOptions)}`],
  ].sort((a, b) => b[0].index - a[0].index)
  let patched = source
  for (const [match, replacement] of edits) {
    patched = patched.slice(0, match.index) + replacement + patched.slice(match.index + match[0].length)
  }
  return patched + '\nwindow.__yisamaNativeFastSourceReady=true;window.__yisamaNativeReasoningSourceReady=true;\n'
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
      return !disposed && ((authorization?.fastAvailable === true && window.__yisamaNativeFastSourceReady !== true) ||
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

export async function restartCodex(spawnChild = spawn) {
  const launcher = fileURLToPath(new URL('./launch-codex.ps1', import.meta.url))
  const child = spawnChild(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher, '-Restart'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
  await once(child, 'spawn')
  child.unref()
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
  const deferred = []
  const run = (payload) => {
    const request = parseRequest(payload)
    if (!request) return Promise.resolve(null)
    pending++
    const result = queue.then(async () => {
      try {
        return { id: request.id, ok: true, data: await handler(request) }
      } catch (error) {
        return { id: request.id, ok: false, error: safeError(error),
          ...(publicErrorCode(error) ? { code: publicErrorCode(error) } : {}) }
      }
    })
    queue = result.then(() => { pending-- }, () => { pending-- })
    return result
  }
  const request = (payload) => {
    if (!quiesced) return run(payload)
    return new Promise((resolve) => deferred.push(() => resolve(run(payload))))
  }
  request.isIdle = () => pending === 0 && deferred.length === 0
  request.drain = () => queue
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
      if (!NATIVE_FAST_ASSET_URL.test(params.request.url) || params.responseStatusCode !== 200) {
        throw new ConnectionError('The native Fast module could not be adapted.')
      }
      const response = await this.connection.call('Fetch.getResponseBody', { requestId: params.requestId })
      const source = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
      const patched = adaptNativeFastSource(source)
      await this.connection.call('Fetch.fulfillRequest', {
        requestId: params.requestId, responseCode: 200,
        responseHeaders: (params.responseHeaders || []).filter((header) =>
          !['content-length', 'content-encoding'].includes(header.name.toLowerCase())),
        body: Buffer.from(patched).toString('base64'),
      })
    } catch (error) {
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
    const response = await this.request(payload)
    if (!response || this.disposed || !this.allowed || executionContextId !== this.topContext()) return
    if (response.ok && parseRequest(payload)?.action === 'restore') {
      this.restoreSync = { version: `restore-${crypto.randomUUID()}`, models: null }
    }
    await this.connection.call('Runtime.evaluate', {
      expression: `if (window === window.top && location.href === ${JSON.stringify(CODEX_PAGE)}) {
        window.__yisamaNativeFast?.receive(${JSON.stringify(response)});
        window.__yisamaInfiniteAssistant?.receive(${JSON.stringify(response)});
      }`,
      contextId: executionContextId,
      returnByValue: true,
    })
  }

  async syncModels(settings) {
    if (this.disposed || !this.allowed || !this.topContext()) return null
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(${syncNativeModels.toString()})(${JSON.stringify(settings)})`,
      contextId: this.topContext(), returnByValue: true, awaitPromise: true,
    }, { timeoutMs: 45000 })
    if (result.exceptionDetails) throw new ConnectionError('Native model synchronization failed.')
    const synced = result.result?.value
    if (synced?.reloadNativeFast === true) {
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
      this.nativeFastReloadAttempted = true
      await this.connection.call('Page.reload', { ignoreCache: true })
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
      patterns: [{ urlPattern: NATIVE_FAST_ASSET, requestStage: 'Response' }],
    })
    const source = `${makeAssistantScript()}\n;(${installNativeFast.toString()})();`
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
  readEndpoint = async (file) => JSON.parse(await fs.readFile(file, 'utf8')),
  connectionFactory = (url, onEvent) => new CdpConnection(url, onEvent),
  nativeConfiguration = handler === handleRequest ? desktopNativeConfiguration : async () => null,
  onNativeSynced = nativeConfiguration === desktopNativeConfiguration ? desktopNativeSynced : async () => {} } = {}) {
  const clients = new Map()
  // Taking over Codex only applies after a restart, so the assistant restarts Codex itself
  // shortly after the panel has shown the takeover reply.
  let restartCodexAt = 0
  const request = createRequestQueue(async (command) => {
    const data = await handler(command)
    if (command.action === 'reconfigure') restartCodexAt = Date.now() + restartDelayMs
    return data
  })
  let generation = validateUpdateMarker(await readUpdate(updateFile))?.generation || null
  let ready = false
  let lastFailure = ''
  try {
    while (!signal?.aborted && isRunning(processId)) {
      let reloading = false
      if (restartCodexAt && Date.now() >= restartCodexAt && request.isIdle() &&
        [...clients.values()].every((client) => client.isIdle())) return { restartCodex: true }
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
        if (request.isIdle() && [...clients.values()].every((client) => client.isIdle())) {
          const settings = await nativeConfiguration() || [...clients.values()].find((client) => client.restoreSync)?.restoreSync
          if (!settings) for (const client of clients.values()) await client.syncModels(null)
          if (settings) {
            request.quiesce()
            try {
              await request.drain()
              let allSynced = true
              for (const client of clients.values()) {
                const synced = await client.syncModels(settings)
                if (synced?.status === 'synced') client.restoreSync = null
                else allSynced = false
              }
              if (allSynced) await onNativeSynced(settings.version)
            } finally {
              request.resume()
            }
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

// Serialized into the renderer. Re-authentication with the current key refreshes
// the model catalog without restarting the local app-server or interrupting chats.
export async function syncNativeModels(settings, options = {}) {
  if (window.top !== window || (location.href !== 'app://-/index.html' && options.allowTestLocation !== true)) return null
  const runtime = window.__yisamaInfiniteAssistant
  if (!runtime || !window.electronBridge?.sendMessageFromView) return { status: 'unavailable' }
  const fast = window.__yisamaNativeFast
  if (!settings) {
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
    if (window.__yisamaNativeAdapterUnsupported === true) {
      runtime.nativeStatus?.('unsupported')
      return { status: 'synced' }
    }
    if (!fast?.needsReload?.()) {
      runtime.nativeStatus?.('synced')
      return { status: 'synced' }
    }
    runtime.nativeStatus?.('pending')
    const hasUnsentChanges = () => {
      const panel = runtime.snapshot?.()
      return panel?.open || panel?.setupPending || [...document.querySelectorAll(
        '[contenteditable=true],textarea,input:not([type]),input[type=text],input[type=password],input[type=email]',
      )].some((node) => node.isContentEditable ? node.textContent.trim() : node.value?.trim())
    }
    if (hasUnsentChanges()) return { status: 'pending' }
    let cursor = null
    do {
      const loaded = await rpc('thread/loaded/list', { cursor, limit: 100 })
      for (const threadId of loaded.data) {
        const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
        if (thread.status?.type !== 'idle') return { status: 'pending' }
      }
      cursor = loaded.nextCursor
    } while (cursor)
    return hasUnsentChanges() ? { status: 'pending' } : { status: 'pending', reloadNativeFast: true }
  }
  let stage = 'authentication'
  try {
    const auth = await rpc('getAuthStatus', { includeToken: true, refreshToken: false })
    if (auth?.isLoading || auth?.authMethod == null) return { status: 'pending' }
    if (auth?.authMethod !== 'apikey' || typeof auth.authToken !== 'string' ||
      auth.authToken.length < 8) throw new Error('Native authentication unavailable.')
    if (typeof settings.apiKey === 'string' && settings.apiKey !== auth.authToken) {
      fast?.authorize(null)
      window.__yisamaNativeModelSync = { version: settings.version, status: 'account-change',
        nextCheckAt: Date.now() + 5000 }
      runtime.nativeStatus?.('account-change')
      return { status: 'account-change' }
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
      await rpc('account/login/start', { type: 'apiKey', apiKey: auth.authToken })
      const catalog = []
      let cursor = null
      do {
        const response = await rpc('model/list', { cursor, includeHidden: true, limit: 100 })
        catalog.push(...response.data)
        cursor = response.nextCursor
      } while (cursor)
      models = catalog.map((model) => model.model)
      if (Array.isArray(settings.models) && (models.length !== settings.models.length ||
        settings.models.some((model) => !models.includes(model)))) {
        throw new Error('Native model catalog did not change.')
      }
      if (settings.modelSettings && settings.provider) {
        stage = 'service-tiers'
        for (const model of catalog) {
          const expected = settings.modelSettings[model.model]
          const supported = expected?.fastAvailable ?? Boolean(expected?.serviceTier)
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
      if (result?.restartCodex && !stop.signal.aborted) await restartCodex()
    }
  } catch (error) {
    console.error(connectionMessage(error))
    process.exitCode = 1
  }
}
