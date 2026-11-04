import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const script = fileURLToPath(new URL('./install-codex.ps1', import.meta.url))
const exec = promisify(execFile)
const probe = `
param([string]$Source, [string]$Exe, [string]$Scenario)
. $Source
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:reads = 0
$script:checks = 0
$script:adds = 0
$script:flags = @()
$desktop = @{ source = 'msix'; executable = $Exe }
function Read-CodexDesktop {
    param($Bootstrap, $Location)
    $script:reads++
    if ($Scenario -eq 'detect-error') { throw 'detection unavailable' }
    if ($Scenario -eq 'existing' -or ($Scenario -eq 'appeared' -and $script:reads -gt 1) -or
        ($Scenario -in @('new', 'undetected') -and $script:reads -gt 2 -and $Scenario -ne 'undetected')) {
        return $desktop
    }
    if ($Scenario -eq 'needs-admin' -and $script:reads -gt 2 -and $script:installedPortable) {
        return @{ source = 'portable'; executable = $Exe }
    }
    return $null
}
function Assert-CodexPackage {
    param($Bootstrap, $Package)
    $script:checks++
    if ($Scenario -eq 'bad-signature') { throw 'signature rejected' }
}
function Get-AppxPackage {
    [CmdletBinding()] param($Name)
    if ($Scenario -eq 'registered') { return @{ Name = 'OpenAI.Codex' } }
}
function Get-Command {
    [CmdletBinding()] param($Name)
    return @{ Parameters = @{ LiteralPath = $true } }
}
$script:portable = 0
function Install-PortableCodex {
    param($Bootstrap, $Package)
    $script:portable++
    if ($Scenario -eq 'portable-error') { throw 'portable rejected' }
    if ($Scenario -eq 'needs-admin-undetected') { return }
    $script:installedPortable = $true
}
function Add-AppxPackage {
    [CmdletBinding()] param([string]$LiteralPath)
    $script:adds++
    $script:flags = @($PSBoundParameters.Keys | Sort-Object)
    if ($Scenario -eq 'install-error') { throw 'native install rejected' }
    if ($Scenario -in @('needs-admin', 'needs-admin-undetected', 'portable-error')) {
        throw 'Administrator privileges required to install packaged service'
    }
}
$ok = $false
$message = ''
try {
    $result = Install-MissingCodex -Bootstrap 'unused' -Package 'verified.msix' -Location 'selection.json'
    $ok = $null -ne $result
} catch { $message = $_.Exception.Message }
@{ ok = $ok; message = $message; reads = $script:reads; checks = $script:checks;
   adds = $script:adds; flags = $script:flags; portable = $script:portable } | ConvertTo-Json -Compress
`

test('Codex prerequisites preserve existing installs and fail closed without force flags', {
  skip: process.platform !== 'win32' && 'Windows package installer only.',
  timeout: 60000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisama-prerequisite-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const helper = path.join(root, 'probe.ps1')
  const exe = path.join(root, 'Codex.exe')
  await fs.writeFile(helper, probe, 'utf8')
  await fs.writeFile(exe, 'isolated executable marker', 'utf8')
  const run = async (scenario) => {
    const { stdout, stderr } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Source', script, '-Exe', exe, '-Scenario', scenario], { windowsHide: true })
    assert.equal(stderr, '')
    return JSON.parse(stdout)
  }
  const existing = await run('existing')
  assert.equal(existing.ok, true)
  assert.equal(existing.checks, 0)
  assert.equal(existing.adds, 0)
  const appeared = await run('appeared')
  assert.equal(appeared.ok, true)
  assert.equal(appeared.checks, 1)
  assert.equal(appeared.adds, 0)
  const installed = await run('new')
  assert.equal(installed.ok, true)
  assert.equal(installed.adds, 1)
  assert.deepEqual(installed.flags, ['ErrorAction', 'LiteralPath'])
  const unpacked = await run('needs-admin')
  assert.equal(unpacked.ok, true)
  assert.equal(unpacked.adds, 1)
  assert.equal(unpacked.portable, 1)
  const both = await run('portable-error')
  assert.equal(both.ok, false)
  assert.match(both.message, /Administrator privileges required.*portable rejected/)
  assert.equal((await run('needs-admin-undetected')).ok, false)
  assert.equal(installed.portable, 0)
  assert.equal(existing.portable, 0)
  for (const scenario of ['detect-error', 'bad-signature', 'registered', 'install-error', 'undetected']) {
    const result = await run(scenario)
    assert.equal(result.ok, false, scenario)
    assert.ok(result.message, scenario)
    assert.equal(result.adds, ['install-error', 'undetected'].includes(scenario) ? 1 : 0, scenario)
  }
})
