// Throwaway smoke test for the logic changed in this pass. Run: node scripts/smoke.mjs
import assert from 'node:assert/strict'

// ---- router: query string + path params -------------------------------------
const routes = [
  { path: '/patients' },
  { path: '/patients/:id' },
  { path: '/billing' },
  { path: '/billing/:id' },
  { path: '/consultations' },
]

function matchRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/'
  const qi = raw.indexOf('?')
  const path = qi === -1 ? raw : raw.slice(0, qi)
  const query = {}
  if (qi !== -1) new URLSearchParams(raw.slice(qi + 1)).forEach((v, k) => { query[k] = v })
  for (const r of routes) {
    const pattern = '^' + r.path.replace(/:[^/]+/g, '([^/]+)') + '$'
    const m = path.match(new RegExp(pattern))
    if (m) {
      const keys = [...r.path.matchAll(/:([^/]+)/g)].map((x) => x[1])
      const params = {}
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      return { path: r.path, params: { ...params, ...query } }
    }
  }
  return null
}

let r = matchRoute('#/billing')
assert.deepEqual(r, { path: '/billing', params: {} }, 'plain billing')

r = matchRoute('#/billing?patient=abc123&new=1&from=enc&enc=enc_9')
assert.equal(r.path, '/billing', 'query must NOT be treated as an invoice id')
assert.deepEqual(r.params, { patient: 'abc123', new: '1', from: 'enc', enc: 'enc_9' }, 'params parsed')

r = matchRoute('#/patients/pid-77')
assert.equal(r.path, '/patients/:id')
assert.equal(r.params.id, 'pid-77', 'path param still works')

r = matchRoute('#/consultations?enc=enc_42')
assert.equal(r.path, '/consultations')
assert.equal(r.params.enc, 'enc_42', 'back-link from billing restores encounter')

r = matchRoute('#/patients/a?tab=Overview')
assert.equal(r.params.id, 'a', 'path + query merge')
assert.equal(r.params.tab, 'Overview', 'query merged alongside path param')

r = matchRoute('#/patients/a%2Fb')
assert.equal(r.params.id, 'a/b', 'still percent-decoded')

r = matchRoute('#/nope')
assert.equal(r, null, 'unknown route')

// URLSearchParams built by the Bill button must round-trip through the router.
const q = new URLSearchParams({ patient: 'p 1', new: '1', from: 'enc', enc: 'e/1' })
r = matchRoute('#/billing?' + q.toString())
assert.equal(r.params.patient, 'p 1', 'spaces survive')
assert.equal(r.params.enc, 'e/1', 'slashes survive')

// ---- payerService: ordering + fallback merge ---------------------------------
const FALLBACK_PAYERS = [
  { name: 'Self-pay', category: 'self', sort_order: 10 },
  { name: 'NHIA', category: 'government', sort_order: 20 },
  { name: 'HMO · Axa', category: 'hmo', sort_order: 30 },
  { name: 'HMO · Hygeia', category: 'hmo', sort_order: 40 },
]
function fallbackRows() {
  return FALLBACK_PAYERS.map((p) => ({
    id: 'fallback:' + p.name, name: p.name, category: p.category, code: '',
    active: true, sortOrder: p.sort_order, fallback: true,
  }))
}
const byOrder = (a, b) => {
  if (a.active !== b.active) return a.active ? -1 : 1
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.name.localeCompare(b.name)
}

const cloud = [
  { id: 'a', name: 'NHIA', active: true, sortOrder: 20 },
  { id: 'b', name: 'Retired HMO', active: false, sortOrder: 5 },
  { id: 'c', name: 'Corporate · Beta', active: true, sortOrder: 1 },
]
const sorted = cloud.slice().sort(byOrder)
assert.deepEqual(sorted.map((x) => x.id), ['c', 'a', 'b'], 'active first, then sort_order')

// Dropdown must not contain an inactive payer. (listPayers() always returns
// rows already put through byOrder, which is what feeds payerOptions.)
const opts = sorted.filter((x) => x.active !== false).map((x) => ({ value: x.name, label: x.name }))
assert.deepEqual(opts.map((o) => o.value), ['Corporate · Beta', 'NHIA'], 'inactive hidden from dropdown')

// ...but a stored value that is no longer active must survive, or saving an
// unrelated field would silently rewrite the patient's payer.
function payerOptions(rows, current) {
  const o = rows.filter((r) => r.active !== false).map((r) => ({ value: r.name, label: r.name }))
  const cur = String(current || '').trim()
  if (cur && !o.some((x) => x.value === cur)) o.push({ value: cur, label: cur + ' (inactive)' })
  return o
}
let po = payerOptions(cloud, 'Retired HMO')
assert.equal(po.length, 3, 'inactive current value appended')
assert.equal(po[2].value, 'Retired HMO')
assert.equal(po[2].label, 'Retired HMO (inactive)')

po = payerOptions(cloud, 'NHIA')
assert.equal(po.length, 2, 'already-listed value is not duplicated')
assert.equal(po.find((x) => x.value === 'NHIA').label, 'NHIA', 'no "(inactive)" suffix when active')

po = payerOptions(cloud, '')
assert.equal(po.length, 2, 'no current value -> no phantom option')

assert.equal(fallbackRows().length, 4, 'defaults used when collection is empty')
assert.equal(fallbackRows()[0].name, 'Self-pay')
assert.ok(fallbackRows().every((x) => x.fallback), 'defaults are flagged, so the UI can say "built-in"')

// Dedup on save must ignore fallback rows, or promoting a default is impossible.
const rows = fallbackRows()
const dupCheck = (list, name, id) =>
  list.find((x) => !x.fallback && x.name.toLowerCase() === name.toLowerCase() && x.id !== id)
assert.equal(dupCheck(rows, 'NHIA', undefined), undefined, 'fallback must not block promotion')
assert.equal(dupCheck(cloud, 'nhia', undefined)?.id, 'a', 'name match is case-insensitive')
assert.equal(dupCheck(cloud, 'NHIA', 'a'), undefined, 'editing a row does not collide with itself')
assert.equal(dupCheck(cloud, 'NHIA', 'z').id, 'a', 'a genuinely different row still collides')

// ---- encounter status clamp (real module) ------------------------------------
// The clamp and workflow order live in src/features/encounters/domain.js, which
// is deliberately free of Firebase imports so this test exercises the real
// implementation rather than a copy. (Importing src/services/consultationService.js
// here would pull in src/firebase.js, which needs Vite's import.meta.env.)
import { ENCOUNTER_STATUS_FLOW, furtherStatus, stageForTrigger, ENCOUNTER_STATUS_FLOW_META } from '../src/features/encounters/domain.js'

