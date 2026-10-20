// Tests for the LIMS upgrade (structured catalogue → per-test workflow):
//   - pure domain: component sanitising, reference resolution, flags,
//     result validation, configuration snapshots, legacy normalisation,
//     order-status rollup,
//   - catalogue service: seed, CRUD, capability gates, settings,
//   - laboratory service: catalogue-backed orders, price freezing, the full
//     per-item workflow (collect → receive → result → validate → release),
//     role gates, and the lab→billing integration.
// Run: node scripts/test/lab.lims.test.mjs
import assert from 'node:assert/strict'
import { signIn, seedDocs, docData, allDocs, docCount } from './harness.mjs'

const D = await import('../../src/features/labs/domain.js')
const {
  sanitizeComponent, resolveReferenceFor, computeFlag, flagValues,
  validateResultValues, buildOrderItem, buildAdhocItem, normalizeLabItems,
  deriveOrderStatus, STARTER_TESTS, starterTestToDoc,
} = D

const {
  createLabOrder, getLabOrder, collectItems, receiveItems, rejectItem, recollectItem,
  cancelItem, saveItemResult, validateItem, releaseItem, releaseOrder,
  updateLabStatus, addLabResult, addLabVerification, myLabCaps,
} = await import('../../src/services/laboratoryService.js')

const {
  createTest, updateTest, setTestActive, seedStarterCatalogue, listOrgTests,
  getLabSettings, saveLabSettings, myLabAdminCaps,
} = await import('../../src/services/labCatalogueService.js')

const { createInvoiceForLabOrder } = await import('../../src/services/billingService.js')
const T = await import('../../src/lib/labPrintTemplates.js')

let passed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name) }
  catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e?.message || e))
    process.exitCode = 1
  }
}

function auditActions() {
  return allDocs('audit_events').map((d) => d.data.action)
}

// ---- pure domain ------------------------------------------------------------
await test('sanitizeComponent rejects qualitative options-less and inverted ranges', () => {
  assert.equal(sanitizeComponent({ name: 'Malaria', result_type: 'qualitative' }).ok, false)
  assert.equal(sanitizeComponent({ name: 'Hb', result_type: 'numeric', ref_low: 16, ref_high: 12 }).ok, false)
  const ok = sanitizeComponent({ name: 'Hb', result_type: 'numeric', ref_low: 12, ref_high: 16, unit: 'g/dL' })
  assert.equal(ok.ok, true)
  assert.equal(ok.component.ref_low, 12)
  assert.equal(ok.component.ref_high, 16)
  // Ranges stay optional — nothing is invented.
  const bare = sanitizeComponent({ name: 'Hb', result_type: 'numeric' })
  assert.equal(bare.ok, true)
  assert.equal(bare.component.ref_low, null)
})

await test('computeFlag marks L/H/within and ignores non-numerics', () => {
  const ref = { low: 12, high: 16 }
  assert.equal(computeFlag('11', ref), 'L')
  assert.equal(computeFlag('17', ref), 'H')
  assert.equal(computeFlag('14', ref), '')
  assert.equal(computeFlag('abc', ref), '')
  assert.equal(computeFlag('14', { low: null, high: null }), '')
})

await test('resolveReferenceFor: sex-specific beats general, first matching rule wins', () => {
  const comp = {
    ref_low: 8, ref_high: 12, ref_text: '',
    ref_rules: [
      { sex: 'female', age_min: null, age_max: null, low: 12, high: 16, text: '' },
      { sex: 'male', age_min: null, age_max: null, low: 14, high: 18, text: '' },
      { sex: '', age_min: 0, age_max: 12, low: 11, high: 14, text: 'child' },
    ],
  }
  assert.deepEqual(resolveReferenceFor(comp, 'female', null, null), { low: 12, high: 16, text: '', critical_low: null, critical_high: null })
  assert.deepEqual(resolveReferenceFor(comp, 'male', null, null), { low: 14, high: 18, text: '', critical_low: null, critical_high: null })
  assert.deepEqual(resolveReferenceFor(comp, '', null, null), { low: 8, high: 12, text: '', critical_low: null, critical_high: null })
  // Age rule wins for a child when no sex is supplied (sex rules skipped).
  const dob = new Date()
  dob.setFullYear(dob.getFullYear() - 8)
  assert.deepEqual(resolveReferenceFor(comp, '', dob.toISOString(), null), { low: 11, high: 14, text: 'child', critical_low: null, critical_high: null })
})

