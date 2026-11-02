import { initializeApp, getApps } from 'firebase-admin/app'
import { createHash } from 'node:crypto'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { validateClinicalDraft } from './draftValidation.js'
import { generateStructuredDraft } from './clinicalAiProvider.js'
import { checkDeepgram, transcribeWithDeepgram } from './speechProvider.js'

if (!getApps().length) initializeApp()
const db = getFirestore()
const DEEPGRAM_API_KEY = defineSecret('DEEPGRAM_API_KEY')

export function createSpeechHttpHandler({ store, auth, provider, secret = () => '', endpoint = () => '', allowClinicalAudio = () => false, timestamp = () => new Date(), log = console }) {
  return async function speechHttpHandler(req, res) {
    const origin = String(req.headers.origin || '')
    if (origin === 'https://medlogng.web.app') {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Vary', 'Origin')
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Medilog-Client, X-Speech-Request-Id')
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    }
    res.set('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') return res.status(origin === 'https://medlogng.web.app' ? 204 : 403).end()
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' })
    if (origin !== 'https://medlogng.web.app' || req.get('x-medilog-client') !== 'medilogng-web') return res.status(403).json({ ok: false, error: 'This client is not allowed.' })
    try {
      if (!allowClinicalAudio()) return res.status(503).json({ ok: false, error: 'Clinical audio processing has not been enabled for this deployment.' })
      const match = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''))
      if (!match) return res.status(401).json({ ok: false, error: 'Sign in is required.' })
      const identity = await auth.verifyIdToken(match[1], true)
      const orgId = String(req.query.orgId || '')
      const patientId = String(req.query.patientId || '')
      const encounterId = String(req.query.encounterId || '')
      const requestId = String(req.get('x-speech-request-id') || '')
      if (!orgId || !patientId || !encounterId || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) return res.status(400).json({ ok: false, error: 'Organization, patient, consultation and request id are required.' })
      const membership = await store.collection('organization_memberships').doc(orgId + '_' + identity.uid).get()
      const member = membership.exists ? membership.data() : null
      const capabilities = Array.isArray(member?.capabilities) ? member.capabilities : []
      if (member?.status !== 'active' || !(capabilities.includes('*') || capabilities.includes('encounter.edit'))) return res.status(403).json({ ok: false, error: 'Active encounter.edit permission is required.' })
      const encounterSnapshot = await store.collection('encounters').doc(encounterId).get()
      const encounter = encounterSnapshot.exists ? encounterSnapshot.data() : null
      if (!encounter || encounter.organization_id !== orgId || encounter.patient_id !== patientId) return res.status(403).json({ ok: false, error: 'Consultation does not belong to this patient and hospital.' })
      const audio = Buffer.from(req.rawBody || [])
      const contentType = String(req.get('content-type') || '')
      const auditBase = { actor_user_id: identity.uid, actor_organization_id: orgId, organization_id: orgId, patient_id: patientId, record_id: encounterId, request_id: requestId, source: 'firebase-deepgram-stt' }
      const idempotencyId = 'speech_transcription_' + createHash('sha256').update([identity.uid, orgId, encounterId, requestId].join('\n')).digest('hex')
      const auditRef = store.collection('audit_events').doc(idempotencyId)
      const submitRecord = { ...auditBase, action: 'speech.transcription-submit', model: 'nova-3-medical', status: 'started', occurredAt: timestamp() }
      try { await auditRef.create(submitRecord) }
      catch (error) {
        if (error?.code === 6 || error?.code === 'already-exists') return res.status(409).json({ ok: false, error: 'This transcription request was already submitted. Start a new request if a retry is needed.' })
        throw error
      }
      let result
      try { result = await provider({ audio, contentType, apiKey: secret(), endpoint: endpoint() }) }
      catch (error) {
        await auditRef.update({ status: 'failed', failure_code: String(error?.code || 'provider-error').slice(0, 80), provider_status: Number(error?.providerStatus) || null, completedAt: timestamp() }).catch(() => {})
        throw error
      }
      await auditRef.update({ status: 'completed', model: result.model, processing_ms: result.processingMs ?? null, completedAt: timestamp() })
      return res.status(200).json({ ok: true, status: 'completed', text: result.text, model: result.model, processingMs: result.processingMs ?? null, requestId })
    } catch (error) {
      const code = error?.code
      if (['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error'].includes(code)) return res.status(401).json({ ok: false, error: 'Sign in again before transcribing.' })
      if (code === 'invalid-argument') return res.status(400).json({ ok: false, error: error.message })
      if (code === 'failed-precondition') return res.status(503).json({ ok: false, error: error.message })
      log.error?.('[speech] online transcription failed', code || error?.name || 'unknown')
      return res.status(503).json({ ok: false, error: 'Online transcription could not be completed.' })
    }
  }
}

