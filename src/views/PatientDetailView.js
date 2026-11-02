// Patient 360 profile — Firestore reads/writes (offline-first, cached).
// Full rewrite: graceful degradation on permission errors, per-collection try/catch,
// consistent tab patterns, ARIA keyboard navigation, URL hash sync, skeletons,
// abort controllers, WCAG 2.1 AA.
import { authStore } from '../store/authStore.js'
import { shell, setPage, skeletonCard, statusBadge, formModal, toast, closeModal, openModal, wireToast } from '../components/shell.js'
import { esc } from '../utils/sanitize.js'
import { fmtDate } from '../utils/format.js'
import { emptyRow } from '../data/mockData.js'
import { can } from '../features/admin/roles.js'
import { myActiveMembership, getClinicalStaff } from '../services/authService.js'
import { payerOptions } from '../services/payerService.js'
import { listPatientInvoices } from '../services/billingService.js'
import { naira } from '../utils/format.js'
import {
  getPatient, updatePatient, listPatientDocs, createPatientDoc, findOpenEncounterForPatient,
  myPatientCaps, friendlyPatientError, formatPhone, getAllAllergiesFromDB,
} from '../services/patientService.js'
import { getPatientPhotoMeta, getPatientPhotoBlob, upsertPatientPhoto, removePatientPhoto, compressImage } from '../services/patientPhotoService.js'
import {
  createAdmission, dischargeAdmission, listOrgWards, validateAdmissionInput, normalizeAdmission,
  ADMISSION_TYPES,
} from '../services/admissionService.js'
import { listOrgDrugs, requestMedicationLines, updateRequestItems } from '../services/pharmacyService.js'
import { listPatientAdministrations } from '../services/medicationAdminService.js'
import { openPrescriptionModal } from '../features/pharmacy/prescriptionModal.js'
import * as R from '../features/pharmacy/requests.js'
import * as A from '../features/pharmacy/administration.js'
import { printDocument } from '../lib/print.js'
import { prescriptionHtml } from '../lib/prescriptionPrint.js'
import { enqueue } from '../services/clinicalOutbox.js'
import { ENCOUNTER_STATUS_FLOW_META } from '../features/encounters/domain.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { staffLabel } from '../lib/staffName.js'
import { onCleanup } from '../lib/lifecycle.js'
import { parseAllergyString, DEFAULT_ALLERGY_SUGGESTIONS } from '../components/AllergyTagInput.js'
import { db, doc, updateDoc, serverTimestamp } from '../firebase.js'
import { confirmDelete } from './deleteUi.js'
import {
  canDeleteRecords, deleteEncounter, deletePatientRow, deleteMedicationRequest,
  deletePatientDocument, deleteAdmission, deleteLabOrder,
} from '../services/deleteService.js'
import { normalizeLabItems, formatItemResultText, ITEM_STATUS } from '../features/labs/domain.js'
import { planHtmlForDisplay } from '../features/encounters/planRichText.js'

/** @typedef {{ id: string, label: string, coll?: string|null }} TabDef */

const TAB = {
  DASHBOARD: 'dashboard',
  PERSONAL: 'personal',
  BLOOD: 'blood',
  KIN: 'kin',
  ENCOUNTERS: 'encounters',
  VITALS: 'vitals',
  DIAGNOSES: 'diagnoses',
  MEDICATIONS: 'medications',
  LABS: 'labs',
  ADMISSIONS: 'admissions',
  DOCUMENTS: 'documents',
}

const COLL = {
  VITALS: 'vitals',
  ENCOUNTERS: 'encounters',
  DIAGNOSES: 'diagnoses',
  MEDS: 'medication_requests',
  LABS: 'lab_orders',
  ADMISSIONS: 'admissions',
  DOCUMENTS: 'documents',
  DOSES: 'medication_administrations',
  CONSENTS: 'patient_consents',
}

const CAP = {
  DEMOGRAPHICS: 'patient.demographics.update',
  VITALS: 'vitals.create',
  DX: 'diagnosis.create',
  RX: 'prescription.create',
  ENCOUNTER: 'encounter.create',
  ENCOUNTER_EDIT: 'encounter.edit',
  ADMIT: 'beds.manage',
  DOCS: 'documents.upload',
  BILL: 'billing.invoice',
  DISPENSE: 'prescription.dispense',
  ADMINISTER: 'medication.administer',
  LAB_ORDER: 'lab.order',
}

const TABS = /** @type {TabDef[]} */ ([
  { id: TAB.DASHBOARD, label: 'Dashboard' },
  { id: TAB.PERSONAL, label: 'Personal Data' },
  { id: TAB.BLOOD, label: 'Blood & Allergies' },
  { id: TAB.KIN, label: 'Next of Kin' },
  { id: TAB.ENCOUNTERS, label: 'Encounters', coll: COLL.ENCOUNTERS },
  { id: TAB.VITALS, label: 'Vitals', coll: COLL.VITALS },
  { id: TAB.DIAGNOSES, label: 'Diagnoses', coll: COLL.DIAGNOSES },
  { id: TAB.MEDICATIONS, label: 'Medications', coll: COLL.MEDS },
  { id: TAB.LABS, label: 'Labs', coll: COLL.LABS },
  { id: TAB.ADMISSIONS, label: 'Admissions', coll: COLL.ADMISSIONS },
  { id: TAB.DOCUMENTS, label: 'Documents', coll: COLL.DOCUMENTS },
])

const BLOOD_GROUPS = [{ value: '', label: 'Not set' }, 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
const GENOTYPES = [{ value: '', label: 'Not set' }, 'AA', 'AS', 'SS', 'AC', 'SC', 'CC']
const DX_STATUSES = ['Active', 'Resolved', 'Chronic']
const FEED_FILTERS = [
  { value: 'all', label: 'All Clinical Events' },
  { value: 'encounter', label: 'Encounters' },
  { value: 'vitals', label: 'Vitals/BP' },
  { value: 'diagnosis', label: 'Diagnoses' },
  { value: 'medication', label: 'Medications' },
  { value: 'dose', label: 'Doses given' },
  { value: 'lab', label: 'Lab Orders/Results' },
  { value: 'admission', label: 'Admissions' },
  { value: 'document', label: 'Documents' },
]
const ICD11_COMMON = [
  { code: '1F40', label: 'Malaria due to Plasmodium falciparum' },
  { code: '1A00', label: 'Cholera' },
  { code: '1A07', label: 'Typhoid fever' },
  { code: 'CA40', label: 'Pneumonia' },
  { code: 'CA23', label: 'Asthma' },
  { code: 'BA00', label: 'Essential hypertension' },
  { code: '5A11', label: 'Type 2 diabetes mellitus' },
  { code: '5A10', label: 'Type 1 diabetes mellitus' },
  { code: 'MD11.0', label: 'Acute upper respiratory infection' },
  { code: 'ME05', label: 'Fever of other or unknown origin' },
  { code: 'MD81', label: 'Abdominal pain' },
  { code: 'GA31', label: 'Urinary tract infection' },
  { code: 'KA21', label: 'Preterm newborn' },
  { code: 'JA00', label: 'Haemorrhage in early pregnancy' },
  { code: 'DA90', label: 'Gastroenteritis or colitis' },
  { code: '1C12', label: 'Tuberculosis' },
  { code: '1C62', label: 'HIV disease' },
  { code: 'CA81', label: 'Sickle cell disorders' },
  { code: '8A80', label: 'Migraine' },
  { code: 'FA80', label: 'Osteoarthritis' },
  { code: 'EE40', label: 'Dermatitis or eczema' },
  { code: 'MB23', label: 'Anaemia' },
  { code: 'BD10', label: 'Heart failure' },
  { code: 'BA41', label: 'Angina pectoris' },
  { code: 'CA07', label: 'Acute nasopharyngitis' },
  { code: 'MD90', label: 'Headache' },
  { code: 'MG50', label: 'Seizure' },
  { code: 'NE80', label: 'Injury of unspecified body region' },
  { code: 'QA00', label: 'Antenatal care' },
  { code: 'QC90', label: 'Immunization' },
]

const ERR = {
  PERMISSION: 'permission',
  OFFLINE: 'offline',
  INDEX: 'index',
  OTHER: 'other',
}

/** @param {*} t */
function ms(t) {
  return t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0)
}
/** @param {*} t */
function when(t) {
  const m = ms(t)
  return m ? new Date(m).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}
