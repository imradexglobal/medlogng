import { db, doc, writeBatch, Bytes, serverTimestamp } from '../firebase.js'

const parentPath = (kind) => kind === 'patient_photo' ? 'patient_photos' : 'result_images'

export function encodeBlobBase64(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const stride = 0x8000
    for (let i = 0; i < bytes.length; i += stride) {
      binary += String.fromCharCode(...bytes.subarray(i, i + stride))
    }
    return btoa(binary)
  })
}

export async function queueOfflineFile(args) {
  const { enqueue } = await import('./clinicalOutbox.js')
  await enqueue('file_upload', args)
  return { id: args.id, pendingSync: true }
}

export async function applyQueuedFileUpload(args) {
  const root = doc(db, parentPath(args.kind), args.id)
  const blob = doc(db, parentPath(args.kind), args.id, 'blob', 'data')
  const batch = writeBatch(db)
  if (args.remove) {
    batch.delete(root)
    batch.delete(blob)
  } else {
    const isPhoto = args.kind === 'patient_photo'
    batch.set(root, { ...args.metadata, ...(isPhoto ? { updated_at: serverTimestamp() } : { created_at: serverTimestamp() }) })
    batch.set(blob, {
      bytes: Bytes.fromBase64String(args.contentBase64),
      content_type: args.contentType,
      organization_id: args.metadata.organization_id,
    })
  }
  await batch.commit()
  return { id: args.id, removed: !!args.remove }
}