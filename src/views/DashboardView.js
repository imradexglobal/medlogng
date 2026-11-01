// Dashboard — live overview from Firestore (offline-first, cached).
// Organised around three questions: what needs action now, what is
// happening today, where can I go to do the work.
import { shell, statusBadge, wireToast, skeletonCard } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { listOrgAppointmentsPage, subscribeOrgAppointments } from '../services/appointmentService.js'
import { listOrgAdmissionsPage, subscribeOrgAdmissions } from '../services/admissionService.js'
import { listOrgDrugsPage, subscribeOrgDrugs } from '../services/pharmacyService.js'
import { listOrgLabsPage, subscribeOrgLabs } from '../services/laboratoryService.js'
import { can } from '../features/admin/roles.js'
import { onCleanup } from '../lib/lifecycle.js'
import { esc } from '../utils/sanitize.js'

function myActiveMembership() {
  const { memberships, activeOrg } = authStore.getState()
  return memberships.find((m) => m.organization_id === activeOrg) || memberships[0] || null
}

// ---- capability groups for role-aware dashboard content --------------------

function capabilityGroups(me) {
  const caps = new Set((me && me.capabilities) || [])
  return {
    canRegister: can(me, 'patient.create'),
    canAppointments: can(me, 'appointment.create') || can(me, 'appointment.update'),
    canBeds: can(me, 'beds.manage'),
    canDispense: can(me, 'prescription.dispense'),
    canLab: can(me, 'lab.order') || can(me, 'lab.sample.collect') || can(me, 'lab.result.enter') || can(me, 'lab.result.verify'),
    canBilling: can(me, 'billing.invoice') || can(me, 'billing.payment'),
    isAdmin: can(me, 'admin.roles.manage'),
  }
}

// ---- small helpers ---------------------------------------------------------

