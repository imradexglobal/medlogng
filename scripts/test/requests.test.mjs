// Tests for the grouped medication-request model: one prescription script per
// request, many lines, partial fulfilment.

import assert from 'node:assert/strict'
import { signIn, seedDocs, docData, allDocs } from './harness.mjs'

const {
  requestMedication, requestMedicationLines, updateRequestItems, listRequestsForEncounter,
  listOrgRequests, getRequest, dispense,
} = await import('../../src/services/pharmacyService.js')

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

const lot = (over = {}) => ({
  organization_id: 'org_1', name: 'Metformin', drug_code: 'MET', strength: '500mg',
  pack_size: '30', sku: 'MET-500MG-30', unit: 'tabs', stock: 100, price: 2500,
  batch: 'B1', expiry: '2028-01-01', status: 'OK', ...over,
})

// ---- pure domain -----------------------------------------------------------
await test('toQty coerces free-text quantities', () => {
  assert.equal(R.toQty('30'), 30)
  assert.equal(R.toQty(30), 30)
  assert.equal(R.toQty(''), 1, 'blank falls back')
  assert.equal(R.toQty(null), 1)
  assert.equal(R.toQty('abc'), 1)
  assert.equal(R.toQty(-5), 1, 'a negative is not a usable quantity')
})

await test('a legacy single-drug document reads as a one-line script', () => {
  const items = R.toRequestItems({
    medicine: 'Metformin', drug_id: 'lot_1', quantity: '30', status: 'Requested',
  })
  assert.equal(items.length, 1, 'legacy rows must not read as empty')
  assert.equal(items[0].medicine, 'Metformin')
  assert.equal(items[0].quantity, 30)
  assert.equal(items[0].dispensed_qty, 0)
})

await test('an empty document has no lines', () => {
  assert.equal(R.toRequestItems({}).length, 0)
  assert.equal(R.toRequestItems(null).length, 0)
})

await test('normalizeRequest derives status from what was issued', () => {
  const full = R.normalizeRequest({
    id: 'r1', status: 'Requested',
    items: [{ line_id: 'a', drug_id: 'l', quantity: 10, dispensed_qty: 10 }],
  })
  assert.equal(full.status, 'Dispensed')
  assert.equal(full.outstanding, 0)
  assert.equal(full.isComplete, true)

  const part = R.normalizeRequest({
    id: 'r2', status: 'Requested',
    items: [
      { line_id: 'a', drug_id: 'l', quantity: 10, dispensed_qty: 10 },
      { line_id: 'b', drug_id: 'l', quantity: 5, dispensed_qty: 0 },
    ],
  })
  assert.equal(part.status, 'Partially dispensed')
  assert.equal(part.dispensed, 10)
  assert.equal(part.total, 15)
  assert.equal(part.outstanding, 5)
  assert.equal(part.lineCount, 2)
})

await test('an explicit Declined status is preserved', () => {
  const r = R.normalizeRequest({ id: 'r', status: 'Declined', items: [{ medicine: 'X', quantity: 1 }] })
  assert.equal(r.status, 'Declined', 'a declined script stays declined even if nothing is owed')
})

await test('the same medicine with the same dosage merges into one line', () => {
  const once = R.mergeRequestLine([], { drug_id: 'l', medicine: 'Metformin', dosage: '1 daily', quantity: 30 })
  const twice = R.mergeRequestLine(once, { drug_id: 'l', medicine: 'Metformin', dosage: '1 daily', quantity: 30 })
  assert.equal(twice.length, 1, 'same drug + dosage accumulates')
  assert.equal(twice[0].quantity, 60)
})

await test('different dosages stay on separate lines', () => {
  const a = R.mergeRequestLine([], { drug_id: 'l', medicine: 'Metformin', dosage: '1 daily', quantity: 30 })
  const b = R.mergeRequestLine(a, { drug_id: 'l', medicine: 'Metformin', dosage: '2 daily', quantity: 10 })
  assert.equal(b.length, 2, 'a script can carry two schedules of one drug')
})

