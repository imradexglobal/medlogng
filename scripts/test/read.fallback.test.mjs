import assert from 'node:assert/strict'
import { isNetworkReadError, readWithCache } from '../../src/lib/readFallback.js'

let cacheReads = 0
let networkReads = 0
const cache = async () => { cacheReads += 1; return 'cached' }
const network = async () => { networkReads += 1; return 'fresh' }

assert.equal(await readWithCache(network, cache, { isOffline: () => true }), 'cached')
assert.equal(networkReads, 0, 'offline read should not contact the network')
assert.equal(cacheReads, 1)

assert.equal(await readWithCache(network, cache, { isOffline: () => false, timeoutMs: 50 }), 'fresh')
assert.equal(networkReads, 1)

assert.equal(await readWithCache(
  () => new Promise(() => {}), cache, { isOffline: () => false, timeoutMs: 5 },
), 'cached', 'a stalled internet request should fall back to local data')

assert.equal(await readWithCache(
  async () => { throw Object.assign(new Error('backend unavailable'), { code: 'unavailable' }) },
  cache, { isOffline: () => false },
), 'cached', 'network errors should fall back to local data')

await assert.rejects(() => readWithCache(
  async () => { throw Object.assign(new Error('permission denied'), { code: 'permission-denied' }) },
  cache, { isOffline: () => false },
), /permission denied/)
assert.equal(isNetworkReadError({ code: 'permission-denied' }), false)
assert.equal(isNetworkReadError({ code: 'network-request-failed' }), true)
console.log('Offline cache reads, timeout fallback, transport fallback and permission-error preservation passed.')
