// Shared EMR app shell: sidebar + topbar + toast + modal (UI only, no logic).
import { authStore } from '../store/authStore.js'
import { logout, myActiveMembership } from '../services/authService.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'
import { onCleanup } from '../lib/lifecycle.js'
import { onUpdate, getSyncMode } from '../services/clinicalOutbox.js'
import { createAllergyTagInput } from './AllergyTagInput.js'
import { getHostNetworkInfo } from '../services/hostService.js'

export const NAV = [
  { path: '/', label: 'Dashboard', icon: '▦' },
  { path: '/patients', label: 'Patients', icon: '◉' },
  { path: '/appointments', label: 'Appointments', icon: '◷' },
  { path: '/consultations', label: 'Consultations', icon: '✚' },
  { path: '/admissions', label: 'Admissions', icon: '▤' },
  { path: '/laboratory', label: 'Laboratory', icon: '♳' },
  { path: '/pharmacy', label: 'Pharmacy', icon: '💊' },
  { path: '/billing', label: 'Billing', icon: '₦' },
  { path: '/reports', label: 'Reports', icon: '📊' },
  { path: '/admin', label: 'Administration', icon: '⚙' },
]

export function statusBadge(s) {
  const statusLabels = {
    Paid: 'Paid', Dispensed: 'Dispensed', Verified: 'Verified', Synced: 'Synced', Completed: 'Completed', Active: 'Active', 'Checked-in': 'Checked-in', 'checked-in': 'Checked-in',
    'Part-paid': 'Part-paid', Pending: 'Pending', Ready: 'Ready', Waiting: 'Waiting', Low: 'Low', 'With vitals': 'With vitals',
    Requested: 'Requested', 'Partially dispensed': 'Partially dispensed', Reversed: 'Reversed', 'no-show': 'No-show',
    'In consultation': 'In consultation', Processing: 'Processing', Confirmed: 'Confirmed', Admitted: 'Admitted', Accepted: 'Accepted', 'Specimen collected': 'Specimen collected',
    External: 'External',
    Unpaid: 'Unpaid', Out: 'Out', Expiring: 'Expiring', Overdue: 'Overdue', cancelled: 'Cancelled',
    Scheduled: 'Scheduled', Open: 'Open', OK: 'OK', 'NHIA claim': 'NHIA claim', scheduled: 'scheduled',
  }
  const cls = {
    Paid: 'ok', Dispensed: 'ok', Verified: 'ok', Synced: 'ok', Completed: 'ok', Active: 'ok', 'Checked-in': 'ok', 'checked-in': 'ok',
    'Part-paid': 'warn', Pending: 'warn', Ready: 'warn', Waiting: 'warn', Low: 'warn', 'With vitals': 'warn',
    Requested: 'warn', 'Partially dispensed': 'warn', Reversed: 'warn', 'no-show': 'warn',
    'In consultation': 'info', Processing: 'info', Confirmed: 'info', Admitted: 'info', Accepted: 'info', 'Specimen collected': 'info',
    External: 'info',
    Unpaid: 'bad', Out: 'bad', Expiring: 'bad', Overdue: 'bad', cancelled: 'bad',
    Scheduled: '', Open: '', OK: 'ok', 'NHIA claim': 'info', scheduled: '',
  }[s] || ''
  const label = statusLabels[s] || esc(s)
  return '<span class="pill ' + cls + '" title="' + esc(label) + '">' + esc(s) + '</span>'
}

