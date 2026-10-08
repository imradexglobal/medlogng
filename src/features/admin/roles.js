// Fixed org role → capability map (pure, unit-testable, no Firebase imports).
// Capability strings MUST match firestore.rules exactly.

export const ROLE_CAPS = {
  hospital_admin: ['*'],
  doctor: [
    'patient.create',
    'patient.demographics.update',
    'encounter.create',
    'encounter.edit',
    'vitals.create',
    'diagnosis.create',
    'prescription.create',
    'lab.order',
    'lab.result.enter',
    'appointment.create',
    'beds.manage',
    'documents.upload',
  ],
  nurse: [
    'patient.create',
    'vitals.create',
    // Triage duty: recording vitals moves the queue forward from
    // `arrived` to `vitals-taken`. Deliberately narrow — it may only
    // write `status`/`updated_at` on the encounter (see firestore.rules),
    // never vitals, notes, diagnosis or plan.
    'encounter.status.advance',
    'appointment.create',
    'beds.manage',
    'documents.upload',
  ],
  pharmacist: [
    'prescription.dispense',
    'documents.upload',
  ],
  lab_scientist: [
    'lab.order',
    'lab.result.enter',
    'lab.result.verify',
  ],
  receptionist: [
    'patient.create',
    'appointment.create',
    'billing.invoice',
    'billing.payment',
  ],
  billing_officer: [
    'billing.invoice',
    'billing.payment',
  ],
  records_officer: [
    'patient.create',
    'patient.demographics.update',
    'appointment.create',
    'documents.upload',
  ],
}

export const ROLE_OPTIONS = Object.keys(ROLE_CAPS)

// Admin-only capabilities (used to gate the Administration page itself).
export const ADMIN_CAPS = ['admin.roles.manage', 'admin.devices.manage']

// At most this many ACTIVE hospital_admins per organization.
// Enforced in adminService (client); Firestore Rules cannot count docs,
// so this is documented as a known client-enforced limit + audit trail.
export const MAX_HOSPITAL_ADMINS = 2

// UX gate only — Firestore Security Rules remain the real authority.
export function can(membership, cap) {
  if (!membership || membership.status !== 'active') return false
  const caps = membership.capabilities || []
  return caps.includes('*') || caps.includes(cap)
}

export function isOrgAdmin(membership) {
  return can(membership, 'admin.roles.manage')
}

// Weak-password policy for the forced-change screen.
const WEAK = new Set(['123456', '12345678', '123456789', 'password', 'qwerty', 'medilog', 'hospital', '11111111', '00000000'])

export function validateNewPassword(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters'
  if (WEAK.has(pw.toLowerCase())) return 'That password is too common — choose a stronger one'
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and numbers together'
  return null
}

export function isValidEmail(email) {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
