[CmdletBinding()]
param([string]$AssetDir = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $AssetDir) { $AssetDir = Join-Path $repoRoot 'vendor\speech' }
$manifestPath = Join-Path $AssetDir 'speech-assets.json'
$required = @{
  worker = 'medilog-whisper-worker.exe'
  model = 'ggml-tiny.en-q5_1.bin'
  ffmpeg = 'ffmpeg.exe'
}

function Stop-Verification([string]$Message) {
  [Console]::Error.WriteLine('Speech asset verification failed: ' + $Message)
  exit 1
}

if (-not (Test-Path $manifestPath -PathType Leaf)) { Stop-Verification 'speech-assets.json is missing.' }
try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json }
catch { Stop-Verification 'speech-assets.json is not valid JSON.' }
if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'windows-x64') {
  Stop-Verification 'Unsupported manifest schema or architecture.'
}
if ($manifest.whisperCpp.source -ne 'https://github.com/ggml-org/whisper.cpp.git' -or
    $manifest.whisperCpp.version -ne 'v1.9.5' -or
    -not ([string]$manifest.whisperCpp.commit).StartsWith('d1be6fd', [StringComparison]::OrdinalIgnoreCase) -or
    $manifest.whisperCpp.license -ne 'MIT') {
  Stop-Verification 'The manifest does not identify the pinned whisper.cpp v1.9.5 source.'
}
if (-not $manifest.toolchain.cmake -or $manifest.toolchain.compilerId -ne 'MSVC' -or
    [string]$manifest.toolchain.compilerVersion -notmatch '^[0-9]+\.[0-9]+' -or
    [string]$manifest.toolchain.visualStudioVersion -notmatch '^17\.' -or
    $manifest.toolchain.platformToolset -ne 'v143' -or
    [string]$manifest.toolchain.windowsSdkVersion -notmatch '^10\.') {
  Stop-Verification 'The manifest is missing the Visual Studio 2022, MSVC v143, Windows SDK or CMake version information.'
}
if ($manifest.model.version -ne 'tiny.en-q5_1' -or $manifest.model.repositoryRevision -ne 'f281eb4' -or
    $manifest.model.license -ne 'MIT' -or
    $manifest.model.source -ne 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb4/ggml-tiny.en-q5_1.bin') {
  Stop-Verification 'The model manifest does not identify the pinned upstream revision and license.'
}
if ($manifest.ffmpeg.license -ne 'LGPL-2.1-or-later' -or $manifest.ffmpeg.sourceVersion -ne '9.0.2' -or
    $manifest.ffmpeg.source -ne 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz' -or
    $manifest.ffmpeg.signature -ne 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz.asc' -or
    $manifest.ffmpeg.signatureFingerprint -ne 'FCF986EA15E6E293A5644F10B4322F04D67658D8' -or
    $manifest.ffmpeg.signatureVerified -ne $true -or
    [string]$manifest.ffmpeg.sourceSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
    -not $manifest.ffmpeg.toolchain -or -not $manifest.ffmpeg.configureArgs -or
    [string]$manifest.ffmpeg.configuration -match '--enable-(gpl|nonfree)(\s|$)') {
  Stop-Verification 'The FFmpeg manifest lacks verified official source, signature, LGPL licence or build information.'
}
if ($manifest.whisperCpp.licenseFile -ne 'LICENSE-whisper.cpp.txt' -or
    $manifest.ffmpeg.licenseFile -ne 'COPYING.LGPLv2.1' -or
    $manifest.ffmpeg.sourceArchiveFile -ne 'ffmpeg-9.0.2.tar.xz' -or
    $manifest.ffmpeg.sourceSignatureFile -ne 'ffmpeg-9.0.2.tar.xz.asc' -or
    $manifest.ffmpeg.sourceSigningKeyFile -ne 'ffmpeg-devel.asc') {
  Stop-Verification 'The manifest is missing required upstream source and license file names.'
}
foreach ($licenseFile in @('LICENSE-whisper.cpp.txt', 'COPYING.LGPLv2.1')) {
  $licensePath = Join-Path $AssetDir $licenseFile
  if (-not (Test-Path $licensePath -PathType Leaf) -or (Get-Item $licensePath).Length -lt 100) {
    Stop-Verification ('Required third-party license text is missing or unexpectedly small: ' + $licenseFile + '.')
  }
}
$mitLicenseText = Get-Content -Raw -LiteralPath (Join-Path $AssetDir 'LICENSE-whisper.cpp.txt')
$ffmpegLicenseText = Get-Content -Raw -LiteralPath (Join-Path $AssetDir 'COPYING.LGPLv2.1')
if ($mitLicenseText -notmatch 'MIT License' -or $ffmpegLicenseText -notmatch 'GNU LESSER GENERAL PUBLIC LICENSE') {
  Stop-Verification 'A packaged third-party license file does not match its recorded license.'
}
$sourceArchivePath = Join-Path $AssetDir ([string]$manifest.ffmpeg.sourceArchiveFile)
if (-not (Test-Path $sourceArchivePath -PathType Leaf)) { Stop-Verification 'The exact FFmpeg source archive is missing from the asset package.' }
$actualSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceArchivePath).Hash
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actualSourceHash, [string]$manifest.ffmpeg.sourceSha256)) {
  Stop-Verification 'FFmpeg source archive SHA-256 does not match its verified build provenance.'
}
foreach ($sourceProof in @($manifest.ffmpeg.sourceSignatureFile, $manifest.ffmpeg.sourceSigningKeyFile)) {
  if (-not (Test-Path (Join-Path $AssetDir ([string]$sourceProof)) -PathType Leaf)) {
    Stop-Verification ('FFmpeg source signature/provenance file is missing: ' + $sourceProof + '.')
  }
}