export function shell(app, { active, title, subtitle = '', actions = '', body = '' }) {
  const { user, activeOrgName, activeOrg } = authStore.getState()
  const email = user?.email || ''
  // Never fall back to the demo/mock hospital name — a missing org name shows
  // the org id (or a neutral label), never another hospital's brand. The label
  // is wired to the auth store below, so when the org doc resolves a moment
  // after this render the sidebar updates in place.
  const org = activeOrgName || activeOrg || 'Hospital'
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  const me = myActiveMembership()
  const role = me?.role ? String(me.role).replace(/_/g, ' ') : 'member'
  // The sidebar identifies the person by staff name — the same value records
  // and reports show — and only falls back to the sign-in email.
  const who = me?.staff_name || user?.displayName || email
  const initials = (String(who || '').match(/\b\w/g) || ['u']).slice(0, 2).join('').toUpperCase()

  app.innerHTML =
    '<div class="emr">' +
      '<div class="side-scrim" id="sideScrim" aria-hidden="true"></div>' +
      '<aside class="side" id="side">' +
        '<div class="side-brand"><img src="./logo.png" class="brand-logo" alt="MediLog NG" onerror="this.style.display=\'none\'" />' +
          '<span><strong>MediLog NG</strong><em id="sideOrg">' + esc(org) + '</em></span>' +
          '<button class="iconbtn side-close only-mobile" id="sideClose" aria-label="Close navigation">✕</button></div>' +
        '<nav class="side-nav" aria-label="Main">' +
          NAV.map((n) => '<a href="#' + n.path + '" class="' + (n.path === active ? 'on' : '') + '"' +
            (n.path === active ? ' aria-current="page"' : '') + '>' +
            '<span class="ic" aria-hidden="true">' + n.icon + '</span>' + esc(n.label) + '</a>').join('') +
        '</nav>' +
        '<div class="side-foot">' +
          '<div class="sync"><span class="dot" id="syncDot"></span><span><strong id="syncState" aria-live="polite">' +
            (online ? 'Online · Firestore' : 'Offline · local cache') +
            '</strong><em id="syncDetail">' + (online ? 'writes sync to the cloud' : 'writes queue until you reconnect') + '</em></span></div>' +
          '<div id="sideHostLan" style="display:none; margin:8px 0; padding:6px 10px; background:rgba(14,107,94,0.18); border:1px solid rgba(14,107,94,0.35); border-radius:8px; cursor:pointer;" title="Click to copy hospital LAN address">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span style="color:#2dd4bf; font-weight:600; font-size:11px;">🌐 Host LAN</span>' +
              '<span style="font-size:10px; color:#94a3b8;">Copy</span>' +
            '</div>' +
            '<div id="sideHostLanText" style="font-family:Consolas, monospace; color:#f8fafc; font-size:11.5px; font-weight:700; margin-top:2px;"></div>' +
          '</div>' +
          '<div class="me"><span class="avatar">' + esc(initials) + '</span>' +
            '<span class="me-meta"><strong>' + esc(who || 'signed out') + '</strong><em>' + esc(role) + '</em></span>' +
            '<button id="outBtn" class="iconbtn" title="Sign out" aria-label="Sign out">⎋</button></div>' +
        '</div>' +
      '</aside>' +
      '<div class="main">' +
        '<header class="top">' +
          '<button id="menuBtn" class="iconbtn only-mobile" aria-label="Open navigation" aria-expanded="false" aria-controls="side">☰</button>' +
          '<div class="top-title"><h1>' + esc(title) + '</h1>' + (subtitle ? '<p>' + subtitle + '</p>' : '') + '</div>' +
          '<div class="top-actions">' + actions + '</div>' +
        '</header>' +
        '<main class="page">' + body + '</main>' +
      '</div>' +
    '</div>' +
    '<div id="toast" class="toast" role="alert" aria-live="polite" hidden></div>' +
    '<div id="modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-card"><div class="modal-head"><h3 id="modalTitle"></h3><button class="iconbtn" data-close aria-label="Close">✕</button></div><div id="modalBody" class="modal-body"></div></div></div>'

  const side = document.getElementById('side')
  const scrim = document.getElementById('sideScrim')
  const menuBtn = document.getElementById('menuBtn')
  const topbar = app.querySelector('.top')

  // Publish the real header height as `--sticky-top`. Anything else that sticks
  // to the top of the viewport (table column headers, feed filters) offsets by
  // it, so a header that wraps to two rows — or does not, after a resize — can
  // never end up tucked underneath its own header. A hardcoded value is wrong
  // as soon as the page title or the number of action buttons changes.
  if (topbar && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sticky-top', Math.round(topbar.getBoundingClientRect().height) + 'px')
    })
    ro.observe(topbar)
    onCleanup(() => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--sticky-top')
    })
  }

  // ---- mobile drawer ---------------------------------------------------------
  // Below 860px the sidebar is an off-canvas drawer. Without the scrim and the
  // body lock the page behind stays scrollable and looks like the drawer is
  // broken, so opening it dims + freezes the content and any dismiss gesture
  // (scrim, nav link, Escape, close button) puts it back.
  function setDrawer(open) {
    if (!side) return
    side.classList.toggle('open', open)
    if (scrim) scrim.classList.toggle('on', open)
    document.body.classList.toggle('nav-open', open)
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  const onResize = () => { if (window.innerWidth > 860) setDrawer(false) }
  if (menuBtn) menuBtn.onclick = () => setDrawer(!side.classList.contains('open'))
  if (scrim) scrim.onclick = () => setDrawer(false)
  document.getElementById('sideClose')?.addEventListener('click', () => setDrawer(false))
  // Every nav link is a hash change; close the drawer so the new page is visible.
  side?.querySelectorAll('.side-nav a').forEach((a) => { a.addEventListener('click', () => setDrawer(false)) })
  // Crossing back to the desktop breakpoint must not strand an open drawer state.
  window.addEventListener('resize', onResize)
  onCleanup(() => {
    window.removeEventListener('resize', onResize)
    // A route change can land on a view with no sidebar, or be triggered from
    // inside a dialog; make sure the page behind is never left frozen by an
    // overlay that no longer exists.
    document.body.classList.remove('nav-open', 'modal-open')
  })

  getHostNetworkInfo().then((info) => {
    if (!info) return
    const el = document.getElementById('sideHostLan')
    const txt = document.getElementById('sideHostLanText')
    if (el && txt) {
      const displayUrl = info.lanUrl || ('http://' + (info.addresses[0] || '127.0.0.1') + ':' + info.port)
      txt.textContent = displayUrl.replace(/^https?:\/\//, '')
      el.style.display = 'block'
      el.onclick = () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(displayUrl).then(() => toast('Copied ' + displayUrl + ' to clipboard!'))
            .catch(() => prompt('Copy this LAN URL:', displayUrl))
        } else {
          prompt('Copy this LAN URL:', displayUrl)
        }
      }
    }
  }).catch(() => {})

  document.getElementById('outBtn').onclick = async () => { await logout(); navigate('/login') }

  // The hospital name resolves from Firestore after sign-in and can arrive
  // after this shell has already rendered (slow/offline org-doc read). Keep
  // the sidebar label live so it swaps to the real name the moment it lands,
  // instead of holding a placeholder for the whole session.
  const orgLabel = document.getElementById('sideOrg')
  const unsubOrg = authStore.subscribe((s) => {
    if (!orgLabel || !orgLabel.isConnected) return
    const name = s.activeOrgName || s.activeOrg || 'Hospital'
    if (orgLabel.textContent !== name) orgLabel.textContent = name
  })
  onCleanup(unsubOrg)
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal })
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal() })

  // ---- connectivity + pending-sync badge -----------------------------------
  // The old indicator was computed once at render, so it stayed stale until the
  // next navigation. This listens to the browser's online/offline events AND
  // the clinical outbox, so the sidebar always tells the truth: offline now,
  // and exactly how many handoffs are still waiting on this device. Elements
  // are re-resolved per call because setPage/shell can swap the nodes.
  let pendingChanges = 0
  function updateSync() {
    const dot = document.getElementById('syncDot')
    const state = document.getElementById('syncState')
    const detail = document.getElementById('syncDetail')
    if (!dot || !state || !detail) return
    const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false
    const n = pendingChanges
    const plural = n === 1 ? '' : 's'
    dot.className = 'dot' + (!isOnline ? ' off' : (n > 0 ? ' warn' : ''))
    if (!isOnline) {
      const { mode, at } = getSyncMode()
      const viaHub = mode === 'hub' && Date.now() - at < 120000
      state.textContent = 'Offline · local cache'
      detail.textContent = n > 0
        ? n + ' change' + plural + ' waiting to sync'
        : (viaHub ? 'handoffs routed via hospital hub' : 'writes queue until you reconnect')
    } else {
      // Name the transport when it was the hospital hub — the whole point of
      // Phase 2 is that staff can SEE a handoff go out over the LAN while the
      // internet is down.
      const { mode, at } = getSyncMode()
      const viaHub = mode === 'hub' && Date.now() - at < 120000
      state.textContent = 'Online · Firestore'
      detail.textContent = n > 0
        ? (mode === 'hub'
            ? 'sending ' + n + ' change' + plural + ' via hospital hub…'
            : 'syncing ' + n + ' change' + plural + '…')
        : (viaHub ? 'last handoff delivered via hospital hub' : 'writes sync to the cloud')
    }
  }
  const onNetChange = () => updateSync()
  window.addEventListener('online', onNetChange)
  window.addEventListener('offline', onNetChange)
  const stopOutboxWatch = onUpdate((n) => { pendingChanges = n || 0; updateSync() })
  updateSync()
  onCleanup(() => {
    window.removeEventListener('online', onNetChange)
    window.removeEventListener('offline', onNetChange)
    stopOutboxWatch()
  })
}

