# MedlinNG Phase 1 audit

**Audit date:** 2026-11-02  
**Overall status: PARTIALLY COMPLETE.** The actual pinned FFmpeg signature now verifies, WAV/MP3/M4A/AAC/WebM/OGG conversion and real transcription passed, and HTTP/HTTPS listener behavior passed with strict TLS validation against an explicitly trusted temporary test CA. The approved offline session design is now implemented and covered by unit and HTTPS listener tests. Phase 1 still cannot be declared complete: actual browser microphone/client-PC trust, clean-machine installation, final fresh NSIS installer generation, target 4 GB performance, and clinical-corpus evaluation remain outstanding.

## Scope and repository state

The application uses a Vite browser client, Firebase Auth/Firestore for the clinical application, a Node/Electron Windows Host with the LAN Hub, and a persistent native Whisper worker. Transcription UI is embedded in the consultation SOAP and treatment-plan fields. The Hub serves the same application and separately provides its existing HTTP LAN endpoint and optional HTTPS endpoint.

At audit start, Git showed pre-existing edits in `src/app.css`, `src/buildInfo.js`, and `src/views/ConsultationsView.js`; they were left untouched. Speech assets and the existing Host installer are present. No Phase 2–5 code was changed.

At the end of this follow-up, the working tree also showed edits in `src/app.css`, `src/buildInfo.js`, `src/components/shell.js`, and `src/views/ConsultationsView.js`. I did not edit or revert those unrelated files.

## Requirement status

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Pinned Whisper source and license | PARTIALLY COMPLETE | `.cache/whisper.cpp-v1.9.5` is exactly commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`; its source license says MIT. Asset manifest records the Windows x64 MSVC build. A fresh source build was not run: this environment has CMake but no Visual Studio C++ tools (`cl`/`vswhere`). |
| Windows Whisper executable and model | COMPLETE for staged assets; fresh reproducible build PARTIALLY COMPLETE | Worker and 32,166,155-byte model exist, match `speech-assets.json` SHA-256 values, and the real worker loaded the model and transcribed pinned JFK audio. A clean second build/hash comparison remains outstanding. |
| Persistent worker, restart, timeout, failed audio | COMPLETE for tested scenarios | Real-worker test passed model startup, real transcription, malformed-audio rejection, continued processing, child crash restart, and inference-timeout recovery. The worker is supervised and serialized. |
| FFmpeg source, licensing, executable | COMPLETE for pinned source proof and staged runtime; fresh rebuild PARTIALLY COMPLETE | The detached source signature verified with pinned fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`; the signed source SHA-256 is `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`. The staged binary hash/version/configuration and LGPL license pass verification. `verify-speech-assets.ps1` now independently checks the detached signature and compares the verifier's hash with the manifest, so packaging fails closed. A fresh FFmpeg source rebuild remains outstanding. |
| HTTP Hub and separate HTTPS speech service | PARTIALLY COMPLETE | Listener integration passed: HTTP health remained available; HTTP job submission and result retrieval returned 403; HTTPS accepted requests and duplicate submissions shared a job/result through the same queue. TLS used a temporary CA explicitly trusted by Node, with normal chain and IP SAN validation enabled. This does not test client-PC trust deployment or browser microphone permissions. |
| Authentication, permission and ownership | PARTIALLY COMPLETE | First use/device registration requires online Firebase identity verification and live `encounter.edit`; P-256 device keys sign Host requests; Host session state and audit entries are encrypted with Electron safeStorage; signed requests bind method, URL, request ID, content type and body hash, with timestamp/replay checks. Offline grants have no fixed expiry and are invalidated on sign-out or successful online denial/revalidation. Consultation-bound actions include clinician, Host timestamp, org, device and encounter. Job owner/org checks remain. Unit and mocked HTTPS integration tests passed; browser/real-Firebase revocation and sign-out deployment tests remain outstanding. |
| Queue, concurrency, recovery and audio preservation | PARTIALLY COMPLETE | Automated persistence tests cover restart requeue, concurrent client submissions, idempotent duplicates, single active worker, queue limit, failure continuation, ownership denial, interrupted upload state and corrupt index audio preservation. Real worker crash/timeout behavior passed. Live simultaneous browser uploads and actual power-loss/disk-failure behavior remain untested. |
| Host installer and installation safety | PARTIALLY COMPLETE | Existing `release/MediLogHost-Setup-1.2.0.exe` is 91,124,454 bytes and dates from 2026-11-01. A current Electron staging build now exists at `release/win-unpacked`; its Hub `server.js`/`auth.js` match source, and packaged worker/model/FFmpeg hashes match the manifest. Fresh NSIS generation stalled after `building target=nsis`; its data archive remained 32 bytes and the old installer remained unchanged. A separate build attempt failed DNS for GitHub before using the explicit local distribution. Clean-machine install, upgrade and uninstall were not tested. |
| 4 GB / 6–10 client performance | BLOCKED for target-hardware claim | This machine reports 8 GB RAM. A short real transcription used about 118.7 MB sampled peak worker working set; startup was 0.14 s and inference 2.34 s. This is not target-hardware evidence. A reproducible protocol and CSV capture template are now provided in `PERFORMANCE-BENCHMARK.md` and `performance-results-template.csv`. |
| Medical/Nigerian English accuracy | PARTIALLY COMPLETE | The protocol and blank CSV template are ready. No consented, de-identified Nigerian clinical corpus and adjudicated references are available, so accuracy and clinical risk results remain pending. Yoruba/code-switching is correctly kept separate. |
| Overall phase | PARTIALLY COMPLETE | Requirements 5–13 in the brief are not all demonstrated in a production-like environment; see exact blockers above. |

