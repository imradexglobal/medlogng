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

console.log('smoke: all assertions passed')