// Restart a CSS animation on an element that may already carry the class.
function replay(el, cls) {
  if (!el) return
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
}

// Swap a view's title, subtitle, actions and body WITHOUT rebuilding the shell.
// The sidebar/topbar are identical between routes, so re-running shell() would
// throw away the DOM and re-trigger the blink. `setPage` keeps the chrome and
// only fades the content, so a slow Firestore read no longer shows a blank page.
// `title`/`subtitle` are plain text (assigned via textContent — pass them
// unescaped); `actions` and `body` are HTML and must be escaped by the caller.
// Returns false when no shell is mounted, so callers can fall back to shell().
export function setPage({ title, subtitle, actions, body } = {}) {
  const page = document.querySelector('.page')
  if (!page) return false
  if (title != null) {
    const h = document.querySelector('.top-title h1')
    if (h) h.textContent = title
  }
  if (subtitle !== undefined) {
    const wrap = document.querySelector('.top-title')
    let p = wrap ? wrap.querySelector('p') : null
    if (subtitle) {
      if (!p && wrap) {
        p = document.createElement('p')
        wrap.appendChild(p)
      }
      if (p) p.textContent = subtitle
    } else if (p) {
      p.remove()
    }
  }
  if (actions != null) {
    const a = document.querySelector('.top-actions')
    if (a) a.innerHTML = actions
  }
  if (body != null) {
    page.innerHTML = body
    replay(page, 'page-in')
  }
  return true
}