await test('merging preserves prescription order', () => {
  let items = []
  for (const n of ['A', 'B', 'C']) {
    items = R.mergeRequestLine(items, { drug_id: 'l' + n, medicine: n, quantity: 1 })
  }
  assert.deepEqual(items.map((i) => i.medicine), ['A', 'B', 'C'])
})

await test('lineOutstanding and isOpenRequest', () => {
  assert.equal(R.lineOutstanding({ quantity: 10, dispensed_qty: 4 }), 6)
  assert.equal(R.lineOutstanding({ quantity: 10, dispensed_qty: 10 }), 0)
  assert.equal(R.lineOutstanding({ quantity: 10, dispensed_qty: 20 }), 0, 'never negative')
  assert.equal(R.isOpenRequest('Requested'), true)
  assert.equal(R.isOpenRequest('Partially dispensed'), true)
  assert.equal(R.isOpenRequest('Dispensed'), false)
  assert.equal(R.isOpenRequest('Declined'), false)
})

await test('applyIssue never records more than was prescribed', () => {
  const items = [{ line_id: 'a', quantity: 10, dispensed_qty: 0 }]
  const out = R.applyIssue(items, { a: 99 })
  assert.equal(out.items[0].dispensed_qty, 10)
  assert.equal(out.outstanding, 0)
})

// ---- service: one script per encounter ------------------------------------
const lineFor = (drugId, name, qty) => ({ drug_id: drugId, medicine: name, quantity: qty, unit: 'tabs' })

await test('prescribing twice for one encounter produces ONE request with two lines', async () => {
  await signIn('doctor')
  seedDocs({
    'stock_lots/lot_1': lot(),
    'stock_lots/lot_2': lot({ name: 'Ibuprofen', drug_code: 'IBU', sku: 'IBU-200MG-20' }),
  })
  const first = await requestMedication({
    patientId: 'pat_1', patientName: 'Ada', encounterId: 'enc_1',
    line: lineFor('lot_1', 'Metformin', 30),
  })
  assert.equal(first.created, true, 'the first line opens a script')
  const second = await requestMedication({
    patientId: 'pat_1', patientName: 'Ada', encounterId: 'enc_1',
    line: lineFor('lot_2', 'Ibuprofen', 20),
  })
  assert.equal(second.created, false, 'the second line joins the open script')
  assert.equal(second.id, first.id, 'same request id')
  assert.equal(allDocs('medication_requests').length, 1, 'one document, not two')
  const stored = docData('medication_requests/' + first.id)
  assert.equal(stored.items.length, 2, 'the script holds both medicines')
  assert.deepEqual(stored.items.map((i) => i.medicine), ['Metformin', 'Ibuprofen'])
})

await test('a new encounter starts a separate script', async () => {
  await signIn('doctor')
  seedDocs({ 'stock_lots/lot_1': lot() })
  await requestMedication({ patientId: 'pat_1', encounterId: 'enc_1', line: lineFor('lot_1', 'Metformin', 30) })
  await requestMedication({ patientId: 'pat_1', encounterId: 'enc_2', line: lineFor('lot_1', 'Metformin', 30) })
  assert.equal(allDocs('medication_requests').length, 2, 'a different encounter is a different script')
})

await test('a fully dispensed script does not absorb new lines', async () => {
  await signIn('doctor')
  seedDocs({
    'stock_lots/lot_1': lot(),
    'medication_requests/old': {
      patient_id: 'pat_1', encounter_id: 'enc_1', organization_id: 'org_1',
      items: [{ line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 10, dispensed_qty: 10 }],
      status: 'Dispensed',
    },
  })
  const res = await requestMedication({ patientId: 'pat_1', encounterId: 'enc_1', line: lineFor('lot_1', 'Metformin', 30) })
  assert.equal(res.created, true, 'a closed script cannot be reopened')
  assert.equal(allDocs('medication_requests').length, 2)
})

