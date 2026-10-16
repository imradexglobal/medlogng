// Infinite scroll for the long registry/queue tables — rows accumulate as the
// user reaches the bottom instead of paging 1, 2, 3 through a numbered pager.
//
// Every table body lives inside a `.tblwrap`, which is itself the scroll
// container (`overflow-y: auto; max-height: 500px`). So the sentinel has to be
// observed against THAT element, not the viewport: a viewport-rooted observer
// would fire the moment the 500px box appeared on screen, long before the user
// had seen the last row. Rooting on the wrapper works in both cases — when the
// table is shorter than the cap it simply keeps loading until it overflows,
// which is what an infinite list should do anyway.
//
// The sentinel carries a visible "Load more" button as well as the observer:
// a keyboard user, or a webview where the observer never fires, still has a
// way to pull the next chunk.
//
// Usage — call mount() after every render that rewrites the table host:
//   const more = createLoadMore(loadMore)
//   more.mount(tableHost.querySelector('.tblwrap'))
// The view owns the fetch and reports back with setLoading/setDone/setError.
import { esc } from '../utils/sanitize.js'

export function createLoadMore(onLoadMore) {
  let node = null
  let wrap = null
  let observer = null
  let loading = false
  let done = false
  let error = ''
  let painted = ''
  // Where the reader was when the fetch started, so the append does not yank
  // them away from the row they were on.
  let anchorTop = 0

  function paint() {
    if (!node) return
    const html = loading
      ? '<span class="sub">Loading more…</span>'
      : done
        ? '<span class="mut">End of list</span>'
        : error
          ? '<button class="btn ghost sm" data-lm>' + esc(error) + '</button>'
          : '<button class="btn ghost sm" data-lm>Load more</button>'
    if (html === painted) return
    painted = html
    node.innerHTML = html
    const b = node.querySelector('[data-lm]')
    if (b) b.onclick = () => onLoadMore()
  }

  return {
    // Attach to (or re-attach to) the scroll container holding the rows. Views
    // rebuild `innerHTML` on most renders, which orphans the observed node, so
    // this is idempotent and safe to call as often as the table repaints.
    mount(host) {
      observer?.disconnect()
      observer = null
      if (!host || !host.isConnected) return
      node = host.querySelector('[data-loadmore]') || (() => {
        const n = document.createElement('div')
        n.className = 'loadmore'
        n.setAttribute('data-loadmore', '1')
        host.appendChild(n)
        return n
      })()
      painted = '' // the node may be a fresh one; force a repaint
      paint()
      // Every append rewrites the table's markup, and a rebuilt scroll
      // container comes back at the top — so the reader would be thrown back
      // to the first row mid-list. Put them back where they were. A filter
      // that shrank the list clamps to the new maximum on its own.
      if (anchorTop) {
        host.scrollTop = anchorTop
        anchorTop = 0
      }
      wrap = host
      // Nothing to observe while a fetch is in flight — the sentinel is by
      // definition still on screen, and that would queue a second read behind
      // the first.
      if (done || loading || typeof IntersectionObserver === 'undefined') return
      observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      }, { root: host, rootMargin: '200px 0px' })
      observer.observe(node)
    },

    setLoading(on) {
      loading = !!on
      if (on) {
        error = ''
        observer?.disconnect()
        observer = null
        // Remember where the reader is. `.is-loading` blocks pointer events on
        // the wrap for the duration of the fetch, so this cannot go stale
        // before the rows are swapped in.
        anchorTop = wrap?.scrollTop || 0
      }
      paint()
    },

    setDone(on) {
      done = !!on
      if (done) observer?.disconnect()
      paint()
    },

    setError(msg) {
      error = msg || ''
      paint()
    },

    // A refresh, filter change or org switch invalidates our position: the
    // caller resets its cursor and rows, and this forgets we had reached the
    // end so the next mount observes again.
    reset() {
      done = false
      error = ''
      loading = false
      anchorTop = 0
      observer?.disconnect()
      observer = null
      painted = ''
      paint()
    },

    destroy() {
      observer?.disconnect()
      observer = null
      node = null
      wrap = null
      anchorTop = 0
    },
  }
}
