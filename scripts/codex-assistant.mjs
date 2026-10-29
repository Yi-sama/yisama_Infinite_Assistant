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
import { safeError, publicErrorCode, desktopNativeConfiguration } from './yisama.mjs'

export const CODEX_PAGE = 'app://-/index.html'
const BINDING = 'yisamaAssistantCommand'
const ASSISTANT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const UPDATE_FILE = path.join(ASSISTANT_ROOT, 'update.json')

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
    if (event.method === 'Runtime.executionContextCreated') {
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

  async reloadState() {
    if (this.disposed || !this.allowed || !this.topContext()) return null
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(() => {
        const runtime = window.__yisamaInfiniteAssistant;
        const state = runtime?.snapshot?.();
        const root = document.getElementById('yisama-infinite-assistant-ui');
        if (!state || !root) return { open: false, busy: false, unsent: false };
        const value = (testId) => root.querySelector('[data-testid="' + testId + '"]')?.value || '';
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
        window.__yisamaInfiniteAssistant?.receive(${JSON.stringify(response)});
      }`,
      contextId: executionContextId,
      returnByValue: true,
    })
  }

  async syncModels(settings) {
    if (!settings || this.disposed || !this.allowed || !this.topContext()) return null
    const result = await this.connection.call('Runtime.evaluate', {
      expression: `(${syncNativeModels.toString()})(${JSON.stringify(settings)})`,
      contextId: this.topContext(), returnByValue: true, awaitPromise: true,
    }, { timeoutMs: 45000 })
    if (result.exceptionDetails) throw new ConnectionError('Native model synchronization failed.')
    return result.result?.value
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
    const source = makeAssistantScript()
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
        if (this.scriptId) {
          await this.connection.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId })
        }
        await this.connection.call('Runtime.evaluate', { expression: REMOVE_ASSISTANT_SCRIPT })
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
  }, onReady = () => {}, report = console.error, pollMs = 2000, updateFile = UPDATE_FILE,
  readUpdate = readUpdateMarker, reloadCheck = shouldReload,
  readEndpoint = async (file) => JSON.parse(await fs.readFile(file, 'utf8')),
  connectionFactory = (url, onEvent) => new CdpConnection(url, onEvent),
  nativeConfiguration = handler === handleRequest ? desktopNativeConfiguration : async () => null } = {}) {
  const clients = new Map()
  const request = createRequestQueue(handler)
  let generation = validateUpdateMarker(await readUpdate(updateFile))?.generation || null
  let ready = false
  let lastFailure = ''
  try {
    while (!signal?.aborted && isRunning(processId)) {
      let reloading = false
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
          if (settings) {
            request.quiesce()
            try {
              await request.drain()
              for (const client of clients.values()) {
                const synced = await client.syncModels(settings)
                if (synced?.status === 'synced') client.restoreSync = null
              }
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
  const previous = window.__yisamaNativeModelSync
  if (previous?.version === settings.version && previous.status === 'error') {
    runtime.nativeStatus?.('error')
    return { status: 'error' }
  }
  if (previous?.version === settings.version && previous.nextCheckAt > Date.now()) return { status: 'pending' }
  if (previous?.version === settings.version && previous.status === 'synced') {
    runtime.nativeStatus?.('synced')
    return { status: 'synced' }
  }
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
  try {
    const auth = await rpc('getAuthStatus', { includeToken: true, refreshToken: false })
    if (auth?.authMethod !== 'apikey' || typeof auth.authToken !== 'string' ||
      auth.authToken.length < 8) throw new Error('Native authentication unavailable.')
    if (typeof settings.apiKey === 'string' && settings.apiKey !== auth.authToken) {
      window.__yisamaNativeModelSync = { version: settings.version, status: 'account-change',
        nextCheckAt: Date.now() + 5000 }
      runtime.nativeStatus?.('account-change')
      return { status: 'account-change' }
    }
    let queryClient
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
    if (!queryClient) throw new Error('Native query cache unavailable.')
    runtime.nativeStatus?.('syncing')
    await rpc('account/login/start', { type: 'apiKey', apiKey: auth.authToken })
    const models = []
    let cursor = null
    do {
      const response = await rpc('model/list', { cursor, includeHidden: true, limit: 100 })
      models.push(...response.data.map((model) => model.model))
      cursor = response.nextCursor
    } while (cursor)
    if (Array.isArray(settings.models) && (models.length !== settings.models.length ||
      settings.models.some((model) => !models.includes(model)))) {
      throw new Error('Native model catalog did not change.')
    }
    await queryClient.invalidateQueries({
      predicate: (query) => ['models', 'config', 'user-saved-config'].includes(query.queryKey[0]),
    })
    window.__yisamaNativeModelSync = { version: settings.version, status: 'synced' }
    runtime.nativeStatus?.('synced')
    return { status: 'synced' }
  } catch {
    window.__yisamaNativeModelSync = { version: settings.version, status: 'error' }
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
    }
  } catch (error) {
    console.error(connectionMessage(error))
    process.exitCode = 1
  }
}
