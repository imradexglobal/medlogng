// Laboratory test catalogue + laboratory settings data layer.
// Direct Firestore (Spark plan: no backend). Collections:
//   lab_test_catalogue/{testId} — org-scoped test definitions + components
//   lab_settings/{orgId}        — org-scoped categories / specimen types / report
// Writes are capability-gated by firestore.rules on `lab.catalogue.manage`.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'
import {
  sanitizeComponent, sortComponents, snapshotTestConfig, starterTestToDoc,
  DEFAULT_CATEGORIES, DEFAULT_SPECIMEN_TYPES, STARTER_TESTS, RESULT_TYPES, RESULT_TYPE_VALUES,
} from '../features/labs/domain.js'

const CATALOGUE = 'lab_test_catalogue'
const SETTINGS = 'lab_settings'

// ---- capability -------------------------------------------------------------
export function myLabAdminCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canManageCatalogue: can(me, 'lab.catalogue.manage'),
  }
}

function requireCatalogueManage() {
  if (!myLabAdminCaps().canManageCatalogue) {
    throw new Error('Your role cannot manage the laboratory catalogue (missing "lab.catalogue.manage" capability). Ask an administrator.')
  }
}

// ---- catalogue reads ---------------------------------------------------------
function toTestRow(r) {
  const components = sortComponents(r.components || [])
  return {
    id: r.id,
    organizationId: r.organization_id || '',
    code: r.code || '',
    name: r.name || '',
    category: r.category || '',
    specimenType: r.specimen_type || '',
    priceKobo: Number(r.price_kobo) || 0,
    turnaroundHours: r.turnaround_hours ?? null,
    active: r.active !== false,
    sortOrder: Number(r.sort_order) || 0,
    components,
    componentCount: components.length,
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    updatedAt: r.updated_at ? (typeof r.updated_at.toMillis === 'function' ? r.updated_at.toMillis() : r.updated_at) : 0,
    raw: r,
  }
}

export async function listOrgTests(orgId, { includeInactive = true } = {}) {
  const snap = await getDocs(query(collection(db, CATALOGUE), where('organization_id', '==', orgId)))
  let rows = snap.docs.map((d) => toTestRow({ ...d.data(), id: d.id }))
  if (!includeInactive) rows = rows.filter((t) => t.active)
  rows.sort((a, b) => {
    if (a.category !== b.category) return String(a.category).localeCompare(String(b.category))
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return String(a.name).localeCompare(String(b.name))
  })
  return rows
}

export function subscribeOrgTests(orgId, onRows, onError) {
  return watchQuery(
    query(collection(db, CATALOGUE), where('organization_id', '==', orgId), limit(500)),
    (d) => toTestRow({ ...d.data(), id: d.id }),
    (rows) => {
      rows.sort((a, b) => {
        if (a.category !== b.category) return String(a.category).localeCompare(String(b.category))
        return String(a.name).localeCompare(String(b.name))
      })
      onRows(rows)
    },
    onError,
  )
}

export async function getTest(tid) {
  const snap = await getDoc(doc(db, CATALOGUE, tid))
  if (!snap.exists()) return null
  return toTestRow({ ...snap.data(), id: snap.id })
}

// ---- catalogue writes --------------------------------------------------------
export function validateTestInput(v, existingComponents = []) {
  const name = String(v.name || '').trim()
  if (!name) return 'Test name is required.'
  const code = String(v.code || '').trim().toUpperCase()
  if (code.length > 20) return 'Test code must be 20 characters or fewer.'
  const price = Number(v.price_kobo)
  if (!Number.isFinite(price) || price < 0) return 'Price must be a positive amount.'
  return null
}

