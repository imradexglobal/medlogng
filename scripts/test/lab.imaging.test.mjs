// Tests for the multi-test lab / multi-study imaging upgrade:
//   - pure row normalisers (tests[] / studies[] with legacy fallback),
//   - the service write path (tests[]/studies[] + denormalised summary),
//   - the printable document builders,
//   - the result-image geometry helper.
// Run: node scripts/test/lab.imaging.test.mjs
import assert from 'node:assert/strict'
import { signIn, seedDocs, docData } from './harness.mjs'

const {
  normalizeTests, formatTestResult, normalizeTestInput,
  createLabOrder, getLabOrder,
} = await import('../../src/services/laboratoryService.js')
const {
  normalizeStudies, normalizeStudyInput, normalizeImagingItems, normalizeImagingInput,
  createImagingOrder, getImagingOrder,
} = await import('../../src/services/imagingService.js')
const { fitWithin } = await import('../../src/services/resultImageService.js')
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

await test('normalizeTests promotes a legacy test_panel to a one-element list', () => {
  assert.deepEqual(normalizeTests({ test_panel: 'FBC' }), ['FBC'])
  assert.deepEqual(normalizeTests({}), [])
})

await test('normalizeTests prefers an explicit tests[] array', () => {
  assert.deepEqual(normalizeTests({ test_panel: 'FBC, ESR', tests: ['FBC', 'ESR'] }), ['FBC', 'ESR'])
  assert.deepEqual(normalizeTests({ tests: [{ name: 'FBC' }, 'ESR', ''] }), ['FBC', 'ESR'])
})

await test('formatTestResult renders strings and per-test object maps', () => {
  assert.equal(formatTestResult('5.4 mmol/L'), '5.4 mmol/L')
  assert.equal(formatTestResult({ FBC: 'Normal', ESR: '12' }), 'FBC: Normal; ESR: 12')
  assert.equal(formatTestResult({ FBC: '' }), 'FBC')
  assert.equal(formatTestResult(null), '')
})

await test('normalizeTestInput splits on a tests[] array and joins the summary', () => {
  assert.deepEqual(normalizeTestInput({ tests: ['FBC', ' ESR ', ''] }), { tests: ['FBC', 'ESR'], summary: 'FBC, ESR' })
  assert.deepEqual(normalizeTestInput({ test_panel: 'Widal' }), { tests: ['Widal'], summary: 'Widal' })
})

await test('normalizeStudies / normalizeStudyInput mirror the lab helpers', () => {
  assert.deepEqual(normalizeStudies({ study: 'Chest X-ray' }), ['Chest X-ray'])
  assert.deepEqual(normalizeStudyInput({ studies: ['Chest X-ray', 'Echo'] }), { studies: ['Chest X-ray', 'Echo'], summary: 'Chest X-ray, Echo' })
})

// ---- service write path ----------------------------------------------------
await signIn('lab_scientist', 'org_1')
seedDocs({})

await test('createLabOrder stores tests[] plus a denormalised summary', async () => {
  const created = await createLabOrder({ patient_id: 'patient-001', patient_name: 'Mistura A', tests: ['FBC', 'ESR'] })
  const stored = docData('lab_orders/' + created.id)
  assert.deepEqual(stored.tests, ['FBC', 'ESR'])
  assert.equal(stored.test_panel, 'FBC, ESR')

  const row = await getLabOrder(created.id)
  assert.deepEqual(row.tests, ['FBC', 'ESR'])
  assert.equal(row.testPanel, 'FBC, ESR')
})

await test('createLabOrder refuses an order with no tests', async () => {
  await assert.rejects(
    () => createLabOrder({ patient_id: 'patient-001', tests: [] }),
    /at least one test/i,
  )
})

await test('a legacy lab order reads back as a single-test list', async () => {
  seedDocs({ 'lab_orders/legacy1': { patient_id: 'p1', test_panel: 'Urinalysis', status: 'order', ordered_at: Date.now() } })
  const row = await getLabOrder('legacy1')
  assert.deepEqual(row.tests, ['Urinalysis'])
  assert.equal(row.resultDisplay, '')
})

await test('createImagingOrder stores studies[] plus a denormalised summary', async () => {
  const created = await createImagingOrder({ patient_id: 'patient-001', modality: 'X-ray', studies: ['Chest PA', 'Lateral'] })
  const stored = docData('imaging_orders/' + created.id)
  assert.deepEqual(stored.studies, ['Chest PA', 'Lateral'])
  assert.equal(stored.study, 'Chest PA, Lateral')

  const row = await getImagingOrder(created.id)
  assert.deepEqual(row.studies, ['Chest PA', 'Lateral'])
})

