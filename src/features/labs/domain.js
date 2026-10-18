// Laboratory domain logic — pure module (no Firebase imports, unit-testable).
//
// This is the single source of truth for the LIMS data shapes used by
// laboratoryService / labCatalogueService and the lab views:
//   - catalogue test + component definitions (result types, reference rules)
//   - per-test (ordered item) lifecycle statuses and the legacy order rollup
//   - reference-range resolution (general / sex / age specific)
//   - automatic L/H flag interpretation for numeric results
//   - configuration snapshots so historical reports never drift when the
//     catalogue is edited later
//
// Clinical values policy: this module ships NO fabricated reference ranges.
// Starter seed data (STARTER_TESTS) contains only widely standard test names,
// codes, categories, specimen types, result-component names and SI units —
// every range is left empty for the laboratory to configure itself.

// ---- catalogue shapes -------------------------------------------------------

// Component result types. The renderer switches on these; a new type can be
// added later by extending RESULT_TYPES and the result-entry switch without
// touching the stored data model.
export const RESULT_TYPES = [
  { value: 'numeric', label: 'Numeric (result + reference range + unit)' },
  { value: 'qualitative', label: 'Qualitative (e.g. Negative / Positive / Reactive)' },
  { value: 'selection', label: 'Selection (predefined options)' },
  { value: 'text', label: 'Text (free-text findings)' },
]

export const RESULT_TYPE_VALUES = RESULT_TYPES.map((t) => t.value)

export const DEFAULT_CATEGORIES = [
  'Haematology',
  'Clinical Chemistry',
  'Microbiology',
  'Serology / Immunology',
  'Parasitology',
  'Urinalysis',
  'Hormone Assay',
  'Blood Bank',
  'Other',
]

export const DEFAULT_SPECIMEN_TYPES = [
  'Whole blood (EDTA)',
  'Whole blood (plain)',
  'Serum',
  'Plasma (citrate)',
  'Plasma (fluoride)',
  'Urine',
  'Stool',
  'Seminal fluid',
  'Swab',
  'CSF',
  'Tissue',
  'Other',
]

