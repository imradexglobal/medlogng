# MediLog NG Offline EMR Audit and Completion Prompt

## Assignment for the implementation agent

Complete and verify MediLog NG so the **whole hospital EMR remains operational when internet access is lost while the hospital LAN and its MediLog host remain available**. Multiple authorized workstations on that LAN must read shared hospital data and safely record work through the host. Treat this as a real internet outage, not merely `navigator.onLine === false`: the workstation may still have LAN connectivity while Firebase/Internet is unreachable.

Start by inspecting the current working tree and the code paths named in this brief. Re-audit the current implementation before changing it. Some workflows already have host-backed offline queues; preserve and extend them instead of building duplicate paths. Implement gaps through completion. Do not call the system “fully offline” if any required workflow is only cached on one browser, queues only to Firebase, or silently fails.

The intended outage scope is **internet unavailable, hospital LAN host available**. First-time setup, initial identity verification and LAN host enrollment may require connectivity before the outage. During an outage, a previously enrolled, authorized staff member must be able to reopen the app, authenticate safely using a valid cached session, and work with the host. Document separately any capability that truly requires an external service (for example password reset email), and ensure it does not prevent clinical work by an already authenticated staff member.

## Audit findings at the time this prompt was written

These are code-level findings to verify against the working tree before implementation; do not assume they remain unchanged.

### Existing foundations to preserve

- Firebase is initialized with persistent browser-side Firestore caching. This helps the same browser but does not by itself give other workstations a shared outage copy.
- The app has a service worker and a LAN host query/read path, encrypted host-side offline query cache, device enrollment/session capabilities, and a durable clinical outbox.
- Specialized host/outbox operations already cover several workflows, including admissions, billing payment posting, medication administration, pharmacy stock receive/dispense/create/correct/update/reversal, prescription mirroring and file uploads. Inspect the actual registered handlers in `src/services/clinicalOutbox.js` and the Hub operation handlers before touching these.
- Patient photos and result-image data have a Hub/file handoff path. Verify that the parent metadata, binary payload, authorization, retry, and reads all work together from a second workstation.
- Generic direct Firestore mutation handoff is limited to an explicit collection allowlist in `src/firebase.js`, while the Hub independently has read and write allowlists/capability checks. These lists and the special operation handlers must remain consistent.

### Confirmed or likely gaps requiring code-path verification

- `src/services/authService.js` has `attemptOfflineLogin()` implemented as an unconditional failure. Existing Firebase browser persistence can restore a session in some cases, but a cold launch or auth-state loss can strand staff. Membership and organization state also need to be available and validated from a previously authorized host/device snapshot.
- `src/services/hostSession.js` requires prior device enrollment and secure-context/HTTPS setup and checks online status during registration. Confirm outage access works after prior enrollment, and fail clearly when prerequisites were never met.
- Firestore `runTransaction` workflows cannot be assumed to work from a queued local SDK write. `patientService` encounter creation uses a transaction for duplicate protection. Medication dose administration has an outbox, but its reversal path also needs review. Audit every transaction and preserve its invariant at the host.
- Invoice creation/update in `src/services/billingService.js` uses direct Firestore writes. `invoices` are readable from the Hub but are not in the generic direct-mutation allowlist. Dedicated payment posting does not make invoice creation, invoice edits, refunds, or all billing operations offline-complete.
- Pharmacy request editing/cancellation and other prescription actions may use direct reads/writes outside the specialized prescription-mirror operation. Check `src/services/pharmacyService.js` and every caller; verify each path against the host handler/capability allowlist.
- The host query cache is populated from supported query shapes and is not automatically a complete database replica. Exact query/filter variants and never-before-loaded records can miss during an outage. Inventory every required screen query and provide a deliberate, permission-scoped synchronization/retention strategy.
- `onSnapshot` subscriptions in `src/services/live.js` use Firestore listeners. Confirm how shared Hub mutations reach active views during cloud outage; service-level `getDocs` fallback alone does not keep listeners current.
- The shell status currently relies substantially on `navigator.onLine`, which cannot distinguish Internet/Firebase loss from LAN availability. Present the actual state (cloud, LAN host, local-only), queue counts and per-operation sync status without claiming cloud connectivity just because a network interface is up.
- Bulk import/export and delete/cascade flows need explicit behavior. Export reads may depend on exact cached queries; imports and multi-document deletes must not become partial or report success before durable host acceptance.
- The local Firestore cache, host offline cache, queued mutation log and service-worker asset cache are separate stores. Define recovery, retention, migrations, integrity and storage-exhaustion behavior for each.

