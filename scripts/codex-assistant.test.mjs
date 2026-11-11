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
import { fileURLToPath } from 'node:url'
import {
  adaptNativeFastSource, adaptNativeChunkSource, adaptNativeI18nSource, adaptNativeGateSource, adaptNativeRuntimeSource, adaptNativeHostSource, installHostFallback, installNativeFast, installNativeStartup, syncNativeModels, codexRestartBlocker, allowedTarget, AssistantTarget, CdpConnection, CODEX_PAGE, codexStartedAt, createRequestQueue, readUpdateMarker,
  restartAssistant, restartCodex, runAssistant, shouldReload, validateEndpoint, validateUpdateMarker,
} from './codex-assistant.mjs'
import { inspectNativeControls, diagnoseNativeControls } from './codex-assistant.mjs'
import { validateRequest, handleRequest } from './desktop-bridge.mjs'
import { requestApi } from './yisama.mjs'

const generation = (letter) => letter.repeat(64)
const marker = (letter) => ({ generation: generation(letter), updatedAt: '2026-10-29T02:30:00.000Z' })
const closedPanel = () => ({ open: false, busy: false, unsent: false })

// Inspected 26.1021 and 26.1027 shapes. In 26.1027 the selector's i shadows hostId.
const nativeSourceFor = ({ access = 'Jlo', setter = 'P', models = 'Vso', teamCatalog = false } = {}) => `function ${access}(e){let t=c(10),r=e.hostId,o=e.authMethod,s;s={authMethod:o,hostId:r};let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}
function _fo(e,t,n,r,i){let l=g(e),u=l.hostId,d={hostId:u,conversationId:e},b=h(u),S=b?.authMethod??null,C={authMethod:S,hostId:x};return {hasManagedNewThreadSettings:I,hostId:L,serviceTierAccess:R,serviceTierSettings:z,setServiceTier:${setter}}}
var D2=Sc(J,({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o},{get:d})=>({select:({data:n${teamCatalog ? ',isTeamCatalog:i=!1' : ''}})=>${teamCatalog ? '({...' : ''}${models}({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:_,authMethod:t,availableModels:b.availableModels,defaultModel:b.defaultModel,enabledReasoningEfforts:y,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:x,isCustomModelProvider:o,models:n,useHiddenModels:b.useHiddenModels})${teamCatalog ? ',isTeamCatalog:i})' : ''}}))`
const nativeSource = nativeSourceFor()
const chunkFastSource = nativeSource.split('\nvar D2')[0]
  .replace('function Jlo(e){', 'var access=function(e){let p;')
  .replace('let f=d,p;', 'let f=d;')
  .replace('function _fo(e,t,n,r,i){', 'var setter=function(e,t,n,r,i){')
const chunkModelSource = nativeSourceFor({ teamCatalog: true }).split('\nvar D2')[1]
  .replace('includeUltraReasoningEffort:a,', 'includeUltraReasoningEffort:a=!0,')
  .replace('...Vso(', '...(0,transform.a)(')
  .replace('hasConfiguredModelCatalog:r,includeUltraReasoningEffort:x',
    'hasConfiguredModelCatalog:hasCatalog(r),includeUltraReasoningEffort:x')
  .replace('models:n,useHiddenModels:', 'models:null==specialty?n:n.filter(e=>e.modelSpecialty===specialty),useHiddenModels:')

function startupFixture({ age = 1000, navigation = 'navigate', startedAt } = {}) {
  const clock = { now: Date.now() }
  const listeners = new Map()
  let expire
  const window = {
    performance: { getEntriesByType: () => [{ type: navigation }] },
    setTimeout(callback) { expire = callback; return 1 },
    clearTimeout() { expire = null },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
  }
  window.top = window
  const install = () => runInNewContext(`(${installNativeStartup.toString()})(startedAt)`, {
    window, location: { href: CODEX_PAGE }, startedAt: startedAt ?? new Date(clock.now - age).toISOString(),
    Date: { now: () => clock.now, parse: Date.parse },
  })
  install()
  return { clock, window, listeners, install, expire: () => expire?.() }
}

test('startup loading is tied to a fresh Codex process, not helper updates or document reloads', () => {
  for (const options of [{ age: 31000 }, { age: -1000 }, { startedAt: 'invalid' },
    { navigation: 'reload' }, { navigation: 'back_forward' }]) {
    const { window, listeners } = startupFixture(options)
    assert.equal(window.__yisamaNativeStartup.pending(), false, JSON.stringify(options))
    assert.equal(listeners.size, 0)
  }
  const { window, listeners, install, expire } = startupFixture()
  const startup = window.__yisamaNativeStartup
  assert.equal(startup.pending(), true)
  assert.equal(listeners.size, 3)
  expire()
  assert.equal(startup.pending(), false)
  assert.equal(listeners.size, 0)
  install()
  assert.equal(window.__yisamaNativeStartup, startup, 'replacing the helper must not rearm startup')
  assert.equal(startup.pending(), false)
})

test('startup loading expires or is cancelled permanently as soon as the user interacts', () => {
  for (const type of ['pointerdown', 'keydown', 'input']) {
    const { window, listeners, install } = startupFixture()
    listeners.get(type)()
    assert.equal(window.__yisamaNativeStartup.pending(), false, type)
    assert.equal(listeners.size, 0)
    install()
    assert.equal(window.__yisamaNativeStartup.pending(), false, `${type}: no delayed refresh`)
  }
  const { window, clock } = startupFixture()
  clock.now += 30000
  assert.equal(window.__yisamaNativeStartup.pending(), false, 'the deadline also applies while RPCs run')
})

test('native controls adapt only the inspected hook sites and reject missing or repeated matches', () => {
  const adapted = adaptNativeFastSource(nativeSource)
  assert.match(adapted, /__yisamaNativeFast\?\.access\(r,o\)\?\?d,p;/)
  assert.match(adapted, /__yisamaNativeFast\?\.wrap\(u,S,P\)\?\?P\}/)
  assert.match(adapted, /__yisamaNativeFastSourceReady=true/)
  assert.match(adapted, /__yisamaNativeReasoningSourceReady=true/)
  assert.match(adapted, /return Vso\(window\.__yisamaNativeFast\?\.modelOptions\(yisamaHost,yisamaMethod,yisamaOptions,yisamaUltra\)/)
  assert.match(adapted, /\}\)\(i,t,a\)/)
  assert.doesNotThrow(() => new Function(adapted))
  for (const source of ['', nativeSource + nativeSource, nativeSource.replace('isLoading:u', 'loading:u'),
    nativeSource.replace(',conversationId:e', ''), nativeSource.replace('hostId:i,', ''),
    nativeSource.replace('setServiceTier:P}', 'setServiceTier:P()}'), nativeSource.replace('select:', 'pick:')]) {
    assert.throws(() => adaptNativeFastSource(source), /does not support/)
  }
})

