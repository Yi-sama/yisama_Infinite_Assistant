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

const PORTABLE_PROBE = `
param([string]$Launcher, [string]$Root)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
foreach ($name in 'Test-CodexDesktopPath', 'Find-CodexExecutable', 'Start-CodexDesktopExecutable') {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
}
$exe = Join-Path $Root 'app\\Codex.exe'
$cli = Join-Path $Root 'app\\resources\\codex.exe'
$script:codexDesktop = @{ source = 'portable'; executable = $exe }
$env:CODEX_CLI_PATH = ''
$env:CODEX_WINDOWS_REGISTERED_CORE = 'preserved'
function Start-Process {
    param($FilePath, $WorkingDirectory, $ArgumentList, $RedirectStandardError, [switch]$PassThru)
    if ($env:CODEX_WINDOWS_REGISTERED_CORE) { throw 'registered core leaked into portable launch' }
    if ($env:CODEX_CLI_PATH -ne $cli) { throw 'bundled CLI was not selected' }
    if ($FilePath -ne $exe -or $WorkingDirectory -ne (Split-Path -Parent $exe)) { throw 'wrong executable/directory' }
    if ($ArgumentList -notcontains '--remote-debugging-address=127.0.0.1') { throw 'debug endpoint is not loopback' }
    return 'started'
}
"recognized=$(Test-CodexDesktopPath $exe)"
"unrelated=$(Test-CodexDesktopPath (Join-Path $Root 'other\\Codex.exe'))"
"selected=$((Find-CodexExecutable) -eq $exe)"
Start-CodexDesktopExecutable -Executable $exe -LogPath (Join-Path $Root 'stderr.log')
"restored=$($env:CODEX_WINDOWS_REGISTERED_CORE -eq 'preserved' -and [string]::IsNullOrEmpty($env:CODEX_CLI_PATH))"
`

test('portable Codex uses its selected executable and bundled CLI without changing the environment', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-portable-launch-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  await fs.mkdir(path.join(root, 'app', 'resources'), { recursive: true })
  await fs.writeFile(path.join(root, 'app', 'Codex.exe'), '')
  await fs.writeFile(path.join(root, 'app', 'resources', 'codex.exe'), '')
  const script = path.join(root, 'probe.ps1')
  await fs.writeFile(script, PORTABLE_PROBE, 'utf8')
  const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Launcher', launcher, '-Root', root], { windowsHide: true })
  assert.equal(stderr, '')
  assert.deepEqual(stdout.trim().split(/\r?\n/), [
    'recognized=True', 'unrelated=False', 'selected=True', 'started', 'restored=True',
  ])
})

