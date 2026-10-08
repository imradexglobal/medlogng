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
const ok = { patient_id: 'p9', ward_name: 'Ward A', bed_number: 'Bed 3' }
assert.equal(validateAdmissionInput(ok, { wards, admissions: admRows }), null, 'free bed in a configured ward passes')

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
  validateAdmissionInput({ patient_id: 'p1', ward_name: 'Ward A', bed_number: 'Bed 9' },
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
  validateAdmissionInput({ ...ok, patient_id: 'p1', bed_number: 'Bed 3' }, { wards, admissions: [] }),
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

console.log('smoke: all assertions passed')