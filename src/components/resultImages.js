// Result-image attachment panel (Firestore Bytes, no Storage).
//
// Renders the metadata list for one order and lets a permitted user attach a
// new (compressed) image. Thumbnails are deliberately NOT auto-loaded: the
// binary lives in a subcollection and is fetched only when the user opens an
// image, so the list view never downloads blob data.
import { esc } from '../utils/sanitize.js'
import { toast, openModal, closeModal, wireToast } from './shell.js'
import {
  listResultImages, addResultImage, getResultImageBlob, myResultImageCaps, MAX_IMAGE_BYTES, MAX_PDF_BYTES,
} from '../services/resultImageService.js'
import { friendlyWriteError } from '../utils/errors.js'

function fmtBytes(n) {
  const b = Number(n || 0)
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'
  return (b / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtWhen(ts) {
  const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : (typeof ts === 'number' ? ts : 0)
  return ms ? new Date(ms).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

// Open one attachment: fetch the blob on demand, show it, allow save. Images
// are shown inline; a scanned PDF is embedded in the frame the device offers.
async function viewImage(id, caption) {
  openModal('Result document', '<p class="sub" id="riLoading">Loading…</p>')
  const body = document.getElementById('modalBody')
  const rebind = () => document.querySelectorAll('#modalBody [data-close]').forEach((b) => { b.onclick = closeModal })
  try {
    const blob = await getResultImageBlob(id)
    if (!blob) {
      if (body) { body.innerHTML = '<p class="sub">This document is no longer available.</p><div class="mrow"><button class="btn ghost" data-close>Close</button></div>'; rebind() }
      return
    }
    const url = URL.createObjectURL(blob)
    const isPdf = /application\/pdf/i.test(blob.type || '')
    const ext = isPdf ? 'pdf' : 'webp'
    if (body) {
      body.innerHTML =
        '<div style="text-align:center">' +
        (isPdf
          ? '<iframe src="' + url + '" title="' + esc(caption || 'Result document') + '" style="width:100%;height:65vh;border-radius:10px;border:1px solid #e2e8f0"></iframe>'
          : '<img src="' + url + '" alt="' + esc(caption || 'Result image') + '" style="max-width:100%;max-height:65vh;border-radius:10px;border:1px solid #e2e8f0">') +
        (caption ? '<p class="sub" style="margin-top:8px">' + esc(caption) + '</p>' : '') +
        '</div>' +
        '<div class="mrow"><a class="btn ghost" href="' + url + '" download="' + esc((caption || 'result-document')) + '.' + ext + '">Download</a>' +
        '<button class="btn ghost" data-close>Close</button></div>'
      rebind()
    }
  } catch (e) {
    const el = document.getElementById('riLoading')
    if (el) el.textContent = 'Could not load document: ' + friendlyWriteError(e)
  }
}

async function render(container, opts) {
  const { kind, orderId, patientId, canUpload, onChange } = opts
  let rows = []
  let listError = ''
  try {
    rows = await listResultImages({ kind, orderId })
  } catch (e) {
    // A brand-new collection fails its very first read if the latest security
    // rules have not been deployed yet. That is a deployment gap, not a
    // capability gap, so say so plainly instead of blaming the user's role.
    // The upload controls still render below so a permitted user is never left
    // without a place to attach an external report.
    const denied = (e?.code || '') === 'permission-denied' ||
      /insufficient permissions|permission-denied|permission_denied/i.test(String(e?.message || ''))
    listError = denied
      ? 'Result images are not enabled for this hospital yet — the latest database rules have not been deployed. Orders, results and printing still work. Ask an administrator to deploy the updated security rules.'
      : friendlyWriteError(e)
  }

  const list = listError
    ? '<p class="sub">Could not load attachments: ' + esc(listError) + '</p>'
    : rows.length
      ? rows.map((r) =>
          '<div class="ri-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9">' +
          '<div style="flex:1;min-width:0"><strong>' + esc(r.caption || 'Result document') + '</strong>' +
          (/application\/pdf/i.test(r.content_type || '') ? ' <span class="pill">PDF</span>' : '') +
          '<div class="mut" style="font-size:.75rem">' + esc(fmtWhen(r.created_at)) + ' · ' + esc(fmtBytes(r.size_bytes)) +
          (r.created_by_name ? ' · ' + esc(r.created_by_name) : '') + '</div></div>' +
          '<button class="btn ghost sm" data-view-image="' + esc(r.id) + '" data-caption="' + esc(r.caption || '') + '">View</button>' +
          '</div>').join('')
      : '<p class="mut" style="padding:6px 0">No result documents attached.</p>'

  const upload = canUpload
    ? '<div class="mrow" style="justify-content:flex-start;margin-top:10px;align-items:center">' +
        '<input type="file" accept="image/*,application/pdf" id="riFile" style="display:none">' +
        '<input type="file" accept="image/*" capture="environment" id="riCam" style="display:none">' +
        '<input class="input" id="riCaption" placeholder="Caption (optional)" style="max-width:200px">' +
        '<button class="btn sm" id="riPick">📎 Attach file</button>' +
        '<button class="btn ghost sm" id="riShoot">📷 Take photo</button>' +
      '</div>' +
      '<p class="sub" style="margin-top:6px">Attach an image (compressed to WebP ≤ ' + esc(fmtBytes(MAX_IMAGE_BYTES)) +
      ') or a scanned PDF (≤ ' + esc(fmtBytes(MAX_PDF_BYTES)) + '), chosen from the device or taken with the camera.</p>'
    : ''

  container.innerHTML = '<div class="ri-panel">' + list + upload + '</div>'

  container.querySelectorAll('[data-view-image]').forEach((b) => {
    b.onclick = () => viewImage(b.getAttribute('data-view-image'), b.getAttribute('data-caption'))
  })

  const pick = container.querySelector('#riPick')
  const shoot = container.querySelector('#riShoot')
  const fileInput = container.querySelector('#riFile')
  const camInput = container.querySelector('#riCam')

  const doUpload = async (input) => {
    const file = input && input.files && input.files[0]
    if (!file) return
    const caption = container.querySelector('#riCaption')?.value || ''
    const buttons = [pick, shoot].filter(Boolean)
    buttons.forEach((b) => { b.disabled = true })
    const pickLabel = pick ? pick.textContent : ''
    if (pick) pick.textContent = 'Uploading…'
    try {
      await addResultImage({ kind, orderId, patientId, file, caption })
      toast('Result document attached')
      if (onChange) onChange()
      await render(container, opts)
    } catch (e) {
      toast(friendlyWriteError(e, 'Upload failed'))
      buttons.forEach((b) => { b.disabled = false })
      if (pick) pick.textContent = pickLabel || '📎 Attach file'
    } finally {
      input.value = ''
    }
  }

  if (pick && fileInput) pick.onclick = () => fileInput.click()
  if (shoot && camInput) shoot.onclick = () => camInput.click()
  if (fileInput) fileInput.onchange = () => doUpload(fileInput)
  if (camInput) camInput.onchange = () => doUpload(camInput)
}

// Mount (or re-mount) an attachment panel into `container`.
export function mountResultImages(container, opts) {
  if (!container) return
  const canUpload = opts.canUpload != null ? opts.canUpload : myResultImageCaps().canUpload
  wireToast(document)
  render(container, { ...opts, canUpload })
}

export { viewImage }
