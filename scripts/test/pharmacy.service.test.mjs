// Service-layer tests for the pharmacy write path.
//
// These run the real src/services/pharmacyService.js against an in-memory
// Firestore, so a transaction that Firestore would reject fails here too. That
// is the gap this file exists to close: the previous smoke test never imported
// a service that writes, so `createDrug`'s read-after-write, the dispense
// ReferenceError and the medication_requests rules violation all passed CI.

import assert from 'node:assert/strict'
import { signIn, seedDocs, docData, allDocs } from './harness.mjs'

const { dispense, receiveBatch, createDrug, updateDrug, correctStock, reverseDispenseIssue } =
  await import('../../src/services/pharmacyService.js')

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  ' + name) })
    .catch((e) => {
      console.error('  FAIL ' + name)
      console.error('       ' + (e?.message || e))
      if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
      process.exitCode = 1
    })
}

const lot = (over = {}) => ({
  organization_id: 'org_1',
  name: 'Metformin',
  drug_code: 'MET',
  strength: '500mg',
  pack_size: '30',
  sku: 'MET-500MG-30',
  unit: 'tabs',
  stock: 100,
  price: 2500,
  batch: 'B1',
  expiry: '2028-01-01',
  status: 'OK',
  supplier: 'Test',
  ...over,
})

const REQ = 'medication_requests/req_1'

// ---- createDrug ------------------------------------------------------------
await test('createDrug commits with opening stock (read-after-write regression)', async () => {
  await signIn('pharmacist')
  seedDocs({})
  const res = await createDrug({
    name: 'Metformin', drug_code: 'met', strength: '500mg', pack_size: '30',
    sku: 'MET-500MG-30', unit: 'tabs', price: 2500, stock: 100, batch: 'B1', expiry: '2028-01-01',
  })
  assert.ok(res.id, 'createDrug returns the new id')
  const stored = docData('stock_lots/' + res.id)
  assert.ok(stored, 'the lot doc was written')
  assert.equal(stored.stock, 100)
  assert.equal(stored.drug_code, 'MET', 'drug_code is upper-cased')
  assert.equal(stored.organization_id, 'org_1')
  // The returned object must carry the written values without re-reading.
  assert.equal(res.sku, 'MET-500MG-30')
  assert.equal(res.name, 'Metformin')
})

await test('createDrug with zero opening stock still commits', async () => {
  await signIn('pharmacist')
  seedDocs({})
  const res = await createDrug({ name: 'Ibuprofen', drug_code: 'IBU', strength: '200mg', pack_size: '20' })
  assert.equal(docData('stock_lots/' + res.id).stock, 0)
  assert.equal(docData('stock_lots/' + res.id).status, 'Out')
})

// ---- receiveBatch ----------------------------------------------------------
await test('receiveBatch increments stock and records an in-movement', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  const res = await receiveBatch({ drugId: 'lot_1', qty: 50, batch: 'B2', expiry: '2029-01-01', supplier: 'Acme', invoice_ref: 'INV-9' })
  assert.equal(res.newStock, 150)
  assert.equal(docData('stock_lots/lot_1').stock, 150)
  assert.equal(docData('stock_lots/lot_1').batch, 'B2')
  const moves = allDocs('stock_movements')
  assert.equal(moves.length, 1, 'one movement written')
  assert.equal(moves[0].data.type, 'in')
  assert.equal(moves[0].data.qty, 50)
  assert.equal(moves[0].data.invoice_ref, 'INV-9')
})

await test('receiveBatch revives an out-of-stock lot status', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 0, status: 'Out' }) })
  await receiveBatch({ drugId: 'lot_1', qty: 100, batch: 'B1', expiry: '2028-01-01' })
  assert.equal(docData('stock_lots/lot_1').status, 'OK', 'status tracks stock, not just creation')
})

await test('receiveBatch rejects a non-positive qty and writes nothing', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  await assert.rejects(() => receiveBatch({ drugId: 'lot_1', qty: 0, batch: 'B1', expiry: '2028-01-01' }))
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'stock unchanged')
  assert.equal(allDocs('stock_movements').length, 0, 'no movement written')
})