// Execute the launcher's main block against disposable processes, not the user's Codex.
const RESTART_PROBE = `
param([string]$Launcher, [string]$Root, [string]$Node, [string]$Scenario)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
foreach ($assignment in $ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$env:PSModulePath'
}) { Invoke-Expression $assignment.Extent.Text }
foreach ($definition in $ast.FindAll({ param($n)
    $n -is [Management.Automation.Language.FunctionDefinitionAst]
}, $true)) { Invoke-Expression $definition.Extent.Text }
$appRoot = $Root
$dataRoot = $Root
$endpointFile = Join-Path $Root 'endpoint.json'
$runtime = $Node
$assistantScript = Join-Path $Root 'assistant.mjs'
$yisamaScript = Join-Path $Root 'image.mjs'
$bootstrap = $Node
$ValidateOnly = $false
$Restart = -not $Scenario.StartsWith('startup-')
$Supervise = $false
$UpdateInstaller = ''
$UpdateSha256 = ''
if ($Scenario -like 'update-*-failure') {
    $env:LOCALAPPDATA = $Root
    $UpdateInstaller = Join-Path $Root 'yisama-infinite-assistant-cache\\updates\\test.exe'
    $UpdateSha256 = (Get-FileHash -LiteralPath $UpdateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
}
$startupTimeoutSeconds = 5
$codexExitTimeoutSeconds = 2
$script:codexDesktop = $null
$script:newProcess = $null
$script:helperProcess = $null
$script:warningAfterReopen = $false
$script:automaticInstalled = $false
$script:oldProcess = $null
if ($Restart) {
    $script:oldProcess = Microsoft.PowerShell.Management\\Start-Process -FilePath $Node -ArgumentList @(
        (Quote-StartArgument (Join-Path $Root 'desktop.mjs')), 'old'
    ) -WindowStyle Hidden -PassThru
}
$script:status = 'running'
function Read-SelectedCodex {
    return @{ source = 'portable'; executable = (Join-Path $env:LOCALAPPDATA 'Programs\\Codex\\ChatGPT.exe') }
}
function Get-CodexDesktopProcesses {
    foreach ($process in @($script:oldProcess, $script:newProcess)) {
        if ($process) {
            $process.Refresh()
            if (-not $process.HasExited) { $process }
        }
    }
}
function Find-CodexExecutable {
    if ($Scenario -eq 'missing-executable') { throw 'Selected executable missing (isolated test).' }
    return $script:codexDesktop.executable
}
function Get-WallpaperLauncher {
    if ($Scenario -eq 'wallpaper-failure') { return @{ FilePath = 'isolated-wallpaper'; Arguments = @(); Port = 9222 } }
    return $null
}
function Test-LoopbackPortFree { return $true }
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, $WorkingDirectory, $RedirectStandardOutput,
        $RedirectStandardError, [switch]$PassThru, [switch]$Wait)
    if ($FilePath -eq 'isolated-wallpaper') { throw 'Wallpaper launcher failed (isolated test).' }
    if ($FilePath -eq $UpdateInstaller) {
        if ($ArgumentList -notcontains '/YISAMAUPDATE=1') { throw 'Missing assistant-only update flag.' }
        if ($ArgumentList -contains '/INSTALLCODEX=1') { throw 'Assistant updates must not install Codex.' }
        if ($Scenario -eq 'startup-update') {
            $script:automaticInstalled = $true
            if (Get-CodexDesktopProcesses) { throw 'Automatic update ran while Codex was open.' }
            return @{ ExitCode = 0 }
        }
        if ($Scenario -eq 'update-launch-failure') { throw 'Installer could not start (isolated test).' }
        return @{ ExitCode = 8 }
    }
    $parameters = @{ FilePath = $FilePath; ArgumentList = $ArgumentList; WindowStyle = 'Hidden'; PassThru = $true }
    if ($WorkingDirectory) { $parameters.WorkingDirectory = $WorkingDirectory }
    if ($RedirectStandardOutput) { $parameters.RedirectStandardOutput = $RedirectStandardOutput }
    if ($RedirectStandardError) { $parameters.RedirectStandardError = $RedirectStandardError }
    if ($Wait) { $parameters.Wait = $true }
    $process = Microsoft.PowerShell.Management\\Start-Process @parameters
    if ($RedirectStandardOutput) { $script:helperProcess = $process }
    return $process
}
function Start-CodexDesktopExecutable {
    param([string]$Executable, [string]$LogPath)
    $script:newProcess = Microsoft.PowerShell.Management\\Start-Process -FilePath $Node -ArgumentList @(
        (Quote-StartArgument (Join-Path $Root 'desktop.mjs')), 'new'
    ) -RedirectStandardError $LogPath -WindowStyle Hidden -PassThru
    return $script:newProcess
}
function Confirm-LauncherAction { throw 'Unexpected interactive confirmation in isolated restart.' }
function Show-LauncherError {
    param([string]$Message)
    $script:warningAfterReopen = $script:newProcess -and -not $script:newProcess.HasExited -and
        (Test-Path -LiteralPath $endpointFile)
}
function Write-Error { param([string]$Message) $script:status = 'failed' }
$main = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] } |
    Select-Object -Last 1
try {
    # A nested script block contains the launcher's exit without ending this probe.
    & ([scriptblock]::Create($main.Extent.Text))
}
finally {
    $oldAlive = $false
    if ($script:oldProcess) { $script:oldProcess.Refresh(); $oldAlive = -not $script:oldProcess.HasExited }
    $newAlive = $false
    if ($script:newProcess) { $script:newProcess.Refresh(); $newAlive = -not $script:newProcess.HasExited }
    $endpoint = if (Test-Path -LiteralPath $endpointFile) { Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json } else { $null }
    @{
        oldAlive = $oldAlive; newAlive = $newAlive
        endpointMatches = ($null -ne $endpoint -and $script:newProcess -and $endpoint.processId -eq $script:newProcess.Id)
        assistantReady = @(Get-ChildItem -LiteralPath $Root -Filter 'assistant-*.stdout.log' |
            Select-String -Pattern '"ready":true').Count -gt 0
        warningAfterReopen = $script:warningAfterReopen
        localChecked = (Test-Path -LiteralPath (Join-Path $Root 'checked-local'))
        automaticChecked = (Test-Path -LiteralPath (Join-Path $Root 'checked-update'))
        automaticInstalled = $script:automaticInstalled
    } | ConvertTo-Json -Compress
    foreach ($process in @($script:oldProcess, $script:newProcess, $script:helperProcess)) {
        if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    }
}
`

