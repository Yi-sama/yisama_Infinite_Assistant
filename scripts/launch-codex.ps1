[CmdletBinding()]
param(
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http

$appRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $appRoot 'runtime\node.exe'
$assistantScript = Join-Path $PSScriptRoot 'codex-assistant.mjs'
$dataRoot = Join-Path $env:LOCALAPPDATA 'yisama-infinite-assistant'
$endpointFile = Join-Path $dataRoot 'codex-endpoint.json'

function Show-LauncherError {
    param([string]$Message)
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($Message, 'Codex - yisama', 'OK', 'Error') | Out-Null
}

function Write-LauncherFailure {
    param([string]$Message)
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    [IO.File]::AppendAllText((Join-Path $dataRoot 'launcher.stderr.log'), "$(Get-Date -Format o) $Message$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
}

function Test-CodexDesktopPath {
    param([string]$Path)
    if (-not $Path) { return $false }
    $full = [IO.Path]::GetFullPath($Path)
    $name = [IO.Path]::GetFileName($full)
    if ($name -notin @('ChatGPT.exe', 'Codex.exe')) { return $false }
    if ([string]::Equals((Split-Path -Parent $full), (Join-Path $env:LOCALAPPDATA 'Programs\Codex'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $app = Split-Path -Parent $full
    $package = Split-Path -Parent $app
    return [IO.Path]::GetFileName($app) -eq 'app' -and [IO.Path]::GetFileName($package) -like 'OpenAI.Codex_*' -and
        [IO.Path]::GetFileName((Split-Path -Parent $package)) -eq 'WindowsApps'
}

function Get-CodexDesktopProcesses {
    @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Where-Object {
        try { Test-CodexDesktopPath $_.Path } catch { $false }
    })
}

function Find-CodexExecutable {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex\ChatGPT.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex\Codex.exe')
    )
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
    if ($package) {
        $candidates += Join-Path $package.InstallLocation 'app\ChatGPT.exe'
        $candidates += Join-Path $package.InstallLocation 'app\Codex.exe'
    }
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-CodexDesktopPath $candidate)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'The installed Codex desktop executable was not found.'
}

function Quote-StartArgument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-WallpaperLauncher {
    $direct = Join-Path $env:LOCALAPPDATA 'CodexWallpaperEngineSkin\launch-codex-with-skin.ps1'
    if (Test-Path -LiteralPath $direct -PathType Leaf) {
        return @{ FilePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote-StartArgument $direct)) }
    }

    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
            $shortcutPath = Join-Path $folder 'Codex Wallpaper Skin.lnk'
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { continue }
            $shortcut = $shell.CreateShortcut($shortcutPath)
            try {
                if ([IO.Path]::GetFileName($shortcut.TargetPath) -notin @('powershell.exe', 'pwsh.exe')) { continue }
                $match = [regex]::Match([string]$shortcut.Arguments, '(?i)(?:^|\s)-File\s+(?:"(?<path>[^"]+)"|(?<path>\S+))')
                if (-not $match.Success -or -not (Test-Path -LiteralPath $match.Groups['path'].Value -PathType Leaf)) { continue }
                $scriptPath = [IO.Path]::GetFullPath($match.Groups['path'].Value)
                if ([IO.Path]::GetFileName($scriptPath) -ne 'launch-codex-with-skin.ps1' -or
                    [IO.Path]::GetFileName((Split-Path -Parent $scriptPath)) -ne 'CodexWallpaperEngineSkin') { continue }
                return @{ FilePath = $shortcut.TargetPath; Arguments = $shortcut.Arguments }
            }
            finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        }
    }
    finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    return $null
}

