[CmdletBinding()]
param(
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$appRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $appRoot 'runtime\node.exe'
$assistantScript = Join-Path $PSScriptRoot 'codex-assistant.mjs'
$dataRoot = Join-Path $env:LOCALAPPDATA 'yisama-infinite-assistant'
$endpointFile = Join-Path $dataRoot 'codex-endpoint.json'
$startupTimeoutSeconds = 60
$codexExitTimeoutSeconds = 20

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

# Codex keeps background processes alive for a few seconds after its window closes,
# so an immediate relaunch waits for them instead of failing.
function Wait-CodexDesktopExit {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while (Get-CodexDesktopProcesses) {
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 500
    }
    return $true
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
        return @{ FilePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote-StartArgument $direct)); Port = 9222 }
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
                $port = 9222
                $portMatch = [regex]::Match([string]$shortcut.Arguments, '(?i)(?:-Port|--remote-debugging-port)(?:\s+|=)(?<port>[0-9]{1,5})')
                if ($portMatch.Success) { $port = [int]$portMatch.Groups['port'].Value }
                return @{ FilePath = $shortcut.TargetPath; Arguments = $shortcut.Arguments; Port = $port }
            }
            finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        }
    }
    finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    return $null
}

function Read-RequestedDebugPort {
    param([string]$LogPath)
    if (-not (Test-Path -LiteralPath $LogPath)) { return $null }
    # Codex still holds the redirected log open for writing, so share read/write access.
    # Its output may also contain non-UTF-8 OS messages; decode leniently.
    try {
        $stream = [IO.File]::Open($LogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    }
    catch [IO.IOException] { return $null }
    try {
        $reader = New-Object IO.StreamReader($stream, [Text.UTF8Encoding]::new($false, $false))
        $text = $reader.ReadToEnd()
    }
    finally { $stream.Dispose() }
    $match = [regex]::Match($text, '(?m)^\s*DevTools listening on ws://(?:127\.0\.0\.1|\[::1\]):(?<port>[0-9]{1,5})/devtools/browser/[^\s]+\s*$')
    if ($match.Success) { return [int]$match.Groups['port'].Value }
    return $null
}

function Wait-OwnEndpoint {
    param([Diagnostics.Process]$Process, [string]$LogPath)
    $deadline = [DateTime]::UtcNow.AddSeconds($startupTimeoutSeconds)
    do {
        $port = Read-RequestedDebugPort -LogPath $LogPath
        if ($port) { return @{ port = $port; processId = $Process.Id } }
        if ($Process.HasExited) { throw "Codex exited before its debug endpoint was ready. See $LogPath." }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Codex did not report its loopback debug port. See $LogPath."
}

function Write-EndpointFile {
    param([hashtable]$Endpoint)
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $partial = "$endpointFile.$PID.partial"
    $json = @{ port = $Endpoint.port; processId = $Endpoint.processId } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($partial, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $partial -Destination $endpointFile -Force
}

try {
    if ($ValidateOnly) {
        foreach ($required in @($runtime, $assistantScript)) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaged file is missing: $required" }
        }
        Write-Output "Launcher validation passed. Shortcut target: $PSHOME\powershell.exe -File $PSCommandPath"
        exit 0
    }

    if (-not (Wait-CodexDesktopExit -Seconds $codexExitTimeoutSeconds)) {
        throw 'Codex 正在运行，请先完全关闭，再打开 Codex - yisama。'
    }

    $wallpaper = Get-WallpaperLauncher
    if ($wallpaper) {
        Start-Process -FilePath $wallpaper.FilePath -ArgumentList $wallpaper.Arguments -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        $codexProcess = $null
        do {
            $codexProcess = @(Get-CodexDesktopProcesses | Sort-Object StartTime | Select-Object -First 1)
            if ($codexProcess) { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $codexProcess) { throw 'The existing Codex Wallpaper Skin launcher did not start Codex.' }
        $endpoint = @{ port = [int]$wallpaper.Port; processId = $codexProcess[0].Id }
        $codexProcess[0].Dispose()
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
}
catch {
    if (-not $ValidateOnly) {
        Write-LauncherFailure $_.Exception.Message
        Show-LauncherError '无法启动 yisama。请确认 Codex 已完全关闭，然后打开 Codex - yisama。'
    }
    Write-Error $_.Exception.Message
    exit 1
}
