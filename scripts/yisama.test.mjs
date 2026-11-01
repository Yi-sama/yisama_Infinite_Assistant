import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'smol-toml'

import {
  chooseGroup,
  classifyPricing,
  textModels,
  chooseModel,
  chooseReasoning,
  desktopRestartRequired,
  formatQuota,
  patchCodexConfig,
  safeError,
  signIn,
  submitPaymentForm,
} from './yisama.mjs'
import { makeModelCatalog, providerConfig, restoreOwned } from './codex-config.mjs'

test('defaults to All and preserves available groups', () => {
  assert.deepEqual(chooseGroup(undefined, ['auto', 'default', 'premium']), {
    value: 'auto',
    label: 'All',
    availableGroups: ['auto', 'default', 'premium'],
  })
})

test('accepts All case-insensitively', () => {
  assert.equal(chooseGroup('ALL', ['auto', 'default']).value, 'auto')
  assert.throws(() => chooseGroup('all', ['default']), /不可用/)
})

test('patches Codex provider without removing unrelated config', () => {
  const original = [
    'model = "gpt-5"',
    'model_provider = "custom"',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    '',
    '[model_providers.yisama]',
    'name = "old"',
    '',
    '[mcp_servers.example]',
    'command = "node"',
  ].join('\n')

  const patched = patchCodexConfig(original, 'https://relay.example')
  const config = parse(patched)
  assert.equal(config.model, 'gpt-5')
  assert.equal(config.model_provider, 'yisama')
  assert.equal(config.service_tier, 'fast')
  assert.equal(config.model_providers.yisama.base_url, 'https://relay.example/v1')
  assert.equal(config.model_providers.custom.name, 'custom')
  assert.equal(config.mcp_servers.example.command, 'node')
})

test('provider block uses Responses wire format and local auth', () => {
  const provider = providerConfig()
  assert.equal(provider.wire_api, 'responses')
  assert.equal(provider.requires_openai_auth, true)
  assert.equal(provider.env_key, undefined)
})

test('submits gateway fields before opening the checkout page', async () => {
  let request
  const payment = await submitPaymentForm('https://pay.example/submit.php', {
    pid: '4862221745', money: 1, sign: 'secret',
  }, async (url, options) => {
    request = { url, options }
    return new Response(null, { status: 302, headers: { location: '/checkout/test-token' } })
  })
  assert.equal(request.url, 'https://pay.example/submit.php')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.redirect, 'manual')
  assert.equal(String(request.options.body), 'pid=4862221745&money=1&sign=secret')
  assert.deepEqual(payment, {
    paymentUrl: 'https://pay.example/checkout/test-token',
    fields: {},
  })
})

test('native catalogs keep known model capabilities without inventing them for other providers', () => {
  const known = { slug: 'gpt-known', supported_reasoning_levels: [{ effort: 'high' }],
    default_reasoning_level: 'high', base_instructions: 'Known model instructions', context_window: 100000 }
  const catalog = makeModelCatalog(['gpt-known', 'gemini-3-flash', 'gpt-image-1'], [known])
  assert.deepEqual(catalog.models.map((model) => model.slug), ['gpt-known', 'gemini-3-flash'])
  assert.equal(catalog.models[0].base_instructions, known.base_instructions)
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, known.supported_reasoning_levels)
  assert.deepEqual(catalog.models[1].supported_reasoning_levels, [])
  assert.equal(catalog.models[1].context_window, null)
  assert.equal(catalog.models[1].supports_search_tool, false)
  assert.deepEqual(known, { slug: 'gpt-known', supported_reasoning_levels: [{ effort: 'high' }],
    default_reasoning_level: 'high', base_instructions: 'Known model instructions', context_window: 100000 })
})

test('native catalogs expose verified reasoning levels for every current GPT relay model', () => {
  const models = [
    'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra',
    'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-reserve',
  ]
  const known = [{ slug: 'gpt-6.1-sol', default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'xhigh', description: 'Existing metadata' }] }]
  const catalog = makeModelCatalog(models, known)
  const expected = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  for (const model of catalog.models) {
    assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), expected)
  }
  assert.equal(catalog.models.find((model) => model.slug === 'gpt-6.1-sol')
    .supported_reasoning_levels.find((level) => level.effort === 'xhigh').description, 'Existing metadata')
  assert.equal(catalog.models.find((model) => model.slug === 'gpt-6.1-terra').default_reasoning_level, 'medium')
})

