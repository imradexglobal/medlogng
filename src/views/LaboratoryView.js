// Laboratory dashboard + worklist (LIMS).
// Orders are opened on full pages (#/laboratory/orders/:id) where the
// per-test workflow (collect → receive → result → validate → release) lives;
// this screen is the queue: stats, stage chips, search, live updates.
import { shell, toast, wireToast, skeletonCard } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgLabsPage, subscribeOrgLabs, updateLabStatus, myLabCaps,
} from '../services/laboratoryService.js'
import { listOrgPatientsPage, matchesPatient } from '../services/patientService.js'
import { createInvoiceForLabOrder } from '../services/billingService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { fmtDate } from '../utils/format.js'
import { ITEM_STATUS, ITEM_STATUS_META } from '../features/labs/domain.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteLabOrder } from '../services/deleteService.js'

const naira = (kobo) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG')

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
  rejected: ['Rejected', 'bad'],
  cancelled: ['Cancelled', 'bad'],
}

function orderBadge(s) {
  const m = ORDER_STATUS_META[s] || [s, '']
  return '<span class="pill ' + m[1] + '">' + esc(m[0]) + '</span>'
}

const STAGES = [
  { value: 'All', label: 'All' },
  { value: 'order', label: 'Awaiting collection' },
  { value: 'specimen-collected', label: 'In transit / lab' },
  { value: 'processing', label: 'In lab' },
  { value: 'completed', label: 'Awaiting validation' },
  { value: 'verified', label: 'Released' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

function defaultTurnaroundHours(priority) {
  return priority === 'STAT' ? 2 : priority === 'Urgent' ? 4 : 24
}

// True when the order is past its expected turnaround and not yet terminal.
function isOverdue(l) {
  if (!l.orderedAt) return false
  if (l.status === 'verified' || l.status === 'cancelled' || l.status === 'rejected') return false
  let maxHours = 0
  for (const it of (l.items || [])) {
    const t = it.snapshot && it.snapshot.turnaround_hours != null ? Number(it.snapshot.turnaround_hours) : null
    if (t != null && t > maxHours) maxHours = t
  }
  if (!maxHours) maxHours = defaultTurnaroundHours(l.priority)
  return Date.now() - l.orderedAt > maxHours * 60 * 60 * 1000
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
  let patientFilter = 'All'
  let searchQuery = ''
  let cursor = null
  let hasMore = false
  let loading = false
  let loadError = false
  let unsubs = []
  let watchedOrg = activeOrg
  let pfTimer = null

  const initialBody = loading
    ? '<div style="padding:24px">' + skeletonCard(4) + '</div>'
    : null

  shell(app, {
    active: '/laboratory',
    title: 'Laboratory',
    subtitle: 'Order → Collect → Receive → Result → Validate → Release · each test tracks independently',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canOrder ? '<a class="btn" href="#/laboratory/new">+ New lab order</a>' : ''),
    body: initialBody || (
      '<div class="grid4">' +
      '<div class="stat"><em>Ordered</em><strong id="lab-ordered">0</strong><span>awaiting collection</span></div>' +
      '<div class="stat"><em>In lab</em><strong id="lab-inlab">0</strong><span>collected / processing</span></div>' +
      '<div class="stat"><em>Needs sign-off</em><strong id="lab-awaiting">0</strong><span>validation or release</span></div>' +
      '<div class="stat"><em>Released</em><strong id="lab-released">0</strong><span>verified results</span></div></div>' +
      '<div class="card"><div class="flow">' +
      '<span class="fstep" data-stage="order">Order</span><span class="farrow">→</span>' +
      '<span class="fstep" data-stage="specimen-collected">Collect</span><span class="farrow">→</span>' +
      '<span class="fstep" data-stage="processing">Receive</span><span class="farrow">→</span>' +
      '<span class="fstep" data-stage="completed">Result</span><span class="farrow">→</span>' +
      '<span class="fstep" data-stage="verified">Validate</span><span class="farrow">→</span>' +
      '<span class="fstep" data-stage="cancelled">Release</span></div>' +
      '<div class="toolbar"><div class="patient-filter" style="flex:1;min-width:220px"><input class="input" id="patientFilterInput" placeholder="Filter by patient…" value="' + esc(searchQuery) + '"></div>' +
      '<div class="chips" id="stages">' + STAGES.map((s, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-stage="' + esc(s.value) + '">' + esc(s.label) + '</button>').join('') + '</div></div>' +
      '<div id="loadError" class="card" style="display:none;text-align:center;padding:24px"><p class="sub">Failed to load lab orders.</p><button class="btn ghost" id="retryBtn">Retry</button></div>' +
      '<div class="tblwrap"><table class="tbl" id="lab-tbl"><thead><tr><th>Order</th><th>Patient</th><th>Tests</th><th>Stage</th><th>Priority</th><th>Billing</th><th>Date</th><th style="width:140px">Actions</th></tr></thead><tbody>' +
      '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</tbody></table><div class="loadmore" data-loadmore="1"></div></div></div>'
    ),
  })
  wireToast(app)
  const more = createLoadMore(loadMore)

  async function loadPatients() {
    try {
      const r = await listOrgPatientsPage(activeOrg, { pageSize: 200 })
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
    loadPatients().then(render).catch((e) => console.warn('[lab] patient list load failed:', e?.message || e))
    loadMore().then(subscribeLive).catch((e) => {
      console.warn('[lab] orders load failed:', e?.message || e)
      toast('Could not load lab orders — check your connection')
    })
  }

  function patientName(l) {
    return l.patientName || (patientIndex.get(l.patientId) || {}).name || '—'
  }

  function patientMeta(l) {
    const p = patientIndex.get(l.patientId)
    if (!p) return ''
    const parts = []
    if (p.mrn) parts.push(p.mrn)
    if (p.phone) parts.push(formatPhone(p.phone, p.phone_key))
    return parts.join(' · ')
  }

  function formatPhone(phone, key) {
    if (!phone) return ''
    const digits = String(phone).replace(/\D/g, '')
    if (key === 'NG' || digits.startsWith('234')) {
      const local = digits.replace(/^234/, '0')
      return local.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')
    }
    return phone
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
    const head = '<thead><tr><th>Order</th><th>Patient</th><th>Tests</th><th>Stage</th><th>Priority</th><th>Billing</th><th>Date</th><th style="width:140px">Actions</th></tr></thead>'

    const q = searchQuery.toLowerCase()
    const filtered = labOrders.filter((l) => {
      if (stageFilter !== 'All' && l.status !== stageFilter) return false
      if (patientFilter !== 'All' && l.patientId !== patientFilter) return false
      if (!q) return true
      if ((l.patientName || '').toLowerCase().includes(q) ||
        (l.testPanel || '').toLowerCase().includes(q) ||
        (l.orderNo || '').toLowerCase().includes(q) ||
        (l.id || '').toLowerCase().includes(q)) return true
      const p = patientIndex.get(l.patientId)
      if (p) {
        if (matchesPatient(p, q)) return true
        if ((p.mrn || '').toLowerCase().includes(q)) return true
        if ((p.phone || '').toLowerCase().includes(q.replace(/\D/g, ''))) return true
      }
      return false
    })

    const rows = filtered.map((l) => {
      const overdue = isOverdue(l)
      const billing = l.billingStatus === 'invoiced'
        ? '<span class="pill ok">Invoiced</span>'
        : '<span class="pill warn">Unbilled</span>'
      const items = (l.items && l.items.length) ? l.items : []
      const done = items.filter((it) => it.status === ITEM_STATUS.RELEASED).length
      const testCell = items.length
        ? esc(l.testPanel) + (done ? ' <span class="mut">(' + done + '/' + items.length + ' released)</span>' : '')
        : esc(l.testPanel || '—')
      const pm = patientMeta(l)
      return '<tr class="clickable" data-open="' + esc(l.id) + '"' + (overdue ? ' class="overdue"' : '') + '>' +
        '<td><strong>' + esc(l.orderNo || l.id.slice(0, 8)) + '</strong>' +
        (l.source === 'standalone' ? '<div class="mut">standalone</div>' : '') +
        (overdue ? ' <span class="pill bad" style="font-size:.7rem;margin-top:4px">Overdue</span>' : '') + '</td>' +
        '<td><a href="#/patients/' + esc(l.patientId) + '"><strong>' + esc(patientName(l)) + '</strong></a>' +
        (pm ? '<div class="mut">' + esc(pm) + '</div>' : '') + '</td>' +
        '<td>' + testCell + '</td>' +
        '<td>' + orderBadge(l.status) + '</td>' +
        '<td>' + priorityPill(l.priority) + (l.facility === 'external' ? ' <span class="pill info">Ext</span>' : '') + '</td>' +
        '<td>' + billing + '</td>' +
        '<td class="mut">' + fmtDate(l.orderedAt) + '</td>' +
        '<td style="white-space:nowrap">' + kebabCell({ rowId: l.id, items: [
          ...(l.billingStatus !== 'invoiced' && caps.canBill ? [{ label: 'Bill', dataAction: 'bill' }] : []),
          { label: 'Open', dataAction: 'open' },
          ...(canDeleteRecords() ? [{ label: 'Delete', tone: 'danger', dataAction: 'delete' }] : [])
        ] }) + '</td></tr>'
    }).join('')

    const empty = !filtered.length
    tbl.innerHTML = head + '<tbody>' + (empty
      ? '<tr><td colspan="8" class="empty-state" style="text-align:center;padding:40px 8px"><div class="empty-icon">🧪</div><div class="mut">No lab orders found</div>' +
        (caps.canOrder ? '<div style="margin-top:12px"><a class="btn" href="#/laboratory/new">+ New lab order</a></div>' : '') +
        '</td></tr>'
      : rows || '') + '</tbody>'
    more.mount(tbl.closest('.tblwrap'))

    // Highlight the flow step matching the active stage filter.
    document.querySelectorAll('.flow .fstep').forEach((s) => {
      s.classList.toggle('now', s.getAttribute('data-stage') === stageFilter && stageFilter !== 'All')
    })

    tbl.querySelectorAll('[data-open]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('a, button')) return
        window.location.hash = '#/laboratory/orders/' + row.getAttribute('data-open')
      }
    })
    wireKebabs(tbl, async (rowId, action) => {
      const l = labOrders.find((x) => x.id === rowId)
      if (!l) return
      if (action === 'bill') {
        const order = labOrders.find((x) => x.id === rowId)
        if (!order) return
        try {
          await createInvoiceForLabOrder(order)
          toast('Invoice raised for ' + esc(order.patientName || 'patient'))
          reload()
        } catch (e) {
          toast('Could not bill: ' + friendlyWriteError(e))
        }
      }
      if (action === 'open') {
        window.location.hash = '#/laboratory/orders/' + rowId
        return
      }
      if (action === 'delete') {
        confirmDelete('lab order ' + (l.orderNo || l.id.slice(0, 8)), () => deleteLabOrder(rowId), reload)
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

  const pfInput = document.getElementById('patientFilterInput')
  if (pfInput) {
    let pfTimer
    pfInput.addEventListener('input', (e) => {
      clearTimeout(pfTimer)
      pfTimer = setTimeout(() => {
        const val = e.target.value.trim()
        searchQuery = val
        const q = val.toLowerCase()
        patientFilter = 'All'
        // If the value matches a patient MRN/name, lock the patient filter.
        for (const p of patients) {
          if ((p.name || '').toLowerCase().includes(q) || (p.mrn || '').toLowerCase().includes(q)) {
            patientFilter = p.pid
            break
          }
        }
        render()
      }, 250)
    })
  }

  document.getElementById('refreshBtn').onclick = reload
  document.getElementById('retryBtn').onclick = reload

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
    if (pfTimer) clearTimeout(pfTimer)
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
