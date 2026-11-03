// Shared friendly error mapper for Firestore writes (pure, no Firebase imports).
// Turns raw SDK errors ("Missing or insufficient permissions.") into actionable
// messages. Firestore Security Rules stay authoritative; this only explains.
export function friendlyWriteError(e, fallback = 'Something went wrong. Please retry.') {
  const code = e?.code || ''
  const msg = String(e?.message || '')
  if (
    code === 'permission-denied' ||
    /missing or insufficient permissions|insufficient permissions|permission-denied|permission_denied/i.test(msg)
  ) {
    return 'You don\u2019t have permission to do this. Ask an administrator to update your role in Administration \u2192 Staff & roles, then try again.'
  }
  if (code === 'failed-precondition' || /index/i.test(msg)) {
    return 'This query needs a Firestore index — open the browser console link to create it, then retry.'
  }
  if (code === 'unavailable' || /offline|network/i.test(msg)) {
    return 'You are offline — changes are saved on this device and will sync when you reconnect.'
  }
  return msg || fallback
}
