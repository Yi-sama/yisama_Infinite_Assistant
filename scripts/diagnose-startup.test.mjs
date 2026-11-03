import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const script = fileURLToPath(new URL('./diagnose-startup.ps1', import.meta.url))
const run = promisify(execFile)
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows diagnostic only.', timeout: 30000 }

test('startup diagnostic parses on Windows PowerShell and has no mutating commands', windowsOnly, async () => {
  const probe = `
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:YISAMA_PROBE_SCRIPT, [ref]$null, [ref]$errors)
if (@($errors).Count) { throw ($errors | Out-String) }
$commands = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true)
$forbidden = @('Start-Process', 'Stop-Process', 'New-Item', 'Remove-Item', 'Move-Item', 'Copy-Item',
    'Set-Content', 'Add-Content', 'Out-File', 'Set-ExecutionPolicy', 'Invoke-Expression')
foreach ($command in $commands) {
    if ($command.GetCommandName() -in $forbidden) { throw "Mutating command: $($command.GetCommandName())" }
}
'syntax=ok; mutatingCommands=0'
`
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
    windowsHide: true, env: { ...process.env, YISAMA_PROBE_SCRIPT: script },
  })
  assert.match(stdout, /syntax=ok; mutatingCommands=0/)
  const source = await fs.readFile(script, 'utf8')
  assert.equal(/[^\x00-\x7f]/.test(source), false, 'the standalone script must work without a UTF-8 BOM')
  assert.doesNotMatch(source, /\.(?:Save|WriteAllText|AppendAllText|WriteAllBytes)\s*\(/i)
  assert.doesNotMatch(source, /auth\.json|session\.json|config\.toml|state\.json|CommandLine/)
})

test('startup diagnostic reports a missing installation without creating files', windowsOnly, async () => {
  const missing = path.join(path.dirname(script), '__missing_yisama_diagnostic_install__')
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
  const { stdout } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-NoPause', '-InstallRoot', missing,
  ], { windowsHide: true })
  assert.match(stdout, /scripts\\launch-codex\.ps1: MISSING/)
  assert.match(stdout, /scripts\\codex-assistant\.mjs: MISSING/)
  assert.match(stdout, /runtime\\node\.exe: MISSING/)
  assert.match(stdout, /Endpoint file: MISSING/)
  assert.match(stdout, /No application files, settings or processes were changed/)
  assert.doesNotMatch(stdout, /Check could not finish/)
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
})
