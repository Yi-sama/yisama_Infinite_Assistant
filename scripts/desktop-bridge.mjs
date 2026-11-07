import process from 'node:process'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { checkForUpdates, prepareUpdate } from './online-update.mjs'
import {
  desktopLogin,
  desktopAuthOptions,
  desktopRegister,
  desktopSendVerification,
  desktopSendPasswordResetVerification,
  desktopResetPassword,
  desktopRechargeInfo,
  desktopRechargeAmount,
  desktopRechargePay,
  desktopRecharge,
  desktopRedeem,
  desktopRestore,
  desktopSelect,
  desktopReconfigure,
  desktopStatus,
  desktopBalance,
  desktopFastMode,
  safeError,
  publicErrorCode,
} from './yisama.mjs'

const MAX_LINE_LENGTH = 16 * 1024
const ACTIONS = new Set(['status', 'balance', 'login', 'authOptions', 'register', 'sendVerification',
  'sendPasswordResetVerification', 'resetPassword',
  'select', 'reconfigure', 'rechargeInfo', 'rechargeAmount', 'rechargePay', 'recharge', 'redeem',
  'restore', 'fast', 'checkUpdate', 'installUpdate'])

function requestId(value) {
  return Number.isFinite(value) ? value : null
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id < 1 ||
    !ACTIONS.has(value.action)) {
    throw new Error('invalid bridge request')
  }
  const limits = { group: 200, model: 200, username: 200, password: 1024, email: 254,
    verificationCode: 100, loginId: 100, twoFactorCode: 100, paymentMethod: 40, redeemCode: 200 }
  const allowed = value.action === 'login' ? ['username', 'password', 'loginId', 'twoFactorCode']
    : value.action === 'register' ? ['username', 'password', 'email', 'verificationCode']
      : ['sendVerification', 'sendPasswordResetVerification'].includes(value.action) ? ['email']
        : value.action === 'resetPassword' ? ['email', 'verificationCode', 'password']
          : value.action === 'select' ? ['group', 'model']
        : value.action === 'redeem' ? ['redeemCode']
        : ['rechargeAmount', 'rechargePay'].includes(value.action) ? ['paymentMethod'] : []
  const request = { id: value.id, action: value.action }
  if (value.allowInterrupt !== undefined) {
    if (!['restore', 'reconfigure', 'installUpdate'].includes(value.action) || typeof value.allowInterrupt !== 'boolean') {
      throw new Error('invalid bridge request')
    }
    request.allowInterrupt = value.allowInterrupt
  }
  if (value.action === 'installUpdate') {
    if (!/^[a-f0-9]{64}$/.test(value.updateId)) throw new Error('invalid bridge request')
    request.updateId = value.updateId
  }
  if (value.action === 'fast') {
    if (typeof value.enabled !== 'boolean' || !/^[0-9a-f]{64}$/.test(value.keyFingerprint)) {
      throw new Error('invalid bridge request')
    }
    request.enabled = value.enabled
    request.keyFingerprint = value.keyFingerprint
  }
  for (const field of allowed) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' ||
      !(field === 'password' ? value[field].length : value[field].trim()) ||
      value[field].length > limits[field])) {
      throw new Error('invalid bridge request')
    }
    if (value[field] !== undefined) request[field] = value[field]
  }
  if (['rechargeAmount', 'rechargePay'].includes(value.action)) {
    if (!Number.isFinite(value.amount) || value.amount <= 0 || value.amount > 1000000) {
      throw new Error('invalid bridge request')
    }
    request.amount = value.amount
  }
  if (value.action === 'rechargePay' && !request.paymentMethod) throw new Error('invalid bridge request')
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
  if (['sendVerification', 'sendPasswordResetVerification'].includes(value.action) && !request.email) {
    throw new Error('invalid bridge request')
  }
  if (value.action === 'resetPassword' &&
    (!request.email || !request.verificationCode || !request.password ||
      !/^[0-9]{6}$/.test(request.verificationCode) || request.password.length < 8 || request.password.length > 20)) {
    throw new Error('invalid bridge request')
  }
  if (value.action === 'redeem' && !request.redeemCode) throw new Error('invalid bridge request')
  return request
}

export async function handleRequest(request) {
  const { action, group, model, ...details } = validateRequest(request)
  if (action === 'checkUpdate') return checkForUpdates()
  if (action === 'installUpdate') return prepareUpdate(details.updateId)
  if (action === 'status') return desktopStatus()
  if (action === 'balance') return desktopBalance()
  if (action === 'authOptions') return desktopAuthOptions()
  if (action === 'login') return desktopLogin(details)
  if (action === 'register') return desktopRegister(details)
  if (action === 'sendVerification') return desktopSendVerification(details)
  if (action === 'sendPasswordResetVerification') return desktopSendPasswordResetVerification(details)
  if (action === 'resetPassword') return desktopResetPassword(details)
  if (action === 'select') return desktopSelect({ group, model })
  if (action === 'reconfigure') return desktopReconfigure()
  if (action === 'rechargeInfo') return desktopRechargeInfo()
  if (action === 'rechargeAmount') return desktopRechargeAmount(details)
  if (action === 'rechargePay') return desktopRechargePay(details)
  if (action === 'fast') return desktopFastMode(details)
  if (action === 'redeem') return desktopRedeem(details)
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

// Bundled into the in-Codex assistant, import.meta.url is the assistant's own file, so the
// release build turns this entry off; otherwise it would hold stdin open and keep the
// assistant alive after Codex exits.
const cliEntryEnabled = typeof __YISAMA_CLI_ENTRY__ === 'undefined' ? true : __YISAMA_CLI_ENTRY__

if (cliEntryEnabled && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopBridge().catch(() => {
    process.exitCode = 1
  })
}