## Commands and tests run

- `npm run speech:verify` — **passed**; staged worker, model and FFmpeg hashes, size, source pins, license files, PE headers, FFmpeg version/configuration checked.
- `npm run test:speech` — **passed**; mock worker protocol/supervision, persistent queue and asset-verifier rejection tests. These are source/logic tests, not real transcription evidence.
- `npm run test:speech:real` — **passed**; actual Windows worker and pinned model loaded; pinned audio transcribed; malformed audio failed safely; subsequent job succeeded; worker crash and inference timeout recovered.
- `npm run test:speech:listeners` (with temporary trusted CA, strict TLS validation and permitted loopback) — **passed**; HTTP health, HTTPS submissions, duplicate idempotency, HTTP submission/result rejection and shared job service. Worker is mocked in this integration test.
- `node scripts/test/speech.formats.real.mjs` — **passed using actual packaged FFmpeg and Whisper binaries**; WAV 3.90 s, MP3 3.50 s, M4A 4.25 s, AAC 2.82 s, WebM 3.07 s and OGG 3.28 s. Each was converted and transcribed from the pinned JFK sample. Corrupt MP3 was rejected; unknown input returned 415. Alternate containers were encoded from public audio using packaged FFmpeg; this is format validation, not clinical accuracy evidence.
- `npm run dist:host` — **signature verification and Vite build passed**, printing the pinned FFmpeg fingerprint. Electron Builder completed the current Windows app staging folder; source comparisons and worker/model/FFmpeg hashes passed. NSIS stalled after `building target=nsis`; its archive remained 32 bytes, so no fresh setup executable was produced. A build attempt without explicit local distribution failed DNS (`github.com` unavailable); using cached `electronDist` allowed packaging to proceed but did not resolve the NSIS stall.
- The staged source signature check verified FFmpeg archive hash `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` under the pinned release key. Asset tamper tests still passed under `npm run test:speech`.
- Direct worker timing harness — **passed on this machine**; 8 GB reported system RAM, 0.14 s model startup, 2.34 s JFK inference, approximately 118.7 MB sampled peak worker working set.

Browser permission prompts, actual MediaRecorder upload, client-computer trust deployment and live browser transcript retrieval still need testing from a separate trusted Windows client. The listener test uses an explicitly trusted temporary CA and a mocked transcription worker.

## Main implementation found

- `hub/speech/worker.cpp` and `worker.js`: native persistent CPU worker and supervisor with bounded input, restart, timeout and serialized protocol.
- `hub/speech/jobs.js`: disk-backed job index/audio, idempotency, queue and per-user limits, restart recovery, owner/org checks, retention and encrypted-result hooks.
- `hub/server.js`: one Hub handler/listener implementation shared by HTTP and HTTPS; speech paths require `req.socket.encrypted` and `encounter.edit` authorization.
- `electron/host.js`: starts the worker, provides HTTPS PFX configuration, reports validated LAN addresses, encrypts job results and auth cache with Windows safeStorage.
- `src/components/speechInput.js`: browser recording, upload, polling and explicit transcript review/insertion; consultation view connects it to SOAP and Plan.
- `scripts/verify-speech-assets.ps1`, `speech-assets.json`, FFmpeg receipt and deployment/accuracy docs establish asset and clinical evaluation checks.

