// Shared EMR app shell: sidebar + topbar + toast + modal (UI only, no logic).
import { authStore } from '../store/authStore.js'
import { logout, myActiveMembership } from '../services/authService.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'
import { ORG } from '../data/mockData.js'

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
  const map = {
    Paid: 'ok', Dispensed: 'ok', Verified: 'ok', Synced: 'ok', Completed: 'ok', Active: 'ok', 'Checked-in': 'ok',
    'Part-paid': 'warn', Pending: 'warn', Ready: 'warn', Waiting: 'warn', Low: 'warn', 'With vitals': 'warn',
    'In consultation': 'info', Processing: 'info', Confirmed: 'info', Admitted: 'info', Accepted: 'info', 'Specimen collected': 'info',
    Unpaid: 'bad', Out: 'bad', Expiring: 'bad', Overdue: 'bad',
    Scheduled: '', Open: '', OK: 'ok', 'NHIA claim': 'info',
  }
  const cls = map[s] || ''
  return '<span class="pill ' + cls + '">' + esc(s) + '</span>'
}

export function shell(app, { active, title, subtitle = '', actions = '', body = '' }) {
  const { user, activeOrgName } = authStore.getState()
  const email = user?.email || ''
  const org = activeOrgName || ORG.name
  const initials = (email || 'u').slice(0, 2).toUpperCase()
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  const me = myActiveMembership()
  const role = me?.role ? String(me.role).replace(/_/g, ' ') : 'member'

  app.innerHTML =
    '<div class="emr">' +
      '<aside class="side" id="side">' +
        '<div class="side-brand"><span class="brand-mark">✚</span>' +
          '<span><strong>MediLog NG</strong><em>' + esc(org) + '</em></span></div>' +
        '<nav class="side-nav">' +
          NAV.map((n) => '<a href="#' + n.path + '" class="' + (n.path === active ? 'on' : '') + '">' +
            '<span class="ic">' + n.icon + '</span>' + esc(n.label) + '</a>').join('') +
        '</nav>' +
        '<div class="side-foot">' +
          '<div class="sync"><span class="dot"></span><span><strong>' +
            (online ? 'Online · Firestore' : 'Offline · local cache') +
            '</strong><em>' + (online ? 'writes sync to the cloud' : 'writes queue until you reconnect') + '</em></span></div>' +
          '<div class="me"><span class="avatar">' + esc(initials) + '</span>' +
            '<span class="me-meta"><strong>' + esc(email || 'signed out') + '</strong><em>' + esc(role) + '</em></span>' +
            '<button id="outBtn" class="iconbtn" title="Sign out">⎋</button></div>' +
        '</div>' +
      '</aside>' +
      '<div class="main">' +
        '<header class="top">' +
          '<button id="menuBtn" class="iconbtn only-mobile">☰</button>' +
          '<div class="top-title"><h1>' + esc(title) + '</h1>' + (subtitle ? '<p>' + subtitle + '</p>' : '') + '</div>' +
          '<div class="top-actions">' + actions + '</div>' +
        '</header>' +
        '<main class="page">' + body + '</main>' +
      '</div>' +
    '</div>' +
    '<div id="toast" class="toast" hidden></div>' +
    '<div id="modal" class="modal" hidden><div class="modal-card"><div class="modal-head"><h3 id="modalTitle"></h3><button class="iconbtn" data-close>✕</button></div><div id="modalBody" class="modal-body"></div></div></div>'

  document.getElementById('menuBtn').onclick = () => document.getElementById('side').classList.toggle('open')
  document.getElementById('outBtn').onclick = async () => { await logout(); navigate('/login') }
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal })
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal() })
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

export function toast(msg) {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.hidden = false
  clearTimeout(t._h)
  t._h = setTimeout(() => { t.hidden = true }, 2600)
}

export function openModal(title, html) {
  document.getElementById('modalTitle').textContent = title
  document.getElementById('modalBody').innerHTML = html
  document.getElementById('modal').hidden = false
  document.querySelectorAll('#modalBody [data-close]').forEach((b) => { b.onclick = closeModal })
  document.querySelectorAll('#modalBody [data-toast]').forEach((b) => {
    b.onclick = () => { closeModal(); toast(b.getAttribute('data-toast')) }
  })
}

export function closeModal() {
  const m = document.getElementById('modal')
  if (m) m.hidden = true
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

// Real form modal: collects named fields, shows errors inline, never claims a
// save that did not happen. `onSubmit(values)` should throw to keep the modal
// open, or close it itself (closeModal) on success.
export function formModal({ title, fields = [], submitLabel = 'Save', onSubmit }) {
  const html = fields.map((f) => {
    let inner
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      inner = '<select class="input" name="' + esc(f.name) + '">' +
        opts.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === (f.value ?? '') ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
        '</select>'
    } else if (f.type === 'textarea') {
      inner = '<textarea class="input" name="' + esc(f.name) + '" rows="3" placeholder="' + esc(f.placeholder || '') + '">' + esc(f.value ?? '') + '</textarea>'
    } else {
      inner = '<input class="input" type="' + esc(f.type || 'text') + '" name="' + esc(f.name) + '"' +
        (f.list ? ' list="' + esc(f.list) + '"' : '') +
        ' placeholder="' + esc(f.placeholder || '') + '" value="' + esc(f.value ?? '') + '" />' +
        (f.list && f.listOptions ? '<datalist id="' + esc(f.list) + '">' + f.listOptions.map((o) => '<option value="' + esc(typeof o === 'string' ? o : o.value) + '">').join('') + '</datalist>' : '')
    }
    return '<label class="fld' + (f.full ? ' full' : '') + '"><span>' + esc(f.label) + (f.required ? ' *' : '') + '</span>' + inner + '</label>'
  }).join('')

  openModal(title,
    '<div class="fgrid" id="fmFields">' + html + '</div>' +
    '<p id="fmError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" id="fmSave">' + esc(submitLabel) + '</button></div>')

  const errEl = document.getElementById('fmError')
  const btn = document.getElementById('fmSave')
  const label = btn.textContent
  btn.onclick = async () => {
    const values = {}
    document.querySelectorAll('#fmFields [name]').forEach((el) => { values[el.name] = String(el.value || '').trim() })
    errEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Saving…'
    try {
      await onSubmit(values)
    } catch (e) {
      errEl.textContent = e?.message || 'Something went wrong. Please retry.'
      btn.disabled = false
      btn.textContent = label
    }
  }
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
