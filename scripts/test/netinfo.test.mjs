// Network interface classification tests for hub/netinfo.js
// Run with: node scripts/test/netinfo.test.mjs
// Skips cleanly when run on a machine with no detectable LAN interfaces.

import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import { listLanAddresses, startupLines, isAPIPA, isLoopback, isPrivateIPv4, isVirtualInterfaceName, classifyInterfaces } from '../../hub/netinfo.js'

const passed = []
const failed = []

function test(name, fn) {
  try {
    fn()
    passed.push(name)
    console.log('  ok  ' + name)
  } catch (e) {
    failed.push(name)
    console.error('  FAIL ' + name + ' — ' + (e.message || e))
  }
}

console.log('netinfo tests')

// --- classifyInterfaces ---

test('classifyInterfaces returns rows with required fields', () => {
  const ifaces = networkInterfaces()
  const rows = classifyInterfaces(ifaces)
  assert.ok(rows.length >= 0, 'expected at least 0 rows')
  if (rows.length) {
    const r = rows[0]
    assert.ok(r.address, 'row has address')
    assert.ok(r.name, 'row has name')
    assert.ok(typeof r.private === 'boolean', 'row has private flag')
  }
})

test('classifyInterfaces skips loopback addresses', () => {
  const ifaces = networkInterfaces()
  const rows = classifyInterfaces(ifaces)
  for (const r of rows) {
    assert.ok(!isLoopback(r.address), r.address + ' should be skipped')
  }
})

test('classifyInterfaces skips APIPA addresses', () => {
  const ifaces = networkInterfaces()
  const rows = classifyInterfaces(ifaces)
  for (const r of rows) {
    assert.ok(!isAPIPA(r.address), r.address + ' should be skipped')
  }
})

test('classifyInterfaces skips virtual interface names', () => {
  const ifaces = networkInterfaces()
  const rows = classifyInterfaces(ifaces)
  for (const r of rows) {
    assert.ok(!isVirtualInterfaceName(r.name), r.name + ' should be skipped')
  }
})

test('classifyInterfaces ranks private 192.168 above other privates', () => {
  const fake = {
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
  }
  const rows = classifyInterfaces(fake)
  assert.ok(rows.length >= 2, 'expected 2 rows')
  assert.equal(rows[0].address, '192.168.1.50')
  assert.equal(rows[1].address, '10.0.0.5')
})

// --- listLanAddresses ---

test('listLanAddresses returns addresses only', () => {
  const fake = {
    wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
  }
  const addrs = listLanAddresses(fake)
  assert.deepEqual(addrs, ['192.168.1.50'])
})

// --- startupLines ---

test('startupLines includes local URL for loopback host', () => {
  const lines = startupLines({ host: '127.0.0.1', port: 8787, version: 'hub-2.0.0', lanAddresses: [], interfaces: networkInterfaces() })
  assert.ok(lines.some((l) => l.includes('local URL')), 'should include local URL')
  assert.ok(lines.some((l) => l.includes('LAN URL:   none')), 'should indicate no LAN URL')
})

test('startupLines includes LAN URL when addresses available', () => {
  const ifaces = networkInterfaces()
  const lines = startupLines({ host: '192.168.1.50', port: 8787, version: 'hub-2.0.0', lanAddresses: ['192.168.1.50'], interfaces: ifaces })
  assert.ok(lines.some((l) => l.includes('LAN URL:   http://192.168.1.50:8787')), 'should include LAN URL')
})

test('startupLines reports no usable LAN address when none detected', () => {
  const ifaces = networkInterfaces()
  const lines = startupLines({ host: '0.0.0.0', port: 8787, version: 'hub-2.0.0', lanAddresses: [], interfaces: ifaces })
  assert.ok(lines.some((l) => l.includes('not available — no usable IPv4 LAN address')), 'should report no LAN address')
  assert.ok(lines.some((l) => l.includes('ipconfig')), 'should include ipconfig guidance')
})

// --- standalone helpers ---

test('isLoopback recognises 127.0.0.1 and ::1 and 0.0.0.0', () => {
  assert.ok(isLoopback('127.0.0.1'), '127.0.0.1 is loopback')
  assert.ok(isLoopback('0.0.0.0'), '0.0.0.0 is loopback')
  assert.ok(isLoopback('::1'), '::1 is loopback')
})

test('isAPIPA recognises 169.254.x.x', () => {
  assert.ok(isAPIPA('169.254.0.1'), '169.254.0.1 is APIPA')
  assert.ok(!isAPIPA('10.0.0.1'), '10.0.0.1 is not APIPA')
})

test('isPrivateIPv4 matches 10/172.16-31/192.168 ranges', () => {
  assert.ok(isPrivateIPv4('10.0.0.1'), '10.x is private')
  assert.ok(isPrivateIPv4('172.16.0.1'), '172.16.x is private')
  assert.ok(isPrivateIPv4('172.31.255.255'), '172.31.x is private')
  assert.ok(isPrivateIPv4('192.168.1.1'), '192.168.x is private')
  assert.ok(!isPrivateIPv4('8.8.8.8'), '8.8.8.8 is not private')
})

test('isVirtualInterfaceName matches common virtual adapter names', () => {
  assert.ok(!isVirtualInterfaceName('Ethernet'), 'Ethernet is not virtual')
  assert.ok(isVirtualInterfaceName('Hyper-V Virtual Ethernet Adapter'), 'Hyper-V is virtual')
  assert.ok(!isVirtualInterfaceName('Wi-Fi'), 'Wi-Fi is not virtual')
})

console.log('\nnetinfo tests: ' + passed.length + ' passed, ' + failed.length + ' failed')
process.exit(failed.length ? 1 : 0)
