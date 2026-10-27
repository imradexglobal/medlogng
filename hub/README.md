# MediLog NG — Hospital LAN Hub (v2)

The hub is the hospital's own "post office + branch office" inside the building:

```
Ward PC (Chrome) ──> HOST PC (MediLog NG Hub) ──internet──> Firebase
                    │
                    └── internet down? The app still opens on every
                        PC, and handoffs wait safely on the host's
                        disk until the line is back.
```

Ward PCs load the EMR **from the host** (`http://<host-ip>:8787`) and
their offline handoffs post back to the same address — one port, zero
browser obstacles, zero configuration on ward PCs.

---

## Auth: Firebase ID token (no shared secret)

The hub no longer uses a shared secret (`HUB_TOKEN`). Ward PCs send the
signed-in user's Firebase ID token:

```
Authorization: Bearer <id_token>
```

The hub verifies the token signature and expiry with the Firebase Admin SDK,
then checks the caller's hospital membership document
(`organization_memberships/{orgId}_{uid}`) server-side. Each op kind maps
to a capability (`rx_mirror` → `prescription.create`, `lab_snapshot` →
`lab.order`), and every record the handler touches is checked for
organisation ownership.

**Old installs** that still have `HUB_TOKEN` in `.env` will see a startup
warning; remove the `HUB_TOKEN` line and any `VITE_HUB_TOKEN` from the
client build.

---

## LAN address detection

The hub now distinguishes three things:

| Address type | URL pattern | Reachable by |
|---|---|---|
| **Local** | `http://127.0.0.1:8787` | This PC only |
| **LAN** | `http://192.168.x.x:8787` (or other private IPv4) | Other devices on the same trusted Wi-Fi/LAN |
| **Listening addr** | the address the socket is bound to (`0.0.0.0` = all IPv4) | N/A |

The hub reports the LAN URL (best-first: private 192.168.x.x, then Wi-Fi,
then Ethernet). If no usable LAN address is detected, the operator gets
diagnostic lines with `ipconfig` guidance and a check that the network
profile is `Private` (not `Public`). APIPA (`169.254.x.x`) is never advertised
— that signal means the adapter never got a DHCP address.

---

## Startup diagnostics

On first run the hub logs an informative report, e.g.:

```
[hub] listening on 0.0.0.0:8787  (hub-2.0.0)
[hub] local URL: http://127.0.0.1:8787
[hub] LAN URL:   http://192.168.1.50:8787
[hub] other local IPv4 addresses: 10.0.0.1
[hub]   Other devices on the same trusted Wi-Fi/LAN should open the LAN URL.
[hub] authentication: Firebase ID token (Authorization: Bearer)
[hub] do not port-forward this port on the hospital router; it is for the trusted LAN only.
```

If the hub is bound to loopback only, or no LAN address is found, the log
includes clear steps to diagnose and fix the network configuration.

---

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Hub status + API summary |
| GET | `/health` | none (minimal) / Bearer (detail) | `{ok, version, hub, firestoreReady, internet, queue, ...}` |
| POST | `/outbox` | `Authorization: Bearer` | `{ ops: [...] }` → authorised, durably queued |

No wildcard CORS. The hub's own origin (the address the page was served
from) is always allowed. Extra origins may be listed via `ALLOWED_ORIGINS`
in the environment.

---

## Port conflicts

If the port is already in use, the hub prints a friendly error with Windows
diagnostics, e.g.:

```
Port 8787 is already in use. Another hub or program is listening there.
  Find it:  Get-NetTCPConnection -LocalPort 8787 -State Listen | Format-Table LocalAddress,OwningProcess
  Then either stop that program, or start this hub on another port:
  $env:PORT='8788'; npm run hub
```

---

## Firewall

The setup wizard adds a single Windows Firewall rule:

```
New-NetFirewallRule -DisplayName 'MediLog NG Host' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private
```

This allows inbound TCP on the hub port for the **Domain** and **Private**
network profiles only. It never opens a `Public` profile rule, which would
expose the hub on coffee‑shop Wi‑Fi. If the network is misclassified as
`Public`, the operator should fix the network profile in Windows (right‑click
the network icon → "Network and Internet settings") rather than weakening
this rule.

---

## Development & testing

- `npm run test:hub` — runs the hub smoke test suite (emulator required)
- `node scripts/test/netinfo.test.mjs` — network interface classification tests
- `node scripts/test/hub.auth.test.mjs` — auth module tests with fake authenticator
- `node scripts/test/hub.handlers.test.mjs` — handler logic tests with mock db
- Portable Node: `& "$env:LOCALAPPDATA\Temp\opencode\nodejs\node-v24.22.1-win-x64\node.exe"`

---

## Migration from HUB_TOKEN (v1 → v2)

If your hospital is upgrading from the old shared‑secret model:

1. Remove `HUB_TOKEN` from `.env` on the hub PC.
2. Remove `VITE_HUB_TOKEN` from the client `.env.local` (never prefix hub secrets with `VITE_`).
3. Ward PCs: the next time they log in, they will be prompted for their
   Firebase credentials; the hub will verify the ID token server-side.
4. The hub logs a one‑time warning if `HUB_TOKEN` is still present; ignore
   it after removal.
5. All existing queued ops (pre‑upgrade) are still delivered, tagged
   `created_via: 'lan-hub-legacy'`. New ops are tagged `lan-hub` with
   `authVersion: 2`.
6. Firestore rules remain unchanged for clinical reads; only the hub’s
   server-side authorisation (this file) is new.