# MedlinNG development roadmap: Phases 2–5

This roadmap is based on the current Vite/Firebase client, Electron Host/Hub, offline-first services, and existing consultation workflow. Phases 2–5 are planning only in this task. Do not select a cloud speech provider, change consent/retention terms, or implement AI clinical-note generation until the decisions listed below are approved.

## Existing application map

- The application is a browser-first Vite client using Firebase Auth and direct Firestore client services. It also ships as an Electron desktop/Host application.
- Core domains live under `src/services`, `src/features`, and `src/views`: patients, encounters, appointments, admissions, pharmacy, labs, billing and administration.
- `ConsultationsView.js` already has a staged encounter workspace: patient context and vitals; SOAP fields (Subjective, Objective, Assessment, Plan); a rich-text treatment-plan editor; diagnosis, prescription and lab workflows; explicit save actions and capability checks.
- Encounter records already include `patient_id`, `organization_id`, clinician, complaint, clinical note, vitals, diagnosis, treatment plan, prescription and lab orders. Firebase rules and `authService`/role capabilities govern current client operations. The rules document records a broad signed-in clinical-read model, so per-patient confidentiality assumptions need review before any AI/cloud path.
- The LAN Hub in `hub/server.js` verifies Firebase tokens and hospital membership server-side for Host features. Host transcription currently has a private persistent queue and HTTPS-only audio endpoints. Firebase-hosted web clients have no equivalent server job service today.
- `src/components/speechInput.js` currently records in the browser, submits to the same-origin Host endpoint, polls a durable job and presents a transcript review box before insertion. It does not generate or save AI notes.

## Phase 2 — Firebase cloud transcription

### Objective and features

Provide transcription for hospitals using Firebase hosting without a Windows Host. Let a clinician record in a secure browser context, upload audio reliably, see queued/processing/completed/failed/cancelled states, review the transcript, and resume status checks after a browser/network interruption. Host and cloud results should enter the same transcript-review and later documentation flow.

### Technical work

1. Map deployment mode and service API. Introduce a provider-neutral transcription-job interface at the UI boundary, retaining the existing Host route adapter and adding a cloud adapter. Do not make Firebase-hosted users resolve or call a Host address.
2. Evaluate backend candidates against verified current pricing, Nigerian-region availability/latency, medical-data terms, retention, training use, encryption, data residency, model/language support (including Nigerian English and code-switching), concurrency, quotas, outage behavior and exit strategy. Obtain procurement/privacy approval before choosing a provider.
3. Design secure upload: short-lived authorized upload credentials or authenticated chunked upload, strict size/type/duration limits, resumable transfer, checksums, idempotency, orphan cleanup and abuse quotas. Store audio in a private bucket with least-privilege rules; never put audio in public Hosting assets or callable URLs without expiry.
4. Add a trusted job coordinator (for example, a reviewed Cloud Functions/Cloud Run path) because Firebase Hosting alone cannot run durable private jobs or hold provider secrets. Authenticate Firebase ID tokens server-side; validate active organization membership and `encounter.edit`; bind job to uid, organization, patient and encounter; never trust client-supplied owner fields.
5. Persist minimal job metadata, transitions, provider request ids and safe errors. Ensure listeners/polling do not expose other users' job records. Use transactional idempotency and retry only when provider semantics make duplicate billing safe.
6. Return transcript to the current review component through a shared interface. Keep raw transcript immutable and separate from clinician edits. Define deletion of audio on success/failure/cancel and any approved transcript retention independently.

### Reuse and new components

Reuse `attachSpeechInput`, the `speechInput.js` review/insert semantics, `authStore`, membership/capability logic, consultation patient/encounter context, and the job concepts in `hub/speech/jobs.js` (after abstracting transport/persistence). Develop cloud upload storage, cloud job coordinator/worker, provider adapter, deployment-mode selection, retention cleanup, billing/usage observability and operational alerts.

### Dependencies, security and acceptance

Depends on a selected provider, signed data-processing terms, approved retention/data-location policy, billing account, cloud project configuration and production-grade server execution. Acceptance: Firebase-only hospital works with no Host installed; authorized job is tied to the correct patient/encounter; unauthorized user/org access fails; expired upload credentials and oversized/corrupt uploads fail safely; disconnect/reload resumes one job; duplicate requests do not double-transcribe/bill; audio is private and deleted on the approved schedule; provider errors and cost limits are observable; status/result is reviewed in the same UI as Host results.

### Deliverables, risks and approvals