export const ITEM_STATUS = {
  ORDERED: 'ordered',
  SAMPLE_COLLECTED: 'sample_collected',
  RECEIVED: 'received',
  RESULT_ENTERED: 'result_entered',
  VALIDATED: 'validated',
  RELEASED: 'released',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

export const ITEM_STATUS_FLOW = [
  ITEM_STATUS.ORDERED,
  ITEM_STATUS.SAMPLE_COLLECTED,
  ITEM_STATUS.RECEIVED,
  ITEM_STATUS.RESULT_ENTERED,
  ITEM_STATUS.VALIDATED,
  ITEM_STATUS.RELEASED,
]

export const ITEM_STATUS_META = {
  ordered: { label: 'Awaiting collection', cls: 'warn' },
  sample_collected: { label: 'Sample collected', cls: 'info' },
  received: { label: 'Received / processing', cls: 'info' },
  result_entered: { label: 'Awaiting validation', cls: 'warn' },
  validated: { label: 'Awaiting release', cls: 'info' },
  released: { label: 'Released', cls: 'ok' },
  rejected: { label: 'Rejected', cls: 'bad' },
  cancelled: { label: 'Cancelled', cls: 'bad' },
}

export const ORDER_SOURCES = ['hospital', 'standalone']

export const PRIORITIES = ['Routine', 'Urgent', 'STAT']

// ---- component helpers ------------------------------------------------------

let componentSeq = 0
export function newComponentId() {
  componentSeq += 1
  return 'c' + Date.now().toString(36) + componentSeq.toString(36)
}

export function newId(prefix) {
  componentSeq += 1
  return (prefix || 'it') + Date.now().toString(36) + componentSeq.toString(36)
}

// Validate + normalise one component coming from the catalogue editor.
// Returns { ok: true, component } or { ok: false, error }.
export function sanitizeComponent(raw, index = 0) {
  const name = String((raw && raw.name) || '').trim()
  if (!name) return { ok: false, error: 'Component ' + (index + 1) + ': name is required.' }
  if (name.length > 120) return { ok: false, error: 'Component ' + (index + 1) + ': name is too long.' }
  const resultType = String((raw && raw.result_type) || 'numeric').trim()
  if (!RESULT_TYPE_VALUES.includes(resultType)) {
    return { ok: false, error: name + ': unknown result type "' + resultType + '".' }
  }
  const component = {
    id: String((raw && raw.id) || '').trim() || newComponentId(),
    name,
    display_name: String((raw && raw.display_name) || '').trim() || name,
    result_type: resultType,
    unit: String((raw && raw.unit) || '').trim(),
    ref_text: String((raw && raw.ref_text) || '').trim(),
    options: Array.isArray(raw && raw.options)
      ? raw.options.map((o) => String(o || '').trim()).filter(Boolean)
      : [],
    ref_rules: Array.isArray(raw && raw.ref_rules)
      ? raw.ref_rules.map(sanitizeRefRule).filter(Boolean)
      : [],
    display_order: Number.isFinite(Number(raw && raw.display_order)) ? Number(raw.display_order) : index,
    active: raw && raw.active === false ? false : true,
    required: raw && raw.required === true,
  }
  const low = Number(raw && raw.ref_low)
  const high = Number(raw && raw.ref_high)
  component.ref_low = Number.isFinite(low) && String((raw && raw.ref_low) ?? '').trim() !== '' ? low : null
  component.ref_high = Number.isFinite(high) && String((raw && raw.ref_high) ?? '').trim() !== '' ? high : null
  if (component.ref_low != null && component.ref_high != null && component.ref_low > component.ref_high) {
    return { ok: false, error: name + ': lower reference limit is above the upper limit.' }
  }
  if (resultType === 'numeric' && component.ref_low == null && component.ref_high == null && !component.ref_text && !component.ref_rules.length) {
    // Allowed — ranges are optional and laboratory-configured. Nothing invented.
  }
  if ((resultType === 'qualitative' || resultType === 'selection') && !component.options.length) {
    return { ok: false, error: name + ': add at least one option for this result type.' }
  }
  return { ok: true, component }
}

function sanitizeRefRule(raw) {
  if (!raw) return null
  const sex = ['male', 'female'].includes(String(raw.sex || '').toLowerCase())
    ? String(raw.sex || '').toLowerCase()
    : ''
  const ageMin = raw.age_min === '' || raw.age_min == null ? null : Number(raw.age_min)
  const ageMax = raw.age_max === '' || raw.age_max == null ? null : Number(raw.age_max)
  const low = raw.low === '' || raw.low == null ? null : Number(raw.low)
  const high = raw.high === '' || raw.high == null ? null : Number(raw.high)
  const text = String(raw.text || '').trim()
  if (!sex && ageMin == null && ageMax == null) return null // a rule must specialise something
  return {
    sex,
    age_min: ageMin != null && Number.isFinite(ageMin) ? ageMin : null,
    age_max: ageMax != null && Number.isFinite(ageMax) ? ageMax : null,
    low: low != null && Number.isFinite(low) ? low : null,
    high: high != null && Number.isFinite(high) ? high : null,
    text,
  }
}

export function sortComponents(components) {
  return [...(components || [])]
    .map((c, i) => ({ ...c, display_order: Number.isFinite(Number(c.display_order)) ? Number(c.display_order) : i }))
    .sort((a, b) => a.display_order - b.display_order)
}

// Snapshot of the catalogue configuration frozen onto an ordered test item.
// The report and result-entry screens render from THIS snapshot, never from
// the live catalogue, so editing a test later cannot rewrite old reports.
export function snapshotTestConfig(test) {
  return {
    test_id: test.id,
    name: String(test.name || '').trim(),
    code: String(test.code || '').trim(),
    category: String(test.category || '').trim(),
    specimen_type: String(test.specimen_type || '').trim(),
    turnaround_hours: Number(test.turnaround_hours) || null,
    components: sortComponents(test.components)
      .filter((c) => c.active !== false)
      .map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.display_name || c.name,
        result_type: c.result_type || 'numeric',
        unit: c.unit || '',
        ref_low: c.ref_low ?? null,
        ref_high: c.ref_high ?? null,
        ref_text: c.ref_text || '',
        ref_rules: (c.ref_rules || []).map((r) => ({ ...r })),
        options: (c.options || []).map((o) => o),
        display_order: c.display_order,
        required: c.required === true,
      })),
  }
}

