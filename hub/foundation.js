// Firebase Admin foundation for the hub.
//
// The old code initialised Firestore even when no credential existed, so the
// process printed "firestore ready", started listening, and then died as soon
// as Application Default Credentials were looked up. This module refuses to
// create a client it cannot authenticate:
//
//   FIRESTORE_EMULATOR_HOST          -> emulator (no key needed)
//   GOOGLE_APPLICATION_CREDENTIALS   -> that file (ADC)
//   KEY_FILE / hub/keys/...json      -> explicit service account
//   nothing                          -> { db: null, auth: null, error }
//
// A null db is not fatal for serving the app or /health, but every sensitive
// operation is denied (503) until credentials are fixed. That is the safe
// failure mode: never "start happily and crash on the first write".

import { existsSync } from 'node:fs'
import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

function makeApp(options) {
  const app = initializeApp(options)
  return {
    app,
    db: getFirestore(app),
    auth: getAuth(app),
    mode: '',
    error: '',
  }
}

export function initFoundation(cfg = {}, log = console) {
  // A previous initialisation in the same process (tests, Electron host) is
  // reused: firebase-admin allows exactly one default app.
  if (getApps().length) {
    const app = getApps()[0]
    try {
      return {
        app,
        db: getFirestore(app),
        auth: getAuth(app),
        mode: 'existing',
        error: '',
      }
    } catch (e) {
      return { app: null, db: null, auth: null, mode: 'error', error: String(e?.message || e) }
    }
  }

  if (cfg.emulator) {
    try {
      return { ...makeApp({ projectId: cfg.projectId }), mode: 'emulator' }
    } catch (e) {
      return { app: null, db: null, auth: null, mode: 'emulator', error: String(e?.message || e) }
    }
  }

  try {
    const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (adcPath) {
      if (!existsSync(adcPath)) {
        return {
          app: null, db: null, auth: null, mode: 'adc',
          error: 'GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist: ' + adcPath,
        }
      }
      log.info?.('[hub] using credentials from GOOGLE_APPLICATION_CREDENTIALS')
      return { ...makeApp({ credential: applicationDefault(), projectId: cfg.projectId }), mode: 'adc' }
    }

    if (cfg.keyFile && existsSync(cfg.keyFile)) {
      log.info?.('[hub] using service-account key: ' + cfg.keyFile)
      return { ...makeApp({ credential: cert(cfg.keyFile), projectId: cfg.projectId }), mode: 'key' }
    }

    return {
      app: null, db: null, auth: null, mode: 'none',
      error:
        'No Firebase credentials found. Import a service-account key in the Host setup wizard, ' +
        'point KEY_FILE at a key JSON file, set GOOGLE_APPLICATION_CREDENTIALS, or run the ' +
        'Firestore emulator (FIRESTORE_EMULATOR_HOST).',
    }
  } catch (e) {
    return { app: null, db: null, auth: null, mode: 'error', error: String(e?.message || e) }
  }
}

export function foundationSummary(foundation, cfg = {}) {
  if (!foundation || (!foundation.db && !foundation.auth)) {
    return 'firestore/auth NOT ready — ' + (foundation?.error || 'no credentials')
  }
  return 'firestore/auth ready (project ' + cfg.projectId + (cfg.emulator ? ', emulator ' + cfg.emulator : '') + ')'
}
