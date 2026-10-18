// Laboratory dashboard + worklist (LIMS).
// Orders are opened on full pages (#/laboratory/orders/:id) where the
// per-test workflow (collect → receive → result → validate → release) lives;
// this screen is the queue: stats, stage chips, search, live updates.
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgLabsPage, subscribeOrgLabs, updateLabStatus, myLabCaps,
} from '../services/laboratoryService.js'
import { listOrgPatientsPage, matchesPatient } from '../services/patientService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { ITEM_STATUS } from '../features/labs/domain.js'

const STAGES = [
  { value: 'All', label: 'All' },
  { value: 'order', label: 'Awaiting collection' },
  { value: 'specimen-collected', label: 'In transit / lab' },
  { value: 'processing', label: 'In lab' },
  { value: 'completed', label: 'Awaiting validation' },
  { value: 'verified', label: 'Released' },
  { value: 'cancelled', label: 'Cancelled' },
]

function priorityPill(p) {
  const cls = p === 'STAT' ? 'bad' : p === 'Urgent' ? 'warn' : ''
  return '<span class="pill ' + cls + '">' + esc(p || 'Routine') + '</span>'
}

const ORDER_STATUS_META = {
  order: ['Placed', 'warn'],
  accepted: ['Accepted', 'info'],
  'specimen-collected': ['Specimen collected', 'info'],
  processing: ['Processing', 'info'],
  completed: ['Completed', 'ok'],
  verified: ['Verified / released', 'ok'],
  cancelled: ['Cancelled', 'bad'],
}

