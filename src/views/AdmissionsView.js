// Admissions + bed management with Firestore persistence (offline-first, cached).
// Ward master (`wards` collection) drives bed totals; occupancy derives from
// active admissions per ward. Active admissions are discharged, never deleted;
// a discharged admission may be removed by a data.delete holder (mistake
// correction) — the audit trail records who did it.
//
// Admissions link back to the encounter that triggered them (`encounter_id`,
// one-way, per HL7 FHIR `Encounter.partOf`), so a patient admitted after the
// encounter is created still shows the clinical thread that led to the bed.
// Admitting does NOT close the encounter — the clinician keeps documenting.
import { shell, formModal, toast, closeModal, wireToast, skeletonCard } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgAdmissions, listOrgAdmissionsPage, subscribeOrgAdmissions, createAdmission, dischargeAdmission, transferAdmission, myAdmissionCaps,
  listOrgWards, subscribeOrgWards, createWard, updateWardBeds, ADMISSION_TYPES,
  occupancySummary, validateAdmissionInput, validateWardCapacity,
} from '../services/admissionService.js'
import { getEncounter } from '../services/consultationService.js'
import { getClinicalStaff } from '../services/authService.js'
import { listOrgPatientsAll, formatPhone, matchesPatient, createPatientIndexFiller } from '../services/patientService.js'
import { patientSelectMatcher } from '../components/patientSelect.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { fmtDate, fmtDateTime } from '../utils/format.js'
import { navigate } from '../router.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteAdmission } from '../services/deleteService.js'
import { DISCHARGE_TYPES, normalizeBedId as normalizeBed } from '../features/admissions/domain.js'
import { ensureStaffDirectory, staffLabel } from '../lib/staffName.js'

