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
