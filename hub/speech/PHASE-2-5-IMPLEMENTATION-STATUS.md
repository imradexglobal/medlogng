# Phase 2–5 implementation status

**Updated:** 2026-11-02  
**Canonical Firebase Hosting URL:** https://medlogng.web.app  
**Overall:** IN PROGRESS. The Phase 2 documentation workflow and two backend boundaries are now implemented in code, but no model runtime/provider is configured and no deployment is operationally validated.

This status supplements `PHASES-2-5-ROADMAP.md`. The roadmap remains the acceptance authority. The new contracts and deployment guard are foundations; they do not count as an end-to-end AI or cloud speech implementation.

## Phase 2 — AI-assisted clinical documentation

**Status: PARTIALLY IMPLEMENTED (workflow code present; actual model generation blocked by missing local model/provider approval).**

- Added a versioned SOAP draft contract with bounded fields, provenance labels, uncertainty, missing items, conflict descriptions and exact transcript evidence spans.
- Provider output with extra fields (including order/action payloads), unsupported provenance, absent citations, malformed spans or stale/tampered evidence is rejected.
- Review state binds the clinician, organization, patient and encounter. Explicit approval requires the bound clinician, matching open encounter and `encounter.edit`; rejection is supported. The utility does not write an encounter.
- Consultation UI now accepts a reviewed transcript, shows generated S/O/A/P items and exact transcript evidence, highlights uncertainty/missing/conflicting information, permits per-item editing/accept/reject, and inserts accepted content into existing SOAP and Plan editors. Clinician must then use existing Save note/Save plan controls; no auto-save or medication/order action is added.
- Windows Host backend now has a server-side Ollama-compatible adapter restricted to loopback, with no browser credentials or remote-provider fallback. Host verifies online identity, active membership, `encounter.edit`, and authoritative encounter/patient/hospital binding before generation. Generated and review actions are audit-written without transcript text.
- Firebase Hosting now has callable Function entry points with Firebase-authenticated identity, live membership/capability checks, encounter binding, evidence validation and audit events. Its provider interface is deliberately unconfigured; it returns a clear unavailable status until an approved adapter is supplied. Firebase Hosting has no Hub and the client calls the callable backend rather than `/clinical-drafts`.
- Synthetic adapter tests verify structured output, exact evidence spans, absent fabricated citation rejection, remote endpoint denial and fail-closed behavior. This is a deterministic mock-provider test, not a real model run.
- No Ollama runtime/model is installed, so real AI-generated content, clinician browser demonstration and clinical accuracy are not validated. A citation match cannot prove semantic entailment; the UI explicitly tells clinicians to verify each claim. Firebase Functions dependencies and a lockfile are now installed; policy/auth tests pass with an injected test store. The Firebase emulator and deployed integration were not run because free RAM fell below 1 GB, and no cloud provider is approved/configured.

## Phase 3 — clinical intelligence

**Status: NOT IMPLEMENTED beyond transcript-grounded draft omissions/conflicts.** Patient-history context and cross-chart suggestions require clinician-led mapping and separate provenance; the current assistant does not read patient history or mix chart facts into transcript claims.

## Phase 4 — workflow integration and automation

**Status: PARTIALLY IMPLEMENTED; live provider validation blocked.** Browser recordings are encrypted locally, require an explicit transcription action, and are sent to either the Windows Host HTTPS endpoint or Firebase Functions. Both server paths enforce live Firebase identity, active membership, `encounter.edit`, encounter/patient ownership, deterministic duplicate protection and audit status; the browser receives a transcript and processing duration for review, SOAP/Plan insertion or transfer to the Phase 2 draft panel. The Firebase Functions and Host tests use injected/mock providers and do not prove a real Deepgram call. A Deepgram credential and exact authorization to use the credential supplied in chat were not established here; no live audio was sent. No Whisper fallback remains. Phase 3 and Phase 5 remain unimplemented beyond the separately documented safety foundations and planning.

## Phase 5 — optimization and production readiness