await test('receiveBatch rejects a past expiry and writes nothing', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  await assert.rejects(() => receiveBatch({ drugId: 'lot_1', qty: 10, batch: 'B1', expiry: '2000-01-01' }))
  assert.equal(docData('stock_lots/lot_1').stock, 100)
  assert.equal(allDocs('stock_movements').length, 0)
})

// ---- dispense --------------------------------------------------------------
const seedForDispense = (over = {}) => {
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100, batch: 'B1', expiry: '2028-01-01' }),
    [REQ]: {
      patient_id: 'pat_1', patient_name: 'Ada Nwosu',
      items: [
        { line_id: 'l1', drug_id: 'lot_1', medicine: 'Metformin', quantity: 20, dispensed_qty: 0 },
        { line_id: 'l2', drug_id: 'lot_1', medicine: 'Metformin', quantity: 10, dispensed_qty: 0 },
      ],
      status: 'Requested', organization_id: 'org_1',
      ...over,
    },
  })
}

await test('dispense decrements stock and writes an out-movement', async () => {
  await signIn('pharmacist')
  seedForDispense()
  const res = await dispense({
    items: [{ drugId: 'lot_1', requestedQty: 20 }],
    patientId: 'pat_1', patientName: 'Ada Nwosu',
  })
  assert.equal(docData('stock_lots/lot_1').stock, 80)
  const moves = allDocs('stock_movements')
  assert.equal(moves.length, 1)
  assert.equal(moves[0].data.type, 'out')
  assert.equal(moves[0].data.qty, 20)
  assert.equal(moves[0].data.patient_id, 'pat_1')
  assert.equal(res.items[0].lotStock, 80, 'return value reports committed stock')
})

await test('dispense clears batch/expiry when the lot is exhausted', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 10, batch: 'B1', expiry: '2028-01-01' }) })
  await dispense({ items: [{ drugId: 'lot_1', requestedQty: 10 }], patientId: 'pat_1', patientName: 'Ada Nwosu' })
  const after = docData('stock_lots/lot_1')
  assert.equal(after.stock, 0)
  assert.equal(after.batch, '', 'an exhausted lot must not keep listing its batch')
  assert.equal(after.expiry, '')
  assert.equal(after.status, 'Out', 'status tracks stock after dispensing')
})

await test('dispense keeps the batch while stock remains', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 50, batch: 'B1', expiry: '2028-01-01' }) })
  await dispense({ items: [{ drugId: 'lot_1', requestedQty: 20 }], patientId: 'pat_1', patientName: 'Ada Nwosu' })
  assert.equal(docData('stock_lots/lot_1').batch, 'B1')
  assert.equal(docData('stock_lots/lot_1').stock, 30)
})

await test('dispense rejects insufficient stock and rolls the whole transaction back', async () => {
  await signIn('pharmacist')
  seedForDispense()
  await assert.rejects(
    () => dispense({ items: [{ drugId: 'lot_1', requestedQty: 500 }], patientId: 'pat_1', patientName: 'Ada Nwosu' }),
    /Insufficient stock/,
  )
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'stock untouched')
  assert.equal(allDocs('stock_movements').length, 0, 'no movement on failure')
  assert.equal(allDocs('dispensations').length, 0, 'no ticket on failure')
})

await test('dispense rejects a zero quantity', async () => {
  await signIn('pharmacist')
  seedForDispense()
  await assert.rejects(
    () => dispense({ items: [{ drugId: 'lot_1', requestedQty: 0 }], patientId: 'pat_1', patientName: 'Ada Nwosu' }),
    /greater than zero/,
  )
  assert.equal(allDocs('dispensations').length, 0)
})

await test('a failed multi-item dispense commits none of its items', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 100 }),
    'stock_lots/lot_2': lot({ name: 'Ibuprofen', stock: 5 }),
  })
  // First item is fine, second is short — the transaction must roll back both.
  await assert.rejects(() => dispense({
    items: [{ drugId: 'lot_1', requestedQty: 10 }, { drugId: 'lot_2', requestedQty: 99 }],
    patientId: 'pat_1', patientName: 'Ada Nwosu',
  }))
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'the valid item did not decrement')
  assert.equal(docData('stock_lots/lot_2').stock, 5)
  assert.equal(allDocs('dispensations').length, 0)
  assert.equal(allDocs('stock_movements').length, 0)
})

