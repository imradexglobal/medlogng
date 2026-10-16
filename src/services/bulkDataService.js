// Bulk data service (admin "Data import / export").
//
// sql.js runs SQLite in-browser (web + Electron + Android) on the Spark plan.
// This module:
//   - generates the .db template (all tables, keys, joins + schema_reference)
//   - exports the active org's Firestore data into a .db
//   - parses an uploaded .db, stages rows into the local outbox (bulkQueue)
//   - pushes the queued rows to Firestore with the same doc shapes/mirrors the
//     app services write, then tracks written -> synced via waitForPendingWrites
import initSqlJs from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { db, collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, Timestamp, waitForPendingWrites } from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { auth } from '../firebase.js'
import { logAudit } from './adminService.js'
import {
  IMPORT_ORDER_TABLES, TABLE_BY_TABLE,
  buildCreateTableSql, REFERENCE_TABLE_DDL, META_TABLE_DDL,
  rowToDoc, docToRow, validateRow, tsColumns, hasColumn, fkTargets,
} from '../features/data/schema.js'
import { phoneKey } from '../features/patients/search.js'
import * as queue from './bulkQueue.js'

export { queue }

const BATCH_SIZE = 450 // Firestore batch max is 500; keep headroom for the mirror writes

let sqlPromise = null

export function initEngine() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => sqlWasmUrl })
      .catch((e) => {
        sqlPromise = null
        throw new Error('SQLite engine failed to load. If you are on the desktop app this needs the bundled wasm — check the console for a network/CORS error. ' + (e?.message || ''))
      })
  }
  return sqlPromise
}

// ---- template --------------------------------------------------------------

export async function generateTemplate() {
  const S = await initEngine()
  const sdb = new S.Database()
  for (const entry of IMPORT_ORDER_TABLES) {
    sdb.run(buildCreateTableSql(entry))
  }
  sdb.run(REFERENCE_TABLE_DDL)
  sdb.run(META_TABLE_DDL)
  const ins = sdb.prepare('INSERT INTO "schema_reference" ("table_name","column_name","type","required","references","note") VALUES (?,?,?,?,?,?)')
  for (const entry of IMPORT_ORDER_TABLES) {
    for (const c of entry.columns) {
      ins.run([entry.table, c.name, c.type, c.required ? 1 : 0, c.fk ? c.fk.table + '.' + c.fk.col : null, c.note || null])
    }
    if (entry.note) ins.run([entry.table, '(table note)', 'text', 0, null, entry.note])
  }
  ins.free()
  sdb.run(
    'INSERT OR REPLACE INTO "__meta" ("key","value") VALUES ' +
    "('generator','medilog-bulk-v1')," +
    "('generated_at', datetime('now'))," +
    "('org_id','')," +
    "('note','id = Firestore document id (primary key). Leave id blank to auto-generate — children cannot link to an auto-generated id. Timestamps are ISO-8601 text. See schema_reference for column types and joins.')",
  )
  audit('data.template', 'Template generated (' + IMPORT_ORDER_TABLES.length + ' tables)')
  return sdb.export() // Uint8Array
}

// ---- parse -----------------------------------------------------------------

export async function readDatabase(file) {
  const S = await initEngine()
  const buffer = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer())
  return new S.Database(buffer)
}

export function closeDatabase(sdb) {
  try { sdb.close() } catch { /* noop */ }
}

function sqlTableNames(sdb) {
  try {
    const res = sdb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return res.length ? res[0].values.map((r) => String(r[0])) : []
  } catch {
    return []
  }
}

