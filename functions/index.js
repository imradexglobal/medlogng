import { initializeApp, getApps } from 'firebase-admin/app'

if (!getApps().length) initializeApp()

// No callable clinical-draft or AI functions are deployed.
