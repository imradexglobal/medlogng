// Stub for a known upstream packaging bug: @firebase/util@1.15.x ships
// dist/index.esm.js with `import { getDefaultsFromPostinstall } from
// './postinstall.mjs'` but the published tarball only contains
// postinstall.js, so Vite/Rollup cannot resolve it. This module satisfies
// that import without pulling in the postinstall side-effect. (Firestore
// uses it only as a fallback source of app defaults; returning null is safe.)
export function getDefaultsFromPostinstall() {
  return null
}