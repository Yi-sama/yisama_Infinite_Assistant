[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    # Sent by the assistant after a takeover: close Codex without asking, then reopen it.
    [switch]$Restart,
    [switch]$Supervise,
    [string]$UpdateInstaller,
    [string]$UpdateSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# A Codex-launched Windows PowerShell can inherit PowerShell 7 module paths.
$env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath"

$appRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $appRoot 'runtime\node.exe'
$assistantScript = Join-Path $PSScriptRoot 'codex-assistant.mjs'
$yisamaScript = Join-Path $PSScriptRoot 'yisama.mjs'
$bootstrap = Join-Path $appRoot 'runtime\codex-bootstrap.exe'
$script:codexDesktop = $null
$dataRoot = Join-Path $env:LOCALAPPDATA 'yisama-infinite-assistant'
$endpointFile = Join-Path $dataRoot 'codex-endpoint.json'
$startupTimeoutSeconds = 60
$codexExitTimeoutSeconds = 20

function Show-LauncherError {
    param([string]$Message)
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($Message, 'Codex - yisama', 'OK', 'Error') | Out-Null
}

function Confirm-LauncherAction {
    param([string]$Message)
    Add-Type -AssemblyName PresentationFramework
    return [System.Windows.MessageBox]::Show($Message, 'Codex - yisama', 'YesNo', 'Question') -eq 'Yes'
}

function Get-LauncherErrorText {
    param([string]$Reason)
    $hint = switch -Wildcard ($Reason) {
        'The installed Codex desktop executable was not found.' { '没有找到已安装的 Codex 桌面版，请先安装 Codex。' }
        'Codex exited before*' { 'Codex 启动后马上退出了。' }
        'Codex did not report*' { 'Codex 启动超时。' }
        default { $Reason }
    }
    return "无法启动 yisama：$hint$([Environment]::NewLine)$([Environment]::NewLine)详细记录：$(Join-Path $dataRoot 'launcher.stderr.log')"
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
    if ($script:codexDesktop -and [string]::Equals($full,
        [IO.Path]::GetFullPath([string]$script:codexDesktop.executable),
        [StringComparison]::OrdinalIgnoreCase)) { return $true }
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
    if ($script:codexDesktop) {
        $selected = [string]$script:codexDesktop.executable
        if (Test-Path -LiteralPath $selected -PathType Leaf) { return $selected }
        throw 'The selected Codex desktop executable was not found. Run the yisama installer to select it again.'
    }
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

function Read-SelectedCodex {
    $previousEncoding = [Console]::OutputEncoding
    try {
        # The bootstrap emits UTF-8 JSON even on legacy Windows code pages.
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $json = & $bootstrap detect --location (Join-Path $appRoot 'codex-location.json') --json
        if ($LASTEXITCODE -ne 0) { throw 'Codex detection failed. Run the yisama installer to select the installation again.' }
    }
    finally { [Console]::OutputEncoding = $previousEncoding }
    $found = $json | ConvertFrom-Json
    if (-not $found) { throw 'The installed Codex desktop executable was not found.' }
    return $found
}

function Start-CodexDesktopExecutable {
    param([string]$Executable, [string]$LogPath)
    $oldCli = $env:CODEX_CLI_PATH
    $oldCore = $env:CODEX_WINDOWS_REGISTERED_CORE
    try {
        if ($script:codexDesktop -and $script:codexDesktop.source -eq 'portable') {
            # Match Manager's portable launch environment without changing the
            # user's environment, payload, aliases, or configuration on disk.
            Remove-Item Env:CODEX_WINDOWS_REGISTERED_CORE -ErrorAction SilentlyContinue
            if ([string]::IsNullOrWhiteSpace($oldCli)) {
                $root = Split-Path -Parent $Executable
                $cli = @((Join-Path $root 'resources\codex.exe'), (Join-Path $root 'resources\bin\codex.exe')) |
                    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
                if ($cli) { $env:CODEX_CLI_PATH = $cli }
            }
        }
        return Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) `
            -ArgumentList @('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0') `
            -RedirectStandardError $LogPath -PassThru
    }
    finally {
        if ($null -eq $oldCli) { Remove-Item Env:CODEX_CLI_PATH -ErrorAction SilentlyContinue }
        else { $env:CODEX_CLI_PATH = $oldCli }
        if ($null -eq $oldCore) { Remove-Item Env:CODEX_WINDOWS_REGISTERED_CORE -ErrorAction SilentlyContinue }
        else { $env:CODEX_WINDOWS_REGISTERED_CORE = $oldCore }
    }
}

function Quote-StartArgument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-IndependentLauncher {
    param([string]$ScriptPath, [switch]$Restart, [string]$UpdateInstaller, [string]$UpdateSha256)
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', (Quote-StartArgument $ScriptPath))
    if ($Restart) { $arguments += '-Restart' }
    if ($UpdateInstaller) {
        $arguments += @('-UpdateInstaller', (Quote-StartArgument $UpdateInstaller), '-UpdateSha256', $UpdateSha256)
    }
    # Native grandchildren leave Node's kill-on-exit job. Do not use Start-Process
    # -Wait, which introduces process-tree job tracking of its own.
    $launcher = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $launcher.WaitForExit()
    return $launcher.ExitCode
}

function Invoke-StartupCommand {
    param([ValidateSet('local', 'update')][string]$Mode)
    if (Get-CodexDesktopProcesses) { throw 'Codex is still running; startup maintenance was not performed.' }
    $output = & $runtime --disable-warning=ExperimentalWarning $yisamaScript startup $Mode
    if ($LASTEXITCODE -ne 0) { throw 'Startup maintenance did not finish.' }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Assert-UpdateInstaller {
    param([string]$Installer, [string]$Sha256)
    if ($Sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid update request.' }
    $cacheRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'yisama-infinite-assistant-cache\updates')) + '\'
    $updatePath = [IO.Path]::GetFullPath($Installer)
    if (-not $updatePath.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($updatePath) -ne '.exe') { throw 'Invalid update installer path.' }
    if ((Get-FileHash -LiteralPath $updatePath -Algorithm SHA256).Hash -ne $Sha256) {
        throw 'Update installer verification failed.'
    }
    return $updatePath
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

function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return $listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}

# A process started from an earlier Codex (for example a tool server it launched) can inherit
# Codex's debug socket and keep the port after Codex exits; a new Codex then cannot listen on it.
function Test-LoopbackPortFree {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start(); return $true }
    catch [Net.Sockets.SocketException] { return $false }
    finally { $listener.Stop() }
}

