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
    // Only one active hospital — set it as active and go to the dashboard.
    // This branch used to navigate to '/' without ever calling setActiveOrg,
    // so a single-hospital user landed on DashboardView with activeOrg == null
    // and saw "your account is not linked to a hospital" despite having a
    // membership. The store starts null on every fresh load, so it MUST be
    // written here (and on every boot, via the router).
    const only = activeMemberships[0]
    if (only) {
      try {
        const org = await loadOrganization(only.organization_id)
        await setActiveOrg(only.organization_id, org?.name || only.organization_id)
      } catch {}
    }
    // Only navigate to '/' if activeOrg was set; otherwise go to hospital-choice
    // so the user can select their hospital. This handles the case where the
    // auth listener's membership race condition clears activeOrg before it's saved.
    const { activeOrg: currentActiveOrg } = authStore.getState()
    if (currentActiveOrg) {
      navigate('/')
    } else {
      navigate('/hospital-choice')
    }
    return
  }

  // Resolve each hospital independently so every option shows its own name.
  const orgNames = await Promise.all(activeMemberships.map(async (m) => {
    const org = await loadOrganization(m.organization_id)
    return [m.organization_id, org?.name || m.organization_id]
  }))
  const nameByOrgId = new Map(orgNames)
  let hospitalOptions = ''
  activeMemberships.forEach((m) => {
    const isCurrent = m.organization_id === activeOrg
    hospitalOptions += '<option value="' + esc(m.organization_id) + '"' + (isCurrent ? ' selected' : '') + '>'
    hospitalOptions += esc(nameByOrgId.get(m.organization_id) || m.organization_id)
    hospitalOptions += ' (' + esc(m.role || 'member') + ')</option>'
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