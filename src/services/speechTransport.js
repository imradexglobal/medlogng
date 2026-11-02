const FUNCTION_REGION = 'us-central1'

async function hostedSpeechEndpoint(name, app) {
  const projectId = app?.options?.projectId
  if (!projectId) throw new Error('Online transcription backend is unavailable.')
  return `https://${FUNCTION_REGION}-${projectId}.cloudfunctions.net/${name}`
}

async function authenticatedHeaders(user, extra = {}) {
  if (!user) throw new Error('Sign in to transcribe this recording.')
  const token = await user.getIdToken()
  return { Authorization: 'Bearer ' + token, 'x-medilog-client': 'medilogng-web', ...extra }
}

export async function getSpeechBackend({ orgId, user, origin = globalThis.location?.origin, fetchImpl = globalThis.fetch, cloudBaseUrl = '' } = {}) {
  if (!orgId || !user || !origin || !fetchImpl) return null
  const headers = await authenticatedHeaders(user)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const hostResponse = await fetchImpl(new URL('/speech/health?orgId=' + encodeURIComponent(orgId), origin), {
      method: 'GET', headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
    })
    const type = String(hostResponse.headers?.get?.('content-type') || '').toLowerCase()
    if (hostResponse.ok && type.includes('application/json')) {
      const data = await hostResponse.json()
      if (data?.ok === true && data?.available === true) return { kind: 'host', url: new URL('/speech/transcribe', origin).toString(), headers }
    }
  } catch { /* Firebase-hosted apps use the secured callable HTTP function below. */ }
  clearTimeout(timeout)
  try {
    const { app } = await import('../firebase.js')
    const url = cloudBaseUrl ? new URL('speechHealth', cloudBaseUrl).toString() : await hostedSpeechEndpoint('speechHealth', app)
    const cloudResponse = await fetchImpl(url + '?orgId=' + encodeURIComponent(orgId), {
      method: 'GET', headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(7000),
    })
    if (!cloudResponse.ok || !String(cloudResponse.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')) return null
    const data = await cloudResponse.json()
    return data?.ok === true && data?.available === true
      ? { kind: 'firebase', url: cloudBaseUrl ? new URL('transcribeConsultation', cloudBaseUrl).toString() : await hostedSpeechEndpoint('transcribeConsultation', app), headers }
      : null
  } catch { return null } finally { clearTimeout(timeout) }
}

export async function transcribeRecording({ backend, blob, orgId, patientId, encounterId, requestId = crypto.randomUUID(), signal, fetchImpl = globalThis.fetch }) {
  if (!backend || !blob?.size || !orgId || !patientId || !encounterId) throw new Error('A ready transcription service and open consultation are required.')
  const url = new URL(backend.url)
  url.searchParams.set('orgId', orgId)
  url.searchParams.set('patientId', patientId)
  url.searchParams.set('encounterId', encounterId)
  const response = await fetchImpl(url, {
    method: 'POST', headers: { ...backend.headers, 'Content-Type': blob.type || 'audio/webm', 'X-Speech-Request-Id': requestId },
    body: blob, cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok !== true || typeof data.text !== 'string') throw new Error(data.error || 'Online transcription failed. The recording remains on this device.')
  return { text: data.text, model: data.model || 'nova-3-medical' }
}
