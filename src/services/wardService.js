// Ward master data layer (direct Firestore, Spark plan: no backend).
//
// Collection name MUST match firestore.rules (`wards`, guarded by the
// `beds.manage` capability for writes). Reads are signed-in.
// Every doc carries organization_id; writes MUST include it because the
// rules authorize on request.resource.data.organization_id.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'

const WARDS = 'wards'

export function myWardCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canManage: can(me, 'beds.manage'),
  }
}

function toWardRow(r) {
  return {
    id: r.id,
    name: r.name || '',
    totalBeds: Number(r.total_beds ?? r.totalBeds ?? 0),
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    raw: r,
  }
}

// Single equality filter only (no composite index, works offline).
function buildOrgWardsQuery(orgId) {
  return query(collection(db, WARDS), where('organization_id', '==', orgId))
}

function mapWardDoc(d) {
  return toWardRow({ ...d.data(), id: d.id })
}

function sortWards(rows) {
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export async function listOrgWards(orgId) {
  const snap = await getDocs(buildOrgWardsQuery(orgId))
  return sortWards(snap.docs.map(mapWardDoc))
}

// Same query, same ordering and row shape as listOrgWards, pushed on every
// change. AdmissionsView watches this so bed totals update live too.
export function subscribeOrgWards(orgId, onRows, onError) {
  return watchQuery(
    buildOrgWardsQuery(orgId),
    mapWardDoc,
    (rows) => onRows(sortWards(rows)),
    onError,
  )
}

export function validateWard(v) {
  if (!v.name || String(v.name).trim().length < 2) return 'Ward name is required.'
  if (!Number.isFinite(Number(v.total_beds)) || Number(v.total_beds) < 1) return 'Total beds must be at least 1.'
  return null
}

export async function createWard(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!myWardCaps().canManage) {
    throw new Error('Your role cannot manage wards (missing "beds.manage" capability). Ask an administrator.')
  }
  const invalid = validateWard(input)
  if (invalid) throw new Error(invalid)
  // Ward names are unique per hospital (client-side scan, offline-safe).
  const existing = await listOrgWards(activeOrg)
  if (existing.some((w) => w.name.toLowerCase() === String(input.name).trim().toLowerCase())) {
    throw new Error('A ward with this name already exists.')
  }
  const id = doc(collection(db, WARDS)).id
  const now = serverTimestamp()
  await setDoc(doc(db, WARDS, id), {
    name: String(input.name).trim(),
    total_beds: Number(input.total_beds),
    organization_id: activeOrg,
    created_by: user?.uid || null,
    created_at: now,
    updated_at: now,
  })
  try {
    await logAudit({ action: 'ward.created', organizationId: activeOrg, details: String(input.name).trim() + ' · ' + Number(input.total_beds) + ' beds' })
  } catch (e) {
    console.warn('[wards] audit append failed:', e?.message)
  }
  return id
}

export async function updateWardBeds(wardId, totalBeds) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!myWardCaps().canManage) {
    throw new Error('Your role cannot manage wards (missing "beds.manage" capability). Ask an administrator.')
  }
  if (!Number.isFinite(Number(totalBeds)) || Number(totalBeds) < 1) {
    throw new Error('Total beds must be at least 1.')
  }
  // organization_id is re-sent because the rules authorize writes on
  // request.resource.data.organization_id.
  await updateDoc(doc(db, WARDS, wardId), {
    total_beds: Number(totalBeds),
    organization_id: activeOrg,
    updated_at: serverTimestamp(),
  })
  try {
    await logAudit({ action: 'ward.updated', organizationId: activeOrg, details: wardId + ' → ' + Number(totalBeds) + ' beds' })
  } catch (e) {
    console.warn('[wards] audit append failed:', e?.message)
  }
  return true
}
