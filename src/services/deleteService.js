// Cross-app hard-delete, gated by the `data.delete` capability.
//
// Two authorities on every delete:
//   1. CLIENT: the caller's active membership must carry `data.delete`
//      (admins hold '*' so they always do), and the record must belong to
//      the caller's active hospital — organization_id is checked against
//      activeOrg before anything is touched.
//   2. RULES: firestore.rules pins every deletable collection to
//      hasCap(resource.data.organization_id, 'data.delete'), so the same
//      ownership rule holds server-side even if the client is tampered with.
//
// Domain guards on top: records that anchor other data (an invoiced lab
// order, a partly paid invoice, a drug with stock, a released result) refuse
// deletion with an actionable message. Append-only ledgers (payments,
// dispensations, stock movements, audit events, result images) are never
// deletable at all — see firestore.rules.
//
// Every successful delete is audit-logged with the record type + id.
import { deleteDoc, doc, getDoc, getDocs, collection, query, where, db } from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { logAudit } from './adminService.js'
import { can } from '../features/admin/roles.js'
import { myActiveMembership } from './authService.js'

export const DELETE_COLLECTIONS = {
  patient: 'patients',
  orgPatient: 'organization_patients',
  encounter: 'encounters',
  appointment: 'appointments',
  admission: 'admissions',
  labOrder: 'lab_orders',
  imagingOrder: 'imaging_orders',
  drug: 'stock_lots',
  medicationRequest: 'medication_requests',
  invoice: 'invoices',
  labTest: 'lab_test_catalogue',
  document: 'documents',
  vitals: 'vitals',
  diagnosis: 'diagnoses',
  clinicalNote: 'clinical_notes',
}

export function canDeleteRecords() {
  return can(myActiveMembership(), 'data.delete')
}

export function requireDeleteCap() {
  if (!canDeleteRecords()) {
    throw new Error('Your role cannot delete records (missing "data.delete" capability). Ask an administrator to grant it.')
  }
}

// Every deletable doc carries organization_id (patients carry the org that
// first registered them). Refuse anything owned by a different hospital.
export function requireOwnOrg(data, what = 'This record') {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!data || data.organization_id !== activeOrg) {
    throw new Error(what + ' belongs to a different hospital and cannot be deleted here.')
  }
}

async function loadOwned(collectionName, id, what) {
  const snap = await getDoc(doc(db, collectionName, id))
  if (!snap.exists()) throw new Error(what + ' no longer exists.')
  const data = snap.data()
  requireOwnOrg(data, what)
  return data
}

async function runDelete(collectionName, id, { what, action, patientId = null, details = '' }) {
  requireDeleteCap()
  const { activeOrg } = authStore.getState()
  await deleteDoc(doc(db, collectionName, id))
  try {
    await logAudit({
      action, organizationId: activeOrg, patientId,
      details: (what + ' ' + id + (details ? ' · ' + details : '')).slice(0, 500),
    })
  } catch (e) { console.warn('[delete] audit append failed:', e?.message) }
  return true
}

// ---- patients ---------------------------------------------------------------
// A patient may only be deleted while this hospital has no clinical trail for
// them: open encounters, admissions or invoices all block it. The org link
// document is removed with the patient.
export async function deletePatient(pid) {
  requireDeleteCap()
  const p = await loadOwned(DELETE_COLLECTIONS.patient, pid, 'This patient')
  if (p.status === 'merged_into') throw new Error('A merged patient record cannot be deleted.')

  const { activeOrg } = authStore.getState()
  const trail = []
  const encSnap = await getDocs(query(collection(db, DELETE_COLLECTIONS.encounter),
    where('patient_id', '==', pid), where('organization_id', '==', activeOrg)))
  if (!encSnap.empty) trail.push(encSnap.size + ' encounter(s)')
  const admSnap = await getDocs(query(collection(db, DELETE_COLLECTIONS.admission),
    where('patient_id', '==', pid), where('organization_id', '==', activeOrg)))
  if (!admSnap.empty) trail.push(admSnap.size + ' admission(s)')
  const invSnap = await getDocs(query(collection(db, DELETE_COLLECTIONS.invoice),
    where('patient_id', '==', pid), where('organization_id', '==', activeOrg)))
  if (!invSnap.empty) trail.push(invSnap.size + ' invoice(s)')
  if (trail.length) {
    throw new Error('This patient has clinical history in this hospital (' + trail.join(', ') +
      ') — history is never deleted. Close or cancel the records instead.')
  }

  await runDelete(DELETE_COLLECTIONS.patient, pid, {
    what: 'Patient', action: 'data.patient.deleted', patientId: pid,
    details: p.full_name || p.surname || '',
  })
  // Best-effort org link removal (id is deterministic: {orgId}_{pid}).
  try { await deleteDoc(doc(db, DELETE_COLLECTIONS.orgPatient, activeOrg + '_' + pid)) }
  catch (e) { console.warn('[delete] org link removal failed:', e?.message) }
  return true
}

