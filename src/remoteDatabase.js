import { createClient } from '@supabase/supabase-js';
import { createId } from './utils';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  || process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function noStoreFetch(input, init = {}) {
  return fetch(input, { ...init, cache: 'no-store' });
}

export const isRemoteConfigured = Boolean(supabaseUrl && supabaseKey);
const client = isRemoteConfigured
  ? createClient(supabaseUrl, supabaseKey, {
    global: { fetch: noStoreFetch },
    // Lesachi has no user login yet. Avoid auth/session probing in every tab;
    // all shared data access is intentionally handled by the public RLS key.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
  : null;

function requireClient() {
  if (!client) {
    throw new Error('Onlayn baza sozlanmagan. Vercel Production muhitida qayta build qiling.');
  }
  return client;
}

async function unwrap(request) {
  const { data, error } = await request;
  if (error) throw new Error(error.message || 'Onlayn baza xatosi.');
  return data;
}

function toItem(row) {
  return {
    id: row.id,
    rentalId: row.rental_id || row.rentalId,
    equipmentTypeId: row.equipment_type_id || row.equipmentTypeId || null,
    name: row.name,
    quantity: Number(row.quantity) || 0,
    dailyPrice: Number(row.daily_price ?? row.dailyPrice) || 0,
    startedAt: row.started_at || row.startedAt,
    status: row.status === 'returned' ? 'returned' : 'open',
    returnedAt: row.returned_at || row.returnedAt || null,
    frozenAmount: row.frozen_amount ?? row.frozenAmount ?? null,
    returns: row.status === 'returned'
      ? [{
        id: `return_${row.id}`,
        rentalItemId: row.id,
        quantity: Number(row.quantity) || 0,
        returnedAt: row.returned_at || row.returnedAt || null,
        frozenAmount: row.frozen_amount ?? row.frozenAmount ?? null,
      }]
      : [],
  };
}

function toReturnedRpcItem(row) {
  return toItem({
    ...row,
    rental_id: row.rentalId,
    equipment_type_id: row.equipmentTypeId,
    daily_price: row.dailyPrice,
    started_at: row.startedAt,
    returned_at: row.returnedAt,
    frozen_amount: row.frozenAmount,
  });
}

function normaliseEquipmentPayload(payload) {
  const name = String(payload?.name || '').trim();
  const rawDailyPrice = payload?.dailyPrice;
  const rawTotalQuantity = payload?.totalQuantity;
  const dailyPrice = Number(rawDailyPrice);
  const totalQuantity = Number(rawTotalQuantity);
  if (!name) throw new Error('Anjom nomini kiriting.');
  if (rawDailyPrice === null || rawDailyPrice === undefined || String(rawDailyPrice).trim() === '') {
    throw new Error('Kunlik ijara narxini kiriting.');
  }
  if (rawTotalQuantity === null || rawTotalQuantity === undefined || String(rawTotalQuantity).trim() === '') {
    throw new Error('Umumiy miqdorni kiriting.');
  }
  if (!Number.isSafeInteger(dailyPrice) || dailyPrice < 0) throw new Error('Kunlik ijara narxini to‘g‘ri kiriting.');
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity < 0) throw new Error('Umumiy miqdorni 0 yoki undan katta butun son qilib kiriting.');
  return { name, dailyPrice, totalQuantity };
}

function normaliseReturnRequests(returnsOrItemId, legacyQuantity) {
  const source = Array.isArray(returnsOrItemId)
    ? returnsOrItemId
    : returnsOrItemId && typeof returnsOrItemId === 'object'
      ? [returnsOrItemId]
      : [{ itemId: returnsOrItemId, quantity: legacyQuantity }];
  if (!source.length) throw new Error('Qaytariladigan anjom tanlanmagan.');
  const byItemId = new Map();
  for (const entry of source) {
    const itemId = String(entry?.itemId || '').trim();
    if (!itemId) throw new Error('Qaytariladigan anjom topilmadi.');
    const rawQuantity = entry?.quantity;
    if (rawQuantity === null || rawQuantity === undefined || String(rawQuantity).trim() === '') {
      throw new Error('Qaytarilgan sonini kiriting.');
    }
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error('Qaytarilgan soni butun, manfiy bo‘lmagan son bo‘lishi kerak.');
    }
    if (quantity === 0) continue;
    byItemId.set(itemId, (byItemId.get(itemId) || 0) + quantity);
  }
  const requests = Array.from(byItemId, ([itemId, quantity]) => ({ itemId, quantity }));
  if (!requests.length) throw new Error('Kamida bitta anjom uchun qaytarilgan sonini kiriting.');
  return requests;
}

export async function fetchRentals() {
  const db = requireClient();
  const [rentals, customers, items] = await Promise.all([
    unwrap(db.from('rentals').select('*').order('started_at', { ascending: false })),
    unwrap(db.from('customers').select('*')),
    unwrap(db.from('rental_items').select('*').gt('quantity', 0).order('rental_id').order('id')),
  ]);
  const customerById = new Map((customers || []).map((row) => [row.id, row]));
  const itemsByRental = (items || []).reduce((map, row) => {
    const item = toItem(row);
    if (!map[item.rentalId]) map[item.rentalId] = [];
    map[item.rentalId].push(item);
    return map;
  }, {});
  return (rentals || []).map((row) => {
    const customer = customerById.get(row.customer_id) || {};
    return {
      id: row.id,
      startedAt: row.started_at,
      status: row.status,
      closedAt: row.closed_at || null,
      customerName: customer.full_name || 'Noma’lum mijoz',
      phone: customer.phone || '',
      items: itemsByRental[row.id] || [],
    };
  });
}

