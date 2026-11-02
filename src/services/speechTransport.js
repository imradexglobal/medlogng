// Identify the local MediLogNG Hub before sending any recording bytes. Firebase
// Hosting rewrites unknown routes to index.html, so a successful HTTP status
// alone must never be treated as a transcription backend.
export async function hasLocalSpeechHost({
  origin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  if (typeof origin !== 'string' || !origin || typeof fetchImpl !== 'function') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(new URL('/health', origin).toString(), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response?.ok || !String(response.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')) return false
    const body = await response.json()
    return body?.ok === true && body?.hub === true && typeof body?.version === 'string' && body.version.length > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
