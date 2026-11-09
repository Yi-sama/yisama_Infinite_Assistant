import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { imagegenPaths, installImagegen, readOptional, replaceFile, uninstallImagegen } from './codex-config.mjs'

export class ImagegenError extends Error {}

function fail(message) {
  throw new ImagegenError(message)
}

export async function initializeCodexSkills(files, binary) {
  await fs.mkdir(path.dirname(files.codexConfig), { recursive: true })
  const child = spawn(binary, ['--no-daemon', '--disable', 'plugins',
    '-c', 'chatgpt_base_url="http://127.0.0.1:1"', 'app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: path.dirname(files.codexConfig), PLUGIN_DATA: files.pluginData },
    windowsHide: true,
  })
  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  const lines = createInterface({ input: child.stdout })
  child.stderr.resume()
  let sequence = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const done = (error, result) => {
      clearTimeout(timer)
      lines.off('line', receive)
      child.off('error', failed)
      child.off('exit', failed)
      if (error) reject(error)
      else resolve(result)
    }
    const failed = () => done(new ImagegenError('Codex 系统技能初始化失败，未切换生图服务。'))
    const timer = setTimeout(failed, 15000)
    const receive = (line) => {
      let response
      try { response = JSON.parse(line) } catch { return }
      if (response.id !== id) return
      if (response.error) failed()
      else done(null, response.result)
    }
    lines.on('line', receive)
    child.once('error', failed)
    child.once('exit', failed)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => { if (error) failed() })
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'yisama_imagegen_setup', version: '0.1.0' } })
    child.stdin.write('{"method":"initialized"}\n')
    await rpc('skills/list', { cwds: [path.dirname(files.codexConfig)], forceReload: true })
  } finally {
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2500)
    try { await exited } finally { clearTimeout(timer); lines.close() }
  }
}

async function installForDesktop(files) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const bootstrap = path.join(root, 'runtime', 'codex-bootstrap.exe')
  try { await fs.access(bootstrap) } catch (error) {
    if (error.code === 'ENOENT') return installImagegen(files)
    throw error
  }
  const { stdout } = await promisify(execFile)(bootstrap, [
    'detect', '--location', path.join(root, 'codex-location.json'), '--json',
  ], { windowsHide: true, timeout: 15000 })
  const selected = JSON.parse(stdout)
  if (!selected?.executable) fail('未找到 Codex，无法初始化系统生图技能。')
  const resources = path.join(path.dirname(selected.executable), 'resources')
  for (const binary of [path.join(resources, 'codex.exe'), path.join(resources, 'bin', 'codex.exe')]) {
    try { await fs.access(binary) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    return installImagegen(files, { initialize: () => initializeCodexSkills(files, binary) })
  }
  fail('未找到 Codex 核心，无法初始化系统生图技能。')
}

function parseOptions(args) {
  const values = new Set(['--model', '--name', '--prompt', '--prompt-file', '--out', '--n',
    '--size', '--quality', '--background', '--output-format', '--output-compression',
    '--input-fidelity', '--image', '--mask'])
  const options = { image: [] }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--force' || key === '--dry-run') options[key.slice(2)] = true
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (key === '--image') options.image.push(args[++i])
      else if (Object.hasOwn(options, key.slice(2))) fail('生图选项重复。')
      else options[key.slice(2)] = args[++i]
    } else fail('生图选项无效，请查看 image --help。')
  }
  return options
}

function validModel(model) {
  if (typeof model !== 'string' || !model || /\s/.test(model)) fail('请指定有效的生图模型名称。')
  return model
}

function validatePayload(options, model, editing) {
  validModel(model)
  const n = Number(options.n ?? 1)
  if (!Number.isInteger(n) || n < 1 || n > 10) fail('生图数量必须为 1 到 10。')
  const size = options.size || 'auto'
  if (size !== 'auto' && !/^[1-9]\d*x[1-9]\d*$/.test(size)) fail('图片尺寸应为 auto 或 WIDTHxHEIGHT。')
  const format = options['output-format'] || 'png'
  const quality = options.quality || 'medium'
  if (!['png', 'jpeg', 'webp'].includes(format)) fail('图片格式应为 png、jpeg 或 webp。')
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) fail('图片质量选项无效。')
  if (options.background && !['transparent', 'opaque', 'auto'].includes(options.background)) fail('图片背景选项无效。')
  if (options['input-fidelity'] && (!editing || !['high', 'low'].includes(options['input-fidelity']))) {
    fail('input-fidelity 仅支持编辑模式的 high 或 low。')
  }
  if (model === 'gpt-image-2' && (options.background === 'transparent' || options['input-fidelity'])) {
    fail('gpt-image-2 不支持此透明背景或 input-fidelity 参数，未切换模型。')
  }
  if (options['output-compression'] !== undefined &&
      (format === 'png' || !/^\d+$/.test(options['output-compression']) ||
       Number(options['output-compression']) > 100)) fail('压缩率仅用于 jpeg/webp，应为 0 到 100。')
  const payload = { model, n, size, quality, output_format: format }
  for (const key of ['background', 'input-fidelity', 'output-compression']) {
    if (options[key] !== undefined) payload[key.replaceAll('-', '_')] =
      key === 'output-compression' ? Number(options[key]) : options[key]
  }
  return payload
}