export function createSpeechHealthHandler({ store, auth, checkProvider, secret = () => '', endpoint = () => '', allowClinicalAudio = () => false }) {
  return async function speechHealth(req, res) {
    const origin = String(req.headers.origin || '')
    if (origin === 'https://medlogng.web.app') {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Vary', 'Origin')
      res.set('Access-Control-Allow-Headers', 'Authorization, X-Medilog-Client')
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    }
    res.set('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') return res.status(origin === 'https://medlogng.web.app' ? 204 : 403).end()
    if (req.method !== 'GET' || origin !== 'https://medlogng.web.app' || req.get('x-medilog-client') !== 'medilogng-web') return res.status(403).json({ ok: false, available: false })
    try {
      const match = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''))
      if (!match) return res.status(401).json({ ok: false, available: false })
      const identity = await auth.verifyIdToken(match[1], true)
      const orgId = String(req.query.orgId || '')
      const membership = await store.collection('organization_memberships').doc(orgId + '_' + identity.uid).get()
      const member = membership.exists ? membership.data() : null
      const capabilities = Array.isArray(member?.capabilities) ? member.capabilities : []
      if (!orgId || member?.status !== 'active' || !(capabilities.includes('*') || capabilities.includes('encounter.edit'))) return res.status(403).json({ ok: false, available: false })
      const enabled = allowClinicalAudio() && !!secret() && !!endpoint()
      const available = enabled && await checkProvider({ apiKey: secret(), endpoint: endpoint() })
      return res.status(200).json({ ok: true, available, provider: available ? 'deepgram' : '' })
    } catch { return res.status(503).json({ ok: false, available: false }) }
  }
}

