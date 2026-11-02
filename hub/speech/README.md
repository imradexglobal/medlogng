# Online medical speech transcription

MediLogNG now records speech in the browser and sends it to Deepgram only after the clinician chooses **Transcribe recording**. Stopping a recording never starts an upload. If offline, the browser stores it locally with AES-GCM encryption in IndexedDB, bound to the signed-in user, hospital, patient and encounter. If encrypted browser storage is unavailable, the recording is kept in the current page's memory and the clinician is told to keep the page open. A reconnect only checks availability; it never uploads a pending recording automatically.

Transcription uses Deepgram Nova-3 Medical over HTTPS. The API key remains on the Firebase Functions backend or Windows Host environment. The request sets `mip_opt_out=true`; there is no local Whisper engine or silent offline fallback. The UI displays a transcript for clinician review before insertion into a note.

The Firebase Hosting site (`https://medlogng.web.app`) calls the authenticated `speechHealth` and `transcribeConsultation` Functions. Windows Host deployments use the Host HTTPS endpoint, or the same Firebase endpoint when deployed/configured for that hospital. Both validate live Firebase identity, active membership, `encounter.edit`, and the authoritative encounter/patient/hospital binding before sending audio to Deepgram. Results and attempts are audit logged; audio is held in memory during provider processing and is not written to Host disk or Firestore.

## Configuration gates

Cloud Functions require a Secret Manager secret named `DEEPGRAM_API_KEY`, the `DEEPGRAM_ENDPOINT` environment value, and `DEEPGRAM_ALLOW_CLINICAL_AUDIO=true`. Host deployments require these values in the Host process environment. The endpoint must be one of Deepgram's allowlisted HTTPS endpoints: `api.deepgram.com`, `api.in.deepgram.com`, `api.eu.deepgram.com`, or `api.au.deepgram.com`. Do not use a global endpoint unless the hospital's data-protection review explicitly accepts global processing. No credentials are included in browser assets or the Host installer.

The current model is `nova-3-medical` with `language=en`. Deepgram lists English variants including `en-IN` but not `en-NG`; no Nigerian-English accuracy has been demonstrated. Use hospital-approved, consented and de-identified samples to compare output against adjudicated references before clinical rollout. Do not treat a transcript as a verified clinical note.

Deepgram documentation says regional processing requires a regional endpoint and `mip_opt_out=true`; it currently lists India, EU and Australia regions, but no Nigeria region. Confirm the provider's current product terms, clinical-data eligibility, retention settings, price for Nova-3 Medical and legal/data-protection suitability for Nigeria before enabling production processing. See [`ONLINE-STT-DEPLOYMENT.md`](./ONLINE-STT-DEPLOYMENT.md).

The offline device-session and offline EMR handoff mechanism remains for its existing application functions. It no longer authorizes or processes audio transcription.