## Required audit and implementation scope

Build a workflow inventory from routes, services, UI actions, Firestore calls/rules, Hub routes, and outbox handlers. Do not audit only the services listed below; search the repository for all `getDoc(s)`, `onSnapshot`, `setDoc`, `updateDoc`, `deleteDoc`, `writeBatch`, and `runTransaction` use and trace each user-facing operation end to end.

Cover at minimum:

1. App shell, code-split chunks, fonts/icons/assets, service-worker install/update/cold start, and reinstall/restart behavior.
2. Identity, cached session, organization selection, membership/role/capability snapshots, device enrollment, secure LAN setup, expiry/revocation, and sign-out behavior.
3. Patient registration, MRN/duplicate checks, demographics, chart reads, merges, photos, documents, consent and attachments.
4. Appointments, check-in and scheduling.
5. Encounters, consultation notes, vitals, allergies, diagnoses, orders, prescriptions, edits/cancellations, and medication administration/reversal.
6. Admissions, plans, ward/bed allocation and claims, transfers, progress, discharge, and bed release.
7. Laboratory catalog/settings, orders, collection, result entry/edit/review/release, result images/files, and corrections.
8. Imaging orders, reports/results and images/files.
9. Pharmacy catalog, requests, stock create/edit/receive/correct/dispense/reverse, stock movement/audit history, and prescription lifecycle.
10. Invoices and line items, price catalog, payment posting, refunds/voids, claims, coverage/plans, receipts and statements.
11. Staff directory, invitations, membership approval/suspension, roles/capabilities, organization settings, and device management. Define safe outage behavior for administrative actions that cannot be validated from a cached authorization snapshot.
12. Dashboards, lists, reports, search, pagination, exports/imports, print/receipts, audit views, and active/real-time views.
13. Delete/cascade actions, retries, duplicate submissions, conflict resolution, outbox inspection, backups, host health, restoration and cloud-recovery sync.

For each operation record: its source UI action; all reads and writes; whether it currently works from Hub, browser-only cache, cloud only, or not at all; the required capability; its durable acknowledgement point; conflict/idempotency behavior; audit trail; and a test that proves it.

## Design and safety requirements

- The hospital LAN host is the shared source of truth during the outage. A workstation-local Firestore cache is a supplementary cache, never evidence that another workstation can see the change.
- Every accepted operation must be durably recorded before the UI confirms it. Distinguish **saved to hospital LAN**, **waiting for cloud sync**, **synced**, and **failed/needs review**. Never show “saved” for a merely attempted or browser-local mutation.
- Use durable, stable operation IDs and idempotent retries. Replaying after a browser, Hub, or power restart must not duplicate patients, encounters, doses, dispensing, payments, admission events or files.
- Implement transactions as validated host operations with server-side authorization, invariant checks, atomic writes and append-only audit events. Do not replace transaction semantics with blind queued field overwrites. Preserve duplicate/MRN rules, dose limits and reversals, stock accounting, payment uniqueness, bed occupancy and transfer/discharge invariants.
- Enforce organization isolation, user/device identity, capability checks, expiry/revocation policy, allowed collection/operation, payload validation and audit logging on the Hub. Never weaken `firestore.rules` or trust client-provided role/capability fields. Audit accepted and rejected operations.
- Handle conflicting concurrent work explicitly. Use versions/expected state, compare-and-set or domain-specific conflict resolution. Return actionable conflicts rather than silently dropping, overwriting or merging clinically meaningful data.
- Treat files as first-class offline data: bounded uploads, durable LAN storage, content type/size validation, stable IDs/checksums, metadata/data atomicity or recoverable staging, authorized retrieval, retries and eventual cloud promotion.
- Make required outage data available before outage through a permission-scoped, bounded host sync/warm-up process. Show freshness and last successful refresh. Define behavior if data is stale or absent; do not fabricate empty lists when a required query was never cached.
- Make host query support derive from the complete screen inventory. Handle pagination, sort/filter variants, joins/secondary lookups and live updates. Avoid reliance on an exact query having happened earlier unless the UI explicitly reports that required copy is unavailable.
- Keep the host's operation journal and cached data recoverable across restart and upgrade. Define backup/restore, retention, schema migration, disk-full and corruption behavior. Do not discard unacknowledged operations.
- Keep external-only actions unavailable with a clear reason while preserving unrelated offline work. Do not block clinical access on password-reset email, analytics, speech services, external payer endpoints or other Internet services.
- Do not claim completion based solely on unit tests or `navigator.onLine` simulation. Exercise a real browser/host setup with Internet blocked and LAN available.

