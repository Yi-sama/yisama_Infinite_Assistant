import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import {
  adaptNativeFastSource, installNativeFast, syncNativeModels, allowedTarget, AssistantTarget, CdpConnection, CODEX_PAGE, codexStartedAt, createRequestQueue, readUpdateMarker,
  restartAssistant, restartCodex, runAssistant, shouldReload, validateEndpoint, validateUpdateMarker,
} from './codex-assistant.mjs'

const generation = (letter) => letter.repeat(64)
const marker = (letter) => ({ generation: generation(letter), updatedAt: '2026-10-29T02:30:00.000Z' })
const closedPanel = () => ({ open: false, busy: false, unsent: false })

// Shapes copied from the Codex 26.1021 bundle; 26.1016 differs only in minified names.
const nativeSourceFor = ({ access = 'Jlo', setter = 'P', models = 'Vso' } = {}) => `function ${access}(e){let t=c(10),r=e.hostId,o=e.authMethod,s;s={authMethod:o,hostId:r};let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}
function _fo(e,t,n,r,i){let l=g(e),u=l.hostId,d={hostId:u,conversationId:e},b=h(u),S=b?.authMethod??null,C={authMethod:S,hostId:x};return {hasManagedNewThreadSettings:I,hostId:L,serviceTierAccess:R,serviceTierSettings:z,setServiceTier:${setter}}}
var D2=Sc(J,({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o},{get:d})=>({select:({data:n})=>${models}({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:_,authMethod:t,availableModels:b.availableModels,defaultModel:b.defaultModel,enabledReasoningEfforts:y,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:x,isCustomModelProvider:o,models:n,useHiddenModels:b.useHiddenModels})}))`
const nativeSource = nativeSourceFor()

test('native controls adapt only the inspected hook sites and reject missing or repeated matches', () => {
  const adapted = adaptNativeFastSource(nativeSource)
  assert.match(adapted, /__yisamaNativeFast\?\.access\(r,o\)\?\?d,p;/)
  assert.match(adapted, /__yisamaNativeFast\?\.wrap\(u,S,P\)\?\?P\}/)
  assert.match(adapted, /__yisamaNativeFastSourceReady=true/)
  assert.match(adapted, /__yisamaNativeReasoningSourceReady=true/)
  assert.match(adapted, /return Vso\(window\.__yisamaNativeFast\?\.modelOptions\(i,t,yisamaOptions,a\)/)
  assert.doesNotThrow(() => new Function(adapted))
  for (const source of ['', nativeSource + nativeSource, nativeSource.replace('isLoading:u', 'loading:u'),
    nativeSource.replace(',conversationId:e', ''), nativeSource.replace('hostId:i,', ''),
    nativeSource.replace('setServiceTier:P}', 'setServiceTier:P()}'), nativeSource.replace('select:', 'pick:')]) {
    assert.throws(() => adaptNativeFastSource(source), /does not support/)
  }
})

test('native controls follow renamed minified identifiers in other Codex builds', () => {
  const adapted = adaptNativeFastSource(nativeSourceFor({ access: '_Lo', setter: 'F', models: 'eIo' }))
  assert.match(adapted, /__yisamaNativeFast\?\.access\(r,o\)\?\?d,p;/)
  assert.match(adapted, /__yisamaNativeFast\?\.wrap\(u,S,F\)\?\?F\}/)
  assert.match(adapted, /return eIo\(window\.__yisamaNativeFast\?\.modelOptions\(i,t,yisamaOptions,a\)/)
  assert.doesNotThrow(() => new Function(adapted))
})

function fastFixture({ serverFailure = false, nativeFailure = false, ownAuth = true, serverDelay = 0 } = {}) {
  const listeners = new Set()
  const calls = []
  const authCalls = []
  const key = 'sk-isolated-native-fast-test-only'
  const window = {
    __yisamaNativeFastSourceReady: true,
    __yisamaNativeReasoningSourceReady: true,
    __yisamaInfiniteAssistant: { nativeStatus: (status) => calls.push({ status }) },
    setTimeout, clearTimeout,
    addEventListener(_name, listener) { listeners.add(listener) },
    removeEventListener(_name, listener) { listeners.delete(listener) },
    electronBridge: { async sendMessageFromView({ request }) {
      authCalls.push(request.method)
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data: { type: 'mcp-response', hostId: 'local',
          message: { id: request.id, result: { authMethod: 'apikey', authToken: ownAuth ? key : 'sk-other-account' } },
        } })
      })
    } },
    yisamaAssistantCommand(payload) {
      const request = JSON.parse(payload)
      calls.push(request)
      const reply = () => window.__yisamaNativeFast.receive({
        id: request.id, ok: !serverFailure, data: { enabled: request.enabled },
      })
      if (serverDelay > 0) setTimeout(reply, serverDelay)
      else queueMicrotask(reply)
    },
  }
  window.top = window
  runInNewContext(`(${installNativeFast.toString()})()`, {
    window, location: { href: CODEX_PAGE }, crypto: webcrypto, TextEncoder, Uint32Array, Uint8Array,
  })
  const controller = window.__yisamaNativeFast
  controller.authorize({ apiKey: key, fastAvailable: true, fastEnabled: true })
  const native = async (tier, source) => {
    calls.push({ nativeTier: tier, source })
    return !nativeFailure
  }
  return { window, controller, native, calls, authCalls, key }
}

