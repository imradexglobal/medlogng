// Shared live-subscription helper. Every hot list in the app goes through
// this one function so listener behaviour (error routing, mapping safety) is
// identical everywhere. `onSnapshot` comes from ../firebase.js — never from
// firebase/firestore directly — so the persistent multi-tab cache config is
// always the one in use.
import { onSnapshot } from '../firebase.js'

// q: a Firestore Query built by the service's build*Query (same query the
// list* function uses). mapDocs: (doc) => row, the exact mapper the list*
// function applies. onRows(rows): called with the mapped array on every
// snapshot (cache-first, then sync). onError(err): subscription failure
// (permissions/network) — the view falls back to a one-shot list* refresh.
// Returns the unsubscribe function.
export function watchQuery(q, mapDocs, onRows, onError) {
  return onSnapshot(q, (snap) => {
    try {
      onRows(snap.docs.map(mapDocs))
    } catch (e) {
      // A mapping error must route to onError, never crash silently.
      if (typeof onError === 'function') onError(e)
      else console.error('[live] snapshot mapping failed:', e)
    }
  }, onError)
}