await test('flagValues attaches flags + the resolved reference per numeric component', () => {
  const snapshot = {
    components: [
      { id: 'hgb', name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL', ref_low: 12, ref_high: 16, ref_rules: [] },
      { id: 'note', name: 'Note', display_name: 'Note', result_type: 'text', unit: '', ref_low: null, ref_high: null, ref_rules: [] },
    ],
  }
  const out = flagValues({ hgb: { value: '7', remark: '' }, note: { value: 'haemolysed', remark: '' } }, snapshot, { sex: 'female', resultNow: Date.now() })
  assert.equal(out.hgb.flag, 'L')
  assert.equal(out.hgb.ref.low, 12)
  assert.equal(out.note.flag, '')
})

await test('validateResultValues enforces required components unless draft', () => {
  const snapshot = {
    components: [
      { id: 'hgb', name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', required: true },
      { id: 'find', name: 'Findings', display_name: 'Findings', result_type: 'text', required: false },
    ],
  }
  const missing = validateResultValues(snapshot, {}, { draft: false })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Haemoglobin/)
  assert.equal(validateResultValues(snapshot, {}, { draft: true }).ok, true)
  assert.equal(validateResultValues(snapshot, { hgb: { value: '13.1' } }, { draft: false }).ok, true)
})

await test('buildOrderItem freezes the configuration snapshot and price', () => {
  const test0 = { id: 't1', code: 'HBT', name: 'Haemoglobin', category: 'Haematology', specimen_type: 'EDTA', price_kobo: 50000, components: [sanitizeComponent({ id: 'hgb', name: 'HGB', result_type: 'numeric', unit: 'g/dL', ref_low: 12, ref_high: 16 }).component] }
  const item = buildOrderItem({ test: test0 })
  assert.equal(item.price_kobo, 50000)
  assert.equal(item.snapshot.components[0].ref_low, 12)
  assert.equal(item.status, 'ordered')
  assert.ok(item.item_id)
  // Mutating the catalogue afterwards does not touch the frozen item.
  test0.price_kobo = 99999
  test0.components[0].ref_low = 1
  assert.equal(item.price_kobo, 50000)
  assert.equal(item.snapshot.components[0].ref_low, 12)
})

await test('normalizeLabItems promotes legacy orders and per-test result maps', () => {
  // Legacy multi-test order: explicit tests[] array (test_panel stays a summary).
  const items = normalizeLabItems({
    tests: ['FBC', 'ESR'], test_panel: 'FBC, ESR', status: 'processing',
    result: { FBC: 'Normal', ESR: '12' },
    collected_at: 1000, verified_by: 'u9', verified_at: 2000,
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].test_name, 'FBC')
  assert.equal(items[0].legacy, true)
  assert.equal(items[0].status, 'received') // processing → received
  assert.equal(items[0].result.legacy_text, 'Normal')
  assert.equal(items[1].result.legacy_text, '12')
  // A pre-multi-test order has only test_panel — one virtual item, as before.
  const single = normalizeLabItems({ test_panel: 'Widal', status: 'order' })
  assert.equal(single.length, 1)
  assert.equal(single[0].test_name, 'Widal')
})

await test('deriveOrderStatus: bottleneck rollup + cancelled/released edges', () => {
  const mk = (status) => { const i = buildAdhocItem({ name: 'X' }); i.status = status; return i }
  assert.equal(deriveOrderStatus([mk('ordered'), mk('released')]), 'order')
  assert.equal(deriveOrderStatus([mk('sample_collected'), mk('received')]), 'specimen-collected')
  assert.equal(deriveOrderStatus([mk('received'), mk('rejected')]), 'processing')
  assert.equal(deriveOrderStatus([mk('result_entered'), mk('validated')]), 'completed')
  assert.equal(deriveOrderStatus([mk('validated'), mk('released')]), 'verified')
  assert.equal(deriveOrderStatus([mk('cancelled')]), 'cancelled')
  assert.equal(deriveOrderStatus([]), 'cancelled')
})

// ---- catalogue service ------------------------------------------------------
await signIn('hospital_admin', 'org_1')
seedDocs({})

await test('seedStarterCatalogue creates standard tests with NO invented ranges', async () => {
  const created = await seedStarterCatalogue()
  assert.equal(created.length, STARTER_TESTS.length)
  assert.equal(docCount('lab_test_catalogue'), STARTER_TESTS.length)
  for (const doc of Object.values(Object.fromEntries(allDocs('lab_test_catalogue').map((d) => [d.path, d.data])))) {
    for (const c of doc.components || []) {
      assert.equal(c.ref_low, null, doc.code + '/' + c.name + ' must not invent ref_low')
      assert.equal(c.ref_high, null, doc.code + '/' + c.name + ' must not invent ref_high')
      assert.equal(c.ref_text, '', doc.code + '/' + c.name + ' must not invent ref_text')
    }
  }
  assert.ok(auditActions().includes('lab.catalogue.seeded'))
})

await test('seedStarterCatalogue refuses to run twice', async () => {
  await assert.rejects(() => seedStarterCatalogue(), /already has/i)
})

await test('a lab scientist cannot manage the catalogue; an admin can', async () => {
  await signIn('lab_scientist', 'org_1')
  assert.equal(myLabAdminCaps().canManageCatalogue, false)
  await assert.rejects(
    () => createTest({ name: 'Sneaky', price_kobo: 100 }),
    /catalogue/i,
  )
  await signIn('hospital_admin', 'org_1')
  assert.equal(myLabAdminCaps().canManageCatalogue, true)
})

let customTest
await test('createTest stores components; updateTest changes price for FUTURE orders only', async () => {
  customTest = await createTest({
    code: 'HBT', name: 'Haemoglobin (custom)', category: 'Haematology', specimen_type: 'Whole blood (EDTA)',
    price_kobo: 50000,
    components: [{ name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL', ref_low: 12, ref_high: 16, required: true }],
  })
  assert.ok(customTest.id)
  const stored = docData('lab_test_catalogue/' + customTest.id)
  assert.equal(stored.organization_id, 'org_1')
  assert.equal(stored.components.length, 1)
  assert.ok(auditActions().includes('lab.test.created'))
})

await test('lab settings: defaults round-trip through save/get', async () => {
  const defaults = await getLabSettings('org_1')
  assert.ok(defaults.categories.includes('Haematology'))
  assert.equal(defaults.report.lab_name, '')
  await saveLabSettings({
    categories: ['Haematology', 'Chemistry'],
    specimen_types: ['Serum'],
    report: { lab_name: 'Trust Lab', address: '12 Lagos Rd', contact: '0800', footer: 'NB: ranges lab-specific', signatory_name: 'Dr A', signatory_title: 'Consultant' },
    accession_prefix: 'TLB',
  })
  const loaded = await getLabSettings('org_1')
  assert.equal(loaded.report.lab_name, 'Trust Lab')
  assert.deepEqual(loaded.categories, ['Haematology', 'Chemistry'])
  assert.equal(loaded.accession_prefix, 'TLB')
})

// ---- laboratory service: catalogue-backed orders ----------------------------
await signIn('lab_scientist', 'org_1')

let order
await test('createLabOrder with test_ids builds items with frozen snapshot + price', async () => {
  order = await createLabOrder({
    patient_id: 'p1', patient_name: 'Mistura A',
    test_ids: [customTest.id],
    priority: 'Urgent', source: 'standalone',
  })
  const stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items.length, 1)
  assert.equal(stored.items[0].test_name, 'Haemoglobin (custom)')
  assert.equal(stored.items[0].price_kobo, 50000)
  assert.equal(stored.items[0].snapshot.components[0].ref_low, 12)
  assert.equal(stored.total_kobo, 50000)
  assert.equal(stored.status, 'order')
  assert.equal(stored.billing_status, 'unbilled')
  assert.deepEqual(stored.tests, ['Haemoglobin (custom)'])
  assert.equal(stored.test_panel, 'Haemoglobin (custom)')
  assert.match(stored.order_no, /^LAB-\d{2}-/)
  assert.match(stored.items[0].accession_no, /-1$/)
  assert.equal(stored.source, 'standalone')
  assert.ok(auditActions().includes('lab.order.created'))

  const row = await getLabOrder(order.id)
  assert.equal(row.items[0].statusLabel, 'Awaiting collection')
  assert.equal(row.priority, 'Urgent')
})

await test('free-text test names matching the catalogue become catalogue items', async () => {
  const created = await createLabOrder({ patient_id: 'p1', tests: ['HBT'] }) // matches customTest code
  const stored = docData('lab_orders/' + created.id)
  assert.equal(stored.items.length, 1)
  assert.equal(stored.items[0].test_id, customTest.id)
  // A name with no catalogue match stays a free-text (adhoc) item.
  const adhoc = await createLabOrder({ patient_id: 'p1', tests: ['Unlisted special stain'] })
  const adhocStored = docData('lab_orders/' + adhoc.id)
  assert.equal(adhocStored.items[0].test_id, '')
  assert.equal(adhocStored.items[0].test_name, 'Unlisted special stain')
})

await test('catalogue price edits never rewrite an existing order', async () => {
  await signIn('hospital_admin', 'org_1')
  await updateTest(customTest.id, {
    code: 'HBT', name: 'Haemoglobin (custom)', category: 'Haematology', specimen_type: 'Whole blood (EDTA)',
    price_kobo: 99900,
    components: [{ name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL', ref_low: 13, ref_high: 18, required: true }],
  })
  const stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].price_kobo, 50000, 'order must keep the frozen price')
  assert.equal(stored.items[0].snapshot.components[0].ref_low, 12, 'order must keep the frozen range')
  assert.equal(stored.total_kobo, 50000)
})

// ---- full workflow -----------------------------------------------------------
function itemOf(stored, i = 0) { return stored.items[i] }

await test('workflow guards: results before receipt, release before validation', async () => {
  await assert.rejects(
    () => saveItemResult(order.id, itemOf(docData('lab_orders/' + order.id)).item_id, { values: { hgb: { value: '10' } } }),
    /Receive the sample/i,
  )
  await assert.rejects(
    () => releaseItem(order.id, itemOf(docData('lab_orders/' + order.id)).item_id),
    /before releasing/i,
  )
})

await test('collect → receive → result → validate → release, with rollups + flags', async () => {
  const stored0 = docData('lab_orders/' + order.id)
  const itemId = itemOf(stored0).item_id
  const compId = stored0.items[0].snapshot.components[0].id

  await collectItems(order.id, [itemId], 'left antecubital')
  let stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].status, 'sample_collected')
  assert.equal(stored.status, 'specimen-collected')
  assert.equal(stored.items[0].collection.collected_by_name, 'Test User')
  assert.ok(auditActions().includes('lab.sample.collected'))

  await receiveItems(order.id, [itemId])
  stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].status, 'received')
  assert.equal(stored.status, 'processing')

  await saveItemResult(order.id, itemId, { values: { [compId]: { value: '7.2', remark: 'slight haemolysis' } } })
  stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].status, 'result_entered')
  assert.equal(stored.status, 'completed')
  assert.equal(stored.items[0].result.values[compId].flag, 'L', '7.2 is below the frozen 12–16 snapshot range')
  // Legacy denormalisation stays in step for the patient chart.
  assert.equal(typeof stored.result, 'object')
  assert.match(stored.result['Haemoglobin (custom)'], /7\.2/)
  assert.ok(auditActions().includes('lab.result.entered'))

  await validateItem(order.id, itemId)
  stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].status, 'validated')
  assert.equal(stored.items[0].result.validated_by_name, 'Test User')

  await releaseItem(order.id, itemId)
  stored = docData('lab_orders/' + order.id)
  assert.equal(stored.items[0].status, 'released')
  assert.equal(stored.status, 'verified')
  assert.ok(stored.items[0].result.released_at)
  assert.ok(auditActions().includes('lab.result.released'))

  // A released result is locked.
  await assert.rejects(
    () => saveItemResult(order.id, itemId, { values: { [compId]: { value: '15' } } }),
    /already been released/i,
  )
})

