[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'yisama-infinite-assistant'),
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
# A caller may pass PowerShell 7 module paths to Windows PowerShell 5.1.
$env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath"

function Write-Check {
    param([string]$Name, [object]$Value)
    Write-Host ('{0}: {1}' -f $Name, $Value)
}

function Get-LocalCodexTargets {
    param([int]$Port)
    foreach ($hostName in @('127.0.0.1', '[::1]')) {
        $response = $null
        $reader = $null
        try {
            $request = [Net.HttpWebRequest]::Create("http://${hostName}:$Port/json")
            $request.Proxy = $null
            $request.AllowAutoRedirect = $false
            $request.Timeout = 3000
            $request.ReadWriteTimeout = 3000
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -ne 200) { throw 'Unexpected HTTP status.' }
            $reader = [IO.StreamReader]::new($response.GetResponseStream())
            return @($reader.ReadToEnd() | ConvertFrom-Json)
        }
        catch { $failure = $_.Exception.GetType().Name }
        finally {
            if ($reader) { $reader.Dispose() }
            if ($response) { $response.Dispose() }
        }
    }
    throw "Local debug endpoint unavailable ($failure)."
}

try {
    Write-Host '=== Yisama startup check (read-only) ==='
    Write-Check 'PowerShell' $PSVersionTable.PSVersion
    Write-Check 'Language mode' $ExecutionContext.SessionState.LanguageMode
    Write-Check 'Execution policies' ((Get-ExecutionPolicy -List | ForEach-Object {
        '{0}={1}' -f $_.Scope, $_.ExecutionPolicy
    }) -join '; ')

    $shell = $null
    $shortcutCount = 0
    $selectedRoot = $false
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($folderName in @('DesktopDirectory', 'Programs', 'CommonDesktopDirectory', 'CommonPrograms')) {
            $folder = [Environment]::GetFolderPath($folderName)
            if (-not $folder) { continue }
            $shortcutPath = Join-Path $folder 'Codex - yisama.lnk'
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { continue }
            $shortcutCount++
            $shortcut = $null
            try {
                # Reading an existing shortcut does not save or change it.
                $shortcut = $shell.CreateShortcut($shortcutPath)
                $match = [regex]::Match([string]$shortcut.Arguments,
                    '(?i)(?:^|\s)-File\s+(?:"(?<path>[^"]+)"|(?<path>\S+))')
                $isLauncher = $match.Success -and
                    [IO.Path]::GetFileName($match.Groups['path'].Value) -eq 'launch-codex.ps1' -and
                    [IO.Path]::GetFileName($shortcut.TargetPath) -in @('powershell.exe', 'pwsh.exe')
                Write-Check "Shortcut ($folderName)" "targetExists=$(Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf); launcher=$isLauncher"
                if ($isLauncher) {
                    $launcherPath = $match.Groups['path'].Value
                    Write-Check 'Shortcut script exists' (Test-Path -LiteralPath $launcherPath -PathType Leaf)
                    if (-not $PSBoundParameters.ContainsKey('InstallRoot') -and -not $selectedRoot) {
                        $InstallRoot = Split-Path -Parent (Split-Path -Parent $launcherPath)
                        $selectedRoot = $true
                    }
                }
            }
            catch { Write-Check "Shortcut ($folderName)" "UNREADABLE ($($_.Exception.GetType().Name))" }
            finally {
                if ($shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
            }
        }
        Write-Check 'Yisama shortcuts found' $shortcutCount
    }
    catch { Write-Check 'Shortcut query' "UNAVAILABLE ($($_.Exception.GetType().Name))" }
    finally {
        if ($shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    }

    Write-Check 'Install folder' $InstallRoot
    foreach ($relativePath in @('scripts\launch-codex.ps1', 'scripts\codex-assistant.mjs', 'runtime\node.exe')) {
        $file = Join-Path $InstallRoot $relativePath
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Write-Check $relativePath 'PRESENT'
        }
        else { Write-Check $relativePath 'MISSING' }
    }

    $launcher = Join-Path $InstallRoot 'scripts\launch-codex.ps1'
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$null, [ref]$parseErrors) | Out-Null
        Write-Check 'Launcher syntax errors' @($parseErrors).Count
    }
    $bundle = Join-Path $InstallRoot 'scripts\codex-assistant.mjs'
    if (Test-Path -LiteralPath $bundle -PathType Leaf) {
        Write-Check 'Assistant SHA256' (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash
    }

    $processes = @(Get-Process)
    $codex = @($processes | Where-Object { $_.ProcessName -in @('Codex', 'ChatGPT') })
    Write-Check 'Codex/ChatGPT process IDs' (($codex | ForEach-Object { $_.Id }) -join ', ')
    $helperCount = 0
    $unknownNodes = 0
    foreach ($node in @($processes | Where-Object { $_.ProcessName -eq 'node' })) {
        try {
            if (-not $node.Path) { $unknownNodes++; continue }
            if ($node.Path -eq (Join-Path $InstallRoot 'runtime\node.exe')) { $helperCount++ }
        }
        catch { $unknownNodes++ }
    }
    Write-Check 'Bundled node processes' "$helperCount (unreadable node paths: $unknownNodes)"

    $endpointPath = Join-Path $InstallRoot 'codex-endpoint.json'
    if (Test-Path -LiteralPath $endpointPath -PathType Leaf) {
        try {
            $endpoint = Get-Content -LiteralPath $endpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $port = 0
            $processId = 0
            if (-not [int]::TryParse([string]$endpoint.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535 -or
                -not [int]::TryParse([string]$endpoint.processId, [ref]$processId) -or $processId -le 0) {
                throw 'Invalid endpoint file.'
            }
            Write-Check 'Endpoint file' "PRESENT (port=$port; PID=$processId)"
            if ($codex.Id -notcontains $processId) {
                Write-Check 'Debug endpoint' 'STALE: recorded Codex process is not running'
            }
            else {
                $targets = @(Get-LocalCodexTargets -Port $port)
                Write-Check 'Debug endpoint' 'REACHABLE'
                $workspaces = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -eq 'app://-/index.html' })
                Write-Check 'Compatible workspace pages' $workspaces.Count
            }
        }
        catch { Write-Check 'Endpoint check' "FAILED ($($_.Exception.Message))" }
    }
    else { Write-Check 'Endpoint file' 'MISSING' }

    if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
        $logs = @(Get-ChildItem -LiteralPath $InstallRoot -File -Filter '*.log' |
            Where-Object { $_.Name -match '^(launcher\.stderr|assistant-\d+\.(stdout|stderr)|codex-launch-[\w-]+\.stderr)\.log$' } |
            Sort-Object LastWriteTime -Descending)
        Write-Check 'Startup logs found' $logs.Count
        foreach ($log in @($logs | Select-Object -First 4)) {
            Write-Check 'Log' ('{0} ({1} bytes)' -f $log.Name, $log.Length)
        }
    }
    else { Write-Check 'Startup logs' 'NO INSTALL FOLDER' }
    Write-Host 'Check complete. No application files, settings or processes were changed.'
}
catch {
    Write-Host ('Check could not finish: {0} ({1})' -f $_.Exception.GetType().Name, $_.FullyQualifiedErrorId)
    Write-Host 'No repair was attempted.'
}
finally {
    if (-not $NoPause) {
        Read-Host 'Send a screenshot of this window. Press Enter to close' | Out-Null
    }
}
