$worker = Join-Path $PWD 'vendor/speech/medilog-whisper-worker.exe'
$model = Join-Path $PWD 'vendor/speech/ggml-tiny.en-q5_1.bin'
$audio = Join-Path $env:RUNNER_TEMP 'speech-test-audio'
$null = New-Item -ItemType Directory -Force -Path $audio
$sample = Join-Path $PWD '.cache/whisper.cpp-v1.9.5/samples/jfk.wav'
$sampleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sample).Hash
if ($sampleHash -ne '59DFB9A4ACB36FE2A2AFFC14BACBEE2920FF435CB13CC314A08C13F66BA7860E') {
  throw 'Pinned whisper.cpp JFK test audio hash did not match.'
}
$testWav = Join-Path $audio 'jfk.wav'
Copy-Item -LiteralPath $sample -Destination $testWav
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $worker
$start.ArgumentList.Add('--model'); $start.ArgumentList.Add($model)
$start.ArgumentList.Add('--audio-dir'); $start.ArgumentList.Add($audio)
$start.ArgumentList.Add('--threads'); $start.ArgumentList.Add('1')
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Could not start the real Whisper worker.' }
try {
  $readyTask = $process.StandardOutput.ReadLineAsync()
  $readyReceived = $readyTask.Wait([TimeSpan]::FromMinutes(3))
  if (-not $readyReceived -and -not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit()
  }
  if (-not $readyReceived -or $readyTask.Result -ne 'READY') {
    $stderr = $process.StandardError.ReadToEnd()
    throw ('Worker did not load the model: ' + $stderr)
  }
  $process.StandardInput.WriteLine("ci-jfk`t$testWav")
  $responseTask = $process.StandardOutput.ReadLineAsync()
  if (-not $responseTask.Wait([TimeSpan]::FromMinutes(3))) { throw 'Real audio transcription timed out.' }
  $response = $responseTask.Result -split "`t", 3
  if ($response.Count -ne 3 -or $response[0] -ne 'ci-jfk' -or $response[1] -ne 'OK') {
    throw ('Worker rejected pinned test audio: ' + ($response -join "`t"))
  }
  $transcript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($response[2])).ToLowerInvariant()
  if ($transcript -notmatch 'ask not what your country can do for you' -or
      $transcript -notmatch 'ask what you can do for your country') {
    throw ('Real worker transcription did not contain expected JFK phrases: ' + $transcript)
  }
  Write-Host ('Real pinned audio transcription passed. Transcript: ' + $transcript)
  $process.StandardInput.WriteLine('QUIT')
  if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'Worker did not stop cleanly after transcription.' }
} finally {
  if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  $process.Dispose()
}
