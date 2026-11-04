[CmdletBinding()]
param(
    [string]$NodePath = 'D:\Node.js\node.exe',
    [string]$NodeLicensePath,
    [string]$OutputPath,
    [string]$IsccPath = $env:YISAMA_ISCC,
    [string]$SignToolPath = $env:YISAMA_SIGNTOOL,
    [string]$CertificatePath = $env:YISAMA_SIGN_CERT,
    [string]$CertificatePassword = $env:YISAMA_SIGN_CERT_PASSWORD,
    [string]$TimestampUrl = $env:YISAMA_SIGN_TIMESTAMP_URL,
    [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$windowsRoot = Join-Path $repoRoot 'windows'
$distRoot = Join-Path $repoRoot 'dist'
$installerScript = Join-Path $repoRoot 'installer\yisama.iss'
$iconFile = Join-Path $windowsRoot 'assets\yisama.ico'
$releaseBuilder = Join-Path $repoRoot 'scripts\build-release.mjs'
$launcherSource = Join-Path $repoRoot 'scripts\launch-codex.ps1'
$codexInstallSource = Join-Path $repoRoot 'scripts\install-codex.ps1'
$bootstrapRoot = Join-Path $windowsRoot 'bootstrap'
$bootstrapManifest = Join-Path $bootstrapRoot 'Cargo.toml'
$licenseSource = Join-Path $repoRoot 'LICENSE.txt'
$nodeModules = Join-Path $repoRoot 'node_modules'
$esbuildModule = Join-Path $nodeModules 'esbuild'

if ($env:YISAMA_REQUIRE_SIGNATURE -eq '1') { $RequireSignature = $true }

if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $IsccPath = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw 'Inno Setup compiler (ISCC.exe) was not found. Install it with "winget install JRSoftware.InnoSetup" or set YISAMA_ISCC.'
}
foreach ($source in @($installerScript, $iconFile, $releaseBuilder, $launcherSource, $licenseSource,
    $codexInstallSource, $bootstrapManifest)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required Windows payload source was not found: $source" }
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node runtime was not found: $NodePath" }
if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) { throw "Production dependencies were not found: $nodeModules" }
if (-not (Test-Path -LiteralPath $esbuildModule -PathType Container)) { throw "Release builder dependency was not found: $esbuildModule" }

if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $distRoot 'Yisama-Setup.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$signingConfigured = -not [string]::IsNullOrWhiteSpace($SignToolPath) -or
    -not [string]::IsNullOrWhiteSpace($CertificatePath)
if ($signingConfigured -and ([string]::IsNullOrWhiteSpace($SignToolPath) -or [string]::IsNullOrWhiteSpace($CertificatePath))) {
    throw 'Both YISAMA_SIGNTOOL and YISAMA_SIGN_CERT are required for signing.'
}
if (-not $signingConfigured) {
    if ($RequireSignature) { throw 'Signature is required. Set YISAMA_SIGNTOOL and YISAMA_SIGN_CERT.' }
    Write-Warning 'Windows artifacts will be built unsigned. Configure YISAMA_SIGNTOOL and YISAMA_SIGN_CERT for release signing.'
}

function Build-CodexBootstrap {
    param([string]$Destination)

    $cargo = Get-Command cargo.exe -ErrorAction Stop
    $targetDirectory = Join-Path $bootstrapRoot 'target'
    & $cargo.Source build --release --locked --manifest-path $bootstrapManifest --target-dir $targetDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Codex bootstrap build failed.' }
    $binary = Join-Path $targetDirectory 'release\codex-bootstrap.exe'
    Copy-Item -LiteralPath $binary -Destination (Join-Path $Destination 'codex-bootstrap.exe')
    Copy-Item -LiteralPath (Join-Path $bootstrapRoot 'Codex-App-Manager-LICENSE.txt') -Destination $Destination

    $metadataText = & $cargo.Source metadata --locked --format-version 1 `
        --filter-platform x86_64-pc-windows-msvc --manifest-path $bootstrapManifest
    if ($LASTEXITCODE -ne 0) { throw 'Could not collect bootstrap dependency licenses.' }
    $metadata = $metadataText | ConvertFrom-Json
    $notices = [Collections.Generic.List[string]]::new()
    foreach ($package in ($metadata.packages | Sort-Object name,version)) {
        if ($package.name -eq 'yisama-codex-bootstrap') { continue }
        $directory = Split-Path -Parent $package.manifest_path
        $licenses = @()
        # Git workspace members inherit the license from their workspace root.
        for ($level = 0; ($level -lt 3) -and ($licenses.Count -eq 0); $level++) {
            $licenses = @(Get-ChildItem -LiteralPath $directory -File |
                Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|COPYRIGHT)([-._]|$)' })
            $directory = Split-Path -Parent $directory
        }
        if ($licenses.Count -eq 0) { throw "Distribution license is missing for $($package.name)." }
        $notices.Add("$($package.name) $($package.version) ($($package.license))")
        foreach ($file in $licenses) {
            $notices.Add($file.Name)
            $notices.Add([IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8))
        }
    }
    [IO.File]::WriteAllText((Join-Path $Destination 'Bootstrap-THIRD-PARTY-NOTICES.txt'),
        ($notices -join "`r`n`r`n"), [Text.UTF8Encoding]::new($false))
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('yisama-windows-build-' + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $temporaryRoot 'payload'
$releaseRoot = Join-Path $temporaryRoot 'release'

function Remove-BuildTemporaryRoot {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $tempPath = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $prefix = $tempPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $leaf = Split-Path -Leaf $fullPath
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^yisama-windows-build-[0-9a-f]{32}$') {
        throw "Refusing to remove an unexpected build temporary directory."
    }
    Remove-Item -LiteralPath $fullPath -Recurse -Force
}

function Invoke-SignArtifact {
    param([string]$Artifact)

    if (-not $signingConfigured) {
        return
    }
    if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool was not found: $SignToolPath" }
    if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) { throw "Signing certificate was not found: $CertificatePath" }

    $arguments = @('sign', '/fd', 'SHA256', '/f', $CertificatePath)
    if (-not [string]::IsNullOrWhiteSpace($CertificatePassword)) { $arguments += @('/p', $CertificatePassword) }
    if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) { $arguments += @('/tr', $TimestampUrl, '/td', 'SHA256') }
    $arguments += $Artifact
    & $SignToolPath @arguments
    if ($LASTEXITCODE -ne 0) { throw "Installer signing failed with exit code $LASTEXITCODE." }

    & $SignToolPath verify /pa $Artifact
    if ($LASTEXITCODE -ne 0) { throw "Installer signature verification failed with exit code $LASTEXITCODE." }
}

function Invoke-SignPowerShellArtifact {
    param([string]$Artifact)

    if (-not $signingConfigured) { return }
    $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2(
        $CertificatePath, $CertificatePassword, $flags)
    try {
        if (-not $certificate.HasPrivateKey) { throw "Signing certificate has no private key: $CertificatePath" }
        $parameters = @{
            FilePath = $Artifact
            Certificate = $certificate
            HashAlgorithm = 'SHA256'
        }
        if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) { $parameters.TimestampServer = $TimestampUrl }
        $signature = Set-AuthenticodeSignature @parameters
        if ($signature.Status -ne 'Valid') {
            throw "PowerShell signature verification failed for ${Artifact}: $($signature.Status)"
        }
    }
    finally {
        $certificate.Dispose()
    }
}

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
    & $NodePath $releaseBuilder '--source-root' $repoRoot '--out' $releaseRoot
    if ($LASTEXITCODE -ne 0) { throw "Release build failed with exit code $LASTEXITCODE." }

    $runtimeRoot = Join-Path $payloadRoot 'runtime'
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    Build-CodexBootstrap -Destination $runtimeRoot
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $runtimeRoot 'node.exe') -Force
    $nodeLicense = Join-Path $runtimeRoot 'Node-LICENSE.txt'
    if ([string]::IsNullOrWhiteSpace($NodeLicensePath)) {
        $NodeLicensePath = Join-Path (Split-Path -Parent $NodePath) 'LICENSE'
    }
    if (Test-Path -LiteralPath $NodeLicensePath -PathType Leaf) {
        Copy-Item -LiteralPath $NodeLicensePath -Destination $nodeLicense
    } else {
        $nodeVersion = (& $NodePath --version).Trim()
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Unable to identify the Node runtime version.' }
        & curl.exe --noproxy '*' --fail --location --silent --show-error --connect-timeout 15 --max-time 60 `
            -H 'Accept: application/vnd.github.raw+json' -H 'User-Agent: yisama-build' `
            --output $nodeLicense "https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=$nodeVersion"
        if ($LASTEXITCODE -ne 0) { throw 'Unable to download the matching official Node license. Supply -NodeLicensePath for an offline build.' }
    }
    if ((Get-Item -LiteralPath $nodeLicense).Length -lt 10000 -or
        -not ([IO.File]::ReadAllText($nodeLicense).Contains('MIT License'))) {
        throw 'The Node distribution license is incomplete.'
    }

    $payloadScripts = Join-Path $payloadRoot 'scripts'
    New-Item -ItemType Directory -Force -Path $payloadScripts | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'scripts') -File |
        Copy-Item -Destination $payloadScripts -Force
    Invoke-SignPowerShellArtifact (Join-Path $payloadScripts 'launch-codex.ps1')
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'package.json') -Destination (Join-Path $payloadRoot 'package.json') -Force
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'LICENSE.txt') -Destination (Join-Path $payloadRoot 'LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'release-manifest.json') -Destination (Join-Path $payloadRoot 'release-manifest.json') -Force
    $payloadNodeModules = Join-Path $payloadRoot 'node_modules'
    New-Item -ItemType Directory -Force -Path $payloadNodeModules | Out-Null
    foreach ($dependency in @('playwright', 'playwright-core')) {
        $sourceDependency = Join-Path $nodeModules $dependency
        if (-not (Test-Path -LiteralPath $sourceDependency -PathType Container)) {
            throw "Required runtime dependency was not found: $sourceDependency"
        }
        Copy-Item -LiteralPath $sourceDependency -Destination $payloadNodeModules -Recurse -Force
    }
    Invoke-SignArtifact (Join-Path $runtimeRoot 'node.exe')
    Invoke-SignArtifact (Join-Path $runtimeRoot 'codex-bootstrap.exe')

    $manifestFile = Join-Path $payloadRoot 'release-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $bootstrapHash = (Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'codex-bootstrap.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    $launcherHash = (Get-FileHash -LiteralPath (Join-Path $payloadScripts 'launch-codex.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest.entries | Add-Member -NotePropertyName 'launch-codex.ps1' -NotePropertyValue $launcherHash
    $manifest | Add-Member -NotePropertyName windowsBootstrap -NotePropertyValue @{
        engineRevision = '474658de8b3013d6f2ee68ce0cc0402219de11cc'
        sha256 = $bootstrapHash
        codexRelease = Get-Content -LiteralPath (Join-Path $bootstrapRoot 'codex-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $hashInput = [Text.Encoding]::UTF8.GetBytes((($manifest.entries | ConvertTo-Json -Compress) + $bootstrapHash))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $buildId = ([BitConverter]::ToString($hasher.ComputeHash($hashInput))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $manifest | Add-Member -NotePropertyName buildId -NotePropertyValue $buildId
    [IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))

    $appVersion = (Get-Content -LiteralPath (Join-Path $releaseRoot 'package.json') -Raw | ConvertFrom-Json).version
    & $IsccPath '/Qp' "/DPayloadDir=$payloadRoot" "/DAppVersion=$appVersion" `
        "/DOutputDir=$outputDirectory" "/DOutputName=$([IO.Path]::GetFileNameWithoutExtension($OutputPath))" $installerScript
    if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed with exit code $LASTEXITCODE." }
    Invoke-SignArtifact $OutputPath
}
finally {
    Remove-BuildTemporaryRoot $temporaryRoot
}

Write-Output "Built $OutputPath"