test('native Fast updates the native UI before the server and preserves native account access', async () => {
  const { controller, native, calls, authCalls, key, window } = fastFixture()
  assert.equal(controller.access('local', 'apikey')?.fast, true)
  assert.equal(controller.access('local', 'chatgpt'), null)
  assert.equal(controller.access('remote', 'apikey'), null)
  assert.equal(controller.wrap('local', 'chatgpt', native), native)
  const wrapped = controller.wrap('local', 'apikey', native)
  assert.equal(controller.wrap('local', 'apikey', native), wrapped)
  assert.equal(await wrapped(null, 'composer_menu'), true)
  await delay(50)
  assert.equal(calls[0].nativeTier, null)
  const firstServerCall = calls.find((call) => call.action === 'fast')
  assert.equal(firstServerCall.enabled, false)
  assert.equal(firstServerCall.keyFingerprint, createHash('sha256').update(key).digest('hex'))
  assert.deepEqual(authCalls, ['getAuthStatus'])
  assert.equal(JSON.stringify(calls).includes(key), false)
  assert.equal(await wrapped('priority', 'composer_menu'), true)
  await delay(10)
  assert.equal(calls.findLast((call) => call.action === 'fast').enabled, true)
  assert.equal(calls.findLast((call) => Object.hasOwn(call, 'nativeTier')).nativeTier, 'priority')
  window.__yisamaNativeFastSourceReady = false
  assert.equal(controller.access('local', 'apikey'), null)
  controller.dispose()
})

test('native Fast rolls the optimistic native setting back when server confirmation fails', async () => {
  for (const options of [{ serverFailure: true }, { nativeFailure: true }, { ownAuth: false }]) {
    const { controller, native, calls } = fastFixture(options)
    const result = await controller.wrap('local', 'apikey', native)(null, 'composer_menu')
    await delay(50)
    assert.equal(result, true)
    const changes = calls.filter((call) => call.action === 'fast')
    assert.deepEqual(changes.map((call) => call.enabled),
      options.ownAuth === false || options.nativeFailure ? [] : [false])
    assert.equal(calls.filter((call) => Object.hasOwn(call, 'nativeTier')).length,
      2)
    assert.equal(calls.at(-1).status, 'error')
    controller.dispose()
  }
})

test('native Fast rejects a synchronous native setter failure before painting', async () => {
  const { controller, calls } = fastFixture()
  const native = () => false
  assert.equal(await controller.wrap('local', 'apikey', native)(null, 'composer_menu'), false)
  assert.equal(calls.some((call) => call.action === 'fast'), false)
  assert.equal(controller.isBusy(), false)
  controller.dispose()
})

test('native Fast returns before a delayed server confirmation completes', async () => {
  const { controller, native, calls } = fastFixture({ serverDelay: 40 })
  assert.equal(await controller.wrap('local', 'apikey', native)(null, 'composer_menu'), true)
  assert.equal(calls[0].nativeTier, null)
  assert.equal(controller.isBusy(), true)
  await delay(60)
  assert.equal(controller.isBusy(), false)
  assert.equal(calls.find((call) => call.action === 'fast').enabled, false)
  controller.dispose()
})

test('native Fast returns before delayed native persistence completes', async () => {
  const { controller, calls } = fastFixture()
  const native = (tier, source) => new Promise((resolve) => {
    calls.push({ nativeTier: tier, source })
    setTimeout(() => resolve(true), 60)
  })
  const started = Date.now()
  assert.equal(await controller.wrap('local', 'apikey', native)(null, 'composer_menu'), true)
  assert.ok(Date.now() - started < 40, 'the picker must not wait for native persistence')
  assert.equal(calls[0].nativeTier, null)
  assert.equal(calls.some((call) => call.action === 'fast'), false)
  assert.equal(controller.isBusy(), true)
  await delay(90)
  assert.equal(calls.find((call) => call.action === 'fast').enabled, false)
  assert.equal(controller.isBusy(), false)
  controller.dispose()
})

test('native Fast does not alter an unowned API provider or enable Ultra Fast', async () => {
  const { controller, native, calls } = fastFixture()
  const wrapped = controller.wrap('local', 'apikey', native)
  assert.equal(await wrapped('ultrafast', 'composer_menu'), false)
  assert.equal(calls.length, 0)
  controller.authorize(null)
  assert.equal(await wrapped(null, 'composer_menu'), true)
  assert.deepEqual(calls, [{ nativeTier: null, source: 'composer_menu' }])
  controller.dispose()
})