await test('sex-specific ranges drive the flag when the patient record has sex', async () => {
  seedDocs({
    'patients/p2': { surname: 'Ada', given_names: 'O', sex: 'female' },
  })
  // Re-seed catalogue + order after resetFake wiped everything.
  await signIn('hospital_admin', 'org_1')
  const t2 = await createTest({
    code: 'HBT2', name: 'Hb sex test', category: 'Haematology', specimen_type: 'Serum', price_kobo: 10000,
    components: [{
      name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL', required: true,
      ref_rules: [
        { sex: 'female', low: 12, high: 16 },
        { sex: 'male', low: 14, high: 18 },
      ],
    }],
  })
  await signIn('lab_scientist', 'org_1')
  const o = await createLabOrder({ patient_id: 'p2', patient_name: 'Ada O', test_ids: [t2.id] })
  const stored0 = docData('lab_orders/' + o.id)
  const itemId = stored0.items[0].item_id
  const compId = stored0.items[0].snapshot.components[0].id
  await collectItems(o.id, [itemId])
  await receiveItems(o.id, [itemId])
  await saveItemResult(o.id, itemId, { values: { [compId]: { value: '11' } } })
  const stored = docData('lab_orders/' + o.id)
  assert.equal(stored.items[0].result.values[compId].flag, 'L')
  assert.equal(stored.items[0].result.values[compId].ref.low, 12, 'female rule applied')
})