test('Rspack chunks adapt anonymous Fast hooks and reasoning independently', () => {
  const fast = adaptNativeChunkSource(chunkFastSource)
  assert.match(fast, /__yisamaNativeFast\?\.access\(r,o\)\?\?d;/)
  assert.match(fast, /__yisamaNativeFast\?\.wrap\(u,S,P\)\?\?P/)
  assert.match(fast, /__yisamaNativeFastSourceReady=true/)
  assert.doesNotMatch(fast, /__yisamaNativeReasoningSourceReady/)
  assert.doesNotThrow(() => new Function(fast))

  const models = adaptNativeChunkSource(`var D2${chunkModelSource}`)
  assert.match(models, /\(0,transform.a\)\(window\.__yisamaNativeFast\?\.modelOptions/)
  assert.match(models, /__yisamaNativeReasoningSourceReady=true/)
  assert.doesNotMatch(models, /__yisamaNativeFastSourceReady/)
  assert.doesNotThrow(() => new Function(models))
  for (const unrelated of ['', 'export const __webpack_modules__={};',
    'let value={serviceTierAccess:null};', 'let value={setServiceTier:noop};']) {
    assert.equal(adaptNativeChunkSource(unrelated), unrelated)
  }
  assert.throws(() => adaptNativeChunkSource(chunkFastSource + chunkFastSource), /does not support/)
  assert.throws(() => adaptNativeChunkSource(`var D2${chunkModelSource}`.replace('hostId:i,', '')), /does not support/)
})

test('Rspack model selectors retain team, specialty and account boundaries with a defaulted Ultra argument', () => {
  const { controller, window } = fastFixture()
  const model = { model: 'gpt-test', modelSpecialty: 'code',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
  controller.authorize({ provider: 'yisama', fastAvailable: true,
    modelSettings: { 'gpt-test': { reasoningEfforts: ['high', 'ultra'] } } })
  for (const [hostId, authMethod, includeUltraReasoningEffort] of [
    ['local', 'apikey', undefined], ['local', 'apikey', false],
    ['remote', 'apikey', true], ['local', 'chatgpt', true],
  ]) {
    const options = { additionalAvailableModels: [], authMethod, hostId,
      includeUltraReasoningEffort, hasConfiguredModelCatalog: true, isCustomModelProvider: true }
    const query = runInNewContext(`${adaptNativeChunkSource(`var D2${chunkModelSource}`)}\nD2(options,{})`, {
      window, options, Sc: (_key, build) => build, J: null,
      transform: { a: (value) => value }, hasCatalog: (value) => value, specialty: 'code',
      _: false, b: { availableModels: [], defaultModel: model.model, useHiddenModels: false },
      y: new Set(['high']), x: false,
    })
    const owned = hostId === 'local' && authMethod === 'apikey'
    const selected = query.select({ data: [model, { ...model, modelSpecialty: 'other' }], isTeamCatalog: true })
    assert.equal(selected.isTeamCatalog, true)
    assert.equal(selected.models.length, 1)
    assert.equal(selected.includeUltraReasoningEffort, owned && includeUltraReasoningEffort !== false)
    assert.equal(selected.models[0].supportedReasoningEfforts.some((entry) => entry.reasoningEffort === 'ultra'), owned)
  }
  controller.dispose()
})

test('Rspack host, translation, feature and sidebar hooks retain their native settings', () => {
  const window = {}
  const host = { statsigEvaluations: { readExecutionAssignments: async () => null } }
  const hostSource = 'var services;var exports={setAppServices:function(e){services=e}}'
  const adaptedHost = adaptNativeChunkSource(hostSource)
  const actual = runInNewContext(`${adaptedHost};exports.setAppServices(host);services`, {
    window, host, Date, setTimeout, clearTimeout,
  })
  assert.equal(actual.statsigEvaluations.__yisamaFallback, true)
  assert.equal(host.statsigEvaluations.__yisamaFallback, true)
  const featureSource = 'let a=(0,h.Zj)("410065390"),b=(0,i.Zj)("410262010"),c=(0,j.Zj)("1506311413");'
  const adaptedFeatures = adaptNativeChunkSource(featureSource)
  for (const name of ['h', 'i', 'j']) assert.ok(adaptedFeatures.includes(`(0,${name}.Zj)(!0)`))
  assert.match(adaptNativeChunkSource('let a=gate?.get("enable_i18n",!1);'), /get\("enable_i18n",!0\)\|\|!0/)
  const runtimeSource = 'let value=host.values.permissionRefresh??null;' +
    'var settings={read:t=>null!=store&&store.get("sidebarCustomSectionsEnabled"===t?keys.sections:keys.server)};'
  const runtime = runInNewContext(adaptNativeChunkSource(runtimeSource) + ';({settings,value})', {
    window, host: { values: {} }, store: { get: () => undefined }, keys: {},
  })
  assert.equal(runtime.value, false)
  assert.equal(runtime.settings.read('sidebarCustomSectionsEnabled'), false)
  assert.equal(runtime.settings.read('useAppServerCustomSections'), false)
})

test('inspected Codex ESM assets load hooks and preserve Fast and reasoning ownership', {
  skip: !process.env.YISAMA_CODEX_ASSETS && 'Set YISAMA_CODEX_ASSETS to the inspected assets/async folder.',
}, async (t) => {
  const folder = path.resolve(process.env.YISAMA_CODEX_ASSETS)
  const { window, controller, key } = fastFixture()
  t.after(() => controller.dispose())
  controller.authorize({ provider: 'yisama', apiKey: key, fastAvailable: true,
    modelSettings: { 'gpt-test': { reasoningEfforts: ['high', 'ultra'] } } })
  const counts = { access: 0, wrap: 0, modelOptions: 0 }
  let modelModules = 0
  let accessModules = 0
  for (const name of await fs.readdir(folder)) {
    if (!/^\d+\.[0-9a-f]+\.js$/.test(name)) continue
    const source = await fs.readFile(path.join(folder, name), 'utf8')
    const patched = adaptNativeChunkSource(source)
    if (patched === source) continue
    const modules = runInNewContext(patched.replaceAll('export const ', 'const ') +
      '\n;__webpack_modules__', { window })
    for (const name of Object.keys(counts)) {
      counts[name] += patched.split(`window.__yisamaNativeFast?.${name}(`).length - 1
    }
    for (const factory of Object.values(modules)) {
      const text = factory.toString()
      if (!text.includes('window.__yisamaNativeFast?.modelOptions(') &&
        !text.includes('window.__yisamaNativeFast?.access(')) continue
      const model = { model: 'gpt-test', modelSpecialty: 'code',
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
      const nativeAccess = { fast: false, ultrafast: false }
      let method = 'apikey'
      const dependencies = {
        QosV: { c: (size) => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) },
        zTeN: { vU: (_scope, build) => build, Ul: () => 'local',
          _U: () => ({ data: {}, isPending: false }) },
        OeLR: { bo: () => true },
        Xvtr: { a: (options) => options },
        eWgO: { W6: () => nativeAccess },
        EOo5: { tn: () => ({ authMethod: method, isLoading: false }) },
        wCOm: { Y$: (config) => config, cc: () => true },
        B81s: { I2: 'config' },
        Q4dB: { o: () => ['models', 'list'] },
        Q3tq: { pN: 'efforts' },
        dPoV: { t: 'preferences' },
        OMIV: { JW: 'gate' },
        tl5a: { Dj: 'hosts' },
        rvFo: { D: { FIVE_MINUTES: 300000 } },
      }
      const require = (id) => dependencies[id] || {}
      require.d = (target, getters, values) => {
        for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get })
        Object.assign(target, values)
      }
      const exports = {}
      factory({}, exports, require)
      if (text.includes('window.__yisamaNativeFast?.modelOptions(')) {
        modelModules++
        for (const [hostId, authMethod, includeUltraReasoningEffort] of [
          ['local', 'apikey', undefined], ['local', 'apikey', false],
          ['remote', 'apikey', true], ['local', 'chatgpt', true],
        ]) {
          const teamCatalog = { accountId: 'test-team', userId: 'test-user' }
          const query = exports.SV({ additionalAvailableModels: [], authMethod, hostId,
            enabledReasoningEfforts: ['high'], includeUltraReasoningEffort, specialty: 'code', teamCatalog }, {
            get: (key) => ({
              config: { data: { config: { model_provider: 'yisama' } } },
              preferences: { availableModels: [], defaultModel: model.model, useHiddenModels: false },
              gate: false, hosts: ['local', 'remote'], efforts: new Set(['high']),
            })[key],
          })
          assert.equal(query.queryKey[2], hostId)
          assert.equal(query.queryKey[4], teamCatalog)
          assert.equal(query.enabled, true)
          const selected = query.select({ data: [model, { ...model, modelSpecialty: 'other' }], isTeamCatalog: true })
          const owned = hostId === 'local' && authMethod === 'apikey'
          assert.equal(selected.isTeamCatalog, true)
          assert.equal(selected.models.length, 1)
          assert.equal(selected.includeUltraReasoningEffort, owned && includeUltraReasoningEffort !== false)
          assert.equal(selected.models[0].supportedReasoningEfforts.some((entry) =>
            entry.reasoningEffort === 'ultra'), owned)
        }
      } else {
        accessModules++
        assert.equal(exports.U({ hostId: 'local' }).serviceTierAccess.fast, true)
        assert.equal(exports.U({ hostId: 'local' }).serviceTierAccess.ultrafast, false)
        assert.equal(exports.U({ hostId: 'remote' }).serviceTierAccess, null)
        method = 'chatgpt'
        assert.equal(exports.U({ hostId: 'local' }).serviceTierAccess, nativeAccess)
      }
      assert.equal(model.supportedReasoningEfforts.length, 1, 'the native catalog must not be mutated')
    }
  }
  assert.deepEqual(counts, { access: 1, wrap: 1, modelOptions: 2 })
  assert.equal(modelModules, 2)
  assert.equal(accessModules, 1)
  for (const name of ['Fast', 'Reasoning', 'Host', 'Gates', 'Runtime', 'I18n']) {
    assert.equal(window[`__yisamaNative${name}SourceReady`], true, `${name} hook must load`)
  }
})

test('translations are allowed locally only at the one inspected experiment default', () => {
  const source = 'let s=Ul(`72216192`),c;c=s?.get(`enable_i18n`,!1);let u=s?.get(`locale_source`,`IDE`);'
  const adapted = adaptNativeI18nSource(source)
  assert.match(adapted, /c=s\?\.get\(`enable_i18n`,!0\)\|\|!0;/)
  assert.match(adapted, /`locale_source`,`IDE`/)
  assert.match(adapted, /__yisamaNativeI18nSourceReady=true/)
  assert.doesNotThrow(() => new Function(adapted))
  // Unknown or ambiguous builds are left exactly as shipped.
  for (const other of ['let a=1;', source + source]) {
    assert.equal(adaptNativeI18nSource(other).replace(/\nwindow\.__yisamaNativeI18nSourceReady=true;\n$/, ''), other)
  }
})

test('browser and computer use experiments are allowed locally only at exact gate calls', () => {
  const source = 'let a=Mb(`410065390`),b=Mb(`410262010`),c=Mb(`1506311413`),d=Mb(`72216192`);'
  const adapted = adaptNativeGateSource(source)
  assert.match(adapted, /a=Mb\(!0\),b=Mb\(!0\),c=Mb\(!0\),d=Mb\(`72216192`\);/)
  assert.match(adapted, /__yisamaNativeGatesSourceReady=true/)
  assert.doesNotThrow(() => new Function(adapted))
  // A repeated gate is ambiguous and stays as shipped; the others are still allowed.
  const repeated = adaptNativeGateSource(source + 'x=Mb(`410065390`);')
  assert.equal((repeated.match(/`410065390`/g) || []).length, 2)
  assert.match(repeated, /b=Mb\(!0\)/)
})

test('chat branching no longer waits forever for a missing permission-refresh experiment', () => {
  const source = 'let o={async readPermissionRefreshEnabled(){if(A)return(await A.read())?.values.permissionRefresh??null;return null}};'
  const adapted = adaptNativeRuntimeSource(source)
  assert.match(adapted, /\?\.values\.permissionRefresh\?\?!1;return null\}/)
  assert.match(adapted, /__yisamaNativeRuntimeSourceReady=true/)
  assert.doesNotThrow(() => new Function(adapted))
  for (const other of ['let a=1;', source + source]) {
    assert.equal(adaptNativeRuntimeSource(other).replace(/\nwindow\.__yisamaNativeRuntimeSourceReady=true;\n$/, ''), other)
  }
})