export async function fetchEquipmentTypes() {
  const db = requireClient();
  const [types, rentals, items] = await Promise.all([
    unwrap(db.from('equipment_types').select('*').order('name')),
    unwrap(db.from('rentals').select('id,status')),
    unwrap(db.from('rental_items').select('equipment_type_id,rental_id,quantity,status').eq('status', 'open').gt('quantity', 0)),
  ]);
  const activeRentalIds = new Set((rentals || []).filter((row) => row.status !== 'closed').map((row) => row.id));
  const rentedByType = (items || []).reduce((map, row) => {
    if (activeRentalIds.has(row.rental_id)) {
      map.set(row.equipment_type_id, (map.get(row.equipment_type_id) || 0) + (Number(row.quantity) || 0));
    }
    return map;
  }, new Map());
  return (types || []).map((row) => {
    const totalQuantity = Math.max(0, Number(row.total_quantity) || 0);
    const rentedQuantity = Math.max(0, rentedByType.get(row.id) || 0);
    return {
      id: row.id,
      name: row.name,
      dailyPrice: Number(row.daily_price) || 0,
      totalQuantity,
      rentedQuantity,
      availableQuantity: Math.max(0, totalQuantity - rentedQuantity),
    };
  });
}

export async function createEquipmentType(payload) {
  const item = normaliseEquipmentPayload(payload);
  const id = createId('eq');
  await unwrap(requireClient().from('equipment_types').insert({
    id,
    name: item.name,
    daily_price: item.dailyPrice,
    total_quantity: item.totalQuantity,
  }));
  return id;
}

async function activeRentedQuantity(db, equipmentId) {
  const [rentals, items] = await Promise.all([
    unwrap(db.from('rentals').select('id,status')),
    unwrap(db.from('rental_items').select('rental_id,quantity').eq('equipment_type_id', equipmentId).eq('status', 'open').gt('quantity', 0)),
  ]);
  const active = new Set((rentals || []).filter((row) => row.status !== 'closed').map((row) => row.id));
  return (items || []).reduce((sum, row) => sum + (active.has(row.rental_id) ? Number(row.quantity) || 0 : 0), 0);
}

export async function updateEquipmentType(equipmentId, payload) {
  const item = normaliseEquipmentPayload(payload);
  const db = requireClient();
  const rentedQuantity = await activeRentedQuantity(db, equipmentId);
  if (item.totalQuantity < rentedQuantity) {
    throw new Error(`Umumiy miqdor band bo‘lgan ${rentedQuantity} donadan kam bo‘lishi mumkin emas.`);
  }
  await unwrap(db.from('equipment_types').update({
    name: item.name,
    daily_price: item.dailyPrice,
    total_quantity: item.totalQuantity,
  }).eq('id', equipmentId));
  await unwrap(db.from('rental_items').update({ name: item.name }).eq('equipment_type_id', equipmentId).eq('status', 'open'));
  return equipmentId;
}

export async function deleteEquipmentType(equipmentId) {
  const db = requireClient();
  if (await activeRentedQuantity(db, equipmentId) > 0) {
    throw new Error('Bu anjom faol ijarada band. Avval barcha qismlar qaytarilsin.');
  }
  await unwrap(db.from('rental_items').update({ equipment_type_id: null }).eq('equipment_type_id', equipmentId));
  await unwrap(db.from('equipment_types').delete().eq('id', equipmentId));
  return equipmentId;
}

export async function createRental(payload) {
  const now = new Date().toISOString();
  const rentalId = createId('rental');
  const customerId = createId('customer');
  const items = (payload.items || []).map((item) => ({
    id: createId('item'),
    equipmentTypeId: createId('eq'),
    name: String(item.name || '').trim(),
    quantity: Number(item.quantity),
    dailyPrice: Number(item.dailyPrice),
  }));
  if (!items.length) throw new Error('Kamida bitta anjom tanlang.');
  await unwrap(requireClient().rpc('create_rental_with_items', {
    p_rental_id: rentalId,
    p_customer_id: customerId,
    p_customer_name: payload.customerName,
    p_phone: payload.phone,
    p_items: items,
    p_started_at: now,
  }));
  return rentalId;
}

export async function registerReturn(rentalId, returnsOrItemId, legacyQuantity) {
  const requests = normaliseReturnRequests(returnsOrItemId, legacyQuantity);
  const returnedAt = new Date().toISOString();
  const data = await unwrap(requireClient().rpc('register_rental_return', {
    p_rental_id: rentalId,
    p_requests: requests,
    p_returned_at: returnedAt,
  }));
  const outcome = data || {};
  const returnedRows = (outcome.returnedRows || []).map(toReturnedRpcItem);
  const remainingRows = (outcome.remainingRows || []).map(toReturnedRpcItem);
  const wasClosed = Boolean(outcome.wasClosed);
  return {
    rentalId,
    returnedAt: outcome.returnedAt || returnedAt,
    returnedRows,
    remainingRows,
    wasClosed,
    receipt: {
      kind: wasClosed ? 'final' : 'partial',
      type: wasClosed ? 'final' : 'partial',
      returnedItemIds: returnedRows.map((item) => item.id),
      remainingItemIds: remainingRows.map((item) => item.id),
    },
  };
}

export async function getSetting(key) {
  const rows = await unwrap(requireClient().from('settings').select('value').eq('key', key).maybeSingle());
  return rows?.value;
}

export async function setSetting(key, value) {
  await unwrap(requireClient().from('settings').upsert({ key, value }, { onConflict: 'key' }));
}

export async function logSentMessage(rentalId, channel, message, status = 'sent') {
  await unwrap(requireClient().from('sent_messages').insert({
    id: createId('message'),
    rental_id: rentalId,
    channel,
    message,
    status,
    created_at: new Date().toISOString(),
  }));
}
