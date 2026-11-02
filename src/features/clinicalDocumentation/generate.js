import { app, auth } from '../../firebase.js'

function isFirebaseHosted() {
  return ['medlogng.web.app', 'medlogng.firebaseapp.com'].includes(window.location.hostname.toLowerCase())
}

export async function generateClinicalDraft({ transcript, organizationId, patientId, encounterId }) {
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before generating a clinical draft.')
  if (!navigator.onLine) throw new Error('Clinical AI generation currently needs an online Host connection. Transcription remains available offline.')
  if (isFirebaseHosted()) {
    const { getFunctions, httpsCallable } = await import('firebase/functions')
    const call = httpsCallable(getFunctions(app, 'us-central1'), 'generateClinicalDraft', { timeout: 125_000 })
    const result = await call({ transcript, orgId: organizationId, patientId, encounterId })
    const data = result.data
    if (!data?.ok || !data.draft) throw new Error('Firebase clinical AI service did not return a draft.')
    if (data.binding?.uid !== user.uid || data.binding?.orgId !== organizationId || data.binding?.patientId !== patientId || data.binding?.encounterId !== encounterId) {
      throw new Error('The generated draft binding does not match the open consultation.')
    }
    return { draft: data.draft, metadata: data.metadata || null }
  }
  const token = await user.getIdToken()
  const response = await fetch(window.location.origin + '/clinical-drafts', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(125_000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web' },
    body: JSON.stringify({ transcript, orgId: organizationId, patientId, encounterId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok || !data.draft) throw new Error(data.error || 'Clinical AI service is unavailable in this deployment.')
  if (data.binding?.uid !== user.uid || data.binding?.organizationId !== organizationId || data.binding?.patientId !== patientId || data.binding?.encounterId !== encounterId) {
    throw new Error('The generated draft binding does not match the open consultation.')
  }
  return { draft: data.draft, metadata: data.metadata || null }
}

export async function auditClinicalDraftDecision({ organizationId, patientId, encounterId, action, acceptedSuggestions = [], rejectedSuggestions = [] }) {
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before reviewing a clinical draft.')
  if (!['approved', 'rejected'].includes(action)) throw new Error('Invalid clinical draft decision.')
  if (isFirebaseHosted()) {
    const { getFunctions, httpsCallable } = await import('firebase/functions')
    const call = httpsCallable(getFunctions(app, 'us-central1'), 'recordClinicalDraftReview')
    await call({ orgId: organizationId, patientId, encounterId, action, acceptedSuggestions, rejectedSuggestions })
    return
  }
  const response = await fetch(window.location.origin + '/clinical-drafts/review', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { authorization: 'Bearer ' + await user.getIdToken(), 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web' },
    body: JSON.stringify({ orgId: organizationId, patientId, encounterId, action, acceptedSuggestions, rejectedSuggestions }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) throw new Error(data.error || 'Clinical review could not be audited.')
}
