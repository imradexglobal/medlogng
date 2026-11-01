// Consultations / encounters queue + encounter workspace (offline-first, cached).
import { shell, formModal, toast, closeModal, wireToast, openModal, statusBadge } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgEncountersPage, subscribeOrgEncounters, updateEncounterStatus, addDiagnosis, addPrescriptions, setEncounterPrescription,
  myEncounterCaps, recordEncounterVitals, updateEncounterNote, addTreatmentPlan, ENCOUNTER_STATUS_FLOW_META,
} from '../services/consultationService.js'
import { listOrgPatientsPage, formatPhone, matchesPatient, createPatientIndexFiller } from '../services/patientService.js'
import {
  listOrgAdmissions, listOrgAdmissionsPage, subscribeOrgAdmissions, myAdmissionCaps, indexAdmissionsByEncounter, activeAdmissionForEncounter,
} from '../services/admissionService.js'
import { myLabCaps } from '../services/laboratoryService.js'
import { listOrgDrugs, findOpenRequest, listRequestsForEncounter, updateRequestItems } from '../services/pharmacyService.js'
import { administerDose, myAdminCaps } from '../services/medicationAdminService.js'
import { openPrescriptionModal } from '../features/pharmacy/prescriptionModal.js'
import * as R from '../features/pharmacy/requests.js'
import * as A from '../features/pharmacy/administration.js'
import { printDocument } from '../lib/print.js'
import { prescriptionHtml } from '../lib/prescriptionPrint.js'
import { myBillingCaps } from '../services/billingService.js'
import { myActiveMembership } from '../services/authService.js'
import { can } from '../features/admin/roles.js'
import { navigate } from '../router.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { staffLabel } from '../lib/staffName.js'
import { fmtDate, fmtDateTime } from '../utils/format.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteEncounter } from '../services/deleteService.js'

// Encounter statuses are stored lowercase, so the shared statusBadge() (whose
// keys are capitalised) rendered them as bare uncoloured pills. The label +
// tone mapping comes from features/encounters/domain.js, so this view can
// never drift out of sync with the workflow the service actually walks.
const STATUS_FLOW = ENCOUNTER_STATUS_FLOW_META

function encLabel(status) {
  const m = STATUS_FLOW.find((s) => s.key === status)
  return m ? m.label : (status || 'Unknown')
}

function encBadge(status) {
  const m = STATUS_FLOW.find((s) => s.key === status)
  if (!m) return '<span class="pill">' + esc(status || 'Unknown') + '</span>'
  return '<span class="pill ' + m.tone + '">' + esc(m.label) + '</span>'
}

function txt(v, fallback = '—') {
  const t = String(v == null ? '' : v).trim()
  return t || fallback
}

// Firestore timestamps arrive as Timestamps, plain numbers or null (a write
// still sitting in the local cache), so one reader covers all three.
function waitedFor(ts, endTs) {
  if (!ts) return '—'
  const end = endTs || Date.now()
  const secs = Math.max(0, Math.floor((end - ts) / 1000))
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (d) return d + 'd:' + h + 'h:' + m + 'm:' + s + 's'
  if (h) return h + 'h:' + m + 'm:' + s + 's'
  if (m) return m + 'm:' + s + 's'
  return s + 's'
}

// Colour band for the waited cell so long waits are visible at a glance.
function waitTone(secs) {
  if (secs <= 900) return 'ok'      // <= 15 min
  if (secs <= 1800) return 'warn'   // 15-30 min
  return 'bad'                      // > 30 min
}

