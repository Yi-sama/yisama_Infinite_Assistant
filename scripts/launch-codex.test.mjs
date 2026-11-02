import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const launcher = fileURLToPath(new URL('./launch-codex.ps1', import.meta.url))

// Loads only Read-RequestedDebugPort from the launcher, then reads a log that a
// still-running process (like Codex) holds open through Start-Process redirection.
const PROBE = `
param([string]$Launcher, [string]$LogPath)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Read-RequestedDebugPort' }, $true)
Invoke-Expression $function.Extent.Text
$command = 'echo DevTools listening on ws://127.0.0.1:43123/devtools/browser/abc 1>&2 & ping -n 6 127.0.0.1 >nul'
$writer = Start-Process -FilePath cmd.exe -ArgumentList '/c', $command -RedirectStandardError $LogPath -WindowStyle Hidden -PassThru
try {
    $port = $null
    for ($i = 0; $i -lt 30 -and -not $port; $i++) {
        Start-Sleep -Milliseconds 100
        $port = Read-RequestedDebugPort -LogPath $LogPath
    }
    "running=$(-not $writer.HasExited) port=$port"
}
finally { $writer.WaitForExit() }
`

test('launcher reads the debug port while Codex still holds its log open', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-launcher-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const probe = path.join(root, 'probe.ps1')
  await fs.writeFile(probe, PROBE, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher, '-LogPath', path.join(root, 'codex.stderr.log')], { windowsHide: true })
  assert.equal(stdout.trim(), 'running=True port=43123')
})

// Loads only Wait-CodexDesktopExit with a stubbed process list: Codex lingers for
// about one second after its window closes, then a second stub never exits.
const WAIT_PROBE = `
param([string]$Launcher)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Wait-CodexDesktopExit' }, $true)
Invoke-Expression $function.Extent.Text
$script:exitAt = [DateTime]::UtcNow.AddSeconds(1)
function Get-CodexDesktopProcesses { if ([DateTime]::UtcNow -lt $script:exitAt) { @('codex') } }
"lingering=$(Wait-CodexDesktopExit -Seconds 10)"
$script:exitAt = [DateTime]::MaxValue
"stuck=$(Wait-CodexDesktopExit -Seconds 1)"
`

test('launcher waits for a just-closed Codex to finish exiting', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-launcher-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const probe = path.join(root, 'wait.ps1')
  await fs.writeFile(probe, WAIT_PROBE, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher], { windowsHide: true })
  assert.deepEqual(stdout.trim().split(/\r?\n/), ['lingering=True', 'stuck=False'])
})

// Loads only Get-LauncherErrorText: the dialog must name the real reason, not a generic hint.
const ERROR_PROBE = `
param([string]$Launcher)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-LauncherErrorText' }, $true)
Invoke-Expression $function.Extent.Text
$dataRoot = 'TESTROOT'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Get-LauncherErrorText 'The installed Codex desktop executable was not found.'
Get-LauncherErrorText 'something unexpected'
`

test('launcher error dialog names the real failure reason', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-launcher-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const probe = path.join(root, 'error.ps1')
  await fs.writeFile(probe, ERROR_PROBE, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher], { windowsHide: true })
  assert.match(stdout, /没有找到已安装的 Codex 桌面版/)
  assert.match(stdout, /无法启动 yisama：something unexpected/)
  assert.match(stdout, /详细记录：TESTROOT.launcher\.stderr\.log/)
})

// Loads only Get-FreeLoopbackPort and Wait-DebugPort: Store Codex started through app
// activation has no redirected log, so the launcher polls the port it chose.
const POLL_PROBE = `
param([string]$Launcher, [int]$Port)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
foreach ($name in 'Get-FreeLoopbackPort', 'Wait-DebugPort') {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
}
$startupTimeoutSeconds = 30
"free=$((Get-FreeLoopbackPort) -gt 0)"
$endpoint = Wait-DebugPort -Process (Get-Process -Id $PID) -Port $Port
"port=$($endpoint.port) self=$($endpoint.processId -eq $PID)"
`

test('launcher polls the chosen debug port when Codex has no redirected log', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-launcher-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const http = await import('node:http')
  const server = http.createServer((request, response) => response.end('{}'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const probe = path.join(root, 'poll.ps1')
  await fs.writeFile(probe, POLL_PROBE, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher, '-Port', String(server.address().port)], { windowsHide: true })
  assert.deepEqual(stdout.trim().split(/\r?\n/), ['free=True', `port=${server.address().port} self=True`])
})

// Loads only Test-LoopbackPortFree: a port still held after Codex exits must be detected.
const FREE_PROBE = `
param([string]$Launcher, [int]$Busy)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
foreach ($name in 'Get-FreeLoopbackPort', 'Test-LoopbackPortFree') {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
}
"busy=$(Test-LoopbackPortFree -Port $Busy) free=$(Test-LoopbackPortFree -Port (Get-FreeLoopbackPort))"
`

test('launcher detects a debug port that another process still holds', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-launcher-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const probe = path.join(root, 'free.ps1')
  await fs.writeFile(probe, FREE_PROBE, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher, '-Busy', String(server.address().port)], { windowsHide: true })
  assert.equal(stdout.trim(), 'busy=False free=True')
})
