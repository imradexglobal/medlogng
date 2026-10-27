import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

// The Firebase web config is inlined into the bundle at build time. A build
// without it produces an app that boots to "Firebase web config missing" and
// `auth/invalid-api-key` — which is exactly what happened on a redeploy from a
// machine whose .env.local was absent. Fail the build instead of shipping that.
const REQUIRED_FIREBASE_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const missing = REQUIRED_FIREBASE_ENV.filter((key) => !env[key])
  if (missing.length) {
    throw new Error(
      '[config] Missing Firebase web config: ' + missing.join(', ') +
      '\nCopy .env.example to .env.local and fill the VITE_FIREBASE_* keys. ' +
      'Refusing to build a bundle that cannot sign in.'
    )
  }

  return {
    base: './',
    server: {
      port: 5174,
      strictPort: false,
      hmr: {
        host: 'localhost',
      },
    },
    preview: {
      port: 5174,
    },
    resolve: {
      alias: [],
    },
    plugins: [
      {
        // @firebase/util@1.15.x browser bundle does `import ... from
        // './postinstall.mjs'` but the published package omits that file, so
        // Rollup cannot resolve it. Intercept the import and point at a
        // null-stub (Firestore only uses it as a fallback source of defaults).
        name: 'firebase-util-postinstall-stub',
        resolveId(source, importer) {
          if (source === './postinstall.mjs' &&
              importer &&
              importer.includes('@firebase' + '/util' + '/dist/index.esm.js')) {
            return fileURLToPath(new URL('vendor/firebase-util-postinstall.mjs', import.meta.url))
          }
        },
      },
    ],
    optimizeDeps: {
      // sql.js ships a CommonJS/UMD browser build (module.exports.default). It
      // must be pre-bundled so esbuild adds the CJS->ESM default interop that
      // `import initSqlJs from 'sql.js'` relies on. The wasm itself is still
      // loaded separately via the `?url` import in bulkDataService.js.
      include: ['sql.js'],
    },
    build: {
      outDir: 'dist',
      target: 'es2017',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('firebase')) return 'vendor-firebase';
              return 'vendor';
            }
          }
        }
      }
    },
  }
})