test('missing desktop experiment assignments fall back to all-off defaults only after a grace period', async () => {
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    class Evaluations {
      #value = null
      set(value) { this.#value = value }
      async readExecutionAssignments() { return this.#value }
      async hasReadyExecutionAssignments() { return this.#value != null }
      publish(value) { return `published:${value}` }
    }
    const evaluations = new Evaluations()
    const host = installHostFallback({ statsigEvaluations: evaluations, other: 1 })
    assert.equal(host.other, 1)
    assert.equal(await host.statsigEvaluations.readExecutionAssignments(), null, 'still loading at startup')
    assert.equal(await host.statsigEvaluations.hasReadyExecutionAssignments(), false)
    assert.equal(host.statsigEvaluations.publish('x'), 'published:x', 'other methods keep their private state')
    now += 10001
    const fallback = await host.statsigEvaluations.readExecutionAssignments()
    assert.deepEqual(fallback.defaultEnableFeatures, {})
    assert.equal(fallback.values.permissionRefresh, false)
    assert.equal(await host.statsigEvaluations.hasReadyExecutionAssignments(), true)
    const real = { identity: { userId: 'u' }, values: { permissionRefresh: true }, defaultEnableFeatures: { a: 1 } }
    evaluations.set(real)
    assert.equal(await host.statsigEvaluations.readExecutionAssignments(), real, 'real assignments always win')
    assert.equal(installHostFallback(host), host, 'wrapping is idempotent')
    assert.equal(installHostFallback({ other: 2 }).other, 2, 'hosts without evaluations are unchanged')
    const frozen = installHostFallback(Object.freeze({ statsigEvaluations: new Evaluations() }))
    assert.equal(frozen.statsigEvaluations.__yisamaFallback, true)
  } finally {
    Date.now = realNow
  }
})

test('host services are wrapped only at the one setter of the telemetry host variable', () => {
  const source = 'function a(e){x=e}function b(e){KQ=e}var x,KQ;function c(){let t=KQ?.performanceTelemetry;return KQ?.tracing}'
  const adapted = adaptNativeHostSource(source)
  assert.match(adapted, /function a\(e\)\{x=e\}/)
  assert.match(adapted, /function b\(e\)\{KQ=\(function installHostFallback/)
  assert.match(adapted, /__yisamaNativeHostSourceReady=true/)
  assert.doesNotThrow(() => new Function(adapted))
  for (const other of ['let a=1;', source + 'x?.performanceTelemetry;',
    source + 'function d(e){KQ=e}']) {
    assert.equal(adaptNativeHostSource(other).replace(/\nwindow\.__yisamaNativeHostSourceReady=true;\n$/, ''), other)
  }
})

test('native controls follow renamed minified identifiers in other Codex builds', () => {
  const adapted = adaptNativeFastSource(nativeSourceFor({ access: '_Lo', setter: 'F', models: 'eIo' }))
  assert.match(adapted, /__yisamaNativeFast\?\.access\(r,o\)\?\?d,p;/)
  assert.match(adapted, /__yisamaNativeFast\?\.wrap\(u,S,F\)\?\?F\}/)
  assert.match(adapted, /return eIo\(window\.__yisamaNativeFast\?\.modelOptions\(yisamaHost,yisamaMethod,yisamaOptions,yisamaUltra\)/)
  assert.doesNotThrow(() => new Function(adapted))
})

test('native controls preserve the 26.1027 team selector and capture host outside its shadowed parameter', () => {
  const { controller, window } = fastFixture()
  const model = { model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
  controller.authorize({ provider: 'yisama', fastAvailable: true,
    modelSettings: { 'gpt-test': { reasoningEfforts: ['high', 'ultra'] } } })
  for (const teamCatalog of [false, true]) {
    for (const [hostId, authMethod, includeUltraReasoningEffort] of [
      ['local', 'apikey', true], ['remote', 'apikey', true],
      ['local', 'chatgpt', true], ['local', 'apikey', false],
    ]) {
      const adapted = adaptNativeFastSource(nativeSourceFor({ models: 'Rko', teamCatalog }))
      const options = { additionalAvailableModels: [], authMethod, hostId,
        includeUltraReasoningEffort, hasConfiguredModelCatalog: true, isCustomModelProvider: true }
      const query = runInNewContext(`${adapted}\nD2(options,{})`, {
        window, options, Sc: (_key, build) => build, J: null, Rko: (value) => value,
        _: false, b: { availableModels: [], defaultModel: model.model, useHiddenModels: false },
        y: new Set(['high']), x: false,
      })
      const owned = hostId === 'local' && authMethod === 'apikey'
      for (const isTeamCatalog of [undefined, false, true]) {
        const actual = query.select({ data: [model], isTeamCatalog })
        assert.equal(actual.includeUltraReasoningEffort, owned && includeUltraReasoningEffort)
        assert.deepEqual([...actual.enabledReasoningEfforts], owned ? ['high', 'ultra'] : ['high'])
        assert.equal(actual.models[0].supportedReasoningEfforts.some((entry) => entry.reasoningEffort === 'ultra'), owned)
        assert.equal(actual.isTeamCatalog, teamCatalog ? isTeamCatalog ?? false : undefined)
        assert.equal(actual.authMethod, authMethod)
        assert.equal(actual.defaultModel, model.model)
      }
      assert.equal(controller.access(hostId, authMethod)?.fast, owned ? true : undefined)
    }
  }
  assert.deepEqual(model.supportedReasoningEfforts, [{ reasoningEffort: 'high' }])
  const source = nativeSourceFor({ teamCatalog: true })
  for (const malformed of [source + nativeSource,
    source.replace(',isTeamCatalog:i})', ',isTeamCatalog:j})'),
    source.replace('=>({...', '=>('),
    source.replace(',isTeamCatalog:i=!1', '')]) {
    assert.throws(() => adaptNativeFastSource(malformed), /does not support/)
  }
  controller.dispose()
})

function fastFixture({ serverFailure = false, nativeFailure = false, ownAuth = true, serverDelay = 0, lang } = {}) {
  const listeners = new Set()
  const events = new EventEmitter()
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
      const reply = () => {
        window.__yisamaNativeFast.receive({
          id: request.id, ok: !serverFailure, data: { enabled: request.enabled },
        })
        queueMicrotask(() => events.emit('settled', request))
      }
      if (serverDelay > 0) setTimeout(reply, serverDelay)
      else queueMicrotask(reply)
    },
  }
  window.top = window
  runInNewContext(`(${installNativeFast.toString()})()`, {
    window, location: { href: CODEX_PAGE }, crypto: webcrypto, TextEncoder, Uint32Array, Uint8Array,
    ...(lang ? { document: { documentElement: { lang } } } : {}),
  })
  const controller = window.__yisamaNativeFast
  controller.authorize({ apiKey: key, fastAvailable: true, fastEnabled: true })
  const native = async (tier, source) => {
    calls.push({ nativeTier: tier, source })
    return !nativeFailure
  }
  return { window, controller, native, calls, authCalls, key, events }
}

test('only a Chinese interface reloads once to pick up the local translation and feature switches', () => {
  for (const [lang, expected] of [['zh-CN', true], ['zh', true], ['en-US', false], ['zu', false]]) {
    const { controller, window } = fastFixture({ lang })
    assert.equal(controller.needsReload(), expected, lang)
    window.__yisamaNativeI18nSourceReady = true
    assert.equal(controller.needsReload(), expected, `${lang}: feature gates still missing`)
    window.__yisamaNativeGatesSourceReady = true
    assert.equal(controller.needsReload(), expected, `${lang}: runtime defaults still missing`)
    window.__yisamaNativeRuntimeSourceReady = true
    assert.equal(controller.needsReload(), expected, `${lang}: host fallback still missing`)
    window.__yisamaNativeHostSourceReady = true
    assert.equal(controller.needsReload(), false, lang)
  }
})

test('native Fast updates the native UI before the server and preserves native account access', async () => {
  const { controller, native, calls, authCalls, key, window, events } = fastFixture()
  assert.equal(controller.access('local', 'apikey')?.fast, true)
  assert.equal(controller.access('local', 'chatgpt'), null)
  assert.equal(controller.access('remote', 'apikey'), null)
  assert.equal(controller.wrap('local', 'chatgpt', native), native)
  const wrapped = controller.wrap('local', 'apikey', native)
  assert.equal(controller.wrap('local', 'apikey', native), wrapped)
  const firstReply = once(events, 'settled')
  assert.equal(await wrapped(null, 'composer_menu'), true)
  const [firstServerCall] = await firstReply
  assert.equal(calls[0].nativeTier, null)
  assert.equal(firstServerCall.enabled, false)
  assert.equal(firstServerCall.keyFingerprint, createHash('sha256').update(key).digest('hex'))
  assert.deepEqual(authCalls, ['getAuthStatus'])
  assert.equal(JSON.stringify(calls).includes(key), false)
  const secondReply = once(events, 'settled')
  assert.equal(await wrapped('priority', 'composer_menu'), true)
  await secondReply
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
  const state = { mounted: true, queryReady: true, loading: false, draft: '', panelOpen: false, reloadRequested: false,
    active: false, needsReload: true, catalog: [], invalidations: 0, updates: [] }
  const settings = { version: 'test', apiKey: 'sk-native-test-only', provider: 'yisama', fastAvailable: true }
  const props = { client: { getQueryCache() {}, async invalidateQueries() { state.invalidations++ } } }
  const root = { get memoizedProps() { return state.queryReady ? props : null } }
  const window = {
    __yisamaInfiniteAssistant: {
      nativeStatus(status) { state.nativeSync = status },
      snapshot: () => ({ open: state.panelOpen, nativeSync: state.nativeSync }),
      consumeNativeReloadRequest() {
        const requested = state.reloadRequested
        state.reloadRequested = false
        return requested
      },
    },
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
      if (request.method === 'account/login/start' && state.authToken !== undefined && !state.ignoreLogin) {
        state.authToken = request.params.apiKey
      }
      if (request.method === 'thread/read') state.onThreadRead?.()
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
    window, location: { href: CODEX_PAGE }, settings, crypto: webcrypto, TextEncoder, setTimeout, clearTimeout,
    document: { querySelectorAll: () => [{ isContentEditable: true, get textContent() { return state.draft } }] },
  })
  return { state, window, calls, sync, settings }
}

test('local evidence collection is read-only, account-bound and returns no credentials', async () => {
  const { state, window, calls, settings } = nativeSyncFixture()
  settings.modelSettings = { demo: { reasoningEfforts: ['high', 'ultra'] } }
  const inspect = (value = settings) => runInNewContext(`(${inspectNativeControls.toString()})(settings)`, {
    window, location: { href: CODEX_PAGE }, settings: value, crypto: webcrypto, setTimeout, clearTimeout,
  })
  assert.equal((await inspect(null)).status, 'configuration')
  assert.equal(calls.length, 0)
  assert.equal((await inspect()).status, 'repairable')
  assert.equal(state.authorized, undefined)
  window.__yisamaNativeFastSourceReady = true
  window.__yisamaNativeReasoningSourceReady = true
  window.__yisamaNativeModelSync = { version: settings.version, status: 'synced' }
  const ready = await inspect()
  assert.equal(ready.status, 'ready')
  assert.equal(ready.fast, true)
  assert.equal(ready.ultra, true)
  assert.doesNotMatch(JSON.stringify(ready), /apiKey|sk-|authToken/)
  window.__yisamaNativeAdapterUnsupported = true
  assert.equal((await inspect()).status, 'repairable')
  state.authToken = 'foreign-test-key'
  assert.equal((await inspect()).status, 'account-change')
  state.authToken = settings.apiKey
  state.failMethod = 'getAuthStatus'
  assert.equal((await inspect()).status, 'connection')
  state.failMethod = ''
  settings.fastAvailable = false
  settings.modelSettings = {}
  assert.equal((await inspect()).status, 'not-offered')
  settings.fastAvailable = true
  settings.model = 'selected'
  settings.modelSettings = { selected: { fastAvailable: false, reasoningEfforts: ['high'] },
    another: { fastAvailable: true, reasoningEfforts: ['ultra'] } }
  assert.equal((await inspect()).status, 'not-offered', 'another model cannot grant the selected model Fast or Ultra')
  assert.ok(calls.every((method) => method === 'getAuthStatus'), 'no login, writes, reload, inference or paid checks')
})

const diagnosticSettings = {
  provider: 'yisama', apiKey: 'sk-self-check-private', version: 'diagnostic-v1',
  model: 'gpt-test', models: ['gpt-test'], modelSettings: { 'gpt-test': { reasoningEfforts: ['low', 'ultra'] } },
}
const diagnosticResponse = (data) => ({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
})

test('AI self-check uses the current account and model with only sanitized status evidence', async () => {
  const calls = []
  const result = await diagnoseNativeControls(diagnosticSettings, {
    status: 'repairable', canRepair: true, fast: true, ultra: true,
    ignoredSecret: 'DO-NOT-SEND-THIS', source: 'private source', logs: ['private log'],
  }, { send: async (url, options) => {
    calls.push({ url, options })
    return diagnosticResponse({ summary: `建议重新同步 ${diagnosticSettings.apiKey}`, repair: true })
  } })
  assert.equal(calls.length, 1)
  const { url, options } = calls[0]
  assert.equal(url, '/responses')
  assert.equal(options.method, 'POST')
  assert.equal(options.token, diagnosticSettings.apiKey)
  assert.equal(options.apiPrefix, '/v1')
  assert.equal(options.timeoutMs, 60000)
  assert.equal(options.body.model, diagnosticSettings.model)
  assert.equal(options.body.store, false)
  assert.equal(options.body.stream, false)
  assert.equal(options.body.text.format.strict, true)
  assert.deepEqual(options.body.reasoning, { effort: 'low' })
  assert.deepEqual(JSON.parse(options.body.input),
    { operation: 'check', status: 'repairable', canResync: true, fast: true, ultra: true })
  assert.doesNotMatch(JSON.stringify(options.body), /sk-self-check|DO-NOT-SEND|private source|private log/)
  assert.doesNotMatch(result.summary, /sk-self-check/)
  assert.equal(result.repair, true)
})

test('model diagnostics complete the real HTTP request chain against a local simulated provider', async (t) => {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(requests.length === 1 ? 200 : 503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(requests.length === 1
      ? diagnosticResponse({ summary: '建议重新同步控件', repair: true })
      : { error: { message: 'sk-private-provider-error' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const send = (pathname, options) => requestApi(pathname, {
    ...options, origin: `http://127.0.0.1:${server.address().port}`,
  })
  const evidence = { status: 'repairable', canRepair: true, fast: true, ultra: true }
  const result = await diagnoseNativeControls(diagnosticSettings, evidence, { send })
  assert.equal(result.repair, true)
  assert.equal(requests[0].url, '/v1/responses')
  assert.equal(requests[0].authorization, `Bearer ${diagnosticSettings.apiKey}`)
  assert.equal(requests[0].body.model, diagnosticSettings.model)
  assert.doesNotMatch(JSON.stringify(requests[0].body), /sk-self-check/)
  await assert.rejects(diagnoseNativeControls(diagnosticSettings, evidence, { send, action: 'codexRepair' }),
    (error) => {
      assert.doesNotMatch(error.message, /sk-private/)
      return error.publicCode === 'CODEX_DIAGNOSTIC_FAILED'
    })
  assert.equal(requests.length, 2, 'one manual operation sends exactly one model request, including failures')
  assert.equal(JSON.parse(requests[1].body.input).operation, 'repair')
})

test('AI advice cannot grant unavailable features or repair unknown adapters', async () => {
  for (const status of ['ready', 'unsupported', 'not-offered', 'configuration', 'account-change', 'secret-status']) {
    const result = await diagnoseNativeControls(diagnosticSettings, { status, canRepair: true }, {
      action: 'codexRepair', send: async (_url, { body }) => {
        const evidence = JSON.parse(body.input)
        assert.equal(evidence.operation, 'repair')
        assert.equal(evidence.canResync, false)
        assert.doesNotMatch(body.input, /secret-status/)
        return diagnosticResponse({ summary: '模型建议', repair: true })
      },
    })
    assert.equal(result.repair, false, status)
  }
})

test('invalid configuration and failed model requests never fall back to another account or retry', async () => {
  let calls = 0
  for (const settings of [null, { ...diagnosticSettings, provider: 'other' },
    { ...diagnosticSettings, models: [] }]) {
    await assert.rejects(diagnoseNativeControls(settings, { status: 'ready' }, {
      send: async () => { calls++; assert.fail('configuration must be checked before inference') },
    }), (error) => error.publicCode === 'CODEX_DIAGNOSTIC_CONFIGURATION')
  }
  assert.equal(calls, 0)
  for (const payload of [
    { status: 'incomplete', output: [] }, diagnosticResponse({ summary: '', repair: true }),
    diagnosticResponse({ summary: 'invalid result', repair: 'true' }),
  ]) {
    const before = calls
    await assert.rejects(diagnoseNativeControls(diagnosticSettings, { status: 'ready' }, {
      send: async () => { calls++; return payload },
    }), (error) => error.publicCode === 'CODEX_DIAGNOSTIC_FAILED')
    assert.equal(calls, before + 1)
  }
  for (const status of [402, undefined]) {
    const before = calls
    await assert.rejects(diagnoseNativeControls(diagnosticSettings, { status: 'ready' }, {
      send: async () => { calls++; throw Object.assign(new Error('sk-provider-private'), { status }) },
    }), (error) => {
      assert.doesNotMatch(error.message, /sk-provider-private/)
      return error.publicCode === (status === 402 ? 'CODEX_DIAGNOSTIC_BALANCE' : 'CODEX_DIAGNOSTIC_FAILED')
    })
    assert.equal(calls, before + 1)
  }
})

test('Codex self-repair requires explicit confirmation and cannot use the standalone account bridge', async () => {
  assert.throws(() => validateRequest({ id: 1, action: 'codexRepair' }), /invalid bridge request/)
  assert.throws(() => validateRequest({ id: 1, action: 'codexRepair', confirmed: false }), /invalid bridge request/)
  assert.deepEqual(validateRequest({ id: 1, action: 'codexRepair', confirmed: true }),
    { id: 1, action: 'codexRepair', confirmed: true })
  await assert.rejects(handleRequest({ id: 2, action: 'codexCheck' }), /面板/)
  const origin = {}
  let client
  const request = createRequestQueue((_command, context) => { client = context; return { cost: 0 } })
  request.quiesce()
  const reply = request('{"id":3,"action":"codexCheck"}', origin)
  request.resume()
  assert.equal((await reply).data.cost, 0)
  assert.equal(client, origin, 'a queued check must remain bound to its originating renderer')
})

test('known incompatible native adapters are reported without scheduling a fake repair', async () => {
  const calls = []
  const target = new AssistantTarget({}, null, { connectionFactory: () => ({
    async call(method, params) {
      calls.push({ method, params })
      return { result: { value: { status: 'repairable', canRepair: true } } }
    },
  }) })
  target.allowed = true
  target.mainFrameId = 'self-check'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'self-check' } })
  target.nativeAdapterFailed = true
  target.nativeFastReloadAttempted = true
  assert.equal((await target.prepareNativeRepair({})).status, 'unsupported')
  assert.equal(target.nativeFastReloadAttempted, true)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].params.expression.includes(inspectNativeControls.toString()))
})

test('manual repair rearms only one native reload after the renderer accepts the request', async () => {
  const calls = []
  const target = new AssistantTarget({}, null, { connectionFactory: () => ({
    async call(method, params) {
      calls.push({ method, params })
      return { result: { value: params.expression.includes(inspectNativeControls.toString())
        ? { status: 'repairable', canRepair: true, fast: true, ultra: true } : true } }
    },
  }) })
  target.allowed = true
  target.mainFrameId = 'self-check'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'self-check' } })
  target.nativeFastReloadAttempted = true
  assert.equal((await target.prepareNativeRepair({})).status, 'repairing')
  assert.equal(target.nativeFastReloadAttempted, false)
  assert.match(calls[1].params.expression, /delete window\.__yisamaNativeModelSync/)
  assert.equal(calls.some((call) => call.method === 'Page.reload'), false,
    'the normal synchronization loop must recheck activity before any reload')
})

