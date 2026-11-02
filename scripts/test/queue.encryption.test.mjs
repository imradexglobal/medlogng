import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { createQueue } from '../../hub/queue.js'

const testRoot = resolve(process.cwd(), 'scripts', 'test')
const dir = mkdtempSync(join(testRoot, '.tmp-queue-encryption-'))
const relDir = relative(testRoot, resolve(dir))
assert.ok(relDir && !relDir.startsWith('..' + sep) && relDir !== '..', 'test cleanup stays inside scripts/test')
const file = join(dir, 'queue.json')
const encode = (text) => Buffer.from('test-encrypted:' + Buffer.from(text).toString('base64'))
const decode = (bytes) => {
  const text = Buffer.from(bytes).toString()
  if (!text.startsWith('test-encrypted:')) throw new Error('not encrypted')
  return Buffer.from(text.slice('test-encrypted:'.length), 'base64').toString()
}

try {
  writeFileSync(file, JSON.stringify({ version: 1, savedAt: 0, ops: {} }))
  const queue = createQueue(file, { encode, decode })
  assert.equal(readFileSync(file, 'utf8').startsWith('test-encrypted:'), true,
    'legacy plaintext is immediately rewritten using the encrypted encoder')
  const phi = 'Patient Example PHI-771'
  queue.add({ queueKey: 'org:key-1', clientOpKey: 'key-1', kind: 'rx_mirror', orgId: 'org',
    args: { patientName: phi }, actor: { uid: 'staff-1' } })
  const stored = readFileSync(file, 'utf8')
  assert.equal(stored.includes(phi), false, 'operation details must not appear in plaintext on disk')
  assert.equal(createQueue(file, { encode, decode }).get('org:key-1').args.patientName, phi,
    'encrypted state reloads with its queue operation intact')

  const protectedCopy = Buffer.from('not decryptable queue state')
  writeFileSync(file, protectedCopy)
  assert.throws(() => createQueue(file, { encode, decode }), /contents were preserved/)
  assert.deepEqual(readFileSync(file), protectedCopy, 'undecryptable data must be preserved for recovery')
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

console.log('Encrypted host queue persistence, plaintext migration and undecryptable-file preservation passed.')