test('native reasoning exposes catalog-backed Max and Ultra without Fast or changing original preferences', () => {
  const { controller, window } = fastFixture()
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const model = { model: 'gpt-6.1-sol',
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) }
  const original = { enabledReasoningEfforts: new Set(efforts.slice(0, 4)),
    includeUltraReasoningEffort: false, models: [model] }
  controller.authorize({ provider: 'yisama', fastAvailable: false,
    modelSettings: { [model.model]: { reasoningEfforts: efforts } } })
  const actual = controller.modelOptions('local', 'apikey', original)
  assert.deepEqual([...actual.enabledReasoningEfforts], efforts)
  assert.equal(actual.includeUltraReasoningEffort, true)
  assert.deepEqual([...actual.models[0].supportedReasoningEfforts].map(({ reasoningEffort }) => reasoningEffort), efforts)
  assert.deepEqual([...original.enabledReasoningEfforts], efforts.slice(0, 4))
  assert.equal(original.includeUltraReasoningEffort, false)
  assert.equal(controller.modelOptions('local', 'apikey', original, false).includeUltraReasoningEffort, false)
  assert.equal(controller.access('local', 'apikey'), null)
  window.__yisamaNativeReasoningSourceReady = false
  assert.equal(controller.needsReload(), true, 'reasoning adaptation must load even when Fast is unavailable')
  window.__yisamaNativeReasoningSourceReady = true
  assert.equal(controller.needsReload(), false)
  assert.equal(controller.modelOptions('remote', 'apikey', original), original)
  assert.equal(controller.modelOptions('local', 'chatgpt', original), original)
  controller.authorize({ provider: 'yisama', modelSettings: {} })
  const nativeFourLevel = { ...original, models: [{ ...model,
    supportedReasoningEfforts: efforts.slice(0, 4).map((reasoningEffort) => ({ reasoningEffort })) }] }
  assert.deepEqual([...controller.modelOptions('local', 'apikey', nativeFourLevel).enabledReasoningEfforts],
    efforts.slice(0, 4), 'unsupported catalog levels must not be invented')
  controller.authorize({ provider: 'yisama', fastAvailable: false,
    modelSettings: { claude: { reasoningEfforts: ['low', 'medium', 'high'] } } })
  const nonGpt = { enabledReasoningEfforts: new Set(), includeUltraReasoningEffort: false,
    models: [{ model: 'claude', supportedReasoningEfforts: [] }] }
  const nonGptOptions = controller.modelOptions('local', 'apikey', nonGpt)
  assert.deepEqual([...nonGptOptions.enabledReasoningEfforts],
    ['low', 'medium', 'high'], 'catalog-backed reasoning levels must work for non-GPT models')
  assert.deepEqual([...nonGptOptions.models[0].supportedReasoningEfforts].map(({ reasoningEffort }) => reasoningEffort),
    ['low', 'medium', 'high'], 'catalog-backed reasoning levels must be attached to non-GPT models')
  controller.authorize({ provider: 'yisama', modelSettings: {} })
  const nativeNonGpt = { enabledReasoningEfforts: new Set(), includeUltraReasoningEffort: false,
    models: [{ model: 'claude', supportedReasoningEfforts: ['low', 'medium', 'high']
      .map((reasoningEffort) => ({ reasoningEffort })) }] }
  assert.deepEqual([...controller.modelOptions('local', 'apikey', nativeNonGpt).enabledReasoningEfforts],
    ['low', 'medium', 'high'], 'native non-GPT reasoning metadata must remain selectable')
  controller.authorize(null)
  assert.equal(controller.modelOptions('local', 'apikey', original), original)
  controller.dispose()
})

function nativeSyncFixture() {
  const listeners = new Set()
  const calls = []
  const state = { mounted: true, queryReady: true, loading: false, draft: '', panelOpen: false,
    active: false, needsReload: true, catalog: [], invalidations: 0, updates: [] }
  const settings = { version: 'test', apiKey: 'sk-native-test-only', provider: 'yisama', fastAvailable: true }
  const props = { client: { getQueryCache() {}, async invalidateQueries() { state.invalidations++ } } }
  const root = { get memoizedProps() { return state.queryReady ? props : null } }
  const window = {
    __yisamaInfiniteAssistant: { nativeStatus() {}, snapshot: () => ({ open: state.panelOpen }) },
    __codexRoot: { _internalRoot: { get current() { return state.mounted ? root : null } } },
    __yisamaNativeFast: {
      authorize(value) { state.authorized = Boolean(value) },
      isBusy: () => false,
      needsReload: () => state.needsReload,
    },
    addEventListener(_name, listener) { listeners.add(listener) },
    removeEventListener(_name, listener) { listeners.delete(listener) },
    electronBridge: { async sendMessageFromView({ request }) {
      calls.push(request.method)
      if (request.method === 'thread/settings/update') state.updates.push(request.params)
      const result = request.method === 'getAuthStatus'
        ? state.loading ? { authMethod: null, isLoading: true }
          : { authMethod: 'apikey', authToken: state.authToken ?? settings.apiKey }
        : request.method === 'model/list' ? { data: state.catalog, nextCursor: null }
          : request.method === 'thread/loaded/list' ? { data: Object.keys(state.threads || { 'test-thread': {} }), nextCursor: null }
            : request.method === 'thread/read'
              ? { thread: state.threads?.[request.params.threadId] || { status: { type: state.active ? 'active' : 'idle' } } } : {}
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data: { type: 'mcp-response', hostId: 'local',
          message: { id: request.id, result,
            ...(state.failMethod === request.method ? { error: { message: 'isolated failure' } } : {}) } } })
      })
    } },
  }
  window.top = window
  const sync = () => runInNewContext(`(${syncNativeModels.toString()})(settings)`, {
    window, location: { href: CODEX_PAGE }, settings, crypto: webcrypto, setTimeout, clearTimeout,
    document: { querySelectorAll: () => [{ isContentEditable: true, get textContent() { return state.draft } }] },
  })
  return { state, window, calls, sync, settings }
}

test('native Fast waits for initial mount and authentication without caching a startup error', async () => {
  const { state, window, sync, calls } = nativeSyncFixture()
  state.mounted = false
  assert.equal((await sync()).status, 'pending')
  assert.equal(calls.length, 0)
  state.mounted = true
  state.loading = true
  assert.equal((await sync()).status, 'pending')
  assert.equal(window.__yisamaNativeModelSync, undefined)
  state.loading = false
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
})

test('renderer reload waits for the native query provider before starting catalog synchronization', async () => {
  const { state, window, calls, sync } = nativeSyncFixture()
  state.queryReady = false
  assert.equal((await sync()).status, 'pending')
  assert.equal(window.__yisamaNativeModelSync, undefined)
  assert.deepEqual(calls, ['getAuthStatus'], 'a mounted React root does not mean its query provider is ready')
  state.queryReady = true
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 1)
})