// The flow order itself must be the documented clinical workflow.
assert.deepEqual(ENCOUNTER_STATUS_FLOW, ['arrived', 'vitals-taken', 'in-consultation', 'diagnosed', 'planned', 'closed'], 'workflow order')
assert.equal(ENCOUNTER_STATUS_FLOW.at(-1), 'closed', 'closed is terminal')
assert.equal(ENCOUNTER_STATUS_FLOW_META.length, 6, 'one label/tone per status')
assert.ok(ENCOUNTER_STATUS_FLOW_META.every((s) => s.label && s.step && s.key), 'every status carries label + step')

// A clinical action only ever moves the encounter FORWARD. This is what makes
// re-recording vitals on a diagnosed encounter harmless.
assert.equal(furtherStatus('arrived', 'vitals-taken'), 'vitals-taken', 'vitals advance from arrival')
assert.equal(furtherStatus('vitals-taken', 'in-consultation'), 'in-consultation', 'note advances consultation')
assert.equal(furtherStatus('in-consultation', 'diagnosed'), 'diagnosed', 'diagnosis advances')
assert.equal(furtherStatus('diagnosed', 'planned'), 'planned', 'plan/prescription/lab advance')

assert.equal(furtherStatus('diagnosed', 'vitals-taken'), 'diagnosed', 'never regresses')
assert.equal(furtherStatus('planned', 'diagnosed'), 'planned', 'never steps back a stage')
assert.equal(furtherStatus('closed', 'arrived'), 'closed', 'a closed encounter never reopens')
assert.equal(furtherStatus('closed', 'planned'), 'closed', 'late writes cannot reopen a closed encounter')

// Out-of-order writes jump forward rather than being silently dropped, so a
// diagnosis recorded before any note still marks the encounter diagnosed.
assert.equal(furtherStatus('arrived', 'diagnosed'), 'diagnosed', 'out-of-order write skips forward')

// Legacy/unknown statuses (Patient 360 used to write 'Open', which the service
// rejected) are adopted into the flow instead of dead-ending the encounter.
assert.equal(furtherStatus('Open', 'vitals-taken'), 'vitals-taken', 'unknown current adopts the target')
assert.equal(furtherStatus('', 'vitals-taken'), 'vitals-taken', 'missing status adopts the target')
assert.equal(furtherStatus('', 'nonsense'), '', 'unknown target is a no-op')
assert.equal(furtherStatus('arrived', 'nonsense'), 'arrived', 'unknown target leaves status alone')

// The trigger map must agree with the statuses the service actually advances.
assert.equal(stageForTrigger('note'), 'in-consultation')
assert.equal(stageForTrigger('diagnosis'), 'diagnosed')
assert.equal(stageForTrigger('plan'), 'planned')
assert.equal(stageForTrigger('prescription'), 'planned')
assert.equal(stageForTrigger('lab_order'), 'planned')
assert.equal(stageForTrigger('vitals'), null, 'vitals is triage, handled directly by recordEncounterVitals')
assert.equal(stageForTrigger('billing'), null, 'billing is not part of the clinical workflow')
assert.equal(stageForTrigger(''), null, 'empty trigger is a no-op')

// ---- admission / bed rules (real module) ---------------------------------------
// Normalisation, occupancy and the admission validators live in
// src/features/admissions/domain.js, which is deliberately free of Firebase
// imports so this test exercises the real implementation rather than a copy.
import {
  ADMISSION_ACTIVE, ADMISSION_DISCHARGED, ADMISSION_TYPES,
  tsMillis, admissionStatus, isAdmissionActive, normalizeAdmission,
  occupancySummary, wardOccupancy, occupiedInWard,
  activeAdmissionForPatient, indexAdmissionsByEncounter, activeAdmissionForEncounter,
  validateAdmissionInput, validateDischargeInput, validateWardCapacity,
} from '../src/features/admissions/domain.js'

assert.deepEqual(ADMISSION_TYPES, ['Emergency', 'Elective', 'Transfer', 'Observation'], 'admission types')
assert.equal(ADMISSION_ACTIVE, 'active')
assert.equal(ADMISSION_DISCHARGED, 'discharged')

// Firestore Timestamps, { seconds } and epoch millis all have to survive.
assert.equal(tsMillis({ toMillis: () => 1700000000000 }), 1700000000000, 'Timestamp')
assert.equal(tsMillis({ seconds: 1700000000 }), 1700000000000, 'Firestore seconds shape')
assert.equal(tsMillis(1700000000000), 1700000000000, 'epoch millis')
assert.equal(tsMillis(null), 0, 'missing timestamp is 0')
assert.equal(tsMillis('nope'), 0, 'unparseable timestamp is 0')

// Status vocabulary. An admission only stops holding a bed when explicitly
// discharged — a missing or unknown status must fail towards "still in".
assert.equal(admissionStatus('active'), ADMISSION_ACTIVE)
assert.equal(admissionStatus('Admitted'), ADMISSION_ACTIVE, 'legacy chart status')
assert.equal(admissionStatus('  IN_CONSULTATION '), ADMISSION_ACTIVE, 'unknown status holds the bed')
assert.equal(admissionStatus(undefined), ADMISSION_ACTIVE, 'missing status holds the bed')
assert.equal(admissionStatus('discharged'), ADMISSION_DISCHARGED)
assert.equal(admissionStatus('Deceased'), ADMISSION_DISCHARGED)
assert.equal(isAdmissionActive('closed'), false, 'closed is discharged')
assert.equal(isAdmissionActive(''), true, 'empty is active')

// Both writers are understood: the service schema (ward_name/bed_number/
// attending_provider/active) and the legacy patient-chart schema
// (ward/bed/doctor/'Admitted') that used to make a bed invisible to the board.
const legacy = normalizeAdmission({
  id: 'a1', patient_id: 'p1', patient_name: 'Legacy Patient',
  ward: 'Ward B', bed: 'Bed 4', doctor: 'Dr. N. Eze', reason: 'Observation', status: 'Admitted',
  created_at: 1700000000000,
})
assert.equal(legacy.wardName, 'Ward B', 'legacy ward maps to wardName')
assert.equal(legacy.bedNumber, 'Bed 4', 'legacy bed maps to bedNumber')
assert.equal(legacy.attendingProvider, 'Dr. N. Eze', 'legacy doctor maps to attendingProvider')
assert.equal(legacy.admissionReason, 'Observation', 'legacy reason maps to admissionReason')
assert.equal(legacy.status, ADMISSION_ACTIVE, "legacy 'Admitted' is an active bed")

const canonical = normalizeAdmission({
  id: 'a2', patient_id: 'p1', patient_name: 'Canonical Patient', organization_id: 'org1',
  encounter_id: 'enc_7', ward_name: 'Ward A', bed_number: 'Bed 2',
  attending_provider: 'Dr. A. Balogun', admission_type: 'Emergency', status: 'active',
  created_at: 1700000000000,
})
assert.equal(canonical.encounterId, 'enc_7', 'one-way link to the triggering encounter')
assert.equal(canonical.admissionDate, 1700000000000, 'admission date falls back to created_at')
assert.equal(canonical.organizationId, 'org1')

