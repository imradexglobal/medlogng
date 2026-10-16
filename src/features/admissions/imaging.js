// Pure (no Firebase) imaging-order domain helpers for the Admission Session.
// Modelled on features/encounters/domain.js and features/admissions/plan.js — no new
// capability strings, reuses the existing `lab.order` cap so no role migration is needed.

export const MODALITIES = ['X-ray', 'Ultrasound', 'CT', 'MRI', 'PET', 'Other']

export const IMAGING_STATUSES = ['order', 'accepted', 'in-progress', 'completed', 'verified', 'cancelled']

export function imagingStatus(raw) {
  if (!raw || typeof raw !== 'object') return 'order'
  const key = String(raw.status || '').trim().toLowerCase()
  const map = {
    order: 'order',
    accepted: 'accepted',
    inprogress: 'in-progress',
    in_progress: 'in-progress',
    'in-progress': 'in-progress',
    completed: 'completed',
    verified: 'verified',
    cancelled: 'cancelled',
  }
  return map[key] || 'order'
}

export function validateImagingOrder(v) {
  const values = v || {}
  const errors = []

  if (!String(values.modality || '').trim()) errors.push('Modality is required.')
  if (!String(values.study || '').trim()) errors.push('Study description is required.')
  if (!String(values.indication || '').trim()) errors.push('Indication is required.')

  const modality = String(values.modality || '').trim().toLowerCase()
  if (!MODALITIES.includes(modality) && modality !== 'other') errors.push(`Invalid modality: "${modality}". Must be one of: ${MODALITIES.join(', ')} or "other"`)

  return errors.length === 0 ? null : errors
}