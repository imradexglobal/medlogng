// Pure encounter workflow rules — no Firebase imports (unit-testable).
// Same pattern as features/orgs/domain.js and features/admin/roles.js.

// Canonical workflow order: Arrival → Vitals → Consultation → Diagnosis →
// Plan → Close. `closed` is terminal — the flow never reopens.
export const ENCOUNTER_STATUS_FLOW = ['arrived', 'vitals-taken', 'in-consultation', 'diagnosed', 'planned', 'closed']

// Which stage each clinical action proves has been reached. Saving a note
// means the patient is being consulted; a diagnosis means the assessment is
// done; a plan, prescription or lab order means the treatment plan is set.
//
// Vitals is deliberately NOT here: vitals is triage, so
// `recordEncounterVitals` targets `vitals-taken` itself while also writing the
// vitals block, rather than funneling through this trigger map.
const STATUS_TRIGGERS = {
  'in-consultation': ['note'],
  diagnosed: ['diagnosis'],
  planned: ['plan', 'prescription', 'lab_order'],
}

// Pure clamp: whichever of `current`/`target` is farther along the flow wins.
// Never regresses — re-recording vitals on a diagnosed encounter does not drag
// it back to `vitals-taken`. An unknown current (e.g. legacy `Open`) adopts the
// target; `closed` always wins, and a closed encounter can never be reopened.
export function furtherStatus(current, target) {
  if (target === 'closed') return 'closed'
  if (current === 'closed') return current
  const ci = ENCOUNTER_STATUS_FLOW.indexOf(current)
  const ti = ENCOUNTER_STATUS_FLOW.indexOf(target)
  if (ti < 0) return current
  return (ci < 0 || ti > ci) ? target : current
}

// The stage a given clinical action proves has been reached, or null when the
// action says nothing about workflow position.
export function stageForTrigger(trigger) {
  for (const [status, triggers] of Object.entries(STATUS_TRIGGERS)) {
    if (triggers.includes(trigger)) return status
  }
  return null
}

// Human-readable label + colour tone per status. Keys must cover
// ENCOUNTER_STATUS_FLOW; anything missing falls back to the raw key so a new
// status degrades gracefully instead of rendering "undefined".
const STATUS_META = {
  arrived: { label: 'Arrived', step: 'Arrival', tone: 'warn' },
  'vitals-taken': { label: 'Vitals taken', step: 'Vitals', tone: 'info' },
  'in-consultation': { label: 'In consultation', step: 'Consultation', tone: 'info' },
  diagnosed: { label: 'Diagnosed', step: 'Diagnosis', tone: 'info' },
  planned: { label: 'Plan set', step: 'Plan', tone: 'ok' },
  closed: { label: 'Closed', step: 'Close', tone: 'ok' },
}

// `[{ key, label, step, tone }]` in workflow order, so views can never drift
// out of sync with the order the service actually walks.
export const ENCOUNTER_STATUS_FLOW_META = ENCOUNTER_STATUS_FLOW.map((key) => ({
  key,
  ...(STATUS_META[key] || { label: key, step: key, tone: '' }),
}))