// ---- reference ranges + flags ------------------------------------------------

function ageYearsFrom(dob, now) {
  if (!dob) return null
  const d = new Date(dob)
  if (isNaN(d.getTime())) return null
  const ref = now ? new Date(now) : new Date()
  let age = ref.getFullYear() - d.getFullYear()
  const m = ref.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) age -= 1
  return age >= 0 ? age : null
}

// Pick the applicable reference for a component given the patient's sex and
// date of birth. Sex-specific beats general; among rules the FIRST matching
// rule wins (configuration order = priority). Returns
// { low, high, text } where every field may be null when the laboratory has
// not configured one — nothing is invented.
export function resolveReference(component, patient = {}) {
  return resolveReferenceFor(component, patientSex(patient), patient && patient.dob, patient && patient.now)
}

export function resolveReferenceFor(component, sex, dob, now) {
  if (!component) return { low: null, high: null, text: '' }
  const rules = Array.isArray(component.ref_rules) ? component.ref_rules : []
  const age = ageYearsFrom(dob, now)
  for (const r of rules) {
    if (r.sex && sex && r.sex !== sex) continue
    if (r.sex && !sex) continue
    if (r.age_min != null && (age == null || age < r.age_min)) continue
    if (r.age_max != null && (age == null || age > r.age_max)) continue
    if (r.age_min == null && r.age_max == null && !r.sex) continue
    return { low: r.low ?? null, high: r.high ?? null, text: r.text || '' }
  }
  return {
    low: component.ref_low ?? null,
    high: component.ref_high ?? null,
    text: component.ref_text || '',
  }
}

// Automatic interpretation for numeric results with a configured range.
// 'L' = below lower limit, 'H' = above upper limit, '' = within range or not
// interpretable (no range configured). No diagnosis is ever implied; a future
// critical-flag threshold can be layered on top of this same function.
export function computeFlag(value, ref) {
  const n = Number(value)
  if (value === '' || value == null || !Number.isFinite(n)) return ''
  if (!ref) return ''
  const low = ref.low != null && Number.isFinite(Number(ref.low)) ? Number(ref.low) : null
  const high = ref.high != null && Number.isFinite(Number(ref.high)) ? Number(ref.high) : null
  if (low != null && n < low) return 'L'
  if (high != null && n > high) return 'H'
  return ''
}

export const FLAG_LABELS = { L: 'Low', H: 'High', '': '' }

// ---- ordered items ----------------------------------------------------------

// Build a catalogue-backed ordered item. `priceKobo` and `snapshot` are
// frozen here and never re-read from the catalogue afterwards.
export function buildOrderItem({ test, itemIndex = 0, priceKobo = null }) {
  const snapshot = snapshotTestConfig(test)
  return {
    item_id: newId('itm'),
    test_id: test.id || '',
    test_code: snapshot.code,
    test_name: snapshot.name,
    category: snapshot.category,
    specimen_type: snapshot.specimen_type,
    price_kobo: (priceKobo != null && Number.isFinite(Number(priceKobo)))
      ? Number(priceKobo)
      : (Number(test.price_kobo ?? test.priceKobo) || 0), // accepts raw docs and camelCase service rows
    status: ITEM_STATUS.ORDERED,
    accession_no: '',
    snapshot,
    result: null,
    collection: null,
    history: [],
    created_item_index: itemIndex,
  }
}

