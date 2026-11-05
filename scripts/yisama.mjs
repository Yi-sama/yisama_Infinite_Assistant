import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'
import { chromium, request as browserRequest } from 'playwright'
import {
  DEFAULT_ORIGIN, PROVIDER_ID, providerConfig, patchCodexConfig,
  readOptional, replaceFile, writeTransaction, configureCodex, restoreCodex, ConfigRecoveryError,
  makeModelCatalog,
} from './codex-config.mjs'

export { DEFAULT_ORIGIN, PROVIDER_ID, patchCodexConfig }
export const KEY_PREFIX = 'yisama-infinite-assistant'
const ASSISTANT_VERSION = '0.1.0'
const ASSISTANT_LICENSE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAwdYPN4l6iJ9vQDCV6FZEFPDrsAJBenNhJIeDGeMxf10='
const ASSISTANT_LICENSE_RENEW_BEFORE = 24 * 60 * 60
const assistantLicenseRequired = typeof __YISAMA_LICENSE_REQUIRED__ === 'undefined'
  ? false : __YISAMA_LICENSE_REQUIRED__
const REASONING_LABELS = {
  none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高',
  xhigh: '超高（XHigh）', max: '最高（Max）', ultra: '极致（Ultra）',
}
const execFileAsync = promisify(execFile)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'

class UserError extends Error {}

// Domestic users reach the relay through the Chengdu proxy when Cloudflare is unreachable.
// Sessions stay bound to the logical origin; only the transport host changes.
const ROUTE_FALLBACKS = new Map([[DEFAULT_ORIGIN, ['https://api-cn.yisama.asia']]])
const preferredRoute = new Map()
const FIRST_ROUTE_TIMEOUT = 8000
const LAST_ROUTE_TIMEOUT = 30000

export function routesFor(origin) {
  const all = [origin, ...(ROUTE_FALLBACKS.get(origin) || [])]
  const preferred = preferredRoute.get(origin)
  return preferred && all.includes(preferred) ? [preferred, ...all.filter((route) => route !== preferred)] : all
}

// Only a thrown (connection-level) failure moves to the next route; an HTTP answer never does.
export async function withRoute(origin, send, { retry = true } = {}) {
  const routes = routesFor(origin)
  let failure
  for (const [index, base] of routes.entries()) {
    try {
      const result = await send(base, index < routes.length - 1 ? FIRST_ROUTE_TIMEOUT : LAST_ROUTE_TIMEOUT)
      preferredRoute.set(origin, base)
      return result
    } catch (error) {
      failure = error
      if (!retry) break
    }
  }
  throw failure
}

function cookiesForHost(cookies, base) {
  return (cookies || []).map((cookie) => ({ ...cookie, domain: new URL(base).hostname }))
}

let desktopChallenge = null
const desktopCache = new Map()
const CATALOG_TTL = 30000
const DISPLAY_TTL = 300000
export const ASSISTANT_KEY_NAME = `${KEY_PREFIX}:codex`

async function cachedDesktopValue(key, ttl, load) {
  const cached = desktopCache.get(key)
  if (cached?.expiresAt > Date.now()) return cached.value
  const entry = { expiresAt: Date.now() + ttl, value: Promise.resolve().then(load) }
  desktopCache.set(key, entry)
  try {
    return await entry.value
  } catch (error) {
    if (desktopCache.get(key) === entry) desktopCache.delete(key)
    throw error
  }
}

// The assistant offers chat (LLM) routes only; image and video catalogues are hidden.
function desktopTextCatalog() {
  return cachedDesktopValue(`pricing:${originFromEnvironment()}`, DISPLAY_TTL,
    () => requestApi('/pricing').then(classifyPricing, () => classifyPricing(null)))
}

async function desktopGroupInfo(session, keep = '') {
  const [groups, catalog] = await Promise.all([
    cachedDesktopValue(`groups:${session.origin}:${session.token}`, CATALOG_TTL, () => fetchGroupInfo(session.token)),
    desktopTextCatalog(),
  ])
  const offered = groups.filter((group) => group.value === 'auto' || group.value === keep || !catalog.mediaGroups.has(group.value))
  // Once the relay names any group, the assistant offers only the named ones, in display_order;
  // the configured group stays so the panel can still show where the user is.
  if (!offered.some((group) => group.label)) return offered
  const rank = (group) => group.order ?? Number.MAX_SAFE_INTEGER
  return offered.filter((group) => group.label || group.value === keep).sort((a, b) => rank(a) - rank(b))
}

async function desktopModels(apiKey, group = '') {
  const [listing, catalog] = await Promise.all([
    cachedDesktopValue(`models:${originFromEnvironment()}:${group}:${apiKey}`, CATALOG_TTL, () => fetchModelListing(apiKey)),
    desktopTextCatalog(),
  ])
  const models = textModels(listing.models, catalog)
  const metadata = listing.metadata.filter((item) => models.includes(item.slug)).map((item) => {
    if (!Array.isArray(item.input_modalities) ||
      !item.input_modalities.every((value) => value === 'text' || value === 'image')) {
      throw new UserError('服务端模型输入能力格式无效，请稍后重试。')
    }
    return { ...item, input_modalities: [...new Set(item.input_modalities)] }
  })
  return { models, metadata }
}

function desktopDisplay() {
  return cachedDesktopValue(`display:${originFromEnvironment()}`, DISPLAY_TTL,
    () => requestApi('/status'))
}

function desktopAuthError(code, message) {
  const error = new UserError(message)
  error.publicCode = code
  return error
}

async function assistantAuthRequest(context, pathname, { method = 'POST', body } = {}) {
  const origin = originFromEnvironment()
  // Registration and password reset are not repeated on another route after a lost connection.
  const repeatable = method === 'GET' || pathname.startsWith('login')
  let response
  try {
    response = await withRoute(origin, async (base, timeout) => {
      await context.addCookies(cookiesForHost((await context.storageState()).cookies, base))
      return context.fetch(new URL(`/api/assistant/auth/${pathname}`, base).href,
        { method, data: body, maxRedirects: 0, timeout })
    }, { retry: repeatable })
  } catch {
    throw desktopAuthError('AUTH_CONNECTION', '暂时无法连接账号服务，请检查网络后重试。')
  }
  const payload = await response.json().catch(() => null)
  if (response.status() === 429) {
    throw desktopAuthError('AUTH_RATE_LIMIT', '操作过于频繁，请稍后再试。')
  }
  if (response.status() === 404) {
    throw desktopAuthError('AUTH_UNAVAILABLE', '助手登录服务尚未就绪，请联系管理员。')
  }
  if (response.status() >= 500 || !payload) {
    throw desktopAuthError('AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。')
  }
  if (!response.ok() || payload?.success !== true) {
    if (payload?.code === 'AUTH_SESSION_LIMIT') {
      throw desktopAuthError('AUTH_SESSION_LIMIT', '登录设备过多，请先退出其他设备。')
    }
    throw desktopAuthError('AUTH_REJECTED', pathname === 'register'
      ? '注册未完成，请检查账号、密码和邮箱验证码。'
      : pathname.startsWith('verification')
        ? '验证码发送失败，请检查邮箱或稍后重试。'
        : '登录未完成，请检查账号、密码或二次验证码。')
  }
  return payload
}

async function desktopAuthContext(cookies = []) {
  return browserRequest.newContext({
    storageState: { cookies, origins: [] },
    extraHTTPHeaders: { Origin: originFromEnvironment(), Accept: 'application/json' },
    userAgent: 'yisama-infinite-assistant/0.1.0',
    timeout: 30000,
    ignoreHTTPSErrors: false,
  })
}

export async function desktopAuthOptions() {
  const context = await desktopAuthContext()
  try {
    const { data } = await assistantAuthRequest(context, 'options', { method: 'GET' })
    return { auth: {
      passwordLoginEnabled: data?.password_login_enabled === true,
      registrationEnabled: data?.register_enabled === true,
      emailVerificationEnabled: data?.email_verification_enabled === true,
    } }
  } finally {
    await context.dispose()
  }
}