// Skeleton placeholder for content that is still loading. Purely visual so a
// slow read looks like a page filling in rather than a spinner jumping in.
export function skeletonCard(lines = 3) {
  return '<div class="card">' +
    '<div class="skel skel-head"></div>' +
    Array.from({ length: lines }, (_, i) => '<div class="skel' + (i === lines - 1 ? ' skel-short' : '') + '"></div>').join('') +
    '</div>'
}

// The toast and modal hosts normally come from shell()'s markup. But several
// screens never call shell() — LoginView, RegisterView, VerifyEmailView and
// ChangePasswordView all write their own #app content — and they legitimately
// need a toast or a modal. This creates the hosts on demand so openModal() /
// toast() work everywhere instead of throwing a TypeError on #modalTitle.
function ensureOverlays() {
  if (!document.getElementById('toast')) {
    const t = document.createElement('div')
    t.id = 'toast'
    t.className = 'toast'
    t.hidden = true
    document.body.appendChild(t)
  }
  if (!document.getElementById('modal')) {
    const wrap = document.createElement('div')
    wrap.id = 'modal'
    wrap.className = 'modal'
    wrap.hidden = true
    wrap.innerHTML =
      '<div class="modal-card"><div class="modal-head"><h3 id="modalTitle"></h3>' +
      '<button class="iconbtn" data-close aria-label="Close">✕</button></div><div id="modalBody" class="modal-body"></div></div>'
    document.body.appendChild(wrap)
    wrap.addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal() })
  }
}