await test('dispense writes a ticket carrying the parsed item list', async () => {
  await signIn('pharmacist')
  seedForDispense()
  await dispense({ items: [{ drugId: 'lot_1', requestedQty: 20 }], patientId: 'pat_1', patientName: 'Ada Nwosu' })
  const ticket = allDocs('dispensations')[0].data
  assert.equal(ticket.patient_name, 'Ada Nwosu')
  assert.equal(ticket.status, 'dispensed')
  const parsed = JSON.parse(ticket.items)
  assert.equal(Array.isArray(parsed), true, 'items is a JSON array, not a blob')
  assert.equal(parsed[0].name, 'Metformin')
  assert.equal(parsed[0].qty, 20)
})

await test('dispense is refused without the prescription.dispense capability', async () => {
  await signIn('nurse')
  seedForDispense()
  await assert.rejects(
    () => dispense({ items: [{ drugId: 'lot_1', requestedQty: 20 }], patientId: 'pat_1', patientName: 'Ada Nwosu' }),
    /cannot dispense/,
  )
  assert.equal(allDocs('dispensations').length, 0)
})

// ---- updateDrug / correctStock --------------------------------------------
await test('updateDrug commits', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  await updateDrug('lot_1', { name: 'Metformin', drug_code: 'MET', strength: '500mg', pack_size: '30', sku: 'MET-500MG-30', unit: 'tabs', stock: 7, price: 2600, status: 'Low' })
  assert.equal(docData('stock_lots/lot_1').stock, 7)
  assert.equal(docData('stock_lots/lot_1').price, 2600)
})

await test('correctStock writes a ledger movement and sets stock', async () => {
  await signIn('pharmacist')
  seedDocs({ 'stock_lots/lot_1': lot({ stock: 100 }) })
  await correctStock('lot_1', 88, 'Stock count')
  assert.equal(docData('stock_lots/lot_1').stock, 88)
  const moves = allDocs('stock_movements')
  assert.equal(moves.length, 1)
  assert.equal(moves[0].data.type, 'adjust')
})

// ---- reverseDispenseIssue ---------------------------------------------------
// One line issued (20 of 20), one still owed — the shape a partial script is in
// when the pharmacy wants a single medicine back.
const seedPartialIssue = (over = {}) => {
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 80, batch: 'B1', expiry: '2028-01-01' }),
    [REQ]: {
      patient_id: 'pat_1', patient_name: 'Ada Nwosu',
      items: [
        { line_id: 'l1', drug_id: 'lot_1', medicine: 'Metformin', quantity: 20, dispensed_qty: 20 },
        { line_id: 'l2', drug_id: 'lot_1', medicine: 'Metformin', quantity: 10, dispensed_qty: 0 },
      ],
      status: 'Partially dispensed', organization_id: 'org_1',
      ...over,
    },
    'stock_movements/mov_out': {
      type: 'out', organization_id: 'org_1', drug_id: 'lot_1', sku: 'MET-500MG-30',
      name: 'Metformin', qty: 20, batch: 'B1', expiry: '2028-01-01',
      medication_request_id: 'req_1', created_at: 1000,
    },
  })
}

const undoMoves = () => allDocs('stock_movements').filter((m) => m.path !== 'stock_movements/mov_out')

await test('reverseDispenseIssue returns the units to stock and unlocks the line', async () => {
  await signIn('pharmacist')
  seedPartialIssue()
  const res = await reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' })
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'the 20 issued units are back on the shelf')
  const line = docData('medication_requests/req_1').items.find((i) => i.line_id === 'l1')
  assert.equal(line.dispensed_qty, 0, 'dispensed_qty is what locks the medicine — it must be zero')
  assert.equal(docData('medication_requests/req_1').status, 'Requested', 'nothing issued now, so the script reopens')
  assert.equal(res.status, 'Requested')
  assert.equal(res.newStock, 100)
  const moves = undoMoves()
  assert.equal(moves.length, 1, 'a compensating movement is appended, the original stays')
  assert.equal(moves[0].data.type, 'in', 'reversed stock counts back in')
  assert.equal(moves[0].data.qty, 20)
  assert.equal(moves[0].data.reason, 'Dispense reversed')
  assert.equal(moves[0].data.medication_request_id, 'req_1')
  const ticket = allDocs('dispensations')
  assert.equal(ticket.length, 1, 'dispensations are append-only, so the undo is a second doc')
  assert.equal(ticket[0].data.status, 'reversed')
  assert.equal(docData('medication_requests/req_1').dispensed_at, null, 'the script is no longer complete')
})