test('device migration defers during active replies and switches only the verified previous credential when idle', async () => {
  const { state, window, calls, sync, settings } = nativeSyncFixture()
  state.needsReload = false
  state.authToken = 'sk-legacy-device-test'
  settings.previousKeyFingerprint = createHash('sha256').update(state.authToken).digest('hex')
  state.threads = { owned: { modelProvider: 'yisama', model: 'gpt-owned', status: { type: 'active' } } }
  assert.equal((await sync()).status, 'pending')
  assert.equal(state.authToken, 'sk-legacy-device-test')
  assert.equal(calls.includes('account/login/start'), false)
  state.threads.owned.status.type = 'idle'
  assert.equal((await sync()).status, 'synced')
  assert.equal(state.authToken, settings.apiKey)
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 1)
  assert.equal(window.__yisamaNativeModelSync.status, 'synced')
  assert.equal(calls.includes('thread/interrupt'), false)
  assert.equal(calls.includes('logout'), false)
  assert.equal((await sync()).status, 'synced')
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 1)
})

test('device migration rejects foreign accounts and unconfirmed native authentication', async () => {
  for (const mode of ['foreign', 'unconfirmed']) {
    const { state, calls, sync, settings } = nativeSyncFixture()
    state.needsReload = false
    state.authToken = mode === 'foreign' ? 'sk-foreign-device-test' : 'sk-legacy-device-test'
    settings.previousKeyFingerprint = createHash('sha256').update('sk-legacy-device-test').digest('hex')
    state.ignoreLogin = mode === 'unconfirmed'
    assert.equal((await sync()).status, mode === 'foreign' ? 'account-change' : 'error')
    assert.equal(state.authorized, false)
    assert.equal(calls.filter((method) => method === 'account/login/start').length, mode === 'foreign' ? 0 : 1)
  }
})

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

