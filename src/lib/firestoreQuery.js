// Serialise the small, stable subset of Firestore's query representation used
// by this app so a LAN Host can cache an organisation-scoped query result.
// Unsupported query shapes return null and continue through Firebase normally.

function fieldPath(field) {
  return Array.isArray(field?.segments) ? field.segments.join('.') : ''
}

function decodeProtoValue(value) {
  if (!value || typeof value !== 'object') return value
  if ('nullValue' in value) return null
  if ('stringValue' in value) return value.stringValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return Number(value.doubleValue)
  if ('booleanValue' in value) return !!value.booleanValue
  if ('timestampValue' in value) return { __firestoreType: 'timestamp', value: value.timestampValue }
  if ('bytesValue' in value) return { __firestoreType: 'bytes', value: value.bytesValue }
  if ('referenceValue' in value) return { __firestoreType: 'reference', value: value.referenceValue }
  if ('geoPointValue' in value) return { __firestoreType: 'geoPoint', value: value.geoPointValue }
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeProtoValue)
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeProtoValue(v)]))
  return null
}

function decodePosition(bound) {
  if (!bound) return null
  if (!Array.isArray(bound.position) || !bound.position.length) return null
  return { before: !!bound.before, values: bound.position.map(decodeProtoValue) }
}

function flattenFilters(filters, out = []) {
  for (const filter of filters || []) {
    if (filter?.field && filter?.op && filter?.value !== undefined) {
      const field = fieldPath(filter.field)
      if (!field) return null
      out.push({ field, op: String(filter.op), value: decodeProtoValue(filter.value) })
    } else if (filter?.filters && filter?.op === 'and') {
      if (!flattenFilters(filter.filters, out)) return null
    } else return null
  }
  return out
}

export function serializeFirestoreQuery(query) {
  const impl = query?._query
  const segments = impl?.path?.segments
  if (!Array.isArray(segments) || segments.length !== 1 || impl.collectionGroup) return null
  if (impl.limitType && impl.limitType !== 'F') return null
  const filters = flattenFilters(impl.filters)
  if (!filters) return null
  const orderBy = (impl.explicitOrderBy || []).map((item) => ({ field: fieldPath(item.field), dir: item.dir }))
  if (orderBy.some((item) => !item.field || !['asc', 'desc'].includes(item.dir))) return null
  return {
    collection: String(segments[0]),
    filters,
    orderBy,
    limit: Number.isInteger(impl.limit) ? impl.limit : 0,
    startAt: decodePosition(impl.startAt),
    endAt: decodePosition(impl.endAt),
  }
}