function orderBadge(s) {
  const m = ORDER_STATUS_META[s] || [s, '']
  return '<span class="pill ' + m[1] + '">' + esc(m[0]) + '</span>'
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export async function LaboratoryView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myLabCaps()

  if (!activeOrg) {
    shell(app, {
      active: '/laboratory',
      title: 'Laboratory',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    wireToast(app)
    return
  }

  let labOrders = []
  let patients = []
  let patientIndex = new Map()
  let patientLoadError = null
  let stageFilter = 'All'
  let searchQuery = ''
  let cursor = null
  let hasMore = false
  let loading = false
  let loadError = false
  let unsubs = []
  let watchedOrg = activeOrg

  shell(app, {
    active: '/laboratory',
    title: 'Laboratory',
    subtitle: 'Order → Collect → Receive → Result → Validate → Release · each test tracks independently',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canOrder ? '<a class="btn" href="#/laboratory/new">+ New lab order</a>' : ''),
    body:
      '<div class="grid4">' +
      '<div class="stat"><em>Ordered</em><strong id="lab-ordered">0</strong><span>awaiting collection</span></div>' +
      '<div class="stat"><em>In lab</em><strong id="lab-inlab">0</strong><span>collected / processing</span></div>' +
      '<div class="stat"><em>Needs sign-off</em><strong id="lab-awaiting">0</strong><span>validation or release</span></div>' +
      '<div class="stat"><em>Released</em><strong id="lab-released">0</strong><span>verified results</span></div></div>' +
      '<div class="card"><div class="flow">' +
      '<span class="fstep done">Order</span><span class="farrow">→</span>' +
      '<span class="fstep">Collect</span><span class="farrow">→</span>' +
      '<span class="fstep">Receive</span><span class="farrow">→</span>' +
      '<span class="fstep">Result</span><span class="farrow">→</span>' +
      '<span class="fstep">Validate</span><span class="farrow">→</span>' +
      '<span class="fstep">Release</span></div>' +
      '<div class="toolbar"><div class="search" style="flex:1;max-width:340px"><input class="input" id="searchInput" placeholder="Search patient, mobile, test, or ID…" value="' + esc(searchQuery) + '"></div>' +
      '<div class="chips" id="stages">' + STAGES.map((s, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-stage="' + esc(s.value) + '">' + esc(s.label) + '</button>').join('') + '</div></div>' +
      '<div id="loadError" class="card" style="display:none;text-align:center;padding:24px"><p class="sub">Failed to load lab orders.</p><button class="btn ghost" id="retryBtn">Retry</button></div>' +
      '<div class="tblwrap"><table class="tbl" id="lab-tbl"><tr><th>Order</th><th>Patient</th><th>Tests</th><th>Stage</th><th>Priority</th><th>Billing</th><th>Date</th><th></th></tr>' +
      '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table><div class="loadmore" data-loadmore="1"></div></div></div>',
  })
  wireToast(app)
  const more = createLoadMore(loadMore)

  async function loadPatients() {
    try {
      const r = await listOrgPatientsPage(activeOrg, { pageSize: 100 })
      patients = r.rows
      patientIndex = new Map(patients.map((p) => [p.pid, p]))
      patientLoadError = null
    } catch (e) {
      console.error('[laboratory] patient load failed:', e)
      patientLoadError = e
      patients = []
      patientIndex = new Map()
    }
  }

  async function loadMore() {
    if (loading) return
    const first = cursor == null && labOrders.length === 0
    loading = true
    more.setLoading(true)
    const wrap = document.getElementById('lab-tbl')?.closest('.tblwrap')
    wrap?.classList.add('is-loading')
    if (first) {
      loadError = false
      document.getElementById('loadError').style.display = 'none'
    }
    try {
      const pg = await listOrgLabsPage(activeOrg, { cursor })
      const seen = new Set(labOrders.map((l) => l.id))
      labOrders = first ? pg.rows : [...labOrders, ...pg.rows.filter((l) => !seen.has(l.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
    } catch (e) {
      console.error('[laboratory] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) {
        loadError = true
        document.getElementById('loadError').style.display = ''
        toast('Could not load lab orders: ' + friendlyWriteError(e))
      } else {
        more.setError('Could not load more — retry')
      }
    } finally {
      wrap?.classList.remove('is-loading')
    }
  }

  function reload() {
    labOrders = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadPatients().then(render)
    loadMore().then(subscribeLive)
  }

  function patientName(l) {
    return l.patientName || (patientIndex.get(l.patientId) || {}).name || '—'
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    // Item-level counts where items exist; fall back to the order rollup.
    let awaiting = 0; let inLab = 0; let needs = 0; let released = 0
    for (const l of labOrders) {
      const items = (l.items && l.items.length) ? l.items : null
      if (items) {
        for (const it of items) {
          if (it.status === ITEM_STATUS.ORDERED) awaiting++
          else if (it.status === ITEM_STATUS.SAMPLE_COLLECTED || it.status === ITEM_STATUS.RECEIVED) inLab++
          else if (it.status === ITEM_STATUS.RESULT_ENTERED || it.status === ITEM_STATUS.VALIDATED) needs++
          else if (it.status === ITEM_STATUS.RELEASED) released++
        }
      } else {
        if (l.status === 'order' || l.status === 'accepted' || l.status === 'specimen-collected') awaiting++
        else if (l.status === 'processing') inLab++
        else if (l.status === 'completed') needs++
        else if (l.status === 'verified') released++
      }
    }
    set('lab-ordered', awaiting)
    set('lab-inlab', inLab)
    set('lab-awaiting', needs)
    set('lab-released', released)

    const tbl = document.getElementById('lab-tbl')
    if (!tbl) return
    if (labOrders.length) document.getElementById('loadError').style.display = 'none'
    const head = '<tr><th>Order</th><th>Patient</th><th>Tests</th><th>Stage</th><th>Priority</th><th>Billing</th><th>Date</th><th></th></tr>'

    const q = searchQuery.toLowerCase()
    const filtered = labOrders.filter((l) => {
      if (stageFilter !== 'All' && l.status !== stageFilter) return false
      if (!q) return true
      if ((l.patientName || '').toLowerCase().includes(q) ||
        (l.testPanel || '').toLowerCase().includes(q) ||
        (l.orderNo || '').toLowerCase().includes(q) ||
        (l.id || '').toLowerCase().includes(q)) return true
      const p = patientIndex.get(l.patientId)
      return !!p && matchesPatient(p, q)
    })

    const rows = filtered.map((l) => {
      const billing = l.billingStatus === 'invoiced'
        ? '<span class="pill ok">Invoiced</span>'
        : '<span class="pill warn">Unbilled</span>'
      const items = (l.items && l.items.length) ? l.items : []
      const done = items.filter((it) => it.status === ITEM_STATUS.RELEASED).length
      const testCell = items.length
        ? esc(l.testPanel) + (done ? ' <span class="mut">(' + done + '/' + items.length + ' released)</span>' : '')
        : esc(l.testPanel || '—')
      return '<tr class="clickable" data-open="' + esc(l.id) + '">' +
        '<td><strong>' + esc(l.orderNo || l.id.slice(0, 8)) + '</strong>' +
        (l.source === 'standalone' ? '<div class="mut">standalone</div>' : '') + '</td>' +
        '<td><a href="#/patients/' + esc(l.patientId) + '"><strong>' + esc(patientName(l)) + '</strong></a></td>' +
        '<td>' + testCell + '</td>' +
        '<td>' + orderBadge(l.status) + '</td>' +
        '<td>' + priorityPill(l.priority) + (l.facility === 'external' ? ' <span class="pill info">Ext</span>' : '') + '</td>' +
        '<td>' + billing + '</td>' +
        '<td class="mut">' + fmtDate(l.orderedAt) + '</td>' +
        '<td><a class="btn ghost sm" href="#/laboratory/orders/' + esc(l.id) + '">Open</a></td></tr>'
    }).join('')

    tbl.innerHTML = head + (rows || '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">No lab orders found</td></tr>')
    more.mount(tbl.closest('.tblwrap'))

    tbl.querySelectorAll('[data-open]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('a')) return
        window.location.hash = '#/laboratory/orders/' + row.getAttribute('data-open')
      }
    })
  }

  document.querySelectorAll('#stages .chip').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('#stages .chip').forEach((x) => x.classList.remove('on'))
      c.classList.add('on')
      stageFilter = c.getAttribute('data-stage')
      render()
    }
  })

  let searchTimer
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim()
      render()
    }, 250)
  })

  document.getElementById('refreshBtn').onclick = reload
  document.getElementById('retryBtn').onclick = reload

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    if (cursor != null) return
    unsubs.push(
      subscribeOrgLabs(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(labOrders.map((l) => l.id))
          labOrders = rows.filter((l) => !seen.has(l.id)).concat(labOrders)
          render()
        },
        (e) => {
          console.warn('[laboratory] live update failed; refreshing once:', e?.message || e)
          listOrgLabsPage(watchedOrg)
            .then((r) => { labOrders = r.rows; render() })
            .catch(() => {})
        }),
    )
  }

  onCleanup(() => {
    teardownListeners()
    unsubAuth()
  })

  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    subscribeLive()
  })

  reload()
  subscribeLive()
}
