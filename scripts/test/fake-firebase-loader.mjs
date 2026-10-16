// Module loader that swaps the real Firebase SDK for an in-memory fake, so the
// Firestore-writing services can be exercised for real in tests.
//
// Registered from the test files via `register()` from node:module. Only the
// specifier ending in `firebase.js` is intercepted — every other module loads
// normally, so the code under test is the actual shipped source, not a copy.
//
// The fake deliberately reproduces the two Firestore behaviours that silently
// broke real code during this pass:
//   1. A transaction requires every read to happen before any write. Violating
//      that throws FAILED_PRECONDITION, exactly as Firestore does.
//   2. A transaction may be retried on conflict, so callback bodies must not
//      have side effects outside the transaction.

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('firebase.js')) {
    return { url: new URL('./fake-firebase.js', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}