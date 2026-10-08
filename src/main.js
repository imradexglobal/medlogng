import './styles.css'
import './app.css'
import { auth } from './firebase.js'
import { authStore } from './store/authStore.js'
import { initAuthListener } from './services/authService.js'
import { primePayers } from './services/payerService.js'
import { registerRoute, initRouter, handleRoute, navigate, setGuard } from './router.js'
import { checkAccess, startAccessWatch } from './services/authService.js'
import { LoginView } from './views/LoginView.js'
import { RegisterView } from './views/RegisterView.js'
import { DashboardView } from './views/DashboardView.js'
import { PatientsView } from './views/PatientsView.js'
import { PatientDetailView } from './views/PatientDetailView.js'
import { RegisterPatientView } from './views/RegisterPatientView.js'
import { EditPatientView } from './views/EditPatientView.js'
import { AppointmentsView } from './views/AppointmentsView.js'
import { ConsultationsView } from './views/ConsultationsView.js'
import { AdmissionsView } from './views/AdmissionsView.js'
import { LaboratoryView } from './views/LaboratoryView.js'
import { PharmacyView } from './views/PharmacyView.js'
import { BillingView } from './views/BillingView.js'
import { InvoiceDetailView } from './views/InvoiceDetailView.js'
import { ReportsView } from './views/ReportsView.js'
import { AdminView } from './views/AdminView.js'
import { VerifyEmailView } from './views/VerifyEmailView.js'
import { ChangePasswordView } from './views/ChangePasswordView.js'
import { initUpdater } from './components/updater.js'

registerRoute('/login', LoginView, { guest: true })
registerRoute('/register', RegisterView, { guest: true })
registerRoute('/', DashboardView, { auth: true })
registerRoute('/welcome', DashboardView, { auth: true })
registerRoute('/patients', PatientsView, { auth: true })
registerRoute('/patients/new', RegisterPatientView, { auth: true })
registerRoute('/patients/:id', PatientDetailView, { auth: true })
registerRoute('/patients/:id/edit', EditPatientView, { auth: true })
registerRoute('/appointments', AppointmentsView, { auth: true })
registerRoute('/consultations', ConsultationsView, { auth: true })
registerRoute('/admissions', AdmissionsView, { auth: true })
registerRoute('/laboratory', LaboratoryView, { auth: true })
registerRoute('/pharmacy', PharmacyView, { auth: true })
registerRoute('/billing', BillingView, { auth: true })
registerRoute('/billing/:id', InvoiceDetailView, { auth: true })
registerRoute('/reports', ReportsView, { auth: true })
registerRoute('/admin', AdminView, { auth: true })
registerRoute('/verify-email', VerifyEmailView, { auth: true })
registerRoute('/change-password', ChangePasswordView, { auth: true })

setGuard(checkAccess)

// Re-route once auth state is ready (login persistence across reloads).
let booted = false
authStore.subscribe((s) => {
  if (!s.ready || booted) return
  booted = true
  // Wait for auth token to be fully ready (ID token refreshed) before
  // priming payers — avoids "Missing or insufficient permissions" on the
  // first read when the token hasn't propagated yet.
  auth.currentUser?.getIdToken().then(() => {
    primePayers()
  }).catch(() => {
    primePayers()
  })
  const hash = (window.location.hash || '').replace(/^#/, '')
  if (!hash || hash === '/' || hash === '/welcome') {
    navigate(s.user ? '/' : '/login')
    // If hash didn't change (e.g. already at #/), handleRoute won't fire
    // via hashchange — call it directly.
    handleRoute()
  } else {
    handleRoute()
  }
})

initRouter()
initAuthListener()
startAccessWatch()
initUpdater()
handleRoute()
