import { authStore } from '../store/authStore.js'
import { db, doc, updateDoc, serverTimestamp } from '../firebase.js'
import { getDocTolerant } from '../lib/offlineRead.js'
import { can } from '../features/admin/roles.js'
import {
  DEFAULT_PRINTING_SETTINGS,
  normalizePrintingSettings,
  validatePrintingSettings,
} from '../features/printing/domain.js'
import { logAudit } from './adminService.js'

const CACHE_KEY_PREFIX = 'medilogng.printingSettings.'
const CACHE_TTL_MS = 30_000
const cache = new Map()
const pendingReads = new Map()
let initialized = false
let observedContext = ''

function localKey(orgId) {
  return CACHE_KEY_PREFIX + encodeURIComponent(String(orgId || ''))
}

function readLocal(orgId) {
  if (!orgId || typeof localStorage === 'undefined') return null
  try {
    const saved = JSON.parse(localStorage.getItem(localKey(orgId)) || 'null')
    if (!saved || saved.organization_id !== orgId) return null
    const entry = {
      settings: normalizePrintingSettings(saved.settings),
      fetchedAt: Number(saved.fetched_at) || 0,
    }
    cache.set(orgId, entry)
    return entry
  } catch {
    return null
  }
}

function store(orgId, settings, fetchedAt = Date.now()) {
  const normalized = normalizePrintingSettings(settings)
  const entry = { settings: normalized, fetchedAt }
  cache.set(orgId, entry)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(localKey(orgId), JSON.stringify({
        organization_id: orgId,
        settings: normalized,
        fetched_at: fetchedAt,
      }))
    } catch { /* local persistence is an optimization; Firestore remains canonical */ }
  }
  return normalized
}

function isCurrentActiveHospitalMember(orgId) {
  const state = authStore.getState()
  return Boolean(
    orgId && state.user && state.activeOrg === orgId &&
    (state.memberships || []).some((item) => item.organization_id === orgId && item.status === 'active'),
  )
}

export function getCachedPrintingSettings(orgId) {
  if (!isCurrentActiveHospitalMember(orgId)) return { ...DEFAULT_PRINTING_SETTINGS }
  const entry = cache.get(orgId) || readLocal(orgId)
  return entry ? { ...entry.settings } : { ...DEFAULT_PRINTING_SETTINGS }
}

export function hasCachedPrintingSettings(orgId) {
  return Boolean(isCurrentActiveHospitalMember(orgId) && (cache.has(orgId) || readLocal(orgId)))
}

export async function getPrintingSettings(orgId, { forceRefresh = false } = {}) {
  if (!isCurrentActiveHospitalMember(orgId)) return { ...DEFAULT_PRINTING_SETTINGS }
  const current = cache.get(orgId) || readLocal(orgId)
  if (!forceRefresh && current && Date.now() - current.fetchedAt < CACHE_TTL_MS) {
    return { ...current.settings }
  }
  if (pendingReads.has(orgId)) return pendingReads.get(orgId)

  const request = (async () => {
    try {
      const snapshot = await getDocTolerant(doc(db, 'organizations', orgId))
      const org = snapshot.exists() ? snapshot.data() : null
      return store(orgId, org?.printing_configuration || DEFAULT_PRINTING_SETTINGS)
    } catch (error) {
      const fallback = cache.get(orgId) || readLocal(orgId)
      if (fallback) return { ...fallback.settings }
      throw error
    } finally {
      pendingReads.delete(orgId)
    }
  })()
  pendingReads.set(orgId, request)
  return request
}

export async function savePrintingSettings(orgId, input) {
  const state = authStore.getState()
  if (!orgId || state.activeOrg !== orgId) throw new Error('Select this hospital before changing its printing settings.')
  const membership = (state.memberships || []).find((item) => item.organization_id === orgId)
  if (!can(membership, 'admin.roles.manage')) {
    throw new Error('Hospital administrator access is required to change printing settings.')
  }

  const settings = validatePrintingSettings(input)
  await updateDoc(doc(db, 'organizations', orgId), {
    printing_configuration: {
      ...settings,
      updated_by: state.user?.uid || null,
      updated_at: serverTimestamp(),
    },
  })
  store(orgId, settings)
  void logAudit({
    action: 'org.printing_settings.updated',
    organizationId: orgId,
    details: `letterhead=${settings.letterhead_adjustment_enabled ? 'on' : 'off'} · offset=${settings.top_offset_mm}mm`,
  })
  return settings
}

export function initializePrintingSettings() {
  if (initialized) return
  initialized = true

  const refreshForCurrentHospital = (state = authStore.getState()) => {
    if (!state.ready || !state.user || !state.activeOrg) {
      observedContext = ''
      return
    }
    const key = `${state.user.uid}:${state.activeOrg}`
    if (key === observedContext) return
    observedContext = key
    void getPrintingSettings(state.activeOrg, { forceRefresh: true }).catch((error) => {
      console.info('[printing] hospital settings will use the saved local/default value:', error?.message || error)
    })
  }

  authStore.subscribe(refreshForCurrentHospital)
  refreshForCurrentHospital()
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      const state = authStore.getState()
      if (state.ready && state.user && state.activeOrg) {
        void getPrintingSettings(state.activeOrg, { forceRefresh: true }).catch(() => {})
      }
    })
  }
}