Deliver provider evaluation and recommendation, privacy/threat model, cost envelope and quotas, retention/deletion policy, architecture/API, cloud resources and rules, monitoring, user-facing workflow, tests and operator runbook. Approval required for provider, costs, regions, data-processing terms, audio/transcript retention, consent wording, multilingual scope, and any change to the clinical read/access model. Main risks: unexpected per-minute costs, vendor lock-in, upload interruption, data leakage through storage/rules, provider outages, and Nigerian-accent clinical error.

## Phase 3 — Medical AI documentation assistant

### Objective and features

Transform a clinician-reviewed transcript into a draft aligned with existing SOAP and Plan forms. Extract only explicitly supported content; mark source as patient-reported, clinician-observed, or unclear; identify missing/conflicting statements; preserve context; allow editing; and require a doctor to review and approve before any encounter save.

### Technical work

1. Define a versioned structured schema mapped to actual form fields: Subjective, Objective, Assessment, Plan, plus links/citations to transcript spans and uncertainty/conflict flags. Treat existing vitals, medications, allergies and history as separate chart context with provenance; never confuse chart context with statements in the recording.
2. Build a provider-independent extraction boundary. Evaluate model/privacy location, prompt/data retention, cost, latency and structured-output guarantees before a provider decision. Enforce schema validation, source-span grounding and “not stated” values; reject unsupported claims rather than filling gaps.
3. Preserve verbatim transcript and AI draft as separate versioned objects. Show highlighted supporting transcript phrases and unresolved items next to every proposed field. Provide clinician edit, discard and approve actions; approval is explicit and attributable.
4. Keep generated data out of medication orders, diagnoses, lab orders and final encounter saves unless the clinician independently confirms each structured action. No background auto-save/auto-approval.
5. Add safe audit events for model/version, transcript version/hash, draft version, edits, reviewer, approval/rejection and final save without logging unnecessary PHI.

### Reuse and new components

Reuse SOAP `SOAP_FIELDS` and markers, Plan editor serialization, consultation workspace, encounter DTO/service, permission gates and transcript review. Develop extraction schema, prompt/model adapter, provenance/evidence UI, diff/review state, validation/uncertainty handling, audit/version storage, and clinician acceptance instrumentation.

### Dependencies, security and acceptance

Depends on Phase 2 transcripts in both deployment modes, selected/approved AI backend, consent and privacy terms, Phase 4 corpus/evaluation process, and a settled schema mapping with clinicians. Acceptance: each populated field has supporting transcript evidence; no unsupported fact is silently added; uncertain/contradictory content is visibly flagged; medication names/dose/route/frequency are never inferred; original transcript remains recoverable; no data saves until clinician review/approval; role and encounter ownership are enforced; reviewer can edit or reject safely.

### Deliverables, risks and approvals

Deliver clinical field mapping, schema, provider evaluation, reviewed prompts/adapters, draft UI, provenance/audit model, clinician workflow, safety evaluation and SOP. Approval required for model/provider, whether existing chart context may be included, field mapping, persistence/retention, audit visibility, and clinician sign-off policy. Main risks: hallucinated facts, omission of negation, fabricated or altered medication instructions, bias, automation bias, prompt injection embedded in dictated text and disclosure to a model provider.

## Phase 4 — Security, reliability and clinical validation

### Objective and features

Establish evidence that the Host and cloud workflows protect data, recover from faults and keep transcription/draft-generation risks visible. This phase is a cross-cutting verification and remediation stream; it should start with threat modeling before Phase 2 data paths are opened and continue through production.

### Technical work

- Map identity, organization, patient, encounter, audio, transcript, draft and final-note authorization across Firestore, Hub, Host disk, browser storage, cloud storage and provider APIs.
- Review Firestore's actual clinical-read policy against intended patient privacy. Test cross-organization and cross-patient access, membership suspension, privilege changes, super-admin paths and offline cached authorization. Review token replay and sign-out semantics; close the Phase 1 offline-session gap before calling offline authorization validated.
- Confirm TLS certificate trust/name/rotation, encryption-at-rest boundaries, safeStorage behavior, key backup/recovery, temporary file ACLs, result and audio retention, cleanup after crash, logs/telemetry redaction, backups and deletion evidence.
- Add abuse controls: upload quotas, job limits, request rate limits, provider spend budgets, alerting, secrets rotation and least-privilege service identities.
- Run concurrency, restart, disk-full, low-memory, malformed media, corrupt index, network loss, provider timeout, duplicate delivery, upgrade/rollback, restore and incident-response exercises.
- Execute Nigerian English and medical terminology evaluation with consented/de-identified, speaker-disjoint samples and clinician-adjudicated references. Report WER and clinically significant discrepancies separately. Inspect drugs, strength/dose, route, frequency, duration, negation/allergy, numbers, dates and measurements. Keep Yoruba/code-switching as its own evaluation group. A low WER is not a safety conclusion.
- Conduct clinician usability/acceptance review and track corrections, rejection rates, time saved, unsafe suggestion classes and subgroup results without overclaiming from small samples.