test('native synchronization accepts extra native models without managing their capabilities or threads', async () => {
  const { state, window, sync, settings } = nativeSyncFixture()
  state.needsReload = false
  Object.assign(settings, {
    models: ['gpt-owned'],
    modelSettings: { 'gpt-owned': {
      fastAvailable: true, serviceTier: 'priority', reasoningEfforts: ['high', 'ultra'],
    } },
  })
  const extra = { model: 'native-extra', serviceTiers: [{ id: 'priority' }], defaultServiceTier: 'priority' }
  state.catalog = [extra, {
    model: 'gpt-owned', serviceTiers: [{ id: 'priority' }], defaultServiceTier: 'priority',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
  }]
  state.threads = {
    owned: { modelProvider: 'yisama', model: 'gpt-owned' },
    extra: { modelProvider: 'yisama', model: 'native-extra' },
    foreign: { modelProvider: 'personal', model: 'gpt-owned' },
  }
  const before = JSON.stringify(state.catalog)
  assert.equal((await sync()).status, 'synced')
  assert.equal(window.__yisamaNativeModelSync.status, 'synced')
  assert.equal(state.authorized, true)
  assert.equal(state.invalidations, 1)
  assert.deepEqual(state.updates.map((update) => ({ ...update })),
    [{ threadId: 'owned', model: 'gpt-owned', serviceTier: 'priority' }])
  assert.equal(JSON.stringify(state.catalog), before, 'native-only models must remain unchanged')
})

test('extra native models cannot substitute for required models or their capabilities', async () => {
  for (const failure of ['missing-model', 'missing-fast', 'missing-reasoning']) {
    const { state, window, sync, settings } = nativeSyncFixture()
    state.needsReload = false
    Object.assign(settings, {
      models: ['gpt-owned'],
      modelSettings: { 'gpt-owned': {
        fastAvailable: true, serviceTier: 'priority', reasoningEfforts: ['ultra'],
      } },
    })
    state.catalog = [{
      model: 'native-extra', serviceTiers: [{ id: 'priority' }], defaultServiceTier: 'priority',
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }],
    }]
    if (failure !== 'missing-model') state.catalog.push({
      model: 'gpt-owned',
      serviceTiers: failure === 'missing-fast' ? [] : [{ id: 'priority' }],
      defaultServiceTier: failure === 'missing-fast' ? null : 'priority',
      supportedReasoningEfforts: failure === 'missing-reasoning' ? [] : [{ reasoningEffort: 'ultra' }],
    })
    assert.equal((await sync()).status, 'error', failure)
    assert.equal(window.__yisamaNativeModelSync.stage,
      failure === 'missing-model' ? 'catalog' : 'service-tiers', failure)
    assert.equal(state.authorized, false, failure)
    assert.equal(state.updates.length, 0, failure)
  }
})

test('native synchronization does not acknowledge stale input capabilities', async () => {
  for (const expected of [['text'], ['text', 'image']]) {
    const { state, window, sync, settings } = nativeSyncFixture()
    state.needsReload = false
    Object.assign(settings, {
      models: ['gpt-owned'],
      modelSettings: { 'gpt-owned': { inputModalities: expected } },
    })
    state.catalog = [{ model: 'gpt-owned',
      inputModalities: expected.length === 1 ? ['text', 'image'] : ['text'] }]
    assert.equal((await sync()).status, 'error')
    assert.equal(state.updates.length, 0)
    assert.equal(window.__yisamaNativeModelSync.status, 'error')
    assert.equal(state.authorized, false)
  }
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

test('native controls never reload automatically when drafts or active replies clear', async () => {
  const { state, sync, calls } = nativeSyncFixture()
  for (const field of ['draft', 'panelOpen', 'active']) {
    state[field] = field === 'draft' ? 'unsent' : true
    const result = await sync()
    assert.equal(result.status, 'pending')
    assert.equal(result.reloadNativeFast, undefined)
    state[field] = field === 'draft' ? '' : false
  }
  for (let poll = 0; poll < 3; poll++) assert.equal((await sync()).reloadNativeFast, undefined)
  assert.equal(state.nativeSync, 'reload-required')
  assert.equal(calls.includes('thread/loaded/list'), false,
    'background readiness checks do not scan conversations or schedule a page reload')
  state.reloadRequested = true
  state.panelOpen = true
  assert.equal((await sync()).reloadNativeFast, true, 'the explicit button works with the panel open')
  assert.equal(state.reloadRequested, false)
  assert.equal((await sync()).reloadNativeFast, undefined, 'one click grants only one reload attempt')
  assert.equal(calls.filter((method) => method === 'account/login/start').length, 1,
    'waiting for safe resource loading must not repeatedly log in')
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
})

test('a fresh Codex launch loads missing native controls once without a button click', async () => {
  const { state, window, sync } = nativeSyncFixture()
  let pending = true
  window.__yisamaNativeStartup = {
    pending: () => pending,
    cancel() { pending = false },
  }
  state.queryReady = false
  assert.equal((await sync()).status, 'pending')
  assert.equal(pending, true, 'startup waits for the initial query provider')
  state.queryReady = true
  const result = await sync()
  assert.equal(result.reloadNativeFast, true)
  assert.equal(result.startupReload, true)
  assert.equal(state.reloadRequested, false)
  assert.equal(pending, false)
  assert.equal((await sync()).reloadNativeFast, undefined, 'startup cannot queue another refresh')
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
})

test('startup loading is never deferred until drafts, panels, or active replies clear', async () => {
  for (const field of ['draft', 'panelOpen', 'active', 'onThreadRead']) {
    const { state, window, sync } = nativeSyncFixture()
    let pending = true
    window.__yisamaNativeStartup = {
      pending: () => pending,
      cancel() { pending = false },
    }
    state[field] = field === 'draft' ? 'unsent' : field === 'onThreadRead' ? () => { pending = false } : true
    assert.equal((await sync()).reloadNativeFast, undefined, field)
    assert.equal(pending, false, field)
    state[field] = field === 'draft' ? '' : field === 'onThreadRead' ? undefined : false
    for (let poll = 0; poll < 3; poll++) {
      assert.equal((await sync()).reloadNativeFast, undefined, `${field}: no delayed refresh`)
    }
    state.reloadRequested = true
    assert.equal((await sync()).reloadNativeFast, true, 'manual refresh remains available')
  }
})

test('already loaded controls consume startup without reloading later catalog revisions', async () => {
  const { state, window, settings, sync } = nativeSyncFixture()
  let pending = true
  window.__yisamaNativeStartup = {
    pending: () => pending,
    cancel() { pending = false },
  }
  state.needsReload = false
  assert.equal((await sync()).status, 'synced')
  assert.equal(pending, false)
  state.needsReload = true
  settings.version = 'later-group'
  assert.equal((await sync()).reloadNativeFast, undefined)
})

test('a blocked or failed explicit reload is consumed and cannot run later without another click', async () => {
  for (const blockedBy of ['draft', 'active', 'loading', 'mounted', 'failMethod']) {
    const { state, sync } = nativeSyncFixture()
    await sync()
    const normal = state[blockedBy]
    state[blockedBy] = { draft: 'unsent', active: true, loading: true,
      mounted: false, failMethod: 'thread/read' }[blockedBy]
    state.reloadRequested = true
    assert.equal((await sync()).reloadNativeFast, undefined, blockedBy)
    assert.equal(state.reloadRequested, false, blockedBy)
    if (['draft', 'active'].includes(blockedBy)) assert.equal(state.nativeSync, 'reload-blocked')
    state[blockedBy] = normal
    for (let poll = 0; poll < 3; poll++) {
      assert.equal((await sync()).reloadNativeFast, undefined, `${blockedBy}: no delayed reload`)
    }
  }
})

test('incompatible native Fast resources cannot cause a renderer reload loop', async () => {
  const calls = []
  const reports = []
  const target = new AssistantTarget({}, null, { report: (message) => reports.push(message), connectionFactory: () => ({
    async call(method, params) {
      calls.push(method)
      if (method === 'Runtime.evaluate' && /__yisamaNativeAdapterUnsupported = true/.test(params.expression)) return {}
      return { result: { value: { status: 'pending',
        ...(calls.includes('Page.reload') ? { nativeControlsMissing: true } : { reloadNativeFast: true }) } } }
    },
  }) })
  target.allowed = true
  target.mainFrameId = 'main'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'main' } })
  assert.equal((await target.syncModels({})).status, 'pending')
  assert.equal((await target.syncModels({})).status, 'synced')
  assert.equal(calls.filter((method) => method === 'Page.reload').length, 1)
  // The single reload bypasses modules cached from an earlier adapter.
  assert.deepEqual(calls.slice(calls.indexOf('Page.reload') - 2, calls.indexOf('Page.reload') + 1),
    ['Network.enable', 'Network.setCacheDisabled', 'Page.reload'])
  assert.equal(calls.at(-1), 'Runtime.evaluate')
  assert.match(reports[0], /Native model controls: user-requested page reload\.$/)
  assert.equal(reports[1], 'The native model controls did not load. This Codex build may be incompatible.')
})

