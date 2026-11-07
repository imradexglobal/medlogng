// Read-only in-app preview for laboratory reports.
// Uses the same structured report template as printing, without opening a print dialog.
import { openModal, toast } from './shell.js'
import { authStore } from '../store/authStore.js'
import { getLabOrder } from '../services/laboratoryService.js'
import { getLabSettings } from '../services/labCatalogueService.js'
import { getPatient } from '../services/patientService.js'
import { labReportHtml } from '../lib/labPrintTemplates.js'
import { esc } from '../utils/sanitize.js'

export async function openLabReport(orderId) {
  const id = typeof orderId === 'object' && orderId ? orderId.id : orderId
  if (!id) {
    toast('Could not identify this lab order')
    return
  }

  let order
  try {
    order = await getLabOrder(id)
  } catch (error) {
    toast(error?.message || 'Could not load the laboratory report')
    return
  }
  if (!order) {
    toast('This lab order could not be found')
    return
  }

  const { activeOrg, activeOrgName } = authStore.getState()
  const [labSettings, patient] = await Promise.all([
    getLabSettings(activeOrg).catch(() => null),
    order.patientId ? getPatient(order.patientId).catch(() => null) : Promise.resolve(null),
  ])
  const report = labReportHtml(order, {
    hospitalName: activeOrgName,
    labSettings,
    patient,
    preview: true,
  })

  openModal('Laboratory report · ' + (order.orderNo || String(order.id).slice(0, 8)),
    '<div class="lab-report-preview"><div class="lab-report-sheet">' + report + '</div></div>' +
    '<div class="mrow" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" type="button" data-close>Close</button></div>',
    { wide: true })
  const card = document.querySelector('#modal .modal-card')
  if (card) card.style.maxWidth = 'min(1000px, calc(100vw - 32px))'
}
