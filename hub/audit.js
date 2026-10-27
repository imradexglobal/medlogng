// Append-only audit trail for hub-delivered writes.
//
// The Admin SDK bypasses Security Rules, so the hub must leave a record of
// every change it makes with the verified user, hospital, operation, time and
// record id. Audit is best-effort: a failed audit write must never block a
// clinical handoff, but it is logged loudly so the gap is visible.
//
// Field names match src/services/adminService.js listAudit():
//   actor_organization_id + occurredAt drive the Administration → Audit view.
//
// Never logged: passwords, tokens, full patient records, or free-text notes.

import { FieldValue } from 'firebase-admin/firestore'

export const ACTIONS = {
  DELIVERED: 'hub.op.delivered',
  FAILED: 'hub.op.failed',
}

export function createAuditor({ db = null, log = console } = {}) {
  async function record({ action, op, result = null, error = null }) {
    if (!db) return false
    const actor = op?.actor && typeof op.actor === 'object' ? op.actor : {}
    const doc = {
      action,
      actor_user_id: actor.uid || null,
      actor_email: actor.email || null,
      actor_name: actor.name || null,
      // AdminView queries this field; keep it independent of organization_id.
      actor_organization_id: op?.orgId || '',
      organization_id: op?.orgId || '',
      source: 'lan-hub',
      operation: op?.kind || '',
      client_op_key: op?.clientOpKey || '',
      record_id: result?.id || '',
      replayed: result?.deduped === true,
      details: error ? String(error).slice(0, 300) : '',
      occurredAt: FieldValue.serverTimestamp(),
    }
    try {
      await db.collection('audit_events').add(doc)
      return true
    } catch (e) {
      log.warn?.('[hub] audit write failed:', String(e?.message || e))
      return false
    }
  }

  return {
    delivered(op, result) {
      return record({ action: ACTIONS.DELIVERED, op, result })
    },
    failed(op, error) {
      return record({ action: ACTIONS.FAILED, op, error })
    },
  }
}