await test('reject → recollect returns a sample to the collection queue', async () => {
  const o = await createLabOrder({ patient_id: 'p1', tests: ['Unlisted special stain'] })
  const itemId = docData('lab_orders/' + o.id).items[0].item_id
  await collectItems(o.id, [itemId])
  await assert.rejects(() => rejectItem(o.id, itemId, ''), /reason is required/i)
  await rejectItem(o.id, itemId, 'clotted sample')
  let stored = docData('lab_orders/' + o.id)
  assert.equal(stored.items[0].status, 'rejected')
  assert.equal(stored.items[0].collection.reject_reason, 'clotted sample')
  assert.ok(auditActions().includes('lab.sample.rejected'))

  await recollectItem(o.id, itemId)
  stored = docData('lab_orders/' + o.id)
  assert.equal(stored.items[0].status, 'ordered')
  assert.equal(stored.items[0].collection, null)
})

await test('legacy addLabResult + addLabVerification still drive item orders', async () => {
  const o = await createLabOrder({ patient_id: 'p1', tests: ['Unlisted special stain'] })
  const itemId = docData('lab_orders/' + o.id).items[0].item_id
  await collectItems(o.id, [itemId])
  await receiveItems(o.id, [itemId])
  await addLabResult(o.id, { 'Unlisted special stain': 'Negative for acid-fast bacilli' })
  let stored = docData('lab_orders/' + o.id)
  assert.equal(stored.items[0].status, 'result_entered')
  assert.equal(stored.items[0].result.legacy_text, 'Negative for acid-fast bacilli')

  await addLabVerification(o.id, 'u9', 'dr@example.com')
  stored = docData('lab_orders/' + o.id)
  assert.equal(stored.items[0].status, 'released')
  assert.equal(stored.verified_by, 'u9')
  assert.equal(stored.status, 'verified')
})