// ---- encounters -------------------------------------------------------------
// Closed encounters only. Vitals / diagnoses / notes recorded against this
// encounter are removed with it (embedded arrays go with the doc itself).
export async function deleteEncounter(eid) {
  requireDeleteCap()
  const e = await loadOwned(DELETE_COLLECTIONS.encounter, eid, 'This encounter')
  if (e.status !== 'closed') {
    throw new Error('Only a closed encounter can be deleted — close it first.')
  }
  const { activeOrg } = authStore.getState()
  const pid = e.patient_id || null
  await runDelete(DELETE_COLLECTIONS.encounter, eid, {
    what: 'Encounter', action: 'data.encounter.deleted', patientId: pid,
    details: e.patient_name || '',
  })
  // Cascade the encounter-scoped child rows in THIS hospital only. Build the
  // ref from id rather than using snapshot.ref (works under the test fake too).
  for (const [coll, label] of [[DELETE_COLLECTIONS.vitals, 'vitals'], [DELETE_COLLECTIONS.diagnosis, 'diagnoses'], [DELETE_COLLECTIONS.clinicalNote, 'notes']]) {
    try {
      const snap = await getDocs(query(collection(db, coll),
        where('encounter_id', '==', eid), where('organization_id', '==', activeOrg)))
      for (const d of snap.docs) await deleteDoc(doc(db, coll, d.id))
    } catch (err) { console.warn('[delete] ' + label + ' cascade failed:', err?.message) }
  }
  return true
}

// ---- appointments -----------------------------------------------------------
export async function deleteAppointment(aid) {
  requireDeleteCap()
  const a = await loadOwned(DELETE_COLLECTIONS.appointment, aid, 'This appointment')
  return runDelete(DELETE_COLLECTIONS.appointment, aid, {
    what: 'Appointment', action: 'data.appointment.deleted', patientId: a.patient_id || null,
    details: (a.patient_name || '') + (a.time ? ' · ' + a.time : ''),
  })
}

// ---- admissions -------------------------------------------------------------
// Discharged only — an active admission holds a bed, and the discharge is the
// auditable end of the stay.
export async function deleteAdmission(aid) {
  requireDeleteCap()
  const a = await loadOwned(DELETE_COLLECTIONS.admission, aid, 'This admission')
  if (a.status === 'active') {
    throw new Error('Discharge the patient first — an active admission holds a bed.')
  }
  return runDelete(DELETE_COLLECTIONS.admission, aid, {
    what: 'Admission', action: 'data.admission.deleted', patientId: a.patient_id || null,
    details: (a.ward_name || '') + (a.bed_number ? ' bed ' + a.bed_number : ''),
  })
}

// ---- lab orders -------------------------------------------------------------
// A released/validated result is the patient's permanent clinical record, and an
// order tied to a live invoice anchors billing — neither may be deleted out from
// under it. Only clean, unreleased, uninvoiced orders go.
export async function deleteLabOrder(lid) {
  requireDeleteCap()
  const o = await loadOwned(DELETE_COLLECTIONS.labOrder, lid, 'This lab order')
  const items = Array.isArray(o.items) ? o.items : []
  if (items.some((it) => it && (it.status === 'released' || it.status === 'validated'))) {
    throw new Error('A released result is part of the patient record — this order cannot be deleted.')
  }
  // Only block deletion when the linked invoice actually still exists — if the
  // invoice was already deleted there is nothing anchoring this order.
  if (o.invoice_id) {
    const invSnap = await getDoc(doc(db, DELETE_COLLECTIONS.invoice, o.invoice_id))
    if (invSnap.exists()) {
      throw new Error('This order is tied to an invoice — void the invoice first.')
    }
  }
  return runDelete(DELETE_COLLECTIONS.labOrder, lid, {
    what: 'Lab order', action: 'data.lab_order.deleted', patientId: o.patient_id || null,
    details: o.order_no || o.test_panel || '',
  })
}