// ---- occupancy --------------------------------------------------------------
const wards = [
  { name: 'Ward A', totalBeds: 2 },
  { name: 'Ward B', totalBeds: 1 },
  { name: 'Ward C', totalBeds: 0 },
]
const admRows = [legacy, canonical] // both active: Ward B x1, Ward A x1
const occ = wardOccupancy(admRows, wards)
const wardA = occ.find((w) => w.name === 'Ward A')
const wardC = occ.find((w) => w.name === 'Ward C')
assert.equal(wardA.occupied, 1)
assert.equal(wardA.free, 1)
assert.equal(wardA.pct, 50)
assert.equal(wardC.unconfigured, true, 'ward with no bed count is flagged, not 0% full')
assert.equal(occupiedInWard(admRows, 'Ward A'), 1)
assert.equal(occupiedInWard(admRows, 'Ward Z'), 0, 'unknown ward is 0, not a crash')

const sum = occupancySummary(admRows, wards)
assert.equal(sum.active, 2)
assert.equal(sum.discharged, 0)
assert.equal(sum.totalBeds, 3)
assert.equal(sum.free, 1)
assert.equal(sum.occupancyPct, 67)

// A discharged admission frees its bed again.
const afterDischarge = occupancySummary([legacy, { ...canonical, status: 'discharged' }], wards)
assert.equal(afterDischarge.active, 1, 'discharging frees the bed')
assert.equal(afterDischarge.discharged, 1)
assert.equal(afterDischarge.free, 2)

// Over-capacity is reported rather than hidden behind a negative free count.
const stuffed = occupancySummary([...admRows, { ...canonical, id: 'a3', wardName: 'Ward B' }], wards)
const stuffedB = stuffed.wards.find((w) => w.name === 'Ward B')
assert.equal(stuffedB.overCapacity, true, 'over-capacity ward is flagged')
assert.equal(stuffedB.free, 0, 'free beds never go negative')

// Raw (un-normalized) rows are accepted too, so callers cannot get it wrong.
assert.equal(occupancySummary([{ ward_name: 'Ward A', status: 'active' }], wards).active, 1, 'raw rows normalised')

// ---- one bed per patient ----------------------------------------------------
assert.equal(activeAdmissionForPatient(admRows, 'p1').id, 'a1', 'first active bed wins')
assert.equal(activeAdmissionForPatient(admRows, 'p2'), null, 'unknown patient holds nothing')
assert.equal(activeAdmissionForPatient(admRows, ''), null, 'no patient id, no match')

// ---- encounter linkage ------------------------------------------------------
const index = indexAdmissionsByEncounter([canonical, legacy, { ...canonical, id: 'a4', status: 'discharged' }])
assert.equal(index.get('enc_7').length, 2, 'both linked admissions indexed')
assert.equal(index.has(''), false, 'unlinked admissions are not indexed')
assert.equal(activeAdmissionForEncounter(index, 'enc_7').id, 'a2', 'active beat is preferred')
assert.equal(activeAdmissionForEncounter(index, 'enc_9'), null, 'unlinked encounter holds no bed')
assert.equal(activeAdmissionForEncounter(index, ''), null, 'blank encounter id is safe')
assert.equal(activeAdmissionForEncounter(new Map(), 'enc_7'), null, 'empty index is safe')

// ---- admission validation ---------------------------------------------------
// Ward A is a configured 2-bed ward with Bed 2 taken, so Bed 1 is the free bed.
const ok = { patient_id: 'p9', ward_name: 'Ward A', bed_number: 'Bed 1' }
assert.equal(validateAdmissionInput(ok, { wards, admissions: admRows }), null, 'free bed in a configured ward passes')

// A configured ward only owns beds 1..totalBeds — a bed outside that range is
// refused even when the ward has capacity and the slot looks free.
assert.match(
  validateAdmissionInput({ ...ok, bed_number: 'Bed 9' }, { wards, admissions: admRows }),
  /does not exist in Ward A \(beds 1 – 2\)/,
  'an out-of-range bed is refused on a configured ward',
)

assert.match(
  validateAdmissionInput({ ...ok, ward_name: 'Ward B' }, { wards, admissions: admRows }),
  /is full \(1 \/ 1\)/,
  'a full ward is refused'
)
assert.match(
  validateAdmissionInput({ ...ok, ward_name: 'Ward A', bed_number: 'Bed 2' }, { wards, admissions: admRows }),
  /already occupied by Canonical Patient/,
  'a double-booked bed is refused even when the ward has capacity'
)
assert.match(
  validateAdmissionInput({ patient_id: 'p1', ward_name: 'Ward A', bed_number: 'Bed 9' }, { wards, admissions: admRows }),
  /already holds a bed/,
  'one bed per patient'
)
// A discharged admission no longer blocks the patient. Both of p1's beds must be
// discharged — one active bed is enough to refuse.
assert.equal(
  validateAdmissionInput({ patient_id: 'p1', ward_name: 'Ward A', bed_number: 'Bed 9' },
    { wards, admissions: [legacy, { ...canonical, status: 'discharged' }] }),
  'This patient already holds a bed — Ward B · Bed 4. Discharge or transfer them first.',
  'the remaining active bed still blocks'
)
assert.equal(
  validateAdmissionInput({ patient_id: 'p1', ward_name: 'Ward A', bed_number: 'Bed 1' },
    { wards, admissions: [{ ...legacy, status: 'discharged' }, { ...canonical, status: 'discharged' }] }),
  null,
  'a discharged patient can be re-admitted'
)
// No ward master yet: nothing to check against, so it is allowed through.
assert.equal(
  validateAdmissionInput({ patient_id: 'p9', ward_name: 'Brand New Ward', bed_number: 'Bed 1' }, { wards, admissions: admRows }),
  null,
  'unknown ward is allowed when there is no ward master'
)

assert.equal(validateAdmissionInput({ ward_name: 'Ward A', bed_number: 'Bed 1' }, { wards, admissions: admRows }), 'Patient is required.')
assert.equal(validateAdmissionInput({ patient_id: 'p9', bed_number: 'Bed 1' }, { wards, admissions: admRows }), 'Ward is required.')
assert.equal(validateAdmissionInput({ patient_id: 'p9', ward_name: 'Ward A' }, { wards, admissions: admRows }), 'Bed is required.')
assert.equal(
  validateAdmissionInput({ ...ok, patient_id: 'p1', bed_number: 'Bed 2' }, { wards, admissions: [] }),
  null,
  'p1 holds nothing when the ward has no admissions yet'
)

// Linking an encounter to a different patient must be refused, or the bed would
// be filed under someone else's clinical story.
assert.equal(
  validateAdmissionInput({ ...ok, encounter_id: 'enc_7' }, { wards, admissions: admRows, encounter: { patientId: 'p1' } }),
  'That encounter belongs to a different patient.',
)
assert.equal(
  validateAdmissionInput({ ...ok, encounter_id: 'enc_7' }, { wards, admissions: admRows, encounter: { patientId: 'p9' } }),
  null,
  'same patient links cleanly'
)