foreach ($role in $required.Keys) {
  $record = $manifest.$role
  $expectedName = $required[$role]
  if (-not $record -or $record.file -ne $expectedName) { Stop-Verification ("Manifest entry '$role' must name '$expectedName'.") }
  if ([string]$record.sha256 -notmatch '^[0-9a-fA-F]{64}$') { Stop-Verification ("Manifest entry '$role' has an invalid SHA-256.") }
  $file = Join-Path $AssetDir $expectedName
  if (-not (Test-Path $file -PathType Leaf)) { Stop-Verification ("Required asset is missing: " + $expectedName + '.') }
  $actual = Get-Item -LiteralPath $file
  if ($actual.Length -ne [int64]$record.sizeBytes) { Stop-Verification ("Asset size does not match the manifest: " + $expectedName + '.') }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actualHash, [string]$record.sha256)) {
    Stop-Verification ("Asset SHA-256 does not match the manifest: " + $expectedName + '.')
  }
  if ($role -ne 'model') {
    $stream = [IO.File]::OpenRead($file)
    try {
      if ($stream.Length -lt 2 -or $stream.ReadByte() -ne 0x4d -or $stream.ReadByte() -ne 0x5a) {
        Stop-Verification ("Asset is not a Windows PE executable: " + $expectedName + '.')
      }
    } finally { $stream.Dispose() }
  }
  if (-not $record.version) { Stop-Verification ("Manifest entry '$role' has no version information.") }
}

$modelHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $AssetDir $required.model)).Hash
$pinnedModelHash = 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b'
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($modelHash, $pinnedModelHash)) {
  Stop-Verification 'The quantized Tiny English model does not match the pinned upstream SHA-256.'
}

$ffmpegOutput = & (Join-Path $AssetDir $required.ffmpeg) -version 2>&1
$ffmpegExitCode = $LASTEXITCODE
$ffmpegFirstLine = [string]($ffmpegOutput | Select-Object -First 1)
if ($ffmpegExitCode -ne 0 -or $ffmpegFirstLine -ne [string]$manifest.ffmpeg.version) {
  Stop-Verification 'FFmpeg failed to start or its reported version differs from the manifest.'
}

Write-Host 'Speech assets verified:'
Write-Host ('  Worker: ' + $manifest.worker.version + ' · SHA-256 ' + $manifest.worker.sha256)
Write-Host ('  Model:  ' + $manifest.model.version + ' · SHA-256 ' + $manifest.model.sha256)
Write-Host ('  FFmpeg: ' + $manifest.ffmpeg.version + ' · SHA-256 ' + $manifest.ffmpeg.sha256)
