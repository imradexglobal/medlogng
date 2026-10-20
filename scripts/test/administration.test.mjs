// Tests for medication administration — the bedside half of the medication
// chain (ordered → issued → given). Pure domain only; no Firestore needed.

import assert from 'node:assert/strict'

const A = await import('../../src/features/pharmacy/administration.js')
const R = await import('../../src/features/pharmacy/requests.js')

let passed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name) }
  catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e?.message || e))
    process.exitCode = 1
  }
}

const line = (over = {}) => ({
  line_id: 'line_0', drug_id: 'lot_1', medicine: 'Paracetamol 500mg', unit: 'tabs',
  dosage: '1 tab daily', quantity: 3, dispensed_qty: 3, administered_qty: 0, external: false,
  ...over,
})

// ---- remaining / given maths ------------------------------------------------
await test('the client example: order 3, give 1, 2 remain', () => {
  const l = line({ administered_qty: 1 })
  assert.equal(A.lineGiven(l), 1)
  assert.equal(A.lineRemainingToGive(l), 2)
  assert.equal(A.isLineFullyGiven(l), false)
})

await test('a fully given line has nothing left to give', () => {
  const l = line({ administered_qty: 3 })
  assert.equal(A.lineRemainingToGive(l), 0)
  assert.equal(A.isLineFullyGiven(l), true)
})

await test('given never exceeds ordered, even on a corrupt counter', () => {
  const l = line({ administered_qty: 9 })
  assert.equal(A.lineRemainingToGive(l), 0, 'remaining clamps at zero')
  assert.equal(A.exceedsOrder(l, 1), true, 'one more dose is still over the order')
})

await test('a dose beyond the order is refused; within the order is not', () => {
  const l = line({ administered_qty: 2 })
  assert.equal(A.exceedsOrder(l, 1), false, 'the 3rd dose is the last allowed')
  assert.equal(A.exceedsOrder(l, 2), true, 'two more would make 4 of 3')
})

// ---- the issued-stock warning (soft) ----------------------------------------
await test('giving more than issued warns on in-house lines', () => {
  const l = line({ dispensed_qty: 2, administered_qty: 1 })
  assert.equal(A.overIssuedWarn(l, 1), false, '2nd dose is covered by what was issued')
  assert.equal(A.overIssuedWarn(l, 2), true, '3rd dose reaches beyond the issued 2')
})

await test('external lines never trigger the issue warning', () => {
  const l = line({ external: true, dispensed_qty: 0, administered_qty: 1 })
  assert.equal(A.overIssuedWarn(l, 5), false, 'the pharmacy never issues external drugs')
})

// ---- applyAdministration -----------------------------------------------------
await test('applyAdministration bumps the right line and clamps at the order', () => {
  const items = [line(), line({ line_id: 'line_1', medicine: 'Ibuprofen', quantity: 2 })]
  const { items: next } = A.applyAdministration(items, { line_0: 1, line_1: 9 })
  assert.equal(next[0].administered_qty, 1)
  assert.equal(next[1].administered_qty, 2, 'clamped to the ordered 2, never 9')
})

await test('applyAdministration preserves every other line field', () => {
  const { items: next } = A.applyAdministration([line()], { line_0: 1 })
  assert.equal(next[0].medicine, 'Paracetamol 500mg')
  assert.equal(next[0].quantity, 3, 'the ordered quantity is never rewritten')
  assert.equal(next[0].dispensed_qty, 3, 'the issued quantity is never rewritten')
})

// ---- applyReversal -----------------------------------------------------------
await test('a reversal takes the dose back off the counter', () => {
  const { items } = A.applyReversal([line({ administered_qty: 2 })], 'line_0', 1)
  assert.equal(items[0].administered_qty, 1)
})

await test('a reversal cannot drive the counter below zero', () => {
  const { items } = A.applyReversal([line({ administered_qty: 1 })], 'line_0', 3)
  assert.equal(items[0].administered_qty, 0)
})

// ---- script progress ---------------------------------------------------------
await test('adminProgress totals the whole script', () => {
  const items = [
    line({ administered_qty: 1 }),
    line({ line_id: 'line_1', medicine: 'Ibuprofen', quantity: 2, administered_qty: 2 }),
  ]
  const p = A.adminProgress(items)
  assert.equal(p.ordered, 5, '3 + 2')
  assert.equal(p.given, 3, '1 + 2')
  assert.equal(p.toGive, 2)
  assert.equal(p.isComplete, false)
  assert.equal(p.completeLines, 1)
})

await test('adminProgress counts external lines — the patient still takes them', () => {
  const p = A.adminProgress([line({ external: true, dispensed_qty: 0, administered_qty: 3 })])
  assert.equal(p.given, 3)
  assert.equal(p.isComplete, true, 'complete even though the pharmacy never issued a single tab')
})

await test('an empty script has nothing given and is not "complete"', () => {
  const p = A.adminProgress([])
  assert.equal(p.given, 0)
  assert.equal(p.isComplete, false)
})

// ---- the event shape ---------------------------------------------------------
await test('buildDoseEvent snapshots the line and stamps who/when/where', () => {
  const event = A.buildDoseEvent({
    request: { id: 'r1', patient_id: 'p1', patient_name: 'Ada', encounter_id: 'e1', admission_session_id: 's1' },
    line: line(), qty: 1, route: 'IM', site: 'left deltoid', note: 'given after feed',
    user: { uid: 'u9', email: 'nurse@x.org' }, activeOrg: 'org_1', now: 123,
  })
  assert.equal(event.medicine, 'Paracetamol 500mg', 'snapshot, so the trail reads without joining')
  assert.equal(event.route, 'im', 'routes normalise to lowercase')
  assert.equal(event.site, 'left deltoid')
  assert.equal(event.administered_by, 'u9')
  assert.equal(event.administered_by_name, 'nurse@x.org')
  assert.equal(event.encounter_id, 'e1')
  assert.equal(event.medication_request_id, 'r1')
  assert.equal(event.type, 'given')
})

await test('an unknown route falls back to oral rather than failing', () => {
  const event = A.buildDoseEvent({
    request: {}, line: line(), qty: 1, route: 'teleport', user: {}, activeOrg: 'o', now: 1,
  })
  assert.equal(event.route, 'oral')
})

// ---- the row the views render -----------------------------------------------
await test('normalizeRequest now carries given/toGive alongside issue progress', () => {
  const row = R.normalizeRequest({
    id: 'r1', status: 'Requested',
    items: [
      { line_id: 'a', quantity: 3, dispensed_qty: 3, administered_qty: 1 },
      { line_id: 'b', quantity: 2, dispensed_qty: 0, administered_qty: 0 },
    ],
  })
  assert.equal(row.given, 1)
  assert.equal(row.toGive, 4)
  assert.equal(row.status, 'Partially dispensed', 'status stays issue-based; doses do not change it')
})

await test('legacy rows without administered_qty read as nothing given', () => {
  const items = R.toRequestItems({ medicine: 'Metformin', quantity: '30' })
  assert.equal(items[0].administered_qty, 0)
  assert.equal(A.lineRemainingToGive(items[0]), 30)
})

console.log('administration: ' + passed + ' passed')
