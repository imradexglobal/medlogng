// Host-verified device identity for shared LAN handoffs when Firebase cannot
// refresh a short-lived ID token during an internet outage.
import { getOrCreateDeviceKey, readDeviceSession, signedDeviceRequest } from './deviceSession.js'

function hostBaseUrl() {
  try {
    const configured = localStorage.getItem('medilogng.hubUrl') || import.meta.env?.VITE_HUB_URL || ''
    return String(configured || window.location.origin).replace(/\/+$/, '')
  } catch { return window.location.origin }
}

export async function registerHostSession(user, orgId) {
  if (!user?.uid || !orgId || !navigator.onLine) return null
  const baseUrl = hostBaseUrl()
  try { if (new URL(baseUrl).protocol !== 'https:') return null } catch { return null }
  const device = await getOrCreateDeviceKey(user.uid, orgId)
  const token = await user.getIdToken()
  const response = await fetch(baseUrl + '/device/session/register?orgId=' + encodeURIComponent(orgId), {
    method: 'POST', headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'x-medilog-client': 'medilogng-web',
      'x-device-device': device.deviceId,
    }, body: JSON.stringify({ publicKey: device.publicKey }), cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) return null
  const data = await response.json().catch(() => ({}))
  if (!data.session?.deviceId || data.session.deviceId !== device.deviceId) return null
  return device
}

export async function currentHostSession(uid, orgId) {
  if (!uid || !orgId) return null
  return readDeviceSession(uid, orgId).catch(() => null)
}

export async function revalidateHostSession(user, orgId) {
  if (!user?.uid || !orgId || !navigator.onLine) return false
  const device = await currentHostSession(user.uid, orgId)
  if (!device) return false
  try {
    const token = await user.getIdToken(true)
    const response = await signedDeviceRequest('/device/session/revalidate?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', headers: { authorization: 'Bearer ' + token },
    }, device)
    return response.ok
  } catch { return false }
}

export async function revokeHostSession(device) {
  if (!device?.deviceId || !device.orgId) return false
  try {
    const response = await signedDeviceRequest('/device/session/revoke?orgId=' + encodeURIComponent(device.orgId), {
      method: 'POST', signal: AbortSignal.timeout(1500),
    }, device)
    return response.ok
  } catch { return false }
}