async function configuration(files) {
  const text = await readOptional(imagegenPaths(files).config)
  if (text === null) fail('请先在无限助手侧栏登录，生图配置会自动完成。')
  let config
  try {
    config = JSON.parse(text)
    const url = new URL(config.baseUrl)
    if (config.version !== 2 || config.group !== 'images' || !Number.isInteger(config.userId) ||
        !Number.isInteger(config.keyId) || !config.keyName?.startsWith('yisama:images:') ||
        url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
        typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new Error()
  } catch {
    fail('助手生图配置无效，请在侧栏重新登录；未使用其他服务。')
  }
  return config
}

async function request(config, endpoint, body, fetchImpl) {
  let response
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) fail(`站点生图请求失败（HTTP ${response.status}），未切换服务或模型。`)
    const data = await response.json()
    if (data?.success === false) fail('站点生图请求未成功，未切换服务或模型。')
    return data
  } catch (error) {
    if (error instanceof ImagegenError) throw error
    fail('生图请求连接失败或响应无效，未切换服务或模型；请检查站点状态。')
  }
}

async function imageModels(config, fetchImpl) {
  let listing
  try {
    listing = await request(config, 'models', undefined, fetchImpl)
  } catch {
    fail('暂时查不到你的生图模型，请稍后重试。')
  }
  if (!Array.isArray(listing?.data)) fail('暂时无法读取你的生图模型清单，请稍后重试。')
  let pricing
  try {
    pricing = await request({ baseUrl: new URL('/api', config.baseUrl).href }, 'pricing', undefined, fetchImpl)
  } catch {
    fail('暂时查不到你的生图模型，请稍后重试。')
  }
  const endpoint = pricing?.supported_endpoint?.['image-generation']
  if (endpoint?.path !== '/v1/images/generations' || endpoint?.method !== 'POST' ||
      !Array.isArray(pricing?.data) || !pricing.data.every((item) =>
    typeof item?.model_name === 'string' && Array.isArray(item.supported_endpoint_types) &&
    Array.isArray(item.enable_groups))) {
    fail('暂时无法读取你的生图模型清单，请稍后重试。')
  }
  const supported = new Set(pricing.data.filter((item) =>
    item.supported_endpoint_types.includes('image-generation') &&
    item.enable_groups.includes(config.group)).map((item) => item.model_name))
  return [...new Set(listing.data.map((item) => item?.id)
    .filter((id) => typeof id === 'string' && supported.has(id)))].sort()
}

function imageInfo(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg' }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') return { format: 'webp' }
  fail('站点未返回可识别的 PNG、JPEG 或 WebP 图片。')
}

