import './styles.css'
import './app.css'
import { auth } from './firebase.js'
import { authStore } from './store/authStore.js'
import { initAuthListener, attemptOfflineLogin, saveLastLogin, refreshSession } from './services/authService.js'
import { primePayers } from './services/payerService.js'
import { registerRoute, initRouter, handleRoute, navigate, setGuard } from './router.js'
import { checkAccess, startAccessWatch } from './services/authService.js'
import { startIdleWatch } from './services/idleService.js'
import { initUpdater } from './components/updater.js'
import { startOutboxSync } from './services/clinicalOutbox.js'
import { installChunkRecovery } from './lib/chunkRecovery.js'

// Views are loaded on demand (see registerRoute in router.js). Login is pulled
// in eagerly because it is the screen a cold, signed-out load lands on.
import { LoginView } from './views/LoginView.js'

const DashboardView = () => import('./views/DashboardView.js').then((m) => m.DashboardView)
const RegisterView = () => import('./views/RegisterView.js').then((m) => m.RegisterView)
const PatientsView = () => import('./views/PatientsView.js').then((m) => m.PatientsView)
const PatientDetailView = () => import('./views/PatientDetailView.js').then((m) => m.PatientDetailView)
const RegisterPatientView = () => import('./views/RegisterPatientView.js').then((m) => m.RegisterPatientView)
const EditPatientView = () => import('./views/EditPatientView.js').then((m) => m.EditPatientView)
const AppointmentsView = () => import('./views/AppointmentsView.js').then((m) => m.AppointmentsView)
const ConsultationsView = () => import('./views/ConsultationsView.js').then((m) => m.ConsultationsView)
const AdmissionsView = () => import('./views/AdmissionsView.js').then((m) => m.AdmissionsView)
const AdmitView = () => import('./views/AdmitView.js').then((m) => m.AdmitView)
const AdmissionWorkspaceView = () => import('./views/AdmissionWorkspaceView.js').then((m) => m.AdmissionWorkspaceView)
const LaboratoryView = () => import('./views/LaboratoryView.js').then((m) => m.LaboratoryView)
const LabNewOrderView = () => import('./views/LabNewOrderView.js').then((m) => m.LabNewOrderView)
const LabOrderView = () => import('./views/LabOrderView.js').then((m) => m.LabOrderView)
const LabResultView = () => import('./views/LabResultView.js').then((m) => m.LabResultView)
const LabCatalogueView = () => import('./views/LabCatalogueView.js').then((m) => m.LabCatalogueView)
const PharmacyView = () => import('./views/PharmacyView.js').then((m) => m.PharmacyView)
const PharmacyDrugFormView = () => import('./views/PharmacyDrugFormView.js').then((m) => m.PharmacyDrugFormView)
const PharmacyReceiveView = () => import('./views/PharmacyReceiveView.js').then((m) => m.PharmacyReceiveView)
const PharmacyRequestView = () => import('./views/PharmacyRequestView.js').then((m) => m.PharmacyRequestView)
const BillingView = () => import('./views/BillingView.jsx').then((m) => m.default)
const InvoiceDetailView = () => import('./views/InvoiceDetailView.js').then((m) => m.InvoiceDetailView)
const ReportsView = () => import('./views/ReportsView.js').then((m) => m.ReportsView)
const AdminView = () => import('./views/AdminView.js').then((m) => m.AdminView)
const VerifyEmailView = () => import('./views/VerifyEmailView.js').then((m) => m.VerifyEmailView)
const ChangePasswordView = () => import('./views/ChangePasswordView.js').then((m) => m.ChangePasswordView)

registerRoute('/login', async () => LoginView, { guest: true })
registerRoute('/register', RegisterView, { guest: true })
registerRoute('/', DashboardView, { auth: true })
registerRoute('/welcome', DashboardView, { auth: true })
registerRoute('/patients', PatientsView, { auth: true })
registerRoute('/patients/new', RegisterPatientView, { auth: true })
registerRoute('/patients/:id', PatientDetailView, { auth: true })
registerRoute('/patients/:id/edit', EditPatientView, { auth: true })
registerRoute('/appointments', AppointmentsView, { auth: true })
registerRoute('/consultations', ConsultationsView, { auth: true })
// `/admissions/new` must be registered before `/admissions/:id` — the router
// matches in registration order, and the wildcard would otherwise swallow
// "new", opening the workspace with id "new" ("admission could not be loaded").
registerRoute('/admissions/new', AdmitView, { auth: true })
registerRoute('/admissions/:id', AdmissionWorkspaceView, { auth: true })
registerRoute('/admissions', AdmissionsView, { auth: true })
registerRoute('/laboratory', LaboratoryView, { auth: true })
registerRoute('/laboratory/new', LabNewOrderView, { auth: true })
registerRoute('/laboratory/catalogue', LabCatalogueView, { auth: true })
registerRoute('/laboratory/catalogue/:id', LabCatalogueView, { auth: true })
registerRoute('/laboratory/orders/:id/items/:itemId', LabResultView, { auth: true })
registerRoute('/laboratory/orders/:id', LabOrderView, { auth: true })
registerRoute('/pharmacy', PharmacyView, { auth: true })
registerRoute('/pharmacy/drugs/new', PharmacyDrugFormView, { auth: true })
registerRoute('/pharmacy/drugs/:id', PharmacyDrugFormView, { auth: true })
registerRoute('/pharmacy/receive', PharmacyReceiveView, { auth: true })
registerRoute('/pharmacy/requests/:id', PharmacyRequestView, { auth: true })
registerRoute('/billing', BillingView, { auth: true })
registerRoute('/billing/:id', InvoiceDetailView, { auth: true })
registerRoute('/reports', ReportsView, { auth: true })
registerRoute('/admin', AdminView, { auth: true })
registerRoute('/verify-email', VerifyEmailView, { auth: true })
registerRoute('/change-password', ChangePasswordView, { auth: true })