// A free-text (non-catalogue) test — used for ad-hoc / external requests.
// It behaves like a single text component so the rest of the pipeline is
// uniform.
export function buildAdhocItem({ name, priceKobo = 0 }) {
  const clean = String(name || '').trim()
  const comp = sanitizeComponent({
    id: newComponentId(),
    name: 'Result',
    display_name: 'Result',
    result_type: 'text',
  })
  return {
    item_id: newId('itm'),
    test_id: '',
    test_code: '',
    test_name: clean,
    category: '',
    specimen_type: '',
    price_kobo: Number(priceKobo) || 0,
    status: ITEM_STATUS.ORDERED,
    accession_no: '',
    snapshot: {
      test_id: '',
      name: clean,
      code: '',
      category: '',
      specimen_type: '',
      turnaround_hours: null,
      components: [comp.component],
    },
    result: null,
    collection: null,
    history: [],
  }
}

// Read-time normalisation: an order written before the item model (or by an
// older client) only has `tests: string[]` + a free-text/map `result`. Those
// are promoted to virtual items so every screen handles one shape only.
export function normalizeLabItems(order) {
  if (!order) return []
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.map((it, i) => ({
      item_id: it.item_id || ('legacy-item-' + i),
      test_id: it.test_id || '',
      test_code: it.test_code || '',
      test_name: it.test_name || (typeof it === 'string' ? it : '') || 'Test',
      category: it.category || '',
      specimen_type: it.specimen_type || '',
      price_kobo: Number(it.price_kobo) || 0,
      status: it.status || ITEM_STATUS.ORDERED,
      accession_no: it.accession_no || '',
      snapshot: it.snapshot || null,
      result: it.result || null,
      collection: it.collection || null,
      history: Array.isArray(it.history) ? it.history : [],
      legacy: it.legacy === true,
    }))
  }
  // Legacy fallback.
  const names = Array.isArray(order.tests) && order.tests.length
    ? order.tests.map((t) => (typeof t === 'string' ? t : (t && t.name) || '')).map((t) => String(t).trim()).filter(Boolean)
    : (String(order.test_panel || '').trim() ? [String(order.test_panel).trim()] : [])
  const resultMap = (order.result && typeof order.result === 'object' && !Array.isArray(order.result)) ? order.result : null
  return names.map((name, i) => ({
    item_id: 'legacy-item-' + i,
    test_id: '',
    test_code: '',
    test_name: name,
    category: '',
    specimen_type: '',
    price_kobo: 0,
    status: legacyStatusToItemStatus(order.status),
    accession_no: '',
    snapshot: null,
    result: order.result == null || order.result === '' ? null : {
      values: {},
      legacy_text: resultMap ? String(resultMap[name] ?? '') : (names.length === 1 ? formatLegacyResult(order.result) : ''),
      entered_by: '',
      entered_by_name: '',
      entered_at: order.completed_at || null,
      validated_by: order.verified_by || '',
      validated_by_name: order.verified_by_name || '',
      validated_at: order.verified_at || null,
      released_by: order.verified_by || '',
      released_by_name: order.verified_by_name || '',
      released_at: order.verified_at || null,
    },
    collection: order.collected_at
      ? { collected_at: order.collected_at, collected_by: '', collected_by_name: '', received_at: null, received_by: '', received_by_name: '', reject_reason: '' }
      : null,
    history: [],
    legacy: true,
  }))
}

function formatLegacyResult(result) {
  if (result == null || result === '') return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(String).filter(Boolean).join('; ')
  return String(result)
}

export function legacyStatusToItemStatus(status) {
  switch (status) {
    case 'order': return ITEM_STATUS.ORDERED
    case 'accepted': return ITEM_STATUS.ORDERED
    case 'specimen-collected': return ITEM_STATUS.SAMPLE_COLLECTED
    case 'processing': return ITEM_STATUS.RECEIVED
    case 'completed': return ITEM_STATUS.RESULT_ENTERED
    case 'verified': return ITEM_STATUS.RELEASED
    case 'cancelled': return ITEM_STATUS.CANCELLED
    default: return ITEM_STATUS.ORDERED
  }
}

