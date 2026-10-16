import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
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
})
