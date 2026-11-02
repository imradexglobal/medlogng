// LAN address detection + startup diagnostics (pure, no side effects).
//
// The hub used to print `http://0.0.0.0:PORT` and leave the operator to guess
// the machine's real LAN address. 0.0.0.0 is a *bind* address, never a URL you
// can type on another device, so this module separates the three things that
// matter:
//
//   local URL       http://127.0.0.1:PORT      (this PC only)
//   LAN URL         http://192.168.x.x:PORT    (other devices on the network)
//   listening addr  the address the socket is bound to (0.0.0.0 = all IPv4)
//
// Interface classification deliberately skips:
//   - loopback / 0.0.0.0
//   - APIPA (169.254.x.x) — the adapter failed DHCP, so it is not reachable
//     from another device and must never be advertised
//   - common virtual adapters (Hyper-V, WSL, VirtualBox, VPN, Bluetooth...).
//     They are real sockets but another ward PC cannot reach them.
//
// Everything here is exported separately so scripts/test/netinfo.test.mjs can
// cover normal, APIPA-only, loopback-only and virtual-only machines without
// touching the host's real network.

const VIRTUAL_NAME_RE = /(local area connection\s*\*|vethernet|hyper-v|virtualbox|vmware|docker|wsl|tailscale|zerotier|bluetooth|teredo|isatap|npcap|loopback|vpn|\btap\b|\btun\b|hamachi|radmin|openvpn|wireguard|pseudo)/i

const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/

export function isIPv4(family) {
  return family === 'IPv4' || family === 4
}

export function isAPIPA(address) {
  return /^169\.254\./.test(String(address || ''))
}

export function isLoopback(address) {
  const a = String(address || '')
  return /^127\./.test(a) || a === '0.0.0.0' || a === '::1'
}

export function isPrivateIPv4(address) {
  return PRIVATE_RE.test(String(address || ''))
}

export function isVirtualInterfaceName(name) {
  return VIRTUAL_NAME_RE.test(String(name || ''))
}

// Classify the object returned by os.networkInterfaces().
// Returns usable addresses best-first. Exported for tests.
export function classifyInterfaces(interfaces) {
  const rows = []
  const seen = new Set()
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const item of list || []) {
      if (!item || !isIPv4(item.family)) continue
      const address = String(item.address || '')
      if (!address || item.internal) continue
      if (isLoopback(address) || isAPIPA(address)) continue
      if (isVirtualInterfaceName(name)) continue
      if (seen.has(address)) continue
      seen.add(address)
      rows.push({
        name: String(name || ''),
        address,
        netmask: item.netmask || '',
        cidr: item.cidr || '',
        mac: item.mac || '',
        private: isPrivateIPv4(address),
      })
    }
  }
  // A 192.168.x.x / 10.x.x.x address is overwhelmingly the building LAN;
  // public-looking addresses are kept (some institutions NAT oddly) but rank
  // below private ones, and Wi-Fi/Ethernet below "weird adapter" names.
  const score = (r) => {
    let n = 0
    if (r.private) n += 4
    if (r.address.startsWith('192.168.')) n += 2
    if (/wi-?fi|wireless|wlan|ethernet/i.test(r.name)) n += 2
    if (/ethernet/i.test(r.name)) n += 1
    return n
  }
  rows.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
  return rows
}

// Convenience: just the addresses, best-first.
export function listLanAddresses(interfaces) {
  return classifyInterfaces(interfaces).map((r) => r.address)
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

// Build the human-readable startup report. Returns an array of lines (no
// trailing newline) so callers can log.info() them or assert on them in tests.
export function startupLines({ host = '0.0.0.0', port, version = '', lanAddresses: addresses = [], interfaces, protocol = 'http' } = {}) {
  const addrs = Array.isArray(addresses) ? addresses : listLanAddresses(interfaces)
  const lines = []
  lines.push('[hub] listening on ' + host + ':' + port + (version ? '  (' + version + ')' : ''))
  lines.push('[hub] local URL: ' + protocol + '://127.0.0.1:' + port)

  if (isLoopbackHost(host)) {
    lines.push('[hub] LAN URL:   none — bound to ' + host + ' (this PC only).')
    lines.push('[hub]   To let other devices connect, set HUB_HOST=0.0.0.0 and restart the hub.')
    return lines
  }

  if (addrs.length) {
    lines.push('[hub] LAN URL:   ' + protocol + '://' + addrs[0] + ':' + port)
    if (addrs.length > 1) {
      lines.push('[hub] other local IPv4 addresses: ' + addrs.slice(1).join(', '))
    }
    lines.push('[hub]   Other devices on the same trusted Wi-Fi/LAN should open the LAN URL.')
  } else {
    lines.push('[hub] LAN URL:   not available — no usable IPv4 LAN address was detected.')
    lines.push('[hub]   The hub is still reachable on this PC at ' + protocol + '://127.0.0.1:' + port + '.')
    lines.push('[hub]   To diagnose on Windows (no admin needed):')
    lines.push('[hub]     ipconfig                     # look for "IPv4 Address" on the adapter you use')
    lines.push('[hub]     Get-NetConnectionProfile     # confirms the network is Private, not Public')
    lines.push('[hub]   If the adapter shows 169.254.x.x it never got a DHCP address — reconnect')
    lines.push('[hub]   Wi-Fi/Ethernet (or set a static address), then start the hub again.')
  }
  return lines
}

// Turn a Node listen() error into an operator-friendly message. The error is
// re-thrown by startHub, so the CLI can print it without a stack trace.
export function describeListenError(err, port) {
  const code = err?.code || ''
  if (code === 'EADDRINUSE') {
    return new Error(
      'Port ' + port + ' is already in use. Another hub or program is listening there.\n' +
      '  Find it:  Get-NetTCPConnection -LocalPort ' + port + ' -State Listen | Format-Table LocalAddress,OwningProcess\n' +
      '  Then either stop that program, or start this hub on another port:  $env:PORT=' + (Number(port) + 1) + '; npm run hub'
    )
  }
  if (code === 'EACCES') {
    return new Error(
      'Windows refused port ' + port + ' (EACCES). Pick a non-privileged port (8787 or above) and try again.'
    )
  }
  if (code === 'EADDRNOTAVAIL') {
    return new Error(
      'The requested HUB_HOST address is not assigned to this computer. Use HUB_HOST=0.0.0.0 (all interfaces)\n' +
      'or HUB_HOST=127.0.0.1 (this PC only). Run `ipconfig` to see the addresses this PC actually has.'
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}