function todayLabel() {
  const d = new Date()
  return d.toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function shortTime(ts) {
  if (!ts) return '—'
  const d = new Date(typeof ts.toMillis === 'function' ? ts.toMillis() : ts)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
}

// ---- view ------------------------------------------------------------------

export async function DashboardView(app) {
  const { activeOrg, activeOrgName } = authStore.getState()
  const me = myActiveMembership()
  const g = capabilityGroups(me)

  if (!activeOrg) {
    shell(app, {
      active: '/',
      title: 'Dashboard',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite.</p></div>',
    })
    return
  }

  // Per-section loading/error state. A failed read never looks like "zero".
  let loading = true
  let loadError = null

  let appts = []
  let adms = []
  let drugs = []
  let labs = []

  let watchedOrg = activeOrg

  async function load() {
    try {
      loading = true
      loadError = null
      const [a, ad, d, l] = await Promise.all([
        listOrgAppointmentsPage(watchedOrg, { pageSize: 25 }).then((r) => r.rows).catch(() => []),
        listOrgAdmissionsPage(watchedOrg, { pageSize: 25 }).then((r) => r.rows).catch(() => []),
        listOrgDrugsPage(watchedOrg, { pageSize: 50 }).then((r) => r.rows).catch(() => []),
        listOrgLabsPage(watchedOrg, { pageSize: 25 }).then((r) => r.rows).catch(() => []),
      ])
      appts = a
      adms = ad
      drugs = d
      labs = l
      loading = false
      render()
    } catch (e) {
      console.error('[dashboard] load failed:', e)
      loadError = e
      loading = false
      render()
    }
  }

  // ---- derived views ---------------------------------------------------------

  function checkedIn() {
    return appts.filter((a) => a.status === 'checked-in')
  }

  function scheduledToday() {
    const today = new Date().toISOString().slice(0, 10)
    return appts.filter((a) => String(a.time || '').slice(0, 10) === today)
  }

  function activeAdmissions() {
    return adms.filter((a) => a.status === 'active' || a.status === 'Admitted')
  }

  function lowOrOutStock() {
    return drugs.filter((d) => Number(d.stock || 0) < 20)
  }

  // Only include attention items where we have data AND the user may act on them.
  // An item must have a clear destination the user is allowed to open.
  function attentionItems() {
    const items = []

    const queue = checkedIn()
    if (queue.length > 0 && g.canAppointments) {
      items.push({
        kind: 'queue',
        label: queue.length + ' patient' + (queue.length === 1 ? '' : 's') + ' checked in',
        detail: queue[0].patientName + (queue.length > 1 ? ' · +' + (queue.length - 1) + ' more' : ''),
        link: '#/consultations',
        linkLabel: 'Open queue',
        tone: queue.length > 3 ? 'bad' : 'warn',
      })
    }

    const low = lowOrOutStock()
    if (low.length > 0 && g.canDispense) {
      items.push({
        kind: 'stock',
        label: low.length + ' medicine' + (low.length === 1 ? '' : 's') + ' low or out of stock',
        detail: low.map((d) => d.name).slice(0, 2).join(', ') + (low.length > 2 ? ' · +' + (low.length - 2) + ' more' : ''),
        link: '#/pharmacy',
        linkLabel: 'Review stock',
        tone: 'bad',
      })
    }

    const pendingLabs = labs.filter((l) => l.status !== 'verified' && l.status !== 'cancelled' && l.status !== 'rejected')
    if (pendingLabs.length > 0 && g.canLab) {
      items.push({
        kind: 'lab',
        label: pendingLabs.length + ' lab order' + (pendingLabs.length === 1 ? '' : 's') + ' awaiting result',
        detail: 'Open orders needing collection, entry or verification',
        link: '#/laboratory',
        linkLabel: 'Open laboratory',
        tone: 'warn',
      })
    }

    return items
  }

  // ---- render ----------------------------------------------------------------

  function render() {
    const org = activeOrgName || activeOrg || 'Hospital'
    const dateLabel = todayLabel()

    const registerBtn = g.canRegister
      ? '<a class="btn" href="#/patients">+ Register patient</a>'
      : ''

    const actions =
      registerBtn +
      '<a class="btn ghost" href="#/appointments">Day schedule</a>'

    // Build sections
    const items = attentionItems()
    const queued = checkedIn()
    const activeAdm = activeAdmissions()
    const schedToday = scheduledToday()

    const needsAttentionHtml =
      '<div class="card"><div class="card-head"><h3 style="font-size:1rem">What needs action now</h3>' +
      '<span class="pill ' + (items.length === 0 ? 'ok' : 'warn') + '">' +
      (items.length === 0 ? 'All clear' : items.length + ' item' + (items.length === 1 ? '' : 's')) +
      '</span></div>' +
      (items.length === 0
        ? '<div class="empty-state"><p class="sub">Nothing needs attention right now.</p><p class="mut">Checked-in queue, low stock and pending lab orders appear here when there is work to do.</p></div>'
        : '<div class="attention-list">' +
          items.map((it) =>
            '<a href="' + esc(it.link) + '" class="attention-item tone-' + esc(it.tone) + '">' +
            '<div><strong>' + esc(it.label) + '</strong>' +
            '<div class="mut">' + esc(it.detail) + '</div></div>' +
            '<span class="btn ghost sm">' + esc(it.linkLabel) + ' →</span>' +
            '</a>'
          ).join('') +
          '</div>') +
      '</div>'

    const todayActivityHtml =
      '<div class="card"><div class="card-head"><h3 style="font-size:1rem">What is happening today</h3></div>' +
      '<div class="grid3">' +
      '<div class="stat"><em>Appointments scheduled</em>' +
      (loading ? '<strong class="mut">…</strong>' : loadError ? '<strong class="mut bad">unavailable</strong>' : '<strong>' + String(schedToday.length) + '</strong>') +
      '<span>booked for ' + dateLabel.split(',').slice(1).join(',') + '</span></div>' +
      '<div class="stat"><em>Patients waiting</em>' +
      (loading ? '<strong class="mut">…</strong>' : loadError ? '<strong class="mut bad">unavailable</strong>' : '<strong>' + String(queued.length) + '</strong>') +
      '<span>checked in, awaiting clinician</span></div>' +
      '<div class="stat"><em>Active admissions</em>' +
      (loading ? '<strong class="mut">…</strong>' : loadError ? '<strong class="mut bad">unavailable</strong>' : '<strong>' + String(activeAdm.length) + '</strong>') +
      '<span>patients on wards</span></div>' +
      '</div></div>'

    const worklistHtml =
      '<div class="card"><div class="card-head"><h3 style="font-size:1rem">Worklist preview</h3>' +
      '<a class="btn ghost sm" href="#/consultations">Open queue →</a>' +
      '</div>' +
      (loading
        ? '<div style="padding:24px">' + skeletonCard(3) + '</div>'
        : loadError
          ? '<div class="empty-state"><p class="err">Could not load queue — ' + esc(String(loadError?.message || loadError)) + '</p><button class="btn ghost sm" onclick="location.reload()">Retry</button></div>'
          : queued.length === 0
            ? '<div class="empty-state"><p class="sub">No one is checked in right now.</p></div>'
            : '<div class="tblwrap"><table class="tbl"><thead><tr><th>Time</th><th>Patient</th><th>Clinic</th><th>Status</th></tr></thead><tbody>' +
              queued.slice(0, 5).map((q) =>
                '<tr>' +
                '<td>' + esc(q.time ? shortTime(q.time) : '—') + '</td>' +
                '<td><strong>' + esc(q.patientName || '—') + '</strong></td>' +
                '<td>' + esc(q.clinic || '—') + '</td>' +
                '<td>' + statusBadge(q.status) + '</td>' +
                '</tr>'
              ).join('') +
              '</tbody></table></div>') +
      '</div>'

    shell(app, {
      active: '/',
      title: 'Today at ' + dateLabel,
      subtitle: esc(org) + ' · ' + (me ? (me.staff_name || me.role || 'care team') : 'care team'),
      actions: actions,
      body:
        '<div class="dash-layout">' +
        needsAttentionHtml +
        todayActivityHtml +
        worklistHtml +
        '</div>',
    })

    wireToast(app)
  }

  // ---- live subscriptions ----------------------------------------------------

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  let unsubs = []

  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    const liveErr = (fallback) => (e) => {
      console.warn('[dashboard] live update failed; refreshing once:', e?.message || e)
      loadError = e
      render()
      Promise.resolve().then(fallback).catch(() => {})
    }
    unsubs.push(
      subscribeOrgAppointments(watchedOrg,
        (rows) => { appts = rows.slice(0, 25); loading = false; loadError = null; render() },
        liveErr(() => listOrgAppointmentsPage(watchedOrg, { pageSize: 25 }).then((r) => { appts = r.rows; loading = false; render() }))),
      subscribeOrgAdmissions(watchedOrg,
        (rows) => { adms = rows.slice(0, 25); loading = false; loadError = null; render() },
        liveErr(() => listOrgAdmissionsPage(watchedOrg, { pageSize: 25 }).then((r) => { adms = r.rows; loading = false; render() }))),
      subscribeOrgDrugs(watchedOrg,
        (rows) => { drugs = rows.slice(0, 50); loading = false; loadError = null; render() },
        liveErr(() => listOrgDrugsPage(watchedOrg, { pageSize: 50 }).then((r) => { drugs = r.rows; loading = false; render() }))),
      subscribeOrgLabs(watchedOrg,
        (rows) => { labs = rows.slice(0, 25); loading = false; loadError = null; render() },
        liveErr(() => listOrgLabsPage(watchedOrg, { pageSize: 25 }).then((r) => { labs = r.rows; loading = false; render() }))),
    )
  }

  onCleanup(() => {
    teardownListeners()
    unsubAuth()
  })

  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    if (watchedOrg) load()
    subscribeLive()
  })

  await load()
  subscribeLive()
}