export async function createTest(input) {
  requireCatalogueManage()
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const err = validateTestInput(input)
  if (err) throw new Error(err)

  const components = []
  const list = Array.isArray(input.components) ? input.components : []
  for (let i = 0; i < list.length; i++) {
    const r = sanitizeComponent({ ...list[i], display_order: i }, i)
    if (!r.ok) throw new Error(r.error)
    components.push(r.component)
  }

  const tid = doc(collection(db, CATALOGUE)).id
  const now = serverTimestamp()
  const test = {
    organization_id: activeOrg,
    code: String(input.code || '').trim().toUpperCase(),
    name: String(input.name || '').trim(),
    category: String(input.category || '').trim(),
    specimen_type: String(input.specimen_type || '').trim(),
    price_kobo: Math.round(Number(input.price_kobo) || 0),
    turnaround_hours: input.turnaround_hours === '' || input.turnaround_hours == null ? null : Number(input.turnaround_hours),
    active: true,
    sort_order: Number(input.sort_order) || 0,
    components,
    created_by: user?.uid || null,
    created_by_name: user?.email || '',
    created_at: now,
    updated_at: now,
  }
  await setDoc(doc(db, CATALOGUE, tid), test)
  try {
    await logAudit({
      action: 'lab.test.created', organizationId: activeOrg,
      details: test.code + ' ' + test.name + ' · ' + components.length + ' component(s)',
    })
  } catch (e) { console.warn('[lab-catalogue] audit append failed:', e?.message) }
  return { id: tid, ...test }
}

// Update a test definition. The `history` of the change is captured on the
// audit trail; existing orders are unaffected because they carry a frozen
// configuration snapshot.
export async function updateTest(tid, input) {
  requireCatalogueManage()
  const { activeOrg } = authStore.getState()
  const existing = await getTest(tid)
  if (!existing) throw new Error('Test not found.')
  if (existing.organizationId !== activeOrg) throw new Error('That test belongs to another hospital.')

  const err = validateTestInput(input)
  if (err) throw new Error(err)

  const components = []
  const list = Array.isArray(input.components) ? input.components : []
  for (let i = 0; i < list.length; i++) {
    const r = sanitizeComponent({ ...list[i], display_order: i }, i)
    if (!r.ok) throw new Error(r.error)
    components.push(r.component)
  }

  const before = existing.priceKobo
  const patch = {
    code: String(input.code || '').trim().toUpperCase(),
    name: String(input.name || '').trim(),
    category: String(input.category || '').trim(),
    specimen_type: String(input.specimen_type || '').trim(),
    price_kobo: Math.round(Number(input.price_kobo) || 0),
    turnaround_hours: input.turnaround_hours === '' || input.turnaround_hours == null ? null : Number(input.turnaround_hours),
    sort_order: Number(input.sort_order) || 0,
    components,
    updated_at: serverTimestamp(),
  }
  await updateDoc(doc(db, CATALOGUE, tid), patch)
  try {
    await logAudit({
      action: 'lab.test.updated', organizationId: activeOrg,
      details: patch.code + ' ' + patch.name +
        (before !== patch.price_kobo ? ' · price ₦' + (before / 100) + ' → ₦' + (patch.price_kobo / 100) : ''),
    })
    if (before !== patch.price_kobo) {
      await logAudit({
        action: 'lab.test.price_changed', organizationId: activeOrg,
        details: patch.code + ' ' + patch.name + ' · ₦' + (before / 100) + ' → ₦' + (patch.price_kobo / 100),
      })
    }
  } catch (e) { console.warn('[lab-catalogue] audit append failed:', e?.message) }
  return getTest(tid)
}

export async function setTestActive(tid, active) {
  requireCatalogueManage()
  const { activeOrg } = authStore.getState()
  const existing = await getTest(tid)
  if (!existing) throw new Error('Test not found.')
  if (existing.organizationId !== activeOrg) throw new Error('That test belongs to another hospital.')
  await updateDoc(doc(db, CATALOGUE, tid), { active: !!active, updated_at: serverTimestamp() })
  try {
    await logAudit({
      action: active ? 'lab.test.activated' : 'lab.test.deactivated',
      organizationId: activeOrg, details: existing.code + ' ' + existing.name,
    })
  } catch (e) { console.warn('[lab-catalogue] audit append failed:', e?.message) }
  return true
}

