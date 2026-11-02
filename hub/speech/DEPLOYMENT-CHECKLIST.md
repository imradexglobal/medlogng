# Online transcription deployment checklist

The former Host-local Whisper/FFmpeg transcription implementation and package assets have been removed. Do not use or distribute pre-1.2.3 Host installers; they contain the retired engine, and 1.2.0 is separately known to be unsafe because of bundled Firebase credentials. The current 1.2.3 candidate requires new installer payload verification before release.

## Before enabling a provider

- Obtain hospital privacy/legal/clinical/procurement approval for Deepgram clinical audio processing and a documented lawful basis, vendor terms, retention controls, subcontractors, breach process and data-subject handling.
- Confirm whether Deepgram's India regional endpoint and Nova-3 Medical are enabled for the account. Nigeria has no listed Deepgram processing region. Review data residency implications before use.
- Obtain model-specific price and account confirmation that `mip_opt_out=true` is permitted; confirm it in the provider's account logs.
- Collect consented, de-identified Nigerian English synthetic/clinical-domain test recordings where permitted; adjudicate reference transcripts and report word/medical-term error before clinical launch. Do not infer Nigerian English quality from model availability.
- Configure `DEEPGRAM_API_KEY` only as a Firebase secret or Host process secret; configure approved `DEEPGRAM_ENDPOINT` and enable gate only after review.
- Confirm Firebase Functions region/billing, service account permissions, audit access, monitoring and quotas.

## Browser and recording

- Serve the app and Host speech endpoint over HTTPS with a certificate trusted by each client and valid for the exact Host DNS name.
- Use current Chrome or Edge on each client. Confirm `window.isSecureContext`, `navigator.mediaDevices.getUserMedia`, and `MediaRecorder` support.
- Test microphone permission denied/granted, no microphone, 5-minute maximum, stop, cancel, consultation navigation, and browser reload.
- Record offline and inspect IndexedDB: audio ciphertext only, key is non-extractable, identity/organization/patient/encounter binding is enforced. Reconnect and verify no network request occurs until the clinician chooses **Transcribe recording**.
- If encrypted storage is unavailable, ensure the UI tells the clinician that recording is only held in page memory.
- Confirm generated transcript remains editable and is not inserted/saved until clinician action.

## Security and application tests

- Run `npm run test:speech`, `npm --prefix functions test`, `npm run build`, and the complete `npm test` suite.
- Verify unauthenticated, revoked-token, inactive-member, wrong-organization, missing `encounter.edit`, wrong-patient and wrong-encounter requests never reach Deepgram.
- Verify Host HTTP refuses transcription; Host HTTPS and Firebase Functions accept only the configured app origin and expected client header.
- Confirm endpoint allowlist rejects HTTP, arbitrary hostnames, ports, credentials, query strings and redirects.
- Confirm provider request uses `nova-3-medical`, `language=en`, `mip_opt_out=true`, and no audio is written to local disk or Firestore.
- Confirm audit entries identify actor, timestamp, hospital, consultation, patient, request and result, and contain neither audio nor transcript.
- Check `dist/assets` and the installer for Deepgram credentials/private keys and retired Whisper/FFmpeg files.

## Firebase Functions and Host operation

- Deploy to a non-production Firebase project first. Confirm `speechHealth` fails closed without a secret and returns available only to an active, authorized clinician when the provider is reachable.
- Test live authentication, permission revocation, encounter ownership, audit writes, timeouts and provider outages with synthetic audio.
- For Windows Host, configure provider secrets in the Host process environment; restart Host and verify health. Never place credentials in Vite environment variables, browser code, Host config JSON or installer.
- Test Host restart, Firebase outage and Deepgram outage. Pending local audio must stay encrypted and user-triggered; no silent fallback or automatic upload.
- Monitor request latency, provider usage/cost, errors and concurrent users. The new online flow avoids local Whisper CPU/RAM consumption, but LAN bandwidth, provider quotas, cloud limits and hospital internet availability still require load validation.

## Release and hospital validation

- Generate the Host installer from the exact release commit and inspect the extracted payload. Confirm it has no `resources/speech` directory, Whisper worker/model, FFmpeg, source archives, Firebase service-account credentials, private keys or `.env` files.
- Record installer SHA-256, version, build command, package scan output and unsigned status. Authenticode signing is required for production Windows distribution.
- Run clean install, upgrade and uninstall in an isolated supported Windows VM, confirming Host configuration, certificate material and operational user data are preserved by upgrade/uninstall behavior.
- Validate HTTPS trust installation on every client using the hospital's managed trust process; no bypassing certificate warnings.
- Run 6–10-client hospital network testing and measure upload throughput/latency, backend queueing, simultaneous request limits, retries and user-visible failure paths. Record actual Host specs and connectivity.
- Complete browser microphone and live Firebase/Deepgram tests with approved credentials in the hospital environment. Never use identifiable patient data in development tests.
