// View teardown registry. The router has no unmount hook — views stay mounted
// (dimmed) behind the progress bar while the next lazy module loads — so each
// live view registers its teardown here and the router runs them all right
// before mounting the next routed view. Views that never call onCleanup are
// completely unaffected: runCleanups on an empty list is a no-op.

const cleanups = []

export function onCleanup(fn) {
  if (typeof fn !== 'function') return
  cleanups.push(fn)
}

// LIFO so child/teardown order mirrors registration order; each callback is
// isolated so one failure can't block the others. The list is always cleared,
// even when a callback throws, so fast repeated navigation can't grow it.
export function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop()
    try {
      fn()
    } catch (e) {
      console.warn('[cleanup] failed:', e?.message || e)
    }
  }
}
