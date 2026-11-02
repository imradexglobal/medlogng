[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$candidates = @()
if ($env:MSYS2_ROOT) { $candidates += $env:MSYS2_ROOT }
$candidates += @('C:\msys64', 'C:\tools\msys64')
$msysRoot = $candidates | Where-Object { Test-Path (Join-Path $_ 'usr\bin\bash.exe') } | Select-Object -First 1
if (-not $msysRoot) {
  throw 'FFmpeg build requires MSYS2 UCRT64. Install it from https://www.msys2.org/ or set MSYS2_ROOT to its installation folder.'
}

$bash = Join-Path $msysRoot 'usr\bin\bash.exe'
$cygpath = Join-Path $msysRoot 'usr\bin\cygpath.exe'
foreach ($tool in @($bash, $cygpath)) {
  if (-not (Test-Path $tool -PathType Leaf)) { throw ('MSYS2 is incomplete; required tool is missing: ' + $tool) }
}
$repoMsysOutput = & $cygpath -u $repoRoot
$cygpathExitCode = $LASTEXITCODE
if ($cygpathExitCode -ne 0 -or -not $repoMsysOutput) {
  throw 'MSYS2 cygpath could not run. Repair the MSYS2 installation or set MSYS2_ROOT to its valid root folder.'
}
$repoMsysPath = ([string]$repoMsysOutput).Trim()
if (-not $repoMsysPath.StartsWith('/')) { throw 'Could not convert the repository path for MSYS2.' }
$scriptMsysPath = $repoMsysPath + '/scripts/build-ffmpeg.sh'
$oldSystem = $env:MSYSTEM
$oldPathType = $env:MSYS2_PATH_TYPE
$oldChere = $env:CHERE_INVOKING
try {
  $env:MSYSTEM = 'UCRT64'
  $env:MSYS2_PATH_TYPE = 'minimal'
  $env:CHERE_INVOKING = '1'
  & $bash --login -c 'cd "$1" && bash "$2"' 'medlog-ffmpeg-build' $repoMsysPath $scriptMsysPath
  if ($LASTEXITCODE -ne 0) { throw ('FFmpeg UCRT64 build failed with exit code ' + $LASTEXITCODE + '.') }
} finally {
  if ($null -eq $oldSystem) { Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue } else { $env:MSYSTEM = $oldSystem }
  if ($null -eq $oldPathType) { Remove-Item Env:MSYS2_PATH_TYPE -ErrorAction SilentlyContinue } else { $env:MSYS2_PATH_TYPE = $oldPathType }
  if ($null -eq $oldChere) { Remove-Item Env:CHERE_INVOKING -ErrorAction SilentlyContinue } else { $env:CHERE_INVOKING = $oldChere }
}
