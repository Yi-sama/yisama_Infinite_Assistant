import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const output = path.resolve(here, '../output/server-build')
const [action, source, baselineOverlay, baselineBinary, ...baselineGitFiles] = process.argv.slice(2)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function prepare() {
  if (!source || !baselineOverlay || !baselineBinary) throw new Error('Supply source, baseline overlay, and deployed baseline binary.')
  await fs.mkdir(output, { recursive: true })
  const replacements = JSON.parse(await fs.readFile(baselineOverlay, 'utf8')).Replace
  const snapshot = {}
  const walk = async (directory) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.agents', '.cache', 'test-results'].includes(item.name)) continue
      const file = path.join(directory, item.name)
      const relative = path.relative(source, file)
      if (item.isDirectory()) {
        if (relative.startsWith(`web${path.sep}`) && !relative.startsWith(`web${path.sep}dist`)) continue
        await walk(file)
      } else if (/\.(go|mod|sum)$/.test(file) || relative.startsWith(`web${path.sep}dist${path.sep}`)) {
        if (replacements[file] === '') { snapshot[file] = ''; continue }
        const target = path.join(output, 'frozen', relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(replacements[file] || file, target)
        snapshot[file] = target
      }
    }
  }
  await walk(source)
  for (const [file, value] of Object.entries(replacements)) {
    const embedded = path.relative(source, file).startsWith(`web${path.sep}dist${path.sep}`)
    if (file in snapshot || (!/\.(go|mod|sum)$/.test(file) && !embedded)) continue
    if (!value) snapshot[file] = ''
    else {
      const target = path.join(output, 'frozen', path.relative(source, file))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(value, target)
      snapshot[file] = target
    }
  }
  for (const relative of baselineGitFiles) {
    const target = snapshot[path.join(source, relative)]
    if (!target) throw new Error('A baseline Git file must already belong to the frozen source.')
    await fs.writeFile(target, execFileSync('git', ['show', `HEAD:${relative.replaceAll('\\', '/')}`], { cwd: source, windowsHide: true }))
  }
  await fs.writeFile(path.join(output, 'baseline-overlay.json'), JSON.stringify({ Replace: snapshot }, null, 2), 'utf8')
  await fs.writeFile(path.join(output, 'build-inputs.json'), JSON.stringify({
    source: path.resolve(source), baselineBinary: path.resolve(baselineBinary),
    baselineSha256: sha(await fs.readFile(baselineBinary)),
    baselineGitFiles,
  }, null, 2), 'utf8')
  console.log('Frozen existing source and baseline overlay without changing the shared checkout.')
}

async function candidateOverlay(inputs) {
  const { Replace: replacements } = JSON.parse(await fs.readFile(path.join(output, 'baseline-overlay.json'), 'utf8'))
  const routerFile = path.join(inputs.source, 'router/api-router.go')
  const routerText = await fs.readFile(replacements[routerFile], 'utf8')
  const marker = '\tanonymousRequestBodyLimit := middleware.AnonymousRequestBodyLimit()'
  if (routerText.split(marker).length !== 2) throw new Error('Router insertion point changed.')
  const patchedRouter = path.join(output, 'api-router.go')
  await fs.writeFile(patchedRouter, routerText.replace(
    marker, `${marker}\n\tsetAssistantAuthRoutes(apiRouter)\n\tsetAssistantLicenseRoutes(apiRouter)`,
  ), 'utf8')
  replacements[routerFile] = patchedRouter
  const userFile = path.join(inputs.source, 'controller/user.go')
  const userText = await fs.readFile(replacements[userFile], 'utf8')
  const audit = '\tswitch c.FullPath() {'
  if (userText.split(audit).length !== 2) throw new Error('Login audit insertion point changed.')
  const patchedUser = path.join(output, 'user.go')
  await fs.writeFile(patchedUser, userText.replace(audit, `${audit}\n\tcase "/api/assistant/auth/login":\n\t\treturn "assistant-password"\n\tcase "/api/assistant/auth/login/2fa":\n\t\treturn "assistant-2fa"`), 'utf8')
  replacements[userFile] = patchedUser
  replacements[path.join(inputs.source, 'router/assistant-auth.go')] = path.join(here, 'assistant-auth.go')
  replacements[path.join(inputs.source, 'middleware/assistant-auth-rate-limit.go')] = path.join(here, 'assistant-auth-rate-limit.go')
  replacements[path.join(inputs.source, 'router/assistant-auth_test.go')] = path.join(here, 'assistant-auth_test.go')
  replacements[path.join(inputs.source, 'router/assistant-license.go')] = path.join(here, 'assistant-license.go')
  replacements[path.join(inputs.source, 'router/assistant-license_test.go')] = path.join(here, 'assistant-license_test.go')
  const overlay = path.join(output, 'candidate-overlay.json')
  await fs.writeFile(overlay, JSON.stringify({ Replace: replacements }, null, 2), 'utf8')
  return overlay
}