function Get-LoopbackListeningPorts {
    param([int]$ProcessId)
    try {
        return @(Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction Stop |
            Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
            Select-Object -ExpandProperty LocalPort -Unique)
    }
    catch {
        $ports = @()
        foreach ($line in (& (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano -p tcp 2>$null)) {
            $match = [regex]::Match($line, '^\s*TCP\s+(?<address>127\.0\.0\.1|\[::1\]):(?<port>[0-9]+)\s+\S+\s+LISTENING\s+(?<pid>[0-9]+)\s*$')
            if ($match.Success -and [int]$match.Groups['pid'].Value -eq $ProcessId) { $ports += [int]$match.Groups['port'].Value }
        }
        return @($ports | Select-Object -Unique)
    }
}

function Get-VerifiedEndpoint {
    param([int]$ProcessId)
    $ports = @(Get-LoopbackListeningPorts -ProcessId $ProcessId)
    if (-not $ports) { return $null }
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(1)
    try {
        foreach ($port in $ports) {
            foreach ($address in @('127.0.0.1', '[::1]')) {
                try {
                    $targets = $client.GetStringAsync("http://${address}:$port/json").GetAwaiter().GetResult() | ConvertFrom-Json
                    $page = @($targets | Where-Object {
                        $_.type -eq 'page' -and $_.url -ceq 'app://-/index.html' -and
                        $_.webSocketDebuggerUrl -match ('^ws://(?:127\.0\.0\.1|\[::1\]):' + [regex]::Escape([string]$port) + '/devtools/page/[^/]+$')
                    } | Select-Object -First 1)
                    if ($page.Count -eq 1) { return @{ port = [int]$port; processId = $ProcessId } }
                } catch { }
            }
        }
    }
    finally { $client.Dispose(); $handler.Dispose() }
    return $null
}

function Wait-VerifiedEndpoint {
    param([int]$ProcessId, [int]$TimeoutSeconds = 25)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $endpoint = Get-VerifiedEndpoint -ProcessId $ProcessId
        if ($endpoint) { return $endpoint }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Codex did not expose its loopback-only debug page. Close Codex and launch it again with Codex - yisama.'
}

function Read-RequestedDebugPort {
    param([string]$LogPath)
    if (-not (Test-Path -LiteralPath $LogPath)) { return $null }
    $text = [IO.File]::ReadAllText($LogPath, [Text.UTF8Encoding]::new($false, $true))
    $match = [regex]::Match($text, '(?m)^\s*DevTools listening on ws://(?:127\.0\.0\.1|\[::1\]):(?<port>[0-9]{1,5})/devtools/browser/[^\s]+\s*$')
    if ($match.Success) { return [int]$match.Groups['port'].Value }
    return $null
}

function Wait-OwnEndpoint {
    param([Diagnostics.Process]$Process, [string]$LogPath)
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $port = Read-RequestedDebugPort -LogPath $LogPath
        if ($port) {
            $endpoint = Get-VerifiedEndpoint -ProcessId $Process.Id
            if ($endpoint -and $endpoint.port -eq $port) { return $endpoint }
        }
        if ($Process.HasExited) { throw "Codex exited before its debug endpoint was ready. See $LogPath." }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Codex did not report a usable loopback debug endpoint. See $LogPath."
}

function Write-EndpointFile {
    param([hashtable]$Endpoint)
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $partial = "$endpointFile.$PID.partial"
    $json = @{ port = $Endpoint.port; processId = $Endpoint.processId } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($partial, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $partial -Destination $endpointFile -Force
}

function Wait-AssistantReady {
    param([Diagnostics.Process]$Process, [string]$ReadyLog, [string]$ErrorLog, [int]$CodexProcessId)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if (Test-Path -LiteralPath $ReadyLog) {
            foreach ($line in Get-Content -LiteralPath $ReadyLog -Encoding UTF8) {
                try {
                    $value = $line | ConvertFrom-Json
                    if ($value.ready -eq $true -and $value.processId -eq $CodexProcessId) { return }
                } catch { }
            }
        }
        if ($Process.HasExited) { throw "The yisama bridge exited before it was ready. See $ErrorLog." }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The yisama bridge did not become ready. See $ErrorLog."
}

try {
    if ($ValidateOnly) {
        foreach ($required in @($runtime, $assistantScript)) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaged file is missing: $required" }
        }
        Write-Output "Launcher validation passed. Shortcut target: $PSHOME\powershell.exe -File $PSCommandPath"
        exit 0
    }

    if (Get-CodexDesktopProcesses) {
        throw 'Codex 正在运行，请先完全关闭，再打开 Codex - yisama。'
    }

    $wallpaper = Get-WallpaperLauncher
    if ($wallpaper) {
        Start-Process -FilePath $wallpaper.FilePath -ArgumentList $wallpaper.Arguments -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        $endpoint = $null
        do {
            foreach ($process in Get-CodexDesktopProcesses) {
                try { $endpoint = Get-VerifiedEndpoint -ProcessId $process.Id } finally { $process.Dispose() }
                if ($endpoint) { break }
            }
            if ($endpoint) { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $endpoint) { throw 'The existing Codex Wallpaper Skin launcher did not start a verified Codex workspace.' }
    }
    else {
        $executable = Find-CodexExecutable
        New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
        $debugLog = Join-Path $dataRoot ("codex-launch-$([Guid]::NewGuid().ToString('N')).stderr.log")
        $codex = Start-Process -FilePath $executable -ArgumentList @('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0') -RedirectStandardError $debugLog -PassThru
        $endpoint = Wait-OwnEndpoint -Process $codex -LogPath $debugLog
    }

    Write-EndpointFile -Endpoint $endpoint
    $readyLog = Join-Path $dataRoot ("assistant-$($endpoint.processId).stdout.log")
    $errorLog = Join-Path $dataRoot ("assistant-$($endpoint.processId).stderr.log")
    $assistant = Start-Process -FilePath $runtime -ArgumentList @((Quote-StartArgument $assistantScript), '--endpoint-file', (Quote-StartArgument $endpointFile), '--process-id', $endpoint.processId) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $readyLog -RedirectStandardError $errorLog -PassThru
    Wait-AssistantReady -Process $assistant -ReadyLog $readyLog -ErrorLog $errorLog -CodexProcessId $endpoint.processId
}
catch {
    if (-not $ValidateOnly) {
        Write-LauncherFailure $_.Exception.Message
        Show-LauncherError '无法启动 yisama。请确认 Codex 已完全关闭，然后打开 Codex - yisama。'
    }
    Write-Error $_.Exception.Message
    exit 1
}
