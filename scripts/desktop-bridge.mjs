import process from 'node:process'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  desktopLogin,
  desktopAuthOptions,
  desktopRegister,
  desktopSendVerification,
  desktopRecharge,
  desktopRestore,
  desktopSelect,
  desktopStatus,
  safeError,
  publicErrorCode,
} from './yisama.mjs'

const MAX_LINE_LENGTH = 16 * 1024
const ACTIONS = new Set(['status', 'login', 'authOptions', 'register', 'sendVerification', 'select', 'recharge', 'restore'])

function requestId(value) {
  return Number.isFinite(value) ? value : null
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id < 1 ||
    !ACTIONS.has(value.action)) {
    throw new Error('invalid bridge request')
  }
  const limits = { group: 200, model: 200, username: 200, password: 1024, email: 254,
    verificationCode: 100, loginId: 100, twoFactorCode: 100 }
  const allowed = value.action === 'login' ? ['username', 'password', 'loginId', 'twoFactorCode']
    : value.action === 'register' ? ['username', 'password', 'email', 'verificationCode']
      : value.action === 'sendVerification' ? ['email'] : value.action === 'select' ? ['group', 'model'] : []
  const request = { id: value.id, action: value.action }
  for (const field of allowed) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' ||
      !(field === 'password' ? value[field].length : value[field].trim()) ||
      value[field].length > limits[field])) {
      throw new Error('invalid bridge request')
    }
    if (value[field] !== undefined) request[field] = value[field]
  }
  if (value.action === 'login') {
    const credentials = value.username !== undefined || value.password !== undefined
    const challenge = value.loginId !== undefined || value.twoFactorCode !== undefined
    if ((credentials && challenge) || (credentials && (!request.username || !request.password)) ||
      (challenge && (!request.loginId || !request.twoFactorCode))) throw new Error('invalid bridge request')
  }
  if (value.action === 'register' && (!request.username || !request.password ||
    request.username.length > 20 || request.password.length < 8 || request.password.length > 20)) {
    throw new Error('invalid bridge request')
  }
  if (value.action === 'sendVerification' && !request.email) throw new Error('invalid bridge request')
  return request
}

export async function handleRequest(request) {
  const { action, group, model, ...details } = validateRequest(request)
  if (action === 'status') return desktopStatus()
  if (action === 'authOptions') return desktopAuthOptions()
  if (action === 'login') return desktopLogin(details)
  if (action === 'register') return desktopRegister(details)
  if (action === 'sendVerification') return desktopSendVerification(details)
  if (action === 'select') return desktopSelect({ group, model })
  if (action === 'recharge') return desktopRecharge()
  return desktopRestore()
}

function errorResponse(id, error) {
  return { id, ok: false, error: safeError(error), ...(publicErrorCode(error) ? { code: publicErrorCode(error) } : {}) }
}

export async function runDesktopBridge({ input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    let id = null
    let response
    try {
      if (line.length > MAX_LINE_LENGTH) throw new Error('bridge request too long')
      const request = JSON.parse(line)
      id = requestId(request?.id)
      const data = await handleRequest(request)
      response = { id, ok: true, data }
    } catch (error) {
      response = errorResponse(id, error)
    }
    output.write(`${JSON.stringify(response)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopBridge().catch(() => {
    process.exitCode = 1
  })
}