test('native Fast tiers follow the group and the relay model policy, not stale metadata', () => {
  const known = [{ slug: 'gpt-5.5', service_tiers: [
    { id: 'priority', name: 'Fast', description: 'Old description' },
    { id: 'ultrafast', name: 'Ultra Fast', description: 'Not supported by this relay' },
  ], additional_speed_tiers: ['fast', 'ultrafast'], default_service_tier: 'ultrafast' }]
  const models = ['gpt-5.5', 'gpt-6.1-sol', 'gemini-3-flash', 'gpt-5-pro', 'Auto']
  const enabled = makeModelCatalog(models, known, { fast: true })
  for (const model of enabled.models.slice(0, 2)) {
    assert.deepEqual(model.service_tiers.map((tier) => [tier.id, tier.name]), [['priority', 'Fast']])
    assert.equal(model.default_service_tier, 'priority')
    assert.deepEqual(model.additional_speed_tiers, ['fast'])
  }
  for (const model of [...enabled.models.slice(2), ...makeModelCatalog(models, known).models]) {
    assert.deepEqual(model.service_tiers, [])
    assert.deepEqual(model.additional_speed_tiers, [])
    assert.equal(model.default_service_tier, null)
  }
  assert.equal(known[0].default_service_tier, 'ultrafast', 'source metadata must remain untouched')
})

test('preserves quoted tables, multiline strings, and updates the active profile', () => {
  const original = `profile = "work"
model_provider = "old"
note = """
[model_providers.yisama]
this is not a table
"""
[profiles."work"]
model_provider = "old"
model = "old-model"
[model_providers."old"]
name = "old"
["mcp_servers"."quoted.name"]
command = "node"
args = ["a", "b"]
`
  const result = parse(patchCodexConfig(original, 'https://relay.example', 'gpt-5-codex'))
  assert.match(result.note, /this is not a table/)
  assert.equal(result.profiles.work.model_provider, 'yisama')
  assert.equal(result.profiles.work.model, 'gpt-5-codex')
  assert.deepEqual(result.mcp_servers['quoted.name'].args, ['a', 'b'])
  assert.throws(() => patchCodexConfig('model = ['))
})

test('quota is the wallet balance, not the unlimited token allowance', () => {
  assert.equal(formatQuota({ quota: 6250000, unlimited_quota: true }, {
    quota_per_unit: 500000, quota_display_type: 'USD',
  }), '$12.50')
  assert.equal(formatQuota({}, { quota_per_unit: 500000 }), '暂时无法读取')
  assert.equal(formatQuota({ quota: -500000 }, { quota_per_unit: 500000 }), '$-1.00')
})

test('reasoning levels are model-specific and Ultra never falls back to XHigh', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  assert.equal(chooseReasoning('Ultra', 'high', levels), 'ultra')
  assert.equal(chooseReasoning(undefined, 'ultra', levels), 'ultra')
  assert.equal(chooseReasoning(undefined, 'ultra', ['low', 'high']), null)
  assert.equal(chooseReasoning('auto', 'ultra', levels), null)
  assert.equal(chooseReasoning(undefined, 'high', null), null)
  assert.throws(() => chooseReasoning('ultra', 'high', ['high', 'xhigh']), /未列出/)
  assert.throws(() => chooseReasoning('ultra', 'high', null), /暂无法确认/)
  assert.throws(() => chooseReasoning('unknown', 'high', levels), /无效/)
})

test('reasoning updates and auto apply to both root and active profile only', () => {
  const original = `profile = "work"
model_reasoning_effort = "high"
[profiles.work]
model_reasoning_effort = "xhigh"
[profiles.personal]
model_reasoning_effort = "low"
`
  const ultra = patchCodexConfig(original, undefined, undefined, 'ultra')
  const config = parse(ultra)
  assert.equal(config.model_reasoning_effort, 'ultra')
  assert.equal(config.profiles.work.model_reasoning_effort, 'ultra')
  assert.equal(config.profiles.personal.model_reasoning_effort, 'low')
  const automatic = parse(patchCodexConfig(ultra, undefined, undefined, null))
  assert.equal(automatic.model_reasoning_effort, undefined)
  assert.equal(automatic.profiles.work.model_reasoning_effort, undefined)
  assert.equal(automatic.profiles.personal.model_reasoning_effort, 'low')
  assert.equal(parse(patchCodexConfig(original)).model_reasoning_effort, 'high')
})

test('model choice prefers an available model and rejects non-text-only groups', () => {
  assert.equal(chooseModel(['gpt-5-codex', 'gpt-5'], 'gpt-5'), 'gpt-5')
  assert.equal(chooseModel(['gpt-5', 'gpt-5-codex'], 'missing'), 'gpt-5-codex')
  assert.equal(chooseModel(['Auto', 'gemini-3-flash']), 'gemini-3-flash')
  assert.equal(chooseModel(['Auto', 'deepseek-v4-pro', 'qwen3-max']), 'deepseek-v4-pro')
  assert.throws(() => chooseModel(['gpt-image-1', 'whisper-1', 'image-only', 'gemini-3-pro-image']), /没有可自动选择/)
})

