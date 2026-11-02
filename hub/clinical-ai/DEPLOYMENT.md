# Clinical documentation assistant deployment

## Windows Host

The consultation screen uses the existing recorder and Whisper transcript review. “Use for clinical draft” copies that reviewed transcript into the AI panel. The Host sends it to `/clinical-drafts` over the configured Host HTTPS listener. The Hub verifies the Firebase identity online, active membership, `encounter.edit`, and the authoritative encounter's hospital and patient before forwarding text to an Ollama-compatible endpoint bound to loopback. Audio is not sent to the AI model. With the current adapter, model processing stays on the Host PC; no cloud AI fallback exists.

An administrator must install Ollama and a hospital-approved local model on the Host, then set these Host process environment variables before restarting it:

```powershell
$env:MEDLOG_CLINICAL_AI_URL = 'http://127.0.0.1:11434'
$env:MEDLOG_CLINICAL_AI_MODEL = '<hospital-approved-model-tag>'
```

Verify the model is available with `ollama list` and that the Hub process can reach `http://127.0.0.1:11434/api/tags`. Do not expose Ollama on the LAN. The default URL is loopback and the adapter rejects non-loopback endpoints. Review model license, update policy, disk/RAM needs, local logging, security and clinical performance before enabling it. No model is bundled with MediLogNG.

The Host authorization check currently requires online identity/membership verification and an authoritative encounter read for AI generation. Offline Whisper transcription remains independent and usable according to the Phase 1 offline speech session. AI generation itself is unavailable while the Host cannot reach Firebase; the UI says so and never silently changes processors.

## Firebase Hosting

`functions/index.js` defines authenticated callable functions for generation and review auditing. It checks active membership and `encounter.edit`, verifies the encounter's organization/patient binding, validates evidence against the submitted transcript and writes audit events. The provider adapter in `functions/clinicalAiProvider.js` deliberately returns `failed-precondition` until a hospital approves and supplies a provider implementation. Firebase Hosting has no Hub executable; the client calls these Firebase Functions directly.

Before deployment, the Firebase project must have billing enabled for Cloud Functions. Install the Functions dependencies in `functions/`, run a Functions emulator integration suite, select a model provider only after privacy/legal review, use Secret Manager for any provider credential, configure region/billing/quota/retention controls and review cloud logs. Then deploy Hosting and Functions together. This workspace has no approved provider, project deployment credentials, Functions lockfile, or deployed backend; these steps have not been performed.

## Clinical review

The assistant displays exact transcript excerpts, provenance, uncertainty, unresolved information and conflicts. A matching excerpt confirms only that the citation is in the transcript; it does not prove the proposed sentence is clinically entailed. The clinician must verify each claim, edit/accept/reject suggestions, insert accepted content, and use the existing Save note/Save plan controls. The assistant cannot create diagnoses, prescriptions, lab orders or other structured actions. Synthetic unit examples are not a clinical accuracy evaluation.