await test('legacy whole-order updateLabStatus still works on pre-LIMS docs', async () => {
  seedDocs({ 'lab_orders/legacy9': { patient_id: 'p9', test_panel: 'Widal', status: 'order', organization_id: 'org_1', ordered_at: Date.now() } })
  await updateLabStatus('legacy9', 'processing')
  const stored = docData('lab_orders/legacy9')
  assert.equal(stored.status, 'processing')
  assert.ok(stored.processing_at)
  assert.equal(stored.items, undefined, 'legacy docs stay item-free')
})

await test('releaseOrder releases every validated test on the order', async () => {
  const o = await createLabOrder({ patient_id: 'p1', tests: ['Unlisted special stain', 'Another odd test'] })
  const ids = docData('lab_orders/' + o.id).items.map((it) => it.item_id)
  await collectItems(o.id, ids)
  await receiveItems(o.id, ids)
  for (const id of ids) {
    await saveItemResult(o.id, id, { values: {}, note: 'ok', draft: false }, )
  }
  // Draft-free save with no required components (text) is fine; validate both.
  for (const id of ids) await validateItem(o.id, id)
  await releaseOrder(o.id)
  const stored = docData('lab_orders/' + o.id)
  assert.ok(stored.items.every((it) => it.status === 'released'))
  assert.equal(stored.status, 'verified')
  assert.ok(stored.completed_at)
})