## Remaining before Phase 1 completion

1. Do a clean FFmpeg source rebuild on an unrestricted release Windows build machine; compare clean Whisper/FFmpeg outputs if reproducibility is to be claimed.
2. The offline session semantics are resolved and implemented. Validate IndexedDB CryptoKey persistence, explicit sign-out, online permission revocation and reconnection on the supported Windows browser with a real Firebase project and Host.
3. Test browser microphone permission, recording, upload and transcript return from separate Windows clients; verify trusted CA deployment and certificate name coverage for the stable Host DNS/IP.
4. The real format/transcription matrix now covers WAV, MP3, M4A, AAC, WebM and OGG. Check additional hospital-originated devices/codecs if they are to be part of the supported matrix.
5. Complete a fresh NSIS build from current source, extract/hash its payload, then install on a clean supported Windows environment. Test startup, transcription, missing/corrupt-asset messaging, upgrade/data preservation and uninstall behavior.
6. Measure Host + worker RAM/CPU, duration and queue wait for 1-, 3- and 5-minute recordings, 6–10 clients, failures/restarts on actual 4 GB hardware using the new benchmark procedure/template.
7. Run the approved consented/de-identified Nigerian English and medical corpus evaluation; keep Yoruba/code-switching separate; obtain clinician review of medication/dose/route/frequency and severity 2–4 errors.

## Offline speech session lifecycle

The existing Firebase login flow is retained. On first speech use, the browser creates a non-exportable P-256 private key in IndexedDB and registers its public key over HTTPS after live Firebase identity, membership and `encounter.edit` checks. The Host binds that key to the verified uid and hospital, and stores only the public key and last verified grant in Electron safeStorage encrypted state. The browser profile's IndexedDB key is the client/device proof; the Host does not trust cached localStorage identity or membership JSON.

For upload, poll, cancel, offline bootstrap and revoke, the browser signs the exact request with that device key. The Host checks the stored grant, clinician/org binding, TLS, proof freshness and nonce replay before any transcription request, and continues enforcing job uid/org ownership. Explicit sign-out deletes all clinician keys from IndexedDB immediately and sends best-effort signed revoke calls to reachable Host sessions. On browser reconnect/focus and before online use, cached sessions are revalidated against Firebase identity and live Firestore membership/permissions. A denied grant invalidates the Host session and removes the browser key; a temporary backend outage preserves the last verified grant.

No fixed session expiration is imposed. A last verified `encounter.edit` permission remains locally valid until explicit sign-out or successful online revalidation, matching the approved policy. The five-minute timestamp bound applies only to each signed request as a replay defense; it does not expire the session. Revocation cannot take effect while the Host has no connection to the authoritative source. Browser-profile key storage is not hardware-backed and cannot protect against a compromised browser profile or same-origin script execution; test the chosen deployment's browser/profile protections.

The installer/build attempt and this report update did not modify Phase 2–5 business logic.

## Files changed in this follow-up

- `scripts/verify-speech-assets.ps1` — added detached FFmpeg source signature verification and signed-hash comparison before assets are accepted for packaging.
- `scripts/test/create-speech-test-certificate.ps1` and `scripts/test/speech.listeners.test.mjs` — added a temporary CA and strict chain/IP-name validation instead of disabling TLS verification.
- `scripts/test/speech.formats.real.mjs` — added real conversion/transcription coverage for the supported format matrix and malformed inputs.
- `hub/speech/sessions.js`, `src/services/speechSession.js`, `scripts/test/speech.sessions.test.mjs`, `hub/server.js`, `hub/auth.js`, `electron/host.js`, `hub/speech/jobs.js` — implemented encrypted Host sessions, device proof, online revalidation, explicit revoke, signed speech API calls, consultation audit and focused tests.
- `hub/speech/README.md`, `hub/speech/PHASE-1-AUDIT.md`, `hub/speech/PERFORMANCE-BENCHMARK.md`, and `hub/speech/performance-results-template.csv` — documented verification, current evidence and target-hardware benchmark process.
- `release/MediLogHost-Setup-1.2.0.exe` was not changed. `release/win-unpacked` is an ignored current app staging build with verified speech assets; the 32-byte NSIS archive is not a usable installer.

Offline speech session business logic was implemented and the approved policy is no longer an open decision. External deployment tests, clean installer, target performance and clinical evaluation mean **Phase 1 remains PARTIALLY COMPLETE**.

## Phase 1 completion follow-up (2026-11-02)