export function toast(msg) {
  ensureOverlays()
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.hidden = false
  clearTimeout(t._h)
  t._h = setTimeout(() => { t.hidden = true }, 2600)
}

// A dialog on a phone must behave like a dialog, not like a page: the content
// behind it stops scrolling under your thumb, Escape/back drops it, and focus
// moves into it so the first field is one tap away (and the on-screen keyboard
// does not stay hidden). `lastFocus` restores focus to whatever opened it.
let lastFocus = null

export function openModal(title, html, opts = {}) {
  ensureOverlays()
  const modal = document.getElementById('modal')
  const body = document.getElementById('modalBody')
  const card = modal.querySelector('.modal-card')
  lastFocus = document.activeElement
  document.getElementById('modalTitle').textContent = title
  // `wide` gives dense clinical summaries (the full A-Z of an encounter) the
  // room to stay readable without the caller patching styles after the fact.
  if (card) card.style.maxWidth = opts.wide ? '780px' : ''
  body.innerHTML = html
  modal.hidden = false
  document.body.classList.add('modal-open')
  document.querySelectorAll('#modalBody [data-close]').forEach((b) => { b.onclick = closeModal })
  document.querySelectorAll('#modalBody [data-toast]').forEach((b) => {
    b.onclick = () => { closeModal(); toast(b.getAttribute('data-toast')) }
  })
  // Focus the first real control — the data-close ✕ is excluded so typing does
  // not begin in a box the clerk cannot see.
  const first = body.querySelector('input:not([type=hidden]),select,textarea,button:not([data-close])')
  if (first) { try { first.focus({ preventScroll: true }) } catch { /* not focusable */ } }
}

// Escape closes the topmost layer: the dialog if one is open, otherwise the
// mobile drawer. Bound once, on the document, so it works for every overlay host.
function onKeydown(e) {
  if (e.key !== 'Escape') return
  const modal = document.getElementById('modal')
  if (modal && !modal.hidden) { closeModal(); return }
  const side = document.getElementById('side')
  if (side && side.classList.contains('open')) {
    side.classList.remove('open')
    document.getElementById('sideScrim')?.classList.remove('on')
    document.body.classList.remove('nav-open')
    document.getElementById('menuBtn')?.setAttribute('aria-expanded', 'false')
  }
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onKeydown)

export function closeModal() {
  const m = document.getElementById('modal')
  if (m) m.hidden = true
  document.body.classList.remove('modal-open')
  if (lastFocus && lastFocus.isConnected) { try { lastFocus.focus({ preventScroll: true }) } catch { /* gone */ } }
  lastFocus = null
}

export function wireToast(scope = document) {
  scope.querySelectorAll('[data-toast]').forEach((b) => {
    b.onclick = () => toast(b.getAttribute('data-toast'))
  })
}

export function demoFormModal(title, fieldsHtml, saveLabel = 'Save (UI preview)') {
  openModal(title,
    '<div class="fgrid">' + fieldsHtml + '</div>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" data-toast="Saved locally (UI preview). No data was written."> ' + esc(saveLabel) + '</button></div>')
}