await test('reverseDispenseIssue reopens a fully dispensed script to partially dispensed', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 70, batch: 'B1', expiry: '2028-01-01' }),
    [REQ]: {
      patient_id: 'pat_1', patient_name: 'Ada Nwosu',
      items: [
        { line_id: 'l1', drug_id: 'lot_1', medicine: 'Metformin', quantity: 20, dispensed_qty: 20 },
        { line_id: 'l2', drug_id: 'lot_1', medicine: 'Ibuprofen', quantity: 10, dispensed_qty: 10 },
      ],
      status: 'Dispensed', organization_id: 'org_1', dispensed_at: 123,
    },
  })
  const res = await reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' })
  assert.equal(docData('stock_lots/lot_1').stock, 90)
  assert.equal(res.status, 'Partially dispensed', 'the other medicine is still issued')
  assert.equal(docData('medication_requests/req_1').dispensed_at, null)
})

await test('reverseDispenseIssue restores the batch a fully exhausted lot lost', async () => {
  await signIn('pharmacist')
  seedDocs({
    'stock_lots/lot_1': lot({ stock: 0, batch: '', expiry: '', status: 'Out' }),
    [REQ]: {
      patient_id: 'pat_1', patient_name: 'Ada Nwosu',
      items: [{ line_id: 'l1', drug_id: 'lot_1', medicine: 'Metformin', quantity: 20, dispensed_qty: 20 }],
      status: 'Dispensed', organization_id: 'org_1',
    },
    'stock_movements/mov_out': {
      type: 'out', organization_id: 'org_1', drug_id: 'lot_1', qty: 20,
      batch: 'B1', expiry: '2028-01-01', medication_request_id: 'req_1', created_at: 1000,
    },
  })
  await reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' })
  const l = docData('stock_lots/lot_1')
  assert.equal(l.stock, 20)
  assert.equal(l.batch, 'B1', 'returned units come back with the batch they left in')
  assert.equal(l.expiry, '2028-01-01')
  assert.equal(l.status, 'OK', 'status is derived from stock again')
})

await test('reverseDispenseIssue refuses a medicine that was never dispensed', async () => {
  await signIn('pharmacist')
  seedForDispense()
  await assert.rejects(
    () => reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' }),
    /has not been dispensed/,
  )
  assert.equal(docData('stock_lots/lot_1').stock, 100, 'stock untouched')
  assert.equal(allDocs('stock_movements').length, 0, 'no movement written')
})

await test('reverseDispenseIssue refuses an external line', async () => {
  await signIn('pharmacist')
  seedDocs({
    [REQ]: {
      patient_id: 'pat_1', patient_name: 'Ada Nwosu',
      items: [{ line_id: 'l1', medicine: 'Panadol', quantity: 10, dispensed_qty: 0, external: true }],
      status: 'External', organization_id: 'org_1',
    },
  })
  await assert.rejects(
    () => reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' }),
    /external prescription/,
  )
})

await test('reverseDispenseIssue is refused without the prescription.dispense capability', async () => {
  await signIn('doctor')
  seedPartialIssue()
  await assert.rejects(
    () => reverseDispenseIssue({ requestId: 'req_1', lineId: 'l1' }),
    /cannot reverse/,
  )
  assert.equal(docData('stock_lots/lot_1').stock, 80, 'stock untouched')
  assert.equal(docData('medication_requests/req_1').items[0].dispensed_qty, 20, 'line untouched')
})

console.log('pharmacy service: ' + passed + ' passed')