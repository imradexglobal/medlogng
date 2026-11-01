// Tiny observable store for the signed-in user + memberships (Layer 1 auth only).

const listeners = new Set

// Load state from localStorage on initialization
let savedState = null
try {
  savedState = JSON.parse(localStorage.getItem('medlogng_auth_state') || 'null')
} catch (e) {
  console.warn('Failed to load auth state from localStorage', e)
}

const state = {
  // Restore saved state, falling back to defaults
  user: savedState?.user ?? null,
  memberships: savedState?.memberships ?? [],
  activeOrg: savedState?.activeOrg ?? null,
  activeOrgName: savedState?.activeOrgName ?? '',
  ready: false,
}

export const authStore = {
  getState() {
    return state
  },
  setState(patch) {
    Object.assign(state, patch)
    // Save to localStorage
    try {
      localStorage.setItem('medlogng_auth_state', JSON.stringify(state))
    } catch (e) {
      console.warn('Failed to save auth state to localStorage', e)
    }
    listeners.forEach((fn) => {
      try { fn(state) } catch (e) { console.warn(e) }
    })
  },
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