assert.equal(validateDischargeInput({ reason: 'Recovered' }), null)
assert.equal(validateDischargeInput({ reason: '  ' }), 'Discharge reason is required.')
assert.equal(validateDischargeInput({}), 'Discharge reason is required.')

// Capacity equal to the current occupancy is fine; only *below* it is refused.
assert.equal(validateWardCapacity(1, admRows, 'Ward A'), null, 'capacity may equal occupancy')
assert.equal(validateWardCapacity(3, admRows, 'Ward A'), null, 'capacity may rise')
assert.equal(validateWardCapacity(0, admRows, 'Ward A'), 'Total beds must be at least 1.')
assert.equal(validateWardCapacity('abc', admRows, 'Ward A'), 'Total beds must be at least 1.')
// Two patients in Ward A, so a one-bed capacity would strand someone.
const twoInA = [...admRows, { ...canonical, id: 'a5', bedNumber: 'Bed 8' }]
assert.equal(occupiedInWard(twoInA, 'Ward A'), 2, 'Ward A holds two')
assert.equal(validateWardCapacity(1, twoInA, 'Ward A'), 'Cannot set below current occupancy (2).')

// ---- security rules + indexes (regression guards) ----------------------------
// Firestore cannot express "authorize against the org that OWNS the doc" by
// accident, so guard the two ways this has gone wrong before:
//
//   1. An update authorized on request.resource.data.organization_id lets any
//      caller who holds the capability SOMEWHERE rewrite a doc owned by a
//      DIFFERENT org and re-file it into their own. The beds module must pin
//      organization_id instead.
//   2. Composite indexes cost a write on every document change, so an index on
//      a field no writer ever sets is pure waste.
import fs from 'node:fs'

const rulesSrc = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
const indexesSrc = fs.readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')

function matchBlock(name) {
  // Match blocks close with `}` on its own line (column 0) — the style used
  // throughout firestore.rules. The non-greedy capture stops at the first
  // such closer, which is always the block's own closing brace.
  const m = rulesSrc.match(new RegExp('match\\s+/' + name + '/\\{[^}]*\\}\\s*\\{([\\s\\S]*?)\\n\\}', 'm'))
  assert.ok(m, 'firestore.rules has a match block for ' + name)
  return m[1]
}