## Acceptance criteria

The task is complete only when all applicable criteria pass and the workflow matrix has no unexplained gaps:

- With the Internet blocked and LAN host reachable, previously enrolled staff can cold-start/reopen the app, resume an authorized session, select the hospital, navigate all clinical modules, read the prepared hospital copy, and complete supported workflows from two or more workstations.
- A write accepted on workstation A is immediately visible from workstation B through the LAN host, including list/detail/active views and attached files. It remains visible after client and Hub restarts.
- Every supported mutation shows its durable LAN acknowledgement and cloud-sync state. Repeated clicks, retry storms, lost responses and restarts produce one domain event and one appropriate audit trail.
- Domain invariants are enforced at the Hub under concurrent requests. Include race tests for patient duplicate registration, dose limits/reversal, stock dispense/correction, payment posting, and bed occupancy/transfer/discharge where applicable.
- Authorization is checked from the trusted enrolled identity plus a valid authorization snapshot and is enforced server-side. Expired/revoked devices and insufficient roles are rejected, including when the client is modified.
- Unsupported/stale reads and disk-full/storage errors are visible and actionable. No empty result or success toast masks missing host data or failed durable writes.
- When Internet returns, queued changes and files promote safely and idempotently to Firestore; cloud conflicts are surfaced for resolution. Cloud recovery must not erase valid LAN records or replay append-only actions twice.
- Service-worker and deployment checks prove the app shell and every route's lazy-loaded assets are available after prior installation with the Internet unavailable.
- Tests cover browser/Hub restart, two clients, no cloud access, transient Hub failure, Hub restart, corrupt/stale authorization, concurrency, retries, file payloads, storage exhaustion, and reconnection.
- Run relevant existing tests, add targeted tests for each fixed gap, run the production build, and run Firestore rules/Hub integration tests. Do not report a rules test as passed if the emulator/dependency is absent or the test was skipped; report the limitation and provide a reproducible command/environment.
- Update operational documentation with the exact supported outage scope, setup/enrollment steps, data warm-up, HTTPS/certificates, host health checks, recovery and backup procedures, known external-only functions, and limitations. Remove any UI copy that overstates connectivity or synchronization.

## Suggested implementation sequence

1. Finish the operation/query/auth inventory and map every route to its dependencies and current offline mechanism.
2. Define a single Hub contract for trusted identity, capability snapshots, operation IDs, acknowledgements, conflicts, audit events, status and recovery. Add schema/versioning as needed.
3. Close access/session and data-warm-up gaps, then close each high-risk transaction workflow with an atomic, validated Hub handler.
4. Complete remaining read/query/live-view behavior, file handling, admin safe behavior, bulk/cascade operations and UI sync reporting.
5. Add outage integration coverage and operational setup/restore documentation. Verify with Internet blocked and multiple LAN clients.
6. Re-run the audit against the completed tree and update the workflow matrix with evidence and any precise remaining external-service limitation.

## Existing code and verification entry points

Start with `src/firebase.js`, `src/services/hostQueryRead.js`, `src/services/hostSession.js`, `src/services/clinicalOutbox.js`, `src/services/offlineFileSync.js`, `src/services/live.js`, `hub/querySpec.js`, `hub/ops.js`, `hub/offlineQueryCache.js`, `firestore.rules`, `vite.config.js`, the service-worker source, and the services named above. Discover the current test scripts from `package.json` and `scripts/test/`; names and coverage may have changed. In particular inspect the existing offline host-route/query, Hub handlers/auth, clinical outbox, pharmacy, file, rules and smoke coverage. Use the repository's actual test commands and report exact results.

## Required deliverables

1. Completed code and tests, with no unrelated working-tree changes reverted.
2. An audit/workflow matrix in the repository documenting each module's outage behavior and the evidence used to call it complete.
3. Updated setup and recovery documentation for hospital operators.
4. A final concise report stating what is proven to work during an Internet outage with LAN host, what remains external-only, test/build results, and any deployment prerequisites. Do not call the whole EMR fully offline until every required acceptance criterion is proven.