function sections(binary) {
  const offset = Number(binary.readBigUInt64LE(40))
  const size = binary.readUInt16LE(58)
  const count = binary.readUInt16LE(60)
  const namesIndex = binary.readUInt16LE(62)
  const namesHeader = offset + namesIndex * size
  const namesStart = Number(binary.readBigUInt64LE(namesHeader + 24))
  const names = binary.subarray(namesStart, namesStart + Number(binary.readBigUInt64LE(namesHeader + 32)))
  const values = {}
  for (let i = 0; i < count; i++) {
    const header = offset + i * size
    if (binary.readUInt32LE(header + 4) === 8) continue
    const nameStart = binary.readUInt32LE(header)
    const name = names.subarray(nameStart, names.indexOf(0, nameStart)).toString()
    const start = Number(binary.readBigUInt64LE(header + 24))
    values[name] = sha(binary.subarray(start, start + Number(binary.readBigUInt64LE(header + 32))))
  }
  return values
}

if (action === 'prepare') await prepare()
else {
  const inputs = JSON.parse(await fs.readFile(path.join(output, 'build-inputs.json'), 'utf8'))
  const isBaseline = action === 'baseline'
  const isTest = action === 'test'
  if (!['baseline', 'candidate', 'test'].includes(action)) throw new Error('Use prepare, baseline, candidate, or test.')
  const overlay = isBaseline ? path.join(output, 'baseline-overlay.json') : await candidateOverlay(inputs)
  const artifact = path.join(output, isBaseline ? 'new-api.baseline' : 'new-api')
  const args = isTest
    ? ['test', '-p', '1', '-overlay', overlay, '-run', '^TestAssistant', '-count=1', './router']
    : ['build', '-p', '1', '-trimpath', '-buildvcs=false', '-overlay', overlay, '-o', artifact, '.']
  const child = spawn('go', args, {
    cwd: inputs.source, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, GOOS: isTest ? 'windows' : 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOMAXPROCS: '2' },
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error(`Local Go ${action} failed (${code}).`)
  if (!isTest) {
    const binary = await fs.readFile(artifact)
    console.log(JSON.stringify({ action, artifact, sha256: sha(binary) }))
    if (isBaseline) {
      const before = sections(await fs.readFile(inputs.baselineBinary))
      const after = sections(binary)
      const metadata = new Set(['.gopclntab', '.note.gnu.build-id', '.note.go.buildid', '.go.buildinfo', '.symtab', '.strtab', '.shstrtab'])
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name])
      const behavioral = changed.filter((name) => !metadata.has(name) && !name.startsWith('.debug_'))
      if (behavioral.length) throw new Error(`Baseline does not reproduce deployed executable/data sections: ${behavioral.join(', ')}.`)
      await fs.writeFile(path.join(output, 'baseline-verified.json'), JSON.stringify(inputs, null, 2), 'utf8')
      console.log('Deployed baseline executable/data sections reproduced.')
    } else {
      const baseline = JSON.parse(await fs.readFile(path.join(output, 'baseline-verified.json'), 'utf8'))
      if (baseline.baselineSha256 !== inputs.baselineSha256) throw new Error('Baseline changed.')
      await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
        baselineSha256: inputs.baselineSha256, sha256: sha(binary),
        changedSources: [
          'router/api-router.go', 'controller/user.go', 'router/assistant-auth.go',
          'middleware/assistant-auth-rate-limit.go', 'router/assistant-license.go',
        ],
        remoteBuild: false,
      }, null, 2), 'utf8')
    }
  }
}