function Wait-DebugPort {
    param([Diagnostics.Process]$Process, [int]$Port)
    $deadline = [DateTime]::UtcNow.AddSeconds($startupTimeoutSeconds)
    do {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
            return @{ port = $Port; processId = $Process.Id }
        }
        catch { }
        if ($Process.HasExited) { throw 'Codex exited before its debug endpoint was ready.' }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Codex did not report its loopback debug port.'
}

# Some Windows 10 machines deny running a Store app's executable directly, so the
# Store Codex is started through Windows app activation, which still passes arguments.
function Start-CodexStoreApp {
    param([string[]]$Arguments)
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $package) { return $null }
    $appId = @((Get-AppxPackageManifest -Package $package).Package.Applications.Application)[0].Id
    if (-not ('YisamaAppActivator' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager { }
public static class YisamaAppActivator {
    public static uint Activate(string appUserModelId, string arguments) {
        uint processId;
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        Marshal.ThrowExceptionForHR(manager.ActivateApplication(appUserModelId, arguments, 0, out processId));
        return processId;
    }
}
'@
    }
    $processId = [YisamaAppActivator]::Activate("$($package.PackageFamilyName)!$appId", ($Arguments -join ' '))
    return Get-Process -Id $processId
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
    $launchMutex = $null
    $ownsLaunch = $false
    if ($Supervise) {
        exit (Start-IndependentLauncher -ScriptPath $PSCommandPath -Restart:$Restart `
            -UpdateInstaller $UpdateInstaller -UpdateSha256 $UpdateSha256)
    }
    foreach ($required in @($runtime, $assistantScript, $bootstrap, $yisamaScript)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaged file is missing: $required" }
    }
    if ($ValidateOnly) {
        Write-Output "Launcher validation passed. Shortcut target: $PSHOME\powershell.exe -File $PSCommandPath"
        exit 0
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $lockId = [BitConverter]::ToString($hash.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($appRoot).ToUpperInvariant()))).Replace('-', '')
    }
    finally { $hash.Dispose() }
    $launchMutex = [Threading.Mutex]::new($false, "Local\YisamaLauncher-$lockId")
    try { $ownsLaunch = $launchMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsLaunch = $true }
    if (-not $ownsLaunch) { exit 0 }

    $script:codexDesktop = Read-SelectedCodex
    $executable = Find-CodexExecutable
    $startupWarning = $null
    if ($UpdateInstaller) {
        if (-not $Restart) { throw 'Invalid update request.' }
        $updatePath = Assert-UpdateInstaller -Installer $UpdateInstaller -Sha256 $UpdateSha256
    }

    # Finish fallible preparation while the existing Codex is still available.
    # The update installer also prepares imagegen after replacing its files.
    if (-not $UpdateInstaller) {
        & $runtime $yisamaScript image install | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '生图配置未完成，原始 imagegen 备份已保留。' }
    }
    $wallpaper = Get-WallpaperLauncher
    if ($script:codexDesktop.source -eq 'portable' -and -not [string]::Equals(
        [IO.Path]::GetFullPath((Split-Path -Parent $script:codexDesktop.executable)),
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex'), [StringComparison]::OrdinalIgnoreCase)) {
        $wallpaper = $null
    }

    if ($Restart) { Get-CodexDesktopProcesses | Stop-Process -Force -ErrorAction SilentlyContinue }
    if (-not (Wait-CodexDesktopExit -Seconds $codexExitTimeoutSeconds)) {
        # Closing the window can leave Codex running in the system tray.
        if (-not (Confirm-LauncherAction 'Codex 仍在后台运行（可能在右下角托盘里）。要结束它，再用 yisama 重新打开吗？')) { exit 0 }
        Get-CodexDesktopProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        if (-not (Wait-CodexDesktopExit -Seconds $codexExitTimeoutSeconds)) {
            throw 'Codex 仍在运行，无法结束。请在任务管理器里结束 Codex 后再试。'
        }
    }

    # Normal launches update before Codex starts; a repair/account restart does not download again.
    if (-not $UpdateInstaller -and -not $Restart) {
        try {
            $automatic = Invoke-StartupCommand -Mode update
            if ($automatic.status -eq 'prepared') {
                $updatePath = Assert-UpdateInstaller -Installer $automatic.updateInstaller.path -Sha256 $automatic.updateInstaller.sha256
                $UpdateInstaller = $updatePath
            }
            elseif ($automatic.status -eq 'unavailable') {
                Write-LauncherFailure 'Automatic assistant update unavailable; starting the installed version.'
            }
        }
        catch {
            Write-LauncherFailure 'Automatic assistant update did not finish; starting the installed version.'
        }
    }
    if ($UpdateInstaller) {
        # The parent helper uses runtime\node.exe, which the installer must be able to replace.
        try {
            $install = Start-Process -FilePath $updatePath -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES',
                '/NORESTART', '/SP-', '/YISAMAUPDATE=1', ('/DIR="' + $appRoot + '"')) -WindowStyle Hidden -PassThru -Wait
            if ($install.ExitCode -ne 0) { throw "Update installer failed with exit code $($install.ExitCode)." }
        }
        catch {
            Write-LauncherFailure "$($_.Exception.Message) Reopening Codex."
            $startupWarning = '更新安装未完成，已重新打开 Codex。请稍后重试更新。'
        }
    }

    try {
        $local = Invoke-StartupCommand -Mode local
        if ($local.threads.skipped -gt 0) {
            $startupWarning = '部分旧对话的格式尚不支持迁移，原记录已保留，请更新无限助手后重试。'
        }
    }
    catch {
        Write-LauncherFailure 'Local startup check did not finish; provider backups were retained.'
        $startupWarning = '旧对话检查未完成，已有迁移备份已保留。请关闭其他 Codex 进程后重新打开。'
    }

    # Codex's packaged build-flavor policy uses this switch on Windows too.
    # Process-local only; Microsoft Store and other deployment tools are unchanged.
    $env:CODEX_SPARKLE_ENABLED = 'false'
    $env:YISAMA_CODEX_UPDATE_CONTROL = 'launch-disabled'
    if ($wallpaper -and -not (Test-LoopbackPortFree -Port $wallpaper.Port)) {
        Write-LauncherFailure "Port $($wallpaper.Port) is held by another process; starting Codex without Wallpaper Skin."
        $wallpaper = $null
    }
    $endpoint = $null
    if ($wallpaper) {
        try {
            Start-Process -FilePath $wallpaper.FilePath -ArgumentList $wallpaper.Arguments -WindowStyle Hidden | Out-Null
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            $codexProcess = $null
            do {
                $codexProcess = @(Get-CodexDesktopProcesses | Sort-Object StartTime | Select-Object -First 1)
                if ($codexProcess) { break }
                Start-Sleep -Milliseconds 300
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $codexProcess) { throw 'The existing Codex Wallpaper Skin launcher did not start Codex.' }
            $endpoint = Wait-DebugPort -Process $codexProcess[0] -Port ([int]$wallpaper.Port)
        }
        catch {
            # Do not start a second instance if the skin opened Codex without a usable endpoint.
            if (Get-CodexDesktopProcesses) { throw }
            Write-LauncherFailure "Wallpaper Skin launch failed; starting Codex directly: $($_.Exception.Message)"
        }
    }
    if (-not $endpoint) {
        New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
        $debugLog = Join-Path $dataRoot ("codex-launch-$([Guid]::NewGuid().ToString('N')).stderr.log")
        try {
            $codex = Start-CodexDesktopExecutable -Executable $executable -LogPath $debugLog
            $endpoint = Wait-OwnEndpoint -Process $codex -LogPath $debugLog
        }
        catch [InvalidOperationException] {
            if ($script:codexDesktop.source -ne 'msix') { throw }
            Write-LauncherFailure "Direct Codex start failed, using app activation: $($_.Exception.Message)"
            $port = Get-FreeLoopbackPort
            # Windows app activation may not inherit our process environment.
            $env:YISAMA_CODEX_UPDATE_CONTROL = 'activation-unverified'
            $codex = Start-CodexStoreApp -Arguments @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$port")
            if (-not $codex) { throw }
            $endpoint = Wait-DebugPort -Process $codex -Port $port
        }
    }

    Write-EndpointFile -Endpoint $endpoint
    $readyLog = Join-Path $dataRoot ("assistant-$($endpoint.processId).stdout.log")
    $errorLog = Join-Path $dataRoot ("assistant-$($endpoint.processId).stderr.log")
    $assistant = Start-Process -FilePath $runtime -ArgumentList @((Quote-StartArgument $assistantScript), '--endpoint-file', (Quote-StartArgument $endpointFile), '--process-id', $endpoint.processId) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $readyLog -RedirectStandardError $errorLog -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $assistant.Refresh()
        if ($assistant.HasExited) { throw "The yisama assistant exited during startup. See $errorLog." }
        if ((Test-Path -LiteralPath $readyLog) -and
            (Select-String -LiteralPath $readyLog -Pattern '"ready":true' -Quiet)) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw "The yisama assistant did not become ready. See $errorLog." }
        Start-Sleep -Milliseconds 250
    } while ($true)
    if ($startupWarning) { Show-LauncherError $startupWarning }
}
catch {
    if (-not $ValidateOnly) {
        Write-LauncherFailure $_.Exception.Message
        Show-LauncherError (Get-LauncherErrorText $_.Exception.Message)
    }
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if ($launchMutex) {
        if ($ownsLaunch) { $launchMutex.ReleaseMutex() }
        $launchMutex.Dispose()
    }
}