// ---- imaging orders ---------------------------------------------------------
export async function deleteImagingOrder(iid) {
  requireDeleteCap()
  const o = await loadOwned(DELETE_COLLECTIONS.imagingOrder, iid, 'This imaging order')
  if (o.status === 'verified' || (o.result && o.result !== '')) {
    throw new Error('A verified imaging order with findings is part of the patient record and cannot be deleted.')
  }
  return runDelete(DELETE_COLLECTIONS.imagingOrder, iid, {
    what: 'Imaging order', action: 'data.imaging_order.deleted', patientId: o.patient_id || null,
    details: o.study || o.studies?.join?.(', ') || '',
  })
}

// ---- drugs (stock lots) -----------------------------------------------------
// Zero stock only — anything else must go through a stock adjustment so the
// movement ledger stays balanced.
export async function deleteDrug(did) {
  requireDeleteCap()
  const d = await loadOwned(DELETE_COLLECTIONS.drug, did, 'This medicine')
  const stock = Number(d.stock) || 0
  if (stock > 0) {
    throw new Error('This medicine still has ' + stock + ' unit(s) in stock — correct the stock to zero first so the movement ledger stays balanced.')
  }
  return runDelete(DELETE_COLLECTIONS.drug, did, {
    what: 'Medicine', action: 'data.drug.deleted', details: d.name || '',
  })
}

// ---- medication requests ----------------------------------------------------
// Nothing dispensed at all — a partly issued script is the pharmacy's record.
export async function deleteMedicationRequest(rid) {
  requireDeleteCap()
  const r = await loadOwned(DELETE_COLLECTIONS.medicationRequest, rid, 'This prescription')
  const items = Array.isArray(r.items) ? r.items : []
  const issued = items.reduce((s, it) => s + (Number(it.dispensed_qty) || 0), 0)
  if (issued > 0) {
    throw new Error(issued + ' unit(s) have already been dispensed on this script — a partly issued prescription cannot be deleted.')
  }
  return runDelete(DELETE_COLLECTIONS.medicationRequest, rid, {
    what: 'Prescription', action: 'data.medication_request.deleted', patientId: r.patient_id || null,
    details: items.map((it) => it.drug_name || it.name).filter(Boolean).join(', '),
  })
}

// ---- invoices ---------------------------------------------------------------
// An invoice that has taken money is part of the financial record — the linked
// payment ledger stays balanced only while the invoice it points at exists, so a
// paid invoice is voided/adjusted, never deleted. An unpaid (even discounted)
// invoice can still be removed.
export async function deleteInvoice(iid) {
  requireDeleteCap()
  const inv = await loadOwned(DELETE_COLLECTIONS.invoice, iid, 'This invoice')
  const paid = Number(inv.paid_kobo) || 0
  if (paid > 0) {
    throw new Error('₦' + (paid / 100).toLocaleString('en-NG') + ' has been received against this invoice — reverse the payment before deleting.')
  }
  return runDelete(DELETE_COLLECTIONS.invoice, iid, {
    what: 'Invoice', action: 'data.invoice.deleted', patientId: inv.patient_id || null,
    details: inv.invoice_id || '',
  })
}

// ---- lab catalogue tests ----------------------------------------------------
// Safe at any time: live orders carry frozen snapshots of the configuration,
// so removing the catalogue entry never rewrites what was already ordered.
export async function deleteLabTest(tid) {
  requireDeleteCap()
  const t = await loadOwned(DELETE_COLLECTIONS.labTest, tid, 'This test')
  return runDelete(DELETE_COLLECTIONS.labTest, tid, {
    what: 'Catalogue test', action: 'data.lab_test.deleted',
    details: (t.code || '') + ' ' + (t.name || ''),
  })
}

// ---- patient documents ------------------------------------------------------
export async function deletePatientDocument(docId) {
  requireDeleteCap()
  const d = await loadOwned(DELETE_COLLECTIONS.document, docId, 'This document')
  return runDelete(DELETE_COLLECTIONS.document, docId, {
    what: 'Document', action: 'data.document.deleted', patientId: d.patient_id || null,
    details: d.name || d.document_type || '',
  })
}

// ---- single clinical rows (vitals / diagnosis / note) -----------------------
// Used from the patient chart's timeline rows.
export async function deletePatientRow(collectionName, id, label) {
  if (!Object.values(DELETE_COLLECTIONS).includes(collectionName)) {
    throw new Error('That record type cannot be deleted.')
  }
  requireDeleteCap()
  const d = await loadOwned(collectionName, id, 'This ' + (label || 'record'))
  return runDelete(collectionName, id, {
    what: label || 'Record', action: 'data.' + collectionName + '.deleted', patientId: d.patient_id || null,
    details: d.condition || d.name || '',
  })
}