for (const scenario of ['normal', 'image-failure', 'missing-executable', 'missing-assistant',
  'wallpaper-failure', 'update-launch-failure', 'update-exit-failure',
  'startup-current', 'startup-update', 'startup-offline', 'startup-invalid-update', 'startup-local-failure']) {
  test(`launcher restart completes or preserves the running desktop: ${scenario}`, {
    skip: process.platform !== 'win32' && 'Windows launcher only.',
    timeout: 30000,
  }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-restart-flow-'))
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
    await fs.writeFile(path.join(root, 'desktop.mjs'), `
import http from 'node:http'
const server = http.createServer((request, response) => response.end('{}'))
server.listen(0, '127.0.0.1', () => {
  console.error('DevTools listening on ws://127.0.0.1:' + server.address().port + '/devtools/browser/isolated')
})
`, 'utf8')
    await fs.writeFile(path.join(root, 'image.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = path.dirname(fileURLToPath(import.meta.url))
if (process.argv[2] === 'startup') {
  const mode = process.argv[3]
  fs.writeFileSync(path.join(root, 'checked-' + mode), '')
  if (mode === 'local') {
    if (${JSON.stringify(scenario)} === 'startup-local-failure') process.exit(6)
    console.log(JSON.stringify({ local: true, paidCalls: 0, threads: { skipped: 0 } }))
  } else if (${JSON.stringify(scenario)} === 'startup-offline') {
    console.log(JSON.stringify({ status: 'unavailable' }))
  } else if (['startup-update', 'startup-invalid-update'].includes(${JSON.stringify(scenario)})) {
    const file = path.join(root, 'yisama-infinite-assistant-cache', 'updates', 'test.exe')
    const sha256 = ${JSON.stringify(scenario)} === 'startup-invalid-update' ? '0'.repeat(64)
      : createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    console.log(JSON.stringify({ status: 'prepared', updateInstaller: { path: file, sha256 } }))
  } else console.log(JSON.stringify({ status: 'current' }))
} else process.exit(${scenario === 'image-failure' ? 7 : 0})
`, 'utf8')
    if (scenario !== 'missing-assistant') {
      await fs.writeFile(path.join(root, 'assistant.mjs'),
        "console.log('{\"ready\":true}'); setInterval(() => {}, 1000)\n", 'utf8')
    }
    if (scenario.startsWith('update-') || scenario.startsWith('startup-')) {
      const cache = path.join(root, 'yisama-infinite-assistant-cache', 'updates')
      await fs.mkdir(cache, { recursive: true })
      await fs.writeFile(path.join(cache, 'test.exe'), 'isolated installer fixture\n', 'utf8')
    }
    const probe = path.join(root, 'probe.ps1')
    await fs.writeFile(probe, RESTART_PROBE, 'utf8')
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', probe, '-Launcher', launcher, '-Root', root, '-Node', process.execPath, '-Scenario', scenario],
    { windowsHide: true, timeout: 25000, env: { ...process.env, LOCALAPPDATA: root } }).catch((error) => {
      // The probe prints its observable process state even when the launcher exits 1.
      if (!error.stdout) throw error
      return error
    })
    const result = JSON.parse(stdout.trim())
    if (['image-failure', 'missing-executable', 'missing-assistant'].includes(scenario)) {
      assert.equal(result.oldAlive, true, 'preflight failure must not close the existing Codex')
      assert.equal(result.newAlive, false)
    } else {
      assert.deepEqual(result, { oldAlive: false, newAlive: true, endpointMatches: true, assistantReady: true,
        warningAfterReopen: scenario.startsWith('update-') || scenario === 'startup-local-failure',
        localChecked: true, automaticChecked: scenario.startsWith('startup-'),
        automaticInstalled: scenario === 'startup-update' })
    }
  })
}

test('Codex updater opt-out is inherited only by launcher children and app activation remains unverified', {
  skip: process.platform !== 'win32' && 'Windows launcher only.',
  timeout: 30000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-updater-launch-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const probe = path.join(root, 'probe.ps1')
  await fs.writeFile(probe, `
param([string]$Launcher, [string]$Node)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$null, [ref]$null)
foreach ($name in 'CODEX_SPARKLE_ENABLED', 'YISAMA_CODEX_UPDATE_CONTROL') {
  $assignments = $ast.FindAll({ param($n)
    $n -is [Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -eq ('$env:' + $name)
  }, $true)
  Invoke-Expression $assignments[0].Extent.Text
}
& $Node -e 'console.log(JSON.stringify({updater:process.env.CODEX_SPARKLE_ENABLED,control:process.env.YISAMA_CODEX_UPDATE_CONTROL}))'
`, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Launcher', launcher, '-Node', process.execPath], { windowsHide: true })
  assert.deepEqual(JSON.parse(stdout), { updater: 'false', control: 'launch-disabled' })
  const source = await fs.readFile(launcher, 'utf8')
  assert.match(source, /YISAMA_CODEX_UPDATE_CONTROL = 'activation-unverified'[\s\S]*Start-CodexStoreApp -Arguments/)
  assert.doesNotMatch(source, /SetEnvironmentVariable|Set-ItemProperty.*Appx|WindowsStore\\AutoDownload/)
})

test('inspected packaged Codex applies its updater opt-out on Windows', {
  skip: !process.env.YISAMA_CODEX_BOOTSTRAP && 'Set YISAMA_CODEX_BOOTSTRAP to an inspected official bootstrap asset.',
}, async () => {
  const source = await fs.readFile(process.env.YISAMA_CODEX_BOOTSTRAP, 'utf8')
  const gate = /\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)=>"false"!==\4\.CODEX_SPARKLE_ENABLED&&([\w$]+)\.includes\(\1\)&&\2===\3/.exec(source)
  assert.ok(gate, 'the inspected distribution must actually read the launch opt-out')
  const enabled = new Function(gate[5], `return (${gate[0]})`)(['prod'])
  assert.equal(enabled('prod', 'win32', 'win32', {}), true)
  assert.equal(enabled('prod', 'win32', 'win32', { CODEX_SPARKLE_ENABLED: 'false' }), false)
})
