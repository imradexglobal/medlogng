# Offline speech deployment verification

Phase 1 is not release-ready until this checklist is completed on a clean
Windows machine matching the Host application's supported Windows versions and
on the actual 4 GB Host computer. CI asset builds do not substitute for these
checks.

## Before installation

- Record Windows edition, version/build, architecture, total RAM and free disk.
- Obtain the installer and its matching `speech-assets.json`,
  `ffmpeg-build.json`, build logs and source/toolchain provenance.
- Verify the installer SHA-256 against the release record.
- On the build machine, run `scripts/verify-speech-assets.ps1` against the
  staged `vendor/speech` directory before making the installer.
- Confirm this machine has no Visual Studio, CMake, MSYS2, Git, Node.js, FFmpeg
  or Whisper development tools installed.

## Clean installation and packaging

- Install and launch the Host without installing developer tools or runtime
  packages separately.
- Confirm the installation contains
  `resources/speech/medilog-whisper-worker.exe`,
  `resources/speech/ggml-tiny.en-q5_1.bin`, `resources/speech/ffmpeg.exe`, and
  `resources/speech/speech-assets.json`, plus `LICENSE-whisper.cpp.txt`,
  `COPYING.LGPLv2.1`, the matching FFmpeg source archive, detached signature
  and release key.
- Compare the installed worker, model and FFmpeg SHA-256 values against
  `speech-assets.json` and record them. Confirm model loading completes and the
  Host reports the worker ready.
- Confirm a missing or modified worker, model, FFmpeg executable or manifest
  prevents creating a Host installer.
- Confirm no Microsoft Visual C++ redistributable or MSYS2 runtime is required;
  if any binary needs one, include and verify the approved runtime dependency
  before release.

## LAN, security and persistence

- Confirm existing clients still use the same HTTP Host address and port for
  existing non-transcription features.
- Confirm HTTPS uses the trusted certificate valid for the actual stable Host
  address and selected port. Test browser microphone permission from a client.
- Submit a recording over HTTPS from two separate authenticated clients and
  confirm each can retrieve only its own job and result.
- Confirm transcription upload, job polling and result retrieval are rejected
  over HTTP; verify that authentication and authorization are required over
  HTTPS.
- Restart the Host with queued work present. Confirm queued audio and ownership
  survive restart, processing resumes once, and completed results are not
  duplicated or exposed to another user.
- Test queue full, per-user limit, invalid/empty audio, cancel, disconnect,
  timeout and worker crash. Confirm the queue continues after a failed job.
- Disconnect internet while keeping the LAN available and confirm the already
  authenticated local Host workflow continues according to Phase 1's approved
  local-session behavior.

## Transcription and performance

- Use consented, de-identified recordings with known reference transcripts;
  include Nigerian English accents, medication names, dosages and clinical
  terminology. Preserve and report recognition errors; do not silently correct
  transcripts.
- Test 1-, 3- and 5-minute recordings, plus invalid formats and empty audio.
- Separately collect English/Yoruba code-switching results. The pinned
  `tiny.en` model is English-only; do not interpret its output as a Yoruba
  evaluation.
- On the actual 4 GB Host, record peak worker and Host RAM, CPU utilization,
  elapsed transcription time, upload time, queue wait and maximum queue depth
  for one and multiple clients. Record failures and impact on ordinary Host
  work.
- Repeat an identical clean build and compare asset hashes before calling the
  build reproducible.

## Results record

For each test, record date, operator, machine/Windows build, installer and
manifest hashes, input recording identifier (never patient-identifying data),
expected and recognized text, job status/timings, CPU/RAM measurements, and
pass/fail notes. Phase 1 remains **IN PROGRESS** until the results are reviewed
and approved.
