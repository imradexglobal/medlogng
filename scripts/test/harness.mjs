// Test harness for the Firestore-writing services.
//
// Loads the REAL src/ modules (nothing is copied) with `../firebase.js` swapped
// for an in-memory fake, so transactions actually execute. Auth state is set
// through the real authStore so the capability gates are exercised too.

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./fake-firebase-loader.mjs', import.meta.url)

const { authStore } = await import('../../src/store/authStore.js')
const { resetFake, __fake } = await import('./fake-firebase.js')
const { ROLE_CAPS } = await import('../../src/features/admin/roles.js')

// Signs in as a member with the given role, and selects an org.
//
// The membership carries an explicit `capabilities` array because `can()` reads
// that field off the doc — real membership docs are written with ROLE_CAPS
// resolved at creation time, so a test membership that omits it would fail
// every capability gate and prove nothing.
export async function signIn(role = 'pharmacist', orgId = 'org_1') {
  authStore.setState({
    user: { uid: 'u1', email: 'user@hospital.ng', displayName: 'Test User' },
    memberships: [{
      organization_id: orgId,
      user_id: 'u1',
      role,
      status: 'active',
      capabilities: ROLE_CAPS[role] || [],
    }],
    activeOrg: orgId,
    activeOrgName: 'Test Hospital',
    ready: true,
  })
  return authStore
}

export function seedDocs(docs) {
  resetFake({ docs })
}

export function docData(path) {
  return __fake.docs.get(path)
}

export function allDocs(prefix) {
  const out = []
  for (const [path, data] of __fake.docs) {
    if (path.startsWith(prefix + '/')) out.push({ path, data })
  }
  return out
}

export { __fake, authStore }

// Convenience for asserting a Firestore transaction was not left half-applied.
export function docCount(prefix) {
  return allDocs(prefix).length
}