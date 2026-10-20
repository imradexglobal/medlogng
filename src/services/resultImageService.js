// Result image storage (direct Firestore, Spark plan: no Firebase Storage).
//
// Design (matches the "images without Storage" requirement):
//   result_images/{id}            — metadata only (safe to list; no binary).
//   result_images/{id}/blob/data  — the compressed image as Firestore Bytes.
//
// One image per document, one document per image. List queries read the parent
// collection, so the blob subcollection — and therefore the binary payload — is
// never downloaded when rendering an order's attachments.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, serverTimestamp, Bytes,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { currentStaffName } from '../lib/staffName.js'

const RESULT_IMAGES = 'result_images'
const BLOB_DOC = 'blob'
const BLOB_ID = 'data'

// Ceiling for a stored result image. The task requires <= 500 KB after
// compression; WebP at these settings clears it for typical phone photos.
export const MAX_IMAGE_BYTES = 500 * 1024

// A scanned PDF report is stored as-is (a scan is already a compact document),
// but Firestore caps a single document at ~1 MiB, so keep a margin below it.
export const MAX_PDF_BYTES = 900 * 1024

function isPdf(file) {
  return /application\/pdf/i.test(file?.type || '') || /\.pdf$/i.test(file?.name || '')
}

// ---- capability -------------------------------------------------------------
export function myResultImageCaps() {
  const me = myActiveMembership()
  // Result images are gated by the existing lab result-entry capability so no
  // role migration is needed (viewer chose this).
  return { membership: me, canUpload: can(me, 'lab.result.enter') }
}

function requireUpload() {
  if (!myResultImageCaps().canUpload) {
    throw new Error('Your role cannot attach result images (missing "lab.result.enter" capability). Ask an administrator to re-save your role.')
  }
}

// ---- geometry (pure, unit-testable) -----------------------------------------
// Scale a width/height so the longest side fits within maxDim, preserving
// aspect ratio. Never upscales.
export function fitWithin(w, h, maxDim) {
  const longest = Math.max(w || 0, h || 0)
  if (!longest || longest <= maxDim) return { width: Math.max(1, Math.round(w || 1)), height: Math.max(1, Math.round(h || 1)) }
  const ratio = maxDim / longest
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) }
}

// ---- compression (browser canvas) -------------------------------------------
function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).catch(() => loadViaImg(file))
  }
  return loadViaImg(file)
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')) }
    img.src = url
  })
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed.'))),
      'image/webp',
      quality,
    )
  })
}

// Compress to WebP under MAX_IMAGE_BYTES. First drops quality, then shrinks the
// dimensions — so a large but simple image keeps its resolution, while a noisy
// photo is downscaled only as much as needed.
export async function compressImage(file, { maxBytes = MAX_IMAGE_BYTES, maxDim = 1600 } = {}) {
  const src = await loadBitmap(file)
  const sw = src.width || src.naturalWidth || 0
  const sh = src.height || src.naturalHeight || 0
  if (!sw || !sh) throw new Error('That file could not be read as an image.')

  let { width, height } = fitWithin(sw, sh, maxDim)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image compression is not supported on this device.')

  let quality = 0.82
  let blob = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width
    canvas.height = height
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(src, 0, 0, width, height)
    blob = await canvasToBlob(canvas, quality)
    if (blob.size <= maxBytes) break
    if (quality > 0.42) {
      quality = Math.max(0.4, quality - 0.12)
    } else {
      const next = fitWithin(width, height, Math.round(Math.max(width, height) * 0.8))
      width = next.width
      height = next.height
    }
  }
  if (blob.size > maxBytes) {
    throw new Error('The image is still over 500 KB after compression. Try a smaller or simpler picture.')
  }
  if (src.close) { try { src.close() } catch { /* ignore */ } }
  return { blob, width, height }
}

// ---- write ------------------------------------------------------------------
export async function addResultImage({ kind, orderId, patientId, file, caption = '' }) {
  requireUpload()
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!orderId) throw new Error('An order id is required to attach a document.')
  if (!file) throw new Error('Choose a file to attach.')
  const pdf = isPdf(file)
  if (!pdf && !/^image\//i.test(file.type || '')) throw new Error('Attach an image or a PDF file.')

  const normalizedKind = kind === 'imaging' ? 'imaging' : 'lab'

  let blob
  let width = 0
  let height = 0
  if (pdf) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error('That PDF is over ' + Math.round(MAX_PDF_BYTES / 1024) + ' KB. Compress or split the scan first.')
    }
    blob = file
  } else {
    const compressed = await compressImage(file)
    blob = compressed.blob
    width = compressed.width
    height = compressed.height
  }

  const id = doc(collection(db, RESULT_IMAGES)).id
  const meta = {
    kind: normalizedKind,
    order_id: orderId,
    patient_id: patientId || '',
    organization_id: activeOrg,
    caption: String(caption || '').trim(),
    content_type: blob.type || (pdf ? 'application/pdf' : 'image/webp'),
    size_bytes: blob.size,
    width,
    height,
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: serverTimestamp(),
  }
  const buffer = await blob.arrayBuffer()
  await setDoc(doc(db, RESULT_IMAGES, id), meta)
  await setDoc(
    doc(db, RESULT_IMAGES, id, BLOB_DOC, BLOB_ID),
    {
      bytes: Bytes.fromUint8Array(new Uint8Array(buffer)),
      content_type: meta.content_type,
      organization_id: activeOrg,
    },
  )

  try {
    await logAudit({
      action: normalizedKind + '.result.image.added',
      organizationId: activeOrg,
      patientId: patientId || '',
      details: normalizedKind + ' result image for order ' + orderId + ' (' + meta.size_bytes + ' bytes)',
    })
  } catch (e) {
    console.warn('[resultImages] audit append failed:', e?.message)
  }
  return { id, ...meta }
}

// ---- read (metadata only) ---------------------------------------------------
export async function listResultImages({ kind, orderId }) {
  if (!orderId) return []
  const snap = await getDocs(query(collection(db, RESULT_IMAGES), where('order_id', '==', orderId)))
  const rows = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
  const filtered = kind ? rows.filter((r) => r.kind === kind) : rows
  filtered.sort((a, b) => tsMillis(a.created_at) - tsMillis(b.created_at))
  return filtered
}

function tsMillis(t) {
  return t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0)
}

// Fetch the binary for one image. Called only when the user opens it, never
// during a list render.
export async function getResultImageBlob(id) {
  const snap = await getDoc(doc(db, RESULT_IMAGES, id, BLOB_DOC, BLOB_ID))
  if (!snap.exists()) return null
  const data = snap.data() || {}
  const bytes = data.bytes
  const u8 = bytes instanceof Uint8Array ? bytes : (bytes && typeof bytes.toUint8Array === 'function' ? bytes.toUint8Array() : new Uint8Array())
  return new Blob([u8], { type: data.content_type || 'image/webp' })
}