**Status: NOT COMPLETE.** Existing Phase 1 Host benchmark evidence and limitations remain in `PHASE-1-AUDIT.md` and `PERFORMANCE-BENCHMARK.md`. No cloud job implementation, cross-mode workflow, new 4 GB/6–10-client results, production alerting, cloud restore exercise or hospital UAT was performed in this work.

## Preliminary cloud processor review

No processor is selected or approved. Google's official current Speech-to-Text materials identify Chirp 3 regional availability as US/EU multi-region; Hausa (`ha-NG`) and Yoruba (`yo-NG`) are listed in Preview, while the language list surfaced no Nigerian English (`en-NG`) entry. This is a material language and residency limitation, not evidence of suitable clinical accuracy. Official pricing lists standard v2 recognition at USD 0.016/minute for the first monthly tier, before storage/compute and any other services. Its data-usage FAQ distinguishes synchronous/streaming processing from asynchronous transcript storage (approximately five days). These details must be rechecked at procurement because model availability, terms, pricing and regions change. See the official [Chirp 3 model and regional/language table](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3), [Speech-to-Text pricing](https://cloud.google.com/speech-to-text/pricing), and [data-usage FAQ](https://docs.cloud.google.com/speech-to-text/docs/v1/data-usage-faq).

These published facts are insufficient to approve processing identifiable clinical data. Hospital privacy/legal review must confirm the exact service, endpoint, contract/addendum, permitted data, logs/abuse handling, retention, deletion, region, key control, billing and patient consent. A separate model/provider and lifecycle review is required for clinical-note generation. No credentials or production project were available, no live service call was made and no patient data was transmitted.

## Remaining completion gates

1. Select and approve cloud speech and clinical-note providers, data-processing terms, region, consent, retention/deletion, spend limits and incident ownership. No processor has been enabled.
2. Install and test Firebase Functions dependencies, run emulator and deployed integration tests, configure project billing/quota and deploy the authenticated callable backend. Firebase project access and deployment evidence are absent here.
3. Install a hospital-approved local model on the Host or provide an approved cloud adapter; test real generation, timeout/recovery, review auditing, and save through the existing capability-checked encounter services.
4. Evaluate the approved model on a consented, de-identified, clinician-adjudicated corpus. Report language groups separately, WER, severity 2–4 errors, medication/number/negation errors, uncertainty and clinician review outcomes.
5. Complete the roadmap's threat model, revocation/cross-patient tests, crash/retry/retention/recovery/cost controls, security review and both-deployment end-to-end UAT.
6. Complete outstanding Phase 1 hospital/browser/VM/4 GB/device-trust and signing gates listed in `PHASE-1-AUDIT.md`.

## Local verification performed for these foundations

- `npm run test:clinical-drafts` — PASS (synthetic evidence, tampering, binding, explicit review and capability checks).
- `npm run test:speech` — current PASS after the health-check and status changes (Deepgram adapter input/endpoint/MIP opt-out tests, Host-device session tests, Host/Firebase routing, mock Host HTTPS integration and legacy endpoint retirement). It does not contact Deepgram.
- `npm run test:clinical-ai` — PASS (synthetic mock adapter: draft structure, exact quote spans, citation fabrication rejection, non-loopback denial and unconfigured-model fail-closed behavior). It does not invoke Ollama or an external model.
- `npm --prefix functions test` — current PASS after adding revoked-token, inactive-membership, missing-capability and cross-patient/hospital rejection coverage (clinical-AI policy tests plus speech HTTP handler auth, encounter binding, audit, idempotency and fail-closed provider). It does not call Deepgram.
- Host local clinical-note AI uses a single scheduling lane. Speech recognition is online and is independent of the Host CPU inference queue. No actual model, live provider or target-hardware performance has been measured.
- `npm run build` — PASS after the consultation UI and backend client changes.

These tests do not demonstrate clinical AI quality, Firebase-only speech, provider privacy, production security, or Phase 2–5 acceptance.