export async function desktopRegister({ username, password, email, verificationCode } = {}) {
  const context = await desktopAuthContext()
  try {
    await assistantAuthRequest(context, 'register', {
      body: { username, password, email, verification_code: verificationCode },
    })
    return { registered: true, message: '注册成功，请使用新账号登录。' }
  } finally {
    await context.dispose()
  }
}

export async function desktopSendVerification({ email } = {}) {
  const context = await desktopAuthContext()
  try {
    await assistantAuthRequest(context, `verification?email=${encodeURIComponent(email)}`, { method: 'GET' })
    return { verificationSent: true, message: '验证码已发送，请查看邮箱。' }
  } finally {
    await context.dispose()
  }
}

export function originFromEnvironment() {
  const url = new URL(process.env.YISAMA_PORTAL_URL || DEFAULT_ORIGIN)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new UserError('站点地址无效，请联系管理员。')
  }
  return url.origin
}

export function paths() {
  const pluginData = process.env.PLUGIN_DATA || path.join(os.homedir(), '.yisama-infinite-assistant')
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return {
    pluginData,
    state: path.join(pluginData, 'state.json'),
    session: path.join(pluginData, 'session.json'),
    license: path.join(pluginData, 'license.json'),
    codexConfig: path.join(codexHome, 'config.toml'),
    codexAuth: path.join(codexHome, 'auth.json'),
  }
}

async function readJson(file, fallback = null) {
  const text = await readOptional(file)
  return text === null ? fallback : JSON.parse(text)
}

async function writeJson(file, value) {
  await replaceFile(file, JSON.stringify(value, null, 2) + '\n')
}

function assistantLicenseBytes(payload) {
  return JSON.stringify({
    version: payload?.version,
    license_id: payload?.license_id,
    user_id: payload?.user_id,
    installation_id: payload?.installation_id,
    issued_at: payload?.issued_at,
    expires_at: payload?.expires_at,
  })
}

function assistantLicensePublicKey() {
  return createPublicKey({
    key: Buffer.from(ASSISTANT_LICENSE_PUBLIC_KEY, 'base64'),
    format: 'der',
    type: 'spki',
  })
}

function validAssistantLicense(lease, installationId, userId, now = Math.floor(Date.now() / 1000)) {
  const payload = lease?.payload
  if (!payload || payload.version !== 1 || payload.user_id !== userId ||
      payload.installation_id !== installationId || typeof payload.license_id !== 'string' ||
      !Number.isSafeInteger(payload.issued_at) || !Number.isSafeInteger(payload.expires_at) ||
      payload.issued_at > now + 300 || payload.expires_at <= now ||
      typeof lease.signature !== 'string') return false
  let signature
  try { signature = Buffer.from(lease.signature, 'base64') } catch { return false }
  if (signature.length !== 64) return false
  return verifySignature(null, Buffer.from(assistantLicenseBytes(payload)), assistantLicensePublicKey(), signature)
}

function licenseError(code, message) {
  const error = new UserError(message)
  error.publicCode = code
  return error
}

async function ensureAssistantLicense(session) {
  if (!assistantLicenseRequired) return
  const file = paths().license
  const stored = await readJson(file, {})
  const installationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    stored?.installationId || '') ? stored.installationId : randomUUID()
  const now = Math.floor(Date.now() / 1000)
  if (validAssistantLicense(stored?.lease, installationId, session.user?.id, now + ASSISTANT_LICENSE_RENEW_BEFORE)) return

  let response
  try {
    response = await requestApi('/assistant/license/activate', {
      token: session.token, method: 'POST',
      body: { installation_id: installationId, version: ASSISTANT_VERSION, client: 'codex-windows' },
    })
  } catch (error) {
    if (error.status === 403) throw licenseError('LICENSE_REVOKED', '当前安装未获授权，请联系管理员。')
    if (error.status === 404 || error.status === 503) {
      throw licenseError('LICENSE_UNAVAILABLE', '授权服务暂时不可用，请更新后重试。')
    }
    throw licenseError('LICENSE_FAILED', '授权验证失败，请稍后重试。')
  }
  const lease = response.data
  if (!validAssistantLicense(lease, installationId, session.user?.id, now)) {
    throw licenseError('LICENSE_INVALID', '授权响应无效，请联系管理员。')
  }
  await writeJson(file, { installationId, lease, updatedAt: new Date().toISOString() })
}

function apiError(status) {
  let message = '站点操作未成功，请稍后重试或联系管理员。'
  if (status === 401) message = '登录已失效，请重新登录。'
  if (status === 403) message = '当前账号没有这项权限，请联系管理员。'
  if (status === 429) message = '操作过于频繁，请稍后再试。'
  const error = new UserError(message)
  error.status = status
  return error
}

export async function requestApi(pathname, {
  token, method = 'GET', body, origin = originFromEnvironment(),
  fetchImpl = globalThis.fetch, apiPrefix = '/api',
} = {}) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await withRoute(origin, (base, timeout) => fetchImpl(new URL(`${apiPrefix}${pathname}`, base), {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { retry: method === 'GET' || pathname.startsWith('/user/login') })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.success === false) throw apiError(response.status)
  return payload
}

async function promptLine(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await prompt.question(question)).trim()
  } finally {
    prompt.close()
  }
}

// Direct sign-in is for controlled integrations, never for collecting a user's password in chat.
export async function signIn({
  username, password, twoFactorCode, flowToken, turnstile = '',
  origin = originFromEnvironment(), fetchImpl = globalThis.fetch,
} = {}) {
  const payload = flowToken
    ? await requestApi('/user/login/2fa', {
      origin, fetchImpl, method: 'POST', body: { flow_token: flowToken, code: twoFactorCode },
    })
    : await requestApi(`/user/login?turnstile=${encodeURIComponent(turnstile)}`, {
      origin, fetchImpl, method: 'POST', body: { username, password },
    })
  if (payload.data?.flow_token && !payload.data?.access_token) {
    if (!twoFactorCode) throw new UserError('请在官方页面完成二次验证。')
    return signIn({ origin, fetchImpl, flowToken: payload.data.flow_token, twoFactorCode })
  }
  accessToken(payload)
  return payload
}

function accessToken(payload) {
  const token = payload?.data?.access_token
  if (typeof token !== 'string' || token.length < 16) {
    throw new UserError('登录未完成，请重新登录。')
  }
  return token
}

export function waitForPortalLogin(context, origin, timeout = 300000) {
  let cancel
  const promise = new Promise((resolve, reject) => {
    const finish = (error, payload) => {
      clearTimeout(timer)
      context.off('response', onResponse)
      context.off('close', onClose)
      if (error) reject(error)
      else resolve(payload)
    }
    const onClose = () => finish(new UserError('登录已取消。'))
    const onResponse = async (response) => {
      const url = new URL(response.url())
      if (url.origin !== origin || !(
        /^\/api\/user\/(login(?:\/2fa)?|passkey\/login\/finish|auth\/refresh)$/.test(url.pathname) ||
        url.pathname.startsWith('/api/oauth/')
      ) || !response.ok()) return
      try {
        const payload = await response.json()
        if (payload.success === true && typeof payload.data?.access_token === 'string' &&
          payload.data.access_token.length >= 16) finish(null, payload)
      } catch {
        // Unsuccessful attempts and verification challenges stay on the official page.
      }
    }
    const timer = setTimeout(() => finish(new UserError('登录等待已超时，请重新登录。')), timeout)
    cancel = () => finish(new UserError('登录已取消。'))
    context.on('response', onResponse)
    context.on('close', onClose)
  })
  promise.catch(() => {})
  return { promise, cancel: () => cancel() }
}