export function createClinicalAiHandlers({ store, provider, timestamp = () => new Date(), log = console }) {
  const fail = (code, message) => { throw new HttpsError(code, message) }
  async function authorizedEncounter(request, data) {
    if (!request.auth?.uid) fail('unauthenticated', 'Sign in is required.')
    const { orgId, patientId, encounterId } = data
    if (![orgId, patientId, encounterId].every((value) => typeof value === 'string' && value.length > 0)) {
      fail('invalid-argument', 'Organization, patient and encounter are required.')
    }
    const uid = request.auth.uid
    const member = await store.collection('organization_memberships').doc(orgId + '_' + uid).get()
    const membership = member.exists ? member.data() : null
    const caps = Array.isArray(membership?.capabilities) ? membership.capabilities : []
    if (membership?.status !== 'active' || !(caps.includes('*') || caps.includes('encounter.edit'))) {
      fail('permission-denied', 'Active membership with encounter.edit is required.')
    }
    const encounterSnap = await store.collection('encounters').doc(encounterId).get()
    const encounter = encounterSnap.exists ? encounterSnap.data() : null
    if (!encounter || encounter.organization_id !== orgId || encounter.patient_id !== patientId) {
      fail('permission-denied', 'Encounter does not belong to this patient and hospital.')
    }
    return { uid, orgId, patientId, encounterId }
  }
  async function audit(binding, action, decisions = {}) {
    await store.collection('audit_events').add({
      action: 'clinical_draft.' + action, actor_user_id: binding.uid,
      organization_id: binding.orgId, actor_organization_id: binding.orgId,
      source: 'firebase-clinical-ai', operation: action,
      patient_id: binding.patientId, record_id: binding.encounterId,
      occurredAt: timestamp(),
      ...(action === 'approved' || action === 'rejected' ? {
        accepted_suggestions: decisions.accepted || [], rejected_suggestions: decisions.rejected || [],
      } : {}),
    })
  }
  return {
    async generate(request) {
      const data = request.data || {}
      const binding = await authorizedEncounter(request, data)
      if (typeof data.transcript !== 'string' || !data.transcript.trim() || data.transcript.length > 100_000) {
        fail('invalid-argument', 'A non-empty transcript within the supported length is required.')
      }
      let draft
      try { draft = await provider(data.transcript) }
      catch (error) {
        if (error?.code === 'failed-precondition') fail('failed-precondition', error.message)
        log.error?.('[clinical-ai] approved provider invocation failed', error?.code || 'unknown')
        fail('unavailable', 'Clinical AI processing failed.')
      }
      const validation = validateClinicalDraft(draft, data.transcript)
      if (!validation.valid) fail('data-loss', 'Clinical AI output failed transcript evidence validation.')
      await audit(binding, 'generated')
      return { ok: true, draft, binding }
    },
    async review(request) {
      const data = request.data || {}
      const binding = await authorizedEncounter(request, data)
      if (!['approved', 'rejected'].includes(data.action)) fail('invalid-argument', 'Review decision must be approved or rejected.')
      const validSuggestionIds = (value) => Array.isArray(value) && value.length <= 200 && value.every((item) => /^(S|O|A|P):\d{1,3}$/.test(item))
      const accepted = data.acceptedSuggestions || []
      const rejected = data.rejectedSuggestions || []
      if (!validSuggestionIds(accepted) || !validSuggestionIds(rejected)) fail('invalid-argument', 'Reviewed suggestion references are invalid.')
      await audit(binding, data.action, { accepted, rejected })
      return { ok: true }
    },
  }
}

const handlers = createClinicalAiHandlers({ store: db, provider: generateStructuredDraft, timestamp: () => FieldValue.serverTimestamp() })
export const generateClinicalDraft = onCall({ region: 'us-central1', timeoutSeconds: 120, memory: '1GiB', maxInstances: 2 }, handlers.generate)
export const recordClinicalDraftReview = onCall({ region: 'us-central1', maxInstances: 2 }, handlers.review)
const speechHandler = createSpeechHttpHandler({
  store: db,
  auth: (await import('firebase-admin/auth')).getAuth(),
  provider: transcribeWithDeepgram,
  secret: () => DEEPGRAM_API_KEY.value(),
  endpoint: () => process.env.DEEPGRAM_ENDPOINT || '',
  allowClinicalAudio: () => process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO === 'true',
  timestamp: () => FieldValue.serverTimestamp(),
})
const speechHealthHandler = createSpeechHealthHandler({
  store: db, auth: (await import('firebase-admin/auth')).getAuth(), checkProvider: checkDeepgram,
  secret: () => DEEPGRAM_API_KEY.value(), endpoint: () => process.env.DEEPGRAM_ENDPOINT || '',
  allowClinicalAudio: () => process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO === 'true',
})
export const transcribeConsultation = onRequest({ region: 'us-central1', timeoutSeconds: 240, memory: '1GiB', maxInstances: 5, concurrency: 2, secrets: [DEEPGRAM_API_KEY] }, speechHandler)
export const speechHealth = onRequest({ region: 'us-central1', timeoutSeconds: 15, memory: '256MiB', maxInstances: 5, secrets: [DEEPGRAM_API_KEY] }, speechHealthHandler)
