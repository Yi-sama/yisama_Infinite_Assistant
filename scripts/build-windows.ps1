[CmdletBinding()]
param(
    [string]$NodePath = 'D:\Node.js\node.exe',
    [string]$NodeLicensePath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$windowsRoot = Join-Path $repoRoot 'windows'
$distRoot = Join-Path $repoRoot 'dist'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$installerSource = Join-Path $windowsRoot 'Installer.cs'
$launcherSource = Join-Path $repoRoot 'scripts\launch-codex.ps1'
$assistantSource = Join-Path $repoRoot 'scripts\codex-assistant.mjs'
$panelSource = Join-Path $repoRoot 'scripts\codex-panel.mjs'
$nodeModules = Join-Path $repoRoot 'node_modules'

if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "C# compiler was not found: $csc" }
foreach ($source in @($installerSource, $launcherSource, $assistantSource, $panelSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required Windows payload source was not found: $source" }
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node runtime was not found: $NodePath" }
if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) { throw "Production dependencies were not found: $nodeModules" }

if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $distRoot 'Yisama-Setup.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('yisama-windows-build-' + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $temporaryRoot 'payload'
$payloadZip = Join-Path $temporaryRoot 'payload.zip'

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

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

    $runtimeRoot = Join-Path $payloadRoot 'runtime'
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
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
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'scripts') -Filter '*.mjs' -File |
        Where-Object { $_.Name -notlike '*.test.mjs' } |
        Copy-Item -Destination $payloadScripts -Force
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $payloadScripts 'launch-codex.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $payloadRoot 'package.json') -Force
    Copy-Item -LiteralPath $nodeModules -Destination (Join-Path $payloadRoot 'node_modules') -Recurse -Force

    Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $payloadRoot -Force | Select-Object -ExpandProperty FullName) -DestinationPath $payloadZip -CompressionLevel Optimal

    $resourceArgument = '/resource:{0},payload.zip' -f $payloadZip
    & $csc /nologo /codepage:65001 /utf8output /target:winexe /out:$OutputPath /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll $resourceArgument $installerSource
    if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-BuildTemporaryRoot $temporaryRoot
}

Write-Output "Built $OutputPath"