export async function ConsultationsView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myEncounterCaps()
  const billingCaps = myBillingCaps()
  // Returned to from Billing ("← Back to encounter") or deep-linked.
  const wantEnc = String(params.enc || '')

  if (!activeOrg) {
    shell(app, {
      active: '/consultations',
      title: 'Consultations',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let encounters = []
  let patients = []
  let pIndex = new Map()
  // The registry join only loads one bounded page of organization_patients, so
  // a patient past that page — or an encounter whose snapshot lost
  // patient_name — would read as "Unknown patient". fillIndex() fetches those
  // on demand and drops them into pIndex; see ensureVisibleMeta().
  let fillIndex = createPatientIndexFiller(activeOrg)
  // Infinite scroll: rows accumulate and `cursor` marks the end of what we hold.
  let cursor = null
  let hasMore = false
  let loading = false
  let selectedEncounter = null
  // Which pane of the tabbed workspace is showing. Persists across live
  // repaints so a clinician writing a note is not thrown back to Overview
  // every time the queue ticks.
  let wsTab = 'overview'
  // Pharmacy catalogue, loaded lazily the first time the prescription form is
  // opened. Prescribing is offered only against in-stock lots, so the clinician
  // cannot queue a medicine the hospital is unable to issue.
  let drugs = null
  // Prescription scripts already written for the selected encounter. Cached per
  // encounter so the live encounter feed does not re-query the pharmacy on every
  // tick, and re-read explicitly after any prescribing action.
  let rxScripts = []
  let rxFor = ''
  let rxSeq = 0
  const rxExpanded = new Set()
  // Admissions grouped by the encounter that triggered them. Fetched once per
  // load so the queue can badge every admitted patient without one query a row.
  let admissionsByEncounter = new Map()
  let activeBedByPatient = new Map()
  const bedCaps = myAdmissionCaps()
  let unsubs = []
  let watchedOrg = activeOrg
  let tick = null

  shell(app, {
    active: '/consultations',
    title: 'Consultations',
    subtitle: 'Arrival → Vitals → Consultation → Diagnosis → Plan → Close',
    actions:
      '<button class="btn" id="newEncB">+ Start encounter</button>' +
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>',
    body:
      // Both panels are viewport-height on desktop (.consult-grid): the queue
      // scrolls in its own box and the workspace scrolls between its tab strip
      // and its fixed action bar, so neither drags the whole page around.
      '<div class="grid2x consult-grid"><div class="card"><div class="card-head"><h3>Encounter queue</h3><span class="pill info" id="enc-count">0 open</span></div>' +
      '<div class="toolbar" style="margin:0 0 8px"><div style="position:relative;display:inline-block"><input class="input" id="qSearch" aria-label="Search encounters by patient, MRN or mobile" placeholder="Search patient, MRN or mobile…" style="max-width:240px"><button type="button" id="qClear" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--emr-muted);cursor:pointer;font-size:1.2rem;line-height:1;padding:0" hidden>✕</button></div>' +
      '<select class="input" id="qStatus" style="max-width:170px"><option value="open" selected>Open encounters</option><option value="closed">Closed</option><option value="all">All</option>' +
      STATUS_FLOW.map((s) => '<option value="' + s.key + '">' + esc(s.label) + '</option>').join('') + '</select></div>' +
      '<div class="tblwrap"><table class="tbl" id="enc-tbl"><thead><tr><th>Patient</th><th>MRN · contact</th><th>Waited</th><th>Status</th></tr></thead><tbody>' +
      '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</tbody></table><div class="loadmore" data-loadmore="1"></div></div></div>' +
      '<div class="card enc-ws">' +
      '<div class="enc-ws-head">' +
      '<div class="card-head"><h3 id="encTitle">No encounter selected</h3><span id="encStatus">—</span></div>' +
      '<p class="sub" id="encHint">Select a patient from the queue to open the encounter workspace.</p>' +
      '</div>' +
      // The long workspace is tabbed instead of one endless list: Overview
      // (identity, flow, vitals), the SOAP note, the plan, prescriptions and
      // lab orders each get their own pane as data is added.
      // Compact labels so all five tabs share one row with no sideways scroll
      // (title= carries the full name; .enc-tabs flex rules enforce the fit).
      '<div class="tabs enc-tabs" id="encTabs">' +
      '<button data-wt="overview" class="on" title="Overview">Overview</button>' +
      '<button data-wt="note" title="Clinical note (SOAP)">SOAP note</button>' +
      '<button data-wt="plan" title="Treatment plan">Plan <span class="pill ok" id="planDot" hidden>✓</span></button>' +
      '<button data-wt="rx" title="Prescriptions">Rx <span class="pill info" id="rxCount" hidden>0</span></button>' +
      '<button data-wt="labs" title="Lab orders">Labs <span class="pill info" id="labCount" hidden>0</span></button>' +
      '</div>' +
      // Only THIS box scrolls — the tab strip above and the action bar below
      // stay pinned, so +Vitals / +Diagnosis / Advance are always reachable.
      '<div class="enc-ws-body" id="encWsBody">' +
      '<div data-wp="overview">' +
      '<div class="flow" id="enc-flow">' + STATUS_FLOW.map((s) => '<span class="fstep">' + esc(s.step) + '</span><span class="farrow">→</span>').join('').replace(/<span class="farrow">→<\/span>$/, '') + '</div>' +
      '<div id="encWho"></div>' +
      '<div id="encAdm"></div>' +
      '<div class="kv"><div><em>BP</em><strong id="v-bp">—</strong></div><div><em>Pulse</em><strong id="v-pulse">—</strong></div><div><em>Temp</em><strong id="v-temp">—</strong></div><div><em>SpO₂</em><strong id="v-spo2">—</strong></div></div>' +
      '<div id="encDx" style="margin-top:10px"></div>' +
      '</div>' +
      '<div data-wp="note" hidden>' +
      '<label class="fld full"><span>Clinical note (SOAP)</span><textarea class="input" id="enc-note" rows="8" placeholder="S: … O: … A: … P: …"></textarea></label>' +
      '<div class="toolbar" style="margin-top:6px"><button class="btn sm" id="saveNoteB">Save note</button><span class="mut" id="noteState"></span></div>' +
      '</div>' +
      '<div data-wp="plan" hidden>' +
      '<div id="planBox" hidden><div class="fld full"><span>Treatment plan</span><div class="input" id="planView" style="white-space:pre-wrap"></div></div></div>' +
      '<p class="sub" id="planEmpty">No plan saved on this encounter yet — add one with <strong>+ Plan</strong> below.</p>' +
      '</div>' +
      '<div data-wp="rx" hidden><div id="encRx"></div></div>' +
      '<div data-wp="labs" hidden><div id="encLabs"></div></div>' +
      '</div>' +
      // Fixed action bar: never scrolls away, whatever tab is showing.
      '<div class="toolbar enc-ws-bar"><button class="btn ghost sm" id="vitalsB">+ Vitals</button><button class="btn ghost sm" id="dxB">+ Diagnosis</button><button class="btn ghost sm" id="rxB">+ Prescription</button><button class="btn ghost sm" id="labB">+ Lab order</button><button class="btn ghost sm" id="planB">+ Plan</button><button class="btn ghost sm" id="billB">+ Bill item</button>' +
      (caps.canEdit ? '<button class="btn ghost sm" id="advB">Advance →</button><button class="btn sm" id="closeEncB">Close encounter →</button>' : '') +
      '<span id="delEncSlot"></span>' +
      (bedCaps.canAdmit ? '<button class="btn sm" id="admitFromEncB">Admit patient</button>' : '') + '</div>' +
      '</div></div>',
  })

  // The queue only stores patient_name, so the readable identity (MRN, age,
  // phone, payer) is joined in from the org patient list. Falls back to the
  // encounter's own snapshot when the patient is not in this hospital's list.
  function patientMeta(e) {
    const p = pIndex.get(e.patientId)
    if (!p) {
      return { pid: e.patientId || '', name: e.patientName || 'Unknown patient', mrn: '—', sex: '', age: '', dob: '', phone: '', phone_key: '', payer: '', allergy: '' }
    }
    return {
      pid: p.pid,
      name: p.name || e.patientName || 'Unnamed patient',
      mrn: p.mrn || p.pid,
      sex: p.sex || '',
      age: p.age,
      dob: p.dob || '',
      phone: formatPhone(p.phone, p.phone_key),
      // Carried through unformatted so the queue filter can match a mobile
      // number typed as '0803…' against the stored digits.
      phone_key: p.phone_key || '',
      payer: p.payer || '',
      allergy: p.allergy || '',
    }
  }

  // Name the patients the screen is actually showing but the bounded index
  // missed. Filled rows land in pIndex and repaint exactly once — a render
  // that finds nothing new stops the cycle, so this can never loop.
  async function ensureVisibleMeta() {
    if (!document.getElementById('enc-tbl')) return
    const ids = visibleEncounters().map((e) => e.patientId)
    if (selectedEncounter) ids.push(selectedEncounter.patientId)
    const changed = await fillIndex.fill(pIndex, ids)
    if (!changed || !document.getElementById('enc-tbl')) return
    renderQueue()
    renderWorkspace()
  }

  // The admissions join (per-encounter index + per-patient active bed). Shared
  // by loadMore() and the live admissions subscription so a bed change
  // re-renders the queue's bed badges through the exact same path.
  function indexAdmissions(adms) {
    admissionsByEncounter = indexAdmissionsByEncounter(adms)
    activeBedByPatient = new Map()
    for (const a of adms) {
      if (a.status === 'active' && a.patientId && !activeBedByPatient.has(a.patientId)) {
        activeBedByPatient.set(a.patientId, a)
      }
    }
  }

  // Re-point the selected encounter at its freshest row (or pick one when none
  // is selected yet). Shared by loadMore() and the live encounter subscription.
  function refreshSelectedEncounter() {
    if (!selectedEncounter) {
      selectedEncounter = wantEnc && encounters.find((e) => e.id === wantEnc)
    }
    if (selectedEncounter) {
      const fresh = encounters.find((e) => e.id === selectedEncounter.id)
      if (fresh) selectedEncounter = fresh
      else selectedEncounter = null
    }
  }

  const more = createLoadMore(loadMore)

  // Append the next chunk of the queue. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded. The
  // open encounter is never dropped here — scrolling must not close the
  // workspace a clinician is working in.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && encounters.length === 0
    loading = true
    more.setLoading(true)
    document.getElementById('enc-tbl')?.closest('.tblwrap')?.classList.add('is-loading')
    try {
      const [pg, pats, adms] = await Promise.all([
        listOrgEncountersPage(activeOrg, { cursor }),
        first ? listOrgPatientsPage(activeOrg, { pageSize: 100 }).then((r) => r.rows).catch(() => []) : Promise.resolve(patients),
        listOrgAdmissionsPage(activeOrg, { pageSize: 100 }).then((r) => r.rows).catch(() => []),
      ])
      // A row written between two chunk reads shifts the cursor stream and can
      // repeat the boundary document.
      const seen = new Set(encounters.map((e) => e.id))
      encounters = first ? pg.rows : [...encounters, ...pg.rows.filter((e) => !seen.has(e.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) {
        patients = pats
        pIndex = new Map(patients.map((p) => [p.pid, p]))
      }
      indexAdmissions(adms)
      refreshSelectedEncounter()
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      renderQueue()
      renderWorkspace()
    } catch (e) {
      console.error('[consultations] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) toast('Could not load encounters: ' + friendlyWriteError(e))
      else more.setError('Could not load more — retry')
    } finally {
      document.getElementById('enc-tbl')?.closest('.tblwrap')?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole queue, keeping the open encounter selected.
  function reload() {
    encounters = []
    cursor = null
    hasMore = false
    fillIndex.reset()
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive).catch((e) => {
      console.warn('[consultations] initial load failed:', e?.message || e)
      toast('Could not load consultations — check your connection')
    })
  }

  // The bed currently held by an admission linked to this encounter, if any.
  function linkedBed(enc) {
    return enc ? activeAdmissionForEncounter(admissionsByEncounter, enc.id) : null
  }

  // The patient's current bed from ANY admission, linked or not — a patient who
  // was admitted from the ward desk still holds one bed, and offering a second
  // admit would be a double-booking the service would (rightly) reject.
  function patientBed(enc) {
    if (!enc || !enc.patientId) return null
    return activeBedByPatient.get(enc.patientId) || null
  }

  let noteDirty = false
  function visibleEncounters() {
    const q = String(document.getElementById('qSearch')?.value || '').trim().toLowerCase()
    const mode = document.getElementById('qStatus')?.value || 'open'
    return encounters.filter((e) => {
      if (mode === 'open' && e.status === 'closed') return false
      if (mode === 'closed' && e.status !== 'closed') return false
      if (mode !== 'all' && mode !== 'open' && mode !== 'closed' && e.status !== mode) return false
      if (q) {
        // Same matcher the registry uses, so name, ID, MRN and mobile number
        // all work — the old haystack had no phone in it at all.
        if (!matchesPatient(patientMeta(e), q)) return false
      }
      return true
    })
  }

  function renderQueue() {
    const tbl = document.getElementById('enc-tbl')
    const cnt = document.getElementById('enc-count')
    const openN = encounters.filter((e) => e.status !== 'closed').length
    if (cnt) cnt.textContent = openN + ' open'
    if (!tbl) return
    const head = '<thead><tr><th>Patient</th><th>MRN · contact</th><th>Waited</th><th>Status</th></tr></thead>'
    const shown = visibleEncounters()
    const rows = shown.map((e) => {
      const m = patientMeta(e)
      const who = [m.age !== '' && m.age != null ? m.age + 'y' : '', m.sex].filter(Boolean).join(' · ')
      const b = patientBed(e)
      const waited = e.createdAt ? Math.max(0, Math.floor(((e.status === 'closed' ? e.updatedAt : Date.now()) - e.createdAt) / 1000)) : 0
      // Bed badge lives inside the status cell so the table keeps its four
      // columns — the "Waited" clock ticks r.cells[2].
      const bedBadge = b
        ? '<div style="margin-top:4px"><span class="pill ok" title="Admitted to ' + esc(b.wardName) + ' · ' + esc(b.bedNumber) + '">🛏 ' +
          esc(String(b.wardName || '').slice(0, 14)) + ' · ' + esc(b.bedNumber) + '</span></div>'
        : ''
      return '<tr class="clickable' + (selectedEncounter && selectedEncounter.id === e.id ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' +
        '<td><strong>' + esc(m.name) + '</strong><div class="mut">' + esc(m.pid.slice(0, 8)) + '</div></td>' +
        '<td><div>' + esc(m.mrn) + '</div><div class="mut">' + esc(who || 'No demographics on file') + '</div>' +
        (m.phone ? '<div class="mut">' + esc(m.phone) + '</div>' : '') + '</td>' +
        '<td class="mut ' + (waited ? waitTone(waited) : '') + '">' + esc(waitedFor(e.createdAt, e.status === 'closed' ? e.updatedAt : 0)) + '</td>' +
        '<td>' + encBadge(e.status) + bedBadge + '</td></tr>'
    }).join('')
    tbl.innerHTML = head + '<tbody>' + (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No encounters match this filter</td></tr>') + '</tbody>'
    more.mount(tbl.closest('.tblwrap'))
    tbl.querySelectorAll('tr.clickable').forEach((r) => {
      r.onclick = () => {
        if (noteDirty && !window.confirm('You have an unsaved note. Switch encounters anyway?')) return
        noteDirty = false
        selectedEncounter = encounters.find((e) => e.id === r.getAttribute('data-id')) || null
        renderQueue()
        renderWorkspace()
      }
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (noteDirty && !window.confirm('You have an unsaved note. Switch encounters anyway?')) return
          noteDirty = false
          selectedEncounter = encounters.find((e) => e.id === r.getAttribute('data-id')) || null
          renderQueue()
          renderWorkspace()
        }
      })
    })
    ensureVisibleMeta()
  }

  // ---- workspace tabs -------------------------------------------------------
  // One pane at a time inside #encWsBody; only that box scrolls, so the tab
  // strip and the action bar below it stay pinned in place.
  function showWsTab(name) {
    wsTab = name
    document.querySelectorAll('#encTabs button').forEach((b) =>
      b.classList.toggle('on', b.getAttribute('data-wt') === name))
    document.querySelectorAll('#encWsBody [data-wp]').forEach((p) => {
      p.hidden = p.getAttribute('data-wp') !== name
    })
  }
  document.querySelectorAll('#encTabs button').forEach((b) => {
    b.onclick = () => showWsTab(b.getAttribute('data-wt'))
  })

  function renderWorkspace() {
    const titleEl = document.getElementById('encTitle')
    const statusEl = document.getElementById('encStatus')
    const noteEl = document.getElementById('enc-note')
    const whoEl = document.getElementById('encWho')
    if (!selectedEncounter) {
      if (titleEl) titleEl.textContent = 'No encounter selected'
      if (statusEl) statusEl.textContent = '—'
      const hintEl = document.getElementById('encHint')
      if (hintEl) hintEl.hidden = false
      if (whoEl) whoEl.innerHTML = ''
      const admEl0 = document.getElementById('encAdm')
      if (admEl0) admEl0.innerHTML = ''
      const rxE = document.getElementById('encRx')
      if (rxE) rxE.innerHTML = ''
      const labsE0 = document.getElementById('encLabs')
      if (labsE0) labsE0.innerHTML = ''
      const dxE0 = document.getElementById('encDx')
      if (dxE0) dxE0.innerHTML = ''
      rxScripts = []
      rxFor = ''
      paintBadges()
      const admitBtn0 = document.getElementById('admitFromEncB')
      if (admitBtn0) admitBtn0.style.display = 'none'
      const delSlot0 = document.getElementById('delEncSlot')
      if (delSlot0) delSlot0.innerHTML = ''
      paintFlow(-1)
      return
    }
    const e = selectedEncounter
    const m = patientMeta(e)
    if (titleEl) titleEl.textContent = m.name
    if (statusEl) statusEl.innerHTML = encBadge(e.status)
    const hintEl = document.getElementById('encHint')
    if (hintEl) hintEl.hidden = true
    if (whoEl) {
      const demo = [m.age !== '' && m.age != null ? m.age + 'y' : '', m.sex].filter(Boolean).join(' · ') || '—'
      whoEl.innerHTML =
        '<div class="kv">' +
        '<div><em>MRN</em><strong style="font-size:.9rem">' + esc(m.mrn) + '</strong></div>' +
        '<div><em>Age / sex</em><strong style="font-size:.9rem">' + esc(demo) + '</strong></div>' +
        '<div><em>Payer</em><strong style="font-size:.9rem">' + esc(m.payer || '—') + '</strong></div>' +
        '<div><em>Phone</em><strong style="font-size:.9rem">' + esc(m.phone || '—') + '</strong></div>' +
        '</div>' +
        (m.allergy && m.allergy !== 'None known'
          ? '<div class="allergy" style="margin-top:10px">⚠ Allergy: <strong>' + esc(m.allergy) + '</strong> — confirm before prescribing</div>'
          : '') +
        '<div class="toolbar" style="margin:10px 0 12px">' +
        (m.pid ? '<a class="btn ghost sm" href="#/patients/' + encodeURIComponent(m.pid) + '">Open patient record →</a>' : '') +
        '<span class="mut">Encounter ' + esc(e.id.slice(0, 8)) + ' · ' + esc(encLabel(e.status)) + (e.type ? ' · ' + esc(e.type) : '') + (e.clinician ? ' · ' + esc(e.clinician) : '') + '</span>' +
        '</div>'
    }
    paintFlow(STATUS_FLOW.findIndex((s) => s.key === e.status))

    // ---- admission strip ----------------------------------------------------
    // Per HL7 FHIR the admission is a stay hanging off this encounter, not a
    // replacement for it: the clinician keeps documenting here, so nothing in
    // this block closes or advances the encounter.
    const admEl = document.getElementById('encAdm')
    const admitBtn = document.getElementById('admitFromEncB')
    const bed = linkedBed(e)
    const anyBed = bed || patientBed(e)
    if (admEl) {
      if (anyBed) {
        admEl.innerHTML =
          '<div class="allergy" style="margin:0 0 12px;background:var(--emr-okbg);border-color:var(--emr-ok)">' +
          '🛏 Inpatient · <strong>' + esc(anyBed.wardName || 'ward unknown') + ' · ' + esc(anyBed.bedNumber || 'bed unknown') + '</strong>' +
          (bed ? ' — admitted from this encounter' : ' — admitted separately') +
          (anyBed.attendingProvider ? ' · ' + esc(anyBed.attendingProvider) : '') +
          ' <a class="btn ghost sm" href="#/admissions">Bed board →</a></div>'
      } else {
        admEl.innerHTML = bedCaps.canAdmit
          ? '<p class="sub" style="margin:0 0 12px">Not admitted. Admitting from here links the bed to this encounter and leaves the encounter open for documentation.</p>'
          : ''
      }
    }
    if (admitBtn) {
      const canAdmitThis = bedCaps.canAdmit && !anyBed && !!e.patientId
      admitBtn.style.display = canAdmitThis ? '' : 'none'
      admitBtn.title = anyBed ? 'This patient already holds a bed' : 'Admit to a ward bed, linked to this encounter'
    }
    // Label Advance with where it actually goes, so the fallback is never a
    // blind step into an unknown stage.
    const advBtn = document.getElementById('advB')
    if (advBtn) {
      const ni = STATUS_FLOW.findIndex((s) => s.key === e.status) + 1
      const nextStep = STATUS_FLOW[ni]
      advBtn.textContent = nextStep && e.status !== 'closed' ? 'Advance → ' + nextStep.label : 'Advance →'
    }
    // Delete is only offered once the encounter is closed (the service refuses
    // open ones) and only for data.delete holders. Repainted on every selection
    // change because the action bar itself is static shell markup.
    const delSlot = document.getElementById('delEncSlot')
    if (delSlot) {
      delSlot.innerHTML = e.status === 'closed'
        ? kebabCell({ rowId: e.id, items: [{ label: 'Delete', tone: 'danger', dataAction: 'delete' }] }) : ''
      wireKebabs(delSlot, async (rowId, action) => {
        if (action === 'delete') {
          confirmDelete('this closed encounter', () => deleteEncounter(rowId), () => {
            selectedEncounter = null
            reload()
          })
        }
      })
    }
    const vitals = e.vitals || {}
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '—' }
    set('v-bp', vitals.BP); set('v-pulse', vitals.Pulse); set('v-temp', vitals.Temp); set('v-spo2', vitals.SpO2)
    // Diagnoses recorded on this encounter — the whole list when the doc has
    // it, else the single `diagnosis` string older rows carry.
    const dxEl = document.getElementById('encDx')
    if (dxEl) {
      const dxList = (Array.isArray(e.raw?.diagnoses) && e.raw.diagnoses.length)
        ? e.raw.diagnoses
        : (e.diagnosis ? [{ condition: e.diagnosis }] : [])
      dxEl.innerHTML = dxList.length
        ? '<em style="font-style:normal;font-size:.7rem;font-weight:700;text-transform:uppercase;color:var(--emr-muted)">Diagnoses</em><div style="margin-top:5px">' +
          dxList.map((d) => '<span class="pill info" style="margin:0 6px 6px 0">' + esc(txt(d.condition)) + '</span>').join('') +
          '</div>'
        : ''
    }
    if (noteEl && document.activeElement !== noteEl) noteEl.value = e.chiefComplaint ? 'S: ' + e.chiefComplaint : ''
    // The saved plan is data, not an editor — show it read-only when present so
    // "Plan set" is backed by something the prescriber can actually read back.
    const planBox = document.getElementById('planBox')
    const planView = document.getElementById('planView')
    const planEmpty = document.getElementById('planEmpty')
    if (planBox && planView) {
      if (e.treatmentPlan) {
        planView.textContent = e.treatmentPlan
        planBox.hidden = false
        if (planEmpty) planEmpty.hidden = true
      } else {
        planView.textContent = ''
        planBox.hidden = true
        if (planEmpty) planEmpty.hidden = false
      }
    }
    renderEncLabs()
    loadEncRx()
    paintBadges()
    ensureVisibleMeta()
  }

  // Tab-strip counters: which panes actually hold data, at a glance, without
  // hopping through the tabs to find out.
  function paintBadges() {
    const e = selectedEncounter
    const planDot = document.getElementById('planDot')
    if (planDot) planDot.hidden = !(e && e.treatmentPlan)
    const labEl = document.getElementById('labCount')
    if (labEl) {
      const n = e && Array.isArray(e.labOrders) ? e.labOrders.length : 0
      labEl.hidden = !n
      labEl.textContent = n
    }
    const rxEl = document.getElementById('rxCount')
    if (rxEl) {
      const n = e ? rxScripts.length : 0
      rxEl.hidden = !n
      rxEl.textContent = n
    }
  }

  // Lab orders live as a snapshot on the encounter itself (written by
  // "+ Lab order"), so this pane reads straight off the selected row — no
  // extra query, and it repaints with the live encounter feed.
  function renderEncLabs() {
    const el = document.getElementById('encLabs')
    if (!el) return
    const orders = (selectedEncounter && selectedEncounter.labOrders) || []
    if (!orders.length) {
      el.innerHTML = '<p class="sub">No lab orders on this encounter yet — place one with <strong>+ Lab order</strong> below.</p>'
      return
    }
    el.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Order</th><th>Tests</th><th>Priority</th><th>Ordered</th></tr></thead><tbody>' +
      orders.map((o) =>
        '<tr><td><a href="#/laboratory/orders/' + esc(txt(o.lab_order_id || o.id)) + '"><strong>' + esc(txt(o.lab_order_id || o.id)) + '</strong></a></td>' +
        '<td>' + esc(txt(o.test_panel || (Array.isArray(o.tests) ? o.tests.join(', ') : ''))) + '</td>' +
        '<td>' + esc(txt(o.priority, 'Routine')) + '</td>' +
        '<td class="mut">' + esc(fmtDateTime(o.ordered_at)) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<p class="sub" style="margin-top:8px">Snapshot copied onto this encounter when the order was placed — the live result trail stays in Laboratory.</p>'
  }

  // ---- prescriptions for this encounter ------------------------------------
  // One row per prescription SCRIPT (the whole script for this patient/visit),
  // expandable to every line and printable for the patient. Cached per encounter
  // so the live encounter feed does not hammer the pharmacy collection.
  async function loadEncRx(force = false) {
    const el = document.getElementById('encRx')
    if (!el) return
    const enc = selectedEncounter
    if (!enc || !enc.patientId) {
      rxScripts = []; rxFor = ''; el.innerHTML = ''; return
    }
    if (!force && rxFor === enc.id) return
    const seq = ++rxSeq
    // A different encounter's scripts must never linger — neither in the list
    // nor in the tab badge — while this one is being fetched.
    if (rxFor !== enc.id) {
      rxScripts = []
      rxExpanded.clear()
    }
    rxFor = enc.id
    if (!rxScripts.length) el.innerHTML = '<p class="sub" style="margin:10px 0 0">Loading prescriptions…</p>'
    try {
      const list = await listRequestsForEncounter(enc.id)
      if (seq !== rxSeq || rxFor !== enc.id) return
      rxScripts = list
      renderEncRx()
    } catch (e) {
      if (seq !== rxSeq) return
      el.innerHTML = '<p class="sub" style="margin:10px 0 0">Could not load prescriptions: ' + esc(friendlyWriteError(e)) + '</p>'
    }
  }

  // Summary of a script's medicines, scannable without opening it.
  function rxSummary(r) {
    const names = r.items.map((l) => l.medicine || 'item')
    return esc(names.slice(0, 2).join(', ') || '—') + (names.length > 2 ? ' <span class="mut">+' + (names.length - 2) + ' more</span>' : '')
  }

  // Record one dose against one script line: qty, route, site, note. The hard
  // stop (never more than the prescriber ordered) is enforced in the service;
  // the issued-stock shortfall is only a warning here, because ward stock can
  // bridge it and external lines were never issued at all.
  function openGiveDoseModal(r, l) {
    if (!canAdminDose) { toast('Your role cannot record medication administration — ask an administrator for the "medication.administer" capability.'); return }
    const remaining = A.lineRemainingToGive(l)
    if (remaining <= 0) { toast(`"${l.medicine}" has already been given in full (${R.toQty(l.quantity, 1)} of ${R.toQty(l.quantity, 1)}).`); return }
    formModal({
      title: `Give ${l.medicine || 'dose'}`,
      fields: [
        { name: 'dose_line', label: 'Medicine', preview: `${l.medicine || '—'}${l.dosage ? ' · ' + l.dosage : ''} — ${remaining} of ${R.toQty(l.quantity, 1)} left to give` },
        { name: 'qty', label: 'Doses to give now', type: 'number', value: 1, required: true, hint: true },
        { name: 'route', label: 'Route', type: 'select', value: 'oral', options: A.ADMIN_ROUTES.map((x) => ({ value: x, label: x.toUpperCase() })) },
        { name: 'site', label: 'Site (for injections)', placeholder: 'e.g. left deltoid' },
        { name: 'note', label: 'Note', type: 'textarea', placeholder: 'optional — anything worth recording about this dose' },
      ],
      submitLabel: 'Record dose',
      onInput: (vals) => {
        const hint = document.querySelector('#fmFields [data-hint="qty"]')
        if (!hint) return
        const q = Number(vals.qty)
        if (!q || q <= 0) { hint.hidden = true; return }
        if (A.overIssuedWarn(l, q)) {
          const issued = R.toQty(l.dispensed_qty, 0)
          hint.textContent = `⚠ pharmacy issued ${issued} — this dose reaches beyond that. Fine if ward stock covers it; otherwise check the issue first.`
          hint.hidden = false
        } else {
          hint.hidden = true
        }
      },
      onSubmit: async (v) => {
        const qty = Number(v.qty)
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Dose quantity must be greater than zero.')
        if (A.exceedsOrder(l, qty)) throw new Error(`Only ${remaining} left to give on "${l.medicine}" (ordered ${R.toQty(l.quantity, 1)}, given ${A.lineGiven(l)}).`)
        const res = await administerDose({ requestId: r.id, lineId: l.line_id, qty, route: v.route, site: v.site, note: v.note })
        closeModal()
        toast(`${l.medicine}: given ${qty} — ${res.remaining} left to give`)
        await loadEncRx(true)
        showWsTab('rx')
      },
    })
  }

  function renderEncRx() {
    const el = document.getElementById('encRx')
    if (!el) return
    if (!rxScripts.length) {
      el.innerHTML = '<p class="sub">No prescriptions on this encounter yet — write one with <strong>+ Prescription</strong> below.</p>'
      paintBadges()
      return
    }
    const rows = rxScripts.map((r) => {
      const open = R.isOpenRequest(r.status) || r.status === R.REQUEST_STATUS.EXTERNAL
      const expanded = rxExpanded.has(r.id)
      const lines = r.items.map((l) => {
        const issued = R.toQty(l.dispensed_qty, 0)
        const given = A.lineGiven(l)
        const left = A.lineRemainingToGive(l)
        const unit = l.unit ? ' ' + esc(l.unit) : ''
        return '<tr>' +
          '<td><strong>' + esc(l.medicine || '—') + '</strong>' + (l.external ? ' <span class="pill info">external</span>' : '') +
          (l.sku ? '<div class="mut">' + esc(l.sku) + '</div>' : '') + '</td>' +
          '<td>' + esc(l.dosage || '—') + '</td>' +
          '<td>' + esc(R.toQty(l.quantity, 0)) + unit + '</td>' +
          '<td>' + (issued ? esc(issued) : '<span class="mut">—</span>') + '</td>' +
          '<td>' + (given ? '<strong>' + esc(given) + '</strong>' : '<span class="mut">—</span>') + '</td>' +
          '<td>' + (left > 0 ? '<span class="pill warn">' + esc(left) + ' to go</span>' : '<span class="pill ok">done</span>') + '</td>' +
          '<td class="mut">' + esc(l.instructions || '—') + '</td>' +
          '<td style="white-space:nowrap">' + kebabCell({ rowId: r.id + '|' + l.line_id, items: (canAdminDose && left > 0
            ? [{ label: 'Give', dataAction: 'give' }]
            : []) }) + '</td></tr>'
      }).join('')
      // Script-level dose progress rides in the summary row so "how much of
      // this script has the patient actually taken" is readable without opening
      // it — the number the front desk quotes when a patient asks.
      const doseBit = (r.given > 0 || r.toGive > 0)
        ? '<div class="mut" style="font-size:.72rem">Given ' + esc(r.given) + ' of ' + esc(r.given + r.toGive) + ' · ' + esc(r.toGive) + ' to go</div>'
        : ''
      return '<tr class="clickable' + (expanded ? ' sel' : '') + '" data-rx-row="' + esc(r.id) + '">' +
        '<td><span class="mut" data-rx-caret>' + (expanded ? '▾' : '▸') + '</span> ' + rxSummary(r) +
        (r.prescribedBy ? '<div class="mut">' + esc(staffLabel(r.prescribedBy) || r.prescribedBy) + '</div>' : '') + doseBit + '</td>' +
        '<td>' + esc(r.lineCount) + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td class="mut">' + esc(fmtDateTime(r.raw?.created_at)) + '</td>' +
        '<td style="white-space:nowrap">' + kebabCell({ rowId: r.id, items: [
          { label: '🖨 Print', dataAction: 'print' },
          ...(canRx && open ? [{ label: 'Adjust', dataAction: 'adjust' }] : [])
        ] }) + '</td></tr>' +
        '<tr data-rx-detail="' + esc(r.id) + '" style="' + (expanded ? '' : 'display:none') + '">' +
        '<td colspan="5" style="background:#f8fafc">' +
          (lines
            ? '<div class="tblwrap"><table class="tbl" style="margin:6px 0"><thead><tr><th>Medicine</th><th>Dosage</th><th>Ordered</th><th>Issued</th><th>Given</th><th></th><th>Instructions</th><th></th></tr></thead><tbody>' + lines + '</tbody></table></div>'
            : '<p class="sub" style="margin:8px 0">No medicines on this prescription.</p>') +
        '</td></tr>'
    }).join('')
    el.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Medicines</th><th>Lines</th><th>Status</th><th>Written</th><th style="width:100px">Actions</th></tr></thead><tbody>' +
        rows +
      '</tbody></table></div>' +
      '<p class="sub" style="margin-top:8px">One row per prescription for this encounter — click a row to read the whole script and give doses.</p>'
    paintBadges()

    el.querySelectorAll('[data-rx-row]').forEach((row) => {
      row.onclick = (ev) => {
        // The row's own buttons act on the script; they must not toggle it open.
        if (ev.target.closest('button')) return
        const id = row.getAttribute('data-rx-row')
        if (rxExpanded.has(id)) rxExpanded.delete(id)
        else rxExpanded.add(id)
        renderEncRx()
      }
    })
    wireKebabs(el, (rowId, action) => {
      const r = rxScripts.find((x) => x.id === rowId)
      if (!r) return
      if (action === 'print') printScript(r)
      if (action === 'adjust') adjustScript(r)
    })
    wireKebabs(el, (rowId, action) => {
      if (action === 'give') {
        const [rid, lineId] = rowId.split('|')
        const r = rxScripts.find((x) => x.id === rid)
        const l = r && r.items.find((x) => x.line_id === lineId)
        if (r && l) openGiveDoseModal(r, l)
      }
    })
  }

  // The chart-side print: same document the pharmacy would hand the patient.
  function printScript(r) {
    const m = patientMeta(selectedEncounter)
    printDocument('Prescription', prescriptionHtml({
      hospitalName: authStore.getState().activeOrgName,
      patientName: m.name,
      mrn: m.mrn,
      encounterId: r.encounterId,
      scriptId: r.id,
      status: r.status,
      items: r.items,
      prescribedBy: r.prescribedBy,
      prescribedAt: r.raw?.created_at,
    }))
  }

  // Highlight the workflow step the encounter has actually reached.
  function paintFlow(idx) {
    document.querySelectorAll('#enc-flow .fstep').forEach((el, i) => {
      el.classList.toggle('done', idx > i)
      el.classList.toggle('now', idx === i)
    })
  }

  // Action buttons mirror the rules: the encounter write needs
  // `encounter.edit`; the mirrors need their own caps. Buttons the current
  // role cannot use are hidden instead of failing at write time.
  const me = myActiveMembership()
  const canDx = caps.canEdit && can(me, 'diagnosis.create')
  const canRx = caps.canEdit && can(me, 'prescription.create')
  // Giving a dose is a bedside act with its own capability — deliberately NOT
  // chained to encounter.edit, because a nurse records doses but never edits
  // the clinical note.
  const canAdminDose = myAdminCaps().canAdminister
  const labCaps = myLabCaps()
  const canLab = caps.canEdit && labCaps.canOrder
  function hideIfNoCap(id, ok) {
    const el = document.getElementById(id)
    if (el && !ok) el.style.display = 'none'
  }
  hideIfNoCap('dxB', canDx)
  hideIfNoCap('rxB', canRx)
  hideIfNoCap('labB', canLab)
  // The plan has no dedicated capability; it is part of the encounter, so it
  // is gated on `encounter.edit` like the note and status updates.
  hideIfNoCap('planB', caps.canEdit)
  // Billing lives in its own module behind the `billing.invoice` capability, so
  // a doctor without it must not be offered a dead button.
  hideIfNoCap('billB', billingCaps.canInvoice)

  // "Bill item" used to be a bare <a href="#/billing">, which dropped the
  // clinician on an empty billing page and lost the patient. It now hands the
  // patient (and this encounter) to Billing, which opens the New invoice form
  // with both the patient and their saved payer already selected.
  function openBilling() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!billingCaps.canInvoice) { toast('Your role cannot raise invoices — a billing officer must do this.'); return }
    if (!selectedEncounter.patientId) { toast('This encounter is not linked to a patient.'); return }
    const q = new URLSearchParams({
      patient: selectedEncounter.patientId,
      new: '1',
      from: 'enc',
      enc: selectedEncounter.id,
    })
    navigate('/billing?' + q.toString())
  }

  // ---- start a new encounter from the queue page ---------------------------
  // One shared full-page form for EVERY entry point (queue, patient list,
  // patient chart): same fields, same duplicate guard, and it deep-links
  // straight into the new encounter's workspace.
  function openNewEncounter() {
    navigate('/encounters/new')
  }

  function openDiagnosisForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canDx) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    formModal({
      title: 'Add diagnosis',
      submitLabel: 'Save',
      fields: [
        { name: 'diagnosis', label: 'Condition / ICD-11', required: true, full: true, placeholder: 'e.g. Malaria' },
        { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Resolved', 'Chronic'] },
      ],
      onSubmit: async (v) => {
        try {
          await addDiagnosis(selectedEncounter.id, v.diagnosis + ' (' + (v.status || 'Active') + ')')
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Diagnosis added')
        showWsTab('overview')
        reload()
      },
    })
  }

  function openVitalsForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    formModal({
      title: 'Record vitals',
      submitLabel: 'Save vitals',
      fields: [
        { name: 'bp_systolic', label: 'BP systolic', type: 'number', placeholder: '120' },
        { name: 'bp_diastolic', label: 'BP diastolic', type: 'number', placeholder: '80' },
        { name: 'pulse', label: 'Pulse (bpm)', type: 'number', placeholder: '78' },
        { name: 'temp_c', label: 'Temp °C', type: 'number', placeholder: '36.8' },
        { name: 'spo2', label: 'SpO₂ %', type: 'number', placeholder: '98' },
        { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null }
        try {
          await recordEncounterVitals(selectedEncounter.id, {
            bp_systolic: num(v.bp_systolic), bp_diastolic: num(v.bp_diastolic),
            pulse: num(v.pulse), temp_c: num(v.temp_c), spo2: num(v.spo2), note: v.note || '',
          })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Vitals saved')
        showWsTab('overview')
        reload()
      },
    })
  }

  // The catalogue is fetched on first open rather than with the encounter queue:
  // most sessions never prescribe, and it keeps one more org-wide query off the
  // page's critical path.
  async function ensureDrugs() {
    if (drugs) return drugs
    drugs = await listOrgDrugs(activeOrg)
    return drugs
  }

  // The script form itself. `mode` is one of:
  //   new    — this encounter has no open prescription yet
  //   append — a script is open; these lines are added to that list
  //   adjust — a script is open; it is rewritten in place (issued lines locked)
  function openScriptForm(catalogue, mode, script) {
    const adjusting = mode === 'adjust'
    openPrescriptionModal({
      drugs: catalogue,
      title: adjusting ? 'Adjust prescription' : 'New prescription',
      submitLabel: adjusting ? 'Save changes' : 'Prescribe',
      hint: adjusting
        ? 'Edit this script. Medicines the pharmacy has already issued are locked and stay on the prescription.'
        : (mode === 'append'
          ? 'These medicines will be added to the prescription already open for this encounter.'
          : 'One prescription, many medicines — add every drug for this visit and send them in one go.'),
      initialLines: adjusting
        ? (script?.items || []).map((l) => ({
          line_id: l.line_id,
          drug_id: l.drug_id || '',
          sku: l.sku || '',
          unit: l.unit || '',
          medicine: l.medicine || '',
          dosage: l.dosage || '',
          qty: l.quantity === '' || l.quantity == null ? '' : String(l.quantity),
          instructions: l.instructions || '',
          external: !!l.external,
          dispensed_qty: l.dispensed_qty,
        }))
        : [],
      onSubmit: async (lines) => {
        let rxResult = null
        try {
          if (adjusting) {
            await updateRequestItems(script.id, lines)
            await setEncounterPrescription(selectedEncounter.id, lines)
          } else {
            rxResult = await addPrescriptions(selectedEncounter.id, lines)
          }
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        const n = lines.length
        const plural = n === 1 ? '' : 's'
        toast(adjusting
          ? 'Prescription updated — ' + n + ' medicine' + plural
          : (mode === 'append'
            ? n + ' medicine' + plural + ' added to the open prescription'
            : (rxResult?.pendingSync
              ? 'Prescription saved — will reach the pharmacy when the connection allows'
              : 'Prescription sent to the pharmacy queue — ' + n + ' medicine' + plural)))
        showWsTab('rx')
        reload()
        loadEncRx(true)
      },
    })
  }

  // Re-open the encounter's open script as an editable form.
  async function adjustScript(script) {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canRx) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    let catalogue = []
    try {
      catalogue = await ensureDrugs()
    } catch (e) {
      toast('Could not load the pharmacy catalogue: ' + friendlyWriteError(e))
      return
    }
    openScriptForm(catalogue, 'adjust', script)
  }

  // A prescription belongs to one patient and one encounter, so one is held open
  // at a time. When a script is already open the clinician is asked which they
  // meant — extend the list, or fix the last one — instead of a rival order
  // quietly starting that the pharmacist would have to guess between.
  async function openMedicineForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canRx) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    let catalogue = []
    try {
      catalogue = await ensureDrugs()
    } catch (e) {
      toast('Could not load the pharmacy catalogue: ' + friendlyWriteError(e))
      return
    }
    let existing = null
    if (selectedEncounter.patientId) {
      try {
        existing = await findOpenRequest({ patientId: selectedEncounter.patientId, encounterId: selectedEncounter.id })
      } catch (e) {
        console.warn('[consultations] open-script lookup failed:', e?.message)
      }
    }
    if (!existing) { openScriptForm(catalogue, 'new'); return }

    const n = existing.lineCount
    openModal('Prescription for this encounter',
      '<p class="sub" style="margin:0 0 12px">This encounter already has a prescription — <strong>' +
        esc(n + ' medicine' + (n === 1 ? '' : 's')) + '</strong> · ' + statusBadge(existing.status) +
        '. Add more medicines to the list, or adjust the one already written.</p>' +
      '<div class="mrow">' +
        '<button class="btn ghost" data-close>Cancel</button>' +
        '<button class="btn ghost" id="rxAdjustB">Adjust the last one</button>' +
        '<button class="btn" id="rxAppendB">+ Add to the list</button>' +
      '</div>')
    const appendB = document.getElementById('rxAppendB')
    if (appendB) appendB.onclick = () => openScriptForm(catalogue, 'append', existing)
    const adjustB = document.getElementById('rxAdjustB')
    if (adjustB) adjustB.onclick = () => openScriptForm(catalogue, 'adjust', existing)
  }

  function openPlanForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!caps.canEdit) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    // The plan has no capability of its own — it is part of the encounter, so
    // it shares `encounter.edit`. Pre-fill with the saved plan so this is an
    // edit rather than a blind overwrite.
    formModal({
      title: 'Treatment plan',
      submitLabel: 'Save plan',
      fields: [
        {
          name: 'plan', label: 'Plan', type: 'textarea', full: true, required: true,
          value: selectedEncounter.treatmentPlan || '',
          placeholder: 'Investigations, treatment, follow-up, referrals…',
        },
      ],
      onSubmit: async (v) => {
        if (!v.plan) throw new Error('Plan cannot be empty.')
        try {
          await addTreatmentPlan(selectedEncounter.id, v.plan)
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Plan saved')
        showWsTab('plan')
        reload()
      },
    })
  }

  function openLabOrderForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canLab) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    // Order entry moved to the full-page LIMS form, which also snapshots the
    // order onto this encounter once placed.
    window.location.hash = '#/laboratory/new?patient=' + encodeURIComponent(selectedEncounter.patientId) +
      '&encounter=' + encodeURIComponent(selectedEncounter.id)
  }

  // Refresh is the one action that closes the open encounter — a full re-read
  // may no longer contain it.
  document.getElementById('refreshBtn').onclick = () => { selectedEncounter = null; reload() }
  document.getElementById('newEncB').onclick = openNewEncounter
  document.getElementById('vitalsB').onclick = openVitalsForm
  document.getElementById('dxB').onclick = openDiagnosisForm
  document.getElementById('rxB').onclick = openMedicineForm
  document.getElementById('labB').onclick = openLabOrderForm
  document.getElementById('planB').onclick = openPlanForm
  document.getElementById('billB').onclick = openBilling

  // Admitting hands the patient AND this encounter to the Admissions page, which
  // owns the single admit form. Deep-linking instead of duplicating the form
  // here means the bed-full and double-admission checks cannot drift between two
  // copies of the same UI.
  const admitFromEncB = document.getElementById('admitFromEncB')
  if (admitFromEncB) admitFromEncB.onclick = () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!selectedEncounter.patientId) { toast('This encounter is not linked to a patient.'); return }
    if (patientBed(selectedEncounter)) { toast('This patient already holds a bed — discharge them first.'); return }
    const q = new URLSearchParams({ enc: selectedEncounter.id })
    navigate('/admissions/new?' + q.toString())
  }
  const advB = document.getElementById('advB')
  if (advB) advB.onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    const idx = STATUS_FLOW.findIndex((s) => s.key === selectedEncounter.status)
    const nextIdx = idx < 0 ? 0 : idx + 1
    // `closed` is terminal; an unknown status (legacy `Open`) is advanced into
    // the flow at its first step rather than dead-ending.
    if (!STATUS_FLOW[nextIdx] || selectedEncounter.status === 'closed') { toast('Encounter is already at the final step'); return }
    const next = STATUS_FLOW[nextIdx].key
    try {
      await updateEncounterStatus(selectedEncounter.id, next)
      toast('Status → ' + STATUS_FLOW[nextIdx].label)
      reload()
    } catch (e) { toast(friendlyWriteError(e, 'Status update failed')) }
  }
  document.getElementById('saveNoteB').onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    const noteEl = document.getElementById('enc-note')
    try {
      await updateEncounterNote(selectedEncounter.id, noteEl ? noteEl.value : '')
      noteDirty = false
      const st = document.getElementById('noteState')
      if (st) st.textContent = 'Saved'
      toast('Note saved')
      reload()
    } catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
  }
  const noteEl0 = document.getElementById('enc-note')
  if (noteEl0) noteEl0.addEventListener('input', () => {
    noteDirty = true
    const st = document.getElementById('noteState')
    if (st) st.textContent = 'Unsaved changes'
  })
  const qSearch = document.getElementById('qSearch')
  if (qSearch) {
    let qDebounce
    qSearch.addEventListener('input', () => {
      clearTimeout(qDebounce)
      qDebounce = setTimeout(() => {
        const cb = document.getElementById('qClear')
        if (cb) cb.hidden = !qSearch.value.trim()
        renderQueue()
      }, 500)
    })
    const qClear = document.getElementById('qClear')
    if (qClear) qClear.onclick = () => { qSearch.value = ''; qClear.hidden = true; renderQueue() }
  }
  const qStatus = document.getElementById('qStatus')
  if (qStatus) qStatus.addEventListener('change', renderQueue)
  const closeB = document.getElementById('closeEncB')
  if (closeB) closeB.onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!window.confirm('Close this encounter? A closed encounter cannot be reopened.')) return
    try {
      await updateEncounterStatus(selectedEncounter.id, 'closed')
      toast('Encounter closed')
      reload()
    } catch (e) { toast(friendlyWriteError(e, 'Close failed')) }
  }
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  // Live updates for the encounter queue and the admissions join (bed badges).
  // The patient name/demographics join stays one-shot (the registry is never
  // live); a brand-new patient's name may only appear after reload.
  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    // The live feed only ever knows about the newest slice of the queue. Once
    // the user has scrolled past it, leave the accumulated list alone rather
    // than truncating it back to one chunk.
    if (cursor != null) return
    unsubs.push(
      subscribeOrgEncounters(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(encounters.map((e) => e.id))
          encounters = rows.filter((e) => !seen.has(e.id)).concat(encounters)
          refreshSelectedEncounter()
          renderQueue()
          renderWorkspace()
        },
        (e) => {
          console.warn('[consultations] live update failed; refreshing once:', e?.message || e)
          listOrgEncountersPage(watchedOrg)
            .then((r) => {
              if (cursor != null) return
              const seen = new Set(encounters.map((e) => e.id))
              encounters = r.rows.filter((e) => !seen.has(e.id)).concat(encounters)
              refreshSelectedEncounter()
              renderQueue()
              renderWorkspace()
            })
            .catch(() => {})
        }),
      subscribeOrgAdmissions(watchedOrg,
        (rows) => {
          indexAdmissions(rows)
          renderQueue()
          renderWorkspace()
        },
        (e) => {
          console.warn('[consultations] live admissions update failed; refreshing once:', e?.message || e)
          listOrgAdmissionsPage(watchedOrg, { pageSize: 100 })
            .then((r) => {
              indexAdmissions(r.rows)
              renderQueue()
              renderWorkspace()
            })
            .catch(() => {})
        }),
    )
  }

  onCleanup(() => {
    teardownListeners()
    if (tick) clearInterval(tick)
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

  // Live "Waited" clock: refresh only the Waited cells every second so the
  // countdown advances without a manual refresh. Self-cleans when navigation
  // replaces the queue table; the router cleanup clears it on navigation too.
  tick = setInterval(() => {
    const tbl = document.getElementById('enc-tbl')
    if (!tbl) { clearInterval(tick); return }
    const shown = visibleEncounters()
    tbl.querySelectorAll('tr.clickable').forEach((r, i) => {
      const e = shown[i]
      if (!e) return
      const td = r.cells[2]
      if (td) td.textContent = waitedFor(e.createdAt, e.status === 'closed' ? e.updatedAt : 0)
    })
  }, 1000)
}