test('a reload requested in an old document cannot refresh a replacement document', async () => {
  const calls = []
  const target = new AssistantTarget({}, null, { connectionFactory: () => ({
    async call(method) {
      calls.push(method)
      target.onEvent({ method: 'Runtime.executionContextsCleared' })
      target.contexts.set(2, { auxData: { isDefault: true, frameId: 'main' } })
      return { result: { value: { status: 'pending', reloadNativeFast: true } } }
    },
  }) })
  target.allowed = true
  target.mainFrameId = 'main'
  target.contexts.set(1, { auxData: { isDefault: true, frameId: 'main' } })
  assert.equal((await target.syncModels({})).status, 'pending')
  assert.deepEqual(calls, ['Runtime.evaluate'])
  assert.equal(target.nativeFastReloadAttempted, false)
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
  assert.equal(Buffer.from(calls.at(-1).params.body, 'base64').toString(), adaptNativeFastSource(adaptNativeGateSource(nativeSource)))
  const before = calls.length
  await assert.rejects(target.adaptNativeScript({ requestId: 'other', responseStatusCode: 200,
    request: { url: 'https://example.com/app-initial-438d1df57f70.js' },
  }), /could not be adapted/)
  assert.deepEqual(calls.slice(before), [{ method: 'Fetch.continueRequest', params: { requestId: 'other' } }])
})

test('numeric ESM asset interception adapts native chunks and continues unrelated code unchanged', async () => {
  const calls = []
  let source = chunkFastSource
  const target = new AssistantTarget({}, null, { connectionFactory: () => ({
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'Fetch.getResponseBody') return { body: source }
      return {}
    },
  }) })
  const request = (url) => ({ requestId: 'chunk', responseStatusCode: 200, request: { url } })
  await target.adaptNativeScript(request('app://-/assets/async/634175.4437e0034c.js'))
  assert.equal(calls.at(-1).method, 'Fetch.fulfillRequest')
  assert.equal(Buffer.from(calls.at(-1).params.body, 'base64').toString(), adaptNativeChunkSource(source))
  source = 'export const value=42;'
  await target.adaptNativeScript(request('app://-/assets/async/123456.abcdef0123.js'))
  assert.equal(calls.at(-1).method, 'Fetch.continueRequest')
  for (const url of ['https://example.com/assets/async/634175.4437e0034c.js',
    'app://-/assets/async/other.4437e0034c.js', 'app://-/assets/async/634175.4437e0034c.js?untrusted']) {
    const before = calls.length
    await assert.rejects(target.adaptNativeScript(request(url)), /could not be adapted/)
    assert.deepEqual(calls.slice(before).map((call) => call.method), ['Fetch.continueRequest'])
  }
})

test('an incompatible Fast adapter still delivers the feature gates and reports the problem', async () => {
  const calls = []
  const reports = []
  const source = 'let g=Mb(`1506311413`);'
  const target = new AssistantTarget({}, null, { report: (message) => reports.push(message), connectionFactory: () => ({
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'Fetch.getResponseBody') return { body: source }
      return {}
    },
  }) })
  await target.adaptNativeScript({ requestId: 'gates', responseStatusCode: 200,
    request: { url: 'app://-/assets/app-initial-ad16eaadf81f.js' }, responseHeaders: [] })
  const fulfilled = calls.find((call) => call.method === 'Fetch.fulfillRequest')
  assert.match(Buffer.from(fulfilled.params.body, 'base64').toString(), /g=Mb\(!0\)/)
  assert.equal(calls.some((call) => call.method === 'Fetch.continueRequest'), false)
  assert.equal(reports.length, 1)
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

test('Codex restart keeps its helper alive until the hidden packaged launcher finishes', async () => {
  let launcher
  let finished = false
  const restarting = restartCodex((executable, args, options) => {
    assert.equal(path.basename(executable).toLowerCase(), 'powershell.exe')
    assert.ok(args.includes('-NonInteractive'))
    assert.equal(path.basename(args[args.indexOf('-File') + 1]), 'launch-codex.ps1')
    assert.ok(args.includes('-Supervise'))
    assert.equal(args.at(-1), '-Restart')
    assert.deepEqual(options, { detached: false, stdio: 'ignore', windowsHide: true })
    launcher = new EventEmitter()
    launcher.unref = () => assert.fail('PowerShell must remain referenced until the launcher finishes.')
    queueMicrotask(() => launcher.emit('spawn'))
    return launcher
  }).then(() => { finished = true })
  await delay(0)
  assert.equal(finished, false)
  launcher.emit('close', 0)
  await restarting
  assert.equal(finished, true)
})

test('Codex restart reports launcher startup and execution failures', async () => {
  for (const code of [1, null]) {
    await assert.rejects(restartCodex(() => {
      const launcher = new EventEmitter()
      queueMicrotask(() => {
        launcher.emit('spawn')
        setImmediate(() => launcher.emit('close', code))
      })
      return launcher
    }), /Codex could not restart/)
  }
  await assert.rejects(restartCodex(() => {
    const launcher = new EventEmitter()
    queueMicrotask(() => launcher.emit('error', new Error('isolated launcher spawn failure')))
    return launcher
  }), /isolated launcher spawn failure/)
})

const isolatedRestartPrelude = `[CmdletBinding()]\nparam([switch]$Restart, [switch]$Supervise, ` +
  `[string]$UpdateInstaller, [string]$UpdateSha256)\n` +
  `$ErrorActionPreference = 'Stop'\n$env:PSModulePath = "$PSHOME\\Modules;$env:PSModulePath"\n` +
  `$ast = [Management.Automation.Language.Parser]::ParseFile(` +
  `'${fileURLToPath(new URL('./launch-codex.ps1', import.meta.url)).replaceAll("'", "''")}', [ref]$null, [ref]$null)\n` +
  `foreach ($name in 'Quote-StartArgument', 'Start-IndependentLauncher') {\n` +
  `  $function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)\n` +
  `  Invoke-Expression $function.Extent.Text\n}\n` +
  `if ($Supervise) { exit (Start-IndependentLauncher -ScriptPath $PSCommandPath -Restart:$Restart ` +
  `-UpdateInstaller $UpdateInstaller -UpdateSha256 $UpdateSha256) }\n`