// Roll the per-item statuses back to the legacy order-level status so list
// views, reports and older modules keep reading one vocabulary. The LEAST
// advanced active item wins: a half-done order shows its earliest bottleneck.
export function deriveOrderStatus(items) {
  const active = (items || []).filter((it) => it.status !== ITEM_STATUS.CANCELLED)
  if (!active.length) return 'cancelled'
  if (!items || !items.length) return 'order'
  if (active.some((it) => it.status === ITEM_STATUS.ORDERED)) return 'order'
  if (active.some((it) => it.status === ITEM_STATUS.SAMPLE_COLLECTED)) return 'specimen-collected'
  if (active.some((it) => it.status === ITEM_STATUS.REJECTED)) return 'processing'
  if (active.some((it) => it.status === ITEM_STATUS.RECEIVED)) return 'processing'
  if (active.some((it) => it.status === ITEM_STATUS.RESULT_ENTERED)) return 'completed'
  // validated + released only
  return 'verified'
}

export function orderStatusFromItemsOrLegacy(order, items) {
  if (Array.isArray(order.items) && order.items.length) return deriveOrderStatus(items)
  return order.status || 'order'
}

// ---- accession / order numbers ----------------------------------------------

// Human-readable order number: LAB-YY-XXXXXX where XXXXXX is derived from the
// Firestore document id (unique, stable, no counter transaction required).
export function buildOrderNo(docId) {
  const yy = String(new Date().getFullYear()).slice(-2)
  const tail = String(docId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, 'X')
  return 'LAB-' + yy + '-' + tail
}

// Accession (specimen) number per ordered test: ORDERNO-1, ORDERNO-2 …
// A single string per item — a barcode can later encode exactly this value
// without any schema change.
export function buildAccessionNo(orderNo, index) {
  return String(orderNo || '') + '-' + (Number(index) + 1)
}

// ---- validation of results --------------------------------------------------

// Collect the values map the result-entry screen submits:
//   { [componentId]: { value, remark } }
// Returns { ok, values, error }. Required active components must be filled
// unless the whole item is being saved as a draft.
export function validateResultValues(snapshot, rawValues, { draft = false } = {}) {
  const components = (snapshot && Array.isArray(snapshot.components)) ? snapshot.components.filter((c) => c.active !== false) : []
  const values = {}
  for (const c of components) {
    const entry = rawValues && rawValues[c.id] ? rawValues[c.id] : {}
    const value = String(entry.value ?? '').trim()
    const remark = String(entry.remark ?? '').trim()
    if (value || remark) values[c.id] = { value, remark }
    else values[c.id] = { value: '', remark: '' }
  }
  if (draft) return { ok: true, values }
  const missing = components.filter((c) => c.required !== false && c.result_type !== 'text' && !String(values[c.id]?.value || '').trim())
  if (missing.length) {
    return { ok: false, values, error: 'Enter a result for: ' + missing.map((c) => c.display_name || c.name).join(', ') }
  }
  return { ok: true, values }
}

// Attach automatic flags to a saved values map (numeric components only).
export function flagValues(values, snapshot, patient) {
  const components = (snapshot && Array.isArray(snapshot.components)) ? snapshot.components : []
  const out = {}
  for (const c of components) {
    const entry = values && values[c.id] ? { ...values[c.id] } : { value: '', remark: '' }
    if (c.result_type === 'numeric') {
      const ref = resolveReferenceFor(c, patientSex(patient), patient && patient.dob, patient && patient.resultNow)
      entry.flag = computeFlag(entry.value, ref)
      entry.ref = ref
    } else {
      entry.flag = ''
      entry.ref = null
    }
    out[c.id] = entry
  }
  return out
}

function patientSex(patient) {
  const s = String((patient && patient.sex) || '').toLowerCase()
  if (s.startsWith('f')) return 'female'
  if (s.startsWith('m')) return 'male'
  return ''
}

// ---- printable rendering helpers -------------------------------------------

