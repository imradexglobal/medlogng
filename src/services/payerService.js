// Payer / payment-type master list — the "Edit demographic → Payer" dropdown.
//
// Collection: `payers` (firestore.rules:284). Intentionally GLOBAL, not
// org-scoped: its read rule is `signedIn()`, and every hospital in the product
// shares one national list of payers (NHIA, HMOs, self-pay). It sits in the
// claims family `payers → plans → coverages → claims`; nothing else in src/
// read it before, so there is no competing meaning to preserve.
//
// OFFLINE-FIRST: the list is pulled from Firestore ONCE, held in memory and
// mirrored to localStorage. After that every dropdown read is served from the
// offline copy — no query, no spinner, works with the radio off. A background
// refresh only happens when the copy is older than FRESH_MS, so edits made on
// another device still arrive, without turning the list into a live listener.
//
// A patient/invoice stores the payer's `name` (a plain string), not the doc id,
// so renaming or deactivating a payer never rewrites or orphans history.
import {
  db, collection, query, getDocs, doc, setDoc, updateDoc, deleteDoc, serverTimestamp, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'

const COLLECTION = 'payers'
const CACHE_KEY = 'medilogng.payers.v1'
const FRESH_MS = 6 * 60 * 60 * 1000

export const PAYER_CATEGORIES = [
  { value: 'self', label: 'Self-pay / cash' },
  { value: 'government', label: 'Government scheme' },
  { value: 'hmo', label: 'HMO / insurer' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'other', label: 'Other' },
]

// Used only when the collection is genuinely empty (fresh install, never
// seeded). Once it holds any row the collection is authoritative and these
// are NOT merged back in — otherwise a deleted payer would keep reappearing.
export const FALLBACK_PAYERS = [
  { name: 'Self-pay', category: 'self', sort_order: 10 },
  { name: 'NHIA', category: 'government', sort_order: 20 },
  { name: 'HMO · Axa', category: 'hmo', sort_order: 30 },
  { name: 'HMO · Hygeia', category: 'hmo', sort_order: 40 },
]

// ---- capability gate ---------------------------------------------------------
// Mirrors the rules: `payers` write requires `billing.invoice` on the author's
// organization, which is why every write below carries `organization_id`.
export function myPayerCaps() {
  const me = myActiveMembership()
  return { membership: me, canManage: can(me, 'billing.invoice') }
}

// ---- row shaping -------------------------------------------------------------
function toPayerRow(d) {
  const data = d.data() || {}
  return {
    id: d.id,
    name: String(data.name || '').trim(),
    category: data.category || 'other',
    code: String(data.code || '').trim(),
    active: data.active !== false,
    sortOrder: Number.isFinite(Number(data.sort_order)) ? Number(data.sort_order) : 100,
    fallback: false,
  }
}

function byOrder(a, b) {
  if (a.active !== b.active) return a.active ? -1 : 1
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.name.localeCompare(b.name)
}

function fallbackRows() {
  return FALLBACK_PAYERS.map((p) => ({
    id: 'fallback:' + p.name, name: p.name, category: p.category, code: '',
    active: true, sortOrder: p.sort_order, fallback: true,
  }))
}

// ---- offline cache -----------------------------------------------------------
let mem = null // { at, rows }

function readSnapshot() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.rows)) return null
    return { at: Number(parsed.at) || 0, rows: parsed.rows.filter((r) => r && r.name) }
  } catch {
    return null
  }
}

function writeSnapshot(rows) {
  mem = { at: Date.now(), rows }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(mem)) } catch { /* quota — memory cache still works */ }
  return mem
}

// Cached copy on this device, or null if the list was never pulled.
export function cachedPayers() {
  const snap = mem || readSnapshot()
  return snap && snap.rows.length ? snap.rows.slice().sort(byOrder) : null
}

async function fetchFromCloud() {
  // Only attempt Firestore read when a user session is active
  // — avoids 'Missing or insufficient permissions' on the login page.
  const { user } = await import('../store/authStore.js').then(m => m.authStore.getState())
  if (!user || !user.uid) throw new Error('Not authenticated — skipping cloud fetch')
  const snap = await getDocs(query(collection(db, COLLECTION), limit(100)))
  return snap.docs.map(toPayerRow).filter((r) => r.name).sort(byOrder)
}