test('restart executes a real hidden PowerShell process and observes its result without closing Codex', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-restart-process-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, 'isolated launcher.ps1')
  const marker = path.join(directory, 'executed.txt')
  await fs.writeFile(script, isolatedRestartPrelude +
    `if (-not $Restart) { exit 7 }\n` +
    `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', ` +
    `(@{restart=[bool]$Restart;installer=$UpdateInstaller;sha256=$UpdateSha256} | ConvertTo-Json -Compress))\nexit 0\n`, 'utf8')
  const launch = (executable, args, options) => {
    const replaced = [...args]
    replaced[replaced.indexOf('-File') + 1] = script
    return spawn(executable, replaced, options)
  }
  await restartCodex(launch)
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { restart: true, installer: '', sha256: '' })
  const installer = { path: path.join(directory, "update with 'quotes'.exe"), sha256: 'a'.repeat(64) }
  await restartCodex(launch, { installer })
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')),
    { restart: true, installer: installer.path, sha256: installer.sha256 })
  await fs.writeFile(script, isolatedRestartPrelude + 'exit 9\n', 'utf8')
  await assert.rejects(restartCodex(launch), /Codex could not restart/)
})

test('restart launcher can open a new process after an installer terminates its calling helper', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-restart-handoff-'))
  const result = path.join(directory, 'desktop.json')
  const supervisor = path.join(directory, 'launcher.json')
  const trace = path.join(directory, 'trace.log')
  t.after(async () => {
    for (const file of [result, supervisor]) {
      const saved = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)
      if (saved?.pid) {
        try { process.kill(saved.pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  const desktop = path.join(directory, 'desktop.mjs')
  await fs.writeFile(desktop, `import fs from 'node:fs'\n` +
    `fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({pid:process.pid}))\nsetInterval(() => {}, 1000)\n`, 'utf8')
  const script = path.join(directory, 'launcher.ps1')
  await fs.writeFile(script, isolatedRestartPrelude +
    `$Desktop = '${desktop.replaceAll("'", "''")}'\n$Node = '${process.execPath.replaceAll("'", "''")}'\n` +
    `$Caller = (Get-Content -LiteralPath '${supervisor.replaceAll("'", "''")}' -Raw | ConvertFrom-Json).caller\n` +
    `$trace = Join-Path (Split-Path -Parent $Desktop) 'trace.log'\n` +
    `if (-not $Restart) { exit 7 }\nStart-Sleep -Milliseconds 500\n` +
    `[IO.File]::AppendAllText($trace, "started\\n")\n` +
    `Stop-Process -Id $Caller -Force -ErrorAction Stop\n` +
    `[IO.File]::AppendAllText($trace, "caller-stopped\\n")\n` +
    `Start-Process -FilePath $Node -ArgumentList ('"' + $Desktop + '"') -WindowStyle Hidden\n` +
    `[IO.File]::AppendAllText($trace, "desktop-started\\n")\n`, 'utf8')
  const driver = path.join(directory, 'driver.mjs')
  await fs.writeFile(driver, `import {spawn} from 'node:child_process'\nimport fs from 'node:fs'\n` +
    `import {restartCodex} from ${JSON.stringify(new URL('./codex-assistant.mjs', import.meta.url).href)}\n` +
    `await restartCodex((executable, args, options) => {\n` +
    `  args[args.indexOf('-File') + 1] = ${JSON.stringify(script)}\n` +
    `  const child = spawn(executable, args, options)\n` +
    `  fs.writeFileSync(${JSON.stringify(supervisor)}, JSON.stringify({pid:child.pid,caller:process.pid}))\n  return child\n})\n`, 'utf8')
  const caller = spawn(process.execPath, [driver], { windowsHide: true, stdio: 'ignore', timeout: 15000 })
  const [code] = await once(caller, 'close')
  assert.notEqual(code, 0, 'the isolated installer must stop its calling helper')
  let started
  const deadline = Date.now() + 10000
  while (!started && Date.now() < deadline) {
    started = await fs.readFile(result, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!started) await delay(50)
  }
  const phases = await fs.readFile(trace, 'utf8').catch(() => 'launcher did not execute')
  assert.ok(started?.pid, `the launcher must survive its calling helper and open the new desktop process: ${phases}`)
  assert.doesNotThrow(() => process.kill(started.pid, 0))
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

function makeConnectionFactory({ state = closedPanel, onEnable, syncStatus, restartBlocker = null,
  nativeCheck = { status: 'repairable', canRepair: true, fast: true, ultra: true } } = {}) {
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
          if (method === 'Runtime.evaluate' && params.expression.startsWith('(async function codexRestartBlocker')) {
            return { result: { value: typeof restartBlocker === 'function' ? restartBlocker() : restartBlocker } }
          }
          if (method === 'Runtime.evaluate' && params.expression.startsWith('(async function inspectNativeControls')) {
            return { result: { value: nativeCheck } }
          }
          if (method === 'Runtime.evaluate' && params.expression.includes('runtime.startNativeRepair()')) {
            return { result: { value: true } }
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
    diagnose: async () => assert.fail('model diagnostics require an explicit manual request'),
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

test('update checks do not hold up account actions but are included in queue drain', async () => {
  let complete
  const request = createRequestQueue(({ action }) => action === 'checkUpdate'
    ? new Promise((resolve) => { complete = resolve }) : { loggedIn: true })
  const check = request(JSON.stringify({ id: 1, action: 'checkUpdate' }))
  const status = await request(JSON.stringify({ id: 2, action: 'status' }))
  assert.equal(status.ok, true)
  assert.equal(request.isIdle(), false)
  let drained = false
  const drain = request.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  complete({ available: false })
  await check
  await drain
  assert.equal(request.isIdle(), true)
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
    let send
    const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
    let polls = 0
    const result = await runAssistant(assistantOptions({
      handler: async () => ({ loggedIn: true }), restartDelayMs: 0,
      isRunning: () => ++polls <= 5, connectionFactory: factory,
      onReady() {
        send({ method: 'Runtime.bindingCalled', params: {
          name: 'yisamaAssistantCommand', payload: JSON.stringify({ id: 1, action }), executionContextId: 1,
        } })
      },
    }))
    assert.deepEqual(result, expected, action)
    assert.ok(connections[0].calls.some((call) => call.method === 'Runtime.evaluate' &&
      call.params.expression.includes('"id":1,"ok":true')))
  }
})

test('restore restarts only after its successful reply and never resynchronizes the old account', async () => {
  for (const [restored, expected] of [[true, { restartCodex: true }], [false, undefined]]) {
    let send
    let configured = true
    const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
    let polls = 0
    const result = await runAssistant(assistantOptions({
      handler: async () => {
        configured = false
        return { loggedIn: false, restartRequired: restored }
      },
      nativeConfiguration: async () => configured ? { version: 'owned-before-restore', models: [] } : null,
      restartDelayMs: 0,
      isRunning: () => ++polls <= 5,
      connectionFactory: factory,
      onReady() {
        send({ method: 'Runtime.bindingCalled', params: {
          name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"restore"}', executionContextId: 1,
        } })
      },
    }))
    const calls = connections[0].calls
    const reply = calls.findIndex((call) => call.method === 'Runtime.evaluate' &&
      call.params.expression.includes('"id":1,"ok":true'))
    assert.notEqual(reply, -1, 'the logout result must reach the panel before restarting')
    const laterSyncs = calls.slice(reply + 1).filter((call) =>
      call.method === 'Runtime.evaluate' && call.params.expression.startsWith('(async function syncNativeModels'))
    assert.ok(laterSyncs.every((call) => call.params.expression.endsWith('(null)')),
      'restoration must never log back in using the account cached in Codex')
    assert.deepEqual(result, expected)
  }
})

test('blocked account changes leave the account untouched and never restart later', async () => {
  for (const action of ['restore', 'reconfigure']) {
    for (const blocker of ['draft', 'busy', 'unavailable']) {
      let send
      let handled = false
      const { factory, connections } = makeConnectionFactory({
        restartBlocker: blocker, onEnable: (onEvent) => { send = onEvent },
      })
      let polls = 0
      const result = await runAssistant(assistantOptions({
        handler: async () => { handled = true; return { restartRequired: true } },
        restartDelayMs: 0, isRunning: () => ++polls <= 4, connectionFactory: factory,
        onReady() {
          send({ method: 'Runtime.bindingCalled', params: {
            name: 'yisamaAssistantCommand', payload: JSON.stringify({ id: 1, action }), executionContextId: 1,
          } })
        },
      }))
      assert.equal(handled, false, blocker)
      assert.equal(result, undefined, blocker)
      const code = `${action === 'restore' ? 'RESTORE' : 'RESTART'}_${blocker === 'unavailable' ? 'CHECK_FAILED' : 'BLOCKED'}`
      assert.ok(connections[0].calls.some((call) => call.method === 'Runtime.evaluate' &&
        call.params.expression.includes(code)))
    }
  }
})

test('a failed restore cannot schedule a restart or claim that logout succeeded', async () => {
  let send
  const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
  let polls = 0
  const result = await runAssistant(assistantOptions({
    handler: async () => { throw new Error('Isolated restore failure.') },
    restartDelayMs: 0, isRunning: () => ++polls <= 4, connectionFactory: factory,
    onReady() {
      send({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"restore"}', executionContextId: 1,
      } })
    },
  }))
  assert.equal(result, undefined)
  assert.ok(connections[0].calls.some((call) => call.method === 'Runtime.evaluate' &&
    call.params.expression.includes('"id":1,"ok":false')))
})

test('restore cannot race a model poll into writing the previous account back', async () => {
  let send
  let requested = false
  let restored = false
  const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
  let polls = 0
  await runAssistant(assistantOptions({
    handler: async () => { restored = true; return { loggedIn: false, restartRequired: true } },
    nativeConfiguration: async () => {
      if (requested) return null
      requested = true
      send({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"restore"}', executionContextId: 1,
      } })
      await new Promise(setImmediate)
      return { version: 'account-read-before-restore', models: [] }
    },
    restartDelayMs: 0, isRunning: () => ++polls <= 4, connectionFactory: factory,
  }))
  assert.equal(restored, true)
  const calls = connections[0].calls
  const reply = calls.findIndex((call) => call.method === 'Runtime.evaluate' &&
    call.params.expression.includes('"id":1,"ok":true'))
  assert.notEqual(reply, -1)
  assert.ok(!calls.slice(reply + 1).some((call) => call.method === 'Runtime.evaluate' &&
    call.params.expression.includes('account-read-before-restore')))
})

test('restart preflight checks drafts and active threads without changing authentication', async () => {
  for (const [draft, active, failure, expected] of [
    ['', false, '', null],
    ['unsent message', false, '', 'draft'],
    ['', true, '', 'busy'],
    ['', false, 'thread/loaded/list', 'unavailable'],
  ]) {
    const { state, window, calls } = nativeSyncFixture()
    Object.assign(state, { draft, active, failMethod: failure })
    const blocker = await runInNewContext(`(${codexRestartBlocker.toString()})()`, {
      window, location: { href: CODEX_PAGE }, crypto: webcrypto, setTimeout, clearTimeout,
      document: { querySelectorAll: () => [{ isContentEditable: true, get textContent() { return state.draft } }] },
    })
    assert.equal(blocker, expected)
    assert.ok(calls.every((method) => ['thread/loaded/list', 'thread/read'].includes(method)))
  }
})

test('hidden and read-only fields do not falsely prevent restarting', async () => {
  for (const node of [
    { value: 'hidden username', closest: () => ({}) },
    { value: 'invisible form', getClientRects: () => [] },
    { value: 'displayed account', readOnly: true },
    { value: 'disabled field', disabled: true },
  ]) {
    const { window } = nativeSyncFixture()
    const blocker = await runInNewContext(`(${codexRestartBlocker.toString()})()`, {
      window, location: { href: CODEX_PAGE }, crypto: webcrypto, setTimeout, clearTimeout,
      document: { querySelectorAll: () => [node] },
    })
    assert.equal(blocker, null)
  }
})

test('a launcher failure reaches the still-mounted panel and permits a second restart attempt', async () => {
  let send
  let attempts = 0
  const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
  let polls = 0
  const reports = []
  const result = await runAssistant(assistantOptions({
    handler: async () => ({ restartRequired: true }), restartDelayMs: 0,
    restart: async () => { attempts++; throw new Error('isolated restart failure') },
    report: (message) => reports.push(message),
    isRunning: () => ++polls <= 5, connectionFactory: factory,
    onReady() {
      send({ method: 'Runtime.bindingCalled', params: {
        name: 'yisamaAssistantCommand', payload: '{"id":1,"action":"reconfigure"}', executionContextId: 1,
      } })
    },
  }))
  assert.equal(result, undefined)
  assert.equal(attempts, 1, 'a failed restart must not retry or close Codex later')
  assert.equal(reports.length, 1)
  const calls = connections[0].calls
  const notify = calls.findIndex((call) => call.params?.expression?.includes('restartFailed'))
  const dispose = calls.findIndex((call) => call.method === 'Runtime.removeBinding')
  assert.ok(notify !== -1 && dispose > notify, 'the failure must be shown before renderer cleanup')
})

test('manual self-repair never interrupts drafts, active tasks or unavailable activity checks', async () => {
  for (const blocker of ['busy', 'draft', 'unavailable']) {
    let send
    let polls = 0
    const { factory, connections } = makeConnectionFactory({ restartBlocker: blocker,
      onEnable: (event) => { send = event } })
    await runAssistant(assistantOptions({
      handler: async () => assert.fail('self-repair must not invoke account changes'),
      nativeConfiguration: async () => null,
      isRunning: () => ++polls <= 5, connectionFactory: factory,
      onReady() {
        send({ method: 'Runtime.bindingCalled', params: { name: 'yisamaAssistantCommand',
          payload: '{"id":44,"action":"codexRepair","confirmed":true}', executionContextId: 1 } })
      },
    }))
    const calls = connections[0].calls
    assert.ok(calls.some((call) => call.params?.expression?.includes('"code":"CODEX_REPAIR_BLOCKED"')), blocker)
    assert.equal(calls.some((call) => call.params?.expression?.includes('runtime.startNativeRepair()')), false)
    assert.equal(calls.some((call) => call.method === 'Page.reload'), false)
  }
})

test('only manual diagnostic requests call the model; self-check never starts a repair', async () => {
  for (const action of [null, 'codexCheck', 'codexRepair']) {
    let send
    let polls = 0
    let modelCalls = 0
    const { factory, connections } = makeConnectionFactory({ onEnable: (event) => { send = event } })
    await runAssistant(assistantOptions({
      connectionFactory: factory, isRunning: () => ++polls <= 5,
      nativeConfiguration: async () => diagnosticSettings,
      diagnose: async (settings, check, options) => {
        modelCalls++
        assert.equal(settings.apiKey, diagnosticSettings.apiKey)
        assert.equal(check.status, 'repairable')
        assert.equal(options.action, action)
        return { summary: '建议同步控件', repair: true }
      },
      onReady() {
        if (action) send({ method: 'Runtime.bindingCalled', params: {
          name: 'yisamaAssistantCommand', executionContextId: 1,
          payload: JSON.stringify({ id: 51, action, ...(action === 'codexRepair' ? { confirmed: true } : {}) }),
        } })
      },
    }))
    assert.equal(modelCalls, action ? 1 : 0)
    const expressions = connections[0].calls.map((call) => call.params?.expression || '').join('\n')
    assert.equal(expressions.includes('runtime.startNativeRepair()'), action === 'codexRepair')
    if (action) {
      assert.match(expressions, /"billing":"account"/)
      assert.doesNotMatch(expressions, /"cost":0/)
    }
  }
})

test('tasks or changed credentials during model analysis prevent repair without scheduling it later', async () => {
  for (const change of ['busy', 'credential', 'model', 'declined']) {
    let send
    let polls = 0
    let blocker = null
    let settings = diagnosticSettings
    let modelCalls = 0
    const { factory, connections } = makeConnectionFactory({
      onEnable: (event) => { send = event }, restartBlocker: () => blocker,
    })
    await runAssistant(assistantOptions({
      connectionFactory: factory, isRunning: () => ++polls <= 5,
      nativeConfiguration: async () => settings,
      diagnose: async () => {
        modelCalls++
        if (change === 'busy') blocker = 'busy'
        if (change === 'credential') settings = { ...settings, apiKey: 'sk-changed-account', version: 'changed' }
        if (change === 'model') settings = { ...settings, model: 'gpt-other-model' }
        return { summary: '模型分析完成', repair: change !== 'declined' }
      },
      onReady() {
        send({ method: 'Runtime.bindingCalled', params: { name: 'yisamaAssistantCommand', executionContextId: 1,
          payload: '{"id":52,"action":"codexRepair","confirmed":true}' } })
      },
    }))
    assert.equal(modelCalls, 1)
    const expressions = connections[0].calls.map((call) => call.params?.expression || '').join('\n')
    assert.equal(expressions.includes('runtime.startNativeRepair()'), false)
    if (change !== 'declined') assert.match(expressions,
      change === 'busy' ? /CODEX_REPAIR_BLOCKED/ : /CODEX_DIAGNOSTIC_CONFIGURATION/)
    assert.equal(connections[0].calls.some((call) => call.method === 'Page.reload'), false)
  }
})

test('interrupting tasks requires explicit consent and unavailable activity checks are never bypassed', async () => {
  for (const [blocker, consent, expected] of [
    ['busy', false, false], ['draft', false, false], ['busy', true, true],
    ['draft', true, true], ['unavailable', true, false],
  ]) {
    let send
    let restarted = false
    const { factory } = makeConnectionFactory({ restartBlocker: blocker, onEnable: (event) => { send = event } })
    let polls = 0
    await runAssistant(assistantOptions({
      handler: async () => ({ restartRequired: true }), restartDelayMs: 0,
      restart: async () => { restarted = true },
      isRunning: () => ++polls <= 5, connectionFactory: factory,
      onReady() {
        send({ method: 'Runtime.bindingCalled', params: { name: 'yisamaAssistantCommand',
          payload: JSON.stringify({ id: 1, action: 'reconfigure', allowInterrupt: consent }), executionContextId: 1 } })
      },
    }))
    assert.equal(restarted, expected, `${blocker}, consent=${consent}`)
  }
})

test('prepared updates only reach the launcher after the success reply and are not exposed to the UI', async () => {
  let send
  let plan
  const { factory, connections } = makeConnectionFactory({ onEnable: (onEvent) => { send = onEvent } })
  let polls = 0
  const installer = { path: path.resolve('isolated-setup.exe'), sha256: 'a'.repeat(64) }
  const result = await runAssistant(assistantOptions({
    handler: async () => ({ restartRequired: true, updateInstaller: installer }), restartDelayMs: 0,
    restart: async (_spawn, options) => {
      plan = options
      assert.ok(connections[0].calls.some((call) => call.params?.expression?.includes('"id":1,"ok":true')))
    },
    isRunning: () => ++polls <= 5, connectionFactory: factory,
    onReady() {
      send({ method: 'Runtime.bindingCalled', params: { name: 'yisamaAssistantCommand',
        payload: JSON.stringify({ id: 1, action: 'installUpdate', updateId: 'b'.repeat(64) }), executionContextId: 1 } })
    },
  }))
  assert.deepEqual(result, { restarted: true })
  assert.deepEqual(plan, { installer })
  const reply = connections[0].calls.find((call) => call.params?.expression?.includes('"id":1,"ok":true'))
  assert.ok(!reply.params.expression.includes('isolated-setup.exe'))
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
