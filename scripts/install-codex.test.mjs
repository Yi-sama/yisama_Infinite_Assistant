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
function Add-AppxPackage {
    [CmdletBinding()] param([string]$LiteralPath)
    $script:adds++
    $script:flags = @($PSBoundParameters.Keys | Sort-Object)
    if ($Scenario -eq 'install-error') { throw 'native install rejected' }
}
$ok = $false
$message = ''
try {
    $result = Install-MissingCodex -Bootstrap 'unused' -Package 'verified.msix' -Location 'selection.json'
    $ok = $null -ne $result
} catch { $message = $_.Exception.Message }
@{ ok = $ok; message = $message; reads = $script:reads; checks = $script:checks;
   adds = $script:adds; flags = $script:flags } | ConvertTo-Json -Compress
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
  for (const scenario of ['detect-error', 'bad-signature', 'registered', 'install-error', 'undetected']) {
    const result = await run(scenario)
    assert.equal(result.ok, false, scenario)
    assert.ok(result.message, scenario)
    assert.equal(result.adds, ['install-error', 'undetected'].includes(scenario) ? 1 : 0, scenario)
  }
})