// admissions + wards are the two Firestore collections behind the beds module
// (bed totals live on the ward doc; there are no `beds`/`rooms` collections).
for (const coll of ['admissions', 'wards']) {
  const block = matchBlock(coll)
  const update = block.match(/allow update:[^;]+;/)
  assert.ok(update, coll + ' has an explicit update rule')
  assert.ok(
    /resource\.data\.organization_id\s*==\s*request\.resource\.data\.organization_id/.test(update[0]),
    coll + ' update must PIN organization_id (found: ' + update[0].trim() + ')'
  )
  assert.ok(
    !/hasCap\(\s*request\.resource\.data\.organization_id/.test(update[0]),
    coll + ' update must not authorize against the org being written to'
  )
}

// Admissions may only be removed AFTER discharge and only by a holder of
// data.delete in the hospital that owns the admission (deleteService enforces
// the discharge-first order; the rule pins ownership via resource.data).
assert.ok(
  /allow delete: if canDelete\(resource\.data\.organization_id\);/.test(matchBlock('admissions')),
  'admissions delete must be org-pinned canDelete',
)

// The `data.delete` gate: collections that carry clinical/billing records
// delete only through canDelete(resource.data.organization_id) — ownership
// always comes from the stored doc, so a client can never re-point it.
for (const coll of [
  'patients', 'organization_patients', 'encounters', 'vitals', 'allergies',
  'diagnoses', 'clinical_notes', 'medication_requests', 'lab_orders',
  'lab_test_catalogue', 'imaging_orders', 'appointments', 'invoices',
  'stock_lots', 'documents',
]) {
  assert.ok(
    /allow delete: if canDelete\(resource\.data\.organization_id\);/.test(matchBlock(coll)),
    coll + ' delete must be gated by org-pinned canDelete (data.delete)',
  )
}

// Append-only ledgers are NEVER deletable — money, doses, stock movement and
// the audit trail are the hospital's permanent record. (`stock_movements`
// writes its clause as `allow update, delete: if false;`.)
for (const coll of ['payments', 'dispensations', 'stock_movements', 'audit_events', 'result_images']) {
  const block = matchBlock(coll)
  assert.ok(
    /allow (?:delete|update, delete): if false;/.test(block),
    coll + ' is an append-only ledger and must never be deletable',
  )
}

// Admissions queries need: org + the one-way encounter link, plus org +
// created_at for the server-paginated list (see admissionService
// listOrgAdmissionsPage). `admitDateTime` was indexed but no writer ever set it.
const admIndexes = JSON.parse(indexesSrc).indexes.filter((i) => i.collectionGroup === 'admissions')
const admPaths = admIndexes.map((i) => i.fields.map((f) => f.fieldPath).join('+'))
assert.ok(
  admPaths.includes('organization_id+encounter_id'),
  'admissions index must serve the org + encounter_id lookup',
)
assert.ok(
  admPaths.includes('organization_id+created_at'),
  'admissions index must serve the org + created_at paginated list',
)
assert.ok(!indexesSrc.includes('admitDateTime'), 'no index may reference the never-written admitDateTime')

// ---- patient search (real module) ---------------------------------------------
// Query parsing and phone/name matching live in src/features/patients/search.js,
// which is deliberately free of Firebase imports so this test exercises the real
// implementation rather than a copy.
import {
  MIN_PHONE_DIGITS, normalizePhone, phoneKey, phoneSearchDigits, phoneMatches,
  parseSearchTerm, patientHaystack, matchesPatient,
} from '../src/features/patients/search.js'

// A registered patient, exactly as toPatientRow shapes it.
const ada = {
  pid: 'pidAda0001', mrn: 'IMR-PIDADA', name: 'Okoro Ada', surname: 'Okoro',
  given_names: 'Ada', sex: 'F', dob: '1990-04-02',
  phone: '+2348031234567', phone_key: '8031234567',
}
const eve = {
  pid: 'pidEve00002', mrn: 'IMR-PIDEVE00', name: 'Ada Eve', surname: 'Eve',
  given_names: 'Ada Chidinma', sex: 'F', dob: '',
  phone: '+2348039999999', phone_key: '8039999999',
}

// ---- the phone regression: searching by mobile number found nothing ----------
// The registry used to feed '08031234567' to the SURNAME matcher, so a number
// that existed returned zero rows. It must be recognised as a phone search.
let p = parseSearchTerm('08031234567')
assert.equal(p.isPhone, true, 'a full local number is a phone search, not a surname')
assert.equal(p.surname, '', 'a phone search must not be parsed as a name')
assert.equal(p.phoneDigits, '8031234567', 'trunk zero stripped')
assert.equal(matchesPatient(ada, p), true, 'searching by mobile finds the registered patient')
assert.equal(matchesPatient(eve, p), false, 'and only that patient')

// Every way a clerk can type the same number resolves to the same record.
for (const typed of ['08031234567', '0803 123 4567', '0803-123-4567', '+2348031234567',
  '+234 803 123 4567', '2348031234567', '8031234567', '803 123 4567', '  08031234567  ']) {
  assert.equal(matchesPatient(ada, typed), true, '"' + typed + '" must find the patient')
}
assert.equal(matchesPatient(ada, '08031234568'), false, 'a different number must not match')
assert.equal(matchesPatient(ada, '07031234567'), false, 'another network must not match')

// Partial numbers work. Exact-only matching meant retyping all 11 digits.
assert.equal(matchesPatient(ada, '8031'), true, 'leading digits find the patient')
assert.equal(matchesPatient(ada, '34567'), true, 'trailing digits find the patient')
assert.equal(matchesPatient(ada, '8032'), false, 'digits belonging to nobody match nobody')
assert.equal(matchesPatient(eve, '8031'), false, 'partials do not leak across patients')

// A number typed with the country code must still hit the 10-digit key.
assert.equal(phoneMatches(ada, '+234 803 123 4567'), true)
assert.equal(phoneMatches(ada, '08031234567'), true)

// Records written before phone_key existed are still findable by phone.
assert.equal(phoneMatches({ phone: '+2348031234567' }, '8031234567'), true, 'phone fallback')
assert.equal(phoneMatches({ phone_key: '8031234567' }, '08031234567'), true, 'key is enough')
assert.equal(phoneMatches({}, '8031234567'), false, 'a patient with no phone does not match')
assert.equal(phoneMatches(ada, ''), true, 'an empty phone query is not a filter')

// Too few digits is not a phone search — it is still a name/ID search.
assert.equal(parseSearchTerm('803').isPhone, false, '3 digits is not a mobile number')
assert.ok(MIN_PHONE_DIGITS >= 4, 'the threshold cannot drop below 4')

// An ID or MRN contains letters, so it can never be mistaken for a number.
p = parseSearchTerm('IMR-PIDADA')
assert.equal(p.isPhone, false, 'an MRN is a text search')
assert.equal(matchesPatient(ada, p), true, 'MRN search works')

p = parseSearchTerm('pidAda0001')
assert.equal(p.isPhone, false, 'a patient ID is a text search')
assert.equal(matchesPatient(ada, p), true, 'patient ID search works')

// ---- name search -------------------------------------------------------------
assert.equal(matchesPatient(ada, 'okoro'), true, 'surname matches')
assert.equal(matchesPatient(ada, 'OKORO'), true, 'surname match is case-insensitive')
assert.equal(matchesPatient(ada, 'ada'), true, 'given name matches')
assert.equal(matchesPatient(ada, 'Ada Okoro'), true, 'given + surname in either order')
assert.equal(matchesPatient(ada, 'okoro ada'), true, 'surname + given')
assert.equal(matchesPatient(eve, 'Ada'), true, 'given name finds the other patient too')
assert.equal(matchesPatient(eve, 'Ada Okoro'), false, 'a name from another patient does not match')

// Whitespace must not break the parse.
assert.equal(matchesPatient(ada, '  Okoro   Ada  '), true, 'extra spaces tolerated')
assert.equal(matchesPatient(ada, 'Ada\tOkoro'), true, 'tab-separated name tolerated')

// ---- empty query -------------------------------------------------------------
assert.deepEqual(parseSearchTerm(''), { term: '', text: '', surname: '', given_names: '', phoneDigits: '', isPhone: false })
assert.equal(parseSearchTerm('   ').term, '', 'whitespace is an empty query')
assert.equal(matchesPatient(ada, ''), true, 'an empty query matches everything')
assert.equal(matchesPatient(ada, null), true, 'a null query matches everything')
assert.equal(matchesPatient(ada, undefined), true, 'an undefined query matches everything')

// ---- strict phone validation is unchanged -------------------------------------
// normalizePhone still REJECTS a partial number — only search is lenient, so a
// half-typed number can never be saved as a patient's contact.
assert.equal(normalizePhone('08031234567'), '08031234567')
assert.equal(normalizePhone('+234 803 123 4567'), '08031234567')
assert.equal(normalizePhone('8031234567'), '08031234567', 'bare 10 digits get a trunk zero')
assert.equal(normalizePhone('803123'), '', 'a partial number is not a valid phone')
assert.equal(normalizePhone('12345'), '')
assert.equal(normalizePhone(''), '')
assert.equal(normalizePhone(null), '')
assert.equal(phoneKey('+2348031234567'), '8031234567', 'key drops the trunk zero')
assert.equal(phoneKey('nonsense'), '')
assert.equal(phoneSearchDigits('+234 803 123 4567'), '8031234567')
assert.equal(phoneSearchDigits('08031234567'), '8031234567')
// Normalising twice must be a no-op — phoneMatches re-normalises the digits
// that parseSearchTerm already normalised.
const once = phoneSearchDigits('+234 803 123 4567')
assert.equal(phoneSearchDigits(once), once, 'phoneSearchDigits is idempotent')
assert.equal(matchesPatient(ada, phoneSearchDigits('+234 803 123 4567')), true, 'pre-normalised query still matches')

// '234' is a real Nigerian mobile prefix, so a bare 10-digit number starting 234
// must not be mistaken for the country code — in validation or in search.
assert.equal(normalizePhone('2345678901'), '02345678901', 'local 234 prefix is not a country code')
assert.equal(phoneSearchDigits('2345678901'), '2345678901', 'same in search')
assert.equal(phoneKey('2345678901'), '2345678901')
assert.equal(normalizePhone('+2342345678901'), '02345678901', 'country code still stripped when present')
assert.equal(matchesPatient({ phone_key: '2345678901' }, '02345678901'), true, 'a 234-prefixed number is findable')

// ---- the search box must actually route a number to the phone matcher --------
// Regression guard on the wiring, not just the rule: PatientsView used to call
// searchPatientsGlobally(name, givenNames, '') with a hard-coded empty phone
// argument, so every mobile search was downgraded to a surname search.
const patientsViewSrc = fs.readFileSync(new URL('../src/views/PatientsView.js', import.meta.url), 'utf8')
const searchCall = patientsViewSrc.match(/searchPatientsGlobally\(([^)]*)\)/)
assert.ok(searchCall, 'PatientsView calls the global registry search')
assert.ok(!searchCall[1].includes("''"), 'PatientsView must pass the parsed query through, not an empty phone')
assert.ok(/parseSearchTerm/.test(patientsViewSrc), 'PatientsView parses the term before searching')
// One registry read per keystroke is a full collection scan; debounce it.
assert.ok(/setTimeout\(runSearch/.test(patientsViewSrc), 'the registry search is debounced')

// Every patient picker must be reachable by mobile number too. A <select> cannot
// be typed into, so a clerk who only knows the number had no way in at all.
// LaboratoryView dropped its patient <select> entirely — orders are filtered by
// a free-text search that joins through matchesPatient (phone-key aware), which
// covers the same clerk need without a picker.
for (const view of ['AppointmentsView', 'BillingView', 'AdmissionsView']) {
  const url = ['.js', '.jsx']
    .map((ext) => new URL('../src/views/' + view + ext, import.meta.url))
    .find((u) => fs.existsSync(u))
  assert.ok(url, view + ' view source exists (.js or .jsx)')
  const src = fs.readFileSync(url, 'utf8')
  const opts = src.match(/const patientOpts =[\s\S]*?\n    \}/)
  assert.ok(opts, view + ' builds a patient option list')
  assert.ok(/formatPhone/.test(opts[0]), view + ' patient options carry the mobile number')
  // Filterable by typing: either the shell's `searchable` select, a bespoke
  // type-ahead (BillingView) that joins through matchesPatient, or the shell's
  // wireSearchableSelect filter-box + select pair.
  const filterable = /searchable:/.test(src) ||
    (/matchesPatient\(/.test(src) && /invPatientSearch|patient-dropdown/.test(src)) ||
    /wireSearchableSelect\(/.test(src)
  assert.ok(filterable, view + ' patient picker is filterable')
}
{
  const labSrc = fs.readFileSync(new URL('../src/views/LaboratoryView.js', import.meta.url), 'utf8')
  assert.ok(/matchesPatient/.test(labSrc), 'LaboratoryView search joins through matchesPatient (mobile reachable)')
}

// Encounters are started through ONE full-page form (#/encounters/new,
// StartEncounterView) that every entry point navigates to — no per-view
// modal/pop-up forms, and the page is deliberately not a nav entry.
{
  const page = fs.readFileSync(new URL('../src/views/StartEncounterView.js', import.meta.url), 'utf8')
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(/registerRoute\('\/encounters\/new'/.test(main), 'Start-encounter page is routed')
  assert.ok(/createEncounter\(/.test(page), 'the page creates the encounter')
  assert.ok(!/formModal\(/.test(page), 'the page renders its own form, not a modal popup')
  for (const view of ['ConsultationsView', 'PatientsView', 'PatientDetailView']) {
    const src = fs.readFileSync(new URL('../src/views/' + view + '.js', import.meta.url), 'utf8')
    assert.ok(/encounters\/new/.test(src), view + ' navigates to the shared Start-encounter page')
    assert.ok(!/createEncounter\(/.test(src), view + ' does not create encounters itself')
    assert.ok(!/createPatientDoc\('encounters'/.test(src), view + ' does not write encounters with legacy field names')
  }
}

// The filter must be digit-aware, or '+234 803 123 4567' is unreachable by
// typing '0803…' — the exact string a Nigerian clerk would type.
const shellSrc = fs.readFileSync(new URL('../src/components/shell.js', import.meta.url), 'utf8')
assert.ok(/data-filter-for/.test(shellSrc), 'formModal renders a filter box for searchable selects')
assert.ok(/replace\(\/\\D\/g, ''\)\.includes\(digits\)/.test(shellSrc), 'the filter matches on digits')

// ---- haystack ----------------------------------------------------------------
assert.ok(patientHaystack(ada).includes('+2348031234567'), 'the stored phone is searchable')
assert.ok(patientHaystack(ada).includes('8031234567'), 'the phone key is searchable')
assert.ok(patientHaystack(ada).includes('imr-pidada'), 'the MRN is searchable in the haystack')
assert.equal(patientHaystack(null), '', 'a missing row has no haystack, not a crash')

// ---- bulk data schema (real module) -------------------------------------------
// The admin SQLite <-> Firestore mapping lives in src/features/data/schema.js,
// which is deliberately free of Firebase imports so it is unit-testable here.
import {
  IMPORT_ORDER_TABLES, TABLE_BY_TABLE, TABLE_BY_COLLECTION,
  buildCreateTableSql, REFERENCE_TABLE_DDL, META_TABLE_DDL,
  rowToDoc, docToRow, validateRow, tsColumns, hasColumn, fkTargets, tsToIso,
} from '../src/features/data/schema.js'

const patients = TABLE_BY_TABLE.patients
const orgPats = TABLE_BY_TABLE.organization_patients

assert.equal(IMPORT_ORDER_TABLES.length, 22, 'registry covers clinical + operational + org config')
assert.equal(Object.keys(TABLE_BY_TABLE).length, 22, 'every table is indexable by name')
assert.equal(TABLE_BY_COLLECTION.encounters.collection, 'encounters', 'collection index round-trips')
assert.ok(orgPats.orgKeyed, 'organization_patients is org-keyed')
assert.ok(orgPats.derived, 'organization_patients is derived from patients')

// Firestore rules require `status` on several collections; if a table lists it
// as a rules-required field, the importer must default it or imports fail.
for (const entry of IMPORT_ORDER_TABLES) {
  if ((entry.rulesRequired || []).includes('status')) {
    assert.ok(entry.defaultStatus, entry.table + ' must default status (rules require it)')
  }
}

// Child tables must reference parents that actually exist in the registry.
for (const entry of IMPORT_ORDER_TABLES) {
  for (const fk of fkTargets(entry)) {
    assert.ok(TABLE_BY_TABLE[fk.table], entry.table + '.' + fk.column + ' FK targets a registered table: ' + fk.table)
    assert.ok(hasColumn(TABLE_BY_TABLE[fk.table], fk.col), fk.table + ' has the FK column ' + fk.col)
  }
}

// ---- SQL DDL ---------------------------------------------------------------
const patientsDdl = buildCreateTableSql(patients)
assert.match(patientsDdl, /"id" TEXT NOT NULL PRIMARY KEY/, 'patients table has a text primary key')
assert.ok(!/PRIMARY KEY \("id"\)/.test(patientsDdl), 'the primary key is declared inline on id, not repeated as a table constraint')
assert.ok(!/"id" TEXT NOT NULL(?! PRIMARY KEY)/.test(patientsDdl), 'id is declared once, as the primary key')
const encDdl = buildCreateTableSql(TABLE_BY_TABLE.encounters)
assert.match(encDdl, /FOREIGN KEY \("patient_id"\) REFERENCES "patients"\("id"\)/, 'encounter FK to patients')
assert.match(encDdl, /"vitals" TEXT/, 'json columns stored as TEXT')
assert.match(encDdl, /"patient_id" TEXT/, 'text columns are TEXT')
assert.match(REFERENCE_TABLE_DDL, /"references" TEXT/, 'schema_reference table is DDL-safe')
assert.match(META_TABLE_DDL, /PRIMARY KEY/, '__meta key/value table')

// ---- row -> doc coercion -----------------------------------------------------
const vitals = TABLE_BY_TABLE.vitals
const row = {
  id: 'v1', patient_id: 'p1', encounter_id: 'e1',
  bp_systolic: '120', bp_diastolic: 80, pulse: '72', temp_c: '36.7', spo2: '98',
  note: 'stable',
  created_by: 'u1', created_at: '2024-01-02T03:04:05.000Z', updated_at: '',
}
const doc = rowToDoc(vitals, row)
assert.equal(doc.bp_systolic, 120, 'int coercion from text')
assert.equal(doc.bp_diastolic, 80, 'int coercion from number')
assert.equal(doc.temp_c, 36.7, 'real coercion')
assert.equal(doc.created_at, '2024-01-02T03:04:05.000Z', 'ts stays an ISO string in the outbox')
assert.equal(doc.updated_at, '', 'blank ts is blank, dropped later')

// bool / json coercion on patients.
const payer = TABLE_BY_TABLE.payers
const payerDoc = rowToDoc(payer, { id: 'py1', name: 'NHIA', category: 'nhia', sort_order: '20', active: 1, code: '' })
assert.equal(payerDoc.active, true, 'bool from 1')
assert.equal(payerDoc.sort_order, 20, 'int from text')
const pRow = { id: 'p1', surname: 'Okoro', given_names: 'Ada', allergy: '["penicillin"]', status: 'active', created_by: '', created_at: '', updated_at: '' }
const pDoc = rowToDoc(TABLE_BY_TABLE.patients, pRow)
assert.deepEqual(pDoc.allergy, ['penicillin'], 'json text parses to array')
assert.ok(hasColumn(TABLE_BY_TABLE.patients, 'updated_at'), 'patients keep updated_at')

// ---- doc -> row (export) -----------------------------------------------------
const tsLike = { toMillis: () => 1700000000000 }
const docBack = {
  id: 'enc1', patient_id: 'p1', patient_name: 'Ada Okoro', appointment_id: '', status: 'closed',
  type: 'General', clinician: 'Dr B', chief_complaint: 'Fever', vitals: { BP: '120/80' },
  diagnoses: [{ condition: 'Malaria' }], diagnosis: '', treatment_plan: '', prescription: {}, lab_orders: [],
  created_by: 'u1', created_by_name: 'Dr B', created_at: tsLike, updated_at: null,
}
const encRow = docToRow(TABLE_BY_TABLE.encounters, docBack)
assert.deepEqual(JSON.parse(encRow.vitals), { BP: '120/80' }, 'json object stringified to text')
assert.deepEqual(JSON.parse(encRow.diagnoses), [{ condition: 'Malaria' }], 'array stringified to text')
assert.equal(encRow.created_at, '2023-11-14T22:13:20.000Z', 'Timestamp -> ISO via tsToIso')
assert.equal(tsToIso('2024-05-06T07:08:09.000Z'), '2024-05-06T07:08:09.000Z', 'ISO string passes through')
assert.equal(tsToIso('nonsense'), 'nonsense', 'unparseable ts preserved, never silently dropped')
assert.equal(tsToIso(1700000000000), '2023-11-14T22:13:20.000Z', 'epoch millis -> ISO')
assert.equal(encRow.updated_at, '', 'missing ts exported as blank, not a broken value')

// ---- validation --------------------------------------------------------------
assert.equal(validateRow(TABLE_BY_TABLE.patients, { ...pDoc, patient_id: undefined }), null, 'patients do not require patient_id')
assert.equal(validateRow(TABLE_BY_TABLE.patients, { ...pDoc, surname: '' }), 'Missing required field "surname"', 'surname is a rules requirement')
assert.equal(validateRow(TABLE_BY_TABLE.payments, { invoice_id: 'inv1', amount_kobo: '0' }), 'amount_kobo must be a positive integer (Security Rules)', 'zero payment refused')
assert.equal(validateRow(TABLE_BY_TABLE.payments, { invoice_id: 'inv1', amount_kobo: 500 }), null, 'valid payment passes')
const ward = { name: 'Ward A' }
assert.equal(validateRow(TABLE_BY_TABLE.wards, { ...ward, total_beds: 0 }), 'total_beds must be at least 1', 'beds floor of 1')
assert.equal(validateRow(TABLE_BY_TABLE.wards, { ...ward, total_beds: 5 }), null, 'valid ward passes')

// ---- bulk queue status summary (pure) ---------------------------------------
import { QUEUE_STATUSES, summarize } from '../src/services/bulkQueue.js'
assert.deepEqual(QUEUE_STATUSES, ['queued', 'sending', 'written', 'synced', 'error'], 'full state machine')
const qsum = summarize([
  { table: 'patients', status: 'queued' },
  { table: 'patients', status: 'queued' },
  { table: 'patients', status: 'synced' },
  { table: 'payers', status: 'error' },
  { table: 'encounters', status: 'written' },
  { table: 'encounters', status: 'written' },
])
assert.equal(qsum.length, 3, 'per-table rollup')
const pats = qsum.find((t) => t.table === 'patients')
assert.deepEqual([pats.total, pats.queued, pats.synced], [3, 2, 1], 'per-table counts roll up')
assert.ok(qsum.sort((a, b) => a.table.localeCompare(b.table)).every((t, i, arr) => i === 0 || arr[i - 1].table <= t.table), 'summarize sorts by table')

// Auto-written mirror rows are counted so the upload-status table can fold them
// under the table they mirror instead of showing a confusing second table.
const qsumAuto = summarize([
  { table: 'patients', status: 'queued' },
  { table: 'organization_patients', status: 'queued', auto: true },
  { table: 'organization_patients', status: 'queued', auto: true },
])
assert.equal(qsumAuto.find((t) => t.table === 'organization_patients').auto, 2, 'auto-mirror rows are counted per table')
assert.equal(qsumAuto.find((t) => t.table === 'patients').auto, 0, 'normal rows are not auto')

// ---- review the wiring of the admin tab (no stale audit filter enum) --------
const adminViewSrc = fs.readFileSync(new URL('../src/views/AdminView.js', import.meta.url), 'utf8')
assert.ok(adminViewSrc.includes("'Data import / export'"), 'admin nav includes the data tab')
assert.ok(/import \{[\s\S]*bulkDataService/.test(adminViewSrc), 'AdminView wires the bulk service')
assert.ok(/stageImport|generateTemplate|exportToDatabase/.test(adminViewSrc), 'template + export + stage are all called')
assert.ok(/setInterval\(refreshStatus, 1000\)/.test(adminViewSrc), 'live upload-status polling is wired')
assert.ok(/waitForPendingWrites|flushPending/.test(adminViewSrc), 'cloud-sync status is surfaced')

// ---- inactivity auto-logout (real module) --------------------------------------
// Closing the app must NOT end the session (Firebase local persistence keeps
// the user signed in); 20 minutes without a single interaction must. The
// rules are pure in src/features/session/idle.js; the localStorage + DOM
// wiring lives in src/services/idleService.js.
import { IDLE_TIMEOUT_MS, idleElapsed, isIdleExpired } from '../src/features/session/idle.js'

assert.equal(IDLE_TIMEOUT_MS, 20 * 60 * 1000, '20 minutes of inactivity ends the session')
const t0 = 1700000000000
assert.equal(isIdleExpired(t0, t0), false, 'fresh activity is never expired')
assert.equal(isIdleExpired(t0 + IDLE_TIMEOUT_MS - 1, t0), false, '19:59 is still active')
assert.equal(isIdleExpired(t0 + IDLE_TIMEOUT_MS, t0), true, 'exactly 20 minutes expires')
assert.equal(isIdleExpired(t0 + 45 * 60 * 1000, t0), true, 'a tab left open for 45 min expires')
assert.equal(idleElapsed(t0, 0), 0, 'no stamp counts as just-started')
assert.equal(isIdleExpired(t0, 0), false, 'a missing stamp must not sign out a live session')
assert.equal(idleElapsed(t0, t0 + 60 * 1000), 0, 'a future stamp (clock skew) is clamped')
assert.equal(isIdleExpired(t0, t0 + 60 * 1000), false, 'clock skew cannot expire a session')

const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
assert.ok(/startIdleWatch\(\)/.test(mainSrc), 'main.js boots the inactivity watcher')

const idleSrc = fs.readFileSync(new URL('../src/services/idleService.js', import.meta.url), 'utf8')
for (const ev of ['mousedown', 'keydown', 'wheel', 'touchstart']) {
  assert.ok(idleSrc.includes("'" + ev + "'"), 'interaction listener: ' + ev)
}
// Relaunching the app is not interaction. A stamp on focus/visibilitychange
// would reset the clock every time the app is reopened, so a device left in a
// drawer for hours would still be "active".
const eventsLine = idleSrc.match(/const ACTIVITY_EVENTS = \[[^\]]*\]/)[0]
assert.ok(!/focus|visibilitychange/.test(eventsLine), 'focus/visibility must not count as activity')
assert.ok(idleSrc.includes('visibilitychange'), 'returning to a hidden tab re-checks the clock')
assert.ok(/localStorage/.test(idleSrc), 'the stamp lives in localStorage, so a closed app keeps timing')
assert.ok(/authStateReady/.test(idleSrc), 'the first check waits for the persisted session to be restored')
assert.ok(/forceLogout/.test(idleSrc), 'expiry signs the user out through the shared forced-logout path')
assert.ok(/clearStamp/.test(idleSrc), 'expiry clears the stamp')

// ---- forgot password (email reset) ---------------------------------------------
// The login screen used to answer "Forgot password?" with "coming soon" and
// send the user to their admin. It now mails a Firebase reset link.
const loginSrc = fs.readFileSync(new URL('../src/views/LoginView.js', import.meta.url), 'utf8')
assert.ok(/requestPasswordReset/.test(loginSrc), 'LoginView requests the reset email')
assert.ok(!/coming soon/.test(loginSrc), 'the "reset is coming soon" stub is gone')
assert.ok(/id="resetFields"/.test(loginSrc), 'the reset form is its own inline pane')
assert.ok(/id="rem"/.test(loginSrc), 'the reset form collects the address')
assert.ok(/id="backLogin"/.test(loginSrc), 'the user can get back to the login form')
assert.ok(/markActivity/.test(loginSrc), 'signing in restarts the inactivity clock')

const authSrc = fs.readFileSync(new URL('../src/services/authService.js', import.meta.url), 'utf8')
assert.ok(/sendPasswordResetEmail\(auth,/.test(authSrc), 'authService calls the Firebase reset API')
assert.ok(/export async function requestPasswordReset/.test(authSrc), 'requestPasswordReset is exported for the view')
assert.ok(/export async function verifyResetCode/.test(authSrc), 'the reset link code can be verified in-app')
assert.ok(/export async function completePasswordReset/.test(authSrc), 'the new password is saved through confirmPasswordReset')
assert.ok(/handleCodeInApp: true/.test(authSrc), 'the emailed link returns to the app so the password is entered there')
assert.ok(!/sendPasswordResetEmail\(auth, mail,\s*\}\)/.test(authSrc), 'the reset email carries a continue URL')
assert.ok(/auth\/unauthorized-continue-uri/.test(authSrc), 'an unauthorized origin falls back to the hosted reset page instead of failing')
assert.ok(/seg\.style\.display = 'none'/.test(loginSrc), 'the reset screen hides the mode switcher inline (.fn-seg sets display:flex, which beats the hidden attribute)')

// The new password must be typed twice, and both must match before saving.
assert.ok(/renderPasswordField\('np'/.test(loginSrc), 'the reset screen has a new-password field')
assert.ok(/renderPasswordField\('cp'/.test(loginSrc), 'the reset screen has a confirm-password field')
assert.ok(/Passwords do not match/.test(loginSrc), 'a mismatch is refused before saving')
assert.ok(/completePasswordReset\(code, np\)/.test(loginSrc), 'both fields are checked before the reset is submitted')
assert.ok(/mode === 'resetPassword' && params\.oobCode/.test(loginSrc), 'the emailed link is handled on the login screen')

// A reset link must render even with a live session (the user is locked out on
// that device), and must not be bounced away by the auth gates.
const routerSrc = fs.readFileSync(new URL('../src/router.js', import.meta.url), 'utf8')
assert.ok(/isResetLink/.test(routerSrc), 'the router lets a reset link through the guest redirect')
assert.ok(/route\.guest && user && !isResetLink/.test(routerSrc), 'the signed-in bounce is skipped for reset links')
assert.ok(/split\('\?'\)\[0\]/.test(authSrc), 'checkAccess compares the path only, ignoring the reset query')

const errorsSrc = fs.readFileSync(new URL('../src/features/auth/errors.js', import.meta.url), 'utf8')
for (const code of ['auth/invalid-action-code', 'auth/expired-action-code']) {
  assert.ok(errorsSrc.includes(code), 'friendly message for ' + code)
}

// A hash router cannot see ?mode=resetPassword&oobCode=… on a plain URL (the
// action-link shape), so main.js folds them into the hash before booting.
const mainSrc2 = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
assert.ok(/foldResetLinkIntoHash/.test(mainSrc2), 'main.js folds action links into the hash')
assert.ok(/mode=resetPassword/.test(mainSrc2), 'only resetPassword links are folded')
assert.ok(/oobCode/.test(mainSrc2), 'the one-time code is carried into the hash')
assert.ok(/replaceState/.test(mainSrc2), 'the fold rewrites the URL without reloading or adding history')

console.log('smoke: all assertions passed')