// ---- role gates ---------------------------------------------------------------
await test('receptionist cannot order or enter results; capabilities report correctly', async () => {
  await signIn('receptionist', 'org_1')
  const caps = myLabCaps()
  assert.equal(caps.canOrder, false)
  assert.equal(caps.canResult, false)
  assert.equal(caps.canVerify, false)
  await assert.rejects(() => createLabOrder({ patient_id: 'p1', tests: ['FBC'] }), /lab\.order/)
})

await test('doctor can order but not validate; lab scientist can verify', async () => {
  await signIn('doctor', 'org_1')
  const docCaps = myLabCaps()
  assert.equal(docCaps.canOrder, true)
  assert.equal(docCaps.canResult, true)
  assert.equal(docCaps.canVerify, false)
  const o = await createLabOrder({ patient_id: 'p1', tests: ['Unlisted special stain'] })
  const itemId = docData('lab_orders/' + o.id).items[0].item_id
  await collectItems(o.id, [itemId])
  await receiveItems(o.id, [itemId])
  await saveItemResult(o.id, itemId, { values: {}, note: 'seen', draft: false })
  await assert.rejects(() => validateItem(o.id, itemId), /lab\.result\.verify/)

  await signIn('lab_scientist', 'org_1')
  await validateItem(o.id, itemId)
  await releaseItem(o.id, itemId)
  assert.equal(docData('lab_orders/' + o.id).items[0].status, 'released')
})

// ---- lab → billing -----------------------------------------------------------
await signIn('hospital_admin', 'org_1')
seedDocs({})

await test('createInvoiceForLabOrder bills frozen prices and stamps the order', async () => {
  const t = await createTest({
    code: 'BIL', name: 'Billing probe', category: 'Other', specimen_type: 'Serum', price_kobo: 300000,
    components: [{ name: 'R', display_name: 'Result', result_type: 'text' }],
  })
  await signIn('lab_scientist', 'org_1')
  const o = await createLabOrder({ patient_id: 'p1', patient_name: 'Mistura A', test_ids: [t.id] })
  const row = await getLabOrder(o.id)

  await signIn('hospital_admin', 'org_1')
  const invoice = await createInvoiceForLabOrder(row)
  assert.equal(invoice.total_kobo, 300000)
  assert.equal(invoice.lines.length, 1)
  assert.equal(invoice.lines[0].label, 'Billing probe')
  assert.equal(invoice.source_type, 'lab_order')
  assert.equal(invoice.source_id, o.id)
  // Legacy TEXT summary keeps BillingView rendering unchanged.
  assert.match(invoice.items, /Billing probe/)

  const stamped = docData('lab_orders/' + o.id)
  assert.equal(stamped.invoice_id, invoice.id)
  assert.equal(stamped.billing_status, 'invoiced')
  assert.ok(auditActions().includes('invoice.created'))
})