// Wire a filter box that narrows the options of a <select> in place. Option
// labels carry the mobile number, so a typed number is matched against digits
// only — '+234 803 123 4567' must be findable by typing '0803…'. Never leaves
// a hidden option selected, so the user can always see what they will submit.
//
// Used by formModal's `searchable` selects and exported so full-page pickers
// (lab new order, billing new invoice) can offer the exact same patient-search
// UX without a floating dropdown that can cover the input field.
export function wireSearchableSelect(box, sel) {
  if (!box || !sel) return
  const options = Array.from(sel.options)

  function fireChange() {
    // Dispatch synthetic change so listeners (onchange) always fire,
    // even when the selected index was already pointing at that option.
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }

  box.oninput = () => {
    const q = box.value.trim().toLowerCase()
    const digits = q.replace(/\D/g, '')
    for (const o of options) {
      const label = String(o.getAttribute('data-label') || o.textContent || '').toLowerCase()
      o.hidden = !(!q
        || (/[0-9]/.test(q) ? label.replace(/\D/g, '').includes(digits) : label.includes(q)))
    }
    // Auto-advance to the first visible option when the current one is hidden.
    if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden) {
      const first = options.find((o) => !o.hidden)
      sel.value = first ? first.value : ''
      fireChange()
    }
  }

  // Ensure selecting the very first real option always triggers onchange,
  // even if it was the browser's pre-selected default.
  sel.addEventListener('mousedown', () => {
    sel._beforeValue = sel.value
  })
  sel.addEventListener('change', () => {
    sel._beforeValue = sel.value
  })
  // Also handle click-to-same-option (no 'change' would fire natively).
  sel.addEventListener('click', () => {
    if (sel.value && sel.value !== '' && sel.value !== sel._beforeValue) {
      sel._beforeValue = sel.value
      fireChange()
    } else if (sel.value && sel.value !== '') {
      // Value is the same but user explicitly clicked — still fire.
      fireChange()
    }
  })
}