await test('a partially dispensed script still absorbs new lines', async () => {
  await signIn('doctor')
  seedDocs({
    'stock_lots/lot_1': lot(),
    'stock_lots/lot_2': lot({ name: 'Ibuprofen', drug_code: 'IBU' }),
    'medication_requests/part': {
      patient_id: 'pat_1', encounter_id: 'enc_1', organization_id: 'org_1',
      items: [
        { line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 10, dispensed_qty: 4 },
        { line_id: 'b', drug_id: 'lot_2', medicine: 'Ibuprofen', quantity: 10, dispensed_qty: 0 },
      ],
      status: 'Partially dispensed',
    },
  })
  const res = await requestMedication({ patientId: 'pat_1', encounterId: 'enc_1', line: lineFor('lot_1', 'Metformin', 30) })
  assert.equal(res.created, false)
  assert.equal(res.items.length, 2, 'merged into the Metformin line rather than appended')
  assert.equal(res.items.find((i) => i.medicine === 'Metformin').quantity, 40)
  assert.equal(allDocs('medication_requests').length, 1)
})

await test('prescribing requires the prescription.create capability', async () => {
  await signIn('nurse')
  seedDocs({})
  await assert.rejects(
    () => requestMedication({ patientId: 'pat_1', encounterId: 'enc_1', line: lineFor('lot_1', 'X', 1) }),
    /cannot prescribe/,
  )
  assert.equal(allDocs('medication_requests').length, 0)
})

// ---- service: dispensing part of a script ---------------------------------
await test('dispensing one line leaves the request partially dispensed', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'medication_requests/r1': {
      patient_id: 'pat_1', patient_name: 'Ada', organization_id: 'org_1',
      items: [
        { line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 30, dispensed_qty: 0 },
        { line_id: 'b', drug_id: 'lot_1', medicine: 'Ibuprofen', quantity: 20, dispensed_qty: 0 },
      ],
      status: 'Requested',
    },
  })
  await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 10, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  })
  const after = docData('medication_requests/r1')
  assert.equal(after.status, 'Partially dispensed', 'not fully dispensed while a line is outstanding')
  assert.equal(after.items.find((i) => i.line_id === 'a').dispensed_qty, 10)
  assert.equal(after.items.find((i) => i.line_id === 'b').dispensed_qty, 0, 'the untouched line is untouched')
  assert.equal(after.dispensed_at, undefined, 'not stamped complete yet')
})

await test('dispensing every line closes the request', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'medication_requests/r1': {
      patient_id: 'pat_1', organization_id: 'org_1',
      items: [
        { line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 30, dispensed_qty: 0 },
        { line_id: 'b', drug_id: 'lot_1', medicine: 'Ibuprofen', quantity: 20, dispensed_qty: 0 },
      ],
      status: 'Requested',
    },
  })
  await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 30, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  })
  await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 20, lineId: 'b' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  })
  const after = docData('medication_requests/r1')
  assert.equal(after.status, 'Dispensed')
  assert.ok(after.dispensed_at, 'stamped complete once every line is issued')
  assert.equal(docData('stock_lots/lot_1').stock, 50, '50 issued in total')
})

await test('a partial dispense issues exactly what was asked, not the whole line', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'medication_requests/r1': {
      patient_id: 'pat_1', organization_id: 'org_1',
      items: [{ line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 30, dispensed_qty: 0 }],
      status: 'Requested',
    },
  })
  await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 7, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  })
  assert.equal(docData('stock_lots/lot_1').stock, 93, 'only 7 units left the shelf')
  assert.equal(docData('medication_requests/r1').items[0].dispensed_qty, 7)
})

