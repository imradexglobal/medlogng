# Enable differential updates for GitHub releases

## Problem
`differentialPackage: false` in both NSIS configs forces electron-updater to download the entire installer on every release, instead of only changed blocks.

## Changes
- `electron-builder.yml` (nsis.differentialPackage): false → true
- `electron-builder.host.yml` (nsis.differentialPackage): false → true

## Validation
- Rebuild with `npm run publish:desktop` / `publish:host`, confirm `latest.yml`/`host.yml` include differential block entries.
- Test update on an installed prior version; verify only delta downloaded.
