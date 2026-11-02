# Offline speech deployment verification

Phase 1 is not release-ready until this checklist is completed on a clean
Windows machine matching the Host application's supported Windows versions and
on the actual 4 GB Host computer. CI asset builds do not substitute for these
checks.

## Before installation

- Canonical Firebase web URL: `https://medlogng.web.app`. The current repository
  has no cloud speech backend. Firebase-only deployments must not submit audio
  to `/speech/jobs`; the UI should report cloud transcription as unavailable
  until a separately authenticated backend is implemented and approved.
- Record Windows edition, version/build, architecture, total RAM and free disk.
- Obtain the installer and its matching `speech-assets.json`,
  `ffmpeg-build.json`, build logs and source/toolchain provenance.
- Verify the installer SHA-256 against the release record.
- Do not distribute `release/MediLogHost-Setup-1.2.0.exe`: its package contains
  `hub/keys/service-account.json`. Use only a reviewed, credential-free Host
  candidate at `release/MediLogHost-Setup-1.2.2.exe` after verifying its SHA-256
  in `release/phase1/RELEASE-NOTES.md`. The 1.2.2 artifact is unsigned and is
  not production-ready without Authenticode signing and lifecycle validation.
- On the build machine, run `scripts/verify-speech-assets.ps1` against the
  staged `vendor/speech` directory before making the installer.
- Confirm this machine has no Visual Studio, CMake, MSYS2, Git, Node.js, FFmpeg
  or Whisper development tools installed.
- In Firebase Authentication email templates, confirm the password-reset
  action URL is configured to the app's deployed web action handler. The app
  intentionally handles Firebase's `mode=resetPassword` and `oobCode` in its
  browser login route. `handleCodeInApp` is for installed Android/iOS
  Universal/App Links and is not used for this browser flow. Verify an actual
  reset email reaches the app handler and that expired/used codes are rejected.

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

## Current local verification record

These results were obtained on the development machine on 2026-11-02. They
verify local code and emulator behavior only; they do not satisfy the clean
Windows, hospital Firebase, browser/device or target-hardware steps below.

- `npm test` — **PASSED** (smoke and service suites; Firestore rules test
  explicitly skips when no emulator is running).
- `npm run test:speech` — **PASSED** (worker lifecycle mocks, queue/session
  checks and asset-verifier checks).
- `npm run test:speech:listeners` — **PASSED** with local loopback access
  (HTTPS/HTTP behavior, signed device enrollment, offline bootstrap,
  transcription, replay protection and revalidation denial).
- `firebase emulators:exec --only firestore --project demo-medlogng "node
  scripts/test/hub.smoke.mjs"` — **17 passed, 0 failed**.
- `firebase emulators:exec --only firestore --project medlogng-test "node
  scripts/test/firestore.rules.test.mjs"` — **12 passed, 0 failed** using the
  repository's actual Firestore rules. Expected denied writes/read emit
  `PERMISSION_DENIED` emulator diagnostics.
- `npm run build` — first attempt was blocked by managed parent-directory
  access; a retry with the required file access **PASSED** (Vite transformed
  137 modules; completed in 5.45 seconds). This cleanup changed tests/docs and
  a dev-only test dependency, not application/Host packaging source; no
  installer rebuild was performed. The previous installer verification
  remains recorded in the Phase 1 audit.

The Firebase emulator used the demo project ID and no real project credentials.
The portable Microsoft JDK was verified against Microsoft's published SHA-256
and used only for emulator execution. These results are repeatable with
Java 21, Firebase CLI, the lockfile dependencies and local loopback access.

## Executable deployment validation procedure

These are the remaining hospital-side checks for the 1.2.2 candidate. Record
the operator, timestamp, machine/build, installer SHA-256, certificate
thumbprint, Host address and sanitized outcomes. Never put patient identifiers,
Firebase keys, PFX passwords or private keys in the record.

### HTTPS certificate trust and browser microphone

