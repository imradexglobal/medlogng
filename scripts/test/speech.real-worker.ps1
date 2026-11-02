[CmdletBinding()]
param(
  [string]$WorkerPath = '',
  [string]$ModelPath = '',
  [string]$SamplePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $WorkerPath) { $WorkerPath = Join-Path $repoRoot 'vendor\speech\medilog-whisper-worker.exe' }
if (-not $ModelPath) { $ModelPath = Join-Path $repoRoot 'vendor\speech\ggml-tiny.en-q5_1.bin' }
if (-not $SamplePath) { $SamplePath = Join-Path $repoRoot '.cache\whisper.cpp-v1.9.5\samples\jfk.wav' }

foreach ($requiredFile in @($WorkerPath, $ModelPath, $SamplePath)) {
  if (-not (Test-Path $requiredFile -PathType Leaf)) { throw ('Required real-worker test file is missing: ' + $requiredFile) }
}
$sha = [Security.Cryptography.SHA256]::Create()
$sampleStream = $null
try {
  $sampleStream = [IO.File]::OpenRead($SamplePath)
  $sampleHash = [BitConverter]::ToString($sha.ComputeHash($sampleStream)).Replace('-', '')
} finally {
  if ($sampleStream) { $sampleStream.Dispose() }
  $sha.Dispose()
}
if ($sampleHash -ne '59DFB9A4ACB36FE2A2AFFC14BACBEE2920FF435CB13CC314A08C13F66BA7860E') {
  throw 'Pinned whisper.cpp JFK test audio SHA-256 did not match.'
}

$audioDir = Join-Path ([IO.Path]::GetTempPath()) ('medlog-speech-real-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $audioDir | Out-Null
$audioPath = Join-Path $audioDir 'jfk.wav'
Copy-Item -LiteralPath $SamplePath -Destination $audioPath

function Quote-WindowsArgument([string]$Value) { '"' + $Value.Replace('"', '\"') + '"' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Resolve-Path $WorkerPath).Path
$start.Arguments = '--model ' + (Quote-WindowsArgument (Resolve-Path $ModelPath).Path) +
  ' --audio-dir ' + (Quote-WindowsArgument $audioDir) + ' --threads 1'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$started = $false
try {
  if (-not $process.Start()) { throw 'Could not start the actual Whisper worker executable.' }
  $started = $true
  $readyTask = $process.StandardOutput.ReadLineAsync()
  $ready = $readyTask.Wait([TimeSpan]::FromMinutes(3))
  if (-not $ready -and -not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit()
  }
  if (-not $ready -or $readyTask.Result -ne 'READY') {
    $stderr = if ($process.HasExited) { $process.StandardError.ReadToEnd() } else { 'worker startup timed out' }
    throw ('Actual worker failed to load the pinned model: ' + $stderr)
  }

  $process.StandardInput.WriteLine("ci-jfk`t$audioPath")
  $responseTask = $process.StandardOutput.ReadLineAsync()
  if (-not $responseTask.Wait([TimeSpan]::FromMinutes(3))) { throw 'Real audio transcription timed out.' }
  $response = $responseTask.Result -split "`t", 3
  if ($response.Count -ne 3 -or $response[0] -ne 'ci-jfk' -or $response[1] -ne 'OK') {
    throw ('Actual worker rejected the pinned test recording: ' + ($response -join "`t"))
  }
  $transcript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($response[2])).ToLowerInvariant()
  if ($transcript -notmatch 'ask not what your country can do for you' -or
      $transcript -notmatch 'ask what you can do for your country') {
    throw ('Actual tiny.en-q5_1 transcription did not contain the expected JFK phrases: ' + $transcript)
  }
  Write-Host 'Real worker startup, model load, protocol and pinned-audio transcription passed.'
  Write-Host ('Transcript: ' + $transcript)
  $process.StandardInput.WriteLine('QUIT')
  if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) {
    throw 'Actual Whisper worker did not stop cleanly after transcription.'
  }
} finally {
  if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  $process.Dispose()
  Remove-Item -LiteralPath $audioDir -Recurse -Force -ErrorAction SilentlyContinue
}
