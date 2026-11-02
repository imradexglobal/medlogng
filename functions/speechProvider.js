const ALLOWED_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac',
])
const DEEPGRAM_HOSTS = new Set(['api.deepgram.com', 'api.in.deepgram.com', 'api.eu.deepgram.com', 'api.au.deepgram.com'])

function providerOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw Object.assign(new Error('A valid Deepgram regional endpoint is required.'), { code: 'failed-precondition' }) }
  if (url.protocol !== 'https:' || !DEEPGRAM_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw Object.assign(new Error('The speech provider endpoint must be an approved HTTPS Deepgram endpoint.'), { code: 'failed-precondition' })
  }
  return url.origin
}

export function validateSpeechAudio(audio, contentType) {
  if (!Buffer.isBuffer(audio) || audio.length < 1024 || audio.length > 25 * 1024 * 1024) {
    throw Object.assign(new Error('Audio must be between 1 KB and 25 MB.'), { code: 'invalid-argument' })
  }
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.has(type)) throw Object.assign(new Error('Unsupported audio format.'), { code: 'invalid-argument' })
  const head = audio.subarray(0, 12)
  const magic = (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') ||
    head.toString('ascii', 0, 4) === 'OggS' || head.toString('hex', 0, 4) === '1a45dfa3' ||
    head.toString('ascii', 4, 8) === 'ftyp' || head.toString('ascii', 0, 3) === 'ID3' ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
  if (!magic) throw Object.assign(new Error('Audio file signature is invalid.'), { code: 'invalid-argument' })
  return type
}

export async function transcribeWithDeepgram({ audio, contentType, apiKey, endpoint, fetchImpl = fetch, now = Date.now }) {
  const type = validateSpeechAudio(audio, contentType)
  if (!apiKey || !endpoint) throw Object.assign(new Error('Online speech provider is not configured.'), { code: 'failed-precondition' })
  const origin = providerOrigin(endpoint)
  const url = new URL('/v1/listen', origin)
  url.searchParams.set('model', 'nova-3-medical')
  url.searchParams.set('language', 'en')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  // Never permit provider retention or model training for clinical audio.
  url.searchParams.set('mip_opt_out', 'true')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const startedAt = now()
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: 'Token ' + apiKey, 'Content-Type': type },
      body: audio,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      const status = Number(response.status) || 0
      const message = status === 401
        ? 'Deepgram rejected the server credential. Verify its backend configuration and transcription permissions.'
        : status === 403
          ? 'The Deepgram account is not permitted to use the selected medical transcription model.'
          : status === 413
            ? 'The recording is too large for online transcription.'
            : status === 429
              ? 'Deepgram is rate limiting transcription. Wait briefly and retry.'
              : status >= 500
                ? 'Deepgram is temporarily unavailable. Retry later.'
                : 'Deepgram rejected the audio or transcription options.'
      const code = status === 400 || status === 413 ? 'invalid-argument' : status === 401 || status === 403 ? 'failed-precondition' : 'unavailable'
      throw Object.assign(new Error(message), { code, providerStatus: status })
    }
    const result = await response.json()
    const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw Object.assign(new Error('Provider returned no usable transcript.'), { code: 'data-loss' })
    return {
      text: text.trim(), model: 'nova-3-medical',
      providerRequestId: String(result?.metadata?.request_id || '').slice(0, 120),
      processingMs: Math.max(0, Math.round(now() - startedAt)),
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Online transcription timed out.'), { code: 'deadline-exceeded' })
    throw error
  } finally { clearTimeout(timer) }
}

export async function checkDeepgram({ apiKey, endpoint, fetchImpl = fetch }) {
  if (!apiKey || !endpoint) return false
  let origin
  try { origin = providerOrigin(endpoint) } catch { return false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    // This validates an API key without requiring project-administration
    // permissions that a least-privilege transcription key should not have.
    const response = await fetchImpl(new URL('/v1/auth/token', origin), {
      headers: { Authorization: 'Token ' + apiKey }, signal: controller.signal, redirect: 'error',
    })
    return response.ok
  } catch { return false } finally { clearTimeout(timer) }
}