/** @param {*} v @param {string} [fallback] */
function s(v, fallback = '—') {
  const t = String(v == null ? '' : v).trim()
  return t || fallback
}
/** @param {*} v @param {string} [fallback] */
function who(v, fallback = '—') {
  return s(staffLabel(v), fallback)
}
/** @param {*} v @returns {number|null} */
function num(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}
function bmi(weightKg, heightCm) {
  const weight = Number(weightKg)
  const height = Number(heightCm)
  return Number.isFinite(weight) && weight > 0 && Number.isFinite(height) && height > 0
    ? Number((weight / ((height / 100) ** 2)).toFixed(1))
    : null
}
/** @param {string} [name] */
function tabDef(name) {
  return TABS.find((t) => t.id === name) || TABS[0]
}
/** @param {unknown} e @returns {{ kind: string, message: string }} */
function classifyError(e) {
  const code = (e && typeof e === 'object' && 'code' in e) ? String(e.code || '') : ''
  const raw = (e && typeof e === 'object' && 'message' in e) ? String(e.message || '') : String(e || '')
  const message = friendlyPatientError(e)
  if (code === 'permission-denied' || /permission|denied|not allowed|allow/i.test(raw + message)) {
    return { kind: ERR.PERMISSION, message: "You don't have permission to view this" }
  }
  if (code === 'unavailable' || /offline|network/i.test(raw + message)) {
    return { kind: ERR.OFFLINE, message: 'Offline — showing cached data' }
  }
  if (code === 'failed-precondition' || /index/i.test(raw + message)) {
    return { kind: ERR.INDEX, message: 'Index needed — open the browser console link to create it, then retry.' }
  }
  return { kind: ERR.OTHER, message }
}
/** @param {string|null|undefined} err */
function classifyMessage(err) {
  if (!err) return null
  return classifyError({ message: err })
}
/** @param {string} message @param {string} [kind] */
function noticeHtml(message, kind = ERR.OTHER) {
  const assertive = kind === ERR.PERMISSION || kind === ERR.OTHER
  const cls = kind === ERR.PERMISSION ? 'pd-perm' : kind === ERR.OFFLINE ? 'pd-offline' : 'pd-notice'
  return '<div class="' + cls + '" role="status" aria-live="' + (assertive ? 'assertive' : 'polite') + '">' + esc(message) + '</div>'
}
/** @param {{ icon?: string, title: string, body: string, actionHtml?: string }} o */
function emptyState({ icon = '◌', title, body, actionHtml = '' }) {
  return '<div class="pd-empty" role="status">' +
    '<div class="pd-empty-icon" aria-hidden="true">' + icon + '</div>' +
    '<p><strong>' + esc(title) + '</strong></p>' +
    '<p class="sub">' + esc(body) + '</p>' +
    (actionHtml || '') +
    '</div>'
}
/** @param {{ caption: string, cols: string[], rows: object[], htmlRow: Function }} o */
function dataTable({ caption, cols, rows, htmlRow }) {
  return '<div class="tblwrap"><table class="tbl">' +
    '<caption class="pd-caption">' + esc(caption) + '</caption>' +
    '<thead><tr>' + cols.map((c) => '<th scope="col">' + esc(c) + '</th>').join('') + '</tr></thead>' +
    '<tbody>' + (rows.length ? rows.map(htmlRow).join('') : emptyRow(cols.length)) + '</tbody></table></div>'
}
/** @param {string} inner @param {string} [extra] */
function toolbar(inner, extra = '') {
  return '<div class="pd-toolbar">' + inner + extra + '</div>'
}
/** @param {string} [status] */
function encLabel(status) {
  const map = {
    arrived: 'Arrived', 'vitals-taken': 'Vitals Taken', 'in-consultation': 'In Consultation',
    diagnosed: 'Diagnosed', planned: 'Plan Set', closed: 'Closed', open: 'Open',
    active: 'Active', admitted: 'Admitted', discharged: 'Discharged',
  }
  return map[status?.toLowerCase?.()] || s(status, '—')
}
/** @param {string} [status] */
function encBadge(status) {
  const tones = {
    arrived: 'warn', 'vitals-taken': 'info', 'in-consultation': 'info',
    diagnosed: 'info', planned: 'ok', closed: 'ok',
  }
  return '<span class="pill ' + (tones[status?.toLowerCase?.()] || '') + '">' + esc(encLabel(status)) + '</span>'
}
/** @param {string} [status] */
function patientStatusBadge(status) {
  const raw = String(status || 'Active')
  const key = raw.toLowerCase()
  const tone = key === 'active' ? 'ok' : key === 'merged' ? 'info' : key === 'inactive' ? 'warn' : ''
  const label = key === 'active' ? 'Active' : key === 'merged' ? 'Merged' : key === 'inactive' ? 'Inactive' : raw
  return '<span class="pill pstatus ' + tone + '">' + esc(label) + '</span>'
}
/** @param {*} p @returns {string[]} */
function allergyList(p) {
  if (Array.isArray(p.allergy)) return p.allergy.map((a) => String(a).trim()).filter(Boolean)
  if (p.allergy) {
    return String(p.allergy).split(/[,;]/).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'none known')
  }
  return []
}
/** @param {object} order */
function labResultSnippet(order) {
  const stage = String(order.stage || order.status || '').toLowerCase()
  const items = normalizeLabItems(order)
  const bits = items.filter((it) => {
    const itemStage = String(it.status || '').toLowerCase()
    return itemStage === ITEM_STATUS.RELEASED || itemStage === ITEM_STATUS.VALIDATED ||
      stage === 'verified' || stage === ITEM_STATUS.RELEASED || stage === ITEM_STATUS.VALIDATED
  }).map((it) => {
    const result = formatItemResultText(it)
    return result ? it.test_name + ': ' + result : ''
  }).filter(Boolean)
  return bits.slice(0, 2).join(' · ')
}
/** @param {number[]} values @param {string} label @param {unknown[]} timestamps */
function sparkline(values, label, timestamps = []) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n))
  if (nums.length < 2) return '<p class="sub">Not enough ' + esc(label) + ' readings for a chart.</p>'
  const w = 360, h = 88, pad = 8
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const pts = nums.map((n, i) => {
    const x = pad + (i / (nums.length - 1)) * (w - pad * 2)
    const y = h - pad - ((n - min) / span) * (h - pad * 2)
    return x.toFixed(1) + ',' + y.toFixed(1)
  }).join(' ')
  return '<svg class="pd-spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + ' trend">' +
    '<polyline class="pd-spark-line" fill="none" points="' + pts + '" /></svg>' +
    '<div class="pd-spark-range"><span>Min ' + esc(String(min)) + '</span><span>Max ' + esc(String(max)) + '</span></div>' +
    (timestamps.length > 1 ? '<div class="pd-spark-range"><span>' + esc(fmtDate(timestamps[0])) + '</span><span>' + esc(fmtDate(timestamps[timestamps.length - 1])) + '</span></div>' : '')
}
/** @param {string} pid */
function tabFromLocation(pid) {
  const raw = String(window.location.hash || '').replace(/^#/, '')
  const qi = raw.indexOf('?')
  const path = qi === -1 ? raw : raw.slice(0, qi)
  if (path !== '/patients/' + pid) return TAB.DASHBOARD
  const tab = qi === -1 ? '' : (new URLSearchParams(raw.slice(qi + 1)).get('tab') || '')
  return TABS.some((t) => t.id === tab) ? tab : TAB.DASHBOARD
}
/** @param {HTMLElement|null} btn @param {() => Promise<void>|void} fn */
function withBusy(btn, fn) {
  return async () => {
    if (btn && btn.disabled) return
    if (btn) {
      btn.disabled = true
      btn.classList.add('is-busy')
      btn.setAttribute('aria-busy', 'true')
    }
    try {
      await fn()
    } finally {
      if (btn) {
        btn.disabled = false
        btn.classList.remove('is-busy')
        btn.removeAttribute('aria-busy')
      }
    }
  }
}
/** @param {object} card */
function renderVitalCard(card) {
  return '<div class="vital-card">' +
    '<div class="vital-label">' + esc(card.label) + '</div>' +
    '<div class="vital-value">' + esc(card.value) + '</div>' +
    (card.timestamp ? '<div class="pd-vital-time">' + esc(card.timestamp) + '</div>' : '') +
    '</div>'
}
/** @param {object} e @param {number} i */
function renderFeedItem(e, i) {
  return '<article class="feed-item is-clickable" tabindex="0" role="button" data-feed-idx="' + i + '" data-type="' + esc(e.type) + '" data-feed-id="' + esc(e.id || '') + '" aria-label="Open ' + esc(e.primary) + '">' +
    '<div class="feed-icon" aria-hidden="true">' + e.icon + '</div>' +
    '<div class="feed-content">' +
    '<div class="feed-primary">' + esc(e.primary) + '</div>' +
    '<div class="feed-secondary">' + esc(e.secondary) + '</div>' +
    '</div>' +
    '<div class="feed-meta">' +
    '<span>' + esc(when(e.timestamp)) + '</span>' +
    (e.clinician ? '<span>' + esc(e.clinician) + '</span>' : '') +
    (e.status ? '<span class="pill">' + esc(encLabel(e.status)) + '</span>' : '') +
    '</div></article>'
}
/** @param {{ title: string, count: number, listHtml: string, addId?: string, canAdd?: boolean }} o */
function renderSummaryCard({ title, count, listHtml, addId, canAdd }) {
  const add = canAdd && addId
    ? '<button type="button" class="btn ghost sm" id="' + addId + '" title="Add ' + esc(title) + '">+ Add</button>'
    : ''
  return '<div class="summary-card">' +
    '<div class="summary-header"><div class="summary-title">' + title +
    ' <span class="summary-count">' + count + '</span></div>' + add + '</div>' +
    '<div class="summary-list">' + listHtml + '</div></div>'
}

export async function PatientDetailView(app, params = {}) {
  const pid = params.id
  const me = myActiveMembership()
  const caps = myPatientCaps()
  const canVitals = can(me, CAP.VITALS)
  const canDx = can(me, CAP.DX)
  const canRx = can(me, CAP.RX)
  const canEncounter = can(me, CAP.ENCOUNTER)
  const canEncEdit = can(me, CAP.ENCOUNTER_EDIT)
  const canAdmit = can(me, CAP.ADMIT)
  const canDocs = can(me, CAP.DOCS)
  const canBill = can(me, CAP.BILL)
  const canDispense = can(me, CAP.DISPENSE)
  const canLabOrder = can(me, CAP.LAB_ORDER)
  const canDelete = canDeleteRecords()

  let p = null
  let loadError = null
  const backActions = '<a class="btn ghost" href="#/patients">← All patients</a>'

  shell(app, {
    active: '/patients',
    title: 'Patient',
    subtitle: 'Loading record…',
    actions: backActions,
    body: skeletonCard(5),
  })

  const live = document.getElementById('toast')
  if (live) {
    live.setAttribute('aria-live', 'polite')
    live.setAttribute('role', 'status')
  }

  try {
    p = await getPatient(pid)
  } catch (e) {
    loadError = friendlyPatientError(e)
  }

  if (loadError) {
    setPage({
      title: 'Patient',
      subtitle: 'Could not load record',
      actions: backActions,
      body: '<div class="card">' + noticeHtml(loadError, classifyError({ message: loadError }).kind) +
        '<button class="btn" id="rBtn">Retry</button></div>',
    })
    const rb = document.getElementById('rBtn')
    if (rb) rb.onclick = () => PatientDetailView(app, params)
    return
  }
  if (!p) {
    setPage({
      title: 'Patient not found',
      subtitle: 'No record matches ' + pid,
      actions: backActions,
      body: '<div class="card"><p class="sub">This patient record does not exist, or it belongs to a different hospital.</p></div>',
    })
    return
  }

  let photoMeta = null
  let photoUrl = null
  let lastVisit = null
  let payerOpts = [{ value: p.payer || 'Self-pay', label: p.payer || 'Self-pay' }]
  let activeTab = params.tab && TABS.some((t) => t.id === params.tab) ? params.tab : tabFromLocation(pid)
  let dashboardFilter = sessionStorage.getItem('pd:feed:' + pid) || 'all'
  let vitalsMode = sessionStorage.getItem('pd:vitalsView:' + pid) || 'table'
  let feedLimit = 30
  let historyLimit = 50
  let tabAbort = null
  let renderSeq = 0
  const loadCache = {}
  let drugsCache = null
  let allergySuggestions = [...DEFAULT_ALLERGY_SUGGESTIONS]

  const ini = (p.name || '').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  const ageText = p.age !== '' ? p.age + 'y' : ''

  function subtitleText() {
    return [p.mrn, ageText, p.sex, lastVisit ? 'last seen ' + fmtDate(lastVisit) : '']
      .filter(Boolean).join(' · ')
  }

  payerOptions(p.payer).then((opts) => {
    if (opts && opts.length) payerOpts = opts
  }).catch(() => {})
  getAllAllergiesFromDB().then((fromDB) => {
    const seen = new Set()
    allergySuggestions = []
    for (const x of [...fromDB, ...DEFAULT_ALLERGY_SUGGESTIONS]) {
      const key = String(x).trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      allergySuggestions.push(String(x).trim())
    }
  }).catch(() => {})

  ;(async () => {
    try {
      photoMeta = await getPatientPhotoMeta(pid).catch(() => null)
      if (photoMeta) {
        const blob = await getPatientPhotoBlob(pid).catch(() => null)
        if (blob) photoUrl = URL.createObjectURL(blob)
      }
      const enc = await fetchCollection(COLL.ENCOUNTERS, { limitN: 1 })
      const latest = (enc.rows || [])[0]
      if (latest) lastVisit = latest.created_at
    } catch { /* non-fatal */ }
    refreshHeaderPhoto()
    const sp = document.querySelector('.top-title p')
    if (sp) sp.textContent = subtitleText()
  })()

  function knownAllergies() {
    return allergyList(p)
  }

  function patientFields(overrides = {}) {
    return {
      surname: p.surname,
      given_names: p.given_names,
      phone: p.phone_key || p.phone,
      sex: p.sex,
      dob: p.dob,
      address: p.address,
      blood_group: p.blood_group,
      genotype: p.genotype,
      payer: p.payer,
      allergy: Array.isArray(p.allergy) ? p.allergy : parseAllergyString(p.allergy),
      occupation: p.occupation,
      next_of_kin_first_name: p.next_of_kin_first_name,
      next_of_kin_last_name: p.next_of_kin_last_name,
      next_of_kin_phone: p.next_of_kin_phone_key || p.next_of_kin_phone,
      next_of_kin_address: p.next_of_kin_address,
      ...overrides,
    }
  }

  async function reloadPatient() {
    try {
      const next = await getPatient(pid)
      if (next) p = next
    } catch { /* keep current */ }
    renderHeader()
    wireTabs()
    await render(activeTab, { force: false })
  }

  function setTabInHash(tabId) {
    const path = '/patients/' + encodeURIComponent(pid)
    const q = tabId && tabId !== TAB.DASHBOARD ? '?tab=' + encodeURIComponent(tabId) : ''
    const next = '#' + path + q
    if (window.location.hash !== next) {
      history.replaceState(null, '', window.location.pathname + window.location.search + next)
    }
  }

  function tabsNavHtml() {
    return '<nav class="tabs" id="ptabs" role="tablist" aria-label="Patient record sections">' +
      TABS.map((t) => {
        const on = t.id === activeTab
        return '<button type="button" role="tab" id="tab-' + t.id + '" data-t="' + t.id + '"' +
          ' aria-selected="' + (on ? 'true' : 'false') + '"' +
          ' aria-controls="ppane" tabindex="' + (on ? '0' : '-1') + '"' +
          ' class="' + (on ? 'on' : '') + '">' + esc(t.label) + '</button>'
      }).join('') +
      '</nav>'
  }

  function headerBodyHtml() {
    const allergies = knownAllergies()
    const hasAllergy = allergies.length > 0
    const photoHtml = photoUrl
      ? '<span id="pavatarbox" class="pavatar-wrap"><img src="' + photoUrl + '" alt="Photo of ' + esc(p.name) + '" class="pavatar photo" /></span>'
      : '<span id="pavatarbox" class="pavatar-wrap pavatar" aria-hidden="true">' + esc(ini) + '</span>'
    const photoActions = (caps.canUpdate || caps.canCreate)
      ? '<div class="phead-actions">' +
        '<button type="button" class="btn ghost sm" id="photoUploadBtn" title="Upload photo">📷</button>' +
        (photoUrl ? '<button type="button" class="btn ghost sm" id="photoRemoveBtn" title="Remove photo">✕</button>' : '') +
        '</div>'
      : ''
    const payerHtml = caps.canUpdate
      ? '<select class="input pd-payer" id="payerInline" aria-label="Payer">' +
        payerOpts.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o
          return '<option value="' + esc(opt.value) + '"' + (opt.value === (p.payer || 'Self-pay') ? ' selected' : '') + '>' + esc(opt.label) + '</option>'
        }).join('') + '</select>'
      : '<strong>' + esc(p.payer || 'Self-pay') + '</strong>'
    const banner = hasAllergy
        ? '<div class="allergy" id="allergyBanner" role="alert">' +
          '<span aria-hidden="true">⚠</span> Allergy: <strong>' + esc(allergies.join(', ')) + '</strong> — always confirm before prescribing' +
          '</div>'
        : '<div class="allergy allergy-none">Allergy status not recorded — confirm before prescribing</div>'
    return '<div class="phead">' + photoHtml + photoActions +
      '<div class="phead-main"><h2>' + esc(p.name) + ' ' + patientStatusBadge(p.status) + '</h2>' +
      '<div class="meta">DOB ' + esc(p.dob || 'not recorded') + ' · ' + esc(formatPhone(p.phone, p.phone_key)) +
      ' · Registered ' + (p.registered ? fmtDate(p.registered) : '—') + '</div>' +
      banner + '</div>' +
      '<div class="phead-side"><div class="kv pd-idkv">' +
      '<div><em>MRN</em><strong>' + esc(p.mrn || '—') + '</strong></div>' +
      '<div><em>Payer</em>' + payerHtml + '</div>' +
      '</div></div></div>' +
      tabsNavHtml() +
      '<div id="ppane" role="tabpanel" aria-labelledby="tab-' + activeTab + '" tabindex="0"></div>'
  }

  function bindHeaderActions() {
    const editBtn = document.getElementById('editBtn')
    if (editBtn) editBtn.onclick = openEdit
    const encBtn = document.getElementById('encBtn')
    if (encBtn) encBtn.onclick = withBusy(encBtn, async () => openEncounter())
    const pu = document.getElementById('photoUploadBtn')
    if (pu) pu.onclick = () => openPhotoUpload()
    const pr = document.getElementById('photoRemoveBtn')
    if (pr) pr.onclick = () => openPhotoRemove()
    const payer = document.getElementById('payerInline')
    if (payer) {
      payer.onchange = async () => {
        const next = payer.value
        try {
          const result = await updatePatient(pid, patientFields({ payer: next, force: true }))
          if (result && result.warning) {
            toast(result.warning)
            payer.value = p.payer || 'Self-pay'
            return
          }
          p.payer = next
          toast('Payer updated')
        } catch (e) {
          toast(friendlyPatientError(e))
          payer.value = p.payer || 'Self-pay'
        }
      }
    }
  }

  function renderHeader() {
    setPage({
      title: p.name,
      subtitle: subtitleText(),
      actions:
        backActions +
        (caps.canUpdate ? '<button type="button" class="btn ghost" id="editBtn">Edit demographics</button>' : '') +
        (canEncounter ? '<button type="button" class="btn" id="encBtn">Start encounter</button>' : ''),
      body: headerBodyHtml(),
    })
    bindHeaderActions()
  }

  function refreshHeaderPhoto() {
    const box = document.getElementById('pavatarbox')
    if (box) {
      if (photoUrl) {
        box.classList.remove('pavatar')
        box.innerHTML = '<img src="' + photoUrl + '" alt="Photo of ' + esc(p.name) + '" class="pavatar photo" />'
      } else {
        box.classList.add('pavatar')
        box.textContent = ini
      }
    }
    const actions = document.querySelector('.phead-actions')
    if (actions) {
      actions.innerHTML = (caps.canUpdate || caps.canCreate)
        ? '<button type="button" class="btn ghost sm" id="photoUploadBtn" title="Upload photo">📷</button>' +
          (photoUrl ? '<button type="button" class="btn ghost sm" id="photoRemoveBtn" title="Remove photo">✕</button>' : '')
        : ''
    }
    const pu = document.getElementById('photoUploadBtn')
    if (pu) pu.onclick = () => openPhotoUpload()
    const pr = document.getElementById('photoRemoveBtn')
    if (pr) pr.onclick = () => openPhotoRemove()
  }

  renderHeader()

  function pane() {
    return document.getElementById('ppane')
  }

  /**
   * @param {string} coll
   * @param {{ limitN?: number }} [opts]
   * @returns {Promise<{ rows: object[], error: string|null, kind: string|null }>}
   */
  async function fetchCollection(coll, opts = {}) {
    try {
      if (coll === COLL.DOSES) {
        const rows = await listPatientAdministrations(pid)
        return { rows: rows || [], error: null, kind: null }
      }
      const res = await listPatientDocs(coll, pid, opts)
      const err = res.error || null
      const info = err ? classifyMessage(err) : null
      return { rows: res.rows || [], error: info ? info.message : null, kind: info ? info.kind : null }
    } catch (e) {
      const info = classifyError(e)
      return { rows: [], error: info.message, kind: info.kind }
    }
  }

  function emptyCollection(error, kind) {
    return { rows: [], error: error || null, kind: kind || null }
  }

  /**
   * @returns {Promise<object>}
   */
  async function loadDashboardData() {
    const keys = [
      ['vitals', COLL.VITALS],
      ['encounters', COLL.ENCOUNTERS],
      ['diagnoses', COLL.DIAGNOSES],
      ['meds', COLL.MEDS],
      ['labs', COLL.LABS],
      ['admissions', COLL.ADMISSIONS],
      ['docs', COLL.DOCUMENTS],
      ['doses', COLL.DOSES],
    ]
    const bag = {}
    // Each fetch is independent — one permission-denied read does not crash the dashboard.
    await Promise.all(keys.map(async ([name, coll]) => {
      bag[name] = await fetchCollection(coll, { limitN: ['vitals', 'encounters'].includes(name) ? null : historyLimit })
    }))
    const vitals = bag.vitals || emptyCollection()
    const allVitals = vitals.rows || []
    const timeline = buildUnifiedTimeline(
      bag.encounters?.rows || [],
      allVitals,
      bag.diagnoses?.rows || [],
      bag.meds?.rows || [],
      bag.labs?.rows || [],
      bag.admissions?.rows || [],
      bag.docs?.rows || [],
      bag.doses?.rows || [],
    )
    const errors = {}
    for (const [name] of keys) {
      if (bag[name]?.error) errors[name] = { message: bag[name].error, kind: bag[name].kind }
    }
    const offline = Object.values(errors).some((x) => x.kind === ERR.OFFLINE)
    return {
      latestVitals: allVitals[0] || null,
      allVitals,
      timeline,
      activeDiagnoses: (bag.diagnoses?.rows || []).filter((d) => (d.status || 'Active') === 'Active'),
      activeMeds: (bag.meds?.rows || []).filter((m) => {
        const script = R.normalizeRequest(m)
        return script.status === 'Dispensed' || script.status === 'Partially dispensed'
      }),
      allergies: knownAllergies(),
      errors,
      offline,
      sections: bag,
    }
  }

  function buildUnifiedTimeline(encounters, vitals, diagnoses, meds, labs, admissions, docs, doses = []) {
    const entries = []
    for (const e of encounters) {
      entries.push({
        type: 'encounter', timestamp: e.created_at, icon: '🏥', id: e.id,
        primary: s(e.encounter_type || e.type || e.reason || 'Encounter'),
        secondary: s(e.reason || e.chief_complaint || 'No reason recorded') + ' · ' + encLabel(e.status),
        status: e.status, clinician: who(e.clinician_name || e.clinician || e.created_by_name), raw: e,
      })
    }
    for (const v of vitals) {
      const bp = (v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—')
      const parts = ['BP ' + bp]
      if (v.pulse) parts.push('P ' + v.pulse)
      if (v.temp_c) parts.push('T ' + v.temp_c + '°C')
      if (v.spo2) parts.push('SpO₂ ' + v.spo2 + '%')
      if (v.rr) parts.push('RR ' + v.rr)
      if (v.weight_kg) parts.push(v.weight_kg + ' kg')
      if (v.height_cm) parts.push(v.height_cm + ' cm')
      entries.push({
        type: 'vitals', timestamp: v.created_at, icon: '📍', id: v.id,
        primary: parts.join('  •  '), secondary: who(v.created_by_name || v.created_by),
        clinician: who(v.created_by_name || v.created_by), raw: v,
      })
    }
    for (const d of diagnoses) {
      entries.push({
        type: 'diagnosis', timestamp: d.created_at, icon: '🩺', id: d.id,
        primary: s(d.condition || d.name || d.icd_code || 'Diagnosis'),
        secondary: (d.icd_code ? '[' + d.icd_code + '] ' : '') + s(d.status, 'Active') + ' · ' + who(d.created_by_name || d.created_by),
        status: d.status, clinician: who(d.created_by_name || d.created_by), raw: d,
      })
    }
    for (const m of meds) {
      const script = R.normalizeRequest(m)
      const names = script.items.map((l) => l.medicine).filter(Boolean).slice(0, 3).join(', ')
      entries.push({
        type: 'medication', timestamp: m.created_at, icon: '💊', id: m.id,
        primary: s(names || m.medicine || m.name || 'Prescription'),
        secondary: s(script.status, 'Requested') + ' · ' + who(m.created_by_name || m.created_by),
        status: script.status, clinician: who(m.created_by_name || m.created_by), raw: m,
      })
    }
    for (const d of doses) {
      const reversed = d.type === 'reversed'
      entries.push({
        type: 'dose', timestamp: d.administered_at || d.created_at, icon: reversed ? '↩' : '💉', id: d.id,
        primary: (reversed ? 'Reversed: ' : 'Given: ') + s(d.medicine) + ' ×' + s(d.qty, '1'),
        secondary: [String(d.route || '').toUpperCase(), s(d.site, ''), s(d.note, '')].filter(Boolean).join(' · ') +
          ' · ' + who(d.administered_by_name || d.administered_by),
        clinician: who(d.administered_by_name || d.administered_by), raw: d,
      })
    }
    for (const l of labs) {
      entries.push({
        type: 'lab', timestamp: l.created_at, icon: '🧪', id: l.id,
        primary: s(l.test || l.test_panel || l.panel || 'Lab order'),
        secondary: s(l.stage || l.status, 'Ordered') + (l.priority ? ' · ' + l.priority : '') + ' · ' + who(l.created_by_name || l.created_by),
        status: l.stage || l.status, clinician: who(l.created_by_name || l.created_by), raw: l,
      })
    }
    for (const raw of admissions) {
      const a = normalizeAdmission(raw)
      entries.push({
        type: 'admission', timestamp: a.admissionDate || a.createdAt, icon: '🛏️', id: a.id,
        primary: s(a.wardName) + ' · ' + s(a.bedNumber),
        secondary: who(a.attendingProvider) + ' · ' + s(a.status === 'discharged' ? 'Discharged' : 'Admitted'),
        status: a.status, clinician: who(a.attendingProvider), raw: a,
      })
    }
    for (const d of docs) {
      entries.push({
        type: 'document', timestamp: d.created_at, icon: '📄', id: d.id,
        primary: s(d.name || d.filename || d.title || 'Document'),
        secondary: s(d.type || d.document_type || d.kind) + ' · ' + who(d.created_by_name || d.created_by),
        clinician: who(d.created_by_name || d.created_by), raw: d,
      })
    }
    entries.sort((a, b) => ms(b.timestamp) - ms(a.timestamp))
    return entries
  }

  function filteredTimeline(d) {
    const all = d.timeline || []
    if (dashboardFilter === 'all') return all
    return all.filter((e) => e.type === dashboardFilter)
  }

  function sectionDenied(d, key) {
    const err = d.errors && d.errors[key]
    if (!err) return ''
    if (err.kind === ERR.PERMISSION) return noticeHtml('No data (insufficient permissions)', ERR.PERMISSION)
    return noticeHtml(err.message, err.kind)
  }

  function skeletonFor(tabId) {
    if (tabId === TAB.DASHBOARD) {
      return '<div class="dashboard-pane pd-skel-dash" aria-busy="true" role="status">' +
        '<div class="vitals-snapshot">' + Array.from({ length: 4 }, () => '<div class="vital-card skel-card"><div class="skel skel-short"></div><div class="skel"></div></div>').join('') + '</div>' +
        '<div class="dashboard-grid"><div class="clinical-summary">' + skeletonCard(4) + '</div><div class="progress-feed">' + skeletonCard(6) + '</div></div></div>'
    }
    return skeletonCard(4)
  }

  function buildDashboardPane() {
    const d = loadCache[TAB.DASHBOARD] || {
      latestVitals: null, allVitals: [], timeline: [], activeDiagnoses: [], activeMeds: [], allergies: [], errors: {},
    }
    const v = d.latestVitals
    const encounterRows = d.sections?.encounters?.rows || []
    const newestEncounter = encounterRows[0] || null
    const encounterError = d.errors?.encounters
    const vitalNotice = sectionDenied(d, 'vitals') || (!d.allVitals?.length ? '<div class="pd-history-note">No vital readings recorded yet.</div>' : '')
    const admissionRows = d.sections?.admissions?.rows || []
    const admissionSampled = admissionRows.length >= historyLimit
    const admissionError = d.errors?.admissions
    const activeStay = admissionRows.map(normalizeAdmission).find((a) => a.status === 'active')
    const vitalCards = v
      ? [
        { label: 'BP · mmHg', value: (v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—'), timestamp: when(v.created_at) },
        { label: 'Pulse', value: s(v.pulse) + ' bpm', timestamp: when(v.created_at) },
        { label: 'Temp', value: s(v.temp_c) + ' °C', timestamp: when(v.created_at) },
        { label: 'SpO₂', value: s(v.spo2) + '%', timestamp: when(v.created_at) },
        ...(v.weight_kg ? [{ label: 'Weight', value: s(v.weight_kg) + ' kg', timestamp: when(v.created_at) }] : []),
        ...(v.height_cm ? [{ label: 'Height', value: s(v.height_cm) + ' cm', timestamp: when(v.created_at) }] : []),
        ...(v.rr ? [{ label: 'Respiratory rate', value: s(v.rr) + ' /min', timestamp: when(v.created_at) }] : []),
        ...(bmi(v.weight_kg, v.height_cm) != null ? [{ label: 'BMI', value: bmi(v.weight_kg, v.height_cm).toFixed(1), timestamp: when(v.created_at) }] : []),
      ]
      : [
        { label: 'BP', value: '—' }, { label: 'Pulse', value: '—' },
        { label: 'Temp', value: '—' }, { label: 'SpO₂', value: '—' },
      ]

    const list = filteredTimeline(d)
    const shown = list.slice(0, feedLimit)
    const timelineHtml = shown.length
      ? shown.map((e, i) => renderFeedItem(e, i)).join('')
      : emptyState({ icon: '📋', title: 'No events yet', body: 'No ' + (dashboardFilter === 'all' ? 'clinical events' : dashboardFilter) + ' recorded yet.' })

    const dxDenied = sectionDenied(d, 'diagnoses')
    const diagnosesHtml = dxDenied || (d.activeDiagnoses.length
      ? d.activeDiagnoses.map((dx) =>
        '<div class="summary-item"><div class="summary-item-main">' +
        '<span class="summary-item-label">' + esc(dx.condition || dx.name || dx.icd_code || 'Diagnosis') + '</span>' +
        '<span class="summary-item-detail">' + (dx.icd_code ? '[' + esc(dx.icd_code) + '] ' : '') +
        esc(dx.status || 'Active') + ' · ' + esc(who(dx.created_by_name || dx.created_by)) + ' · ' + esc(when(dx.created_at)) + '</span></div>' +
        '<span class="pill ok">' + esc(dx.status || 'Active') + '</span></div>').join('')
      : emptyState({ icon: '🩺', title: 'No active diagnoses', body: 'Nothing on the problem list yet.', actionHtml: canDx ? '<button type="button" class="btn ghost sm" id="dashDxAdd">+ Add diagnosis</button>' : '' }))

    const medDenied = sectionDenied(d, 'meds')
    const activeLines = d.activeMeds.flatMap((m) => R.toRequestItems(m).map((l) => ({
      line: l, script: R.normalizeRequest(m), createdBy: staffLabel(m.created_by_name || m.created_by) || '', createdAt: m.created_at,
    })))
    const medsHtml = medDenied || (activeLines.length
      ? activeLines.map(({ line: l, createdBy, createdAt }) => {
        const issued = R.toQty(l.dispensed_qty, 0)
        const owed = R.lineOutstanding(l)
        return '<div class="summary-item"><div class="summary-item-main">' +
          '<span class="summary-item-label">' + esc(l.medicine) + '</span>' +
          '<span class="summary-item-detail">' + esc(l.dosage) + (l.quantity ? ' ×' + l.quantity : '') + ' · ' +
          esc(when(createdAt)) + ' · ' + esc(createdBy) + '</span></div>' +
          '<span class="pill ' + (owed === 0 ? 'ok' : 'warn') + '">' + (owed === 0 ? 'Dispensed' : issued + ' of ' + R.toQty(l.quantity, 0) + ' issued') + '</span></div>'
      }).join('')
      : emptyState({ icon: '💊', title: 'No current medications', body: 'No active prescriptions on this chart.', actionHtml: canRx ? '<button type="button" class="btn ghost sm" id="dashRxAdd">+ New prescription</button>' : '' }))

    const allergiesHtml = d.allergies.length
      ? d.allergies.map((a) => '<span class="allergy-tag-display">' + esc(a) + '</span>').join(' ')
      : '<span class="mut">No allergy information recorded</span>'

    const quick = []
    if (canVitals) quick.push('<button type="button" class="btn" id="dashVitalsBtn">Record vitals</button>')
    if (canDx) quick.push('<button type="button" class="btn ghost" id="dashDxBtn">+ Diagnosis</button>')
    if (canRx) quick.push('<button type="button" class="btn ghost" id="dashRxBtn">+ Prescription</button>')
    if (canAdmit) quick.push('<button type="button" class="btn ghost" id="dashAdmBtn">+ Admission</button>')

    const capped = Object.entries(d.sections || {}).some(([name, section]) =>
      !['vitals', 'encounters', 'doses'].includes(name) && (section.rows || []).length >= historyLimit)
    const hasReadErrors = Object.keys(d.errors || {}).length > 0
    const banner = (d.offline
      ? noticeHtml('Offline — showing cached data', ERR.OFFLINE)
      : hasReadErrors
        ? noticeHtml('Some record types could not be loaded. This overview may be incomplete.', ERR.PERMISSION)
        : '') +
      (capped
        ? '<div class="pd-history-note">The overview samples some record types (up to ' + historyLimit + ' each). Open a history tab for the full list.</div>'
        : '') +
      (d.offline || hasReadErrors
        ? '<button type="button" class="btn ghost sm" data-retry-tab="' + TAB.DASHBOARD + '">Retry</button>'
        : '')

    const contextHtml = '<div class="pd-context-strip">' +
      '<a class="pd-context-card" href="#/patients/' + encodeURIComponent(pid) + '?tab=encounters"><span>Last encounter</span><strong>' +
      (newestEncounter ? esc(when(newestEncounter.created_at)) + ' · ' + esc(s(newestEncounter.encounter_type || newestEncounter.type || newestEncounter.reason, 'Visit')) : (encounterError ? 'History unavailable' : 'No encounter recorded')) + '</strong></a>' +
      (activeStay
        ? '<a class="pd-context-card pd-context-active" href="#/admissions/' + encodeURIComponent(activeStay.id) + '"><span>Current admission</span><strong>' + esc(s(activeStay.wardName)) + ' · Bed ' + esc(s(activeStay.bedNumber)) + '</strong></a>'
        : '<a class="pd-context-card" href="#/patients/' + encodeURIComponent(pid) + '?tab=admissions"><span>Admission history</span><strong>' + (admissionError ? 'History unavailable' : admissionSampled ? 'Review full history for current stay' : 'No active admission') + '</strong></a>') +
      '</div>'

    return '<div class="dashboard-pane">' + banner +
      (d.loadedAt ? '<p class="pd-updated">Overview loaded ' + esc(when(d.loadedAt)) + '</p>' : '') +
      contextHtml +
      vitalNotice +
      '<div class="vitals-snapshot" role="region" aria-label="Latest vitals">' + vitalCards.map(renderVitalCard).join('') + '</div>' +
      '<div class="dashboard-grid">' +
      '<div class="clinical-summary">' +
      renderSummaryCard({ title: '🩺 Active Diagnoses', count: d.activeDiagnoses.length, listHtml: diagnosesHtml + '<a class="btn ghost sm" href="#/patients/' + encodeURIComponent(pid) + '?tab=diagnoses">View diagnosis history →</a>', addId: 'dashDxAdd', canAdd: canDx }) +
      renderSummaryCard({ title: '💊 Dispensed prescriptions', count: activeLines.length, listHtml: '<p class="sub">Based on pharmacy status; confirm the patient is still taking each medicine.</p>' + medsHtml + '<a class="btn ghost sm" href="#/patients/' + encodeURIComponent(pid) + '?tab=medications">View medication history →</a>', addId: 'dashRxAdd', canAdd: canRx && !medDenied }) +
      renderSummaryCard({ title: '⚠ Allergy status', count: d.allergies.length, listHtml: '<div class="pd-allergy-row">' + allergiesHtml + '</div><a class="btn ghost sm" href="#/patients/' + encodeURIComponent(pid) + '?tab=blood">Review allergy details →</a>' }) +
      '</div>' +
      '<div class="progress-feed" role="region" aria-label="Clinical progress feed">' +
      '<div class="feed-filter"><label class="fld pd-filter-label"><span>Filter</span>' +
      '<select id="feedFilter" class="input" aria-label="Filter clinical events">' +
      FEED_FILTERS.map((opt) => '<option value="' + opt.value + '"' + (dashboardFilter === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>').join('') +
      '</select></label></div>' +
      '<div class="feed-list" id="feedList">' + timelineHtml + '</div>' +
      (list.length > feedLimit ? '<div class="feed-load-more"><button type="button" class="btn ghost sm" id="feedLoadMore">Load more</button></div>' : '') +
      '</div></div>' +
      (quick.length ? '<div class="dashboard-actions">' + quick.join('') + '</div>' : '') +
      '</div>'
  }

  function paneHtml(t, query = '') {
    if (t === TAB.DASHBOARD) return buildDashboardPane()
    if (t === TAB.PERSONAL) return personalPane()
    if (t === TAB.BLOOD) return bloodPane()
    if (t === TAB.KIN) return kinPane()
    const q = query
    const searchBox = '<input class="input pd-search" id="tabSearch" type="search" placeholder="Search this tab…" value="' + esc(q) + '" aria-label="Search this tab">'
    if (t === TAB.ENCOUNTERS) return encountersPane(q, searchBox)
    if (t === TAB.VITALS) return vitalsPane(q, searchBox)
    if (t === TAB.DIAGNOSES) return diagnosesPane(q, searchBox)
    if (t === TAB.MEDICATIONS) return medicationsPane(q, searchBox)
    if (t === TAB.LABS) return labsPane(q, searchBox)
    if (t === TAB.ADMISSIONS) return admissionsPane(q, searchBox)
    if (t === TAB.DOCUMENTS) return documentsPane(q, searchBox)
    return ''
  }

  function personalPane() {
    const billing = loadCache.Billing || { rows: [], error: null, kind: null }
    let billingInner
    if (billing.error && !billing.rows.length) {
      billingInner = noticeHtml(billing.error, billing.kind) +
        '<button type="button" class="btn ghost sm" data-retry-tab="' + TAB.PERSONAL + '">Retry</button>'
    } else {
      const invList = billing.rows || []
      const totalBilled = invList.reduce((sum, i) => sum + (i.total || 0), 0)
      const totalPaid = invList.reduce((sum, i) => sum + (i.paid || 0), 0)
      const bal = totalBilled - totalPaid
      const openCount = invList.filter((i) => (i.status || 'unpaid') !== 'paid').length
      billingInner = !invList.length
        ? '<p class="sub">No invoices raised for this patient yet.</p>'
        : '<div class="kv">' +
          '<div><em>Billed</em><strong>' + esc(naira(totalBilled)) + '</strong></div>' +
          '<div><em>Paid</em><strong class="pd-ok">' + esc(naira(totalPaid)) + '</strong></div>' +
          '<div><em>Balance due</em><strong class="' + (bal > 0 ? 'pd-bad' : 'pd-ok') + '">' + esc(naira(bal)) + '</strong></div>' +
          '<div><em>Open bills</em><strong>' + openCount + '</strong></div></div>'
      billingInner += '<div class="mrow pd-gap">' +
        '<a class="btn ghost sm" href="#/billing?patient=' + encodeURIComponent(pid) + '">All bills (' + invList.length + ') →</a>' +
        (canBill ? '<a class="btn sm" href="#/billing?patient=' + encodeURIComponent(pid) + '&new=1">+ Raise invoice</a>' : '') +
        '</div>'
    }
    const consentRows = billing.consents || []
    const consentHistory = consentRows.length
      ? '<div class="pd-consent-list">' + consentRows.map((c) =>
        '<article><strong>' + esc(s(c.consent_type || c.scope, 'Consent')) + '</strong>' +
        '<span>' + esc(s(c.consent_date, c.created_at ? when(c.created_at) : 'Date not recorded')) + '</span>' +
        '<span>Witness: ' + esc(s(c.witness, 'Not recorded')) + '</span>' +
        (c.note ? '<p>' + esc(c.note) + '</p>' : '') + '</article>').join('') + '</div>'
      : '<p class="sub">No consent records on this chart.</p>'
    return '<div class="grid2x">' +
      '<div class="card"><h3>Personal details</h3>' +
      '<p class="sub">Source: this hospital\'s record.</p>' +
      '<div class="kv">' +
      '<div><em>Surname</em><strong>' + esc(s(p.surname, 'Not recorded')) + '</strong></div>' +
      '<div><em>Given name(s)</em><strong>' + esc(s(p.given_names, 'Not recorded')) + '</strong></div>' +
      '<div><em>Sex</em><strong>' + esc(s(p.sex, 'Not recorded')) + '</strong></div>' +
      '<div><em>Date of birth</em><strong>' + esc(s(p.dob, 'Not recorded')) + '</strong></div>' +
      '<div><em>Age</em><strong>' + esc(p.age !== '' ? p.age + ' years' : 'Not recorded') + '</strong></div>' +
      '<div><em>Phone</em><strong>' + esc(formatPhone(p.phone, p.phone_key)) + '</strong></div>' +
      '<div><em>Occupation</em><strong>' + esc(s(p.occupation, 'Not recorded')) + '</strong></div>' +
      '<div><em>Address</em><strong>' + esc(s(p.address, 'Not recorded')) + '</strong></div>' +
      '<div><em>Payer</em><strong>' + esc(s(p.payer, 'Not recorded')) + '</strong></div></div>' +
      (caps.canUpdate ? '<div class="pd-gap"><button type="button" class="btn ghost" id="editDemoBtn">Edit demographics</button></div>' : '') +
      '</div><div>' +
      '<div class="card"><h3>Administrative · billing & invoices</h3>' + billingInner + '</div>' +
      '<div class="card"><h3>Consent & access</h3>' +
      '<p class="sub">Record consent type, date and witness. Cross-hospital access always requires reason + audit.</p>' +
      (billing.consentError ? noticeHtml(billing.consentError, classifyError({ message: billing.consentError }).kind) : consentHistory) +
      (caps.canUpdate ? '<button type="button" class="btn ghost sm" id="consentBtn">Record consent</button>' : '') +
      '</div></div></div>'
  }

  function bloodPane() {
    const allergies = knownAllergies()
    return '<div class="grid2x">' +
      '<div class="card"><h3>Blood group</h3><div class="kv">' +
      '<div><em>Blood group (ABO/Rh)</em><strong>' + esc(s(p.blood_group, 'Not recorded')) + '</strong></div>' +
      '<div><em>Genotype</em><strong>' + esc(s(p.genotype, 'Not recorded')) + '</strong></div></div>' +
      (caps.canUpdate ? '<div class="pd-gap"><button type="button" class="btn ghost" id="editBloodBtn">Edit blood group & genotype</button></div>' : '') +
      '</div><div class="card"><h3>Allergies</h3>' +
      '<p class="sub">Always confirm before prescribing.</p>' +
      '<div class="allergy-tags-display">' +
      (allergies.length ? allergies.map((a) => '<span class="allergy-tag-display">' + esc(a) + '</span>').join('') : '<span class="mut">No allergy information recorded. Confirm with the patient.</span>') +
      '</div>' +
      (caps.canUpdate ? '<div class="pd-gap"><button type="button" class="btn ghost" id="editAllergyBtn">Edit allergies</button></div>' : '') +
      '</div></div>'
  }

  function kinPane() {
    return '<div class="grid2x"><div class="card"><h3>Contact</h3><div class="kv">' +
      '<div><em>Full name</em><strong>' + esc(s(p.next_of_kin_name, 'Not recorded')) + '</strong></div>' +
      (p.next_of_kin_relationship ? '<div><em>Relationship</em><strong>' + esc(p.next_of_kin_relationship) + '</strong></div>' : '') +
      '<div><em>Phone</em><strong>' + (p.next_of_kin_phone_key || p.next_of_kin_phone
        ? '<a href="tel:' + esc(p.next_of_kin_phone_key || p.next_of_kin_phone) + '">' + esc(formatPhone(p.next_of_kin_phone, p.next_of_kin_phone_key)) + '</a>'
        : 'Not recorded') + '</strong></div></div>' +
      (caps.canUpdate ? '<div class="pd-gap"><button type="button" class="btn ghost" id="editKinContactBtn">Edit contact</button></div>' : '') +
      '</div><div class="card"><h3>Address</h3><div class="kv">' +
      '<div><em>Address</em><strong>' + esc(s(p.next_of_kin_address, 'Not recorded')) + '</strong></div></div>' +
      (caps.canUpdate ? '<div class="pd-gap"><button type="button" class="btn ghost" id="editKinAddressBtn">Edit address</button></div>' : '') +
      '</div></div>'
  }

  function tabRows(tabId, q) {
    const res = loadCache[tabId] || { rows: [], error: null }
    let rows = res.rows || []
    const squery = String(q || '').trim().toLowerCase()
    if (squery) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(squery))
    return { res, rows }
  }

  function errorOrEmpty(res, tabId, empty) {
    if (res.error && !res.rows?.length) {
      return noticeHtml(res.error, res.kind) + '<button type="button" class="btn ghost sm" data-retry-tab="' + tabId + '">Retry</button>'
    }
    return empty
  }

  function encountersPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.ENCOUNTERS, q)
    const add = canEncounter ? '<button type="button" class="btn" id="encTabBtn">Start encounter</button>' : ''
    const body = (!rows.length)
      ? errorOrEmpty(res, TAB.ENCOUNTERS, emptyState({
        icon: '🏥', title: 'No encounters', body: 'No visits recorded yet.',
        actionHtml: add,
      }))
      : dataTable({
        caption: 'Encounters',
        cols: ['When', 'Type', 'Clinician', 'Status', ''],
        rows,
        htmlRow: (e) => {
          const items = [
            { label: 'View', dataAction: 'view' },
            { label: 'Print summary', dataAction: 'print' },
            ...(canEncEdit ? [{ label: 'Edit', dataAction: 'edit' }] : []),
            ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
          ]
          return '<tr class="clickable" tabindex="0" role="button" data-enc-row="' + esc(e.id) + '" aria-label="View encounter">' +
            '<td>' + esc(when(e.created_at)) + '</td>' +
            '<td><strong>' + esc(s(e.encounter_type || e.type || e.reason)) + '</strong>' +
            ((e.chief_complaint || e.reason) ? '<div class="mut">' + esc(s(e.chief_complaint || e.reason)) + '</div>' : '') + '</td>' +
            '<td>' + esc(who(e.clinician_name || e.clinician || e.created_by)) + '</td>' +
            '<td>' + encBadge(e.status) + '</td>' +
            '<td>' + kebabCell({ rowId: e.id, items }) + '</td></tr>'
        },
      })
    return toolbar(searchBox, add && rows.length ? add : '') + body
  }

  function vitalsPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.VITALS, q)
    const add = canVitals ? '<button type="button" class="btn" id="vitalsBtn">+ Record vitals</button>' : ''
    const toggle = '<div class="pd-seg" role="group" aria-label="Vitals view">' +
      '<button type="button" class="btn ghost sm' + (vitalsMode === 'table' ? ' on' : '') + '" data-vitals-mode="table">Table</button>' +
      '<button type="button" class="btn ghost sm' + (vitalsMode === 'chart' ? ' on' : '') + '" data-vitals-mode="chart">Chart</button></div>'
    if (!rows.length) {
      return toolbar(searchBox + toggle, add) + errorOrEmpty(res, TAB.VITALS, emptyState({
        icon: '📍', title: 'No vitals', body: 'No readings recorded yet.', actionHtml: add,
      }))
    }
    const chrono = [...rows].sort((a, b) => ms(a.created_at) - ms(b.created_at))
    const chart = '<div class="pd-chart-grid">' +
      [['BP systolic', chrono.map((v) => v.bp_systolic)], ['Pulse', chrono.map((v) => v.pulse)],
        ['Respiratory rate', chrono.map((v) => v.rr)], ['Temp', chrono.map((v) => v.temp_c)], ['SpO₂', chrono.map((v) => v.spo2)],
        ['Weight', chrono.map((v) => v.weight_kg)], ['Height', chrono.map((v) => v.height_cm)],
        ['BMI', chrono.map((v) => bmi(v.weight_kg, v.height_cm))]].map(([label, vals]) =>
        '<div class="card pd-chart-card"><h4>' + esc(label) + '</h4>' + sparkline(vals, label, chrono.map((v) => v.created_at)) + '</div>').join('') + '</div>'
    const table = dataTable({
      caption: 'Vitals',
      cols: ['When', 'BP', 'Pulse', 'RR', 'Temp', 'SpO₂', 'Weight', 'Height', 'BMI', 'By', ''],
      rows,
      htmlRow: (v) => {
        const items = canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []
        return '<tr data-vitals-row="' + esc(v.id) + '"><td>' + esc(when(v.created_at)) + '</td>' +
          '<td><strong>' + esc((v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—')) + '</strong> <span class="mut">mmHg</span></td>' +
          '<td>' + esc(s(v.pulse)) + ' <span class="mut">bpm</span></td><td>' + esc(s(v.rr)) + (v.rr != null && v.rr !== '' ? ' <span class="mut">/min</span>' : '') + '</td><td>' + esc(s(v.temp_c)) + ' <span class="mut">°C</span></td><td>' + esc(s(v.spo2)) + ' <span class="mut">%</span></td>' +
          '<td>' + esc(s(v.weight_kg)) + (v.weight_kg != null && v.weight_kg !== '' ? ' <span class="mut">kg</span>' : '') + '</td><td>' + esc(s(v.height_cm)) + (v.height_cm != null && v.height_cm !== '' ? ' <span class="mut">cm</span>' : '') + '</td>' +
          '<td>' + esc(bmi(v.weight_kg, v.height_cm) != null ? bmi(v.weight_kg, v.height_cm).toFixed(1) : '—') + '</td>' +
          '<td class="mut">' + esc(who(v.created_by_name || v.created_by)) + (v.note ? '<div>' + esc(v.note) + '</div>' : '') + '</td>' +
          '<td>' + (items.length ? kebabCell({ rowId: v.id, items }) : '') + '</td></tr>'
      },
    })
    return toolbar(searchBox + toggle, add) + (vitalsMode === 'chart' ? chart : table)
  }

  function diagnosesPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.DIAGNOSES, q)
    const add = canDx ? '<button type="button" class="btn ghost" id="dxBtn">+ Add diagnosis</button>' : ''
    if (!rows.length) {
      return toolbar(searchBox, add) + errorOrEmpty(res, TAB.DIAGNOSES, emptyState({
        icon: '🩺', title: 'No diagnoses', body: 'The problem list is empty.', actionHtml: add,
      }))
    }
    return toolbar(searchBox, add) + dataTable({
      caption: 'Diagnoses',
      cols: ['Condition', 'Recorded', 'Recorded by', 'Status', ''],
      rows,
      htmlRow: (d) => {
        const items = [
          ...(canDx ? [{ label: 'Cycle status', dataAction: 'cycle' }] : []),
          ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
        ]
        return '<tr data-dx-row="' + esc(d.id) + '"><td><strong>' + esc(s(d.condition || d.name || d.icd_code)) + '</strong>' +
          (d.icd_code ? '<div class="mut">' + esc(d.icd_code) + '</div>' : '') + '</td>' +
          '<td>' + esc(when(d.created_at)) + '</td>' +
          '<td>' + esc(who(d.created_by_name || d.created_by)) + '</td>' +
          '<td>' + (canDx
            ? '<button type="button" class="pill-btn" data-dx-status="' + esc(d.id) + '" title="Cycle status">' + statusBadge(s(d.status, 'Active')) + '</button>'
            : statusBadge(s(d.status, 'Active'))) + '</td>' +
          '<td>' + (items.length ? kebabCell({ rowId: d.id, items }) : '') + '</td></tr>'
      },
    })
  }

  function medicationsPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.MEDICATIONS, q)
    const add = canRx ? '<button type="button" class="btn" id="rxBtn">+ New prescription</button>' : ''
    if (res.error && !rows.length) {
      return toolbar(searchBox, add) + noticeHtml(res.error, res.kind)
    }
    if (!rows.length) {
      return toolbar(searchBox, add) + emptyState({
        icon: '💊', title: 'No prescriptions', body: 'No medication requests yet.', actionHtml: add,
      })
    }
    return toolbar(searchBox, add) + dataTable({
      caption: 'Prescriptions',
      cols: ['Prescription', 'Medicines', 'Status', 'Ordered', ''],
      rows,
      htmlRow: (raw) => {
        const script = R.normalizeRequest(raw)
        const open = R.isOpenRequest(script.status) || script.status === R.REQUEST_STATUS.EXTERNAL
        const names = script.items.map((l) => l.medicine || 'item')
        const summary = (names.slice(0, 2).join(', ') || '—') + (names.length > 2 ? ' +' + (names.length - 2) + ' more' : '')
        const items = [
          { label: 'View', dataAction: 'view' },
          { label: 'Print', dataAction: 'print' },
          ...(canRx && open ? [{ label: 'Adjust', dataAction: 'adjust' }, { label: 'Discontinue', dataAction: 'stop' }] : []),
          ...(canDispense ? [{ label: 'Dispense', dataAction: 'dispense' }] : []),
          ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
        ]
        return '<tr class="clickable" tabindex="0" role="button" data-rx-row="' + esc(script.id) + '" aria-label="View prescription">' +
          '<td><span class="mut">Script ' + esc(String(script.id).slice(0, 8)) + '</span></td>' +
          '<td>' + esc(summary) + (script.items[0]?.dosage ? '<div class="mut">' + esc(script.items[0].dosage) + '</div>' : '') + '</td>' +
          '<td>' + statusBadge(script.status) + '</td>' +
          '<td class="mut">' + esc(when(raw.created_at)) +
          (raw.created_by_name || raw.created_by ? '<div class="mut">' + esc(who(raw.created_by_name || raw.created_by)) + '</div>' : '') + '</td>' +
          '<td>' + kebabCell({ rowId: script.id, items }) + '</td></tr>'
      },
    })
  }

  function labsPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.LABS, q)
    const add = canLabOrder ? '<a class="btn" href="#/laboratory/new?patient=' + encodeURIComponent(pid) + '">+ Lab order</a>' : ''
    if (!rows.length) {
      return toolbar(searchBox, add) + errorOrEmpty(res, TAB.LABS, emptyState({
        icon: '🧪', title: 'No lab orders', body: 'No laboratory requests on this chart.', actionHtml: add,
      }))
    }
    return toolbar(searchBox, add) + dataTable({
      caption: 'Lab orders',
      cols: ['Order', 'Test', 'Stage', 'Result', 'Ordered', ''],
      rows,
      htmlRow: (l) => {
        const snippet = labResultSnippet(l)
        const items = [
          { label: 'Open', dataAction: 'open' },
          ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
        ]
        return '<tr class="clickable" tabindex="0" role="button" data-lab-row="' + esc(l.id) + '" aria-label="Open lab order">' +
          '<td><strong>' + esc(s(l.id).slice(0, 10)) + '</strong></td>' +
          '<td>' + esc(s(l.test || l.test_panel || l.panel)) + '</td>' +
          '<td>' + statusBadge(s(l.stage || l.status, 'Ordered')) + '</td>' +
          '<td class="mut">' + esc(snippet || '—') + '</td>' +
          '<td class="mut">' + esc(when(l.created_at)) + '</td>' +
          '<td>' + kebabCell({ rowId: l.id, items }) + '</td></tr>'
      },
    })
  }

  function admissionsPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.ADMISSIONS, q)
    const add = canAdmit ? '<button type="button" class="btn" id="admBtn">+ Admit patient</button>' : ''
    if (!rows.length) {
      return toolbar(searchBox, add) + errorOrEmpty(res, TAB.ADMISSIONS, emptyState({
        icon: '🛏️', title: 'No admissions', body: 'This patient is not on a ward stay.', actionHtml: add,
      }))
    }
    const cards = rows.map((raw) => {
      const a = normalizeAdmission(raw)
      const items = [
        { label: 'Open stay', dataAction: 'open' },
        ...(a.status === 'active' && canAdmit ? [{ label: 'Discharge', dataAction: 'discharge' }] : []),
        ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
      ]
      return '<article class="pd-adm-card" role="button" tabindex="0" data-adm-card="' + esc(a.id) + '" aria-label="Open admission stay">' +
        '<div class="pd-adm-top"><span class="pd-bed-badge">' + esc(s(a.wardName)) + ' · ' + esc(s(a.bedNumber)) + '</span>' +
        statusBadge(a.status === 'discharged' ? 'Discharged' : 'Admitted') +
        kebabCell({ rowId: a.id, items }) + '</div>' +
        '<p><em>Admitting Dr</em> ' + esc(who(a.attendingProvider)) + '</p>' +
        '<p class="mut">Since ' + esc(when(a.admissionDate || a.createdAt)) +
        (a.dischargeDate ? ' · Discharged ' + esc(when(a.dischargeDate)) : '') +
        (a.dischargeDate && a.admissionDate ? ' · ' + Math.max(0, Math.floor((a.dischargeDate - a.admissionDate) / 86400000)) + ' days' : '') +
        (a.encounterId ? ' · <a href="#/consultations?enc=' + encodeURIComponent(a.encounterId) + '">Encounter</a>' : '') + '</p>' +
        (a.dischargeNotes ? '<p class="mut">Discharge: ' + esc(a.dischargeNotes) + '</p>' : '') + '</article>'
    }).join('')
    return toolbar(searchBox, add) + '<div class="pd-adm-grid">' + cards + '</div>'
  }

  function documentsPane(q, searchBox) {
    const { res, rows } = tabRows(TAB.DOCUMENTS, q)
    const add = canDocs ? '<button type="button" class="btn" id="docUploadBtn">+ Upload</button>' : ''
    if (!rows.length) {
      return toolbar(searchBox, add) + errorOrEmpty(res, TAB.DOCUMENTS, emptyState({
        icon: '📄', title: 'No documents', body: 'No files attached to this chart.', actionHtml: add,
      }))
    }
    return toolbar(searchBox, add) + dataTable({
      caption: 'Documents',
      cols: ['File', 'Type', 'File status', 'Added', ''],
      rows,
      htmlRow: (d) => {
        const items = [
          { label: 'Preview', dataAction: 'preview' },
          ...(canDelete ? [{ label: 'Delete', dataAction: 'delete', tone: 'danger' }] : []),
        ]
        return '<tr class="clickable" tabindex="0" role="button" data-doc-row="' + esc(d.id) + '" aria-label="Preview document">' +
          '<td><strong>' + esc(s(d.name || d.filename || d.title)) + '</strong></td>' +
          '<td>' + esc(s(d.type || d.document_type || d.kind)) + '</td>' +
          '<td>' + esc(d.url ? 'Preview available' : d.storage_path ? 'Storage path only' : 'Metadata only · no file attached') + '</td>' +
          '<td class="mut">' + esc(when(d.created_at)) + '</td>' +
          '<td>' + kebabCell({ rowId: d.id, items }) + '</td></tr>'
      },
    })
  }

  async function loadTabData(tabId) {
    if (tabId === TAB.DASHBOARD) return loadDashboardData()
    if (tabId === TAB.PERSONAL) {
      const [bills, consents] = await Promise.all([
        listPatientInvoices(pid).then((rows) => ({ rows: rows || [], error: null, kind: null })).catch((e) => {
          const info = classifyError(e)
          return { rows: [], error: info.message, kind: info.kind }
        }),
        listPatientDocs(COLL.CONSENTS, pid, { limitN: null }).then((res) => ({ rows: res.rows || [], error: res.error || null })).catch((e) => ({ rows: [], error: friendlyPatientError(e) })),
      ])
      return { ...bills, consents: consents.rows, consentError: consents.error }
    }
    if (tabId === TAB.BLOOD || tabId === TAB.KIN) return { rows: [], error: null, kind: null }
    const def = tabDef(tabId)
    if (def.coll) return fetchCollection(def.coll, { limitN: null })
    return { rows: [], error: null, kind: null }
  }

  function cacheKey(tabId) {
    return tabId === TAB.PERSONAL ? 'Billing' : tabId
  }

  /**
   * @param {string} tabId
   * @param {{ force?: boolean }} [opts]
   */
  async function render(tabId, opts = {}) {
    const host = pane()
    if (!host) return
    const seq = ++renderSeq
    if (tabAbort) tabAbort.abort()
    tabAbort = new AbortController()
    const signal = tabAbort.signal
    const key = cacheKey(tabId)
    const cached = loadCache[key]
    if (cached && !opts.force) {
      host.innerHTML = paneHtml(tabId)
      host.setAttribute('aria-labelledby', 'tab-' + tabId)
      wirePane()
      loadTabData(tabId).then((fresh) => {
        if (signal.aborted || seq !== renderSeq) return
        loadCache[key] = { ...fresh, loadedAt: Date.now() }
        host.innerHTML = paneHtml(tabId)
        host.setAttribute('aria-labelledby', 'tab-' + tabId)
        wirePane()
      }).catch(() => {})
      return
    }
    host.innerHTML = skeletonFor(tabId)
    host.setAttribute('aria-busy', 'true')
    try {
      const data = await loadTabData(tabId)
      if (signal.aborted || seq !== renderSeq) return
      loadCache[key] = { ...data, loadedAt: Date.now() }
      host.innerHTML = paneHtml(tabId)
      host.setAttribute('aria-labelledby', 'tab-' + tabId)
      host.removeAttribute('aria-busy')
      wirePane()
    } catch (e) {
      if (signal.aborted || seq !== renderSeq) return
      const info = classifyError(e)
      host.innerHTML = noticeHtml(info.message, info.kind) +
        '<button type="button" class="btn" data-retry-tab="' + tabId + '">Retry</button>'
      host.removeAttribute('aria-busy')
      wirePane()
    }
  }

  function invalidate(keys) {
    for (const k of keys) delete loadCache[k]
  }

  async function afterClinical(primaryTab) {
    invalidate([TAB.DASHBOARD, primaryTab, 'Billing'])
    await render(activeTab, { force: true })
  }

  function openVitals() {
    formModal({
      title: 'Record vitals',
      submitLabel: 'Save vitals',
      fields: [
        { name: 'bp_systolic', label: 'BP systolic', type: 'number', placeholder: '120' },
        { name: 'bp_diastolic', label: 'BP diastolic', type: 'number', placeholder: '80' },
        { name: 'pulse', label: 'Pulse (bpm)', type: 'number', placeholder: '78' },
        { name: 'rr', label: 'Respiratory rate (breaths/min)', type: 'number', placeholder: '16' },
        { name: 'temp_c', label: 'Temp °C', type: 'number', placeholder: '36.8' },
        { name: 'spo2', label: 'SpO₂ %', type: 'number', placeholder: '98' },
        { name: 'weight_kg', label: 'Weight kg', type: 'number', placeholder: '70' },
        { name: 'height_cm', label: 'Height cm', type: 'number', placeholder: '170' },
        { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        await createPatientDoc(COLL.VITALS, pid, {
          bp_systolic: num(v.bp_systolic), bp_diastolic: num(v.bp_diastolic),
          pulse: num(v.pulse), rr: num(v.rr), temp_c: num(v.temp_c), spo2: num(v.spo2),
          weight_kg: num(v.weight_kg), height_cm: num(v.height_cm), note: v.note || '',
        }, CAP.VITALS)
        closeModal()
        toast('Vitals saved')
        await afterClinical(TAB.VITALS)
      },
    })
    trapModalFocus()
  }

  function openDiagnosis() {
    const listOpts = ICD11_COMMON.map((x) => x.label + ' (' + x.code + ')')
    formModal({
      title: 'Add diagnosis',
      submitLabel: 'Save diagnosis',
      fields: [
        { name: 'condition', label: 'Condition', required: true, full: true, placeholder: 'Search ICD-11 / condition', list: 'icd11-list', listOptions: listOpts },
        { name: 'icd_code', label: 'ICD-11 code', placeholder: 'e.g. BA00' },
        { name: 'status', label: 'Status', type: 'select', options: DX_STATUSES },
      ],
      onInput: (values) => {
        const typed = String(values.condition || '')
        const hit = ICD11_COMMON.find((x) =>
          typed.includes('(' + x.code + ')') || typed.toLowerCase() === x.label.toLowerCase() || typed.toLowerCase() === x.code.toLowerCase())
        if (hit) {
          const icd = document.querySelector('#modal [name="icd_code"]')
          const cond = document.querySelector('#modal [name="condition"]')
          if (icd && !icd.value) icd.value = hit.code
          if (cond && typed.includes('(')) cond.value = hit.label
        }
      },
      onSubmit: async (v) => {
        let condition = v.condition
        let icd = v.icd_code || ''
        const hit = ICD11_COMMON.find((x) => String(v.condition || '').includes('(' + x.code + ')'))
        if (hit) { condition = hit.label; icd = icd || hit.code }
        await createPatientDoc(COLL.DIAGNOSES, pid, {
          condition, icd_code: icd, status: v.status || 'Active',
        }, CAP.DX)
        closeModal()
        toast('Diagnosis saved')
        await afterClinical(TAB.DIAGNOSES)
      },
    })
    trapModalFocus()
  }

  async function cycleDxStatus(id) {
    if (!canDx) return
    const row = (loadCache[TAB.DIAGNOSES]?.rows || []).find((x) => x.id === id)
    if (!row) return
    const cur = s(row.status, 'Active')
    const next = DX_STATUSES[(DX_STATUSES.indexOf(cur) + 1) % DX_STATUSES.length] || 'Active'
    try {
      await updateDoc(doc(db, COLL.DIAGNOSES, id), { status: next, updated_at: serverTimestamp() })
      toast('Status → ' + next)
      await afterClinical(TAB.DIAGNOSES)
    } catch (e) {
      const info = classifyError(e)
      toast(info.message)
    }
  }

  async function loadCatalogue() {
    drugsCache = drugsCache || await listOrgDrugs(authStore.getState().activeOrg)
    return drugsCache
  }

  function toModalLines(script) {
    return script.items.map((l) => ({
      line_id: l.line_id, drug_id: l.drug_id || '', sku: l.sku || '', unit: l.unit || '',
      medicine: l.medicine || '', dosage: l.dosage || '',
      qty: l.quantity === '' || l.quantity == null ? '' : String(l.quantity),
      instructions: l.instructions || '', external: !!l.external, dispensed_qty: l.dispensed_qty,
    }))
  }

  function warnAllergies(lines) {
    const allergies = knownAllergies()
    const conflicts = lines.filter((l) => {
      const med = String(l.medicine || '').toLowerCase()
      return allergies.some((a) => med.includes(a.toLowerCase()) || a.toLowerCase().includes(med))
    })
    if (!conflicts.length) return true
    return window.confirm(
      'Allergy alert: ' + conflicts.map((l) => l.medicine).join(', ') +
      ' matches a recorded allergy for ' + p.name + '. Continue prescribing anyway?'
    )
  }

  function printScript(raw) {
    const script = R.normalizeRequest(raw)
    printDocument('Prescription', prescriptionHtml({
      hospitalName: authStore.getState().activeOrgName,
      patientName: p.name, mrn: p.mrn, encounterId: script.encounterId,
      scriptId: script.id, status: script.status, items: script.items,
      prescribedBy: script.prescribedBy, prescribedAt: raw.created_at,
    }))
  }

  async function adjustScript(raw) {
    if (!canRx) { toast('Your role cannot prescribe. Ask an administrator.'); return }
    const script = R.normalizeRequest(raw)
    let catalogue
    try { catalogue = await loadCatalogue() }
    catch (e) { toast('Could not load the pharmacy catalogue: ' + friendlyPatientError(e)); return }
    openPrescriptionModal({
      drugs: catalogue, title: 'Adjust prescription', submitLabel: 'Save changes',
      hint: 'Medicines the pharmacy has already issued are locked.',
      initialLines: toModalLines(script),
      onSubmit: async (lines) => {
        if (!warnAllergies(lines)) return
        try { await updateRequestItems(script.id, lines) }
        catch (e) { throw new Error(friendlyPatientError(e)) }
        closeModal()
        toast('Prescription updated')
        await afterClinical(TAB.MEDICATIONS)
      },
    })
    trapModalFocus()
  }

  async function openPrescription() {
    if (!canRx) { toast('Your role cannot prescribe. Ask an administrator.'); return }
    let catalogue
    try { catalogue = await loadCatalogue() }
    catch (e) { toast('Could not load the pharmacy catalogue: ' + friendlyPatientError(e)); return }
    openPrescriptionModal({
      drugs: catalogue, title: 'New prescription', submitLabel: 'Send to pharmacy',
      onSubmit: async (lines) => {
        if (!warnAllergies(lines)) return
        const rxArgs = { patientId: pid, patientName: p.name || '', lines }
        let created = false
        let queued = false
        try { ({ created } = await requestMedicationLines(rxArgs)) }
        catch (e) {
          try { await enqueue('rx_mirror', rxArgs); queued = true }
          catch { throw new Error(friendlyPatientError(e)) }
        }
        closeModal()
        const n = lines.length
        const allExternal = lines.every((l) => l.external)
        toast(queued
          ? 'Prescription saved — will reach the pharmacy when the connection allows'
          : allExternal
            ? 'External prescription saved — ' + n + ' medicine' + (n === 1 ? '' : 's')
            : (created ? 'Prescription sent to pharmacy — ' + n + ' medicine' + (n === 1 ? '' : 's')
              : n + ' medicine' + (n === 1 ? '' : 's') + ' added to the open prescription'))
        await afterClinical(TAB.MEDICATIONS)
      },
    })
    trapModalFocus()
  }

  async function discontinueScript(raw) {
    if (!canRx) return
    const script = R.normalizeRequest(raw)
    if (!window.confirm('Discontinue prescription ' + String(script.id).slice(0, 8) + '…?')) return
    try {
      await updateDoc(doc(db, COLL.MEDS, script.id), {
        status: R.REQUEST_STATUS.DECLINED, reason: 'Discontinued from patient chart', updated_at: serverTimestamp(),
      })
      toast('Prescription discontinued')
      await afterClinical(TAB.MEDICATIONS)
    } catch (e) {
      toast(friendlyPatientError(e))
    }
  }

  function openScriptModal(raw) {
    const script = R.normalizeRequest(raw)
    const open = R.isOpenRequest(script.status) || script.status === R.REQUEST_STATUS.EXTERNAL
    const lines = script.items.map((l) => {
      const issued = R.toQty(l.dispensed_qty, 0)
      const given = A.lineGiven(l)
      const left = A.lineRemainingToGive(l)
      return '<tr><td><strong>' + esc(s(l.medicine)) + '</strong>' + (l.external ? ' <span class="pill info">external</span>' : '') + '</td>' +
        '<td>' + esc(s(l.dosage)) + '</td><td>' + esc(R.toQty(l.quantity, 0)) + (l.unit ? ' ' + esc(l.unit) : '') + '</td>' +
        '<td>' + (issued ? esc(issued) : '—') + '</td><td>' + (given ? esc(given) : '—') + '</td>' +
        '<td>' + (left > 0 ? '<span class="pill warn">' + esc(left) + ' to go</span>' : '<span class="pill ok">done</span>') + '</td>' +
        '<td class="mut">' + esc(s(l.instructions)) + '</td></tr>'
    }).join('')
    openModal('Prescription',
      '<p>' + statusBadge(script.status) + ' <span class="mut">Script ' + esc(String(script.id).slice(0, 8)) + '</span></p>' +
      '<div class="tblwrap"><table class="tbl"><caption class="pd-caption">Medicines</caption><thead><tr>' +
      '<th scope="col">Medicine</th><th scope="col">Dosage</th><th scope="col">Prescribed</th><th scope="col">Issued</th><th scope="col">Given</th><th scope="col"></th><th scope="col">Instructions</th></tr></thead><tbody>' +
      (lines || emptyRow(7)) + '</tbody></table></div>' +
      '<div class="mrow pd-gap">' +
      '<button type="button" class="btn ghost" data-close>Close</button>' +
      '<button type="button" class="btn ghost" id="rxPrintBtn">Print</button>' +
      (canRx && open ? '<button type="button" class="btn ghost" id="rxAdjustBtn">Adjust</button>' : '') +
      (canRx && open ? '<button type="button" class="btn ghost" id="rxStopBtn">Discontinue</button>' : '') +
      (canDispense ? '<a class="btn" href="#/pharmacy/requests/' + encodeURIComponent(script.id) + '">Dispense</a>' : '') +
      '</div>', { wide: true })
    trapModalFocus()
    const pr = document.getElementById('rxPrintBtn')
    if (pr) pr.onclick = () => printScript(raw)
    const adj = document.getElementById('rxAdjustBtn')
    if (adj) adj.onclick = () => { closeModal(); adjustScript(raw) }
    const st = document.getElementById('rxStopBtn')
    if (st) st.onclick = () => { closeModal(); discontinueScript(raw) }
  }

  async function openAdmission() {
    const [wards, openEnc, staff] = await Promise.all([
      listOrgWards(authStore.getState().activeOrg).catch(() => []),
      findOpenEncounterForPatient(pid, authStore.getState().activeOrg).catch(() => null),
      getClinicalStaff(authStore.getState().activeOrg).catch(() => []),
    ])
    const linkedId = openEnc ? openEnc.id : ''
    const providerField = staff.length
      ? { name: 'attending_provider', label: 'Admitting doctor', type: 'select', options: staff }
      : { name: 'attending_provider', label: 'Admitting doctor', placeholder: 'e.g. Dr. N. Eze' }
    formModal({
      title: 'Admit patient',
      submitLabel: 'Confirm admission',
      fields: [
        wards.length
          ? { name: 'ward_name', label: 'Ward', type: 'select', options: wards.map((w) => w.name), required: true }
          : { name: 'ward_name', label: 'Ward', required: true, placeholder: 'e.g. Ward A' },
        { name: 'bed_number', label: 'Bed', required: true, placeholder: 'e.g. Bed 4' },
        { name: 'admission_type', label: 'Admission type', type: 'select', options: ADMISSION_TYPES },
        providerField,
        { name: 'admission_reason', label: 'Reason', full: true, placeholder: 'e.g. Observation' },
      ],
      onSubmit: async (v) => {
        const existing = await fetchCollection(COLL.ADMISSIONS)
        const invalid = validateAdmissionInput(
          { ...v, encounter_id: linkedId },
          { wards, admissions: existing.rows.map(normalizeAdmission), encounter: openEnc },
        )
        if (invalid) throw new Error(invalid)
        await createAdmission({
          patient_id: pid, patient_name: p.name || '', ward_name: v.ward_name, bed_number: v.bed_number,
          admission_type: v.admission_type, admission_reason: v.admission_reason,
          attending_provider: v.attending_provider, encounter_id: linkedId,
        })
        closeModal()
        toast('Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)
        await afterClinical(TAB.ADMISSIONS)
      },
    })
    trapModalFocus()
    const body = document.getElementById('modalBody')
    if (body && openEnc) {
      const note = document.createElement('p')
      note.className = 'sub pd-modal-note'
      note.textContent = 'Linked to open encounter ' + String(openEnc.id).slice(0, 8) + '… (' + (openEnc.status || 'open') + ').'
      body.prepend(note)
    }
  }

  function openDischarge(admissionId) {
    formModal({
      title: 'Discharge patient',
      submitLabel: 'Discharge',
      fields: [
        { name: 'reason', label: 'Discharge reason', required: true, full: true, placeholder: 'e.g. Recovered' },
        { name: 'notes', label: 'Discharge notes', full: true, placeholder: 'Follow-up instructions…' },
      ],
      onSubmit: async (v) => {
        await dischargeAdmission(admissionId, v)
        closeModal()
        toast('Patient discharged')
        await afterClinical(TAB.ADMISSIONS)
      },
    })
    trapModalFocus()
  }

  function encounterPrintHtml(e) {
    return '<h2>' + esc(p.name) + ' — encounter summary</h2>' +
      '<p>' + esc(s(e.encounter_type || e.type || 'Encounter')) + ' · ' + esc(encLabel(e.status)) + ' · ' + esc(when(e.created_at)) + '</p>' +
      '<p>Clinician: ' + esc(who(e.clinician_name || e.clinician || e.created_by)) + '</p>' +
      '<h3>Note</h3><pre>' + esc(s(e.chief_complaint, 'Nothing recorded')) + '</pre>' +
      '<h3>Plan</h3>' + (e.treatment_plan ? '<div class="pd-plan-rich">' + planHtmlForDisplay(e.treatment_plan) + '</div>' : '<p>Nothing recorded.</p>')
  }

  async function openEncounterDetail(e) {
    const eid = e.id
    const encType = s(e.encounter_type || e.type || e.reason || 'Encounter')
    const clinician = who(e.clinician_name || e.clinician || e.created_by_name || e.created_by)
    const vitals = e.vitals && typeof e.vitals === 'object' ? e.vitals : {}
    const dxList = (Array.isArray(e.diagnoses) && e.diagnoses.length)
      ? e.diagnoses
      : (e.diagnosis ? [{ condition: e.diagnosis, added_at: e.updated_at || e.created_at }] : [])
    const rxItems = (e.prescription && Array.isArray(e.prescription.items)) ? e.prescription.items : []
    const labSnap = Array.isArray(e.lab_orders) ? e.lab_orders : []
    const flowIdx = ENCOUNTER_STATUS_FLOW_META.findIndex((m) => m.key === String(e.status || '').toLowerCase())
    const section = (title, inner) => '<section class="pd-section"><h4>' + esc(title) + '</h4>' + inner + '</section>'
    const kvRow = (label, value) => '<div><em>' + esc(label) + '</em><strong>' + esc(s(value)) + '</strong></div>'
    const pre = (text) => text ? '<div class="pd-pre">' + esc(text) + '</div>' : '<p class="sub">Nothing recorded.</p>'
    const html = section('Overview',
      '<div class="kv pd-kv3">' + kvRow('Type', encType) + kvRow('Clinician', clinician) + kvRow('Status', encLabel(e.status)) +
      kvRow('Opened', when(e.created_at)) + kvRow('Last updated', when(e.updated_at)) +
      kvRow('Recorded by', who(e.created_by_name || e.created_by)) + '</div>') +
      section('Workflow', '<div class="flow">' + ENCOUNTER_STATUS_FLOW_META.map((m, i) =>
        '<span class="fstep' + (flowIdx > i ? ' done' : flowIdx === i ? ' now' : '') + '">' + esc(m.step) + '</span>' +
        (i < ENCOUNTER_STATUS_FLOW_META.length - 1 ? '<span class="farrow">→</span>' : '')).join('') + '</div>') +
      section('Vitals', Object.values(vitals).some((x) => x !== '' && x != null)
        ? '<div class="kv pd-kv4">' + kvRow('BP', vitals.BP) + kvRow('Pulse', vitals.Pulse) + kvRow('Respiratory rate', vitals.RR) + kvRow('Temp °C', vitals.Temp) + kvRow('SpO₂', vitals.SpO2) + kvRow('Weight kg', vitals.Weight) + kvRow('Height cm', vitals.Height) + kvRow('BMI', bmi(vitals.Weight, vitals.Height)) + '</div>'
        : '<p class="sub">No vitals snapshot on the encounter.</p>') +
      section('Clinical note (SOAP)', pre(s(e.chief_complaint, ''))) +
      section('Diagnoses', dxList.length
        ? dxList.map((d) => '<div class="summary-item"><span class="summary-item-label">' + esc(s(d.condition)) + '</span></div>').join('')
        : '<p class="sub">No diagnosis recorded on this encounter.</p>') +
      section('Treatment plan', e.treatment_plan
        ? '<div class="pd-pre pd-plan-rich">' + planHtmlForDisplay(e.treatment_plan) + '</div>'
        : '<p class="sub">Nothing recorded.</p>') +
      section('Prescriptions', rxItems.length
        ? '<ul>' + rxItems.map((l) => '<li>' + esc(s(l.medicine)) + ' ' + esc(s(l.dosage)) + '</li>').join('') + '</ul>'
        : '<p class="sub">No medicines snapshotted.</p>') +
      section('Lab orders', labSnap.length
        ? '<ul>' + labSnap.map((o) => '<li>' + esc(s(o.test_panel || o.id)) + '</li>').join('') + '</ul>'
        : '<p class="sub">No lab orders snapshotted.</p>') +
      '<div class="mrow pd-gap"><button type="button" class="btn ghost" data-close>Close</button>' +
      '<a class="btn" href="#/consultations?enc=' + encodeURIComponent(eid) + '">Open in Consultations →</a></div>'
    openModal('Encounter · ' + encType, html, { wide: true })
    trapModalFocus()
  }

  function openEncounter() {
    const q = '?pid=' + encodeURIComponent(pid) + (p?.name ? '&name=' + encodeURIComponent(p.name) : '')
    window.location.hash = '#/encounters/new' + q
  }
  function openEdit() {
    window.location.hash = '#/patients/' + pid + '/edit'
  }

  async function openPhotoUpload() {
    openModal('Upload patient photo',
      '<div class="photo-dropzone" id="photoDrop" tabindex="0" role="button" aria-label="Drop an image file here or choose a file">' +
      '<p>Drop an image here, or choose a file.</p>' +
      '<input type="file" id="photoFile" accept="image/*">' +
      '<div class="mrow pd-gap"><button type="button" class="btn sm" id="photoPick">Choose file</button>' +
      '<button type="button" class="btn ghost sm" id="photoShoot">Take photo</button></div>' +
      '<div id="photoPreview" class="photo-preview" hidden></div>' +
      '<p class="sub" id="photoProgress"></p></div>' +
      '<div class="mrow"><button type="button" class="btn ghost" data-close>Cancel</button>' +
      '<button type="button" class="btn" id="photoSave" disabled>Upload</button></div>')
    trapModalFocus()
    const input = document.getElementById('photoFile')
    const drop = document.getElementById('photoDrop')
    const preview = document.getElementById('photoPreview')
    const progress = document.getElementById('photoProgress')
    const save = document.getElementById('photoSave')
    let picked = null
    const show = async (file) => {
      if (!file || !/^image\//i.test(file.type || '')) { toast('Choose an image file'); return }
      progress.textContent = 'Resizing…'
      try {
        const compressed = await compressImage(file, { maxDim: 800 })
        picked = new File([compressed.blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: compressed.blob.type })
        const url = URL.createObjectURL(compressed.blob)
        preview.hidden = false
        preview.innerHTML = '<img src="' + url + '" alt="Preview" class="pavatar photo">'
        progress.textContent = Math.round(compressed.blob.size / 1024) + ' KB · max 800px'
        save.disabled = false
      } catch (e) {
        progress.textContent = friendlyPatientError(e, 'Could not read image')
      }
    }
    document.getElementById('photoPick').onclick = () => input.click()
    document.getElementById('photoShoot').onclick = () => { input.capture = 'environment'; input.click() }
    input.onchange = () => show(input.files && input.files[0])
    ;['dragenter', 'dragover'].forEach((ev) => {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('on') })
    })
    ;['dragleave', 'drop'].forEach((ev) => {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('on') })
    })
    drop.addEventListener('drop', (e) => show(e.dataTransfer.files && e.dataTransfer.files[0]))
    save.onclick = async () => {
      if (!picked) return
      save.disabled = true
      progress.textContent = 'Uploading…'
      try {
        await upsertPatientPhoto({ pid, file: picked })
        toast('Photo uploaded')
        closeModal()
        photoMeta = await getPatientPhotoMeta(pid)
        const blob = await getPatientPhotoBlob(pid)
        if (blob) photoUrl = URL.createObjectURL(blob)
        refreshHeaderPhoto()
      } catch (e) {
        progress.textContent = friendlyPatientError(e, 'Upload failed')
        save.disabled = false
      }
    }
  }

  async function openPhotoRemove() {
    if (!confirm("Remove this patient's photo?")) return
    try {
      await removePatientPhoto(pid)
      toast('Photo removed')
      photoUrl = null
      photoMeta = null
      refreshHeaderPhoto()
    } catch (e) {
      toast(friendlyPatientError(e, 'Could not remove photo'))
    }
  }

  function openConsent() {
    if (!caps.canUpdate) {
      toast('Your role cannot record consent. Ask an administrator.')
      return
    }
    formModal({
      title: 'Record consent',
      submitLabel: 'Save consent',
      fields: [
        { name: 'consent_type', label: 'Consent type', type: 'select', required: true, options: ['Treatment', 'Procedure', 'Data sharing', 'Photography', 'Full record'] },
        { name: 'consent_date', label: 'Date', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'witness', label: 'Witness', required: true, placeholder: 'Full name of witness' },
        { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        await createPatientDoc(COLL.CONSENTS, pid, {
          consent_type: v.consent_type, consent_date: v.consent_date, witness: v.witness, note: v.note || '',
          scope: v.consent_type,
        }, null)
        closeModal()
        toast('Consent recorded')
        await afterClinical(TAB.PERSONAL)
      },
    })
    trapModalFocus()
  }

  function savePatientPatch(overrides, okMsg) {
    return async () => {
      try {
        const result = await updatePatient(pid, patientFields({ ...overrides, force: true }))
        if (result && result.warning) throw new Error(result.warning)
        closeModal()
        toast(okMsg)
        await reloadPatient()
      } catch (e) {
        throw new Error(friendlyPatientError(e))
      }
    }
  }

  function openBloodEdit() {
    formModal({
      title: 'Edit blood group',
      submitLabel: 'Save',
      fields: [
        { name: 'blood_group', label: 'Blood group', type: 'select', options: BLOOD_GROUPS, value: p.blood_group || '' },
        { name: 'genotype', label: 'Genotype', type: 'select', options: GENOTYPES, value: p.genotype || '' },
      ],
      onSubmit: async (v) => savePatientPatch({ blood_group: v.blood_group, genotype: v.genotype }, 'Blood group updated')(),
    })
    trapModalFocus()
  }

  function openAllergyEdit() {
    formModal({
      title: 'Edit allergies',
      submitLabel: 'Save',
      fields: [
        { name: 'allergy', label: 'Allergies', type: 'tags', value: knownAllergies(), suggestions: allergySuggestions, full: true },
      ],
      onSubmit: async (v) => {
        const tags = Array.isArray(v.allergy) ? v.allergy : parseAllergyString(v.allergy)
        await savePatientPatch({ allergy: tags }, 'Allergies updated')()
      },
    })
    trapModalFocus()
  }

  function openKinContact() {
    formModal({
      title: 'Edit next of kin contact',
      submitLabel: 'Save',
      fields: [
        { name: 'next_of_kin_first_name', label: 'First name', required: true, value: p.next_of_kin_first_name || '' },
        { name: 'next_of_kin_last_name', label: 'Last name', required: true, value: p.next_of_kin_last_name || '' },
        { name: 'next_of_kin_phone', label: 'Phone', required: true, value: p.next_of_kin_phone_key || p.next_of_kin_phone || '' },
      ],
      onSubmit: async (v) => savePatientPatch({
        next_of_kin_first_name: v.next_of_kin_first_name,
        next_of_kin_last_name: v.next_of_kin_last_name,
        next_of_kin_phone: v.next_of_kin_phone,
      }, 'Next of kin contact updated')(),
    })
    trapModalFocus()
  }

  function openKinAddress() {
    formModal({
      title: 'Edit next of kin address',
      submitLabel: 'Save',
      fields: [
        { name: 'next_of_kin_address', label: 'Address', required: true, full: true, value: p.next_of_kin_address || '' },
      ],
      onSubmit: async (v) => savePatientPatch({ next_of_kin_address: v.next_of_kin_address }, 'Address updated')(),
    })
    trapModalFocus()
  }

  function openDocumentUpload() {
    if (!canDocs) return
    openModal('Upload document',
      '<label class="fld"><span>File</span><input class="input" type="file" id="docFile"></label>' +
      '<label class="fld"><span>Type</span><input class="input" id="docType" placeholder="e.g. Referral letter"></label>' +
      '<label class="fld"><span>Description</span><textarea class="input" id="docDesc" rows="2"></textarea></label>' +
      '<p class="sub" id="docHint">Images under 200 KB are stored for in-app preview.</p>' +
      '<div class="mrow"><button type="button" class="btn ghost" data-close>Cancel</button>' +
      '<button type="button" class="btn" id="docSave">Upload</button></div>')
    trapModalFocus()
    document.getElementById('docSave').onclick = async () => {
      const file = document.getElementById('docFile').files?.[0]
      if (!file) { toast('Choose a file'); return }
      const type = document.getElementById('docType').value || file.type || 'file'
      const description = document.getElementById('docDesc').value || ''
      let url = ''
      if (file.size <= 200 * 1024) {
        url = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result || ''))
          r.onerror = () => reject(new Error('Could not read file'))
          r.readAsDataURL(file)
        })
      }
      try {
        await createPatientDoc(COLL.DOCUMENTS, pid, {
          name: file.name, filename: file.name, document_type: type, type, description, url, size_bytes: file.size,
        }, CAP.DOCS)
        closeModal()
        toast(url ? 'Document uploaded' : 'Document metadata saved (file too large to embed)')
        await afterClinical(TAB.DOCUMENTS)
      } catch (e) {
        toast(friendlyPatientError(e))
      }
    }
  }

  function previewDocument(d) {
    const url = d.url || d.storage_path || ''
    if (!url) {
      openModal(s(d.name || 'Document'), '<p class="sub">No preview available for this file.</p>' +
        '<div class="mrow"><button type="button" class="btn ghost" data-close>Close</button></div>')
      trapModalFocus()
      return
    }
    const isImg = /^data:image\/|^https?:.+\.(png|jpe?g|gif|webp)/i.test(url)
    openModal(s(d.name || 'Document'),
      (isImg ? '<img src="' + esc(url) + '" alt="" class="pd-doc-preview">' : '<iframe class="pd-doc-frame" title="Preview" src="' + esc(url) + '"></iframe>') +
      '<div class="mrow pd-gap"><a class="btn" href="' + esc(url) + '" download>Download</a>' +
      '<button type="button" class="btn ghost" data-close>Close</button></div>', { wide: true })
    trapModalFocus()
  }

  function openFeedItem(entry) {
    if (!entry) return
    const id = entry.raw && entry.raw.id
    if (entry.type === 'encounter') {
      window.location.hash = '#/consultations?enc=' + encodeURIComponent(id)
      return
    }
    if (entry.type === 'vitals' || entry.type === 'diagnosis') {
      const tab = entry.type === 'vitals' ? TAB.VITALS : TAB.DIAGNOSES
      activateTab(tab)
      setTimeout(() => {
        const attr = entry.type === 'vitals' ? 'data-vitals-row' : 'data-dx-row'
        const row = [...document.querySelectorAll('[' + attr + ']')].find((el) => el.getAttribute(attr) === String(id))
        if (row) { row.scrollIntoView({ block: 'center' }); row.focus?.() }
      }, 0)
      return
    }
    if (entry.type === 'dose' && entry.raw) {
      const dose = entry.raw
      openModal('Medication administration', '<div class="kv pd-kv3">' +
        '<div><em>Medicine</em><strong>' + esc(s(dose.medicine)) + '</strong></div>' +
        '<div><em>Quantity</em><strong>' + esc(s(dose.qty, '1')) + '</strong></div>' +
        '<div><em>Route</em><strong>' + esc(s(dose.route).toUpperCase()) + '</strong></div>' +
        '<div><em>Administered</em><strong>' + esc(when(dose.administered_at || dose.created_at)) + '</strong></div>' +
        '<div><em>Given by</em><strong>' + esc(who(dose.administered_by_name || dose.administered_by)) + '</strong></div>' +
        (dose.site ? '<div><em>Site</em><strong>' + esc(dose.site) + '</strong></div>' : '') +
        (dose.note ? '<div class="pd-full"><em>Note</em><strong>' + esc(dose.note) + '</strong></div>' : '') +
        '</div><div class="mrow pd-gap"><button type="button" class="btn ghost" data-close>Close</button></div>')
      trapModalFocus()
      return
    }
    if (entry.type === 'medication') {
      activateTab(TAB.MEDICATIONS)
      if (entry.raw) setTimeout(() => openScriptModal(entry.raw), 0)
      return
    }
    if (entry.type === 'lab' && id) {
      window.location.hash = '#/laboratory/orders/' + encodeURIComponent(id)
      return
    }
    if (entry.type === 'admission' && id) {
      window.location.hash = '#/admissions/' + encodeURIComponent(id)
      return
    }
    if (entry.type === 'document') {
      activateTab(TAB.DOCUMENTS)
      if (entry.raw) setTimeout(() => previewDocument(entry.raw), 0)
    }
  }

  function wirePane() {
    const host = pane()
    if (!host) return
    host.querySelectorAll('[data-retry-tab]').forEach((b) => {
      b.onclick = () => render(b.getAttribute('data-retry-tab'), { force: true })
    })
    const search = document.getElementById('tabSearch')
    if (search) {
      search.oninput = () => {
        host.innerHTML = paneHtml(activeTab, search.value)
        wirePane()
        const again = document.getElementById('tabSearch')
        if (again) {
          again.focus()
          const len = again.value.length
          again.setSelectionRange(len, len)
        }
      }
    }
    const e1 = document.getElementById('editDemoBtn'); if (e1) e1.onclick = openEdit
    const c = document.getElementById('consentBtn'); if (c) c.onclick = openConsent
    const eb = document.getElementById('editBloodBtn'); if (eb) eb.onclick = openBloodEdit
    const ea = document.getElementById('editAllergyBtn'); if (ea) ea.onclick = openAllergyEdit
    const kc = document.getElementById('editKinContactBtn'); if (kc) kc.onclick = openKinContact
    const ka = document.getElementById('editKinAddressBtn'); if (ka) ka.onclick = openKinAddress
    const v = document.getElementById('vitalsBtn'); if (v) v.onclick = withBusy(v, async () => openVitals())
    const d = document.getElementById('dxBtn'); if (d) d.onclick = withBusy(d, async () => openDiagnosis())
    const r = document.getElementById('rxBtn'); if (r) r.onclick = withBusy(r, async () => openPrescription())
    const a = document.getElementById('admBtn'); if (a) a.onclick = withBusy(a, async () => openAdmission())
    const encTab = document.getElementById('encTabBtn'); if (encTab) encTab.onclick = openEncounter
    const docBtn = document.getElementById('docUploadBtn'); if (docBtn) docBtn.onclick = openDocumentUpload

    host.querySelectorAll('[data-vitals-mode]').forEach((b) => {
      b.onclick = () => {
        vitalsMode = b.getAttribute('data-vitals-mode')
        sessionStorage.setItem('pd:vitalsView:' + pid, vitalsMode)
        render(TAB.VITALS)
      }
    })
    host.querySelectorAll('[data-dx-status]').forEach((b) => {
      b.onclick = () => cycleDxStatus(b.getAttribute('data-dx-status'))
    })

    host.querySelectorAll('[data-enc-row]').forEach((row) => {
      const go = () => {
        const id = row.getAttribute('data-enc-row')
        window.location.hash = '#/consultations?enc=' + encodeURIComponent(id)
      }
      row.onclick = (ev) => { if (!ev.target.closest('button')) go() }
      row.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } }
    })
    host.querySelectorAll('[data-rx-row]').forEach((row) => {
      const go = () => {
        const raw = (loadCache[TAB.MEDICATIONS]?.rows || []).find((x) => x.id === row.getAttribute('data-rx-row'))
        if (raw) openScriptModal(raw)
      }
      row.onclick = (ev) => { if (!ev.target.closest('button')) go() }
      row.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } }
    })
    host.querySelectorAll('[data-lab-row]').forEach((row) => {
      const go = () => { window.location.hash = '#/laboratory/orders/' + encodeURIComponent(row.getAttribute('data-lab-row')) }
      row.onclick = (ev) => { if (!ev.target.closest('button')) go() }
      row.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } }
    })
    host.querySelectorAll('[data-doc-row]').forEach((row) => {
      const go = () => {
        const raw = (loadCache[TAB.DOCUMENTS]?.rows || []).find((x) => x.id === row.getAttribute('data-doc-row'))
        if (raw) previewDocument(raw)
      }
      row.onclick = (ev) => { if (!ev.target.closest('button')) go() }
      row.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } }
    })
    host.querySelectorAll('[data-adm-card]').forEach((card) => {
      card.onclick = (ev) => {
        if (ev.target.closest('button,a')) return
        window.location.hash = '#/admissions/' + encodeURIComponent(card.getAttribute('data-adm-card'))
      }
      card.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); window.location.hash = '#/admissions/' + encodeURIComponent(card.getAttribute('data-adm-card')) } }
    })

    wireKebabs(host, (rowId, action) => {
      if (activeTab === TAB.ENCOUNTERS) {
        const raw = (loadCache[TAB.ENCOUNTERS]?.rows || []).find((x) => x.id === rowId)
        if (!raw) return
        if (action === 'view') openEncounterDetail(raw)
        if (action === 'print') printDocument('Encounter summary', encounterPrintHtml(raw))
        if (action === 'edit') window.location.hash = '#/consultations?enc=' + encodeURIComponent(rowId)
        if (action === 'delete') confirmDelete('encounter ' + String(rowId).slice(0, 8), () => deleteEncounter(rowId), () => afterClinical(TAB.ENCOUNTERS))
      }
      if (activeTab === TAB.VITALS && action === 'delete') {
        confirmDelete('vitals reading', () => deletePatientRow(COLL.VITALS, rowId, 'vitals'), () => afterClinical(TAB.VITALS))
      }
      if (activeTab === TAB.DIAGNOSES) {
        if (action === 'cycle') cycleDxStatus(rowId)
        if (action === 'delete') confirmDelete('diagnosis', () => deletePatientRow(COLL.DIAGNOSES, rowId, 'diagnosis'), () => afterClinical(TAB.DIAGNOSES))
      }
      if (activeTab === TAB.MEDICATIONS) {
        const raw = (loadCache[TAB.MEDICATIONS]?.rows || []).find((x) => x.id === rowId)
        if (!raw) return
        if (action === 'view') openScriptModal(raw)
        if (action === 'print') printScript(raw)
        if (action === 'adjust') adjustScript(raw)
        if (action === 'stop') discontinueScript(raw)
        if (action === 'dispense') window.location.hash = '#/pharmacy/requests/' + encodeURIComponent(rowId)
        if (action === 'delete') confirmDelete('prescription', () => deleteMedicationRequest(rowId), () => afterClinical(TAB.MEDICATIONS))
      }
      if (activeTab === TAB.LABS) {
        if (action === 'open') window.location.hash = '#/laboratory/orders/' + encodeURIComponent(rowId)
        if (action === 'delete') confirmDelete('lab order', () => deleteLabOrder(rowId), () => afterClinical(TAB.LABS))
      }
      if (activeTab === TAB.ADMISSIONS) {
        if (action === 'open') window.location.hash = '#/admissions/' + encodeURIComponent(rowId)
        if (action === 'discharge') openDischarge(rowId)
        if (action === 'delete') confirmDelete('admission', () => deleteAdmission(rowId), () => afterClinical(TAB.ADMISSIONS))
      }
      if (activeTab === TAB.DOCUMENTS) {
        const raw = (loadCache[TAB.DOCUMENTS]?.rows || []).find((x) => x.id === rowId)
        if (action === 'preview' && raw) previewDocument(raw)
        if (action === 'delete') confirmDelete('document', () => deletePatientDocument(rowId), () => afterClinical(TAB.DOCUMENTS))
      }
    })

    const feedFilter = document.getElementById('feedFilter')
    if (feedFilter) {
      feedFilter.onchange = () => {
        dashboardFilter = feedFilter.value
        sessionStorage.setItem('pd:feed:' + pid, dashboardFilter)
        feedLimit = 30
        const listEl = document.getElementById('feedList')
        const d = loadCache[TAB.DASHBOARD] || { timeline: [] }
        const filtered = filteredTimeline(d)
        if (listEl) {
          listEl.innerHTML = filtered.length
            ? filtered.slice(0, feedLimit).map(renderFeedItem).join('')
            : emptyState({ icon: '📋', title: 'No events', body: 'Nothing matches this filter.' })
          bindFeedClicks()
        }
      }
    }
    const loadMore = document.getElementById('feedLoadMore')
    if (loadMore) {
      loadMore.onclick = () => {
        feedLimit += 30
        const d = loadCache[TAB.DASHBOARD] || { timeline: [] }
        const filtered = filteredTimeline(d)
        const listEl = document.getElementById('feedList')
        if (listEl) listEl.innerHTML = filtered.slice(0, feedLimit).map(renderFeedItem).join('')
        if (feedLimit >= filtered.length) loadMore.remove()
        bindFeedClicks()
      }
    }
    function bindFeedClicks() {
      const d = loadCache[TAB.DASHBOARD] || { timeline: [] }
      const filtered = filteredTimeline(d)
      pane()?.querySelectorAll('[data-feed-idx]').forEach((el) => {
        const go = () => openFeedItem(filtered[Number(el.getAttribute('data-feed-idx'))])
        el.onclick = go
        el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } }
      })
    }
    bindFeedClicks()

    const dashVitals = document.getElementById('dashVitalsBtn')
    if (dashVitals) dashVitals.onclick = withBusy(dashVitals, async () => openVitals())
    const dashDx = document.getElementById('dashDxBtn')
    if (dashDx) dashDx.onclick = withBusy(dashDx, async () => openDiagnosis())
    const dashRx = document.getElementById('dashRxBtn')
    if (dashRx) dashRx.onclick = withBusy(dashRx, async () => openPrescription())
    const dashAdm = document.getElementById('dashAdmBtn')
    if (dashAdm) dashAdm.onclick = withBusy(dashAdm, async () => openAdmission())
    const dashDxAdd = document.getElementById('dashDxAdd')
    if (dashDxAdd) dashDxAdd.onclick = openDiagnosis
    const dashRxAdd = document.getElementById('dashRxAdd')
    if (dashRxAdd) dashRxAdd.onclick = openPrescription
    const dashAll = document.getElementById('dashAllergiesBtn')
    if (dashAll) dashAll.onclick = openAllergyEdit

    wireToast(host)
  }

  function activateTab(tabId, { skipHash = false } = {}) {
    if (!TABS.some((t) => t.id === tabId)) tabId = TAB.DASHBOARD
    activeTab = tabId
    if (!skipHash) setTabInHash(tabId)
    document.querySelectorAll('#ptabs [role="tab"]').forEach((x) => {
      const on = x.getAttribute('data-t') === tabId
      x.classList.toggle('on', on)
      x.setAttribute('aria-selected', on ? 'true' : 'false')
      x.tabIndex = on ? 0 : -1
    })
    const panel = pane()
    if (panel) panel.setAttribute('aria-labelledby', 'tab-' + tabId)
    render(tabId)
  }

  function wireTabs() {
    const list = document.getElementById('ptabs')
    if (!list) return
    list.querySelectorAll('[role="tab"]').forEach((b) => {
      b.onclick = () => activateTab(b.getAttribute('data-t'))
    })
    list.onkeydown = (e) => {
      const tabs = [...list.querySelectorAll('[role="tab"]')]
      const i = tabs.findIndex((t) => t === document.activeElement)
      if (i < 0) return
      let next = i
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = tabs.length - 1
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        activateTab(tabs[i].getAttribute('data-t'))
        return
      } else return
      e.preventDefault()
      tabs[next].focus()
      activateTab(tabs[next].getAttribute('data-t'))
    }
  }

  wireTabs()

  onCleanup(() => {
    if (tabAbort) tabAbort.abort()
    if (photoUrl && String(photoUrl).startsWith('blob:')) URL.revokeObjectURL(photoUrl)
  })

  await render(activeTab)
}
