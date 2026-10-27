// MediLog NG — Host & LAN network status service.
// Discovers the local host server's LAN IP and port for connecting ward devices.

let cachedHostInfo = null
let lastFetchTime = 0
const CACHE_TTL_MS = 15000 // Cache for 15s

export async function getHostNetworkInfo(forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && cachedHostInfo && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedHostInfo
  }

  // 1. Electron Host mode: direct query to main process via preload bridge
  if (typeof window !== 'undefined' && window.medilog && typeof window.medilog.hostGetInfo === 'function') {
    try {
      const info = await window.medilog.hostGetInfo()
      if (info && (info.lanUrl || (info.addresses && info.addresses.length))) {
        cachedHostInfo = {
          lanUrl: info.lanUrl || (info.addresses && info.addresses.length ? ('http://' + info.addresses[0] + ':' + (info.port || 8787)) : ''),
          localUrl: info.localUrl || ('http://127.0.0.1:' + (info.port || 8787)),
          addresses: info.addresses || [],
          port: info.port || 8787,
          running: info.running !== false,
          isHostMachine: true,
        }
        lastFetchTime = now
        return cachedHostInfo
      }
    } catch {
      // Not in host mode or error
    }
  }

  // 2. Browser client or ward PC: query the hub /health endpoint
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(2500) })
    if (res.ok) {
      const data = await res.json()
      if (data && data.hub) {
        const origin = typeof window !== 'undefined' ? (window.location.protocol + '//' + window.location.host) : ''
        cachedHostInfo = {
          lanUrl: data.lanUrl || origin,
          localUrl: 'http://127.0.0.1:' + (data.port || 8787),
          addresses: data.addresses || [typeof window !== 'undefined' ? window.location.hostname : 'localhost'],
          port: data.port || 8787,
          running: true,
          isHostMachine: false,
        }
        lastFetchTime = now
        return cachedHostInfo
      }
    }
  } catch {
    // Not running on a hub or network error
  }

  return null
}
