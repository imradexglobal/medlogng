import { authStore } from '../store/authStore.js'
import { loadOrganization, setActiveOrg, logout } from '../services/authService.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'
import { BUILD_ID, BUILD_TIME } from '../buildInfo.js'
import { currentStaffName } from '../lib/staffName.js'

// Hospital choice view: shown when user belongs to multiple hospitals
export async function HospitalChoiceView(app) {
  const { user, memberships, activeOrg, activeOrgName } = authStore.getState()
  if (!user) { navigate('/login'); return }

  // Get only active memberships
  const activeMemberships = memberships.filter((m) => m.status === 'active')

  if (activeMemberships.length <= 1) {
    // Only one active hospital, go directly there
    if (activeOrg) {
      try { await setActiveOrg(activeOrg, activeOrgName || activeOrg) } catch {}
    }
    navigate('/')
    return
  }

  // Build hospital options
  let hospitalOptions = ''
  activeMemberships.forEach((m) => {
    const orgName = activeOrgName || m.organization_id // will be resolved async below
    const isCurrent = m.organization_id === activeOrg
    hospitalOptions += '<option value="' + m.organization_id + '"' + (isCurrent ? ' selected' : '') + '>'
    hospitalOptions += esc(m.organization_id || 'Unknown Hospital')
    hospitalOptions += ' (' + m.role + ') - ' + (m.status === 'active' ? 'active' : m.status) + '</option>'
  })

  app.innerHTML =
    '<div class="topbar"><strong>MedLogNg</strong>' +
    '<span>' + esc(currentStaffName() || user.email || '') + ' <button id="out" class="btn btn-ghost btn-sm">Sign out</button></span></div>' +
    '<div class="welcome"><div class="card welcome-card">' +
    '<p class="eyebrow">Select Hospital</p>' +
    '<h1>You belong to multiple hospitals</h1>' +
    '<p class="muted">Please select which hospital you want to work with:</p>' +
    '<select id="hospital-select" class="btn btn-ghost btn-sm">' + hospitalOptions + '</select>' +
    '</div></div>' +
    '<div class="build-stamp">MedLogNg v' + esc(BUILD_ID) + ' — built ' + esc(BUILD_TIME) + '</div>'

  // Hospital selection change handler
  const hospitalSelect = document.getElementById('hospital-select')
  if (hospitalSelect) {
    hospitalSelect.onchange = async (e) => {
      const newOrgId = e.target.value
      if (newOrgId) {
        try {
          const org = await loadOrganization(newOrgId)
          const orgName = org?.name || newOrgId
          await setActiveOrg(newOrgId, orgName)
        } catch {}
        navigate('/')
      }
    }
  }

  document.getElementById('out').onclick = async () => {
    const btn = document.getElementById('out')
    btn.disabled = true
    // Must be the real service logout: a bare navigate('/login') is useless
    // here because /login is a guest route, so the router bounces a still
    // signed-in user straight back to /welcome and the button looks dead.
    try {
      await logout()
    } finally {
      navigate('/login')
    }
  }
}