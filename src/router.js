import { authStore } from './store/authStore.js'
import { runCleanups } from './lib/lifecycle.js'
import { ensureStaffDirectory } from './lib/staffName.js'
import { HospitalChoiceView } from './views/HospitalChoiceView.js'

const routes = []

// `render` is a loader: () => import(...).then(m => m.View). It is called on
// first navigation and the resolved view is cached, so each screen is fetched
// once — and only when it is actually opened. Keeping the loader (not the view
// itself) means a cold dev load no longer pulls every view in the app through
// the module graph before the first paint.
export function registerRoute(path, render, opts = {}) {
  routes.push({ path, render, ...opts })
}

registerRoute('/hospital-choice', () => import('./views/HospitalChoiceView.js').then((m) => m.HospitalChoiceView))

let beforeEach = null
export function setGuard(fn) {
  beforeEach = fn
}

// Splits "#/billing?patient=x&new=1" into path "/billing" and params.
// Query params are merged over path params, so a view can read both
// `params.id` and `params.patient` without a new route per flow.
function matchRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/'
  const qi = raw.indexOf('?')
  const path = qi === -1 ? raw : raw.slice(0, qi)
  const query = {}
  if (qi !== -1) {
    new URLSearchParams(raw.slice(qi + 1)).forEach((v, k) => { query[k] = v })
  }
  for (const r of routes) {
    const pattern = '^' + r.path.replace(/:[^/]+/g, '([^/]+)') + '$'
    const m = path.match(new RegExp(pattern))
    if (m) {
      const keys = [...r.path.matchAll(/:([^/]+)/g)].map((x) => x[1])
      const params = {}
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      return { route: r, params: { ...params, ...query } }
    }
  }
  return null
}

export function navigate(path) {
  window.location.hash = '#' + path
}

// Thin progress bar shown while a route renders. The previous page is left
// mounted (only dimmed) so navigation cross-fades instead of flashing a blank
// "Loading…" screen — that flash is what made the app feel like it blinked.
let pendingDepth = 0
function routePending(on) {
  if (typeof document === 'undefined') return
  let bar = document.getElementById('routebar')
  if (on) {
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'routebar'
      document.body.appendChild(bar)
    }
    bar.classList.add('on')
    const page = document.querySelector('.page')
    if (page) page.classList.add('is-pending')
  } else {
    const page = document.querySelector('.page')
    if (page) page.classList.remove('is-pending')
    bar = document.getElementById('routebar')
    if (bar) bar.classList.remove('on')
  }
}

function bootScreen() {
  const app = document.getElementById('app')
  if (app && app.querySelector('.emr')) return false
  if (app) app.innerHTML = '<p class="loading boot">Loading…</p>'
  return true
}

// Single-flight lock. Cold start fires handleRoute() both from the boot
// authStore subscription and from the module-level call, so the same route can
// be entered twice; without this the view mounts twice and the first mount's
// timers/subscriptions keep running against DOM that has already been replaced.
// A repeat call for the same route+params is ignored outright — there is
// nothing to redo, and re-mounting would duplicate timers and live listeners.
let lastKey = null
let inFlight = null

export async function handleRoute() {
  const app = document.getElementById('app')
  const found = matchRoute(window.location.hash)
  if (!found) { navigate('/login'); return }
  const { route, params } = found
  const key = route.path + '?' + JSON.stringify(params)
  // Only latch AFTER the guards below: they early-return without rendering, and
  // latching first would make the later retry (auth becoming ready) a no-op and
  // strand the user on the boot splash.
  if (lastKey === key) return
  const { user, ready } = authStore.getState()
  if (!ready) {
    bootScreen()
    return
  }
  // A password-reset link arrives as #/login?mode=resetPassword&oobCode=… and
  // must render even with a live session: the user is on that screen exactly
  // because they are setting a new password on this device.
  const isResetLink = /[?&]mode=resetPassword(?:&|$)/.test(String(window.location.hash || ''))
  if (route.auth && !user && !isResetLink) { navigate('/login'); return }
  if (route.guest && user && !isResetLink) { navigate('/welcome'); return }
  if (beforeEach) {
    const redirect = beforeEach()
    if (redirect) { navigate(redirect); return }
  }
  lastKey = key
  // First paint after a reload has nothing to fade from; later navigations keep
  // the old page mounted behind the progress bar.
  bootScreen()
  // Serialise mounts: a navigation arriving while one is in flight waits for it,
  // so two views never write into #app concurrently and a slow earlier route
  // cannot overwrite the page the user already moved to.
  if (inFlight) { try { await inFlight } catch {} }
  pendingDepth += 1
  routePending(true)
  inFlight = (async () => {
    try {
      // Staff names are resolved synchronously while a view renders, so the
      // per-hospital directory (members + devices → name) is warmed here once
      // per org — before the view builds its HTML. It never rejects.
      const dir = ensureStaffDirectory(authStore.getState().activeOrg).catch(() => {})
      const view = route.view || (route.view = await route.render())
      await dir
      // Tear down the previous view's listeners right before the new one mounts.
      // Guard redirects / the not-ready splash return above and never reach this.
      runCleanups()
      await view(app, params)
    } catch (err) {
      // Unlatch on failure so the user can retry the same route.
      if (lastKey === key) lastKey = null
      console.error(err)
      if (app) {
        app.innerHTML = '<div class="card card-error"><h2>Page failed to load</h2><p>Please retry.</p><p class="muted">' +
          String(err?.message || err) + '</p></div>'
      }
    } finally {
      pendingDepth = Math.max(0, pendingDepth - 1)
      if (pendingDepth === 0) routePending(false)
    }
  })()
  await inFlight
  inFlight = null
}

export function initRouter() {
  window.addEventListener('hashchange', handleRoute)
  window.addEventListener('beforeunload', runCleanups)
}