1. Issue a Host server certificate whose SAN includes the stable DNS name (or
   IP address) clients will use. Prefer a hospital-managed CA. Export a PFX
   containing the Host private key and import it using the Host setup wizard.
2. Install only the issuing CA certificate on each client into the Windows
   **Trusted Root Certification Authorities** store (or its centrally managed
   equivalent). Do not distribute the Host PFX/private key to clients.
   Restart the browser and confirm chain, hostname, validity and revocation
   checks pass for the exact Host URL.
3. Open the Host using that DNS name and HTTPS port in a supported browser.
   Confirm no certificate warning, allow microphone access, record a short
   consented test utterance, submit it, and verify the resulting job and
   transcript. Confirm HTTP blocks microphone use and rejects speech routes.
   Repeat with an untrusted CA and hostname mismatch; both must fail before
   enrollment or transcription.
4. Repeat in a second authenticated browser profile and verify each profile
   sees only its own job. Sign out of the first profile and verify its prior
   signed requests fail immediately. Save sanitized browser/Host logs.

### Live Firebase Admin setup and permission revalidation

1. Use a dedicated hospital test project and a least-privilege hospital service
   account approved for the Host's Auth verification and Firestore reads. Do
   not use a developer's personal key or production patient data. Transfer its
   JSON key through the hospital's approved secret channel and import it only
   through Host setup. Confirm the raw key is absent from installer/source.
2. Sign in as a test clinician with active membership and `encounter.edit`.
   Enroll a device online and complete one HTTPS transcription. Remove that
   capability (or deactivate membership) in the test project and force a
   successful online revalidation. Verify the Host invalidates or updates the
   cached grant and rejects the next signed request. Restore access and verify
   a new online enrollment/revalidation works.
3. Separately disconnect Host internet while preserving LAN. Verify the last
   online-verified grant continues to work offline and explicit sign-out
   invalidates it. Record that revocation cannot reach a fully offline Host
   until connectivity returns.

### Clean install, upgrade, restart and uninstall

1. On a clean supported Windows VM with no developer tools, verify the
   recorded installer SHA-256, install 1.2.2 per-user, complete setup using
   test-only credentials/certificates and confirm the displayed version.
2. Create a synthetic test queue/config marker and record its path/hash. Quit
   Host using **Tray menu → Quit**, confirm no Host process remains, then run
   the 1.2.2 installer over 1.2.0. Confirm operational data remains and the
   installed version is 1.2.2. Repeat once with Host still running to verify a
   recoverable close/retry prompt. Do not delete data or terminate unrelated
   processes to get past a lock.
3. With queued test work present, restart Windows and verify queue ownership
   remains intact and work resumes once. Uninstall from Windows Apps and
   confirm application binaries are removed while Host configuration,
   encrypted credentials, audit and queue data remain. Record the separate
   approved data-retirement procedure; uninstall intentionally preserves these
   clinical operational records.

### Multi-client performance

On the actual 4 GB Host, follow `PERFORMANCE-BENCHMARK.md` and its CSV template.
Run 6 and 10 authenticated clients from separate devices/browsers, with a
three-run burst and sustained workload. Record per-job queue/upload/conversion/
inference times, Host/worker peak working set, system commit, available memory
and CPU. Repeat with ordinary Host/EMR traffic. Test owner isolation,
disconnect/recovery, worker restart and exactly-once final results. Do not
label a higher-memory machine as a 4 GB result.

### Signing before production distribution

The current 1.2.2 executable is unsigned (`win.sign: false`). Before production
distribution, obtain an organization-controlled Authenticode certificate,
sign the installer and shipped executables under approved key custody, enable
signature verification, and verify signature, publisher, timestamp and final
SHA-256 on a clean Windows machine. An unsigned installer may trigger
SmartScreen warnings and provides no publisher authenticity or tamper evidence;
a verified payload hash alone does not establish who published it.