test('a new synchronization revision recovers old startup errors but does not retry genuine catalog failures', async () => {
  const { state, window, calls, sync, settings } = nativeSyncFixture()
  window.__yisamaNativeModelSync = { version: 'old-revision', status: 'error', stage: 'query-cache' }
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
  settings.version = 'catalog-failure-revision'
  settings.models = ['missing-catalog-model']
  assert.equal((await sync()).status, 'error')
  assert.equal(window.__yisamaNativeModelSync.stage, 'catalog')
  const before = calls.length
  assert.equal((await sync()).status, 'error')
  assert.equal(calls.length, before, 'real failures remain errors rather than causing repeated login requests')
})

test('Fast-only synchronization preserves the catalog, query cache, and owned threads', async () => {
  const { state, window, calls, sync, settings } = nativeSyncFixture()
  state.needsReload = false
  Object.assign(settings, {
    catalogVersion: 'catalog-a', model: 'gpt-owned', models: ['gpt-owned'], fastEnabled: true,
    modelSettings: { 'gpt-owned': { fastAvailable: true, serviceTier: 'priority', effort: 'high' } },
  })
  state.catalog = [{ model: 'gpt-owned', serviceTiers: [{ id: 'priority' }], defaultServiceTier: 'priority' }]
  state.threads = {
    owned: { modelProvider: 'yisama', model: 'gpt-owned', status: { type: 'active' } },
    foreign: { modelProvider: 'personal', model: 'gpt-personal' },
  }
  assert.equal((await sync()).status, 'synced')
  for (const [index, serviceTier] of [null, 'priority', null].entries()) {
    settings.version = `tier-${index}`
    settings.fastEnabled = serviceTier === 'priority'
    settings.modelSettings['gpt-owned'].serviceTier = serviceTier
    const result = await sync()
    assert.equal(result.status, 'synced')
    assert.equal(result.reloadNativeFast, undefined)
    assert.equal(state.updates.length, 1, 'a Fast click must not walk every loaded thread')
    assert.equal(calls.filter((method) => method === 'account/login/start').length, 1,
      'a Fast click must not log in again')
    assert.equal(calls.filter((method) => method === 'model/list').length, 1)
    assert.equal(state.invalidations, 1, 'a Fast click must not refetch models or invalidate the config cache')
  }
  assert.equal(state.updates.length, 1, 'other providers are never updated')
  assert.equal(calls.filter((method) => method === 'getAuthStatus').length, 4)
  assert.equal(window.__yisamaNativeModelSync.catalogVersion, settings.catalogVersion)
  settings.catalogVersion = 'catalog-b'
  settings.version = 'catalog-b'
  assert.equal((await sync()).status, 'synced')
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 2,
    'an actual route or catalog change still requires full synchronization')
  assert.equal(state.invalidations, 2)
  assert.equal(state.updates.length, 2, 'a real catalog change still reconciles owned threads')
  assert.deepEqual({ ...state.updates.at(-1) },
    { threadId: 'owned', model: 'gpt-owned', serviceTier: null })

  settings.catalogVersion = 'catalog-failure'
  settings.version = 'failed-tier-change'
  state.failMethod = 'thread/settings/update'
  assert.equal((await sync()).status, 'error')
  assert.equal(window.__yisamaNativeModelSync.stage, 'thread-settings')
  const failedCalls = calls.length
  assert.equal((await sync()).status, 'error')
  assert.equal(calls.length, failedCalls, 'failed tier updates must not become a retry loop')
  state.failMethod = null
  state.authToken = 'sk-foreign-native-account'
  settings.version = 'foreign-account'
  const updates = state.updates.length
  assert.equal((await sync()).status, 'account-change')
  assert.equal(state.updates.length, updates)
  assert.equal(state.authorized, false)
})

test('Fast-only revisions do not scan active sessions when native controls are already loaded', async () => {
  const { state, window, calls, sync, settings } = nativeSyncFixture()
  window.__yisamaNativeFastSourceReady = true
  window.__yisamaNativeReasoningSourceReady = true
  state.needsReload = true
  Object.assign(settings, {
    catalogVersion: 'catalog-a',
    model: 'gpt-owned',
    models: ['gpt-owned'],
    fastEnabled: true,
    modelSettings: { 'gpt-owned': { fastAvailable: true, serviceTier: 'priority', effort: 'high' } },
  })
  state.threads = {
    active: { modelProvider: 'yisama', model: 'gpt-owned', status: { type: 'active' } },
  }
  window.__yisamaNativeModelSync = {
    version: 'before-fast', catalogVersion: 'catalog-a', status: 'synced',
  }
  settings.version = 'after-fast'

  assert.equal((await sync()).status, 'synced')
  assert.deepEqual(calls, ['getAuthStatus'])
  assert.deepEqual(state.updates, [])
})

