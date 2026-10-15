param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExePath,

    [Parameter(Mandatory = $true)]
    [string]$AssetsRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Resolve-Path -LiteralPath $NodeExePath).Path
$assetsPath = (Resolve-Path -LiteralPath $AssetsRoot).Path
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -ne 'v24.16.0') {
    throw "Node.js v24.16.0 is required for the pinned launcher build; found $nodeVersion."
}

$toolsSource = Join-Path $assetsPath 'tools'
$requiredFiles = @(
    'ytdlp\yt-dlp.exe',
    'whisper\whisper-cli.exe',
    'whisper\whisper.dll',
    'whisper\ggml.dll',
    'whisper\ggml-base.dll',
    'whisper\ggml-cpu.dll'
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $toolsSource $relative) -PathType Leaf)) {
        throw "Missing runtime asset: $relative under $toolsSource"
    }
}

$buildRoot = Join-Path $repoRoot 'build'
$stageRoot = Join-Path $buildRoot 'payload-app'
$payloadRoot = Join-Path $repoRoot 'launcher\payload'
$publishRoot = Join-Path $buildRoot 'publish'
$releaseRoot = Join-Path $buildRoot 'release'
foreach ($target in @($buildRoot, $stageRoot, $payloadRoot, $publishRoot, $releaseRoot)) {
    $fullTarget = [System.IO.Path]::GetFullPath($target)
    $fullRepo = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\') + '\'
    if (-not $fullTarget.StartsWith($fullRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the source project: $fullTarget"
    }
}

New-Item -ItemType Directory -Path $buildRoot, $stageRoot, $payloadRoot, $releaseRoot -Force | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
}
if (Test-Path -LiteralPath $publishRoot) {
    Remove-Item -LiteralPath $publishRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null

Copy-Item -Path (Join-Path $repoRoot 'app\*') -Destination $stageRoot -Recurse -Force
$stagedTools = Join-Path $stageRoot 'tools'
if (Test-Path -LiteralPath $stagedTools) { Remove-Item -LiteralPath $stagedTools -Recurse -Force }
Copy-Item -LiteralPath $toolsSource -Destination $stageRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination $stageRoot -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md') -Destination $stageRoot -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'licenses') -Destination $stageRoot -Recurse -Force

$archivePath = Join-Path $payloadRoot 'app.zip'
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $archivePath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $payloadRoot 'node.exe') -Force

$project = Join-Path $repoRoot 'launcher\BiliSpeechLauncher.csproj'
& dotnet publish $project --configuration Release --runtime win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeAllContentForSelfExtract=true -o $publishRoot
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$builtExe = Get-ChildItem -LiteralPath $publishRoot -Filter '*.exe' -File | Select-Object -First 1 -ExpandProperty FullName
if (-not $builtExe) { throw "No EXE was created under $publishRoot" }
$releaseExe = Join-Path $releaseRoot 'BiliSpeechToDocument.exe'
Copy-Item -LiteralPath $builtExe -Destination $releaseExe -Force
Get-Item -LiteralPath $releaseExe | Select-Object FullName, Length, LastWriteTime