// ---- read --------------------------------------------------------------------
// Serves the offline copy when it is fresh; otherwise refreshes once from
// Firestore. Never rejects: a failed read degrades to cache, then to the
// built-in defaults, so a payer dropdown can never come up empty.
export async function listPayers({ force = false, maxAgeMs = FRESH_MS } = {}) {
  const snap = mem || readSnapshot()
  if (!force && snap && snap.rows.length && Date.now() - snap.at < maxAgeMs) {
    return snap.rows.slice().sort(byOrder)
  }
  try {
    const fetched = await fetchFromCloud()
    if (fetched.length) return writeSnapshot(fetched).rows.slice().sort(byOrder)
    if (snap && snap.rows.length) return snap.rows.slice().sort(byOrder)
    if (fetched.length === 0) {
      console.warn('[payers] collection "' + COLLECTION + '" is empty — using built-in defaults. Seed it from Administration → Payment types.')
    }
    return fallbackRows()
  } catch (e) {
    console.warn('[payers] list failed, serving offline copy:', e?.message)
    if (snap && snap.rows.length) return snap.rows.slice().sort(byOrder)
    return fallbackRows()
  }
}

// Warm the cache once per session. Call after login / on boot.
export function primePayers() {
  return listPayers().catch(() => fallbackRows())
}

// Drop the local copy (used when switching hospitals or signing out).
export function clearPayerCache() {
  mem = null
  try { localStorage.removeItem(CACHE_KEY) } catch { /* ignore */ }
}

// ---- options for <select> ----------------------------------------------------
// `current` matters: if a patient's stored payer was deactivated or renamed,
// the select would silently fall back to its first option and a plain save
// would overwrite the real value. It is appended as "(inactive)" instead.
export async function payerOptions(current) {
  const rows = await listPayers()
  const opts = rows
    .filter((r) => r.active !== false)
    .map((r) => ({ value: r.name, label: r.name, category: r.category }))
  const cur = String(current || '').trim()
  if (cur && !opts.some((o) => o.value === cur)) {
    opts.push({ value: cur, label: cur + ' (inactive)', category: 'other' })
  }
  return opts
}

// Plain string list, for chips and filters.
export async function payerNames({ activeOnly = true } = {}) {
  const rows = await listPayers()
  return rows.filter((r) => !activeOnly || r.active !== false).map((r) => r.name)
}

// ---- writes ------------------------------------------------------------------
function requireManage() {
  if (!myPayerCaps().canManage) {
    throw new Error('Your role cannot manage the payer list (missing "billing.invoice" capability).')
  }
}

// Create or update by name. Used by the dev-only Administration tab and by
// seeding; the dropdown itself only ever reads.
export async function savePayer(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  requireManage()

  const name = String(input.name || '').trim()
  if (name.length < 2) throw new Error('Payer name must be at least 2 characters.')

  const existing = (await listPayers()).find(
    // Fallback rows only exist while the collection is empty, so they must not
    // block promoting one of them into a real row.
    (r) => !r.fallback && r.name.toLowerCase() === name.toLowerCase() && r.id !== input.id,
  )
  if (existing) throw new Error('"' + name + '" is already in the payer list.')

  const now = serverTimestamp()
  const base = {
    name,
    category: input.category || 'other',
    code: String(input.code || '').trim(),
    active: input.active !== false,
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 100,
    organization_id: activeOrg, // provenance — the write rule requires it
    updated_at: now,
  }

  let id = String(input.id || '')
  if (id && !id.startsWith('fallback:')) {
    await updateDoc(doc(db, COLLECTION, id), base)
  } else {
    id = doc(collection(db, COLLECTION)).id
    await setDoc(doc(db, COLLECTION, id), { ...base, created_by: user?.uid || null, created_at: now })
  }

  await refreshCache()
  try {
    await logAudit({
      action: 'payer.' + (input.id ? 'updated' : 'created'),
      organizationId: activeOrg,
      details: name,
    })
  } catch (e) {
    console.warn('[payers] audit append failed:', e?.message)
  }
  return id
}

export async function setPayerActive(id, active) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!id || id.startsWith('fallback:')) throw new Error('This row is a built-in default — save it as a real payer first.')
  requireManage()
  await updateDoc(doc(db, COLLECTION, id), { active: !!active, updated_at: serverTimestamp() })
  await refreshCache()
  return true
}

export async function deletePayer(id) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!id || id.startsWith('fallback:')) throw new Error('Built-in defaults cannot be deleted.')
  requireManage()
  await deleteDoc(doc(db, COLLECTION, id))
  await refreshCache()
  try {
    await logAudit({ action: 'payer.deleted', organizationId: activeOrg, details: id })
  } catch (e) {
    console.warn('[payers] audit append failed:', e?.message)
  }
  return true
}

// Re-read the cloud list and overwrite the local copy (after a write, or when
// a developer forces a sync from the tab).
export async function refreshCache() {
  try {
    const fetched = await fetchFromCloud()
    if (fetched.length) return writeSnapshot(fetched).rows
    writeSnapshot([])
    return []
  } catch (e) {
    console.warn('[payers] refresh failed:', e?.message)
    return (mem && mem.rows) || []
  }
}