test('ordinary groups remove Fast from the root and active profile only', () => {
  const config = parse(patchCodexConfig(`profile = "work"
service_tier = "fast"
[profiles.work]
service_tier = "fast"
[profiles.personal]
service_tier = "fast"
`, undefined, 'gemini-3-flash', null, false))
  assert.equal(config.service_tier, undefined)
  assert.equal(config.profiles.work.service_tier, undefined)
  assert.equal(config.profiles.personal.service_tier, 'fast')
})

test('restart notice depends on the Codex launch, not the helper launch', () => {
  const state = { restartRequired: true, configuredAt: '2026-10-29T03:00:00.000Z' }
  assert.equal(desktopRestartRequired(state, '2026-10-29T02:00:00.000Z'), true)
  assert.equal(desktopRestartRequired(state, '2026-10-29T04:00:00.000Z'), false)
  assert.equal(desktopRestartRequired(state, 'invalid'), true)
  assert.equal(desktopRestartRequired({ restartRequired: true }, '2026-10-29T04:00:00.000Z'), true)
  assert.equal(desktopRestartRequired({}, 'invalid'), false)
})

test('three-way restore keeps later user changes including newly added tables', () => {
  assert.deepEqual(restoreOwned(
    { model: 'old', existing: 1 },
    { model: 'installed', existing: 1, provider: { name: 'yisama', url: 'relay' } },
    { model: 'user-choice', existing: 2, provider: { name: 'yisama', url: 'custom' }, added: true },
  ), { model: 'user-choice', existing: 2, provider: { url: 'custom' }, added: true })
})

test('unexpected errors never echo secrets to the user', () => {
  assert.doesNotMatch(safeError(new Error('Authorization: Bearer sk-secret-123')), /sk-secret|Authorization/)
  assert.doesNotMatch(safeError(new AggregateError([], 'sk-secret-123')), /sk-secret/)
})

test('direct login sends the Turnstile result to the official login endpoint', async () => {
  const requests = []
  const auth = await signIn({
    username: 'demo',
    password: 'password',
    turnstile: 'turnstile-result',
    origin: 'https://relay.example',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options })
      return new Response(JSON.stringify({
        success: true,
        data: { access_token: 'a'.repeat(32) },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(auth.data.access_token.length, 32)
  assert.match(requests[0].url, /\/api\/user\/login\?turnstile=turnstile-result$/)
  assert.equal(JSON.parse(requests[0].options.body).username, 'demo')
})

test('two-factor login reuses the returned flow token without retrying password login', async () => {
  const requests = []
  const auth = await signIn({
    username: 'demo',
    password: 'password',
    turnstile: 'turnstile-result',
    twoFactorCode: '123456',
    origin: 'https://relay.example',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options })
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          success: true,
          data: { flow_token: 'flow-token' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        success: true,
        data: { access_token: 'b'.repeat(32) },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(auth.data.access_token.length, 32)
  assert.equal(requests.length, 2)
  assert.match(requests[1].url, /\/api\/user\/login\/2fa$/)
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    flow_token: 'flow-token',
    code: '123456',
  })
})

test('pricing classification keeps only chat models and hides media groups', () => {
  const catalog = classifyPricing({ data: [
    { model_name: 'gpt-x', quota_type: 0, supported_endpoint_types: ['openai'], enable_groups: ['plus', 'mixed'] },
    { model_name: 'claude-x', quota_type: 0, supported_endpoint_types: ['anthropic', 'openai'], enable_groups: ['mixed'] },
    { model_name: 'gpt-free-call', quota_type: 1, model_price: 0, supported_endpoint_types: ['openai'], enable_groups: ['plus'] },
    { model_name: 'nano-banana', quota_type: 1, model_price: 0.2, supported_endpoint_types: ['openai'], enable_groups: ['images', 'mixed'] },
    { model_name: 'pic', quota_type: 1, supported_endpoint_types: ['image-generation', 'openai'], enable_groups: ['images'] },
    { model_name: 'seedance', quota_type: 1, supported_endpoint_types: ['openai', 'openai-video'], enable_groups: ['video'] },
    { model_name: 'seedance-2', quota_type: 1, supported_endpoint_types: ['openai', 'openai-video'], enable_groups: ['video'] },
    { model_name: 'chat-in-video', quota_type: 0, supported_endpoint_types: ['openai'], enable_groups: ['video'] },
  ] })
  assert.deepEqual([...catalog.mediaGroups].sort(), ['images', 'video'])
  assert.deepEqual(textModels(['gpt-x', 'claude-x', 'gpt-free-call', 'nano-banana', 'pic', 'seedance', 'tts-1', 'unknown-llm'], catalog),
    ['gpt-x', 'claude-x', 'gpt-free-call', 'unknown-llm'])
  assert.deepEqual(textModels(['gpt-x', 'gpt-image-2'], classifyPricing(null)), ['gpt-x'],
    'without pricing data the name-based filter still applies')
})