test('catalog switches preserve a thread model that is temporarily outside the group', async () => {
  const { state, sync, settings } = nativeSyncFixture()
  state.needsReload = false
  state.threads = { conversation: { modelProvider: 'yisama', model: 'gpt-owned' } }
  state.catalog = [{ model: 'gpt-owned', serviceTiers: [], defaultServiceTier: null }]
  Object.assign(settings, {
    catalogVersion: 'group-a', version: 'group-a', model: 'gpt-owned', models: ['gpt-owned'],
    modelSettings: { 'gpt-owned': { serviceTier: null, effort: 'high' } },
  })
  assert.equal((await sync()).status, 'synced')

  state.catalog = [{ model: 'claude-owned', serviceTiers: [], defaultServiceTier: null }]
  Object.assign(settings, {
    catalogVersion: 'group-b', version: 'group-b', model: 'claude-owned', models: ['claude-owned'],
    modelSettings: { 'claude-owned': { serviceTier: null, effort: 'none' } },
  })
  const beforeUnavailableSwitch = state.updates.length
  assert.equal((await sync()).status, 'synced')
  assert.deepEqual(state.updates.slice(beforeUnavailableSwitch), [],
    'an unavailable thread model must not receive a replacement settings update')
  assert.equal(state.threads.conversation.model, 'gpt-owned',
    'an unavailable model must remain on the thread instead of being replaced')

  state.catalog = [{ model: 'gpt-owned', serviceTiers: [], defaultServiceTier: null }]
  Object.assign(settings, {
    catalogVersion: 'group-a-restored', version: 'group-a-restored', model: 'gpt-owned',
    models: ['gpt-owned'], modelSettings: { 'gpt-owned': { serviceTier: null, effort: 'high' } },
  })
  assert.equal((await sync()).status, 'synced')
  assert.equal(state.threads.conversation.model, 'gpt-owned',
    'switching back must recover the original conversation model')
})

test('native Fast requests one initial resource reload only after drafts, panel, and active replies clear', async () => {
  const { state, sync, calls } = nativeSyncFixture()
  for (const field of ['draft', 'panelOpen', 'active']) {
    state[field] = field === 'draft' ? 'unsent' : true
    const result = await sync()
    assert.equal(result.status, 'pending')
    assert.equal(result.reloadNativeFast, undefined)
    state[field] = field === 'draft' ? '' : false
  }
  assert.equal((await sync()).reloadNativeFast, true)
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 1,
    'waiting for safe resource loading must not repeatedly log in')
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
})

test('incompatible native Fast resources cannot cause a renderer reload loop', async () => {
  const calls = []
  const reports = []
  const target = new AssistantTarget({}, null, { report: (message) => reports.push(message), connectionFactory: () => ({
    async call(method, params) {
      calls.push(method)
      if (method === 'Runtime.evaluate' && /__yisamaNativeAdapterUnsupported = true/.test(params.expression)) return {}
      return { result: { value: { status: 'pending', reloadNativeFast: true } } }
    },
  }) })
  target.allowed = true
  target.mainFrameId = 'main'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'main' } })
  assert.equal((await target.syncModels({})).status, 'pending')
  assert.equal((await target.syncModels({})).status, 'synced')
  assert.equal(calls.filter((method) => method === 'Page.reload').length, 1)
  assert.equal(calls.at(-1), 'Runtime.evaluate')
  assert.deepEqual(reports, ['The native model controls did not load. This Codex build may be incompatible.'])
})

test('native asset interception is scoped, removes stale body headers, and releases incompatible modules', async () => {
  const calls = []
  const target = new AssistantTarget({}, null, { connectionFactory: () => ({
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'Fetch.getResponseBody') return { body: nativeSource }
      return {}
    },
  }) })
  await target.adaptNativeScript({ requestId: 'valid', responseStatusCode: 200,
    request: { url: 'app://-/assets/app-initial-ad16eaadf81f.js' },
    responseHeaders: [{ name: 'Content-Length', value: '10' }, { name: 'Content-Type', value: 'text/javascript' }],
  })
  assert.deepEqual(calls.at(-1).params.responseHeaders, [{ name: 'Content-Type', value: 'text/javascript' }])
  assert.equal(Buffer.from(calls.at(-1).params.body, 'base64').toString(), adaptNativeFastSource(nativeSource))
  const before = calls.length
  await assert.rejects(target.adaptNativeScript({ requestId: 'other', responseStatusCode: 200,
    request: { url: 'https://example.com/app-initial-438d1df57f70.js' },
  }), /could not be adapted/)
  assert.deepEqual(calls.slice(before), [{ method: 'Fetch.continueRequest', params: { requestId: 'other' } }])
})

test('replacement detaches from the old helper and waits until spawning succeeds', async () => {
  let unreferenced = false
  await restartAssistant(['--endpoint-file', 'test.json', '--process-id', '7'], (executable, args, options) => {
    assert.equal(executable, process.execPath)
    assert.equal(path.basename(args[0]), 'codex-assistant.mjs')
    assert.deepEqual(args.slice(1), ['--endpoint-file', 'test.json', '--process-id', '7'])
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true })
    const child = new EventEmitter()
    child.unref = () => { unreferenced = true }
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  assert.equal(unreferenced, true)
  await assert.rejects(restartAssistant([], () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('spawn failed')))
    return child
  }), /spawn failed/)
})

test('Codex restart runs the packaged launcher detached with -Restart', async () => {
  let unreferenced = false
  await restartCodex((executable, args, options) => {
    assert.equal(path.basename(executable).toLowerCase(), 'powershell.exe')
    assert.equal(path.basename(args[args.indexOf('-File') + 1]), 'launch-codex.ps1')
    assert.equal(args.at(-1), '-Restart')
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true })
    const child = new EventEmitter()
    child.unref = () => { unreferenced = true }
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  assert.equal(unreferenced, true)
})

test('Codex start time uses the verified desktop PID without WMI or a visible shell', {
  skip: process.platform !== 'win32',
}, async () => {
  const startedAt = await codexStartedAt(4216, async (file, args, options) => {
    assert.equal(file, 'powershell.exe')
    assert.ok(args.includes('-NonInteractive'))
    assert.match(args.at(-1), /Get-Process -Id 4216/)
    assert.equal(options.windowsHide, true)
    return { stdout: '2026-10-29T02:31:12.7108919Z\r\n' }
  })
  assert.equal(startedAt, '2026-10-29T02:31:12.710Z')
  assert.ok(Number.isFinite(Date.parse(await codexStartedAt(process.pid))))
})