export function rowCount(sdb, table) {
  try {
    const res = sdb.exec('SELECT COUNT(*) FROM "' + table + '"')
    const n = res.length ? Number(res[0].values[0][0]) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

// Which known tables does the uploaded file contain, and how many rows each?
export function describeDatabase(sdb) {
  const names = new Set(sqlTableNames(sdb))
  return IMPORT_ORDER_TABLES
    .filter((e) => names.has(e.table))
    .map((e) => ({ ...e, count: rowCount(sdb, e.table) }))
}

function tableRows(sdb, table) {
  try {
    const res = sdb.exec('SELECT * FROM "' + table + '"')
    if (!res.length) return []
    const { columns, values } = res[0]
    return values.map((v) => {
      const o = {}
      columns.forEach((c, i) => { o[c] = v[i] })
      return o
    })
  } catch (e) {
    throw new Error('Table "' + table + '" could not be read: ' + (e?.message || 'bad file'))
  }
}

// ---- stage (Phase 1: everything local first) --------------------------------

export async function stageImport(sqlDb, selectedTables, { orgId }) {
  if (!orgId) throw new Error('No hospital selected — pick your hospital in Administration first.')
  const pending = await queue.pendingCount()
  if (pending > 0) {
    throw new Error('An earlier import is still staged (' + pending + ' rows queued). Push or clear it first — one import at a time.')
  }

  const actorUid = auth.currentUser?.uid || null
  const chosen = new Set(selectedTables || [])
  let staged = 0
  const perTable = {}
  const errors = []
  const allRefs = new Map()

  // Collect explicit parent ids so we can warn about broken foreign keys.
  for (const entry of IMPORT_ORDER_TABLES) {
    if (!chosen.has(entry.table)) continue
    const ids = new Set()
    for (const r of tableRows(sqlDb, entry.table)) {
      if (r.id != null && String(r.id).trim()) ids.add(String(r.id).trim())
    }
    allRefs.set(entry.table, ids)
  }

  // Patient ids already covered by explicit organization_patients rows in the
  // file. Those mirror rows win; every other patient still gets an auto-mirror
  // so imported records show up in this hospital's listings.
  const mirroredPids = new Set()
  if (chosen.has('organization_patients')) {
    for (const r of tableRows(sqlDb, 'organization_patients')) {
      const viaField = r.patient_id != null ? String(r.patient_id).trim() : ''
      const viaDocId = r.id != null && String(r.id).startsWith(orgId + '_')
        ? String(r.id).slice(orgId.length + 1)
        : ''
      const pid = viaField || viaDocId
      if (pid) mirroredPids.add(pid)
    }
  }

  for (const entry of IMPORT_ORDER_TABLES) {
    if (!chosen.has(entry.table)) continue
    const rows = tableRows(sqlDb, entry.table)
    const records = []
    for (const row of rows) {
      const raw = rowToDoc(entry, row)
      const rowId = row.id != null && String(row.id).trim() ? String(row.id).trim() : ''
      const docId = rowId || doc(collection(db, entry.collection)).id
      let data = finalizeDoc(entry, raw, { orgId, actorUid })
      if (entry.table === 'patients') data = enrichPatient(data, docId)
      const err = validateRow(entry, data)
      if (err) {
        errors.push({ table: entry.table, id: rowId || '(new)', message: err })
        continue
      }
      records.push({ table: entry.table, collection: entry.collection, docId, data })
      // Auto-mirror patients -> organization_patients/{orgId}_{pid}. This is the
      // row every listing reads, so it must exist even when the (usually empty)
      // organization_patients table was selected in the import dialog.
      if (entry.table === 'patients' && !mirroredPids.has(docId)) {
        records.push({
          table: 'organization_patients',
          collection: 'organization_patients',
          docId: orgId + '_' + docId,
          data: { ...data, patient_id: docId, organization_id: orgId },
          auto: true,
        })
      }
    }
    if (records.length) {
      await queue.stage(records)
      perTable[entry.table] = records.length
      staged += records.length
    }
  }

  const fkWarnings = findBrokenRefs(sqlDb, chosen, allRefs)
  audit('data.staged', 'Staged ' + staged + ' rows (' + Object.keys(perTable).length + ' tables)')
  return { staged, perTable, errors, fkWarnings }
}

function finalizeDoc(entry, raw, { orgId, actorUid }) {
  const out = { ...raw }
  for (const c of tsColumns(entry)) {
    if (out[c.name] === '' || out[c.name] == null) delete out[c.name]
  }
  if (entry.scope === 'org') out.organization_id = orgId
  if (entry.scope === 'global' && (out.organization_id === '' || out.organization_id == null)) out.organization_id = orgId
  if (entry.defaultStatus && (out.status === '' || out.status == null)) out.status = entry.defaultStatus
  if (hasColumn(entry, 'created_by') && (out.created_by === '' || out.created_by == null)) out.created_by = actorUid
  return out
}

// Fill the fields the app normally derives itself when registering a patient
// (see patientService.registerPatient) so bulk-imported records are complete:
// the MRN, the display full name and the searchable phone key. Values already
// present in the file are left untouched.
function enrichPatient(data, docId) {
  const out = { ...data }
  if (!String(out.full_name || '').trim()) {
    out.full_name = [out.given_names, out.surname].filter(Boolean).join(' ').trim()
  }
  if (!String(out.mrn || '').trim()) {
    out.mrn = 'IMR-' + String(docId).slice(0, 6).toUpperCase()
  }
  if (!String(out.phone_key || '').trim() && String(out.phone || '').trim()) {
    out.phone_key = phoneKey(out.phone)
  }
  return out
}

function findBrokenRefs(sqlDb, chosen, allRefs) {
  const warnings = []
  for (const entry of IMPORT_ORDER_TABLES) {
    if (!chosen.has(entry.table)) continue
    for (const fk of fkTargets(entry)) {
      if (!chosen.has(fk.table)) continue // parent table not imported — no reference to resolve
      const rows = tableRows(sqlDb, entry.table)
      const parentIds = allRefs.get(fk.table)
      if (!parentIds) continue
      let missing = 0
      const samples = []
      for (const r of rows) {
        const v = r[fk.column]
        if (v == null || String(v).trim() === '') continue
        if (!parentIds.has(String(v).trim())) {
          missing += 1
          if (samples.length < 3) samples.push(String(v).trim())
        }
      }
      if (missing) {
        warnings.push({ table: entry.table, column: fk.column, references: fk.table, missing, samples })
      }
    }
  }
  return warnings
}

// ---- push (Phase 2: queued -> cloud) ---------------------------------------

export async function pushQueue({ shouldStop, onProgress } = {}) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  // Recover stranded `sending` claims from an interrupted previous push.
  await queue.resendSending()

  let sent = 0
  let failed = 0
  let batches = 0
  for (;;) {
    if (shouldStop && shouldStop()) break
    const records = await queue.takeQueued(BATCH_SIZE)
    if (!records.length) break
    batches += 1
    let ops = records.map((r) => {
      const entry = TABLE_BY_TABLE[r.table]
      return {
        key: r.key,
        collection: r.collection,
        docId: r.docId,
        appendOnly: entry.appendOnly,
        data: materialize(entry, r.data),
      }
    })
    // Append-only tables (payments, dispensations) can never be overwritten in
    // Firestore — a row whose document already exists is reported as skipped.
    const skipResults = []
    if (ops.some((o) => o.appendOnly)) {
      const keep = []
      for (const o of ops) {
        if (o.appendOnly && (await docExists(o))) {
          skipResults.push({ key: o.key, ok: false, message: 'Skipped — document already exists (append-only table)' })
          continue
        }
        keep.push(o)
      }
      ops = keep
    }
    let results
    if (ops.length) {
      try {
        await commitBatch(ops)
        results = ops.map((o) => ({ key: o.key, ok: true }))
      } catch (e) {
        console.warn('[bulk] batch failed, isolating rows:', e?.message)
        results = await commitIndividually(ops)
      }
      results = results.concat(skipResults)
    } else {
      results = skipResults
    }
    const okKeys = []
    const errRows = []
    for (const r of results) {
      if (r.ok) okKeys.push(r.key)
      else errRows.push({ key: r.key, message: r.message })
    }
    if (okKeys.length) await queue.setStatuses(okKeys, 'written')
    // setStatuses takes one shared message for all keys, so rows are stamped in
    // groups by their own message. Referencing `r` here (r is scoped to the for
    // loop above) threw a ReferenceError and aborted pushQueue whenever any row
    // failed, which also left those rows unmarked — so they retried forever.
    const byMessage = new Map()
    for (const row of errRows) {
      if (!byMessage.has(row.message)) byMessage.set(row.message, [])
      byMessage.get(row.message).push(row.key)
    }
    for (const [message, keys] of byMessage) {
      await queue.setStatuses(keys, 'error', message)
    }
    sent += okKeys.length
    failed += errRows.length
    await maybePromoteWritten()
    if (onProgress) {
      onProgress({ sent, failed, batches, counts: await queue.counts() })
    }
    await new Promise((res) => setTimeout(res, 0))
  }
  await maybePromoteWritten()
  if (onProgress) onProgress({ sent, failed, batches, counts: await queue.counts(), done: true })
  audit('data.push', 'Pushed ' + sent + ' rows, ' + failed + ' failed (' + batches + ' batches)')
  return { sent, failed, batches }
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function docExists(ops) {
  try {
    return (await getDoc(doc(db, ops.collection, ops.docId))).exists()
  } catch {
    return false // unreadable while offline — let the push surface the real error
  }
}

async function commitBatch(ops) {
  for (const group of chunk(ops, BATCH_SIZE)) {
    const batch = writeBatch(db)
    for (const o of group) batch.set(doc(db, o.collection, o.docId), o.data)
    await batch.commit()
  }
}

async function commitIndividually(ops) {
  const out = []
  for (const o of ops) {
    try {
      await setDoc(doc(db, o.collection, o.docId), o.data)
      out.push({ key: o.key, ok: true })
    } catch (e) {
      out.push({ key: o.key, ok: false, message: friendlyBulkError(e) })
    }
  }
  return out
}

function friendlyBulkError(e) {
  const code = e?.code || ''
  const m = e?.message || ''
  if (code === 'permission-denied' || /permission|denied|insufficient/i.test(m)) {
    return 'Not allowed — missing capability for this write (needs an admin account).'
  }
  if (/already exists|document already|xpermission/i.test(m)) return 'Document already exists (append-only table) — skipped.'
  return String(m || 'Unknown write error').slice(0, 300)
}

// Timestamps are stored as ISO strings in the outbox; materialize converts them
// to Firestore Timestamps and stamps created_at/updated_at when declared.
function materialize(entry, data) {
  const out = { ...data }
  for (const c of entry.columns) {
    if (c.type !== 'ts') continue
    const v = out[c.name]
    if (v && typeof v === 'string') {
      out[c.name] = Timestamp.fromDate(new Date(v))
    } else if (v === '') {
      delete out[c.name]
    }
  }
  if (hasColumn(entry, 'created_at') && out.created_at == null) out.created_at = Timestamp.now()
  if (hasColumn(entry, 'updated_at') && out.updated_at == null) out.updated_at = Timestamp.now()
  return out
}

async function maybePromoteWritten() {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  if (!online) return 0
  try {
    await waitForPendingWrites(db)
  } catch {
    return 0
  }
  return promoteWritten()
}

async function promoteWritten() {
  const rows = await queue.rowsByStatus('written')
  if (!rows.length) return 0
  await queue.setStatuses(rows.map((r) => r.key), 'synced')
  return rows.length
}

// If pending local writes exist, wait for the backend ack and promote rows.
export async function flushPending() {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  if (!online) return { flushed: 0, offline: true }
  try {
    await waitForPendingWrites(db)
  } catch (e) {
    return { flushed: 0, error: e?.message || 'still syncing' }
  }
  await promoteWritten()
  const c = await queue.counts()
  return { flushed: c.synced, remaining: c.queued + c.sending + c.written }
}

// ---- export ----------------------------------------------------------------

export async function exportToDatabase(tables, { orgId }) {
  const S = await initEngine()
  const sdb = new S.Database()
  const chosen = new Set(tables)
  const entries = IMPORT_ORDER_TABLES.filter((e) => chosen.has(e.table))
  if (!entries.length) throw new Error('Pick at least one table to export.')

  for (const entry of entries) sdb.run(buildCreateTableSql(entry))

  for (const entry of entries) {
    if (entry.scope === 'org' && !orgId) throw new Error('No hospital selected.')
    let snap
    if (entry.scope === 'org') {
      snap = await getDocs(query(collection(db, entry.collection), where('organization_id', '==', orgId)))
    } else {
      snap = await getDocs(collection(db, entry.collection))
    }
    const cols = entry.columns.map((c) => c.name)
    const insert = sdb.prepare(
      'INSERT INTO "' + entry.table + '" ("' + cols.join('","') + '") VALUES (' + cols.map(() => '?').join(',') + ')',
    )
    for (const d of snap.docs) {
      const row = docToRow(entry, d.data() || {})
      const vals = cols.map((c) => (c === 'id' ? d.id : row[c] !== undefined ? row[c] : ''))
      try {
        insert.run(vals)
      } catch (e) {
        console.warn('[bulk] export row skipped:', entry.collection, d.id, e?.message)
      }
    }
    insert.free()
  }
  audit('data.export', 'Exported ' + entries.length + ' tables')
  return sdb.export()
}

// ---- audit (best-effort) ----------------------------------------------------

function audit(action, details) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) return
  logAudit({ action, organizationId: activeOrg, details: String(details || '').slice(0, 500) }).catch(() => {})
}