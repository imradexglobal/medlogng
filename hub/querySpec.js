const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,119}$/
const OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'])
const MAX_QUERY_LIMIT = 2000

function decodeValue(value, depth = 0) {
  if (depth > 8) throw new Error('Query values are nested too deeply.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Query contains an invalid number.')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('Query list has too many values.')
    return value.map((item) => decodeValue(item, depth + 1))
  }
  if (!value || typeof value !== 'object') throw new Error('Query contains an unsupported value.')
  if (value.__firestoreType === 'timestamp' && typeof value.value === 'string') {
    const date = new Date(value.value)
    if (!Number.isFinite(date.getTime())) throw new Error('Query timestamp is invalid.')
    return date
  }
  if (value.__firestoreType) throw new Error('This query value type is not supported by the LAN Host.')
  const entries = Object.entries(value)
  if (entries.length > 50) throw new Error('Query object has too many fields.')
  const out = {}
  for (const [key, item] of entries) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Query contains an invalid field name.')
    out[key] = decodeValue(item, depth + 1)
  }
  return out
}

function normalizeBound(bound) {
  if (!bound) return null
  if (!bound || typeof bound !== 'object' || !Array.isArray(bound.values) || !bound.values.length || bound.values.length > 10) {
    throw new Error('Query cursor is invalid.')
  }
  return { before: !!bound.before, values: bound.values.map((value) => decodeValue(value)) }
}

export function validateQuerySpec(raw, { orgId, uid }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Query must be an object.')
  const collection = String(raw.collection || '')
  if (!COLLECTION_RE.test(collection)) throw new Error('Query collection is invalid.')
  if (!Array.isArray(raw.filters) || raw.filters.length > 20) throw new Error('Query filters are invalid.')
  const filters = raw.filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || !FIELD_RE.test(String(filter.field || '')) || !OPS.has(filter.op)) {
      throw new Error('Query filter is invalid.')
    }
    return { field: filter.field, op: filter.op, value: decodeValue(filter.value) }
  })
  const hasOrg = filters.some((f) => f.field === 'organization_id' && f.op === '==' && f.value === orgId)
  if (!hasOrg) throw new Error('The Host only caches queries scoped to the selected hospital.')
  if (collection === 'organization_memberships' &&
      !filters.some((f) => f.field === 'user_id' && f.op === '==' && f.value === uid)) {
    throw new Error('Membership queries must be scoped to the signed-in user.')
  }
  const orderBy = Array.isArray(raw.orderBy) ? raw.orderBy.map((item) => {
    if (!item || !FIELD_RE.test(String(item.field || '')) || !['asc', 'desc'].includes(item.dir)) {
      throw new Error('Query order is invalid.')
    }
    return { field: item.field, dir: item.dir }
  }) : []
  if (orderBy.length > 5) throw new Error('Query has too many ordering fields.')
  const limit = Number(raw.limit || 0)
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_QUERY_LIMIT) throw new Error('Query limit is invalid.')
  const startAt = normalizeBound(raw.startAt)
  const endAt = normalizeBound(raw.endAt)
  return { orgId, collection, filters, orderBy, limit, startAt, endAt }
}

export function applyQuerySpec(db, spec) {
  let q = db.collection(spec.collection)
  for (const filter of spec.filters) q = q.where(filter.field, filter.op, filter.value)
  for (const item of spec.orderBy) q = q.orderBy(item.field, item.dir)
  if (spec.startAt) q = q[spec.startAt.before ? 'startAt' : 'startAfter'](...spec.startAt.values)
  if (spec.endAt) q = q[spec.endAt.before ? 'endBefore' : 'endAt'](...spec.endAt.values)
  q = q.limit(spec.limit || MAX_QUERY_LIMIT)
  return q
}

export function serializeFirestoreData(value, depth = 0) {
  if (depth > 16) throw new Error('Document data is too deeply nested.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (value instanceof Date) return { __firestoreType: 'timestamp', seconds: Math.floor(value.getTime() / 1000), nanoseconds: (value.getTime() % 1000) * 1e6 }
  if (value && typeof value.toMillis === 'function' && typeof value.toDate === 'function') {
    const date = value.toDate()
    return { __firestoreType: 'timestamp', seconds: Math.floor(date.getTime() / 1000), nanoseconds: (date.getTime() % 1000) * 1e6 }
  }
  if (Array.isArray(value)) return value.map((item) => serializeFirestoreData(item, depth + 1))
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
      out[key] = serializeFirestoreData(item, depth + 1)
    }
    return out
  }
  return null
}
