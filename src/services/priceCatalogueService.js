// Price catalogue — stored per hospital in Firestore (collection: price_catalogue).
// No hardcoded demo prices. Prices are in kobo (integer) to avoid float drift;
// divide by 100 before display. Empty until an admin adds items in
// Administration → Price settings.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, deleteDoc,
  serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'

const PRICES = 'price_catalogue'

export function myPriceCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canManage: can(me, 'billing.invoice'),
  }
}

function priceRef(orgId, id = null) {
  const base = collection(db, PRICES)
  return id ? doc(base, id) : doc(base)
}

export async function listPrices(orgId) {
  if (!orgId) return []
  const snap = await getDocs(query(
    collection(db, PRICES),
    where('organization_id', '==', orgId),
  ))
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}

export async function savePrice(orgId, { id, name, category, priceKobo, active = true }) {
  if (!orgId) throw new Error('No hospital selected.')
  const caps = myPriceCaps()
  if (!caps.canManage) {
    throw new Error('You cannot manage price catalogue (missing billing.invoice capability).')
  }
  if (!name || !name.trim()) throw new Error('Item name is required.')
  const kobo = Math.round(Number(priceKobo) || 0)
  if (kobo < 0) throw new Error('Price cannot be negative.')
  const now = serverTimestamp()
  const data = {
    organization_id: orgId,
    name: String(name).trim(),
    category: String(category || 'Service').trim(),
    price_kobo: kobo,
    active: active === false ? false : true,
    updated_at: now,
  }
  if (id) {
    const ref = doc(collection(db, PRICES), id)
    await setDoc(ref, data, { merge: true })
    return { id, ...data }
  }
  data.created_at = now
  const ref = priceRef(orgId)
  await setDoc(ref, data)
  return { id: ref.id, ...data }
}

export async function deletePrice(id) {
  const caps = myPriceCaps()
  if (!caps.canManage) {
    throw new Error('You cannot delete price catalogue items.')
  }
  await deleteDoc(doc(collection(db, PRICES), id))
  return true
}

export function priceFor(prices, itemName) {
  if (!prices || !prices.length) return 0
  const match = prices.find((p) => String(p.name).toLowerCase() === String(itemName).toLowerCase() && p.active !== false)
  return match ? Number(match.price_kobo || 0) : 0
}

export function findPrice(prices, itemName) {
  if (!prices || !prices.length) return null
  return prices.find((p) => String(p.name).toLowerCase() === String(itemName).toLowerCase()) || null
}

export function catalogueItems(prices) {
  return (prices || []).filter((p) => p.active !== false).map((p) => p.name)
}

export function lineText(itemName, qty, priceKobo) {
  const match = priceKobo != null ? priceKobo : 0
  return itemName + ' · ' + qty + ' × ₦' + (match / 100).toLocaleString('en-NG')
}
