[CmdletBinding()]
param(
    [string]$BootstrapPath,
    [string]$PackagePath,
    [string]$LocationFile,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-CodexDesktop {
    param([string]$Bootstrap, [string]$Location)
    $previousEncoding = [Console]::OutputEncoding
    try {
        # The bootstrap emits UTF-8 JSON even on legacy Windows code pages.
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $output = & $Bootstrap detect --location $Location --json
        if ($LASTEXITCODE -ne 0) { throw 'Could not verify the existing Codex installation.' }
    }
    finally { [Console]::OutputEncoding = $previousEncoding }
    return ($output | ConvertFrom-Json)
}

function Assert-CodexPackage {
    param([string]$Bootstrap, [string]$Package)
    & $Bootstrap verify --file $Package
    if ($LASTEXITCODE -ne 0) { throw 'Codex package verification failed. Nothing was installed.' }
}

function Install-MissingCodex {
    param([string]$Bootstrap, [string]$Package, [string]$Location)

    $found = Read-CodexDesktop -Bootstrap $Bootstrap -Location $Location
    if ($found) { return $found }
    Assert-CodexPackage -Bootstrap $Bootstrap -Package $Package

    # Never adopt Manager's force-update / force-shutdown flags or policy recovery.
    # Recheck after the lengthy download/verification, before the native install.
    $found = Read-CodexDesktop -Bootstrap $Bootstrap -Location $Location
    if ($found) { return $found }
    if (Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop) {
        throw 'Codex was registered meanwhile. Refresh detection instead of replacing it.'
    }
    $command = Get-Command Add-AppxPackage -ErrorAction Stop
    $parameters = @{ ErrorAction = 'Stop' }
    if ($command.Parameters.ContainsKey('LiteralPath')) {
        $parameters.LiteralPath = $Package
    } else {
        $parameters.Path = $Package
    }
    Add-AppxPackage @parameters | Out-Null
    $found = Read-CodexDesktop -Bootstrap $Bootstrap -Location $Location
    if (-not $found -or $found.source -ne 'msix' -or
        -not (Test-Path -LiteralPath $found.executable -PathType Leaf)) {
        throw 'Codex installation did not produce a detectable desktop executable.'
    }
    return $found
}

function Write-CodexInstallReport {
    param([string]$Path, [string]$Status, [string]$Message)
    $safeMessage = $Message -replace '[\r\n\0]', ' '
    [IO.File]::WriteAllText($Path, "[codex]`r`nstatus=$Status`r`nmessage=$safeMessage`r`n",
        [Text.Encoding]::Unicode)
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        foreach ($file in @($BootstrapPath, $PackagePath)) {
            if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
                throw 'Required Codex installer file is missing.'
            }
        }
        if (-not $ReportPath -or -not $LocationFile) { throw 'Installer report/location path is missing.' }
        $null = Install-MissingCodex -Bootstrap $BootstrapPath -Package $PackagePath -Location $LocationFile
        Write-CodexInstallReport -Path $ReportPath -Status 'found' -Message ''
    }
    catch {
        if ($ReportPath) { Write-CodexInstallReport -Path $ReportPath -Status 'error' -Message $_.Exception.Message }
        Write-Error $_.Exception.Message
        exit 1
    }
}
