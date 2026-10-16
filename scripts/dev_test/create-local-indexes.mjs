import adminDefault from 'firebase-admin'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const admin = adminDefault?.default ?? adminDefault

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROJECT = process.argv[2] || 'medlogng'
const KEY_FILE = process.env.FIREBASE_SA_KEY || path.join(ROOT, 'new-project-service-account.json')

const desired = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes

const app = admin.initializeApp({ credential: admin.cert(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))) })
const { access_token } = await app.options.credential.getAccessToken()
const headers = { Authorization: `Bearer ${access_token}` }

const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups`

async function listIndexes(group) {
  const out = []
  let pageToken = null
  do {
    const url = `${base}/${group}/indexes${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`list ${group}: ${res.status} ${await res.text()}`)
    const json = await res.json()
    out.push(...(json.indexes || []).filter((i) => i.name?.includes(`collectionGroups/${group}/`)))
    pageToken = json.nextPageToken || null
  } while (pageToken)
  return out
}

const fieldKey = (f) => `${f.fieldPath}:${f.order}`

function covers(existing, want) {
  if (existing.queryScope && want.queryScope && existing.queryScope !== want.queryScope) return false
  if (existing.fields.length < want.fields.length) return false
  if (!want.fields.every((f, i) => fieldKey(existing.fields[i]) === fieldKey(f))) return false
  return existing.fields.length === want.fields.length || existing.fields[want.fields.length].fieldPath === '__name__'
}

async function waitForOperation(opName) {
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`https://firestore.googleapis.com/v1/${opName}`, { headers })
    const json = await res.json()
    if (json.done) {
      if (json.error) throw new Error(`operation ${opName} failed: ${JSON.stringify(json.error)}`)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`operation ${opName} timed out after ~6 min`)
}

const seen = new Set()
const missing = []
for (const idx of desired) {
  const key = `${idx.collectionGroup}|${idx.fields.map(fieldKey).join(',')}`
  if (seen.has(key)) continue
  seen.add(key)
  const existing = await listIndexes(idx.collectionGroup)
  if (!existing.some((e) => covers(e, idx))) missing.push(idx)
  console.log(`checked ${idx.collectionGroup} [${idx.fields.map((f) => `${f.fieldPath} ${f.order}`).join(' + ')}]`)
}

let created = 0
for (const idx of missing) {
  const res = await fetch(`${base}/${idx.collectionGroup}/indexes`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queryScope: idx.queryScope || 'COLLECTION',
      fields: idx.fields.map((f) => ({ fieldPath: f.fieldPath, order: f.order })),
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    console.error(`FAILED ${idx.collectionGroup} [${idx.fields.map((f) => f.fieldPath).join(' + ')}]: ${res.status} ${JSON.stringify(json.error || json)}`)
    process.exitCode = 1
    continue
  }
  process.stdout.write(`creating ${idx.collectionGroup} [${idx.fields.map((f) => f.fieldPath).join(' + ')}] ... `)
  await waitForOperation(json.name)
  console.log('READY')
  created++
}

if (created === 0 && !process.exitCode) {
  console.log(`\n${PROJECT}: all ${seen.size} index definitions from firestore.indexes.json already exist.`)
} else {
  console.log(`\n${PROJECT}: created ${created} missing index(es). Reload localhost and the appointments page will stop erroring.`)
}