// Real form modal: collects named fields, shows errors inline, never claims a
// save that did not happen. `onSubmit(values)` should throw to keep the modal
// open, or close it itself (closeModal) on success.
//
// Field options beyond name/label/type/required/full/placeholder:
//   preview: function(values) => string   — read-only field, auto-computed
//            from other field values on every input event.
//   options / searchable / list / listOptions — as before.
//   tags: searchable multi-select pill input (the patient-allergy UX).
//            `options` seeds the suggestion list, `value` the initial pills,
//            and the collected value is the tags joined with ', '. Free text
//            is still allowed — anything typed and confirmed with Enter is
//            kept even when it is not on the suggestion list.
//   hint: true — reserve an inline hint line right under the input
//            (element: #fmFields [data-hint="name"]); views fill it with
//            live validation info close to the box.
//
// `onInput(values)` — optional callback fired on every input change, after
// preview fields are recomputed. Useful for live validation side-effects.
export function formModal({ title, fields = [], body = '', submitLabel = 'Save', onSubmit, onInput }) {
  const html = fields.map((f, fi) => {
    let inner
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      // A plain <select> cannot be typed into, so on a long patient list the
      // only way to reach a record is to scroll. `searchable` adds a filter box
      // that narrows the options in place — the saved value is still the option
      // value, so filtering can never change what gets submitted.
      const filterId = 'fsel' + fi
      inner = (f.searchable
        ? '<input class="input" style="margin-bottom:6px" data-filter-for="' + filterId +
          '" placeholder="' + esc(f.searchPlaceholder || 'Type to filter…') + '" autocomplete="off">'
        : '') +
        '<select class="input" name="' + esc(f.name) + '" id="' + filterId + '">' +
        opts.map((o, oi) => '<option value="' + esc(o.value) + '" data-label="' + esc(o.label) + '"' + (o.value === (f.value ?? '') ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
        '</select>'
    } else if (f.type === 'textarea') {
      inner = '<textarea class="input" name="' + esc(f.name) + '" rows="3" placeholder="' + esc(f.placeholder || '') + '">' + esc(f.value ?? '') + '</textarea>'
    } else if (f.type === 'checks') {
      // Checkbox group: collects a list of ticked values under one name, so a
      // single order can carry several tests/studies. `options` entries are
      // strings or {value,label,checked}; `value` seeds the initial ticks.
      const preset = Array.isArray(f.value) ? f.value.map(String) : []
      inner = '<div class="checks" data-checks="' + esc(f.name) + '">' +
        (f.options || []).map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o
          const checked = opt.checked || preset.includes(String(opt.value))
          return '<label class="chk"><input type="checkbox" name="' + esc(f.name) + '" value="' + esc(opt.value) + '"' +
            (checked ? ' checked' : '') + '> <span>' + esc(opt.label) + '</span></label>'
        }).join('') +
        '</div>'
    } else if (f.type === 'tags') {
      // Searchable multi-select pill input — same UX as the patient-allergy
      // field: type to filter the common list, Enter or click adds a pill,
      // free text still allowed for anything not on the list. Mounted after
      // openModal() (see below); wrapped in a <div> rather than a <label> so
      // clicks on suggestion rows are not forwarded to the text input.
      inner = '<div class="allergy-tag-container fm-tags" data-tags-field="' + esc(f.name) + '"></div>'
    } else if (f.preview !== undefined) {
      // Read-only preview field: value is computed from other fields via
      // f.preview(values). The .ro class gives it a tinted, monospace,
      // dashed-border look so it reads as "derived" not "typed".
      inner = '<input class="input ro" type="text" name="' + esc(f.name) + '" data-preview="' + esc(f.name) + '"' +
        ' readonly placeholder="' + esc(f.placeholder || '') + '" value="' + esc(typeof f.preview === 'function' ? f.preview({}) : (f.preview || '')) + '" />'
    } else {
      inner = '<input class="input" type="' + esc(f.type || 'text') + '" name="' + esc(f.name) + '"' +
        (f.list ? ' list="' + esc(f.list) + '"' : '') +
        ' placeholder="' + esc(f.placeholder || '') + '" value="' + esc(f.value ?? '') + '" />' +
        (f.list && f.listOptions ? '<datalist id="' + esc(f.list) + '">' + f.listOptions.map((o) => '<option value="' + esc(typeof o === 'string' ? o : o.value) + '">').join('') + '</datalist>' : '')
    }
    const wrap = f.type === 'tags' ? 'div' : 'label'
    return '<' + wrap + ' class="fld' + (f.full ? ' full' : '') + '"><span>' + esc(f.label) + (f.required ? ' *' : '') + '</span>' + inner +
      (f.hint ? '<small class="fldhint" data-hint="' + esc(f.name) + '" hidden></small>' : '') + '</' + wrap + '>'
  }).join('')

  // Live instances of the pill inputs, keyed by field name. `collectValues`
  // reads the tags from here rather than from the DOM, because the visible
  // text box only holds whatever is half-typed — the actual list lives in
  // the component. Declared before openModal() so the mount loop below can
  // populate it synchronously.
  const tagInputs = {}

  openModal(title,
    // `body` is the escape hatch for a confirm-style modal that shows a summary
    // instead of inputs (e.g. "Possible duplicate patient" with a Register anyway
    // submit). It is passed through verbatim — callers are responsible for
    // escaping it — and `fields` is ignored, since there is nothing to collect.
    (body ? body : '<div class="fgrid" id="fmFields">' + html + '</div>') +
    '<p id="fmError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" id="fmSave">' + esc(submitLabel) + '</button></div>')

  // Mount the pill inputs into their placeholder containers. The markup alone
  // cannot carry them — the suggestion box, keyboard handling and hidden JSON
  // state are all wired by createAllergyTagInput (the same component the
  // patient-allergy field uses, so both inputs behave identically).
  document.querySelectorAll('#fmFields [data-tags-field]').forEach((c) => {
    const name = c.getAttribute('data-tags-field')
    const f = fields.find((x) => x.name === name) || {}
    tagInputs[name] = createAllergyTagInput(c, {
      value: Array.isArray(f.value) ? f.value : [],
      suggestions: Array.isArray(f.options) ? f.options : [],
      placeholder: f.placeholder || 'Type and press Enter to add',
      name,
      onChange: () => refreshPreviews(),
    })
  })

  // Collect every named control. Checkbox groups collapse to an array of the
  // ticked values; pill inputs collapse to their tags joined with ', ';
  // everything else is a trimmed string. Shared by the live preview pass and
  // the final submit so both agree on the shape.
  function collectValues() {
    const values = {}
    document.querySelectorAll('#fmFields [name]').forEach((el) => {
      if (el.closest('.fm-tags')) return
      if (el.type === 'checkbox') {
        if (!Array.isArray(values[el.name])) values[el.name] = []
        if (el.checked) values[el.name].push(String(el.value || '').trim())
      } else {
        values[el.name] = String(el.value || '').trim()
      }
    })
    for (const name of Object.keys(tagInputs)) {
      values[name] = tagInputs[name].getValue().join(', ')
    }
    return values
  }

  // Recompute preview fields and fire the onInput callback. Called on every
  // keystroke in any named field.
  function refreshPreviews() {
    const values = collectValues()
    fields.forEach((f) => {
      if (typeof f.preview === 'function') {
        const previewEl = document.querySelector('#fmFields [data-preview="' + f.name + '"]')
        if (previewEl) previewEl.value = f.preview(values)
      }
    })
    if (onInput) onInput(values)
  }

  // Wire input events so previews stay live. (The filter boxes above use
  // oninput separately for select-filtering; those are not [name] fields so
  // there is no collision.)
  document.querySelectorAll('#fmFields [name]').forEach((el) => {
    el.oninput = refreshPreviews
    el.onchange = refreshPreviews
  })

  document.querySelectorAll('#fmFields [data-filter-for]').forEach((box) => {
    wireSearchableSelect(box, document.getElementById(box.getAttribute('data-filter-for')))
  })

  const errEl = document.getElementById('fmError')
  const btn = document.getElementById('fmSave')
  const label = btn.textContent
  btn.onclick = async () => {
    const values = collectValues()
    errEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Saving…'
    try {
      await onSubmit(values)
      // Re-enable unconditionally once onSubmit settles. A caller that closes
      // the modal on success is unaffected (the node is gone); a caller that
      // resolves without closing can no longer leave the button latched at
      // "Saving…" with no way back.
      btn.disabled = false
      btn.textContent = label
    } catch (e) {
      errEl.textContent = e?.message || 'Something went wrong. Please retry.'
      btn.disabled = false
      btn.textContent = label
    }
  }
}

