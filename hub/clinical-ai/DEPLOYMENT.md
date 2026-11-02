# Clinical documentation assistant deployment

## Windows Host

The consultation screen records locally and offers a separate, clinician-triggered Deepgram transcription action. After transcript review, “Use for clinical draft” copies that text into the AI panel. The Host sends text to `/clinical-drafts` over its HTTPS listener. The Hub verifies live Firebase identity, active membership, `encounter.edit`, and the authoritative encounter's hospital and patient before forwarding text to an Ollama-compatible endpoint bound to loopback. Audio is not sent to the clinical-note AI model. The note-generation provider remains separate from Deepgram and no cloud note-generation fallback exists on the Host.

An administrator must install Ollama and a hospital-approved local model on the Host, then set these Host process environment variables before restarting it:

```powershell
$env:MEDLOG_CLINICAL_AI_URL = 'http://127.0.0.1:11434'
$env:MEDLOG_CLINICAL_AI_MODEL = '<hospital-approved-model-tag>'
```

Verify the model is available with `ollama list` and that the Hub process can reach `http://127.0.0.1:11434/api/tags`. Do not expose Ollama on the LAN. The default URL is loopback and the adapter rejects non-loopback endpoints. Review model license, update policy, disk/RAM needs, local logging, security and clinical performance before enabling it. No model is bundled with MediLogNG.

Both Host and Firebase speech transcription require online identity/membership authorization and an authoritative encounter read. There is no offline transcription engine or fallback. A recording made without connectivity remains local and is never uploaded automatically when connectivity returns. The locally hosted clinical-note model itself continues to require online authorization; the UI reports when services are unavailable.

## Firebase Hosting

`functions/index.js` defines authenticated callable functions for generation and review auditing. It checks active membership and `encounter.edit`, verifies the encounter's organization/patient binding, validates evidence against the submitted transcript and writes audit events. The provider adapter in `functions/clinicalAiProvider.js` deliberately returns `failed-precondition` until a hospital approves and supplies a provider implementation. Firebase Hosting has no Hub executable; the client calls these Firebase Functions directly. The code currently targets `us-central1`; the hospital must approve/change that region before deployment because it determines where transcripts are processed.

Before deployment, the Firebase project must have billing enabled for Cloud Functions. The Functions dependencies and lockfile are in `functions/`; run the Functions emulator integration suite, select a model provider only after privacy/legal review, use Secret Manager for any provider credential, configure the approved region/billing/quota/retention controls and review cloud logs. Then deploy Hosting and Functions together. This workspace has no approved provider or project deployment credentials, and no backend has been deployed. The Functions runtime is Node.js 22; the official Firebase runtime guidance lists Node 20 and 22 and states Cloud Functions deployment requires Blaze billing: [Manage functions](https://firebase.google.com/docs/functions/manage-functions).

## Clinical review

The assistant displays exact transcript excerpts, provenance, uncertainty, unresolved information and conflicts. A matching excerpt confirms only that the citation is in the transcript; it does not prove the proposed sentence is clinically entailed. The clinician must verify each claim, edit/accept/reject suggestions, insert accepted content, and use the existing Save note/Save plan controls. The assistant cannot create diagnoses, prescriptions, lab orders or other structured actions. Synthetic unit examples are not a clinical accuracy evaluation.