export async function signInWithPortal(origin = originFromEnvironment(), { onPortalOpen } = {}) {
  onPortalOpen?.(`与官方中转站（${origin}）账号互通，请在打开的官方页面登录。`)
  const channels = process.platform === 'win32' ? ['msedge', 'chrome', undefined] : ['chrome', undefined]
  let browser
  for (const channel of channels) {
    try {
      browser = await chromium.launch({ headless: false, channel })
      break
    } catch {
      // Prefer an installed browser; fall back to Playwright Chromium if installed.
    }
  }
  if (!browser) throw new UserError('无法打开登录窗口，请先安装 Edge 或 Chrome 浏览器。')
  const context = await browser.newContext()
  const pending = waitForPortalLogin(context, origin)
  try {
    const page = await context.newPage()
    await page.goto(new URL('/sign-in', origin).href, { waitUntil: 'domcontentloaded' })
    const payload = await pending.promise
    const cookies = (await context.cookies(new URL('/api/user/auth/refresh', origin).href))
      .filter((cookie) => cookie.name === 'new_api_refresh')
    const session = {
      origin, token: accessToken(payload), expiresAt: payload.data.access_expires_at,
      sessionId: payload.data.session?.sid, cookies,
    }
    await writeJson(paths().session, session)
    return session
  } finally {
    pending.cancel()
    await browser.close()
  }
}

export async function authenticatedSession({ interactive = true, onPortalOpen } = {}) {
  const origin = originFromEnvironment()
  let session = await readJson(paths().session)
  if (session?.origin === origin && typeof session.token === 'string') {
    if (!session.expiresAt || session.expiresAt * 1000 > Date.now() + 30000) {
      try {
        const response = await requestApi('/user/self', { token: session.token })
        const current = { ...session, user: response.data }
        await ensureAssistantLicense(current)
        return current
      } catch (error) {
        if (error.status !== 401) throw error
      }
    }
    if (session.cookies?.length) {
      const context = await browserRequest.newContext({
        storageState: { cookies: session.cookies, origins: [] },
        extraHTTPHeaders: { Origin: origin, 'X-Auth-Session': session.sessionId || '' },
        timeout: 30000,
      })
      try {
        const response = await withRoute(origin, async (base, timeout) => {
          await context.addCookies(cookiesForHost((await context.storageState()).cookies, base))
          return context.post(new URL('/api/user/auth/refresh', base).href, { maxRedirects: 0, timeout })
        })
        const payload = await response.json().catch(() => null)
        if (response.ok() && payload?.success && payload.data?.access_token) {
          session = {
            origin, token: accessToken(payload), expiresAt: payload.data.access_expires_at,
            sessionId: payload.data.session?.sid,
            cookies: cookiesForHost((await context.storageState()).cookies
              .filter((cookie) => cookie.name === 'new_api_refresh'), origin),
          }
          await writeJson(paths().session, session)
          const current = { ...session, user: payload.data.user }
          await ensureAssistantLicense(current)
          return current
        }
        if (![401, 403].includes(response.status())) throw apiError(response.status())
      } finally {
        await context.dispose()
      }
    }
  }
  if (!interactive) throw new UserError('请先登录 yisama 无限助手。')
  session = await signInWithPortal(origin, { onPortalOpen })
  const response = await requestApi('/user/self', { token: session.token })
  const current = { ...session, user: response.data }
  await ensureAssistantLicense(current)
  return current
}

export async function fetchGroupInfo(token) {
  const { data } = await requestApi('/user/self/groups', { token })
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UserError('暂时无法读取可用分组。')
  }
  // display_name ("GPT", "Claude", ...) is the name the relay wants users to see for a group;
  // without it the group name is shown. desc stays a description.
  return Object.entries(data).filter(([value]) => value).map(([value, info]) => ({
    value, ratio: Number.isFinite(info?.ratio) ? info.ratio : null,
    label: typeof info?.display_name === 'string' ? info.display_name.trim() : '',
    order: Number.isFinite(info?.display_order) ? info.display_order : null,
  }))
}

export async function fetchGroups(token) {
  return (await fetchGroupInfo(token)).map((group) => group.value)
}

const MEDIA_MODEL = /(?:^|[-_.])(?:image|imagen|audio|tts|video|embedding|rerank)(?:$|[-_.])/i

// Classifies the public pricing list: image/video endpoints and paid per-call models are not LLMs,
// and a group whose models are mostly non-LLM is a media group.
export function classifyPricing(pricing) {
  const nonText = new Set()
  const counts = new Map()
  for (const model of Array.isArray(pricing?.data) ? pricing.data : []) {
    const types = Array.isArray(model?.supported_endpoint_types) ? model.supported_endpoint_types : []
    const text = !types.some((type) => type === 'image-generation' || /video|audio|embedding|rerank/i.test(type)) &&
      !(model.quota_type === 1 && model.model_price > 0)
    if (!text && typeof model.model_name === 'string') nonText.add(model.model_name)
    for (const group of Array.isArray(model?.enable_groups) ? model.enable_groups : []) {
      const count = counts.get(group) || { text: 0, other: 0 }
      count[text ? 'text' : 'other'] += 1
      counts.set(group, count)
    }
  }
  const mediaGroups = new Set([...counts].filter(([, count]) => count.text === 0 || count.other > count.text)
    .map(([group]) => group))
  return { nonText, mediaGroups }
}

export function textModels(models, catalog = classifyPricing(null)) {
  return models.filter((id) => !catalog.nonText.has(id) && !MEDIA_MODEL.test(id))
}

export function chooseGroup(requested, availableGroups) {
  const groups = [...new Set(availableGroups)]
  const value = !requested || /^(all|auto)$/i.test(requested) ? 'auto' : requested
  if (!groups.includes(value)) throw new UserError(`该分组暂不可用：${value === 'auto' ? 'All' : value}`)
  return { value, label: value === 'auto' ? 'All' : value, availableGroups: groups }
}

async function chooseGroupInteractively(groups, requested) {
  if (requested) return chooseGroup(requested, groups)
  const options = groups.map((value) => ({ value, label: value === 'auto' ? 'All' : value }))
  if (!options.length) throw new UserError('此账号没有可用分组，请联系管理员。')
  if (!process.stdin.isTTY) return chooseGroup(groups.includes('auto') ? 'all' : groups[0], groups)
  options.sort((a, b) => Number(b.value === 'auto') - Number(a.value === 'auto'))
  console.log('\n可用分组：')
  options.forEach((item, index) => console.log(`${index + 1}. ${item.label}`))
  const answer = await promptLine('选择分组（默认 1）：')
  const index = answer ? Number(answer) - 1 : 0
  if (!Number.isInteger(index) || !options[index]) throw new UserError('分组选择无效。')
  return chooseGroup(options[index].value, groups)
}

function keyName() {
  return ASSISTANT_KEY_NAME
}

async function findAssistantKey(token, group) {
  const keyword = encodeURIComponent(keyName())
  const response = await requestApi(`/token/search?keyword=${keyword}&p=1&size=100`, { token })
  const items = response.data?.items?.filter((item) => item.name === keyName()) || []
  return items.find((item) => item.group === group) || items[0]
}

