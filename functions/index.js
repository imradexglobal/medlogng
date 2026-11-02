import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { validateClinicalDraft } from './draftValidation.js'
import { generateStructuredDraft } from './clinicalAiProvider.js'

if (!getApps().length) initializeApp()
const db = getFirestore()

function fail(code, message) { throw new HttpsError(code, message) }

async function authorizedEncounter(request, data) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in is required.')
  const { orgId, patientId, encounterId } = data
  if (![orgId, patientId, encounterId].every((value) => typeof value === 'string' && value.length > 0)) {
    fail('invalid-argument', 'Organization, patient and encounter are required.')
  }
  const uid = request.auth.uid
  const member = await db.collection('organization_memberships').doc(orgId + '_' + uid).get()
  const membership = member.exists ? member.data() : null
  const caps = Array.isArray(membership?.capabilities) ? membership.capabilities : []
  if (membership?.status !== 'active' || !(caps.includes('*') || caps.includes('encounter.edit'))) {
    fail('permission-denied', 'Active membership with encounter.edit is required.')
  }
  const encounterSnap = await db.collection('encounters').doc(encounterId).get()
  const encounter = encounterSnap.exists ? encounterSnap.data() : null
  if (!encounter || encounter.organization_id !== orgId || encounter.patient_id !== patientId) {
    fail('permission-denied', 'Encounter does not belong to this patient and hospital.')
  }
  return { uid, orgId, patientId, encounterId }
}

async function audit(binding, action) {
  await db.collection('audit_events').add({
    action: 'clinical_draft.' + action, actor_user_id: binding.uid,
    organization_id: binding.orgId, actor_organization_id: binding.orgId,
    source: 'firebase-clinical-ai', operation: action,
    patient_id: binding.patientId, record_id: binding.encounterId,
    occurredAt: FieldValue.serverTimestamp(),
  })
}

export const generateClinicalDraft = onCall({ region: 'us-central1', timeoutSeconds: 120, memory: '1GiB' }, async (request) => {
  const data = request.data || {}
  const binding = await authorizedEncounter(request, data)
  if (typeof data.transcript !== 'string' || !data.transcript.trim() || data.transcript.length > 100_000) {
    fail('invalid-argument', 'A non-empty transcript within the supported length is required.')
  }
  let draft
  try { draft = await generateStructuredDraft(data.transcript) }
  catch (error) {
    if (error?.code === 'failed-precondition') fail('failed-precondition', error.message)
    console.error('[clinical-ai] approved provider invocation failed', error?.code || 'unknown')
    fail('unavailable', 'Clinical AI processing failed.')
  }
  const validation = validateClinicalDraft(draft, data.transcript)
  if (!validation.valid) fail('data-loss', 'Clinical AI output failed transcript evidence validation.')
  await audit(binding, 'generated')
  return { ok: true, draft, binding }
})

export const recordClinicalDraftReview = onCall({ region: 'us-central1' }, async (request) => {
  const data = request.data || {}
  const binding = await authorizedEncounter(request, data)
  if (!['approved', 'rejected'].includes(data.action)) fail('invalid-argument', 'Review decision must be approved or rejected.')
  await audit(binding, data.action)
  return { ok: true }
})
