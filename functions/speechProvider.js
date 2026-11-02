const ALLOWED_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac',
])

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

export async function transcribeWithDeepgram({ audio, contentType, apiKey, endpoint, fetchImpl = fetch }) {
  const type = validateSpeechAudio(audio, contentType)
  if (!apiKey || !endpoint) throw Object.assign(new Error('Online speech provider is not configured.'), { code: 'failed-precondition' })
  const url = new URL('/v1/listen', endpoint)
  url.searchParams.set('model', 'nova-3-medical')
  url.searchParams.set('language', 'en')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  // Never permit provider retention or model training for clinical audio.
  url.searchParams.set('mip_opt_out', 'true')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: 'Token ' + apiKey, 'Content-Type': type },
      body: audio,
      signal: controller.signal,
    })
    if (!response.ok) throw Object.assign(new Error('Online transcription provider rejected the recording.'), { code: 'unavailable', providerStatus: response.status })
    const result = await response.json()
    const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw Object.assign(new Error('Provider returned no usable transcript.'), { code: 'data-loss' })
    return { text: text.trim(), model: 'nova-3-medical', providerRequestId: String(result?.metadata?.request_id || '').slice(0, 120) }
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Online transcription timed out.'), { code: 'deadline-exceeded' })
    throw error
  } finally { clearTimeout(timer) }
}

export async function checkDeepgram({ apiKey, endpoint, fetchImpl = fetch }) {
  if (!apiKey || !endpoint) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetchImpl(new URL('/v1/projects', endpoint), {
      headers: { Authorization: 'Token ' + apiKey }, signal: controller.signal,
    })
    return response.ok
  } catch { return false } finally { clearTimeout(timer) }
}