export async function AdmissionsView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myAdmissionCaps()

  const linkedEncounterId = String(params.enc || '')
  const autoOpen = String(params.new || '') === '1'
  let openedPreset = false

  if (!activeOrg) {
    shell(app, {
      active: '/admissions',
      title: 'Admissions & beds',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let admissions = []
  let patients = []
  let patientIndex = new Map()
  let fillIndex = createPatientIndexFiller(activeOrg)
  let wards = []
  let clinicalStaff = []
  let linkedEncounter = null
  let unsubs = []
  let watchedOrg = activeOrg
  let cursor = null
  let hasMore = false
  let   loading = false
  function setTableLoading(on) {
    const wrap = document.getElementById('adm-tbl')?.closest('.tblwrap')
    if (!wrap) return
    wrap.classList.toggle('is-loading', !!on)
    wrap.style.pointerEvents = on ? 'none' : ''
    wrap.style.opacity = on ? '0.6' : ''
  }
  let liveWindowEdge = null
  let searchDebounce = null
  let lastSearchTerm = ''
  let wardSearchDebounce = null
  let lastWardSearch = ''
  let activeTab = 'wards'

  shell(app, {
    active: '/admissions',
    title: 'Admissions & beds',
    subtitle: 'Facility → Ward → Bed management',
    actions:
      '<button class="btn ghost" id="refreshBtn" aria-label="Refresh admissions list">↻ Refresh</button>' +
      (caps.canAdmit
        ? '<button class="btn ghost" id="wardsBtn" aria-label="Manage ward and bed settings">Manage wards</button>' +
          '<button class="btn" id="admitBtn" aria-label="Admit a new patient">+ Admit patient</button>'
        : ''),
    body:
      '<div id="adm-context"></div>' +
      '<div class="grid4">' +
        '<div class="stat"><em>Occupied</em><strong id="adm-occupied">0</strong><span id="adm-occ-sub">active admissions</span></div>' +
        '<div class="stat"><em>Available</em><strong id="adm-available">0</strong><span>free beds</span></div>' +
        '<div class="stat"><em>Total beds</em><strong id="adm-total-beds">0</strong><span>ward master</span></div>' +
        '<div class="stat"><em>Discharged</em><strong id="adm-discharged">0</strong><span>audited history kept</span></div>' +
      '</div>' +
      '<div class="tabs" id="adm-tabs" role="tablist">' +
        '<button type="button" class="tab-link active" role="tab" aria-selected="true" data-tab="wards" id="tabbtn-wards">Wards</button>' +
        '<button type="button" class="tab-link" role="tab" aria-selected="false" data-tab="admissions" id="tabbtn-admissions">Current admissions</button>' +
      '</div>' +
      '<div class="tab-content">' +
        '<div class="tab-pane active" id="tab-wards" role="tabpanel" aria-labelledby="tabbtn-wards">' +
          '<div class="card">' +
            '<div class="card-head">' +
              '<h3>Wards</h3>' +
              '<span class="pill" id="adm-ward-count">0 wards</span>' +
            '</div>' +
            '<div class="toolbar" style="margin:0 0 12px;gap:8px;flex-wrap:wrap">' +
              '<input class="input" id="wardSearch" aria-label="Filter wards" placeholder="Filter wards…" style="max-width:220px">' +
              '<span class="mut" style="font-size:.78rem;align-self:center">Legend: ' +
                '<span class="pill" style="margin:0 4px;background:#d1fae5;color:#065f46">Available</span>' +
                '<span class="pill" style="margin:0 4px;background:#fecaca;color:#7f1d1d">Occupied</span>' +
                '<span class="pill warn" style="margin:0 4px">&gt;80% full</span>' +
                '<span class="pill bad" style="margin:0 4px">Over capacity</span>' +
              '</span>' +
            '</div>' +
            '<div class="wardgrid" id="adm-wards"><p class="sub">Loading…</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="tab-pane" id="tab-admissions" role="tabpanel" aria-labelledby="tabbtn-admissions" hidden>' +
          '<div class="card">' +
            '<div class="card-head"><h3 id="adm-tbl-title">Current admissions</h3></div>' +
            '<div class="toolbar" style="margin:0 0 8px;gap:8px;flex-wrap:wrap">' +
              '<input class="input" id="admSearch" aria-label="Search admissions by patient, ward, bed or doctor" placeholder="Search patient, ward, bed, doctor or MRN…" style="max-width:260px">' +
              '<select class="input" id="admStatus" style="max-width:170px">' +
                '<option value="active" selected>Active</option>' +
                '<option value="discharged">Discharged</option>' +
                '<option value="all">All admissions</option>' +
              '</select>' +
            '</div>' +
            '<div class="tblwrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
              '<table class="tbl" id="adm-tbl">' +
                '<thead><tr>' +
                  '<th>Patient</th><th>Ward · Bed</th><th>Admitted</th><th>Doctor</th><th>From encounter</th><th style="width:120px">Actions</th>' +
                '</tr></thead>' +
                '<tbody><tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr></tbody>' +
              '</table>' +
              '<div class="loadmore" data-loadmore="1"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>',
  })

  const more = createLoadMore(loadMore)

  async function loadMore() {
    if (loading) return
    const first = cursor == null && admissions.length === 0
    loading = true
    more.setLoading(true)
    setTableLoading(true)
    const run = (async () => {
      const [pg, pats, w, staff] = await Promise.all([
        listOrgAdmissionsPage(activeOrg, { cursor }),
        // Full registry: it feeds the admit picker's search AND this queue's
        // name/MRN/mobile filter — a bounded page hides patients past it.
        first ? listOrgPatientsAll(activeOrg).catch(() => []) : Promise.resolve(patients),
        first ? listOrgWards(activeOrg).catch(() => []) : Promise.resolve([]),
        first ? getClinicalStaff(activeOrg).catch(() => []) : Promise.resolve([]),
      ])
      const seen = new Set(admissions.map((a) => a.id))
      admissions = first ? pg.rows : [...admissions, ...pg.rows.filter((a) => !seen.has(a.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) {
        patients = pats
        patientIndex = new Map(patients.map((p) => [p.pid, p]))
        wards = w
        clinicalStaff = staff
        if (linkedEncounterId && !linkedEncounter) {
          linkedEncounter = await getEncounter(linkedEncounterId).catch(() => null)
        }
      }
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      setTableLoading(false)
      render()
      if (first && autoOpen && !openedPreset) {
        openedPreset = true
        const q = new URLSearchParams({ enc: linkedEncounterId })
        navigate('/admissions/new?' + q.toString())
      }
    })()
    await Promise.race([
      run,
      new Promise((resolve) => setTimeout(resolve, 8000)).then(() => {
        if (loading) {
          console.warn('[admissions] load timed out — rendering with available data')
          loading = false
          more.setLoading(false)
          setTableLoading(false)
          render()
        }
      }),
    ]).catch(() => {
      loading = false
      more.setLoading(false)
      setTableLoading(false)
      render()
    })
  }

  function reload() {
    admissions = []
    cursor = null
    hasMore = false
    fillIndex.reset()
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive).catch((e) => {
      console.warn('[admissions] load failed:', e?.message || e)
      toast('Could not load admissions — check your connection')
    })
  }

  function occupiedIn(wardName) {
    return admissions.filter((a) => a.status === 'active' && a.wardName === wardName).length
  }

  function admissionName(a) {
    return a.patientName || patientIndex.get(a.patientId)?.name || 'Unknown patient'
  }

  function daysSince(when) {
    if (!when) return null
    const t = typeof when === 'number' ? when : new Date(when).getTime()
    if (!t || Number.isNaN(t)) return null
    return Math.max(0, Math.floor((Date.now() - t) / 86400000))
  }

  async function ensureVisibleMeta() {
    if (!document.getElementById('adm-tbl')) return
    const ids = visibleAdmissions().map((a) => a.patientId)
    if (linkedEncounter) ids.push(linkedEncounter.patientId)
    const changed = await fillIndex.fill(patientIndex, ids)
    if (!changed || !document.getElementById('adm-tbl')) return
    render()
  }

  function visibleAdmissions() {
    const q = String(document.getElementById('admSearch')?.value || '').trim().toLowerCase()
    const mode = document.getElementById('admStatus')?.value || 'active'
    return admissions.filter((a) => {
      if (mode === 'active' && a.status !== 'active') return false
      if (mode === 'discharged' && a.status !== 'discharged') return false
      if (q) {
        const p = patientIndex.get(a.patientId)
        let bedHay = [admissionName(a), a.wardName, a.bedNumber, a.attendingProvider, a.admissionType, a.encounterId]
          .join(' ').toLowerCase()
        if (p) {
          bedHay += ' ' + (p.mrn || '') + ' ' + (p.phone || '') + ' ' + formatPhone(p.phone, p.phone_key)
        }
        if (!bedHay.includes(q) && !(p && matchesPatient(p, q))) return false
      }
      return true
    })
  }

  function wardFilterTerm() {
    return String(document.getElementById('wardSearch')?.value || '').trim().toLowerCase()
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    const sum = occupancySummary(admissions, wards)
    set('adm-occupied', sum.active)
    set('adm-total-beds', sum.totalBeds)
    set('adm-available', sum.hasCapacity ? sum.free : '—')
    set('adm-discharged', sum.discharged)
    const occSub = document.getElementById('adm-occ-sub')
    if (occSub) {
      occSub.textContent = sum.hasCapacity
        ? sum.occupancyPct + '% of configured beds · ' + sum.unconfiguredOccupied + ' in unconfigured wards'
        : 'no configured capacity'
    }
    set('adm-ward-count', wards.length + (wards.length === 1 ? ' ward' : ' wards'))

    if (loading && admissions.length === 0) {
      const tbl = document.getElementById('adm-tbl')
      if (tbl) {
        tbl.innerHTML = '<thead><tr><th>Patient</th><th>Ward · Bed</th><th>Admitted</th><th>Doctor</th><th>From encounter</th><th style="width:120px">Actions</th></tr></thead><tbody>' +
          '<tr><td colspan="6">' + skeletonCard(5) + '</td></tr></tbody>'
      }
      const wg = document.getElementById('adm-wards')
      if (wg) wg.innerHTML = skeletonCard(2)
      ensureVisibleMeta()
      return
    }
    setTableLoading(false)

    const ctx = document.getElementById('adm-context')
    if (ctx) {
      const encName = linkedEncounter
        ? (linkedEncounter.patientName || patientIndex.get(linkedEncounter.patientId)?.name || '')
        : ''
      if (encName) {
        ctx.innerHTML =
          '<div class="card" style="margin-bottom:14px">' +
            '<div class="card-head"><h3>Admitting from encounter</h3>' +
              '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(linkedEncounter.id) + '">Back to encounter →</a></div>' +
            '<p class="sub"><strong>' + esc(encName) + '</strong> · encounter ' +
              esc(String(linkedEncounter.id).slice(0, 8)) + '… · ' + esc(linkedEncounter.status || 'open') +
              '. The new admission is linked to this encounter; the encounter stays open for documentation.</p>' +
          '</div>'
      } else if (linkedEncounterId) {
        ctx.innerHTML =
          '<div class="card" style="margin-bottom:14px"><p class="sub">Linked encounter ' +
            esc(linkedEncounterId.slice(0, 8)) + '… could not be loaded — the admission will be recorded without a clinical link.</p></div>'
      } else {
        ctx.innerHTML = ''
      }
    }

    const wg = document.getElementById('adm-wards')
    if (wg) {
      const filter = wardFilterTerm()
      const wardRows = (sum.wards || []).filter((w) => !filter || String(w.name || '').toLowerCase().includes(filter))

      wg.innerHTML = wardRows.length
        ? wardRows.map((w) => {
          const tone = w.overCapacity ? 'bad' : (w.pct > 80 ? 'warn' : 'info')
          const detail = w.unconfigured
            ? w.occupied + ' occupied · capacity not configured'
            : w.free + ' free · ' + w.pct + '% occupied'
          const barPct = w.totalBeds > 0 ? Math.min(100, Math.round((w.occupied / w.totalBeds) * 100)) : 0
          const barColor = w.overCapacity ? '#b91c1c' : (w.pct > 80 ? '#b45309' : '#0369a1')

          let bedMap = ''
          if (w.totalBeds && w.totalBeds > 0) {
            bedMap = '<div class="bedgrid" style="margin-top:10px">' +
              Array.from({ length: w.totalBeds }, (_, i) => {
                 const bedNo = String(i + 1)
                 const wardKey = String(w.name || '').trim().toLowerCase()
                 const patient = (admissions || []).find((a) => {
                   if (a.status !== 'active') return false
                   const aWard = String(a.wardName || a.ward_name || '').trim().toLowerCase()
                   if (aWard !== wardKey) return false
                   const aBed = normalizeBed(a.bedNumber || a.bed_number || '')
                   const aBedDigits = String(a.bedNumber || a.bed_number || '').replace(/\D/g, '')
                   return aBed === bedNo || aBedDigits === bedNo || String(a.bedNumber || '') === bedNo
                 })
                const destination = patient
                  ? (patient.id
                      ? '/admissions/' + encodeURIComponent(patient.id)
                      : (patient.encounterId
                          ? '/consultations?enc=' + encodeURIComponent(patient.encounterId)
                          : '/patients/' + encodeURIComponent(patient.patientId)))
                  : (caps.canAdmit
                      ? '/admissions/new?ward=' + encodeURIComponent(w.id) + '&bed=' + encodeURIComponent(bedNo)
                      : '')
                const patientName = patient ? admissionName(patient) : ''
                const shortName = patientName.length > 18 ? patientName.slice(0, 16) + '…' : patientName
                const los = patient ? daysSince(patient.admissionDate || patient.createdAt) : null
                const interactive = !!destination
                const title = 'Bed ' + bedNo + (patient
                  ? ' · ' + patientName + (los != null ? ' · day ' + (los + 1) : '')
                  : ' · free')
                 const bedStyle = patient
                   ? 'background:#fecaca;border:1px solid #f87171;color:#7f1d1d;'  // occupied
                   : 'background:#d1fae5;border:1px solid #34d399;color:#065f46;'  // free

                 return '<div class="bed ' + (patient ? 'o' : 'v') + (interactive ? ' clickable' : '') +
                   '" style="' + bedStyle + 'min-height:44px;display:flex;align-items:center;justify-content:center;padding:6px 8px;border-radius:8px;cursor:' +
                   (interactive ? 'pointer' : 'default') + ';"' +
                   (interactive ? ' role="link" tabindex="0" data-bed-destination="' + esc(destination) + '"' : '') +
                   ' title="' + esc(title) + '"' +
                   ' aria-label="' + esc(title) + '">' +
                   '<strong>Bed ' + bedNo + '</strong>' +
                 '</div>'
              }).join('') + '</div>'
          }

          return '<div class="ward" style="margin-bottom:14px">' +
            '<div class="card-head">' +
              '<h4>' + esc(w.name) + '</h4>' +
              '<span class="pill ' + tone + '" aria-label="Occupancy ' + w.occupied + ' of ' + (w.totalBeds || '?') + ' beds (' + w.pct + '%)">' +
                w.occupied + ' / ' + (w.totalBeds || '?') +
              '</span>' +
            '</div>' +
            '<p class="sub" style="margin:0 0 6px">' + esc(detail) + '</p>' +
            (w.totalBeds > 0
              ? '<div style="height:6px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-bottom:4px">' +
                  '<div style="height:100%;width:' + barPct + '%;background:' + barColor + ';border-radius:4px;transition:width .2s"></div>' +
                '</div>'
              : '') +
            bedMap +
          '</div>'
        }).join('')
        : '<p class="sub">' +
            (filter
              ? 'No wards match “' + esc(filter) + '”.'
              : 'No wards configured yet.' + (caps.canAdmit
                  ? ' Use “Manage wards” to add your wards and bed counts.'
                  : ' Ask an administrator to configure wards.')) +
          '</p>'
    }

    const tbl = document.getElementById('adm-tbl')
    const titleEl = document.getElementById('adm-tbl-title')
    const admByPatient = new Map()
    for (const a of admissions) {
      const list = admByPatient.get(a.patientId) || []
      list.push(a)
      admByPatient.set(a.patientId, list)
    }
    const rows = visibleAdmissions().map((a) => {
      const when = a.admissionDate || a.createdAt
      const los = a.status === 'active' ? daysSince(when) : null
      const patientCell = a.patientId
        ? '<a href="#/patients/' + encodeURIComponent(a.patientId) + '"><strong>' + esc(admissionName(a)) + '</strong></a>'
        : '<strong>' + esc(admissionName(a)) + '</strong>'
      let historyPill = ''
      const patientAdms = (admByPatient.get(a.patientId) || []).sort((x, y) =>
        (y.admissionDate || y.createdAt) - (x.admissionDate || x.createdAt)
      )
      const stayNum = patientAdms.findIndex((x) => x.id === a.id) + 1
      if (patientAdms.length > 1) {
        const prev = patientAdms.find((x) => x.id !== a.id && x.status === 'discharged' && x.dischargeDate)
        const daysAgo = prev ? Math.floor((Date.now() - new Date(prev.dischargeDate).getTime()) / 86400000) : 0
        historyPill = ' <span class="pill neutral" aria-label="Stay #' + stayNum + ' of ' + patientAdms.length +
          (prev ? ', last discharged ' + daysAgo + ' days ago' : '') + '">#' + stayNum + ' stay</span>'
      }
      if (los != null) {
        historyPill += ' <span class="pill info" title="Length of stay">Day ' + (los + 1) + '</span>'
      }
      const encCell = a.encounterId
        ? '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(a.encounterId) + '">View encounter</a>'
        : '<span class="mut">—</span>'
      const items = []
      if (a.status === 'active') {
        items.push({ label: 'Open workspace', dataAction: 'workspace', description: 'Open this admission session' })
        if (caps.canAdmit) {
          items.push({ label: 'Transfer', dataAction: 'transfer', description: 'Transfer patient to another ward and bed' })
          items.push({ label: 'Discharge', dataAction: 'discharge', description: 'Discharge this patient' })
        }
      }
      if (a.status === 'discharged' && canDeleteRecords()) {
        items.push({ label: 'Delete', tone: 'danger', dataAction: 'delete', description: 'Permanently delete this discharged admission (audit trail kept)' })
      }
      return '<tr data-row-id="' + a.id + '" style="cursor:' + (a.status === 'active' ? 'pointer' : 'default') + '">' +
        '<td>' + patientCell + historyPill + '</td>' +
        '<td>' + esc(a.wardName) + ' · ' + esc(a.bedNumber) + '</td>' +
        '<td>' + (when ? fmtDateTime(when) : '—') +
          (a.status === 'discharged' && a.dischargeDate
            ? '<div class="mut">out ' + fmtDate(a.dischargeDate) + '</div>' : '') +
        '</td>' +
        '<td>' + esc(staffLabel(a.attendingProvider) || '—') + '</td>' +
        '<td>' + encCell + '</td>' +
        '<td>' + kebabCell({ rowId: a.id, items }) + '</td></tr>'
    }).join('')

    if (titleEl) {
      const mode = document.getElementById('admStatus')?.value || 'active'
      titleEl.textContent = mode === 'discharged' ? 'Discharge history' : (mode === 'all' ? 'All admissions' : 'Current admissions')
    }
    if (tbl) {
      tbl.innerHTML = '<thead><tr><th>Patient</th><th>Ward · Bed</th><th>Admitted</th><th>Doctor</th><th>From encounter</th><th style="width:120px">Actions</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No admissions match this filter</td></tr>') +
        '</tbody>'
      more.mount(tbl.closest('.tblwrap'))

      wireKebabs(tbl, async (rowId, action) => {
        const adm = admissions.find((a) => a.id === rowId)
        if (!adm) return
        if (action === 'workspace') {
          window.location.hash = '#/admissions/' + encodeURIComponent(rowId)
          return
        }
        if (action === 'transfer') { openTransferForm(rowId); return }
        if (action === 'discharge') { openDischargeForm(rowId); return }
        if (action === 'delete') {
          confirmDelete('discharged admission of ' + admissionName(adm), () => deleteAdmission(rowId), () => {
            admissions = admissions.filter((a) => a.id !== rowId)
            render()
          })
        }
      })
    }

    ensureVisibleMeta()
  }

  function openAdmitForm(preselectWardId) {
    if (!patients.length) { toast('No patients registered yet — register a patient first.'); return }
    const enc = linkedEncounter
    const fixedPatient = enc && enc.patientId
      ? patients.find((p) => p.pid === enc.patientId) ||
        patientIndex.get(enc.patientId) ||
        { pid: enc.patientId, name: enc.patientName || enc.patientId }
      : null
    const patientOpts = fixedPatient
      ? [{ value: fixedPatient.pid, label: (fixedPatient.name || fixedPatient.pid) + ' · ' + (fixedPatient.mrn || fixedPatient.pid) }]
      : patients.map((p) => ({
        value: p.pid,
        label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
      }))
    const preselectWard = preselectWardId ? wards.find((w) => w.id === preselectWardId) : null
    const wardField = wards.length
      ? { name: 'ward_name', label: 'Ward', type: 'select', options: wards.map((w) => w.name), required: true, value: preselectWard ? preselectWard.name : '' }
      : { name: 'ward_name', label: 'Ward (no ward master yet — type a name)', required: true, placeholder: 'e.g. Ward A' }
    const providerField = clinicalStaff.length
      ? { name: 'attending_provider', label: 'Attending doctor', type: 'select', options: clinicalStaff }
      : { name: 'attending_provider', label: 'Attending doctor (no staff on file — type a name)', placeholder: 'e.g. Dr. N. Eze' }
    formModal({
      title: enc ? 'Admit patient (from encounter)' : 'Admit patient',
      submitLabel: 'Confirm admission',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true, full: true, value: fixedPatient ? fixedPatient.pid : '', searchable: !fixedPatient && patientOpts.length > 1, searchPlaceholder: 'Name, ID or mobile…', match: patientSelectMatcher(patients) },
        wardField,
        { name: 'bed_number', label: 'Bed', required: true, placeholder: preselectWard && preselectWard.totalBeds ? 'e.g. Bed 1–' + preselectWard.totalBeds : 'e.g. Bed 1', hint: true },
        { name: 'admission_type', label: 'Admission type', type: 'select', options: ADMISSION_TYPES },
        providerField,
        { name: 'admission_reason', label: 'Reason', full: true, placeholder: 'e.g. Observation' },
      ],
      onInput: (vals) => {
        const hint = document.querySelector('#fmFields [data-hint="bed_number"]')
        if (!hint) return
        const ward = wards.find((w) => w.name === vals.ward_name)
        if (ward && ward.totalBeds && ward.totalBeds > 0) {
          const n = Number(String(vals.bed_number || '').replace(/\D/g, ''))
          const normalizedBed = normalizeBed(vals.bed_number)
          if (!n || n < 1 || n > ward.totalBeds) {
            hint.textContent = 'Valid beds for ' + ward.name + ': 1 – ' + ward.totalBeds
            hint.className = 'fldhint bad'
            hint.hidden = false
          } else {
            hint.textContent = 'Bed ' + normalizedBed + ' of ' + ward.totalBeds + ' in ' + ward.name
            hint.className = 'fldhint ok'
            hint.hidden = false
          }
        } else {
          hint.hidden = true
        }
      },
      onSubmit: async (v) => {
        const invalid = validateAdmissionInput(v, { wards, admissions, encounter: enc })
        if (invalid) throw new Error(invalid)
        const sel = patients.find((p) => p.pid === v.patient_id)
        const saved = await createAdmission({
          patient_id: v.patient_id,
          patient_name: (sel && sel.name) || (fixedPatient && fixedPatient.name) || v.patient_id,
          ward_name: v.ward_name,
          bed_number: v.bed_number,
          admission_type: v.admission_type,
          admission_reason: v.admission_reason,
          attending_provider: v.attending_provider,
          encounter_id: enc ? enc.id : '',
        })
        closeModal()
        toast(saved.pendingSync ? 'Admission saved on this device; it will sync when connected.' : 'Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)
        if (saved?.id) {
          navigate('/admissions/' + encodeURIComponent(saved.id))
        } else {
          reload()
        }
      },
    })
  }

  function openDischargeForm(id) {
    const adm = admissions.find((a) => a.id === id)
    if (!adm) return
    formModal({
      title: 'Discharge — ' + admissionName(adm),
      submitLabel: 'Discharge',
      fields: [
        { name: 'reason', label: 'Discharge reason', required: true, full: true, placeholder: 'e.g. Recovered' },
        { name: 'notes', label: 'Discharge notes', full: true, placeholder: 'Follow-up instructions…' },
        { name: 'discharge_type', label: 'Discharge type', type: 'select', options: DISCHARGE_TYPES.map((t) => ({ value: t.value, label: t.label })), value: 'discharged', required: true },
      ],
      onSubmit: async (v) => {
        let pendingSync = false
        try {
          const result = await dischargeAdmission(id, { reason: v.reason, notes: v.notes, dischargeType: v.discharge_type })
          pendingSync = !!result?.pendingSync
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast(pendingSync ? 'Discharge saved on this device; it will sync when connected.' : 'Patient discharged')
        reload()
      },
    })
  }

  function openTransferForm(id) {
    const adm = admissions.find((a) => a.id === id)
    if (!adm || adm.status !== 'active') return
    formModal({
      title: 'Transfer — ' + admissionName(adm),
      submitLabel: 'Transfer',
      fields: [
        { name: 'ward_name', label: 'New ward', type: 'select', options: wards.map((w) => w.name), required: true },
         { name: 'bed_number', label: 'New bed', type: 'number', required: true, placeholder: 'e.g. 3', min: 1, hint: true },
        { name: 'reason', label: 'Transfer reason', full: true, placeholder: 'e.g. Needs ICU-level care', required: true },
      ],
      onInput: (vals) => {
        const hint = document.querySelector('#fmFields [data-hint="bed_number"]')
        if (!hint) return
        const ward = wards.find((w) => w.name === vals.ward_name)
        if (ward && ward.totalBeds && ward.totalBeds > 0) {
          const n = Number(String(vals.bed_number || '').replace(/\D/g, ''))
          const taken = (admissions || []).some((a) =>
            a.id !== id && a.status === 'active' &&
            String(a.wardName || '').trim().toLowerCase() === String(ward.name || '').trim().toLowerCase() &&
            String(a.bedNumber || '') === String(n))
          if (!n || n < 1 || n > ward.totalBeds) {
            hint.textContent = 'Valid beds for ' + ward.name + ': 1 – ' + ward.totalBeds
            hint.className = 'fldhint bad'
            hint.hidden = false
          } else if (taken) {
            hint.textContent = 'Bed ' + n + ' in ' + ward.name + ' is already occupied.'
            hint.className = 'fldhint bad'
            hint.hidden = false
          } else {
            hint.textContent = 'Bed ' + n + ' of ' + ward.totalBeds + ' in ' + ward.name + ' — free'
            hint.className = 'fldhint ok'
            hint.hidden = false
          }
        } else {
          hint.hidden = true
        }
      },
      onSubmit: async (v) => {
        const invalid = validateAdmissionInput(
          { patient_id: adm.patientId, ward_name: v.ward_name, bed_number: v.bed_number, encounter_id: '' },
          { wards, admissions: admissions.filter((a) => a.id !== id), encounter: null },
        )
        if (invalid) throw new Error(invalid)
        let pendingSync = false
        try {
          const result = await transferAdmission(id, { ward_name: v.ward_name, bed_number: v.bed_number, reason: v.reason })
          pendingSync = !!result?.pendingSync
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast(pendingSync ? 'Transfer saved on this device; it will sync when connected.' : 'Patient transferred to ' + v.ward_name + ' · ' + v.bed_number)
        reload()
      },
    })
  }

  function openWardsManager() {
    formModal({
      title: 'Manage wards',
      submitLabel: '+ Add ward',
      fields: [
        { name: 'name', label: 'New ward name', full: true, placeholder: 'e.g. Ward A' },
        { name: 'total_beds', label: 'Total beds', type: 'number', placeholder: 'e.g. 20' },
      ],
      onSubmit: async (v) => {
        try {
          if (!String(v.name || '').trim()) throw new Error('Enter a ward name to add it, with total beds.')
          await createWard({ name: v.name, total_beds: v.total_beds })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Ward added')
        reload()
      },
    })
    const body = document.getElementById('modalBody')
    if (body) {
      const rows = wards.map((w) =>
        '<tr><td><strong>' + esc(w.name) + '</strong></td><td>' + occupiedIn(w.name) + ' occupied</td>' +
        '<td>' + w.totalBeds + ' beds</td>' +
        '<td><button class="btn ghost sm" data-edit-ward="' + esc(w.id) + '">Edit beds</button></td></tr>'
      ).join('')
      const div = document.createElement('div')
      div.innerHTML =
        '<div class="tblwrap"><table class="tbl"><thead><tr><th>Ward</th><th>Occupancy</th><th>Capacity</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:12px 8px">No wards yet — add your first ward below</td></tr>') +
        '</tbody></table></div><br/>'
      body.prepend(div)
      body.onclick = (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-edit-ward]') : null
        if (t) openEditWardBeds(t.getAttribute('data-edit-ward'))
      }
    }
  }

  function openEditWardBeds(wardId) {
    const w = wards.find((x) => x.id === wardId)
    if (!w) return
    const occ = occupiedIn(w.name)
    formModal({
      title: 'Edit beds — ' + w.name,
      submitLabel: 'Save',
      fields: [
        { name: 'total_beds', label: 'Total beds', type: 'number', required: true, value: String(w.totalBeds) },
      ],
      onSubmit: async (v) => {
        const invalid = validateWardCapacity(v.total_beds, admissions, w.name)
        if (invalid) throw new Error(invalid)
        await updateWardBeds(wardId, Number(v.total_beds))
        closeModal()
        toast('Ward updated')
        reload()
      },
    })
    const err = document.getElementById('fmError')
    if (err && occ) {
      err.textContent = occ + ' bed' + (occ === 1 ? '' : 's') + ' currently occupied — capacity cannot go below that.'
    }
  }

  document.getElementById('adm-wards')?.addEventListener('click', (e) => {
    const bed = e.target.closest('[data-bed-destination]')
    if (!bed) return
    const dest = bed.getAttribute('data-bed-destination')
    if (dest) navigate(dest)
  })
  document.getElementById('adm-wards')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const bed = e.target.closest('[data-bed-destination]')
    if (!bed) return
    e.preventDefault()
    const dest = bed.getAttribute('data-bed-destination')
    if (dest) navigate(dest)
  })

  document.getElementById('refreshBtn').onclick = reload

  // Row click → workspace (delegation on stable wrapper)
  document.querySelector('#tab-admissions .tblwrap')?.addEventListener('click', (e) => {
    if (e.target.closest('a, button, select, .kebab, [data-kebab], [data-action]')) return
    const row = e.target.closest('tr[data-row-id]')
    if (!row) return
    const id = row.getAttribute('data-row-id')
    const adm = admissions.find((a) => a.id === id)
    if (adm && adm.status === 'active') {
      window.location.hash = '#/admissions/' + encodeURIComponent(id)
    }
  })
  const admitBtn = document.getElementById('admitBtn')
  if (admitBtn) admitBtn.onclick = () => navigate('/admissions/new')
  const wardsBtn = document.getElementById('wardsBtn')
  if (wardsBtn) wardsBtn.onclick = () => { showTab('wards'); openWardsManager() }

  const admSearch = document.getElementById('admSearch')
  if (admSearch) {
    admSearch.addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase()
      if (term === lastSearchTerm) return
      lastSearchTerm = term
      clearTimeout(searchDebounce)
      searchDebounce = setTimeout(() => render(), 350)
    })
  }
  const admStatus = document.getElementById('admStatus')
  if (admStatus) admStatus.addEventListener('change', render)

  const wardSearch = document.getElementById('wardSearch')
  if (wardSearch) {
    wardSearch.addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase()
      if (term === lastWardSearch) return
      lastWardSearch = term
      clearTimeout(wardSearchDebounce)
      wardSearchDebounce = setTimeout(() => render(), 250)
    })
  }

  function showTab(name) {
    activeTab = name === 'admissions' ? 'admissions' : 'wards'
    document.querySelectorAll('#adm-tabs .tab-link').forEach((b) => {
      const on = b.getAttribute('data-tab') === activeTab
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    document.querySelectorAll('.tab-content .tab-pane').forEach((p) => {
      const on = p.id === 'tab-' + activeTab
      p.classList.toggle('active', on)
      if (on) {
        p.removeAttribute('hidden')
        p.style.display = ''
      } else {
        p.setAttribute('hidden', '')
        p.style.display = 'none'
      }
    })
  }
  document.querySelectorAll('#adm-tabs .tab-link').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab')))
  })
  showTab(activeTab)
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    unsubs.push(
      subscribeOrgAdmissions(watchedOrg,
        (rows) => {
          const incomingById = new Map(rows.map((a) => [a.id, a]))
          if (rows.length) liveWindowEdge = Math.min(...rows.map((a) => a.createdAt || a.admissionDate || 0))
          const edge = liveWindowEdge ?? Infinity
          const retained = admissions.filter((a) => !incomingById.has(a.id) && (a.createdAt || a.admissionDate || 0) < edge)
          admissions = [...rows, ...retained]
          render()
        },
        (e) => {
          console.warn('[admissions] live update failed; refreshing once:', e?.message || e)
          listOrgAdmissionsPage(watchedOrg)
            .then((r) => { admissions = r.rows; render() })
            .catch(() => {})
        }),
      subscribeOrgWards(watchedOrg,
        (rows) => { wards = rows; render() },
        (e) => {
          console.warn('[wards] live update failed; refreshing once:', e?.message || e)
          listOrgWards(watchedOrg)
            .then((r) => { wards = r; render() })
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
    fillIndex = createPatientIndexFiller(watchedOrg)
    subscribeLive()
  })

  loadMore()
  subscribeLive()
  ensureStaffDirectory(activeOrg)

  loading = true
  render()
}