// Emailed action links land on a plain URL — /reset?mode=resetPassword&oobCode=…
// — a hash router reads only location.hash, so without this fold the reset
// parameters are invisible and the user sees the ordinary log-in screen.
// Runs before the router is initialised so the first render is already the
// reset screen.
function foldResetLinkIntoHash() {
  let q
  try { q = new URLSearchParams(window.location.search) } catch { return }
  if (q.get('mode') !== 'resetPassword' || !q.get('oobCode')) return
  const hash = '#/login?mode=resetPassword&oobCode=' + encodeURIComponent(q.get('oobCode'))
  try {
    // replaceState (not location.hash =): no reload, no history entry, and the
    // one-time code leaves the address bar in the same tick.
    window.history.replaceState(null, '', window.location.pathname + hash)
  } catch {
    window.location.hash = hash
  }
}

foldResetLinkIntoHash()

setGuard(checkAccess)

// Re-route once auth state is ready (login persistence across reloads).
let booted = false
authStore.subscribe(async (s) => {
  if (!s.ready || booted) return
  booted = true
  // Attempt offline login with last saved user if we are not already signed in.
  // This allows the last logged-in user to use the app offline.
  if (!s.user) {
    const wasSignedIn = await attemptOfflineLogin()
    if (wasSignedIn) {
      // Refresh session after attempted auto-login
      await refreshSession()
    }
  }
  // Wait briefly for the auth token to be ready (ID token refreshed) before
  // priming payers — avoids "Missing or insufficient permissions" on the
  // first read when the token hasn't propagated yet. Offline (or a dead
  // connection) must not stall on this: race the refresh against a short
  // timeout and prime either way — listPayers serves the localStorage
  // snapshot when Firestore is unreachable.
  const tokenReady = auth.currentUser?.getIdToken().catch(() => {})
  if (tokenReady && navigator.onLine !== false) {
    Promise.race([
      tokenReady,
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]).then(() => primePayers()).catch(() => primePayers())
  } else {
    primePayers()
  }
  const hash = (window.location.hash || '').replace(/^#/, '')
  if (!hash || hash === '/' || hash === '/welcome') {
    const target = s.user ? '/' : '/login'
    navigate(target)
    // navigate() only fires hashchange when the hash actually changes. If we
    // are already sitting on the target (e.g. cold load at #/ while signed in),
    // no event will arrive, so render here instead. Calling it unconditionally
    // would enter the same route twice and mount the view twice.
    if (window.location.hash.replace(/^#/, '') === target) handleRoute()
  } else {
    handleRoute()
  }
})

initRouter()
installChunkRecovery()
initAuthListener()
startAccessWatch()
startIdleWatch()
initUpdater()
startOutboxSync() // retry queued cross-department handoffs (offline -> online)
handleRoute()

// Register the app-shell service worker (web only, production only). Skipped
// in Electron (loads from file://, no SW support) and dev (no caching during
// HMR). Firestore's own offline cache lives in IndexedDB and is independent
// of this — the SW only makes the HTML/JS/CSS shell available offline.
if (import.meta.env.PROD && 'serviceWorker' in navigator &&
    !navigator.userAgent.includes('Electron')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
      // Periodically check for Host app updates every 15 minutes
      setInterval(() => {
        try { reg.update() } catch (e) {}
      }, 15 * 60 * 1000)

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing
        if (sw) {
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] New app version available from Host!')
              try { window.__medilogUpdate?.({ ready: true, version: 'new' }) } catch (e) {}
            }
          })
        }
      })
    }).catch(() => {
      /* offline support degrades to Firestore's data cache only */
    })
  })
}
