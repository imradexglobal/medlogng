# Online speech transcription deployment

## Data flow and safety

1. A clinician opens a patient-linked consultation and records locally in an HTTPS, microphone-capable browser.
2. The browser encrypts the recording with AES-GCM in IndexedDB. Its metadata is bound to the authenticated UID, hospital, patient and encounter.
3. After the clinician explicitly presses **Transcribe recording**, the app checks the active backend and sends that recording once over HTTPS with a Firebase ID token.
4. The Firebase Function or Host verifies the token online (including revocation), active membership, `encounter.edit`, and the authoritative encounter's organization and patient. It rejects requests when any check is unavailable or mismatched.
5. The server sends audio directly from memory to the configured Deepgram endpoint, with `mip_opt_out=true`, using `nova-3-medical` and `language=en`. It returns text only; the Host does not persist audio or transcripts.
6. The consultation screen displays the transcript for clinician correction, manual insertion or clinical-draft review. No note is saved by the speech service.

No reconnect-triggered upload exists. A saved offline recording remains pending until the clinician explicitly starts transcription. If browser encrypted storage cannot be used, only an in-memory copy remains; the UI warns the user to keep the page open.

## Firebase Hosting setup

The current site is `https://medlogng.web.app`. Set the project to the hospital-approved Firebase project and region before deploying. Configure the `DEEPGRAM_API_KEY` Secret Manager secret and function environment values:

```text
DEEPGRAM_ENDPOINT=https://api.in.deepgram.com
DEEPGRAM_ALLOW_CLINICAL_AUDIO=true
```

Then deploy only after the hospital approves the Deepgram account, regional endpoint, processing terms, clinical-data eligibility, expected cost, legal basis and data-protection assessment. Example:

```powershell
firebase functions:secrets:set DEEPGRAM_API_KEY
firebase deploy --only functions
```

The functions currently target `us-central1`. This is the Google Cloud region for request/auth/audit handling and is a separate decision from Deepgram's processing endpoint. Confirm and approve both. Functions require an enabled billing plan. The application does not fall back to a Hub endpoint on Firebase Hosting.

## Windows Host setup

The installer does not contain Deepgram credentials. Configure the Host process environment through the hospital's managed Windows deployment process, then restart MediLogNG Host:

```text
DEEPGRAM_API_KEY=<secret held by the hospital>
DEEPGRAM_ENDPOINT=https://api.in.deepgram.com
DEEPGRAM_ALLOW_CLINICAL_AUDIO=true
```

Keep the key out of the browser, source tree, installer, logs and shared user config. Environment variables must be present in the process that launches the Host. Test health while signed in with `encounter.edit`; unavailable/unauthorized health must leave the Transcribe action disabled. Host speech requests are accepted over HTTPS only.

## Operational validation checklist

- Use a test Firebase project and synthetic audio first. Verify `GET speechHealth` says unavailable before enabling the feature, then available only after the key/endpoint are present and the credential is accepted by Deepgram's `/v1/auth/token` endpoint. This check validates credential authentication without requiring project-administration permissions; it does not prove that the account can use Nova-3 Medical. The first synthetic transcription must verify model entitlement.
- Verify deployment origin is exactly `https://medlogng.web.app`; no Firebase Hosting index fallback may be treated as an API.
- Test no membership, inactive membership, missing `encounter.edit`, expired/revoked token, other hospital, wrong patient and wrong encounter. Provider call count must remain zero for each rejected request.
- Confirm Cloud/Host audit rows include actor UID, hospital, patient, encounter, request id, action, model and timestamp, and contain no audio or transcript.
- Record a synthetic consultation in Chrome/Edge over HTTPS. Deny permission, grant permission, stop without network, reload, reconnect, and explicitly transcribe. Check that reconnection alone never uploads.
- Review/edit the transcript before inserting. Use existing SOAP/Plan save controls. Confirm speech does not auto-save notes or generate orders.
- Test cancel, timeout, provider error, provider key revocation, endpoint outage, oversized/corrupt files and browser refresh. Pending encrypted audio must remain local after failed requests.
- Confirm the Firebase app has no Deepgram API key in built JavaScript, source maps, browser storage or network request headers. The browser sends Firebase identity only; server-to-server request carries Deepgram authorization.
- Confirm `mip_opt_out=true` in the outgoing provider request and verify the setting in Deepgram usage logs for the hospital account.

## Provider selection and unresolved approval

Deepgram was selected to match the user's provider preference. Its public model matrix lists Nova-3 Medical English variants (`en`, `en-US`, `en-AU`, `en-CA`, `en-GB`, `en-IE`, `en-IN`, `en-NZ`) but no `en-NG`; this implementation uses generic English and does not claim Nigerian-accent accuracy. A regional endpoint must be confirmed to expose the medical model for the hospital account. The India endpoint is a candidate by geography, not a claim of Nigeria residency. Deepgram's public materials state `mip_opt_out=true` prevents retention of audio/transcript after processing; request metadata/usage logs remain. Verify current terms and contract directly.

Pricing on the public rate card is usage-based; the page lists rates by product/model and does not expose a distinct Nova-3 Medical price in its general table. Obtain a written quote/terms for the precise model, opt-out, region, expected minutes, support and any healthcare add-ons. Do not use real patient data until hospital clinical, legal, privacy and procurement owners approve.

## Test commands

```powershell
npm run test:speech
npm --prefix functions test
npm run build
```

These automated tests use synthetic audio and mock provider responses. They validate request flow and authorization; they do not demonstrate transcription quality or a live Deepgram account. Live provider, clinical-corpus, hospital-browser, billing and Nigerian legal/data-protection reviews remain external deployment tasks.
