// Admissions + bed management with Firestore persistence (offline-first, cached).
// Ward master (`wards` collection) drives bed totals; occupancy derives from
// active admissions per ward. No historical admission is ever deleted.
//
// Admissions link back to the encounter that triggered them (`encounter_id`,
// one-way, per HL7 FHIR `Encounter.partOf`), so a patient admitted after the
// encounter is created still shows the clinical thread that led to the bed.
// Admitting does NOT close the encounter — the clinician keeps documenting.
import { shell, formModal, toast, closeModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgAdmissions, listOrgAdmissionsPage, subscribeOrgAdmissions, createAdmission, dischargeAdmission, myAdmissionCaps,
  listOrgWards, subscribeOrgWards, createWard, updateWardBeds, ADMISSION_TYPES,
  occupancySummary, validateAdmissionInput, validateWardCapacity,
} from '../services/admissionService.js'
import { getEncounter } from '../services/consultationService.js'
import { getClinicalStaff } from '../services/authService.js'
import { listOrgPatientsPage, formatPhone, matchesPatient, createPatientIndexFiller } from '../services/patientService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

// Admission types come from the domain module so this form cannot drift from
// the list the service and tests agree on.

export async function AdmissionsView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myAdmissionCaps()

  // Deep link from the encounter workspace: #/admissions?enc=<id>&new=1
  const linkedEncounterId = String(params.enc || '')
  const autoOpen = String(params.new || '') === '1'
  // Latched once the deep-linked admit form has been shown. reload() runs again on
  // every search keystroke, status filter and Refresh click, so an unlatched
  // `autoOpen` re-pops the modal over the bed board each time.
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
  // The registry join only loads one bounded page of organization_patients, so
  // an admission whose patient sits past that page (or whose snapshot lost
  // patient_name) read as "Unknown patient" / a blank cell. fillIndex() names
  // those on demand — see ensureVisibleMeta().
  let fillIndex = createPatientIndexFiller(activeOrg)
  let wards = []
  let clinicalStaff = []
  let linkedEncounter = null
  let unsubs = []
  let watchedOrg = activeOrg
  // Infinite scroll: rows accumulate and `cursor` marks the end of what we hold.
  let cursor = null
  let hasMore = false
  let loading = false

  shell(app, {
    active: '/admissions',
    title: 'Admissions & beds',
    subtitle: 'Facility → Ward → Bed management',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canAdmit ? '<button class="btn ghost" id="wardsBtn">Manage wards</button><button class="btn" id="admitBtn">+ Admit patient</button>' : ''),
    body:
      '<div id="adm-context"></div>' +
      '<div class="grid4"><div class="stat"><em>Occupied</em><strong id="adm-occupied">0</strong><span id="adm-occ-sub">active admissions</span></div>' +
      '<div class="stat"><em>Available</em><strong id="adm-available">0</strong><span>free beds</span></div>' +
      '<div class="stat"><em>Total beds</em><strong id="adm-total-beds">0</strong><span>ward master</span></div>' +
      '<div class="stat"><em>Discharged</em><strong id="adm-discharged">0</strong><span>audited history kept</span></div></div>' +
      '<div class="card"><div class="card-head"><h3>Wards</h3><span class="pill" id="adm-ward-count">0 wards</span></div>' +
      '<div class="wardgrid" id="adm-wards"><p class="sub">Loading…</p></div></div>' +
      '<div class="card"><div class="card-head"><h3 id="adm-tbl-title">Current admissions</h3></div>' +
      '<div class="toolbar" style="margin:0 0 8px"><input class="input" id="admSearch" placeholder="Search patient, ward, bed or doctor…" style="max-width:240px">' +
      '<select class="input" id="admStatus" style="max-width:170px"><option value="active" selected>Active</option><option value="discharged">Discharged</option><option value="all">All admissions</option></select></div>' +
      '<div class="tblwrap"><table class="tbl" id="adm-tbl"><tr><th>Patient</th><th>Ward · Bed</th><th>Admitted</th><th>Doctor</th><th>From encounter</th><th></th></tr>' +
      '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table><div class="loadmore" data-loadmore="1"></div></div></div>',
  })

  const more = createLoadMore(loadMore)

  // Append the next chunk of admissions. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && admissions.length === 0
    loading = true
    more.setLoading(true)
    document.getElementById('adm-tbl')?.closest('.tblwrap')?.classList.add('is-loading')
    try {
      const [pg, pats, w, staff] = await Promise.all([
        listOrgAdmissionsPage(activeOrg, { cursor }),
        first ? listOrgPatientsPage(activeOrg, { pageSize: 100 }).then((r) => r.rows).catch(() => []) : Promise.resolve(patients),
        first ? listOrgWards(activeOrg).catch(() => []) : Promise.resolve([]),
        // Attending doctors come from the org's own active memberships, so a
        // discharged or renamed clinician cannot linger in a hard-coded list.
        first ? getClinicalStaff(activeOrg).catch(() => []) : Promise.resolve([]),
      ])
      // A row written between two chunk reads shifts the cursor stream and can
      // repeat the boundary document.
      const seen = new Set(admissions.map((a) => a.id))
      admissions = first ? pg.rows : [...admissions, ...pg.rows.filter((a) => !seen.has(a.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) {
        patients = pats
        patientIndex = new Map(patients.map((p) => [p.pid, p]))
        wards = w
        clinicalStaff = staff
        // Resolve the deep-linked encounter so the admit form can pre-fill the
        // patient and lock the clinical link. A missing encounter is not fatal —
        // the page still works, it just cannot pre-fill.
        if (linkedEncounterId && !linkedEncounter) {
          linkedEncounter = await getEncounter(linkedEncounterId).catch(() => null)
        }
      }
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
      if (first && autoOpen && !openedPreset) {
        openedPreset = true
        openAdmitForm()
      }
    } catch (e) {
      console.error('[admissions] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) toast('Could not load admissions: ' + friendlyWriteError(e))
      else more.setError('Could not load more — retry')
    } finally {
      document.getElementById('adm-tbl')?.closest('.tblwrap')?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole list.
  function reload() {
    admissions = []
    cursor = null
    hasMore = false
    fillIndex.reset()
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive)
  }

  function occupiedIn(wardName) {
    return admissions.filter((a) => a.status === 'active' && a.wardName === wardName).length
  }

  // The admission carries its own patient_name snapshot, but that can be empty
  // (legacy rows) or stale. The registry index is joined in as the source of
  // truth; the snapshot is only what shows before it resolves.
  function admissionName(a) {
    return a.patientName || patientIndex.get(a.patientId)?.name || 'Unknown patient'
  }

  // Name the patients this screen is showing but the bounded index missed.
  // Filled rows land in patientIndex and repaint exactly once — a render that
  // finds nothing new stops the cycle, so this can never loop.
  async function ensureVisibleMeta() {
    if (!document.getElementById('adm-tbl')) return
    const ids = visibleAdmissions().map((a) => a.patientId)
    if (linkedEncounter) ids.push(linkedEncounter.patientId)
    const changed = await fillIndex.fill(patientIndex, ids)
    if (!changed || !document.getElementById('adm-tbl')) return
    render()
  }

  // Rows the table shows, after the search box and the active/discharged filter.
  function visibleAdmissions() {
    const q = String(document.getElementById('admSearch')?.value || '').trim().toLowerCase()
    const mode = document.getElementById('admStatus')?.value || 'active'
    return admissions.filter((a) => {
      if (mode === 'active' && a.status !== 'active') return false
      if (mode === 'discharged' && a.status !== 'discharged') return false
      if (q) {
        const p = patientIndex.get(a.patientId)
        // Bed, ward and doctor stay searchable; the patient's own record is
        // joined in so a mobile number finds the occupied bed, which the
        // admission row alone cannot answer.
        const bedHay = [admissionName(a), a.wardName, a.bedNumber, a.attendingProvider, a.admissionType, a.encounterId]
          .join(' ').toLowerCase()
        if (!bedHay.includes(q) && !(p && matchesPatient(p, q))) return false
      }
      return true
    })
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    const sum = occupancySummary(admissions, wards)
    set('adm-occupied', sum.active)
    set('adm-total-beds', sum.totalBeds)
    set('adm-available', sum.hasCapacity ? sum.free : '—')
    set('adm-discharged', sum.discharged)
    const occSub = document.getElementById('adm-occ-sub')
    if (occSub) occSub.textContent = sum.hasCapacity ? sum.occupancyPct + '% occupancy' : 'no ward master yet'
    set('adm-ward-count', wards.length + (wards.length === 1 ? ' ward' : ' wards'))

    // Banner explaining where this page was opened from, so the link between the
    // encounter and the bed is explicit rather than implied.
    const ctx = document.getElementById('adm-context')
    if (ctx) {
      // Prefer the joined registry name — the encounter snapshot can predate
      // the patient_name field and come back empty.
      const encName = linkedEncounter
        ? (linkedEncounter.patientName || patientIndex.get(linkedEncounter.patientId)?.name || '')
        : ''
      if (encName) {
        ctx.innerHTML = '<div class="card" style="margin-bottom:14px"><div class="card-head"><h3>Admitting from encounter</h3>' +
          '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(linkedEncounter.id) + '">Back to encounter →</a></div>' +
          '<p class="sub"><strong>' + esc(encName) + '</strong> · encounter ' +
          esc(String(linkedEncounter.id).slice(0, 8)) + '… · ' + esc(linkedEncounter.status || 'open') +
          '. The new admission is linked to this encounter; the encounter stays open for documentation.</p></div>'
      } else if (linkedEncounterId) {
        ctx.innerHTML = '<div class="card" style="margin-bottom:14px"><p class="sub">Linked encounter ' +
          esc(linkedEncounterId.slice(0, 8)) + '… could not be loaded — the admission will be recorded without a clinical link.</p></div>'
      } else {
        ctx.innerHTML = ''
      }
    }

    const wg = document.getElementById('adm-wards')
    if (wg) {
      wg.innerHTML = sum.wards.length
        ? sum.wards.map((w) => {
          const tone = w.overCapacity ? 'bad' : (w.pct > 80 ? 'warn' : 'info')
          const detail = w.unconfigured
            ? 'no bed count configured'
            : w.free + ' free · ' + w.pct + '% occupied'
          return '<div class="ward"><div class="card-head"><h4>' + esc(w.name) + '</h4>' +
            '<span class="pill ' + tone + '">' + w.occupied + ' / ' + (w.totalBeds || '?') + '</span></div>' +
            '<p class="sub">' + esc(detail) + '</p></div>'
        }).join('')
        : '<p class="sub">No wards configured yet.' + (caps.canAdmit ? ' Use “Manage wards” to add your wards and bed counts.' : ' Ask an administrator to configure wards.') + '</p>'
    }

    const tbl = document.getElementById('adm-tbl')
    const titleEl = document.getElementById('adm-tbl-title')
    const rows = visibleAdmissions().map((a) => {
      const when = a.admissionDate || a.createdAt
      const patientCell = a.patientId
        ? '<a href="#/patients/' + encodeURIComponent(a.patientId) + '"><strong>' + esc(admissionName(a)) + '</strong></a>'
        : '<strong>' + esc(admissionName(a)) + '</strong>'
      const encCell = a.encounterId
        ? '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(a.encounterId) + '">View encounter</a>'
        : '<span class="mut">—</span>'
      return '<tr>' +
        '<td>' + patientCell + '</td>' +
        '<td>' + esc(a.wardName) + ' · ' + esc(a.bedNumber) + '</td>' +
        '<td>' + (when ? new Date(when).toLocaleDateString('en-NG') : '—') +
          (a.status === 'discharged' && a.dischargeDate
            ? '<div class="mut">out ' + new Date(a.dischargeDate).toLocaleDateString('en-NG') + '</div>' : '') + '</td>' +
        '<td>' + esc(a.attendingProvider || '—') + '</td>' +
        '<td>' + encCell + '</td>' +
        '<td>' + (a.status === 'active' ? '<a class="btn ghost sm" href="#/admissions/' + esc(a.id) + '">Workspace</a>' : '<span class="mut">—</span>') + '</td></tr>'
    }).join('')
    if (titleEl) {
      const mode = document.getElementById('admStatus')?.value || 'active'
      titleEl.textContent = mode === 'discharged' ? 'Discharge history' : (mode === 'all' ? 'All admissions' : 'Current admissions')
    }
    if (tbl) {
      tbl.innerHTML = '<tr><th>Patient</th><th>Ward · Bed</th><th>Admitted</th><th>Doctor</th><th>From encounter</th><th></th></tr>' +
        (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No admissions match this filter</td></tr>')
      more.mount(tbl.closest('.tblwrap'))
      tbl.querySelectorAll('[data-discharge]').forEach((b) => {
        b.onclick = () => openDischargeForm(b.getAttribute('data-discharge'))
      })
    }
    ensureVisibleMeta()
  }

  function openAdmitForm() {
    if (!patients.length) { toast('No patients registered yet — register a patient first.'); return }
    const enc = linkedEncounter
    // When arriving from an encounter the patient is fixed: the bed must belong
    // to the patient in that encounter, not to whoever is picked in a dropdown.
    const fixedPatient = enc && enc.patientId
      ? patients.find((p) => p.pid === enc.patientId) ||
        patientIndex.get(enc.patientId) ||
        { pid: enc.patientId, name: enc.patientName || enc.patientId }
      : null
    // Labels carry the mobile number so the picker's filter box can find a
    // patient by phone, not just by name.
    const patientOpts = fixedPatient
      ? [{ value: fixedPatient.pid, label: (fixedPatient.name || fixedPatient.pid) + ' · ' + (fixedPatient.mrn || fixedPatient.pid) }]
      : patients.map((p) => ({
        value: p.pid,
        label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
      }))
    const wardField = wards.length
      ? { name: 'ward_name', label: 'Ward', type: 'select', options: wards.map((w) => w.name), required: true }
      : { name: 'ward_name', label: 'Ward (no ward master yet — type a name)', required: true, placeholder: 'e.g. Ward A' }
    // With staff on file the doctor is a pick from the org's active memberships;
    // with none, it stays a free-text field so an admission is never blocked by
    // incomplete staff records.
    const providerField = clinicalStaff.length
      ? { name: 'attending_provider', label: 'Attending doctor', type: 'select', options: clinicalStaff }
      : { name: 'attending_provider', label: 'Attending doctor (no staff on file — type a name)', placeholder: 'e.g. Dr. N. Eze' }
    formModal({
      title: enc ? 'Admit patient (from encounter)' : 'Admit patient',
      submitLabel: 'Confirm admission',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true, full: true, value: fixedPatient ? fixedPatient.pid : '', searchable: !fixedPatient && patientOpts.length > 1, searchPlaceholder: 'Name, ID or mobile…' },
        wardField,
        { name: 'bed_number', label: 'Bed', required: true, placeholder: 'e.g. Bed 1' },
        { name: 'admission_type', label: 'Admission type', type: 'select', options: ADMISSION_TYPES },
        providerField,
        { name: 'admission_reason', label: 'Reason', full: true, placeholder: 'e.g. Observation' },
      ],
      onSubmit: async (v) => {
        // Same validator the service runs, applied first so the user sees the
        // reason inline without a round trip.
        const invalid = validateAdmissionInput(v, { wards, admissions, encounter: enc })
        if (invalid) throw new Error(invalid)
        const sel = patients.find((p) => p.pid === v.patient_id)
        await createAdmission({
          patient_id: v.patient_id,
          patient_name: (sel && sel.name) || (fixedPatient && fixedPatient.name) || v.patient_id,
          ward_name: v.ward_name,
          bed_number: v.bed_number,
          admission_type: v.admission_type,
          admission_reason: v.admission_reason,
          attending_provider: v.attending_provider,
          // One-way link back to the encounter that triggered this admission.
          encounter_id: enc ? enc.id : '',
        })
        closeModal()
        toast('Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)
        reload()
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
      ],
      onSubmit: async (v) => {
        try {
          await dischargeAdmission(id, v)
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Patient discharged')
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
    // Inject the current ward list at the top of the modal (formModal builds
    // #modalBody synchronously, so this runs after the form exists).
    const body = document.getElementById('modalBody')
    if (body) {
      const rows = wards.map((w) =>
        '<tr><td><strong>' + esc(w.name) + '</strong></td><td>' + occupiedIn(w.name) + ' occupied</td>' +
        '<td>' + w.totalBeds + ' beds</td>' +
        '<td><button class="btn ghost sm" data-edit-ward="' + esc(w.id) + '">Edit beds</button></td></tr>'
      ).join('')
      const div = document.createElement('div')
      div.innerHTML =
        '<div class="tblwrap"><table class="tbl"><tr><th>Ward</th><th>Occupancy</th><th>Capacity</th><th></th></tr>' +
        (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:12px 8px">No wards yet — add your first ward below</td></tr>') +
        '</table></div><br/>'
      body.prepend(div)
      // Delegation is assigned with `onclick` (not addEventListener) so re-opening
      // this modal REPLACES the handler. A document-level listener would
      // accumulate one closure per visit to this page, firing openEditWardBeds
      // once per past render — and each stale copy would carry an old ward list.
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

  document.getElementById('refreshBtn').onclick = reload
  const admitBtn = document.getElementById('admitBtn')
  if (admitBtn) admitBtn.onclick = openAdmitForm
  const wardsBtn = document.getElementById('wardsBtn')
  if (wardsBtn) wardsBtn.onclick = openWardsManager
  const admSearch = document.getElementById('admSearch')
  if (admSearch) admSearch.addEventListener('input', render)
  const admStatus = document.getElementById('admStatus')
  if (admStatus) admStatus.addEventListener('change', render)
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  // Live updates for admissions and the ward master (bed totals). The patient
  // join stays one-shot (registry is never live); a brand-new patient's
  // contact details may only appear in search after reload.
  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    // The live feed only ever knows about the newest slice of the list. Once the
    // user has scrolled past it, leave the accumulated list alone rather than
    // truncating it back to one chunk.
    if (cursor != null) return
    unsubs.push(
      subscribeOrgAdmissions(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(admissions.map((a) => a.id))
          admissions = rows.filter((a) => !seen.has(a.id)).concat(admissions)
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

  // The app does not re-route on org change, so rebuild the listeners when
  // the active hospital switches.
  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    // The filler is scoped to one hospital; a switch must not keep resolving
    // against the old org's registry.
    fillIndex = createPatientIndexFiller(watchedOrg)
    subscribeLive()
  })

  await loadMore()
  subscribeLive()
}