### Reuse and new components

Reuse current capability/service tests, Hub auth/queue tests, speech accuracy protocol/template, Firebase rules emulator tests and consultation audit functions. Develop formal threat model, security test matrix, redacted operational telemetry, retention verification, chaos/recovery scenarios, adjudicated clinical corpus and clinical safety case.

### Dependencies, acceptance and deliverables

Depends on stable Phase 1 and Phase 2 flows and Phase 3 draft schema/model for end-to-end clinical validation. Acceptance requires documented least-privilege results, no unauthorized patient/job/result access, tested revocation and offline behavior, documented encrypted storage and deletion, bounded recovery/cost behavior, successful backup restore, signed clinical evaluation with severity 2–4 error dispositions, and clinician acceptance. Deliverables: threat model, remediation log, audit/retention evidence, performance and resilience results, clinical evaluation report, go/no-go risks and response playbooks.

Approval is needed for risk acceptance, evaluation corpus access, retention/security exceptions, provider/data location and clinical release thresholds. Main risks are test data that does not represent hospital use, weak subgroup sample sizes, uncaught authorization differences between offline and cloud paths, and clinically severe errors hidden by averages.

## Phase 5 — complete integration and production deployment

### Objective and expected workflow

Connect existing encounter work with either local or cloud transcription and clinician-reviewed AI drafts:

1. Doctor opens an authorized patient consultation.
2. Doctor starts recording.
3. Host deployment processes with offline Whisper; Firebase-only deployment uses the approved cloud service.
4. A transcript becomes available with job status and source/version information.
5. Doctor reviews and corrects the raw transcript.
6. The approved AI assistant proposes structured SOAP and Plan drafts.
7. Doctor reviews, edits and explicitly approves the proposed documentation.
8. The approved note is saved to the same patient encounter through existing capability-checked service paths.
9. Diagnosis, prescription, laboratory and ordinary EMR workflows remain explicit and unchanged unless separately approved.

### Technical work

Provide one workflow orchestration/state model with adapters for Host and cloud job transports; patient/encounter binding; transcript and draft versions; recovery/resume; duplicate prevention; explicit reviewer approvals; safe save through existing encounter services; and status/error presentation. Add deployment-specific configuration without putting secrets in the web bundle. Prepare final release channels, signed artifacts where available, upgrade/rollback and backup/restore procedures, monitoring, support escalation, user/admin docs and maintenance instructions.

### Reuse and new components

Reuse patient/consultation routes, encounter DTO/service, SOAP/Plan editors, capability enforcement, audit services, Host tray/wizard/installer and Phase 2 job APIs. Develop shared orchestration, end-to-end workflow state, cross-mode integration adapters, production dashboards/alerts, deployment automation, backup/recovery/upgrade tooling and support/runbook documentation.

### Dependencies, security and acceptance

Depends on Phase 1 Host readiness, Phase 2 cloud service approval and reliability, Phase 3 clinical review behavior, and Phase 4 security/clinical go-live evidence. Acceptance: run the complete workflow in both deployment types; confirm Firebase deployment has no Host dependency; confirm local Host transcription works with internet disconnected as designed; verify patient and encounter binding through reload/retry; prove transcript and AI drafts are never silently saved; test all permissions, audit history, upgrade, rollback, backup restore, monitoring and user/admin procedures; complete UAT with representative hospitals and signed go-live criteria.

### Deliverables, risks and approvals

Deliver integrated release candidates, automated test evidence, UAT sign-off, installer/upgrade package, cloud deployment, backup and recovery plan, monitoring and incident alerts, support escalation path, user/admin guides, maintenance calendar and production rollout/rollback plan. Approval required for cloud provider and spend, clinical safety case, retention, release thresholds, hospital pilot cohort, production rollout, and any intended change to current EMR behavior. Risks include mode-specific behavior divergence, wrong encounter linkage, double processing/billing, model/provider outages and incomplete user readiness.

## Dependency order

```text
Phase 1 Host evidence ─────────────┐
                                   ├─> Phase 4 security/reliability runs continuously
Phase 2 cloud provider + jobs ─────┴─> shared transcript contract ─> Phase 3 reviewed drafts
                                                                      │
                                                                      └─> Phase 4 clinical validation
Phase 1 + Phase 2 + Phase 3 + Phase 4 go/no-go evidence ───────────────> Phase 5 production integration
```

Define the provider-neutral job and transcript contract early, but keep provider selection and clinical model choice as approval gates. Security threat modeling, access-policy review, and evaluation-corpus planning should begin before cloud implementation, even though full Phase 4 validation depends on those flows existing.