// ---- imaging multi-modality ------------------------------------------------
await test('normalizeImagingItems promotes a legacy order to modality+study pairs', () => {
  assert.deepEqual(
    normalizeImagingItems({ modality: 'X-ray', studies: ['Chest PA', 'Lateral'] }),
    [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'X-ray', study: 'Lateral' }],
  )
  assert.deepEqual(normalizeImagingItems({ modality: 'CT', study: 'Head' }), [{ modality: 'CT', study: 'Head' }])
  assert.deepEqual(normalizeImagingItems({}), [])
})

await test('normalizeImagingInput keeps each study with its own modality', () => {
  const out = normalizeImagingInput({
    items: [
      { modality: 'X-ray', study: 'Chest PA' },
      { modality: 'MRI', study: 'Brain' },
      { modality: '', study: '' },
    ],
  })
  assert.deepEqual(out.items, [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'MRI', study: 'Brain' }])
  assert.deepEqual(out.modalities, ['X-ray', 'MRI'])
  assert.deepEqual(out.studies, ['Chest PA', 'Brain'])
  assert.equal(out.summary, 'Chest PA, Brain')
})

await test('one imaging order can request several modalities at once', async () => {
  const created = await createImagingOrder({
    patient_id: 'patient-001', patient_name: 'Mistura A',
    items: [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'MRI', study: 'Brain' }],
  })
  const stored = docData('imaging_orders/' + created.id)
  assert.deepEqual(stored.items, [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'MRI', study: 'Brain' }])
  assert.deepEqual(stored.modalities, ['X-ray', 'MRI'])
  assert.deepEqual(stored.studies, ['Chest PA', 'Brain'])

  const row = await getImagingOrder(created.id)
  assert.deepEqual(row.items, [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'MRI', study: 'Brain' }])
})

await test('createImagingOrder refuses an order with no studies', async () => {
  await assert.rejects(
    () => createImagingOrder({ patient_id: 'patient-001', items: [] }),
    /at least one imaging study/i,
  )
})

// ---- external facility -----------------------------------------------------
await test('lab and imaging orders record an external facility', async () => {
  const lab = await createLabOrder({ patient_id: 'patient-001', tests: ['FBC'], facility: 'external' })
  assert.equal(docData('lab_orders/' + lab.id).facility, 'external')
  const img = await createImagingOrder({ patient_id: 'patient-001', modality: 'X-ray', studies: ['Chest PA'], facility: 'external' })
  assert.equal(docData('imaging_orders/' + img.id).facility, 'external')
  // Default stays internal so existing callers are unaffected.
  const internal = await createLabOrder({ patient_id: 'patient-001', tests: ['ESR'] })
  assert.equal(docData('lab_orders/' + internal.id).facility, 'internal')
})

await test('external request slips tell the patient to bring the report back', () => {
  const lab = T.labRequestHtml({ patientName: 'Mistura', tests: ['FBC'], facility: 'external' })
  assert.match(lab, /external facility/i)
  const img = T.imagingRequestHtml({
    patientName: 'Mistura', items: [{ modality: 'X-ray', study: 'Chest PA' }, { modality: 'MRI', study: 'Brain' }], facility: 'external',
  })
  assert.match(img, /<td>X-ray<\/td><td>Chest PA<\/td>/)
  assert.match(img, /<td>MRI<\/td><td>Brain<\/td>/)
  assert.match(img, /external facility/i)
})

// ---- print templates -------------------------------------------------------
await test('lab request/report templates list every test', () => {
  const req = T.labRequestHtml({ hospitalName: 'Test Hosp', patientName: 'Mistura', tests: ['FBC', 'ESR'], orderId: 'abcdef123456' })
  assert.match(req, /FBC/)
  assert.match(req, /ESR/)
  assert.match(req, /Laboratory request/)

  const res = T.labResultHtml({ patientName: 'Mistura', tests: ['FBC', 'ESR'], result: { FBC: 'Normal', ESR: '12' } })
  assert.match(res, /<td>FBC<\/td><td>Normal<\/td>/)
  assert.match(res, /<td>ESR<\/td><td>12<\/td>/)
})

await test('imaging request/report templates include studies and indication', () => {
  const req = T.imagingRequestHtml({ modality: 'X-ray', studies: ['Chest PA'], indication: 'Chronic cough' })
  assert.match(req, /Chest PA/)
  assert.match(req, /Chronic cough/)

  const res = T.imagingResultHtml({ modality: 'X-ray', studies: ['Chest PA'], result: 'No consolidation.' })
  assert.match(res, /No consolidation\./)
})

await test('template builders escape untrusted patient text', () => {
  const req = T.labRequestHtml({ patientName: '<script>alert(1)</script>', tests: ['FBC'] })
  assert.ok(!req.includes('<script>'), 'raw markup must not survive')
  assert.match(req, /&lt;script&gt;/)
})

// ---- result-image geometry -------------------------------------------------
await test('fitWithin scales the longest side and never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 })
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 })
  assert.deepEqual(fitWithin(0, 0, 1600), { width: 1, height: 1 })
})

console.log('\nlab & imaging: ' + passed + ' passed')