await test('a legacy single-drug request still dispenses and gets migrated to a line list', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'medication_requests/legacy': {
      patient_id: 'pat_1', medicine: 'Metformin', drug_id: 'lot_1',
      quantity: '30', status: 'Requested', organization_id: 'org_1',
    },
  })
  const res = await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 30 }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'legacy',
  })
  const after = docData('medication_requests/legacy')
  assert.equal(after.status, 'Dispensed', 'a pre-existing row must keep working')
  assert.ok(Array.isArray(after.items), 'migrated to the line list')
  assert.equal(after.items[0].dispensed_qty, 30)
  assert.equal(res.requestProgress.outstanding, 0)
})

await test('a failed dispense leaves the request lines untouched', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 10 }),
    'medication_requests/r1': {
      patient_id: 'pat_1', organization_id: 'org_1',
      items: [{ line_id: 'a', drug_id: 'lot_1', medicine: 'Metformin', quantity: 30, dispensed_qty: 0 }],
      status: 'Requested',
    },
  })
  await assert.rejects(() => dispense({
    items: [{ drugId: 'lot_1', requestedQty: 30, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  }))
  const after = docData('medication_requests/r1')
  assert.equal(after.items[0].dispensed_qty, 0, 'no line was marked issued')
  assert.equal(after.status, 'Requested')
})

await test('a request for a deleted prescription is refused', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  await assert.rejects(() => dispense({
    items: [{ drugId: 'lot_1', requestedQty: 5, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'gone',
  }), /no longer exists/)
  assert.equal(docData('stock_lots/lot_1').stock, 100)
})

await test('listOrgRequests normalises the queue', async () => {
  await signIn('pharmacist')
  seedDocs({
    'medication_requests/r1': {
      patient_id: 'pat_1', patient_name: 'Ada', organization_id: 'org_1',
      items: [{ line_id: 'a', drug_id: 'l', medicine: 'Metformin', quantity: 30 }],
      status: 'Requested',
    },
    'medication_requests/r2': {
      patient_id: 'pat_2', patient_name: 'Bola', organization_id: 'org_1',
      medicine: 'Legacy Drug', quantity: '10', status: 'Requested',
    },
    'medication_requests/other_org': {
      patient_id: 'pat_3', organization_id: 'org_2',
      items: [{ line_id: 'a', drug_id: 'l', medicine: 'X', quantity: 1 }],
      status: 'Requested',
    },
  })
  const rows = await listOrgRequests('org_1')
  assert.equal(rows.length, 2, 'scoped to the org')
  assert.equal(rows.find((r) => r.id === 'r2').lineCount, 1, 'legacy row reads as one line')
  assert.equal(rows.find((r) => r.id === 'r1').total, 30)
})

// ---- external pharmacy -----------------------------------------------------
await test('an external line is flagged and excluded from stock progress', () => {
  const line = R.toLine({ medicine: 'Amlodipine 10mg', quantity: 30, external: true }, 0)
  assert.equal(line.external, true)
  const p = R.requestProgress([line])
  assert.equal(p.total, 0, 'external lines contribute nothing to the in-house balance')
  assert.equal(p.outstanding, 0)
  assert.equal(p.externalCount, 1)
  assert.equal(p.internalLineCount, 0)
})

await test('an all-external script reads as External, not Requested', () => {
  const r = R.normalizeRequest({
    id: 'r', status: 'Requested',
    items: [{ line_id: 'a', medicine: 'Outside drug', quantity: 10, external: true }],
  })
  assert.equal(r.status, 'External')
  assert.equal(r.isComplete, false)
})

await test('a mixed script keeps its in-house status and ignores the external line', () => {
  const r = R.normalizeRequest({
    id: 'r', status: 'Requested',
    items: [
      { line_id: 'a', drug_id: 'l', medicine: 'Metformin', quantity: 10, dispensed_qty: 10 },
      { line_id: 'b', medicine: 'Outside drug', quantity: 5, external: true },
    ],
  })
  assert.equal(r.status, 'Dispensed', 'the external line does not keep it open')
  assert.equal(r.total, 10)
  assert.equal(r.externalCount, 1)
})

await test('an external line never merges with an in-house line of the same name', () => {
  let items = R.mergeRequestLine([], { drug_id: 'l', medicine: 'Metformin', dosage: '1 daily', quantity: 30 })
  items = R.mergeRequestLine(items, { medicine: 'Metformin', dosage: '1 daily', quantity: 30, external: true })
  assert.equal(items.length, 2, 'same name + dosage but a different source stays separate')
})

await test('applyIssue ignores an external line', () => {
  const out = R.applyIssue([{ line_id: 'a', medicine: 'Out', quantity: 10, external: true }], { a: 10 })
  assert.equal(out.items[0].dispensed_qty, 0, 'an external line is never issued from in-house stock')
})

await test('an all-external prescription still saves and opens one request', async () => {
  await signIn('doctor')
  seedDocs({})
  const first = await requestMedication({
    patientId: 'pat_1', patientName: 'Ada', encounterId: 'enc_1',
    line: { medicine: 'Amlodipine 10mg', quantity: 30, external: true },
  })
  assert.equal(first.created, true)
  const stored = docData('medication_requests/' + first.id)
  assert.equal(stored.items[0].external, true)
  // A second external line joins the same script rather than opening a new one.
  const second = await requestMedication({
    patientId: 'pat_1', patientName: 'Ada', encounterId: 'enc_1',
    line: { medicine: 'Atorvastatin 20mg', quantity: 30, external: true },
  })
  assert.equal(second.created, false)
  assert.equal(allDocs('medication_requests').length, 1)
})

await test('dispense refuses an external line and leaves stock untouched', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'medication_requests/r1': {
      patient_id: 'pat_1', patient_name: 'Ada', organization_id: 'org_1',
      items: [{ line_id: 'a', medicine: 'Outside drug', quantity: 10, external: true }],
      status: 'Requested',
    },
  })
  await assert.rejects(() => dispense({
    items: [{ drugId: 'lot_1', requestedQty: 10, lineId: 'a' }],
    patientId: 'pat_1', patientName: 'Ada', medicationRequestId: 'r1',
  }), /external prescription/i)
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'no stock left the shelf')
  assert.ok(!docData('medication_requests/r1').items[0].dispensed_qty, 'the external line was not marked issued')
})

