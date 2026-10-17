# MediLog NG — Hospital LAN Hub

The hub is the hospital's own "post office + branch office" inside the
building:

```
Ward PC (Chrome) ──> HOST PC (MediLog NG Host app) ──internet──> Firebase
                          │
                          └── internet down? The app still opens on every
                              PC, and handoffs wait safely on the host's
                              disk until the line is back.
```

Ward PCs load the EMR **from the host** (`http://<host-ip>:8787`) and their
offline handoffs post back to the same address — one port, zero browser
obstacles, zero configuration on ward PCs.

---

## Easiest path: the Host app (recommended)

Build the installer once (on the development machine):

```powershell
npm install
npm run dist:host        # -> release\MediLogHost-Setup-x.y.z.exe
```

Then on the hospital's host PC (the one that stays on):

1. Double-click `MediLogHost-Setup…exe` → Next → Finish
2. The setup wizard opens:
   - **Step 1** — choose the Firebase service-account JSON key file
   - **Step 2** — *Open firewall* (Windows asks permission once → Yes)
   - **Step 3** — *Finish setup*. The screen shows the address other PCs
     will use, e.g. `http://192.168.1.50:8787`
3. A tray icon appears near the clock. Green = all synced.

On every ward PC: open Chrome → the address from step 3 → log in →
bookmark it. Done. (The host hands each browser the sync secret inside the
page automatically — nobody ever types a token.)

The tray menu: *Open MediLog NG · Start with Windows (toggle) · Open data
folder · Quit*. Closing the window keeps the server running; only tray →
*Quit* stops it.

Uninstalling deletes the host data folder (key, config, queue) — export
anything you need first (tray → *Open data folder*).

---

## Advanced: running the hub without the app (development)

The same server runs standalone from the repo. It also serves `dist/` when
present (same behaviour as the host app).

```powershell
# 1. one-time setup
npm install
copy <service-account>.json hub\keys\service-account.json
# create .env in the project root:
#   HUB_TOKEN=long-random-string
#   PORT=8787

# 2. firewall (once, admin PowerShell)
netsh advfirewall firewall add rule name="MediLog NG Host" dir=in action=allow protocol=TCP localport=8787

# 3. run
npm run build     # so dist/ exists
npm run hub
```

Health check from any device: open `http://<hub-PC-IP>:8787/health` — you
want `"firestoreReady": true`, `"internet": true`, `"servesApp": true`.

For long-running installs use pm2:

```powershell
npm install -g pm2
pm2 start npm --name medilogng-hub -- run hub
pm2 save
pm2 startup        # follow the line it prints
```

### Pointing an existing hosted build at a standalone hub

Only needed when the page is **not** served from the hub (e.g. testing from
`https://medlogng.web.app` — note browsers may block that combination as
mixed content; serving from the hub avoids it entirely):

```js
localStorage.setItem('medilogng.hubUrl', 'http://192.168.1.50:8787')
localStorage.setItem('medilogng.hubToken', 'same-value-as-HUB_TOKEN')
```

---

## Tests

```powershell
npm run test:hub             # needs the Firestore emulator running:
firebase emulators:start --only firestore
```

Covers token auth, durable queueing, duplicate rejection, relay delivery,
replay dedup (no doubled quantities), line merging, permanent errors, and
app serving (SPA fallback, token injection, no-cache headers, traversal
refusal). Skips cleanly when the emulator is not running.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Tray says "check the key file" | Re-run setup: delete `host-config.json` in the data folder (tray → *Open data folder* → up one level) and relaunch |
| `firestoreReady: false` in `/health` | Key file missing/wrong — import it again via the wizard |
| `queue.queued` keeps growing | `lastProbeError` in `/health` explains why it cannot reach Firestore |
| `queue.error` > 0 | A bad op needs attention — see `lastError` inside the host data folder's `queue.json` |
| Ward PC cannot open the address | Firewall (wizard step 2)? Same network/WiFi? `curl http://<ip>:8787/health` from the ward PC |
| Ward PC handoffs not syncing | DevTools console: look for `[handoff] delivered via hospital hub` — a `401` means the page is not from this host (stale tab — reload) |

The queue survives host restarts and power cuts — `queue.json` is rewritten
atomically on every change.

**Do not port-forward 8787 on the hospital router.** The hub is meant for
the building's own network only.