export async function ensureAssistantKey(token, group, {
  requireFast = true, fastEnabled = true, keyId = null, existingKey = null,
} = {}) {
  const desiredFast = fastEnabled === true
  let key
  if (Number.isInteger(keyId)) {
    try {
      key = (await requestApi(`/token/${keyId}`, { token })).data
    } catch (error) {
      if (error.status !== 404) throw error
    }
  }
  key ||= await findAssistantKey(token, group)
  if (!key) {
    await requestApi('/token/', {
      token, method: 'POST',
      body: {
        name: keyName(), remain_quota: 0, expired_time: -1,
        unlimited_quota: true, model_limits_enabled: false, model_limits: '',
        allow_ips: '', group, auto_groups: [], cross_group_retry: group === 'auto', fast_mode: desiredFast,
      },
    })
    key = await findAssistantKey(token, group)
  }
  if (!key || !Number.isInteger(key.id)) throw new UserError('账号准备未完成，请重新设置。')
  const id = key.id
  const fastAvailable = key.fast_mode_available === true
  const expectedFast = desiredFast && fastAvailable
  const updateKey = (fastMode) => requestApi('/token/', {
    token, method: 'PUT',
    body: {
      id, name: keyName(), status: 1, expired_time: -1,
      remain_quota: 0, unlimited_quota: true, model_limits_enabled: false, model_limits: '',
      allow_ips: '', group, auto_groups: [], cross_group_retry: group === 'auto', fast_mode: fastMode,
    },
  })
  // Reconcile older owned credentials without rewriting a healthy credential on every selection.
  if (key.name !== keyName() || key.group !== group || key.status !== 1 ||
    key.fast_mode !== expectedFast || key.expired_time !== -1 ||
    key.unlimited_quota !== true || key.model_limits_enabled !== false ||
    (key.model_limits || '') !== '' || (key.allow_ips || '') !== '' ||
    (Array.isArray(key.auto_groups) ? key.auto_groups.length !== 0 : Boolean(key.auto_groups)) ||
    key.cross_group_retry !== (group === 'auto')) {
    await updateKey(expectedFast)
  }
  key = (await requestApi(`/token/${id}`, { token })).data
  let finalFastAvailable = key?.fast_mode_available === true
  let finalFastEnabled = key?.fast_mode === true
  if (key?.status === 1 && key?.group === group &&
    finalFastEnabled !== (desiredFast && finalFastAvailable)) {
    await updateKey(desiredFast && finalFastAvailable)
    key = (await requestApi(`/token/${id}`, { token })).data
    finalFastAvailable = key?.fast_mode_available === true
    finalFastEnabled = key?.fast_mode === true
  }
  if (key?.status !== 1 || key?.group !== group ||
    finalFastEnabled !== (desiredFast && finalFastAvailable) ||
    (requireFast && !finalFastAvailable)) {
    throw new UserError('当前分组暂不能启用 Fast，请选择支持的分组。')
  }
  let rawKey = keyId === id ? existingKey : null
  if (!rawKey) {
    const secret = await requestApi(`/token/${id}/key`, { token, method: 'POST' })
    rawKey = secret.data?.key
  }
  if (typeof rawKey !== 'string' || rawKey.length < 8) throw new UserError('账号准备未完成，请重新设置。')
  return {
    id, group, key: rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`,
    fastAvailable: finalFastAvailable, fastEnabled: finalFastEnabled,
  }
}

async function fetchModelListing(apiKey) {
  const response = await requestApi('/models', { token: apiKey, apiPrefix: '/v1' })
  if (!Array.isArray(response.data)) throw new UserError('暂时无法读取模型列表。')
  const entries = response.data.filter((item) => typeof item?.id === 'string' && item.id)
  const metadata = entries.filter((item) => Object.hasOwn(item, 'input_modalities'))
    .map((item) => ({ slug: item.id, input_modalities: item.input_modalities }))
  return { models: [...new Set(entries.map((item) => item.id))], metadata }
}

export async function fetchModels(apiKey) {
  return (await fetchModelListing(apiKey)).models
}

export function chooseModel(models, preferred) {
  const textModels = models.filter((id) => !/(?:^|[-_.])(?:image|imagen|audio|tts|video|embedding|rerank)(?:$|[-_.])/i.test(id))
  if (preferred && textModels.includes(preferred)) return preferred
  const model = textModels.find((id) => /^gpt-.*codex/i.test(id)) ||
    textModels.find((id) => /^(gpt-(?:[3-9](?:[.\d]|-|$)|4o)|o[134](?:-|$))/i.test(id)) ||
    textModels.find((id) => /^(?:claude|gemini|grok|deepseek|qwen|glm|kimi|minimax|mimo|doubao|hunyuan|hy[34])(?:[.\d-]|$)/i.test(id))
  if (!model) {
    const error = new UserError('该分组没有可自动选择的对话模型，请选择其他分组。')
    error.publicCode = 'GROUP_NO_TEXT_MODEL'
    throw error
  }
  return model
}

function rememberModelByGroup(state, group, model) {
  const saved = state?.modelByGroup
  const remembered = saved && typeof saved === 'object' && !Array.isArray(saved)
    ? Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
      typeof key === 'string' && key && typeof value === 'string' && value))
    : {}
  return group && typeof model === 'string' && model
    ? { ...remembered, [group]: model }
    : remembered
}

function activeConfig(config) {
  return { ...config, ...config.profiles?.[config.profile] }
}

async function supportedReasoning(files, config, model) {
  const catalogPath = activeConfig(config).model_catalog_json
  // An explicit catalog overrides the cache, just as it does in Codex.
  const file = catalogPath
    ? path.resolve(path.dirname(files.codexConfig), catalogPath)
    : path.join(path.dirname(files.codexConfig), 'models_cache.json')
  const catalog = await readJson(file)
  const metadata = catalog?.models?.find((item) => item.slug === model)
  if (!Array.isArray(metadata?.supported_reasoning_levels)) return null
  return [...new Set(metadata.supported_reasoning_levels
    .map((item) => item.effort)
    .filter((effort) => Object.hasOwn(REASONING_LABELS, effort)))]
}

async function desktopCatalog(files, config, state, models, fast = false, relayMetadata = []) {
  const sources = [activeConfig(config).model_catalog_json]
  if (state.backups?.config) {
    const original = parse(await readOptional(state.backups.config) || '')
    sources.push(activeConfig(original).model_catalog_json)
  }
  sources.push('models_cache.json')
  const metadata = []
  for (const file of [...new Set(sources.filter(Boolean))]) {
    const resolved = path.resolve(path.dirname(files.codexConfig), file)
    const catalog = await readJson(resolved)
    const owned = resolved === state.catalogPath || state.catalogFiles?.includes(resolved) ||
      (path.dirname(resolved) === path.resolve(files.pluginData, 'model-catalogs') &&
        /^[a-f0-9]{64}\.json$/.test(path.basename(resolved)))
    if (Array.isArray(catalog?.models)) metadata.unshift(...catalog.models.map((model) => {
      // Generated catalogs contain defaults, not independent capability evidence.
      if (!owned) return model
      const { input_modalities, ...rest } = model
      return rest
    }))
  }
  return makeModelCatalog(models, [...metadata, ...relayMetadata], { fast })
}

export function chooseReasoning(requested, current, supported) {
  if (requested === undefined) return supported?.includes(current) ? current : null
  const level = requested.toLowerCase()
  if (level === 'auto') return null
  if (!Object.hasOwn(REASONING_LABELS, level)) throw new UserError('思考等级无效，请先查看可选等级。')
  if (supported === null) throw new UserError('暂无法确认此模型的思考等级，请选择 Codex 已识别的模型。')
  if (!supported.includes(level)) throw new UserError('此模型未列出该思考等级，请先查看可选等级或更换模型。')
  return level
}

const REASONING_ORDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

export function highestSupportedReasoning(supported) {
  if (!Array.isArray(supported)) return null
  return REASONING_ORDER.find((level) => supported.includes(level)) || null
}

function reasoningLabel(level) {
  return level ? REASONING_LABELS[level] || '未识别' : '自动（模型默认）'
}

function showReasoningChange(level, previous) {
  console.log(`思考等级：${reasoningLabel(level)}`)
  if (previous && !level) console.log('已恢复模型默认思考等级。')
  if (level === 'ultra') console.log('Ultra 可能增加耗时和额度消耗，实际支持取决于站点线路。')
}

export function formatQuota(user, status) {
  if (user?.quota === undefined || user.quota === null || !Number.isFinite(Number(user.quota))) {
    return '暂时无法读取'
  }
  const raw = Number(user.quota)
  const unit = Number(status?.quota_per_unit)
  if (!(unit > 0)) return `${raw.toLocaleString('en-US')} 额度单位`
  const value = raw / unit
  const type = String(status?.quota_display_type || 'USD').toUpperCase()
  if (type === 'TOKENS') return `${Math.round(raw).toLocaleString('en-US')} tokens`
  if (type === 'CNY') return `¥${(value * Number(status.usd_exchange_rate || 1)).toFixed(2)}`
  if (type === 'CUSTOM') return `${status.custom_currency_symbol || ''}${(value * Number(status.custom_currency_exchange_rate || 1)).toFixed(2)}`
  return `$${value.toFixed(2)}`
}

async function setup(requestedGroup, requestedReasoning) {
  const files = paths()
  const previous = await readJson(files.state, {})
  const origin = originFromEnvironment()
  if (previous.configured && previous.origin && previous.origin !== origin) {
    throw new UserError('当前配置属于另一个站点，请先恢复原配置。')
  }
  const session = await authenticatedSession({ onPortalOpen: (message) => console.log(message) })
  const selected = await chooseGroupInteractively(await fetchGroups(session.token), requestedGroup)
  const auth = await readJson(files.codexAuth, {})
  const canReuse = previous.configured && Number.isInteger(previous.keyId) &&
    typeof auth.OPENAI_API_KEY === 'string' && typeof previous.keyFingerprint === 'string' &&
    createHash('sha256').update(auth.OPENAI_API_KEY).digest('hex') === previous.keyFingerprint
  const internalKey = await ensureAssistantKey(session.token, selected.value, {
    keyId: canReuse ? previous.keyId : null,
    existingKey: canReuse ? auth.OPENAI_API_KEY : null,
  })
  const models = await fetchModels(internalKey.key)
  const current = parse(await readOptional(files.codexConfig) || '')
  const active = activeConfig(current)
  const modelByGroup = rememberModelByGroup(previous, previous.group, active.model)
  const preferred = modelByGroup[selected.value] || active.model
  const model = chooseModel(models, preferred)
  const reasoning = chooseReasoning(requestedReasoning, active.model_reasoning_effort,
    await supportedReasoning(files, current, model))
  const status = await requestApi('/status')
  await configureCodex({
    files, state: previous, apiKey: internalKey.key, origin, model, reasoning,
    statePatch: {
      origin, userId: session.user.id, username: session.user.username,
      group: selected.value, groupLabel: selected.label, keyId: internalKey.id,
      keyFingerprint: createHash('sha256').update(internalKey.key).digest('hex'),
      model, modelByGroup: { ...modelByGroup, [selected.value]: model },
      fastAvailable: internalKey.fastAvailable,
      configuredAt: new Date().toISOString(),
    },
  })
  console.log(`登录成功：${session.user.display_name || session.user.username || 'yisama 用户'}`)
  console.log(`当前分组：${selected.label}`)
  console.log(`当前模型：${model}`)
  showReasoningChange(reasoning, active.model_reasoning_effort)
  console.log('Fast：已开启（支持线路按 1.5x 计费）')
  console.log(`剩余额度：${formatQuota(session.user, status.data)}`)
  console.log('自定义充值：可打开官方中转站钱包')
  console.log('配置已就绪，请重启 Codex 或新建会话后使用。')
}

async function showStatus() {
  const files = paths()
  const state = await readJson(files.state)
  if (!state?.configured) {
    console.log('yisama 无限助手尚未配置。')
    return
  }
  if (state.origin !== originFromEnvironment()) throw new UserError('当前站点与已登录站点不一致，请先恢复原配置。')
  console.log(`当前分组：${state.groupLabel}`)
  const session = await authenticatedSession({ interactive: false })
  const [key, status] = await Promise.all([
    requestApi(`/token/${state.keyId}`, { token: session.token }), requestApi('/status'),
  ])
  const config = parse(await readOptional(files.codexConfig) || '')
  const auth = await readJson(files.codexAuth, {})
  const active = config.profiles?.[config.profile] || {}
  const provider = active.model_provider || config.model_provider
  const local = provider === PROVIDER_ID &&
    config.cli_auth_credentials_store === 'file' &&
    config.model_providers?.yisama?.base_url === providerConfig(state.origin).base_url &&
    config.model_providers?.yisama?.requires_openai_auth === true &&
    !config.model_providers?.yisama?.env_key &&
    auth.auth_mode === 'apikey' && typeof auth.OPENAI_API_KEY === 'string' &&
    createHash('sha256').update(auth.OPENAI_API_KEY).digest('hex') === state.keyFingerprint
  console.log(`Codex：${local ? '已配置' : '当前未使用 yisama'}`)
  console.log(`当前模型：${active.model || config.model || '未选择'}`)
  console.log(`思考等级：${reasoningLabel(active.model_reasoning_effort || config.model_reasoning_effort)}`)
  const fast = key.data?.status === 1 && key.data?.fast_mode === true &&
    key.data?.fast_mode_available === true && local &&
    (active.service_tier || config.service_tier) === 'fast'
  console.log(`Fast：${fast ? '已开启（支持线路按 1.5x 计费）' : '未就绪，请重新设置'}`)
  console.log(`剩余额度：${formatQuota(session.user, status.data)}`)
}

function publicGroups(groups) {
  return groups.slice(0, 100).map((group) => {
    const value = String(group?.value ?? group).slice(0, 200)
    const ratio = Number.isFinite(group?.ratio) ? group.ratio : undefined
    const label = typeof group?.label === 'string' && group.label ? group.label.slice(0, 200) : value === 'auto' ? 'All' : value
    return { value, label, ...(ratio === undefined ? {} : { ratio }) }
  })
}

function publicText(value) {
  return typeof value === 'string' ? value.slice(0, 500) : ''
}

function publicState({
  loggedIn = false, configured = false, username = '', quota = '', group = '', groupLabel = '',
  groups = [], model = '', models = [], message = '', restartRequired = false,
} = {}) {
  return {
    loggedIn: Boolean(loggedIn),
    configured: Boolean(configured),
    username: publicText(username),
    quota: publicText(quota),
    group: publicText(group),
    groupLabel: publicText(groupLabel),
    groups: publicGroups(groups),
    model: publicText(model),
    models: models.slice(0, 200).filter((value) => typeof value === 'string').map((value) => value.slice(0, 200)),
    message: publicText(message),
    restartRequired: Boolean(restartRequired),
  }
}

export function desktopRestartRequired(state, codexStartedAt = process.env.YISAMA_CODEX_STARTED_AT) {
  if (state?.restartRequired !== true) return false
  const configuredAt = Date.parse(state.configuredAt)
  const startedAt = Date.parse(codexStartedAt)
  return !Number.isFinite(configuredAt) || !Number.isFinite(startedAt) || configuredAt >= startedAt
}

function desktopOfflineState(state, message, restartRequired) {
  const configured = state?.configured === true
  return publicState({
    configured,
    group: state?.group,
    groupLabel: state?.groupLabel,
    model: state?.model,
    message: message || (configured
      ? '本机配置仍在，但登录已失效，请重新登录。'
      : '尚未登录，请登录 yisama 账号。'),
    restartRequired: restartRequired ?? desktopRestartRequired(state),
  })
}

function configuredModel(files, state, origin) {
  return Promise.all([readOptional(files.codexConfig), readJson(files.codexAuth, {})]).then(([text, auth]) => {
    const config = parse(text || '')
    const active = activeConfig(config)
    const provider = active.model_provider
    const ownedKey = auth.auth_mode === 'apikey' && typeof auth.OPENAI_API_KEY === 'string' &&
      typeof state?.keyFingerprint === 'string' &&
      createHash('sha256').update(auth.OPENAI_API_KEY).digest('hex') === state.keyFingerprint
    const configured = state?.configured === true && state.origin === origin &&
      provider === PROVIDER_ID && config.cli_auth_credentials_store === 'file' &&
      config.model_providers?.yisama?.base_url === providerConfig(state.origin).base_url &&
      config.model_providers?.yisama?.requires_openai_auth === true &&
      !config.model_providers?.yisama?.env_key && ownedKey
    return { model: active.model || '', apiKey: configured ? auth.OPENAI_API_KEY : null, configured,
      fast: ['fast', 'priority'].includes(active.service_tier) }
  })
}

export async function desktopStatus({ message, restartRequired } = {}) {
  const files = paths()
  let state = await readJson(files.state, {})
  let session
  try {
    session = await authenticatedSession({ interactive: false })
  } catch (error) {
    if (error instanceof UserError && (!error.status || error.status === 401)) {
      return desktopOfflineState(state, message, restartRequired)
    }
    throw error
  }
  const origin = originFromEnvironment()
  const current = await configuredModel(files, state, origin)
  const configured = current.configured
  const [groups, status, listing] = await Promise.all([
    desktopGroupInfo(session, configured ? state.group : ''), desktopDisplay(),
    current.apiKey ? desktopModels(current.apiKey, state.group) : { models: [], metadata: [] },
  ])
  const { models, metadata } = listing
  let model = configured ? current.model || publicText(state.model) : ''
  let fastAvailable = state.fastAvailable
  if (configured && models.length) {
    const config = parse(await readOptional(files.codexConfig) || '')
    const active = activeConfig(config)
    const existingCatalog = await readJson(state.catalogPath, {})
    fastAvailable ??= existingCatalog.models?.some((model) =>
      model.service_tiers?.some((tier) => tier.id === 'priority')) ?? current.fast
    let fast = current.fast
    if (Number.isInteger(state.keyId) && state.userId === session.user.id) {
      const key = (await requestApi(`/token/${state.keyId}`, { token: session.token })).data
      if (key?.id !== state.keyId || key.status !== 1 || key.group !== state.group) {
        throw new UserError('当前助手线路已变化，请重新配置。')
      }
      fastAvailable = key.fast_mode_available === true
      fast = fastAvailable && key.fast_mode === true
    }
    const catalog = await desktopCatalog(files, config, state, models, fastAvailable, metadata)
    const hash = createHash('sha256').update(JSON.stringify(catalog) + '\n').digest('hex')
    if (state.catalogHash !== hash || active.model_catalog_json !== state.catalogPath ||
      current.fast !== fast || state.fastAvailable !== fastAvailable) {
      model = chooseModel(models, model)
      state = await configureCodex({
        files, state, apiKey: current.apiKey, origin, model, fast, catalog,
        reasoning: model === active.model ? active.model_reasoning_effort : null,
        statePatch: {
          model, modelByGroup: rememberModelByGroup(state, state.group, model),
          fastAvailable, configuredAt: new Date().toISOString(), restartRequired: true,
        },
      })
    }
  }
  const needsRestart = restartRequired ?? desktopRestartRequired(state)
  return publicState({
    loggedIn: true,
    configured,
    username: session.user?.display_name || session.user?.username,
    quota: formatQuota(session.user, status.data),
    group: configured ? state.group : '',
    groupLabel: configured ? state.groupLabel : '',
    groups,
    model,
    models,
    message: message || (configured
      ? fastAvailable === false ? '当前分组未开放 Fast。' : '配置已保存。'
      : '已登录 yisama 账号，尚未配置 Codex。'),
    restartRequired: needsRestart,
  })
}

export async function desktopNativeConfiguration() {
  const files = paths()
  const state = await readJson(files.state, {})
  if (!state.configured || !state.catalogPath || !state.catalogHash) return null
  const config = activeConfig(parse(await readOptional(files.codexConfig) || ''))
  if (config.model_provider !== PROVIDER_ID || config.model_catalog_json !== state.catalogPath) return null
  const current = await configuredModel(files, state, originFromEnvironment())
  if (!current.configured || !current.apiKey) return null
  const catalog = await readJson(state.catalogPath)
  const catalogVersion = createHash('sha256').update(JSON.stringify([
    'native-model-controls-v5', state.catalogHash, state.group, state.keyFingerprint,
  ])).digest('hex')
  return {
    catalogVersion,
    version: createHash('sha256').update(JSON.stringify([catalogVersion, current.fast])).digest('hex'),
    apiKey: current.apiKey,
    provider: PROVIDER_ID,
    fastAvailable: catalog.models.some((model) => model.service_tiers?.some((tier) => tier.id === 'priority')),
    fastEnabled: current.fast,
    model: config.model,
    models: catalog.models.map((model) => model.slug),
    modelSettings: Object.fromEntries(catalog.models.map((model) => [model.slug, {
      inputModalities: model.input_modalities ?? ['text', 'image'],
      fastAvailable: model.service_tiers?.some((tier) => tier.id === 'priority') === true,
      serviceTier: current.fast ? model.default_service_tier ?? null : null,
      reasoningEfforts: model.supported_reasoning_levels?.map((level) => level.effort) || [],
      reasoningDescriptions: Object.fromEntries((model.supported_reasoning_levels || [])
        .map((level) => [level.effort, level.description]).filter(([, description]) => description)),
      effort: highestSupportedReasoning(model.supported_reasoning_levels?.map((level) => level.effort)) ||
        model.default_reasoning_level || 'none',
    }])),
  }
}

export async function desktopFastMode({ enabled, keyFingerprint } = {}) {
  if (typeof enabled !== 'boolean' || !/^[0-9a-f]{64}$/.test(keyFingerprint)) {
    throw new UserError('Fast 设置无效。')
  }
  const files = paths()
  const state = await readJson(files.state, {})
  const origin = originFromEnvironment()
  const [current, storedSession] = await Promise.all([
    configuredModel(files, state, origin), readJson(files.session, null),
  ])
  let session = storedSession
  const sessionUsable = session?.origin === origin && typeof session.token === 'string' &&
    (!session.expiresAt || session.expiresAt * 1000 > Date.now() + 30000)
  if (!sessionUsable) session = await authenticatedSession({ interactive: false })
  if (!current.configured || state.keyFingerprint !== keyFingerprint || !Number.isInteger(state.keyId)) {
    throw new UserError('当前账号不属于助手，未更改 Fast。')
  }
  const readKey = async () => (await requestApi(`/token/${state.keyId}`, { token: session.token })).data
  let key
  try {
    key = await readKey()
  } catch (error) {
    if (error.status !== 401 || !sessionUsable) throw error
    session = await authenticatedSession({ interactive: false })
    key = await readKey()
  }
  if (key?.id !== state.keyId || key.user_id !== state.userId || key.status !== 1 || key.group !== state.group ||
    (enabled && key.fast_mode_available !== true)) {
    throw new UserError('当前线路无法更改 Fast。')
  }
  if (key.fast_mode === enabled) return { enabled }
  if (key.fast_mode !== enabled) {
    const updated = await requestApi('/token/?fast_mode_only=true', {
      token: session.token, method: 'PUT', body: { id: state.keyId, fast_mode: enabled },
    })
    const saved = updated.data
    if (saved?.fast_mode !== enabled || saved.user_id !== state.userId ||
      saved.group !== state.group || saved.status !== 1) {
      throw new UserError('服务端未确认 Fast 设置。')
    }
  }
  return { enabled }
}

export async function desktopNativeSynced(version) {
  if ((await desktopNativeConfiguration())?.version !== version) return false
  const files = paths()
  const state = await readJson(files.state, {})
  if (state.restartRequired) await writeJson(files.state, { ...state, restartRequired: false })
  return true
}

async function configureDesktop({
  requestedGroup, requestedModel, preserveGroup = false, forceRestart = false,
} = {}) {
  const files = paths()
  const previous = await readJson(files.state, {})
  const origin = originFromEnvironment()
  if (previous.configured && previous.origin && previous.origin !== origin) {
    throw new UserError('当前配置属于另一个站点，请先恢复原配置。')
  }
  const session = await authenticatedSession({ interactive: false })
  const [groupInfo, current, status] = await Promise.all([
    desktopGroupInfo(session, previous.group), configuredModel(files, previous, origin), desktopDisplay(),
  ])
  const availableGroups = groupInfo.map((item) => item.value)
  if (!availableGroups.length) throw new UserError('此账号没有可用分组，请联系管理员。')
  const group = requestedGroup ?? (preserveGroup ? previous.group : undefined) ??
    (availableGroups.includes('auto') ? 'all' : availableGroups[0])
  const selected = chooseGroup(group, availableGroups)
  const canReuse = previous.configured && previous.userId === session.user.id &&
    current.apiKey && Number.isInteger(previous.keyId)
  const groupChanged = previous.configured && previous.group !== selected.value
  try {
    const internalKey = requestedModel && canReuse && previous.group === selected.value
      ? {
        id: previous.keyId, group: selected.value, key: current.apiKey,
        fastAvailable: previous.fastAvailable ?? current.fast, fastEnabled: current.fast,
      }
      : await ensureAssistantKey(session.token, selected.value, {
        requireFast: false, fastEnabled: canReuse ? (groupChanged ? false : current.fast) : true,
        keyId: canReuse ? previous.keyId : null,
        existingKey: canReuse ? current.apiKey : null,
      })
    const { models, metadata } = await desktopModels(internalKey.key, selected.value)
    if (requestedModel && !models.includes(requestedModel)) {
      throw new UserError('该分组暂不支持此模型。')
    }
    const config = parse(await readOptional(files.codexConfig) || '')
    const active = activeConfig(config)
    const modelByGroup = rememberModelByGroup(previous, previous.group, active.model)
    const model = requestedModel || chooseModel(models, modelByGroup[selected.value] || active.model)
    const reasoning = highestSupportedReasoning(await supportedReasoning(files, config, model))
    const catalog = await desktopCatalog(files, config, previous, models, internalKey.fastAvailable, metadata)
    const catalogHash = createHash('sha256').update(JSON.stringify(catalog) + '\n').digest('hex')
    const changed = !current.configured || previous.group !== selected.value || current.apiKey !== internalKey.key ||
      active.model !== model || (active.model_reasoning_effort ?? null) !== reasoning ||
      current.fast !== internalKey.fastEnabled || previous.fastAvailable !== internalKey.fastAvailable ||
      previous.catalogHash !== catalogHash || active.model_catalog_json !== previous.catalogPath
    if (changed || forceRestart) await configureCodex({
      files, state: previous, apiKey: internalKey.key, origin, model, reasoning,
      fast: internalKey.fastEnabled, catalog,
      statePatch: {
        origin, userId: session.user.id, username: session.user.username,
        group: selected.value, groupLabel: selected.label, keyId: internalKey.id,
        keyFingerprint: createHash('sha256').update(internalKey.key).digest('hex'),
        model, modelByGroup: { ...modelByGroup, [selected.value]: model },
        fastAvailable: internalKey.fastAvailable, configuredAt: new Date().toISOString(), restartRequired: true,
      },
    })
    return publicState({
      loggedIn: true, configured: true,
      username: session.user?.display_name || session.user?.username,
      quota: formatQuota(session.user, status.data),
      group: selected.value, groupLabel: selected.label,
      groups: groupInfo, model, models,
      message: internalKey.fastEnabled ? '分组已保存。' : '分组已保存，使用普通模式。',
      restartRequired: forceRestart || changed || desktopRestartRequired(previous),
    })
  } catch (error) {
    if (canReuse && previous.group !== selected.value) {
      try {
        await ensureAssistantKey(session.token, previous.group, {
          requireFast: false, fastEnabled: current.fast,
          keyId: previous.keyId, existingKey: current.apiKey,
        })
      } catch (rollbackError) {
        throw new ConfigRecoveryError('切换分组失败，原分组未能恢复，请重新选择原分组。', {
          cause: new AggregateError([error, rollbackError]),
        })
      }
    }
    throw error
  }
}

export async function desktopLogin({ username, password, loginId, twoFactorCode } = {}) {
  if (username === undefined && loginId === undefined) return configureDesktop()
  const origin = originFromEnvironment()
  const challenge = loginId ? desktopChallenge : null
  if (loginId && (!challenge || challenge.id !== loginId || challenge.origin !== origin ||
    challenge.expiresAt <= Date.now())) {
    desktopChallenge = null
    throw desktopAuthError('AUTH_EXPIRED', '二次验证已过期，请重新输入账号和密码。')
  }
  if (!loginId) desktopChallenge = null
  const context = await desktopAuthContext(challenge?.cookies)
  let user
  try {
    const payload = await assistantAuthRequest(context, loginId ? 'login/2fa' : 'login', {
      body: loginId ? { flow_token: challenge.flowToken, code: twoFactorCode } : { username, password },
    })
    if (payload.data?.require_2fa === true && typeof payload.data.flow_token === 'string') {
      const expiresAt = Math.min(Number(payload.data.expires_at) * 1000 || Infinity, Date.now() + 5 * 60 * 1000)
      desktopChallenge = {
        id: randomUUID(), origin, expiresAt, flowToken: payload.data.flow_token,
        cookies: cookiesForHost((await context.storageState()).cookies, origin),
      }
      return { auth: { step: 'twoFactor', loginId: desktopChallenge.id } }
    }
    const session = {
      origin, token: accessToken(payload), expiresAt: payload.data.access_expires_at,
      sessionId: payload.data.session?.sid,
      cookies: cookiesForHost((await context.storageState()).cookies
        .filter((cookie) => cookie.name === 'new_api_refresh'), origin),
    }
    user = payload.data?.user
    if (!Number.isInteger(user?.id) || typeof user?.username !== 'string') {
      user = (await requestApi('/user/self', { token: session.token })).data
    }
    await writeJson(paths().session, session)
    desktopChallenge = null
    desktopCache.clear()
  } finally {
    await context.dispose()
  }
  return {
    ...publicState({
      loggedIn: true,
      username: user?.display_name || user?.username,
      message: '登录成功，正在准备可用分组和模型。',
    }),
    setupPending: true,
  }
}

export async function desktopSelect({ group, model } = {}) {
  return configureDesktop({ requestedGroup: group, requestedModel: model, preserveGroup: true })
}

export async function desktopReconfigure() {
  const state = await readJson(paths().state, {})
  if (!state?.configured || !state.group) throw new UserError('请先登录并选择分组。')
  const result = await configureDesktop({
    requestedGroup: state.group, preserveGroup: true, forceRestart: true,
  })
  return {
    ...result,
    message: '接管配置已准备，正在自动重启 Codex…',
    restartRequired: true,
  }
}

export async function desktopRestore() {
  desktopChallenge = null
  desktopCache.clear()
  const files = paths()
  const state = await readJson(files.state, {})
  if (!state?.backups) {
    if (state?.configured) throw new UserError('本地备份不完整，未退出账号或改动当前配置。')
    await writeTransaction([[files.state, null], [files.session, null]])
    return publicState({ message: '已退出 yisama 账号，没有需要恢复的配置。' })
  }
  await restoreCodex(files, state)
  return publicState({
    message: '已恢复本机配置。请重启 Codex 或新建会话后使用。',
    restartRequired: true,
  })
}

async function listGroups() {
  const session = await authenticatedSession({ onPortalOpen: (message) => console.log(message) })
  const groups = await fetchGroups(session.token)
  groups.forEach((group) => console.log(group === 'auto' ? 'All' : group))
}

async function modelCommand(requested, requestedReasoning) {
  const files = paths()
  const state = await readJson(files.state)
  if (!state?.configured || state.origin !== originFromEnvironment()) throw new UserError('请先登录并设置分组。')
  const auth = await readJson(files.codexAuth, {})
  if (!auth.OPENAI_API_KEY) throw new UserError('请先登录并设置分组。')
  const models = await fetchModels(auth.OPENAI_API_KEY)
  if (!requested) {
    models.forEach((id) => console.log(id))
    return
  }
  if (!models.includes(requested)) throw new UserError('该分组暂不支持此模型。')
  const config = parse(await readOptional(files.codexConfig) || '')
  const previous = activeConfig(config).model_reasoning_effort
  const reasoning = chooseReasoning(requestedReasoning, previous,
    await supportedReasoning(files, config, requested))
  await configureCodex({
    files, state, apiKey: auth.OPENAI_API_KEY, origin: state.origin, model: requested, reasoning,
    statePatch: { model: requested, modelByGroup: { ...rememberModelByGroup(state), [state.group]: requested } },
  })
  console.log(`当前模型：${requested}`)
  showReasoningChange(reasoning, previous)
  console.log('请新建 Codex 会话后使用；模型是否支持编程工具由站点线路决定。')
}

async function reasoningCommand(requested) {
  const files = paths()
  const state = await readJson(files.state)
  if (!state?.configured || state.origin !== originFromEnvironment()) throw new UserError('请先登录并设置分组。')
  const config = parse(await readOptional(files.codexConfig) || '')
  const active = activeConfig(config)
  if (active.model_provider !== PROVIDER_ID) throw new UserError('当前未使用 yisama，请先重新设置分组。')
  const supported = await supportedReasoning(files, config, active.model)
  if (requested === undefined) {
    console.log(`当前模型：${active.model}`)
    console.log(`思考等级：${reasoningLabel(active.model_reasoning_effort)}`)
    console.log(`可选等级：自动（auto）${supported?.length
      ? '、' + supported.map((level) => `${reasoningLabel(level)}（${level}）`).join('、') : ''}`)
    if (supported === null) console.log('暂无法确认此模型支持的等级，不会自动开启 Ultra。')
    console.log('等级列表来自 Codex，实际支持取决于站点线路。')
    return
  }
  const reasoning = chooseReasoning(requested, active.model_reasoning_effort, supported)
  const auth = await readJson(files.codexAuth, {})
  if (auth.auth_mode !== 'apikey' || typeof auth.OPENAI_API_KEY !== 'string' ||
    createHash('sha256').update(auth.OPENAI_API_KEY).digest('hex') !== state.keyFingerprint) {
    throw new UserError('当前未使用 yisama，请先重新设置分组。')
  }
  await configureCodex({
    files, state, apiKey: auth.OPENAI_API_KEY, origin: state.origin, model: active.model, reasoning,
  })
  showReasoningChange(reasoning, active.model_reasoning_effort)
  console.log('请新建 Codex 会话后使用。')
}

async function restore() {
  const files = paths()
  const state = await readJson(files.state)
  if (!state?.backups) {
    console.log('没有需要恢复的 yisama 配置。')
    return
  }
  await restoreCodex(files, state)
  console.log('已移除助手配置并保留后续个人改动，请重启 Codex。')
}

async function openRecharge() {
  const url = new URL('/wallet', originFromEnvironment()).href
  if (process.platform === 'win32') {
    await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', url])
  } else {
    await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
  }
}

function jsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function paymentUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

export async function submitPaymentForm(url, fields, fetchImpl = globalThis.fetch) {
  const entries = Object.entries(fields && typeof fields === 'object' ? fields : {})
    .filter(([key, value]) => /^[\w.-]{1,100}$/.test(key) &&
      value !== null && value !== undefined && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key, String(value)])
  if (!entries.length) return { paymentUrl: url, fields: {} }
  const response = await fetchImpl(url, {
    method: 'POST',
    body: new URLSearchParams(entries),
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  const location = response.headers?.get?.('location')
  if (response.status >= 300 && response.status < 400 && location) {
    const redirected = paymentUrl(new URL(location, url).href)
    if (redirected) return { paymentUrl: redirected, fields: {} }
  }
  return { paymentUrl: url, fields: Object.fromEntries(entries) }
}

function publicRechargeInfo(data) {
  const source = data && typeof data === 'object' ? data : {}
  const amountOptions = jsonArray(source.amount_options)
    .map(Number)
    .filter((amount) => Number.isFinite(amount) && amount > 0)
  const paymentMethods = jsonArray(source.pay_methods)
    .filter((method) => method && typeof method === 'object' && method.type !== 'waffo')
    .map((method) => ({
      name: typeof method.name === 'string' ? method.name.slice(0, 80) : '',
      type: typeof method.type === 'string' ? method.type.slice(0, 40) : '',
      minTopup: Number.isFinite(Number(method.min_topup)) ? Number(method.min_topup) : 0,
    }))
    .filter((method) => method.name && method.type)
  return {
    amountOptions,
    paymentMethods,
    minTopup: Number.isFinite(Number(source.min_topup)) ? Number(source.min_topup) : 0,
    currency: typeof source.currency === 'string' ? source.currency.slice(0, 12) : 'USD',
  }
}

export async function desktopRechargeInfo() {
  const session = await authenticatedSession({ interactive: false })
  const response = await requestApi('/user/topup/info', { token: session.token })
  return publicRechargeInfo(response.data)
}

export async function desktopRechargeAmount({ amount, paymentMethod } = {}) {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0 || value > 1000000) {
    throw new UserError('请输入有效的充值金额。')
  }
  const method = typeof paymentMethod === 'string' ? paymentMethod.slice(0, 40) : ''
  const session = await authenticatedSession({ interactive: false })
  const pathname = method === 'stripe' ? '/user/stripe/amount' : '/user/amount'
  const response = await requestApi(pathname, {
    token: session.token, method: 'POST', body: { amount: Math.floor(value) },
  })
  const paymentAmount = Number(response.data)
  if (!Number.isFinite(paymentAmount) || paymentAmount < 0) {
    throw new UserError('暂时无法计算支付金额。')
  }
  return { paymentAmount }
}

export async function desktopRechargePay({ amount, paymentMethod } = {}) {
  const value = Number(amount)
  const method = typeof paymentMethod === 'string' ? paymentMethod.slice(0, 40) : ''
  if (!Number.isFinite(value) || value <= 0 || value > 1000000 || !method) {
    throw new UserError('请输入有效的充值金额和支付方式。')
  }
  const session = await authenticatedSession({ interactive: false })
  const pathname = method === 'stripe' ? '/user/stripe/pay' : '/user/pay'
  const response = await requestApi(pathname, {
    token: session.token, method: 'POST',
    body: method === 'stripe'
      ? { amount: Math.floor(value), payment_method: 'stripe' }
      : { amount: Math.floor(value), payment_method: method },
  })
  const data = response.data && typeof response.data === 'object' ? response.data : {}
  const url = paymentUrl(data.pay_link || data.payment_url || data.url || response.url)
  const fields = Object.fromEntries(Object.entries(data)
    .filter(([key, field]) => key !== 'url' && key !== 'pay_link' && key !== 'payment_url' &&
      ['string', 'number', 'boolean'].includes(typeof field)))
  if (!url) throw new UserError('订单已创建，但支付入口无效，请稍后重试。')
  const payment = method === 'stripe' ? { paymentUrl: url, fields } : await submitPaymentForm(url, fields)
  return { ...payment, amount: Math.floor(value), paymentMethod: method }
}

export async function desktopRedeem({ redeemCode } = {}) {
  const key = typeof redeemCode === 'string' ? redeemCode.trim() : ''
  if (!key) throw new UserError('请输入兑换码。')
  const session = await authenticatedSession({ interactive: false })
  await requestApi('/user/topup', { token: session.token, method: 'POST', body: { key } })
  return desktopStatus()
}

export async function desktopRecharge() {
  await openRecharge()
  return desktopStatus({ message: '已在外部浏览器打开官方站点钱包。' })
}

async function recharge() {
  await openRecharge()
  console.log('已打开官方中转站钱包，可选择自定义金额充值。')
}

function flagValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new UserError('请提供有效的选项值。')
  return args[index + 1]
}

export function safeError(error) {
  if (error instanceof UserError || error instanceof ConfigRecoveryError) return error.message
  return '操作未完成，请检查网络或联系管理员；未输出账号敏感信息。'
}

export function publicErrorCode(error) {
  return error instanceof UserError && typeof error.publicCode === 'string' ? error.publicCode : undefined
}

export async function run(argv = process.argv.slice(2)) {
  const [command = 'setup', ...args] = argv
  const group = flagValue(args, '--group')
  if (command === 'setup') return setup(group, flagValue(args, '--reasoning'))
  if (command === 'status') return showStatus()
  if (command === 'groups') return listGroups()
  if (command === 'select') {
    if (!group) throw new UserError('请选择要切换的分组。')
    return setup(group, flagValue(args, '--reasoning'))
  }
  if (command === 'models' || command === 'model') return modelCommand(flagValue(args, '--name'), flagValue(args, '--reasoning'))
  if (command === 'reasoning') return reasoningCommand(flagValue(args, '--level'))
  if (command === 'recharge') return recharge()
  if (command === 'restore') return restore()
  throw new UserError('操作不存在。')
}

const cliEntryEnabled = typeof __YISAMA_CLI_ENTRY__ === 'undefined' ? true : __YISAMA_CLI_ENTRY__

if (cliEntryEnabled &&
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`yisama 无限助手：${safeError(error)}`)
    process.exitCode = 1
  })
}