// ---- one script, many lines, one write -------------------------------------
await test('requestMedicationLines puts a whole prescription on ONE request in ONE write', async () => {
  await signIn('doctor')
  seedDocs({})
  const res = await requestMedicationLines({
    patientId: 'pat_1', patientName: 'Ada Nwosu', encounterId: 'enc_1',
    lines: [
      { medicine: 'Metformin', dosage: '1 tab daily', qty: '30' },
      { medicine: 'Lisinopril', dosage: '1 tab nightly', qty: '28' },
      { medicine: 'Amlodipine 10mg', qty: '1', external: true },
    ],
  })
  assert.equal(res.created, true)
  const rows = allDocs('medication_requests')
  assert.equal(rows.length, 1, 'three medicines must not open three requests')
  const stored = rows[0].data
  assert.equal(stored.encounter_id, 'enc_1')
  assert.equal(stored.items.length, 3)
  assert.equal(stored.items[0].quantity, 30, 'the form hands back a text qty; the store holds a number')
  assert.equal(stored.items[2].external, true)
  assert.ok(res.items.every((l) => l.line_id), 'every line carries an id the pharmacy can issue against')
  assert.equal(new Set(res.items.map((l) => l.line_id)).size, 3, 'and no two lines share one')
})

await test('a second submit for the same encounter joins the script already open', async () => {
  await signIn('doctor')
  seedDocs({})
  await requestMedicationLines({ patientId: 'pat_1', encounterId: 'enc_1', lines: [{ medicine: 'Metformin', qty: 30 }] })
  const second = await requestMedicationLines({ patientId: 'pat_1', encounterId: 'enc_1', lines: [{ medicine: 'Ibuprofen', qty: 20 }] })
  assert.equal(second.created, false)
  assert.equal(allDocs('medication_requests').length, 1, 'still one script for the encounter')
  assert.equal(second.items.length, 2)
})

