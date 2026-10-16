// Inactivity auto-logout.
//
// Closing the app does NOT sign the user out — Firebase auth keeps local
// persistence, so a reload or relaunch restores the session. What ends a
// session is IDLE_TIMEOUT_MS without a single interaction.
//
// The last-activity stamp lives in localStorage so the clock keeps running
// while the app is closed: relaunching 25 minutes after walking away lands on
// the login screen, relaunching 5 minutes later resumes the session.
import { auth } from '../firebase.js'
import { forceLogout } from './authService.js'
import { IDLE_TIMEOUT_MS, isIdleExpired } from '../features/session/idle.js'

const ACTIVITY_KEY = 'medilogng.lastActivity'
const TICK_MS = 15 * 1000
// Interaction only — a 'focus'/'visibilitychange' listener that stamped
// activity would reset the clock on relaunch and defeat the timeout.
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart']

let started = false

function readStamp() {
  try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0 } catch { return 0 }
}
function writeStamp() {
  try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())) } catch {}
}
function clearStamp() {
  try { localStorage.removeItem(ACTIVITY_KEY) } catch {}
}

// Called after a successful sign-in so the clock starts from that moment and
// not from whatever the previous user left behind on a shared device.
export function markActivity() { writeStamp() }

async function expire() {
  clearStamp()
  await forceLogout('You were signed out after ' + Math.round(IDLE_TIMEOUT_MS / 60000) +
    ' minutes of inactivity.')
}

function check() {
  if (!auth.currentUser) { clearStamp(); return } // nobody signed in — nothing to expire
  if (isIdleExpired(Date.now(), readStamp())) expire()
}

export function startIdleWatch() {
  if (started) return
  started = true
  ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, markActivity, { passive: true }))
  // Returning to a hidden tab is not activity; it is just the moment the
  // expiry becomes visible, so it only re-checks.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
  setInterval(check, TICK_MS)
  // auth.currentUser is null for the first moments of a cold start (the
  // persisted session is restored asynchronously), so the first check waits
  // for Firebase to resolve it — otherwise a session that expired while the
  // app was closed would survive into the first render.
  Promise.resolve(auth.authStateReady ? auth.authStateReady() : null).then(check)
}