The follow-up security review found and fixed several release issues: Host enrollment now uses HTTPS and device binding; browser microphone use is refused on non-HTTPS origins; the Electron Host window prefers validated local HTTPS; signed device proofs are bound to the current Host process lifetime and replay storage is bounded; verified online 401/403 responses invalidate cached offline sessions; failed audit persistence cancels enrollment; and explicit sign-out clears local keys and revokes both speech and device sessions. The approved offline rule remains unchanged: only an online verified `encounter.edit` grant is cached, and it has no arbitrary expiration. Offline signed requests remain tied to the clinician, device key, consultation and Host audit timestamp. Existing authentication, authorization and job ownership checks remain enforced.

A packaging review also found that the previous Host file glob included `hub/keys/service-account.json`. Host packaging now excludes Firebase credentials and environment files. The pre-existing 1.2.0 installer was confirmed to contain `resources/app.asar.unpacked/hub/keys/service-account.json`; it must not be distributed. Host uninstall configuration now preserves Electron user data, which contains operational Host state.

| Follow-up check | Result |
|---|---|
| `npm run test:speech` | PASS: worker protocol/supervision, queue persistence/ownership, offline session binding/grant/signature/replay/restart/sign-out behavior and asset tamper rejection. |
| `npm run test:speech:listeners` (permitted loopback) | PASS: HTTPS enrollment, offline bootstrap, signed transcription, duplicate protection, revocation, HTTP rejection. |
| `npm run test:speech:real` | PASS: real Windows Whisper/model startup, pinned audio, malformed input rejection, crash restart and timeout recovery. |
| `npm run build` | PASS, Vite production bundle generated; existing mixed static/dynamic import warnings remain. |
| `npm run test:hub` | SKIPPED because Firestore emulator was not reachable at `127.0.0.1:8080`. |
| `npm test` | FAIL before service suite: existing `scripts/smoke.mjs:633` assertion expects a searchable-select filter box. This is outside the speech/offline-session changes and was not modified. |
| `npm run test:services` | FAIL in existing pharmacy service tests: 21 passed, one failed (`reverseDispenseIssue is refused without the prescription.dispense capability`). Test harness also logs missing `localStorage`. No unrelated EMR code was changed. |
| Live Firebase credential check | BLOCKED: configured Admin credential returns `app/invalid-credential`; no live identity/membership/permission revocation test could be run. |
| Real browser HTTPS/microphone and client trust | NOT RUN: the user stopped the Computer Use session with Escape. No browser UI automation was resumed. Listener tests use a temporary trusted CA, but this does not validate browser/Windows certificate deployment. |
| Best-available 8-request worker load | PASS as a limited surrogate: 8 concurrent submissions to one serialized real worker all succeeded; startup 0.66 s; total 31.016 s (3.877 s average/request); Host system RAM 8,386,805,760 bytes. This is not 6–10 independent network clients, nor 4 GB hardware; only 337,686,528 bytes were free at measurement time. |
| Fresh Host NSIS installer | BLOCKED: Electron app staging succeeded, but NSIS cannot finish. The cached `makensis.exe` fails to launch with Windows `Illegal System DLL Relocation`; build attempts left only a 32-byte `.nsis.7z` placeholder. Network-based Electron download also failed DNS. No fresh installer is claimed. |
| Installer content / install / upgrade / uninstall | NOT COMPLETED: stage content has required speech assets and omits `hub/keys/service-account.json`; installer archive cannot be verified as a valid package and no installation lifecycle test is claimed. The 1.2.0 installer is not a valid substitute because it contains the credential file. |

**Completion decision:** Phase 1 remains **PARTIALLY COMPLETE**, not production-ready. Session implementation and its automated/local integration coverage are complete, but a safe fresh installer, clean installation lifecycle, real browser/client certificate tests, live Firebase revalidation, 4 GB multi-client performance, Firestore-emulator integration, the existing failing full suites and clinical-corpus evaluation remain outstanding. Phase 2–5 remain planning only.

## Continued completion work (2026-11-02)

### Fresh Host installer

The cached NSIS compiler was not corrupt: running its `makensis.exe /VERSION` in the restricted process context reproduced the Windows relocation error, while the same compiler in the permitted Windows process environment returned `v3.04`. That isolated the failure to process isolation, not to the NSIS installation or Host project configuration. Using the local Electron distribution and the permitted compiler environment produced `release/phase1/MediLogHost-Setup-1.2.1.exe` (140,656,512 bytes). The previous `release/MediLogHost-Setup-1.2.0.exe` was not overwritten.

