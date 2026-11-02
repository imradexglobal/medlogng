[CmdletBinding()]
param(
  [string]$WhisperCppDir = '',
  [string]$FfmpegPath = '',
  [string]$FfmpegBuildInfoPath = '',
  [string]$FfmpegSourceDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$speechSource = Join-Path $repoRoot 'hub\speech'
$buildDir = Join-Path $repoRoot '.cache\whisper-worker-v1.9.5'
$stageDir = Join-Path $repoRoot 'vendor\speech'
$ffmpegSourceUrl = 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'
$ffmpegSignatureUrl = $ffmpegSourceUrl + '.asc'
$ffmpegReleaseFingerprint = 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
if (-not $FfmpegSourceDir) { $FfmpegSourceDir = Join-Path $stageDir 'ffmpeg-source' }
$modelName = 'ggml-tiny.en-q5_1.bin'
$modelPath = Join-Path $stageDir $modelName
$workerName = 'medilog-whisper-worker.exe'
$workerPath = Join-Path $stageDir $workerName
$release = 'v1.9.5'
$releaseCommit = 'd1be6fd'
$modelRevision = 'f281eb4'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/' + $modelRevision + '/' + $modelName
$modelSha256 = 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b'

function Stop-Build([string]$Message) {
  throw ('Whisper packaging preparation failed: ' + $Message)
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Step) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Stop-Build ($Step + ' exited with code ' + $LASTEXITCODE + '.') }
}

if (-not [Environment]::Is64BitOperatingSystem) { Stop-Build 'A 64-bit Windows build machine is required.' }
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) { Stop-Build 'CMake 3.20 or newer is required on the build machine.' }
$cmakeVersion = (& $cmake.Source --version | Select-Object -First 1)
if ($cmakeVersion -notmatch '([0-9]+)\.([0-9]+)') { Stop-Build 'Could not determine the CMake version.' }
if ([version]($Matches[1] + '.' + $Matches[2]) -lt [version]'3.20') { Stop-Build 'CMake 3.20 or newer is required.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Build 'Git is required to obtain the pinned whisper.cpp source.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere -PathType Leaf)) { Stop-Build 'Visual Studio 2022 Build Tools with the Desktop C++ workload (MSVC v143 and Windows SDK) is required.' }
$vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vsInstall -or -not (Test-Path (Join-Path ([string]$vsInstall) 'Common7\Tools\VsDevCmd.bat'))) {
  Stop-Build 'MSVC x64 tools were not found. Install the Visual Studio 2022 Desktop development with C++ workload.'
}
$vsVersion = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion).Trim()
if ($LASTEXITCODE -ne 0 -or $vsVersion -notmatch '^17\.') { Stop-Build 'The Whisper worker requires Visual Studio 2022 Build Tools (17.x).'}

if (-not $WhisperCppDir) {
  $WhisperCppDir = Join-Path $repoRoot '.cache\whisper.cpp-v1.9.5'
}
if (-not (Test-Path (Join-Path $WhisperCppDir 'CMakeLists.txt'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $WhisperCppDir -Parent) | Out-Null
  Invoke-Checked 'git' @('clone', '--filter=blob:none', '--depth', '1', '--branch', $release,
    'https://github.com/ggml-org/whisper.cpp.git', $WhisperCppDir) 'Cloning whisper.cpp'
}
$actualCommit = (& git -C $WhisperCppDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $actualCommit.StartsWith($releaseCommit, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Build ("Expected whisper.cpp $release commit $releaseCommit; found " + $actualCommit + '.')
}

New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$whisperLicensePath = Join-Path $WhisperCppDir 'LICENSE'
if (-not (Test-Path $whisperLicensePath -PathType Leaf) -or (Get-Content -Raw -LiteralPath $whisperLicensePath) -notmatch 'MIT License') {
  Stop-Build 'The pinned whisper.cpp source does not contain its expected MIT license text.'
}
Copy-Item -Force $whisperLicensePath (Join-Path $stageDir 'LICENSE-whisper.cpp.txt')
if (-not (Test-Path $modelPath)) {
  Write-Host ('Downloading the pinned English Tiny Q5_1 model: ' + $modelName)
  Invoke-WebRequest -Uri $modelUrl -OutFile ($modelPath + '.download')
  Move-Item -Force ($modelPath + '.download') $modelPath
}
$modelInfo = Get-Item $modelPath
if ($modelInfo.Length -lt 25MB -or $modelInfo.Length -gt 45MB) {
  Stop-Build ('Model size is outside the expected 25–45 MiB range: ' + $modelInfo.Length + ' bytes.')
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $modelPath).Hash -ne $modelSha256) {
  Stop-Build 'The model SHA-256 does not match the pinned upstream tiny.en-q5_1 artifact.'
}

$FfmpegPath = if ($FfmpegPath) { $FfmpegPath } else { Join-Path $stageDir 'ffmpeg.exe' }
$FfmpegBuildInfoPath = if ($FfmpegBuildInfoPath) { $FfmpegBuildInfoPath } else { Join-Path $stageDir 'ffmpeg-build.json' }
$ffmpegInputs = @(
  $FfmpegPath,
  $FfmpegBuildInfoPath,
  (Join-Path $FfmpegSourceDir 'ffmpeg-9.0.2.tar.xz'),
  (Join-Path $FfmpegSourceDir 'ffmpeg-9.0.2.tar.xz.asc'),
  (Join-Path $FfmpegSourceDir 'ffmpeg-devel.asc')
)
if ($ffmpegInputs | Where-Object { -not (Test-Path $_ -PathType Leaf) }) {
  $ffmpegBuilder = Join-Path $PSScriptRoot 'build-ffmpeg.ps1'
  Invoke-Checked (Join-Path $PSHOME 'powershell.exe') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ffmpegBuilder) 'Official FFmpeg source build'
}

