const NETWORK_ERROR_CODES = new Set([
  'unavailable', 'deadline-exceeded', 'network-request-failed',
])

export function isNetworkReadError(error) {
  if (NETWORK_ERROR_CODES.has(String(error?.code || '').toLowerCase())) return true
  return /network|offline|timed? ?out|connection (?:reset|refused|lost)|failed to fetch/i.test(String(error?.message || ''))
}

export async function readWithCache(networkRead, cacheRead, {
  isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false,
  timeoutMs = 2500,
  label = 'Read',
} = {}) {
  if (isOffline()) return cacheRead()
  let timer
  let timedOut = false
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(Object.assign(new Error(label + ' network read timed out'), { code: 'offline/timeout' }))
    }, timeoutMs)
  })
  const pending = networkRead()
  try {
    return await Promise.race([pending, timeout])
  } catch (error) {
    if (timedOut || isNetworkReadError(error)) {
      try { return await cacheRead() } catch { /* preserve the useful network error below */ }
    }
    throw error
  } finally { clearTimeout(timer) }
}
