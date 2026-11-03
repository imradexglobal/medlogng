# Plan: Host update behavior and first-run wizard skip

## Problem
1. Auto-updater downloads an update even when GitHub's latest release (1.2.4) is lower than installed app (1.2.8).
2. Reinstalling the host installer no longer shows the first-run wizard (Firebase key, firewall, HTTPS).

## Root causes
- `deleteAppDataOnUninstall: false` in `electron-builder.host.yml` preserves `%APPDATA%/MediLog NG Host` across uninstalls, so `hostConfig` (wizard done flag) remains and the wizard is skipped on reinstall.
- Updater likely uses a different channel/tag or `autoUpdater` is checking a higher version from a cached/published release; `publish:host` publishes to GitHub channel `host`. If a `host` channel release > 1.2.8 exists, it will download.

## Plan
1. Add a "Reset setup" / force-wizard flag in `electron/main.js` (e.g. `--reset-setup` or env `MEDLOG_RESET_SETUP=1`) that deletes the host config store before showing the wizard; document in `build-host.bat` notes.
2. Optional: make uninstall remove host config by setting `deleteAppDataOnUninstall: true` only for host (or add a separate "clean uninstall" installer variant). Tradeoff: loses clinical operational data; not recommended.
3. Verify updater: print `autoUpdater.getFeedURL()` and latest version in logs; ensure GitHub `host` channel has no release > 1.2.8 before testing; bump and publish `1.2.8` to `host` channel so installed and published versions match.
4. Add a version-guard in update check: if `latestVersion <= app.getVersion()`, skip download.

## Validation
- Install 1.2.8, confirm no update check downloads when GitHub host channel latest is 1.2.8.
- Fresh install (clean userData) shows wizard steps 1–3.
- Reinstall with `MEDLOG_RESET_SETUP=1` shows wizard.

## Out of scope
- Code changes require switching to implementation agent.
