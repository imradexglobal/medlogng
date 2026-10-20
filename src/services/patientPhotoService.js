// Patient photo storage (direct Firestore, Spark plan: no Firebase Storage).
//
// Design (mirrors resultImageService.js):
//   patient_photos/{pid}            — metadata only (safe to list; no binary).
//   patient_photos/{pid}/blob/data  — the compressed photo as Firestore Bytes.
//
// One photo per patient. The blob subcollection is never downloaded when
// rendering the patient header — only the small metadata doc is read, and the
// binary is fetched on demand when the photo is opened.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, deleteDoc, writeBatch, serverTimestamp, Bytes,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { currentStaffName } from '../lib/staffName.js'

const PATIENT_PHOTOS = 'patient_photos'
const BLOB_DOC = 'blob'
const BLOB_ID = 'data'

// Ceiling for a stored patient photo. WebP at these settings clears it for
// typical phone photos.
export const MAX_PHOTO_BYTES = 500 * 1024

function requirePhoto() {
  const me = myActiveMembership()
  if (!can(me, 'patient.demographics.update')) {
    throw new Error('Your role cannot change patient photos (missing "patient.demographics.update" capability). Ask an administrator to re-save your role.')
  }
}

// Reuse the proven compression geometry from resultImageService.
export { fitWithin, compressImage } from './resultImageService.js'

// ---- write ------------------------------------------------------------------
export async function upsertPatientPhoto({ pid, file }) {
  requirePhoto()
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!pid) throw new Error('A patient id is required.')
  if (!file) throw new Error('Choose a photo to upload.')
  if (!/^image\//i.test(file.type || '')) throw new Error('Attach an image file.')

  const compressed = await compressImage(file, { maxBytes: MAX_PHOTO_BYTES, maxDim: 1200 })
  const blob = compressed.blob

  const metaRef = doc(db, PATIENT_PHOTOS, pid)
  const meta = {
    patient_id: pid,
    organization_id: activeOrg,
    content_type: blob.type || 'image/webp',
    size_bytes: blob.size,
    width: compressed.width,
    height: compressed.height,
    updated_by: user?.uid || null,
    updated_by_name: currentStaffName(),
    updated_at: serverTimestamp(),
  }
  const buffer = await blob.arrayBuffer()

  const batch = writeBatch(db)
  batch.set(metaRef, meta)
  batch.set(
    doc(db, PATIENT_PHOTOS, pid, BLOB_DOC, BLOB_ID),
    {
      bytes: Bytes.fromUint8Array(new Uint8Array(buffer)),
      content_type: meta.content_type,
      organization_id: activeOrg,
    },
  )
  await batch.commit()

  try {
    await logAudit({
      action: 'patient.photo.updated',
      organizationId: activeOrg,
      patientId: pid,
      details: 'patient photo · ' + meta.size_bytes + ' bytes',
    })
  } catch (e) {
    console.warn('[patientPhoto] audit append failed:', e?.message)
  }
  return { pid, ...meta }
}

// ---- read (metadata only) ---------------------------------------------------
export async function getPatientPhotoMeta(pid) {
  if (!pid) return null
  const snap = await getDoc(doc(db, PATIENT_PHOTOS, pid))
  if (!snap.exists()) return null
  return { ...snap.data(), id: snap.id }
}

// Fetch the binary for one photo. Called only when the user opens it, never
// during a list/header render.
export async function getPatientPhotoBlob(pid) {
  if (!pid) return null
  const snap = await getDoc(doc(db, PATIENT_PHOTOS, pid, BLOB_DOC, BLOB_ID))
  if (!snap.exists()) return null
  const data = snap.data() || {}
  const bytes = data.bytes
  const u8 = bytes instanceof Uint8Array ? bytes : (bytes && typeof bytes.toUint8Array === 'function' ? bytes.toUint8Array() : new Uint8Array())
  return new Blob([u8], { type: data.content_type || 'image/webp' })
}

// Remove a patient's photo (and its blob).
export async function removePatientPhoto(pid) {
  requirePhoto()
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!pid) throw new Error('A patient id is required.')

  const batch = writeBatch(db)
  batch.delete(doc(db, PATIENT_PHOTOS, pid, BLOB_DOC, BLOB_ID))
  batch.delete(doc(db, PATIENT_PHOTOS, pid))
  await batch.commit()

  try {
    await logAudit({
      action: 'patient.photo.removed',
      organizationId: activeOrg,
      patientId: pid,
      details: 'patient photo removed',
    })
  } catch (e) {
    console.warn('[patientPhoto] audit append failed:', e?.message)
  }
}
