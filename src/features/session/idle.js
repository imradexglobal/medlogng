// Inactivity rules — pure (no DOM, no Firebase) so the timeout math is
// unit-testable. The watcher itself lives in services/idleService.js.

// 20 minutes without a single interaction ends the session. Closing the app
// does NOT: the session survives reloads/relaunches, only the idle clock
// expires. Change this one constant to retune the timeout.
export const IDLE_TIMEOUT_MS = 20 * 60 * 1000

// How long the session has been idle, in ms. A missing stamp (0) counts as
// "just started", never as "idle forever" — a wiped key must not sign a live
// user out on the next tick. A stamp from the future (clock skew / a second
// tab on a mis-set clock) is clamped to 0 for the same reason.
export function idleElapsed(now, stamp) {
  if (!stamp || stamp <= 0 || now < stamp) return 0
  return now - stamp
}

export function isIdleExpired(now, stamp, timeout = IDLE_TIMEOUT_MS) {
  return idleElapsed(now, stamp) >= timeout
}