7-Zip read and tested the new self-extracting NSIS installer successfully (the expected appended NSIS stub is reported as trailing data by the archive reader). The payload includes the Host executable, worker, model, FFmpeg, manifest and license files. Extracted installer copies of `medilog-whisper-worker.exe`, `ggml-tiny.en-q5_1.bin`, `ffmpeg.exe`, and `speech-assets.json` had SHA-256 values identical to `vendor/speech`. A path scan found no `service-account.json`, `.env`, `.pem`, `.key`, `id_rsa`, or private-key paths. The installer is unsigned because this build has `sign: false`; it is not yet a signed production distribution.

### Installation lifecycle

- **Fresh install:** the 1.2.1 wizard completed an interactive per-user install to a new directory under `.tmp-host-installtest` on this development PC. The wizard displayed 1.2.1 and completed extraction. This is not a clean VM/machine test.
- **Host startup:** launching the installed 1.2.1 executable opened the first-time Host setup window. The setup correctly required the hospital service-account JSON and an HTTPS PFX. Neither was supplied, and no firewall rule was changed.
- **Uninstall and data preservation:** the isolated 1.2.1 uninstall returned exit code 0 and removed the application executable. A synthetic marker placed in the temporary user-data directory remained after uninstall.
- **Upgrade:** the 1.2.1 wizard recognized the isolated 1.2.0 installation and offered an in-place reinstall/upgrade. It then reported that MediLog NG Host could not be closed. The process could not be identified through the available process listing; a silent retry returned exit code 2 and left the isolated installation at 1.2.0. The user stopped Computer Use with Escape while the interactive retry was in progress, so I issued no further desktop controls. In-place upgrade is therefore **not verified**.
- **Restart:** a second full launch/shutdown/restart cycle was not completed.

The old installer was exercised only inside the temporary test tree. The original 1.2.0 installer remains unchanged and unsuitable for distribution. The temporary test tree became partly locked (`app.asar` could not be removed after the interrupted upgrade); a filename scan found no extracted service-account, `.env`, private-key or certificate files in it. The original 1.2.0 installer remains preserved at `release/MediLogHost-Setup-1.2.0.exe`.

### Firebase emulator and existing test failures

A portable Microsoft OpenJDK 21 was downloaded into the workspace, checked against Microsoft's published SHA-256, and used only for emulator tests. Firebase CLI downloaded Firestore Emulator 1.22.0 and started it with demo project `demo-medlogng`; no real Firebase project or credentials were used.

- `firebase emulators:exec --only firestore --project demo-medlogng "node scripts/test/hub.smoke.mjs"` — **7 passed, 9 failed**. Six unauthenticated schema-validation cases expected 400 but got 401; the test's own comment says auth-required endpoints return 401 without a minted token. Three handoff cases failed because the fixture created a patient-organization link but no matching patient document. No Phase 2/3 Hub code was changed.
- `firebase emulators:exec --only firestore --project demo-medlogng "node scripts/test/firestore.rules.test.mjs"` — **failed before running** with `SyntaxError: Illegal return statement` at line 34 of the existing test file. The Firestore rules test was not modified.
- `npm test` remains **failed** at `scripts/smoke.mjs:633`: the assertion searches for `data-filter-for`, which the existing select-filter implementation does not contain. Neither the smoke test nor its EMR components were changed in this follow-up.
- `npm run test:services` remains **failed** at the pharmacy test that expects doctors to lack `prescription.dispense`; the current committed doctor role includes that capability. The service, role and test files were not changed in this follow-up. The harness also logs that `localStorage` is unavailable in Node.

These are pre-existing test/fixture inconsistencies outside the Phase 1 speech/Host scope; they were recorded without changing unrelated EMR behavior. No Phase 2–5 implementation was started.

### Updated completion decision

The fresh 1.2.1 installer is now generated and its payload verified, and a fresh install plus uninstall/data-preservation test passed on the development PC. Phase 1 still remains **PARTIALLY COMPLETE**: the 1.2.0-to-1.2.1 upgrade and restart cycle are unverified; installer signing is absent; real browser/microphone/client trust and live Firebase permission revalidation remain unverified; 4 GB/6–10-client target hardware is unavailable; emulator integration suites have existing failures; and clinical corpus results remain pending. The Nigerian English/medical evaluation protocol is documented in `ACCURACY-EVALUATION.md`; it is a prepared protocol, not accuracy evidence.