// One line of readable text for an item result (lists, patient chart, toast).
export function formatItemResultText(item) {
  if (!item || !item.result) return ''
  const r = item.result
  if (r.legacy_text) return String(r.legacy_text)
  const snapshot = item.snapshot
  const components = (snapshot && snapshot.components) || []
  const values = r.values || {}
  const parts = components.map((c) => {
    const v = values[c.id]
    if (!v || (v.value === '' && !v.remark)) return ''
    const flag = v.flag ? ' (' + v.flag + ')' : ''
    return (c.display_name || c.name) + ': ' + v.value + (c.unit && v.value ? ' ' + c.unit : '') + flag
  }).filter(Boolean)
  if (parts.length) return parts.join('; ')
  if (r.note) return String(r.note)
  return ''
}

// ---- starter catalogue seed -------------------------------------------------
// Standard test identity only: names, codes, categories, specimen types,
// widely-used SI unit labels and (for the FBC panel) the standard parameter
// names. Reference ranges are intentionally EMPTY — they vary by laboratory,
// analyser, methodology, age and sex and must be configured by the facility.

export const STARTER_TESTS = [
  {
    code: 'FBC', name: 'Full Blood Count (FBC)', category: 'Haematology', specimen_type: 'Whole blood (EDTA)', price_kobo: 900000,
    components: [
      { name: 'HGB', display_name: 'Haemoglobin', result_type: 'numeric', unit: 'g/dL' },
      { name: 'HCT', display_name: 'Haematocrit', result_type: 'numeric', unit: '%' },
      { name: 'RBC', display_name: 'Red blood cell count', result_type: 'numeric', unit: '10^12/L' },
      { name: 'WBC', display_name: 'White blood cell count', result_type: 'numeric', unit: '10^9/L' },
      { name: 'MCV', display_name: 'Mean corpuscular volume', result_type: 'numeric', unit: 'fL' },
      { name: 'MCH', display_name: 'Mean corpuscular haemoglobin', result_type: 'numeric', unit: 'pg' },
      { name: 'MCHC', display_name: 'Mean corpuscular Hb concentration', result_type: 'numeric', unit: 'g/dL' },
      { name: 'PLT', display_name: 'Platelet count', result_type: 'numeric', unit: '10^9/L' },
      { name: 'NEUT', display_name: 'Neutrophils', result_type: 'numeric', unit: '%' },
      { name: 'LYMPH', display_name: 'Lymphocytes', result_type: 'numeric', unit: '%' },
      { name: 'MONO', display_name: 'Monocytes', result_type: 'numeric', unit: '%' },
      { name: 'EOS', display_name: 'Eosinophils', result_type: 'numeric', unit: '%' },
      { name: 'BASO', display_name: 'Basophils', result_type: 'numeric', unit: '%' },
    ],
  },
  { code: 'ESR', name: 'ESR', category: 'Haematology', specimen_type: 'Whole blood (EDTA)', price_kobo: 250000, components: [{ name: 'ESR', display_name: 'Erythrocyte sedimentation rate', result_type: 'numeric', unit: 'mm/hr' }] },
  { code: 'BFMP', name: 'Blood film for parasites', category: 'Haematology', specimen_type: 'Whole blood (EDTA)', price_kobo: 300000, components: [{ name: 'PARASITES', display_name: 'Parasites seen', result_type: 'qualitative', options: ['Not seen', 'Seen'] }] },
  { code: 'BG', name: 'Blood group & genotype', category: 'Haematology', specimen_type: 'Whole blood (EDTA)', price_kobo: 200000, components: [{ name: 'BLOOD GROUP', display_name: 'Blood group', result_type: 'text' }, { name: 'GENOTYPE', display_name: 'Genotype', result_type: 'text' }] },
  { code: 'PT', name: 'Prothrombin time / INR', category: 'Haematology', specimen_type: 'Plasma (citrate)', price_kobo: 450000, components: [{ name: 'PT', display_name: 'Prothrombin time', result_type: 'numeric', unit: 's' }, { name: 'INR', display_name: 'INR', result_type: 'numeric', unit: '' }] },
  { code: 'MRTLDT', name: 'Malaria RDT', category: 'Parasitology', specimen_type: 'Whole blood (plain)', price_kobo: 250000, components: [{ name: 'MALARIA RDT', display_name: 'Malaria RDT', result_type: 'qualitative', options: ['Negative', 'Positive'] }] },
  { code: 'MP', name: 'Malaria Parasite (thick & thin film)', category: 'Parasitology', specimen_type: 'Whole blood (EDTA)', price_kobo: 350000, components: [{ name: 'MP', display_name: 'Malaria parasites', result_type: 'qualitative', options: ['Not seen', 'Seen'] }, { name: 'DENSITY', display_name: 'Parasite density', result_type: 'text' }] },
  { code: 'WIDAL', name: 'Widal test', category: 'Serology / Immunology', specimen_type: 'Serum', price_kobo: 300000, components: [{ name: 'WIDAL', display_name: 'Widal result', result_type: 'text' }] },
  { code: 'HBsAg', name: 'Hepatitis B surface antigen (HBsAg)', category: 'Serology / Immunology', specimen_type: 'Serum', price_kobo: 500000, components: [{ name: 'HBsAg', display_name: 'HBsAg', result_type: 'qualitative', options: ['Non-Reactive', 'Reactive'] }] },
  { code: 'HCV', name: 'Hepatitis C antibody (Anti-HCV)', category: 'Serology / Immunology', specimen_type: 'Serum', price_kobo: 500000, components: [{ name: 'HCV', display_name: 'Anti-HCV', result_type: 'qualitative', options: ['Non-Reactive', 'Reactive'] }] },
  { code: 'HIV', name: 'HIV screening', category: 'Serology / Immunology', specimen_type: 'Serum', price_kobo: 500000, components: [{ name: 'HIV', display_name: 'HIV screening', result_type: 'qualitative', options: ['Non-Reactive', 'Reactive', 'Indeterminate'] }] },
  { code: 'HCG', name: 'Pregnancy test (HCG)', category: 'Serology / Immunology', specimen_type: 'Urine', price_kobo: 200000, components: [{ name: 'HCG', display_name: 'Urine HCG', result_type: 'qualitative', options: ['Negative', 'Positive'] }] },
  { code: 'CRP', name: 'CRP', category: 'Serology / Immunology', specimen_type: 'Serum', price_kobo: 450000, components: [{ name: 'CRP', display_name: 'C-reactive protein', result_type: 'numeric', unit: 'mg/L' }] },
  { code: 'UA', name: 'Urinalysis', category: 'Urinalysis', specimen_type: 'Urine', price_kobo: 400000, components: [{ name: 'Physical', display_name: 'Physical', result_type: 'text' }, { name: 'Chemical', display_name: 'Chemical', result_type: 'text' }, { name: 'Microscopy', display_name: 'Microscopy', result_type: 'text' }] },
  { code: 'UCS', name: 'Urine culture & sensitivity', category: 'Microbiology', specimen_type: 'Urine', price_kobo: 800000, components: [{ name: 'CULTURE', display_name: 'Culture growth', result_type: 'text' }, { name: 'SENSITIVITY', display_name: 'Sensitivity', result_type: 'text' }] },
  { code: 'STOOL', name: 'Stool analysis', category: 'Parasitology', specimen_type: 'Stool', price_kobo: 350000, components: [{ name: 'Appearance', display_name: 'Appearance', result_type: 'text' }, { name: 'MUCUS', display_name: 'Mucus', result_type: 'qualitative', options: ['Absent', 'Present'] }, { name: 'BLOOD', display_name: 'Blood', result_type: 'qualitative', options: ['Absent', 'Present'] }, { name: 'OVA / PARASITES', display_name: 'Ova / parasites', result_type: 'text' }] },
  { code: 'LFT', name: 'Liver function test', category: 'Clinical Chemistry', specimen_type: 'Serum', price_kobo: 750000, components: [{ name: 'ALT', display_name: 'ALT (SGPT)', result_type: 'numeric', unit: 'U/L' }, { name: 'AST', display_name: 'AST (SGOT)', result_type: 'numeric', unit: 'U/L' }, { name: 'ALP', display_name: 'Alkaline phosphatase', result_type: 'numeric', unit: 'U/L' }, { name: 'TBIL', display_name: 'Total bilirubin', result_type: 'numeric', unit: 'µmol/L' }, { name: 'DBIL', display_name: 'Direct bilirubin', result_type: 'numeric', unit: 'µmol/L' }, { name: 'ALB', display_name: 'Albumin', result_type: 'numeric', unit: 'g/L' }] },
  { code: 'UE', name: 'Urea & electrolytes', category: 'Clinical Chemistry', specimen_type: 'Serum', price_kobo: 600000, components: [{ name: 'UREA', display_name: 'Urea', result_type: 'numeric', unit: 'mmol/L' }, { name: 'CREA', display_name: 'Creatinine', result_type: 'numeric', unit: 'µmol/L' }, { name: 'NA', display_name: 'Sodium', result_type: 'numeric', unit: 'mmol/L' }, { name: 'K', display_name: 'Potassium', result_type: 'numeric', unit: 'mmol/L' }, { name: 'CL', display_name: 'Chloride', result_type: 'numeric', unit: 'mmol/L' }] },
  { code: 'FBS', name: 'Fasting blood glucose', category: 'Clinical Chemistry', specimen_type: 'Plasma (fluoride)', price_kobo: 250000, components: [{ name: 'FBS', display_name: 'Fasting blood glucose', result_type: 'numeric', unit: 'mmol/L' }] },
  { code: 'RBS', name: 'Random blood sugar', category: 'Clinical Chemistry', specimen_type: 'Plasma (fluoride)', price_kobo: 250000, components: [{ name: 'RBS', display_name: 'Random blood sugar', result_type: 'numeric', unit: 'mmol/L' }] },
  { code: 'LIPID', name: 'Lipid profile', category: 'Clinical Chemistry', specimen_type: 'Serum', price_kobo: 800000, components: [{ name: 'CHOL', display_name: 'Total cholesterol', result_type: 'numeric', unit: 'mmol/L' }, { name: 'TG', display_name: 'Triglycerides', result_type: 'numeric', unit: 'mmol/L' }, { name: 'HDL', display_name: 'HDL cholesterol', result_type: 'numeric', unit: 'mmol/L' }, { name: 'LDL', display_name: 'LDL cholesterol', result_type: 'numeric', unit: 'mmol/L' }] },
  { code: 'HBA1C', name: 'HbA1c', category: 'Clinical Chemistry', specimen_type: 'Whole blood (EDTA)', price_kobo: 750000, components: [{ name: 'HBA1C', display_name: 'HbA1c', result_type: 'numeric', unit: '%' }] },
  { code: 'CREA', name: 'Serum creatinine', category: 'Clinical Chemistry', specimen_type: 'Serum', price_kobo: 300000, components: [{ name: 'CREA', display_name: 'Creatinine', result_type: 'numeric', unit: 'µmol/L' }] },
  { code: 'TFT', name: 'Thyroid function test', category: 'Hormone Assay', specimen_type: 'Serum', price_kobo: 1200000, components: [{ name: 'TSH', display_name: 'TSH', result_type: 'numeric', unit: 'mIU/L' }, { name: 'FT3', display_name: 'Free T3', result_type: 'numeric', unit: 'pmol/L' }, { name: 'FT4', display_name: 'Free T4', result_type: 'numeric', unit: 'pmol/L' }] },
]

export function starterTestToDoc(t, index) {
  const components = (t.components || []).map((c, i) => {
    const r = sanitizeComponent({ ...c, display_order: i }, i)
    if (!r.ok) throw new Error('starter test ' + t.code + ': ' + r.error)
    return r.component
  })
  return {
    code: t.code,
    name: t.name,
    category: t.category,
    specimen_type: t.specimen_type,
    price_kobo: Number(t.price_kobo) || 0,
    turnaround_hours: t.turnaround_hours ?? null,
    active: true,
    sort_order: index,
    components,
  }
}