// ---- starter catalogue seed -------------------------------------------------
// Inserts the standard starter tests ONLY when the hospital has none yet.
// Ranges are never invented — every seeded range stays empty and editable.
export async function seedStarterCatalogue() {
  requireCatalogueManage()
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const existing = await listOrgTests(activeOrg)
  if (existing.length) throw new Error('The catalogue already has ' + existing.length + ' test(s) — the starter set is only for new laboratories.')

  const now = serverTimestamp()
  const created = []
  for (let i = 0; i < STARTER_TESTS.length; i++) {
    const docIn = starterTestToDoc(STARTER_TESTS[i], i)
    const tid = doc(collection(db, CATALOGUE)).id
    await setDoc(doc(db, CATALOGUE, tid), {
      organization_id: activeOrg,
      ...docIn,
      created_by: user?.uid || null,
      created_by_name: user?.email || '',
      created_at: now,
      updated_at: now,
    })
    created.push({ id: tid, ...docIn })
  }
  try {
    await logAudit({
      action: 'lab.catalogue.seeded', organizationId: activeOrg,
      details: created.length + ' starter test definitions (no reference ranges preconfigured)',
    })
  } catch (e) { console.warn('[lab-catalogue] audit append failed:', e?.message) }
  return created
}

// ---- laboratory settings ------------------------------------------------------
export function defaultLabSettings(orgId) {
  return {
    organization_id: orgId,
    categories: [...DEFAULT_CATEGORIES],
    specimen_types: [...DEFAULT_SPECIMEN_TYPES],
    report: { lab_name: '', address: '', contact: '', footer: '', signatory_name: '', signatory_title: '' },
    accession_prefix: 'LAB',
    updated_at: null,
  }
}

export async function getLabSettings(orgId) {
  const snap = await getDoc(doc(db, SETTINGS, orgId))
  if (!snap.exists()) return defaultLabSettings(orgId)
  const r = snap.data()
  return {
    organization_id: orgId,
    categories: Array.isArray(r.categories) && r.categories.length ? r.categories : [...DEFAULT_CATEGORIES],
    specimen_types: Array.isArray(r.specimen_types) && r.specimen_types.length ? r.specimen_types : [...DEFAULT_SPECIMEN_TYPES],
    report: {
      lab_name: r.report?.lab_name || '',
      address: r.report?.address || '',
      contact: r.report?.contact || '',
      footer: r.report?.footer || '',
      signatory_name: r.report?.signatory_name || '',
      signatory_title: r.report?.signatory_title || '',
    },
    accession_prefix: r.accession_prefix || 'LAB',
    updated_at: r.updated_at || null,
  }
}

export async function saveLabSettings(input) {
  requireCatalogueManage()
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const cleanList = (arr, fallback) => {
    const out = (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim()).filter(Boolean)
    return out.length ? out : [...fallback]
  }
  const settings = {
    organization_id: activeOrg,
    categories: cleanList(input.categories, DEFAULT_CATEGORIES),
    specimen_types: cleanList(input.specimen_types, DEFAULT_SPECIMEN_TYPES),
    report: {
      lab_name: String(input.report?.lab_name || '').trim(),
      address: String(input.report?.address || '').trim(),
      contact: String(input.report?.contact || '').trim(),
      footer: String(input.report?.footer || '').trim(),
      signatory_name: String(input.report?.signatory_name || '').trim(),
      signatory_title: String(input.report?.signatory_title || '').trim(),
    },
    accession_prefix: String(input.accession_prefix || 'LAB').trim().toUpperCase().slice(0, 8) || 'LAB',
    updated_by: user?.uid || null,
    updated_at: serverTimestamp(),
  }
  await setDoc(doc(db, SETTINGS, activeOrg), settings, { merge: true })
  try {
    await logAudit({ action: 'lab.settings.updated', organizationId: activeOrg, details: settings.categories.length + ' categories · ' + settings.specimen_types.length + ' specimen types' })
  } catch (e) { console.warn('[lab-catalogue] audit append failed:', e?.message) }
  return settings
}

export { RESULT_TYPES, RESULT_TYPE_VALUES, DEFAULT_CATEGORIES, DEFAULT_SPECIMEN_TYPES }