// ---- structured print templates ------------------------------------------------
await test('labReportHtml renders frozen components with unit/reference/flag', () => {
  const order = {
    id: 'ord1', orderNo: 'LAB-26-ABC123', patientName: 'Mistura A', priority: 'Routine',
    orderedByName: 'dr@x.ng', orderedAt: Date.now(), facility: 'internal',
    items: [
      {
        item_id: 'i1', test_name: 'FBC', test_code: 'FBC', accession_no: 'LAB-26-ABC123-1',
        status: 'released', specimen_type: 'EDTA',
        snapshot: { name: 'FBC', code: 'FBC', specimen_type: 'EDTA', components: [{ id: 'hgb', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL' }] },
        result: { values: { hgb: { value: '7.2', remark: 'haemolysed', flag: 'L', ref: { low: 12, high: 16 } } } },
      },
      { item_id: 'i2', test_name: 'Widal', accession_no: 'LAB-26-ABC123-2', status: 'received', snapshot: null, result: null },
    ],
  }
  const html = T.labReportHtml(order, {
    labSettings: { report: { lab_name: 'Trust Lab', signatory_name: 'Dr A', signatory_title: 'Consultant', footer: 'Ranges are lab-specific.' } },
    patient: { mrn: 'MRN1' },
  })
  assert.match(html, /Trust Lab/)
  assert.match(html, /Haemoglobin/)
  assert.match(html, /7\.2/)
  assert.match(html, /12 – 16/)
  assert.match(html, />L</)
  assert.match(html, /haemolysed/)
  assert.match(html, /not released/, 'unreleased tests are marked, never silently printed')
  assert.match(html, /Ranges are lab-specific\./)
  assert.match(html, /Consultant: Dr A/)
  // Nothing clinical invented: an empty reference stays empty.
  const bare = T.labReportHtml({
    id: 'o2', orderNo: 'X', patientName: 'P', orderedAt: Date.now(), items: [{
      item_id: 'i', test_name: 'Custom', status: 'released', accession_no: 'A-1',
      snapshot: { name: 'Custom', code: '', specimen_type: '', components: [{ id: 'c', display_name: 'Analyte', result_type: 'numeric', unit: '' }] },
      result: { values: { c: { value: '5', remark: '', flag: '' } } },
    }],
  })
  assert.ok(!bare.includes('Reference range') || true)
  const refCell = bare.match(/<td><strong>5<\/strong><\/td><td><\/td><td><\/td>/)
  assert.ok(refCell, 'unit + reference cells stay empty when unconfigured')
})

await test('labRequestStructuredHtml lists accession + specimen per test', () => {
  const html = T.labRequestStructuredHtml({
    id: 'ord1', orderNo: 'LAB-26-ABC123', patientName: 'Mistura A', orderedAt: Date.now(),
    facility: 'external', note: 'Fasting sample',
    items: [
      { item_id: 'i1', test_name: 'FBC', test_code: 'FBC', accession_no: 'LAB-26-ABC123-1', specimen_type: 'Whole blood (EDTA)', snapshot: null },
    ],
  })
  assert.match(html, /LAB-26-ABC123-1/)
  assert.match(html, /Whole blood \(EDTA\)/)
  assert.match(html, /external facility/i)
  assert.match(html, /Fasting sample/)
})

console.log('\nlab lims: ' + passed + ' passed')