// ---- Inline field validation helpers -----------------------------------------
// Usage: <label class="fld">Label<input class="input" data-validate="required|email|phone|number" data-hint="hint-id" /></label>
// After form modal renders, call wireValidation(root) to attach listeners.
// On input, validates and shows/hides hint. On submit, checks all fields.

function validateField(el) {
  const rules = (el.dataset.validate || '').split('|').filter(Boolean)
  if (!rules.length) return true
  const value = (el.value || '').trim()
  for (const rule of rules) {
    if (rule === 'required' && !value) return false
    if (rule === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false
    if (rule === 'phone' && value && !/^[\d\s+\-()]{7,}$/.test(value)) return false
    if (rule === 'number' && value && isNaN(Number(value))) return false
    if (rule.startsWith('min:') && value) {
      const min = Number(rule.split(':')[1])
      if (Number(value) < min) return false
    }
    if (rule.startsWith('max:') && value) {
      const max = Number(rule.split(':')[1])
      if (Number(value) > max) return false
    }
    if (rule.startsWith('minlen:') && value) {
      const min = Number(rule.split(':')[1])
      if (value.length < min) return false
    }
  }
  return true
}

function showFieldError(el, show) {
  const hintId = el.dataset.hint
  if (!hintId) return
  const hint = document.getElementById(hintId)
  if (!hint) return
  hint.textContent = el.dataset.errormsg || 'Invalid value'
  hint.hidden = !show
  el.classList.toggle('invalid', show)
  el.classList.toggle('valid', !show)
}

export function wireValidation(root) {
  root.querySelectorAll('[data-validate]').forEach((el) => {
    el.oninput = () => showFieldError(el, !validateField(el))
    el.onblur = () => showFieldError(el, !validateField(el))
  })
}

export function validateForm(root) {
  let valid = true
  root.querySelectorAll('[data-validate]').forEach((el) => {
    const ok = validateField(el)
    showFieldError(el, !ok)
    if (!ok) valid = false
  })
  return valid
}

export function field(label, inner) {
  return '<label class="fld"><span>' + esc(label) + '</span>' + inner + '</label>'
}
export function inp(ph = '', type = 'text') {
  return '<input class="input" type="' + type + '" placeholder="' + esc(ph) + '" />'
}
export function sel(opts) {
  return '<select class="input">' + opts.map((o) => '<option>' + esc(o) + '</option>').join('') + '</select>'
}