async function imageBytes(item, fetchImpl) {
  if (typeof item?.b64_json === 'string' && item.b64_json.length) {
    return Buffer.from(item.b64_json, 'base64')
  }
  if (typeof item?.url === 'string') {
    try {
      const url = new URL(item.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      // Signed image downloads never receive the assistant's authorization header.
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error()
      return Buffer.from(await response.arrayBuffer())
    } catch {
      fail('生成结果的图片下载失败；未重复提交生图请求。')
    }
  }
  fail('站点没有返回图片数据。')
}

async function appendImage(form, field, file) {
  let bytes
  try { bytes = await fs.readFile(file) } catch { fail('无法读取输入图片或蒙版，请检查本地文件。') }
  if (bytes.length > 50 * 1024 * 1024) fail('输入图片超过 50 MB。')
  const info = imageInfo(bytes)
  form.append(field, new Blob([bytes], { type: `image/${info.format}` }), path.basename(file))
}

export async function runImagegen(files, args, {
  fetchImpl = globalThis.fetch, log = console.log, prepare,
} = {}) {
  const [command = '--help', ...rest] = args
  if (command === '--help') {
    log('image install | uninstall | models | model [--name ID] | generate | edit\n' +
      'generate/edit: --prompt TEXT | --prompt-file FILE, --model ID, --size auto|WIDTHxHEIGHT, ' +
      '--quality low|medium|high|auto, --out FILE, --n 1..10, --output-format png|jpeg|webp, ' +
      '--background transparent|opaque|auto, --output-compression 0..100, ' +
      '--image FILE (repeatable), --mask FILE, --input-fidelity high|low, --dry-run, --force')
    return
  }
  if (command === 'install' || command === 'uninstall') {
    if (rest.length) fail('安装生图配置不接受额外选项。')
    await (command === 'install' ? installForDesktop(files) : uninstallImagegen(files))
    log(command === 'install' ? '系统 imagegen 已配置为无限助手生图。' : '系统 imagegen 已恢复。')
    return
  }
  if (!['generate', 'edit', 'model', 'models'].includes(command)) fail('生图操作不存在。')
  const options = parseOptions(rest)
  if (command === 'models' && rest.length) fail('查询模型不接受额外选项。')
  if (command === 'model' &&
      (options.image.length || Object.keys(options).some((key) =>
        !['image', 'name'].includes(key)))) fail('保存生图模型仅接受 --name。')
  const dryRun = options['dry-run'] && ['generate', 'edit'].includes(command)
  if (!dryRun) await prepare?.()
  const config = dryRun
    ? JSON.parse(await readOptional(imagegenPaths(files).config) || '{}')
    : await configuration(files)
  if (command === 'model') {
    if (options.name) {
      config.model = validModel(options.name)
      await replaceFile(imagegenPaths(files).config, JSON.stringify(config, null, 2) + '\n')
    }
    log(`生图默认模型：${validModel(config.model || 'gpt-image-2')}`)
    return
  }
  if (command === 'models') {
    const models = await imageModels(config, fetchImpl)
    log(models.length ? '你当前可用的生图模型：' : '你的账号目前没有可用的生图模型。')
    for (const model of models) log(model)
    if (models.length) {
      const saved = validModel(config.model || 'gpt-image-2')
      log(models.includes(saved) ? `默认生图模型：${saved}` :
        `已保存的默认模型 ${saved} 目前不可用，请从以上模型中选择。`)
    }
    return
  }
  if (options.name) fail('本次生图请使用 --model 指定模型。')
  const editing = command === 'edit'
  if ((!editing && (options.image.length || options.mask)) ||
      (editing && !options.image.length)) fail('有输入图片请使用 edit 并指定 --image；generate 不接受图片。')
  const payload = validatePayload(options, options.model || config.model || 'gpt-image-2', editing)
  if (Boolean(options.prompt) === Boolean(options['prompt-file'])) fail('请提供 prompt 或 prompt-file，二选一。')
  try {
    payload.prompt = options['prompt-file'] ? await fs.readFile(options['prompt-file'], 'utf8') : options.prompt
  } catch { fail('无法读取提示词文件。') }
  if (!payload.prompt.trim()) fail('提示词不能为空。')
  const output = path.resolve(options.out || path.join('output', 'imagegen', `image-${Date.now()}.${payload.output_format}`))
  if (path.extname(output).toLowerCase() !== `.${payload.output_format}` &&
      !(payload.output_format === 'jpeg' && path.extname(output).toLowerCase() === '.jpg')) {
    fail('输出扩展名必须与 output-format 相同。')
  }
  const outputs = Array.from({ length: payload.n }, (_, i) => payload.n === 1 ? output :
    path.join(path.dirname(output), `${path.basename(output, path.extname(output))}-${i + 1}${path.extname(output)}`))
  for (const file of outputs) {
    if (!options.force) {
      try {
        await fs.access(file)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      fail('输出文件已存在，请换名称；确认替换后才使用 --force。')
    }
  }
  let body = payload
  if (editing) {
    body = new FormData()
    for (const [key, value] of Object.entries(payload)) body.append(key, String(value))
    for (const file of options.image) await appendImage(body, 'image[]', file)
    if (options.mask) await appendImage(body, 'mask', options.mask)
  }
  if (options['dry-run']) {
    log(JSON.stringify({ dryRun: true, payload, inputs: options.image, mask: options.mask, outputs }))
    return
  }
  const started = Date.now()
  const data = await request(config, `images/${editing ? 'edits' : 'generations'}`, body, fetchImpl)
  if (!Array.isArray(data.data) || data.data.length !== payload.n) fail('站点返回的图片数量与请求不一致，未重复提交。')
  const results = []
  for (const [index, item] of data.data.entries()) {
    const bytes = await imageBytes(item, fetchImpl)
    const info = imageInfo(bytes)
    if (info.format !== payload.output_format) fail('站点返回的图片格式与请求不一致，未伪装扩展名或重复提交。')
    await fs.mkdir(path.dirname(outputs[index]), { recursive: true })
    await fs.writeFile(outputs[index], bytes, { flag: options.force ? 'w' : 'wx' })
    results.push({ path: outputs[index], bytes: bytes.length, ...info })
  }
  log(JSON.stringify({ model: payload.model, requestedSize: payload.size,
    elapsedSeconds: (Date.now() - started) / 1000, images: results }))
}