function sequence(values) {
  let index = 0
  return async () => values[Math.min(index++, values.length - 1)]
}

function makeConnectionFactory({ state = closedPanel, onEnable, syncStatus } = {}) {
  const connections = []
  return {
    connections,
    factory(_url, onEvent) {
      const calls = []
      const connection = {
        socket: { readyState: WebSocket.OPEN },
        closed: 0,
        async connect() {},
        async call(method, params = {}) {
          calls.push({ method, params })
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: CODEX_PAGE } } }
          if (method === 'Runtime.enable') {
            onEvent({ method: 'Runtime.executionContextCreated',
              params: { context: { id: 1, auxData: { isDefault: true, frameId: 'main' } } } })
            onEnable?.(onEvent)
          }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `script-${connections.length}` }
          if (method === 'Runtime.evaluate' && params.expression.startsWith('(async function syncNativeModels')) {
            return { result: { value: { status: syncStatus } } }
          }
          if (method === 'Runtime.evaluate' && params.expression.includes('const runtime =')) {
            return { result: { value: state() } }
          }
          return {}
        },
        close() { connection.closed++ },
      }
      connection.calls = calls
      connections.push(connection)
      return connection
    },
  }
}

function assistantTarget(id) {
  return { id, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` }
}

function assistantOptions(overrides = {}) {
  return {
    endpointFile: 'test-endpoint.json',
    processId: 7,
    readEndpoint: async () => ({ port: 9222, processId: 7 }),
    discover: async () => [assistantTarget('main')],
    isRunning: () => true,
    nativeConfiguration: async () => null,
    pollMs: 0,
    report: () => {},
    ...overrides,
  }
}

test('assistant accepts only local Codex main-page endpoints', () => {
  const target = { type: 'page', url: CODEX_PAGE,
    webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/page/workspace' }
  assert.deepEqual(validateEndpoint({ port: 41234, processId: 15 }), { port: 41234, processId: 15 })
  for (const value of [null, { port: 0, processId: 15 }, { port: 65536, processId: 15 },
    { port: 41234, processId: -1 }]) assert.throws(() => validateEndpoint(value))
  assert.equal(allowedTarget(target, 41234), true)
  for (const replacement of [
    { url: 'https://api.yisama.asia/login' }, { url: `${CODEX_PAGE}?webview` }, { type: 'iframe' },
    { webSocketDebuggerUrl: 'ws://example.com:41234/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://user@127.0.0.1:41234/devtools/page/workspace' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/workspace' },
  ]) assert.equal(allowedTarget({ ...target, ...replacement }, 41234), false)
})

test('assistant serializes UI actions and rejects malformed commands before the backend', async () => {
  let active = 0
  let maximum = 0
  const calls = []
  const request = createRequestQueue(async (value) => {
    maximum = Math.max(maximum, ++active)
    calls.push(value)
    await delay(5)
    active--
    return { quota: '$12.50' }
  })
  const result = await Promise.all([
    request(JSON.stringify({ id: 1, action: 'login', token: 'must-be-dropped' })),
    request(JSON.stringify({ id: 2, action: 'select', group: 'auto' })),
    request(JSON.stringify({ id: 3, action: 'status' })),
  ])
  assert.equal(maximum, 1)
  assert.deepEqual(calls.map((value) => value.id), [1, 2, 3])
  assert.equal('token' in calls[0], false)
  assert.equal(result[0].data.quota, '$12.50')
  for (const payload of ['not json', '{}', JSON.stringify({ id: 0, action: 'login' }),
    JSON.stringify({ id: 1, action: 'arbitrary-script' }),
    JSON.stringify({ id: 1, action: 'select', group: '' }), 'x'.repeat(16385)]) {
    assert.equal(await request(payload), null)
  }
  assert.equal(calls.length, 3)
})

test('backend errors are safe responses and do not poison later commands', async () => {
  const request = createRequestQueue(async ({ action }) => {
    if (action === 'login') throw new Error('Bearer sk-secret-do-not-render')
    return { loggedIn: false }
  })
  const failure = await request(JSON.stringify({ id: 1, action: 'login' }))
  assert.equal(failure.ok, false)
  assert.doesNotMatch(failure.error, /sk-secret/)
  assert.equal((await request(JSON.stringify({ id: 2, action: 'status' }))).ok, true)
})

test('request queue drains accepted requests before it resumes a quiesced request', async () => {
  let release
  let calls = 0
  const request = createRequestQueue(() => ++calls === 1
    ? new Promise((resolve) => { release = resolve }) : { loggedIn: false })
  const first = request(JSON.stringify({ id: 1, action: 'status' }))
  request.quiesce()
  const later = request(JSON.stringify({ id: 2, action: 'status' }))
  assert.equal(request.isIdle(), false)
  await delay(0)
  release({ loggedIn: false })
  await first
  await request.drain()
  assert.equal(request.isIdle(), false, 'a request arriving during quiesce remains held, not lost')
  request.resume()
  await later
  await request.drain()
  assert.equal(request.isIdle(), true)
})

test('update marker accepts only the updater contract', async () => {
  assert.deepEqual(validateUpdateMarker(marker('a')), marker('a'))
  for (const value of [null, {}, { generation: generation('A'), updatedAt: marker('a').updatedAt },
    { generation: generation('a'), updatedAt: 'not-a-date' }, { generation: generation('a'), updatedAt: '2026' },
    { generation: generation('a') }]) {
    assert.equal(validateUpdateMarker(value), null)
  }
  assert.equal(shouldReload(generation('a'), marker('a')), false)
  assert.equal(shouldReload(null, marker('a')), true)
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-marker-')), 'update.json')
  await fs.writeFile(file, JSON.stringify(marker('b')))
  assert.deepEqual(await readUpdateMarker(file), marker('b'))
  await fs.rm(path.dirname(file), { recursive: true, force: true })
})

test('marker added after startup reloads exactly once after the helper is ready', async () => {
  const { factory } = makeConnectionFactory()
  const ready = []
  const result = await runAssistant(assistantOptions({
    readUpdate: sequence([null, marker('b'), marker('b')]),
    connectionFactory: factory,
    onReady: (value) => ready.push(value),
  }))
  assert.deepEqual(ready, [{ generation: generation('b') }])
  assert.deepEqual(result, { reload: true, generation: generation('b') })
})

test('an open assistant panel delays marker reload until it is closed', async () => {
  let stateChecks = 0
  const { factory } = makeConnectionFactory({ state: () => stateChecks++ === 0
    ? { open: true, busy: false, unsent: false } : closedPanel() })
  const result = await runAssistant(assistantOptions({
    readUpdate: sequence([null, marker('c'), marker('c')]), connectionFactory: factory,
  }))
  assert.equal(result.reload, true)
  assert.equal(stateChecks, 2)
})

test('an in-flight UI reply prevents reload until its response has been sent', async () => {
  let release
  const { factory } = makeConnectionFactory({
    onEnable(onEvent) {
      onEvent({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: JSON.stringify({ id: 1, action: 'status' }), executionContextId: 1,
      } })
    },
  })
  setTimeout(() => release({ loggedIn: false }), 5)
  const result = await runAssistant(assistantOptions({
    handler: () => new Promise((resolve) => { release = resolve }),
    readUpdate: sequence([null, marker('d'), marker('d'), marker('d')]), connectionFactory: factory,
  }))
  assert.equal(result.reload, true)
})

test('a takeover restarts Codex once its reply has been sent', async () => {
  for (const [action, expected] of [['reconfigure', { restartCodex: true }], ['status', undefined]]) {
    const { factory } = makeConnectionFactory({
      onEnable(onEvent) {
        onEvent({ method: 'Runtime.bindingCalled', params: {
          name: 'yisamaAssistantCommand', payload: JSON.stringify({ id: 1, action }), executionContextId: 1,
        } })
      },
    })
    let polls = 0
    const result = await runAssistant(assistantOptions({
      handler: async () => ({ loggedIn: true }), restartDelayMs: 0,
      isRunning: () => ++polls <= 5, connectionFactory: factory,
    }))
    assert.deepEqual(result, expected, action)
  }
})

test('invalid update markers never reload the helper', async () => {
  const { factory } = makeConnectionFactory()
  let polls = 0
  const result = await runAssistant(assistantOptions({
    isRunning: () => ++polls <= 2,
    readUpdate: sequence([marker('e'), { generation: 'bad', updatedAt: 'not-a-date' }]),
    connectionFactory: factory,
  }))
  assert.equal(result, undefined)
})

test('only verified native synchronization acknowledges the pending configuration', async () => {
  for (const syncStatus of ['synced', 'error', 'account-change']) {
    const { factory } = makeConnectionFactory({ syncStatus })
    const acknowledgments = []
    let polls = 0
    await runAssistant(assistantOptions({
      isRunning: () => ++polls <= 1, connectionFactory: factory, readUpdate: async () => null,
      nativeConfiguration: async () => ({ version: 'isolated-native-version', models: ['gpt-5.5'] }),
      onNativeSynced: async (version) => { acknowledgments.push(version) },
    }))
    assert.deepEqual(acknowledgments, syncStatus === 'synced' ? ['isolated-native-version'] : [])
  }
})

test('replacing a target releases old and final CDP connections', async () => {
  const { factory, connections } = makeConnectionFactory()
  let polls = 0
  let discovery = 0
  await runAssistant(assistantOptions({
    isRunning: () => ++polls <= 2,
    discover: async () => [assistantTarget(++discovery === 1 ? 'old' : 'new')],
    readUpdate: sequence([null]), connectionFactory: factory,
  }))
  assert.equal(connections.length, 2)
  for (const connection of connections) {
    assert.equal(connection.closed, 1)
    assert.ok(connection.calls.some((call) => call.method === 'Runtime.removeBinding'))
    assert.ok(connection.calls.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument'))
  }
})

test('CDP forwards only the bounded authentication fields for the corresponding action', async () => {
  const calls = []
  const request = createRequestQueue(async (value) => { calls.push(value); return { loggedIn: false } })
  await request(JSON.stringify({ id: 1, action: 'login', username: 'demo', password: 'password', token: 'drop' }))
  assert.deepEqual(calls[0], { id: 1, action: 'login', username: 'demo', password: 'password' })
  await request(JSON.stringify({ id: 2, action: 'login', loginId: 'challenge', twoFactorCode: '123456' }))
  assert.deepEqual(calls[1], { id: 2, action: 'login', loginId: 'challenge', twoFactorCode: '123456' })
  await request(JSON.stringify({ id: 3, action: 'status', password: 'drop' }))
  assert.deepEqual(calls[2], { id: 3, action: 'status' })
  for (const details of [
    { username: 'demo' }, { password: 'password' }, { loginId: 'challenge' },
    { username: 'demo', password: 'password', loginId: 'challenge', twoFactorCode: '123456' },
    { username: 'demo', password: 'a'.repeat(1025) }, { username: {}, password: 'password' },
  ]) assert.equal(await request(JSON.stringify({ id: 4, action: 'login', ...details })), null)
})

test('only the top Codex frame can send account commands and receive replies', async () => {
  const commands = []
  const handled = []
  let onEvent
  const connection = {
    socket: { readyState: WebSocket.OPEN },
    async connect() {},
    async call(method, params) {
      commands.push({ method, params })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: CODEX_PAGE } } }
      if (method === 'Runtime.enable') {
        onEvent({ method: 'Runtime.executionContextCreated',
          params: { context: { id: 1, auxData: { isDefault: true, frameId: 'main' } } } })
        onEvent({ method: 'Runtime.executionContextCreated',
          params: { context: { id: 2, auxData: { isDefault: true, frameId: 'login-frame' } } } })
      }
      return { identifier: 'restore-yisama-ui' }
    },
    close() {},
  }
  const target = new AssistantTarget({ webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/page/main' },
    async (payload) => { handled.push(payload); return { id: 1, ok: true, data: { quota: '$9.50' } } },
    { connectionFactory: (_url, listener) => { onEvent = listener; return connection } })
  await target.install()
  assert.ok(commands.find((value) => value.method === 'Page.addScriptToEvaluateOnNewDocument'))
  assert.equal(commands.some((value) => value.method === 'Page.reload' || value.method === 'Page.setBypassCSP'), false)
  const binding = (executionContextId) => ({ method: 'Runtime.bindingCalled',
    params: { name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"login"}', executionContextId } })
  onEvent(binding(2))
  await delay(0)
  assert.equal(handled.length, 0)
  onEvent(binding(1))
  await delay(0)
  assert.equal(handled.length, 1)
  assert.equal(commands.at(-1).params.contextId, 1)
  assert.match(commands.at(-1).params.expression, /receive/)
  onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: 'https://example.com' } } })
  onEvent(binding(1))
  await delay(0)
  assert.equal(handled.length, 1)
  onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: CODEX_PAGE } } })
  await target.dispose()
  assert.ok(commands.find((value) => value.method === 'Page.removeScriptToEvaluateOnNewDocument'))
})

test('an old document cannot receive the result of a command after reload', async () => {
  let resolve
  const replies = []
  const target = new AssistantTarget({}, () => new Promise((done) => { resolve = done }),
    { connectionFactory: () => ({ call: async (...args) => replies.push(args), close() {} }) })
  target.mainFrameId = 'main'
  target.allowed = true
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'main' } })
  const pending = target.reply({ payload: '{"id":1,"action":"login"}', executionContextId: 1 })
  target.onEvent({ method: 'Runtime.executionContextsCleared' })
  resolve({ id: 1, ok: true, data: { loggedIn: true } })
  await pending
  assert.equal(replies.length, 0)
})

test('local CDP transport exchanges commands and binding events with an isolated real browser', async (t) => {
  const executable = process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : process.env.YISAMA_TEST_CDP_BROWSER
  if (!executable || !await fs.stat(executable).then(() => true, () => false)) {
    t.skip('An installed browser is required for the real CDP transport check.')
    return
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-cdp-test-'))
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${root}`, '--no-first-run',
    '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  const exited = once(browser, 'exit')
  let connection
  t.after(async () => {
    connection?.close()
    if (browser.exitCode === null) browser.kill()
    await exited
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  let port
  const deadline = Date.now() + 15000
  while (!port && Date.now() < deadline && browser.exitCode === null) {
    const record = await fs.readFile(path.join(root, 'DevToolsActivePort'), 'utf8').catch(() => '')
    if (record) port = Number(record.split('\n')[0])
    else await delay(100)
  }
  assert.ok(port, 'the isolated browser publishes its local debug port')
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
  const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank')
  assert.ok(page)
  assert.equal(allowedTarget(page, port), false, 'production must never accept arbitrary browser pages')
  let receiveEvent
  const bindingEvent = new Promise((resolve) => { receiveEvent = resolve })
  connection = new CdpConnection(page.webSocketDebuggerUrl, (event) => {
    if (event.method === 'Runtime.bindingCalled') receiveEvent(event)
  })
  await connection.connect()
  await connection.call('Runtime.enable')
  await connection.call('Runtime.addBinding', { name: 'yisamaTransportTest' })
  const result = await connection.call('Runtime.evaluate', {
    expression: 'yisamaTransportTest("verified"); ({ answer: 6 * 7, url: location.href })',
    returnByValue: true,
  })
  assert.deepEqual(result.result.value, { answer: 42, url: 'about:blank' })
  const event = await Promise.race([bindingEvent, delay(5000).then(() => null)])
  assert.equal(event?.params.payload, 'verified')
  assert.ok(event.params.executionContextId)

  await connection.call('Runtime.evaluate', {
    expression: `document.body.innerHTML = '<section id="yisama-infinite-assistant-ui" hidden><section hidden><input value="demo"></section></section>';
      window.__yisamaInfiniteAssistant = { snapshot: () => ({ loggedIn: true, open: false }) };`,
  })
  const assistant = new AssistantTarget({}, async () => null, { connectionFactory: () => connection })
  assistant.allowed = true
  assistant.mainFrameId = 'test-page'
  assistant.contexts.set(event.params.executionContextId, { auxData: { isDefault: true, frameId: 'test-page' } })
  assert.deepEqual(await assistant.reloadState(), closedPanel(),
    'a retained username in the hidden signed-out form must not block an update after login')
  await connection.call('Runtime.evaluate', {
    expression: 'window.__yisamaInfiniteAssistant.snapshot = () => ({ loggedIn: false, open: false });',
  })
  assert.deepEqual(await assistant.reloadState(), { open: false, busy: false, unsent: true },
    'closing the panel must still preserve an unsent login draft')
})
