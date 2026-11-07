# MedLog NG Application-Wide Bug Audit Report

**Audit date:** 2026-11-07  
**Repository:** `medlogng`  
**Scope:** Reliability audit and smallest-safe bug repair; existing business logic, data structures, permissions, calculations, and workflows were preserved.

## Executive summary

The application was audited across the web frontend, Firebase integration, offline-first services, clinical modules, pharmacy, billing, admissions, laboratory, imaging, reports, administration, Electron desktop code, LAN Host code, and the existing automated test suites.

One confirmed production-impacting defect was found and fixed:

- **High — Electron Host setup wizard could not start:** `electron/wizard.js` contained an orphaned `$('btnTls').onclick = async () => {` opener without a matching body/closure. Node reported `SyntaxError: Unexpected end of input`. The Host setup wizard is not included in the Vite web build, so the normal web build and browser tests did not detect it. The orphaned line was removed without changing the wizard workflow or IPC behavior.

No other application defect was confirmed by the available executable checks. No business logic, database schema, security rule, permission, clinical workflow, financial calculation, or existing data was changed.

## Modules inspected

### Frontend and navigation

- Application bootstrap and route registration in `src/main.js` and `src/router.js`.
- Login, registration, email verification, password change, hospital selection, session persistence, access guards, idle handling, and updater behavior.
- Shared shell/navigation, modal, toast, lifecycle, sanitization, formatting, printing, offline-read, chunk-recovery, and staff-directory utilities.
- Patient list, registration, editing, patient detail/history, appointments, consultations, encounter start, and clinical documentation paths.
- Admissions list, admission creation, admission workspace, discharge/transfer behavior, ward/bed handling, session isolation, clinical plan, laboratory, imaging, medication requests/administration, billing, and discharge printing.
- Laboratory queue, order, result, catalogue, report preview, result images, and print templates.
- Pharmacy catalogue, receiving, requests, dispensing, stock movements, medication administration, and pharmacy reports.
- Billing, invoice details, payments/receipts, printing, reports, administration, and settings/configuration paths.

### Data, backend, and security

- Firebase initialization, Auth, Firestore wrappers, persistent cache, offline write handoff, outbox, pagination, live queries, and fallback reads.
- Patient, encounter, admission, admission-session, laboratory, imaging, pharmacy, billing, payer, ward, staff/admin, and deletion services.
- Firestore rules and indexes were reviewed for organisation scoping, capability checks, append-only ledgers, admission bed claims, and clinical data access.
- Cloud Functions entry points and package configuration.
- LAN Hub routing, authentication, queueing, offline query cache, device sessions, and host seed/session services.

### Desktop and operational delivery

- Electron main process, preload bridge, Host process, setup wizard, updater, tray/status lifecycle, firewall setup, and host packaging configuration.
- Existing E2E, service, smoke, hub, Firestore-rule, and admission-session tests.

## Findings and repairs

| Priority | Finding | Status | Repair |
|---|---|---|---|
| High | Host setup wizard JavaScript had an unmatched handler opener and failed Node syntax validation with `Unexpected end of input`. | Fixed | Removed only the orphaned TLS handler line from `electron/wizard.js`. |
| Medium | Firestore rule tests were skipped when run directly because no emulator was available. | Outstanding test-environment limitation | Emulator attempt was made; this machine has no Java runtime and Firebase CLI authentication is unavailable. No production rule change was made. |
| Medium | Hub emulator smoke test could not execute for the same missing-Java/emulator limitation. | Outstanding test-environment limitation | No Hub production change was made based on an unexecuted test. |
| Low | Node emitted `MODULE_TYPELESS_PACKAGE_JSON` warnings for the test harness. | Not changed | Adding `type: module` globally could affect Electron/CommonJS packaging, so this was not changed during a bug-fix-only audit. |
| Informational | Vite reported expected mixed static/dynamic import chunk warnings. | Not a confirmed defect | Production build completed successfully; no refactor was made. |

## Test execution and actual results

- `npm.cmd run build` — **passed**. Vite transformed 141 modules and produced the production bundle successfully.
- `npm.cmd test` — **passed**. Smoke assertions, pharmacy, request, administration, laboratory/imaging, deletion, billing/printing, printing settings, and admission-session tests all passed. Firestore rules were explicitly skipped by the test because the emulator was not running.
- `npm.cmd run test:e2e` — **passed** with exit code 0; the configured onboarding browser test produced no failure output.
- `npm.cmd run test:hub` — **not executed successfully** because the Firestore emulator was unavailable.
- `node` syntax validation for Electron, Hub, and Functions JavaScript — **passed after repair**: 19 files checked.
- Route target integrity check — **passed**: all 27 lazy view imports referenced by `src/main.js` resolved to existing files.
- Firestore emulator-backed rules test — **not testable in this environment**. Firebase CLI reported that Java could not be spawned and the CLI was unauthenticated.
- Firestore emulator-backed Hub smoke test — **not testable in this environment** for the same reason.

## Files modified by this audit

- `electron/wizard.js` — removed one unmatched handler opener that prevented the Host setup wizard from parsing.
- `APPLICATION_AUDIT_REPORT.md` — this report.

The repository already contained extensive unrelated modified/deleted/untracked files before this audit began. Those changes were not reverted, reformatted, or incorporated into this repair.

## Outstanding items

1. Run `firebase emulators:exec --only firestore ...` on a development machine with Java installed and Firebase CLI authentication/configuration available, then execute both the Firestore rules and Hub smoke tests.
2. Test the packaged Electron Host setup wizard manually on Windows, including key import, firewall prompt, host startup, tray behavior, and LAN access.
3. Review the large pre-existing working-tree change set separately before release; it includes removals and changes outside this audit and cannot safely be attributed to this repair.

## Business-logic preservation confirmation

The repair did not change calculations, clinical or financial workflows, data relationships, Firestore rules, permissions, validation requirements, authentication behavior, database schema, record deletion behavior, or hospital configuration. The only production source change was a syntax-only correction required for the Electron Host setup wizard to load.
