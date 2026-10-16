// Pure (no Firebase) plan‑item domain helpers for the Admission Session.
// Mirrors the pattern of features/admissions/domain.js and features/encounters/domain.js.

export const PLAN_TYPES = [
  'assessment',
  'investigation',
  'imaging',
  'treatment',
  'medication',
  'monitoring',
  'nursing',
  'diet',
  'activity',
  'referral',
  'followup',
  'other',
]

export const PLAN_STATUSES = ['planned', 'in-progress', 'completed', 'cancelled', 'removed']

export function planStatus(raw) {
  if (!raw || typeof raw !== 'object') return 'planned'
  const key = String(raw.status || '').trim().toLowerCase()
  const map = {
    planned: 'planned',
    inprogress: 'in-progress',
    in_progress: 'in-progress',
    'in-progress': 'in-progress',
    completed: 'completed',
    cancelled: 'cancelled',
    removed: 'removed',
  }
  return map[key] || 'planned'
}

export function isPlanCompleted(raw) {
  return planStatus(raw) === 'completed'
}

export function isPlanRemoved(raw) {
  return planStatus(raw) === 'removed'
}

export function validatePlanItem(v) {
  const values = v || {}
  const errors = []

  if (!String(values.type || '').trim()) errors.push('Plan type is required.')
  if (!String(values.round || '').trim()) errors.push('Round number is required.')
  if (!String(values.text || '').trim()) errors.push('Plan item text is required.')

  const type = String(values.type || '').trim().toLowerCase()
  if (!PLAN_TYPES.includes(type)) errors.push(`Invalid plan type: "${type}". Must be one of: ${PLAN_TYPES.join(', ')}`)

  return errors.length === 0 ? null : errors
}

export function groupByPlanType(items) {
  const groups = {}
  for (const item of items || []) {
    const type = isPlanRemoved(item) ? 'removed' : (planStatus(item) || 'planned')
    if (!groups[type]) groups[type] = []
    groups[type].push(item)
  }
  // Preserve the PLAN_TYPES order, plus a 'removed' bucket at the end
  const ordered = [...PLAN_TYPES, 'removed'].filter((t) => groups[t] || t === 'removed')
  const result = {}
  for (const t of ordered) result[t] = groups[t] || []
  return result
}

// Merge admission record + plan items + lab orders + imaging orders + medication requests
// + invoices into a single timeline for the AdmissionWorkspaceView.
export function buildSessionTimeline(admission, planItems, labOrders, imagingOrders, medicationRequests, invoices) {
  const rows = []

  // Admission start / discharge
  if (admission) {
    rows.push({
      id: 'admit',
      title: 'Admission',
      type: 'session-milestone',
      timestamp: admission.admissionDate || 0,
      status: isPlanCompleted(admission) ? 'completed' : 'active',
      metadata: { ward: admission.wardName, bed: admission.bedNumber, encounter: admission.encounterId },
    })
    if (admission.dischargeDate) {
      rows.push({
        id: 'discharge',
        title: 'Discharge',
        type: 'session-milestone',
        timestamp: admission.dischargeDate,
        status: 'completed',
        metadata: { reason: admission.dischargeReason },
      })
    }
  }

  // Plan items
  const planByType = groupByPlanType(planItems || [])
  for (const type of PLAN_TYPES) {
    for (const item of planByType[type] || []) {
      const created = item.created_at || item.at || 0
      rows.push({
        id: item.id,
        title: String(item.text || '').substring(0, 50),
        type: 'plan-item',
        subtype: type,
        timestamp: created,
        status: planStatus(item),
        metadata: { round: item.round, by: item.updated_by_name || item.created_by_name || '' },
      })
    }
    // Show removed items collapsed
    for (const item of (planByType['removed'] || []) || []) {
      const created = item.created_at || item.at || 0
      rows.push({
        id: item.id + '-removed',
        title: `— ${String(item.text || '').substring(0, 30)}…`,
        type: 'plan-item',
        subtype: 'removed',
        timestamp: created,
        status: 'removed',
        metadata: { round: item.round },
      })
    }
  }

  // Lab orders
  const labs = labOrders || []
  for (const lo of labs) {
    const ordered = lo.ordered_at || lo.created_at || 0
    rows.push({
      id: lo.id,
      title: `Lab: ${String(lo.test_panel || 'tests')}`,
      type: 'lab-order',
      timestamp: ordered,
      status: lo.status || 'order',
      metadata: { priority: lo.priority, by: lo.ordered_by_name || '' },
    })
  }

  // Imaging orders
  const imaging = imagingOrders || []
  for (const io of imaging) {
    const ordered = io.ordered_at || io.created_at || 0
    rows.push({
      id: io.id,
      title: `Imaging: ${String(io.modality || 'study')}`,
      type: 'imaging-order',
      timestamp: ordered,
      status: io.status || 'order',
      metadata: { priority: io.priority, by: io.ordered_by_name || '' },
    })
  }

  // Medication requests
  const meds = medicationRequests || []
  for (const mr of meds) {
    const ordered = mr.ordered_at || mr.created_at || 0
    rows.push({
      id: mr.id,
      title: `Med: ${String(mr.line || 'item')}`,
      type: 'medication-request',
      timestamp: ordered,
      status: mr.status || 'open',
      metadata: { by: mr.requested_by_name || '' },
    })
  }

  // Invoices
  const invs = invoices || []
  for (const inv of invs) {
    const created = inv.created_at || 0
    rows.push({
      id: inv.id,
      title: `Charge: ${String(inv.item || 'item')}`,
      type: 'invoice',
      timestamp: created,
      status: inv.status || 'unpaid',
      metadata: { amount: inv.amount, by: inv.charged_by_name || '' },
    })
  }

  // Sort descending by timestamp (newest first), stable sort keeps creation order for ties
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  return rows
}

export function nextRound(admission, existingPlanItems) {
  // The round number for a new plan item is max(existing rounds) + 1,
  // or 1 if there are no existing items. Round 1 = initial admission plan.
  const all = existingPlanItems || []
  const rounds = all.map((item) => {
    const r = Number(item.round || 0)
    return Number.isFinite(r) ? r : 1
  })
  const max = rounds.length ? Math.max(...rounds) : 1
  return max + 1
}