if (-not (Test-Path $FfmpegPath -PathType Leaf)) {
  Stop-Build ('A vetted static Windows FFmpeg executable must be staged at ' + $FfmpegPath +
    '. Its source and license must be recorded before packaging.')
}
if (-not (Test-Path $FfmpegBuildInfoPath -PathType Leaf)) {
  Stop-Build ('FFmpeg source/build receipt is missing: ' + $FfmpegBuildInfoPath + '.')
}
try { $ffmpegBuildInfo = Get-Content -Raw -LiteralPath $FfmpegBuildInfoPath | ConvertFrom-Json }
catch { Stop-Build 'FFmpeg source/build receipt is not valid JSON.' }
$ffmpegSourceArchive = Join-Path $FfmpegSourceDir 'ffmpeg-9.0.2.tar.xz'
$ffmpegSourceSignature = Join-Path $FfmpegSourceDir 'ffmpeg-9.0.2.tar.xz.asc'
$ffmpegSigningKey = Join-Path $FfmpegSourceDir 'ffmpeg-devel.asc'
foreach ($requiredSourceFile in @($ffmpegSourceArchive, $ffmpegSourceSignature, $ffmpegSigningKey)) {
  if (-not (Test-Path $requiredSourceFile -PathType Leaf)) { Stop-Build ('Official FFmpeg source verification file is missing: ' + $requiredSourceFile + '.') }
}
if ($ffmpegBuildInfo.schemaVersion -ne 1 -or $ffmpegBuildInfo.sourceVersion -ne '9.0.2' -or
    -not $ffmpegBuildInfo.toolchain -or -not $ffmpegBuildInfo.configureArgs) {
  Stop-Build 'FFmpeg build receipt must identify its toolchain and complete configure arguments.'
}
$ffmpegSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ffmpegSourceArchive).Hash.ToLowerInvariant()
if ($ffmpegBuildInfo.sourceSha256 -and
    -not [StringComparer]::OrdinalIgnoreCase.Equals($ffmpegSourceHash, [string]$ffmpegBuildInfo.sourceSha256)) {
  Stop-Build 'FFmpeg source archive SHA-256 differs from the build receipt.'
}
$gpg = Get-Command gpg.exe -ErrorAction SilentlyContinue
if (-not $gpg) { $gpg = Get-Command gpg -ErrorAction SilentlyContinue }
if (-not $gpg) { Stop-Build 'GnuPG is required to verify the official FFmpeg source signature.' }
$gpgHome = Join-Path (Join-Path $repoRoot '.cache') ('ffmpeg-gpg-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $gpgHome | Out-Null
& $gpg.Source --homedir $gpgHome --batch --import $ffmpegSigningKey *> $null
if ($LASTEXITCODE -ne 0) { Stop-Build 'Could not import the FFmpeg release signing key.' }
$fingerprintLines = & $gpg.Source --homedir $gpgHome --batch --with-colons --fingerprint
if ($LASTEXITCODE -ne 0) { Stop-Build 'Could not read the FFmpeg release signing key fingerprint.' }
$primaryFingerprint = [string]($fingerprintLines | Where-Object { $_ -like 'fpr:*' } | Select-Object -First 1 | ForEach-Object { ($_ -split ':')[9] })
if ($primaryFingerprint -ne $ffmpegReleaseFingerprint) {
  Stop-Build 'FFmpeg signing key fingerprint does not match the fingerprint published by ffmpeg.org.'
}
& $gpg.Source --homedir $gpgHome --batch --verify $ffmpegSourceSignature $ffmpegSourceArchive *> $null
if ($LASTEXITCODE -ne 0) { Stop-Build 'FFmpeg source signature verification failed.' }
$ffmpegConfigureArgs = @($ffmpegBuildInfo.configureArgs | ForEach-Object { [string]$_ })
$requiredFfmpegArgs = @('--disable-autodetect', '--disable-shared', '--enable-static', '--disable-ffplay', '--disable-ffprobe', '--disable-doc', '--disable-debug', '--extra-ldflags=-static')
foreach ($requiredArg in $requiredFfmpegArgs) {
  if ($ffmpegConfigureArgs -notcontains $requiredArg) { Stop-Build ('FFmpeg configure receipt is missing required option ' + $requiredArg + '.') }
}
if (($ffmpegConfigureArgs -join ' ') -match '--enable-(gpl|nonfree)(\s|$)') {
  Stop-Build 'FFmpeg build receipt enables GPL or nonfree components.'
}
$ffmpegVersionOutput = & $FfmpegPath -version 2>&1
$ffmpegExitCode = $LASTEXITCODE
$ffmpegVersion = [string]($ffmpegVersionOutput | Select-Object -First 1)
if ($ffmpegExitCode -ne 0 -or $ffmpegVersion -notmatch '^ffmpeg version\s+9\.0\.2(?:\s|$)') {
  Stop-Build 'The staged FFmpeg executable failed its pinned version check (expected 9.0.2).'
}
$ffmpegConfiguration = [string]($ffmpegVersionOutput | Where-Object { $_ -match '^configuration:' } | Select-Object -First 1)
if ($ffmpegConfiguration -match '--enable-(gpl|nonfree)(\s|$)') {
  Stop-Build 'The staged FFmpeg build enables GPL or nonfree components and cannot be used for this Host package.'
}
foreach ($requiredArg in $requiredFfmpegArgs) {
  if ($ffmpegConfiguration -notlike ('*' + $requiredArg + '*')) {
    Stop-Build ('The staged FFmpeg configuration does not match its receipt; missing ' + $requiredArg + '.')
  }
}
$ffmpegLicenseOutput = & $FfmpegPath -L 2>&1
$ffmpegLicenseExitCode = $LASTEXITCODE
if ($ffmpegLicenseExitCode -ne 0 -or [string]($ffmpegLicenseOutput -join "`n") -notmatch 'GNU Lesser General Public License|LGPL') {
  Stop-Build 'The staged FFmpeg executable does not report an LGPL license.'
}
if ((Get-Item $FfmpegPath).Length -lt 1MB) { Stop-Build 'The staged FFmpeg executable is unexpectedly small.' }
$stagedFfmpegPath = Join-Path $stageDir 'ffmpeg.exe'
if ([IO.Path]::GetFullPath($FfmpegPath) -ne [IO.Path]::GetFullPath($stagedFfmpegPath)) {
  Copy-Item -Force $FfmpegPath $stagedFfmpegPath
}
$FfmpegPath = $stagedFfmpegPath

Invoke-Checked $cmake.Source @('-S', $speechSource, '-B', $buildDir, '-G', 'Visual Studio 17 2022', '-A', 'x64',
  '-T', 'v143',
  ('-DWHISPER_CPP_DIR=' + (Resolve-Path $WhisperCppDir).Path),
  '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF') 'CMake configure'
Invoke-Checked $cmake.Source @('--build', $buildDir, '--config', 'Release',
  '--target', 'medilog-whisper-worker', '--parallel', '2') 'Worker build'

$builtWorker = Join-Path $buildDir 'out\medilog-whisper-worker.exe'
if (-not (Test-Path $builtWorker -PathType Leaf)) {
  Stop-Build ('CMake succeeded but did not produce ' + $builtWorker + '.')
}
Copy-Item -Force $builtWorker $workerPath

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
$workerHash = Get-Sha256 $workerPath
$modelHash = Get-Sha256 $modelPath
$ffmpegHash = Get-Sha256 $FfmpegPath
$cachePath = Join-Path $buildDir 'CMakeCache.txt'
$compilerId = 'MSVC'
$compilerVersion = 'unknown'
$windowsSdkVersion = ''
$platformToolset = ''
if (Test-Path $cachePath) {
  $cacheCompilerId = Select-String -Path $cachePath -Pattern '^CMAKE_CXX_COMPILER_ID:[^=]+=(.+)$' | Select-Object -First 1
  $cacheCompilerVersion = Select-String -Path $cachePath -Pattern '^CMAKE_CXX_COMPILER_VERSION:[^=]+=(.+)$' | Select-Object -First 1
  if ($cacheCompilerId) { $compilerId = $cacheCompilerId.Matches[0].Groups[1].Value }
  if ($cacheCompilerVersion) { $compilerVersion = $cacheCompilerVersion.Matches[0].Groups[1].Value }
  $cacheSdk = Select-String -Path $cachePath -Pattern '^CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION[^=]*=(.+)$' | Select-Object -First 1
  $cacheToolset = Select-String -Path $cachePath -Pattern '^CMAKE_GENERATOR_TOOLSET[^=]*=(.+)$' | Select-Object -First 1
  if ($cacheSdk) { $windowsSdkVersion = $cacheSdk.Matches[0].Groups[1].Value }
  if ($cacheToolset) { $platformToolset = $cacheToolset.Matches[0].Groups[1].Value }
}
if ($compilerId -ne 'MSVC' -or $compilerVersion -notmatch '^[0-9]+\.[0-9]+') {
  Stop-Build 'CMake did not report the Visual Studio C++ compiler version; the asset manifest cannot be reproduced.'
}
if ($platformToolset -ne 'v143' -or $windowsSdkVersion -notmatch '^10\.') {
  Stop-Build 'CMake did not report the required v143 toolset and selected Windows SDK; the asset manifest cannot record build provenance.'
}

$manifest = [ordered]@{
  schemaVersion = 1
  architecture = 'windows-x64'
  whisperCpp = [ordered]@{ source = 'https://github.com/ggml-org/whisper.cpp.git'; version = $release; commit = $actualCommit; license = 'MIT'; licenseFile = 'LICENSE-whisper.cpp.txt' }
  toolchain = [ordered]@{
    cmake = [string]$cmakeVersion; visualStudioVersion = [string]$vsVersion
    compilerId = [string]$compilerId; compilerVersion = [string]$compilerVersion
    platformToolset = [string]$platformToolset; windowsSdkVersion = [string]$windowsSdkVersion
  }
  model = [ordered]@{ file = $modelName; version = 'tiny.en-q5_1'; source = $modelUrl; repositoryRevision = $modelRevision; license = 'MIT'; sizeBytes = $modelInfo.Length; sha256 = $modelHash }
  worker = [ordered]@{ file = $workerName; version = $release; sizeBytes = (Get-Item $workerPath).Length; sha256 = $workerHash }
  ffmpeg = [ordered]@{
    file = 'ffmpeg.exe'; version = [string]$ffmpegVersion; license = 'LGPL-2.1-or-later'
    configuration = $ffmpegConfiguration; source = $ffmpegSourceUrl; sourceVersion = [string]$ffmpegBuildInfo.sourceVersion
    sourceSha256 = ([string]$ffmpegBuildInfo.sourceSha256).ToLowerInvariant()
    signature = $ffmpegSignatureUrl; signatureFingerprint = $ffmpegReleaseFingerprint
    sourceArchiveFile = 'ffmpeg-9.0.2.tar.xz'; sourceSignatureFile = 'ffmpeg-9.0.2.tar.xz.asc'
    sourceSigningKeyFile = 'ffmpeg-devel.asc'; licenseFile = 'COPYING.LGPLv2.1'
    signatureVerified = $true; toolchain = $ffmpegBuildInfo.toolchain; configureArgs = $ffmpegConfigureArgs
    sizeBytes = (Get-Item $FfmpegPath).Length; sha256 = $ffmpegHash
  }
}
$manifestPath = Join-Path $stageDir 'speech-assets.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $manifestPath
Write-Host ('Built worker and wrote verified asset metadata: ' + $manifestPath)