await test('a medicine added later cannot borrow the line id of one already on the script', async () => {
  await signIn('doctor')
  seedDocs({})
  const first = await requestMedicationLines({ patientId: 'pat_1', encounterId: 'enc_1', lines: [{ medicine: 'Metformin', qty: 30 }] })
  const ids = new Set(first.items.map((l) => l.line_id))
  // A third insert on a script whose ids were position-derived is where a
  // naive "line_<index>" default starts colliding.
  await requestMedicationLines({ patientId: 'pat_1', encounterId: 'enc_1', lines: [{ medicine: 'Ibuprofen', qty: 20 }] })
  const third = await requestMedicationLines({ patientId: 'pat_1', encounterId: 'enc_1', lines: [{ medicine: 'Paracetamol', qty: 10 }] })
  const all = third.items.map((l) => l.line_id)
  assert.equal(new Set(all).size, all.length, 'line ids stay unique as the script grows')
  assert.ok([...ids].every((id) => all.includes(id)), 'the earlier lines kept their own ids')
})

await test('requestMedicationLines is refused without prescription.create', async () => {
  await signIn('nurse')
  seedDocs({})
  await assert.rejects(
    () => requestMedicationLines({ patientId: 'pat_1', lines: [{ medicine: 'Metformin', qty: 30 }] }),
    /cannot prescribe/,
  )
  assert.equal(allDocs('medication_requests').length, 0, 'nothing written')
})

await test('requestMedicationLines refuses an empty prescription', async () => {
  await signIn('doctor')
  seedDocs({})
  await assert.rejects(() => requestMedicationLines({ patientId: 'pat_1', lines: [{}] }), /at least one medicine/)
})

// ---- adjust the last one ---------------------------------------------------
const seedScript = (over = {}) => seedDocs({
  'medication_requests/req_1': {
    patient_id: 'pat_1', patient_name: 'Ada Nwosu', encounter_id: 'enc_1',
    organization_id: 'org_1', created_at: 1000,
    items: [
      { line_id: 'line_0', drug_id: 'lot_1', medicine: 'Metformin', quantity: 30, dispensed_qty: 0 },
      { line_id: 'line_1', medicine: 'Lisinopril', quantity: 28, dispensed_qty: 10 },
    ],
    status: 'Partially dispensed',
    ...over,
  },
})

await test('updateRequestItems rewrites the open script and keeps what was issued', async () => {
  await signIn('doctor')
  seedScript()
  const res = await updateRequestItems('req_1', [
    { line_id: 'line_0', drug_id: 'lot_1', medicine: 'Metformin', qty: '45' },
    { line_id: 'line_1', medicine: 'Lisinopril', qty: '28' },
    { medicine: 'Ibuprofen', qty: '20' }, // added in the same edit, no id yet
  ])
  assert.equal(res.items.length, 3)
  const byId = Object.fromEntries(res.items.map((l) => [l.line_id, l]))
  assert.equal(byId.line_0.quantity, 45, 'the edit lands on the line it names')
  assert.equal(byId.line_1.dispensed_qty, 10, 'issued quantity survives a rewrite')
  const added = res.items.find((l) => l.medicine === 'Ibuprofen')
  assert.ok(added.line_id && !['line_0', 'line_1'].includes(added.line_id), 'a new line is not issued someone else\'s id')
  const stored = docData('medication_requests/req_1')
  assert.equal(stored.items.length, 3, 'one write, no duplicate document')
  assert.equal(stored.status, res.status, 'status recomputed from what is still outstanding')
})

await test('updateRequestItems refuses to drop a line the pharmacy has issued', async () => {
  await signIn('doctor')
  seedScript()
  await assert.rejects(
    () => updateRequestItems('req_1', [{ line_id: 'line_0', medicine: 'Metformin', qty: 30 }]),
    /must stay on the prescription/,
  )
  assert.equal(docData('medication_requests/req_1').items.length, 2, 'nothing written')
})

await test('updateRequestItems refuses to cut a quantity below what went out', async () => {
  await signIn('doctor')
  seedScript()
  await assert.rejects(
    () => updateRequestItems('req_1', [
      { line_id: 'line_0', medicine: 'Metformin', qty: 30 },
      { line_id: 'line_1', medicine: 'Lisinopril', qty: '5' },
    ]),
    /cannot be reduced below/,
  )
  assert.equal(docData('medication_requests/req_1').items[1].quantity, 28, 'the script is untouched')
})

await test('updateRequestItems is refused without prescription.create', async () => {
  await signIn('receptionist')
  seedScript()
  await assert.rejects(
    () => updateRequestItems('req_1', [{ line_id: 'line_0', medicine: 'Metformin', qty: 30 }]),
    /cannot prescribe/,
  )
  assert.equal(docData('medication_requests/req_1').items.length, 2)
})

await test('updateRequestItems refuses a script that has already been dispensed', async () => {
  await signIn('doctor')
  seedScript({
    status: 'Dispensed',
    items: [{ line_id: 'line_0', medicine: 'Metformin', quantity: 30, dispensed_qty: 30 }],
  })
  await assert.rejects(
    () => updateRequestItems('req_1', [{ line_id: 'line_0', medicine: 'Metformin', qty: 30 }]),
    /already been dispensed/,
  )
})

// ---- the encounter's script list -------------------------------------------
await test('listRequestsForEncounter returns only this encounter, newest first', async () => {
  await signIn('doctor')
  seedDocs({
    'medication_requests/a': { organization_id: 'org_1', encounter_id: 'enc_1', created_at: 1000, status: 'Requested', items: [{ line_id: 'line_0', medicine: 'Metformin', quantity: 30 }] },
    'medication_requests/b': { organization_id: 'org_1', encounter_id: 'enc_1', created_at: 3000, status: 'Requested', items: [{ line_id: 'line_0', medicine: 'Ibuprofen', quantity: 20 }] },
    'medication_requests/c': { organization_id: 'org_1', encounter_id: 'enc_other', created_at: 5000, status: 'Requested', items: [{ line_id: 'line_0', medicine: 'Paracetamol', quantity: 10 }] },
    'medication_requests/d': { organization_id: 'org_other', encounter_id: 'enc_1', created_at: 6000, status: 'Requested', items: [{ line_id: 'line_0', medicine: 'Other hospital drug', quantity: 5 }] },
  })
  const list = await listRequestsForEncounter('enc_1')
  assert.deepEqual(list.map((r) => r.id), ['b', 'a'], 'this org, this encounter, newest first')
  assert.equal(list[0].items[0].medicine, 'Ibuprofen')
})

await test('line ids stay unique when a line is added to a script that has had one removed', () => {
  // Line ids default to a position-derived "line_<index>", and line_1 is gone
  // (dropped while it was still unissued) — so the append arrives at index 2
  // asking for "line_2", which is exactly the id of the line still sitting there.
  const items = [
    { line_id: 'line_0', medicine: 'Metformin', quantity: 30 },
    { line_id: 'line_2', medicine: 'Lisinopril', quantity: 28 },
  ]
  const merged = R.mergeRequestLine(items, { medicine: 'Ibuprofen', quantity: 20 })
  const ids = merged.map((l) => l.line_id)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3, 'the appended line did not borrow line_2')
  assert.equal(merged[1].medicine, 'Lisinopril', 'the existing line was not overwritten')
  assert.equal(R.freshLineId(['line_0', 'line_1', 'line_3']), 'line_2', 'picks the first free slot')
})

console.log('requests: ' + passed + ' passed')