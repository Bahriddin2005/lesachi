export const DAY_MS = 86_400_000;
export const BUSINESS_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

export function createId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function dayCount(from, to = new Date()) {
  const start = new Date(from || to);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 1;
  // Uzbekistan has a fixed UTC+5 business day. Converting timestamps to a
  // civil-day serial avoids DST/device-timezone errors and keeps the inclusive
  // "olgan kun + qaytargan/bungi kun" rule identical on every device.
  const civilDay = (date) => {
    const shifted = new Date(date.getTime() + BUSINESS_UTC_OFFSET_MS);
    return Math.floor(Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) / DAY_MS);
  };
  return Math.max(1, civilDay(end) - civilDay(start) + 1);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function savedAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rentalItems(rental) {
  return Array.isArray(rental?.items) ? rental.items : [];
}

function legacyReturns(item) {
  return Array.isArray(item?.returns) ? item.returns : [];
}

function quantityOf(item) {
  return Math.max(0, numberValue(item?.quantity));
}

function dailyPriceOf(item) {
  return Math.max(0, numberValue(item?.dailyPrice));
}

/** The original checkout date belongs to an item after a split, not just the rental. */
export function itemStartedAt(rental, item) {
  return item?.startedAt || rental?.startedAt;
}

export function isReturnedItem(item) {
  return item?.status === 'returned' || (item?.status !== 'open' && Boolean(item?.returnedAt));
}

export function isOpenItem(item) {
  return item?.status === 'open' || (!item?.status && !item?.returnedAt);
}

/**
 * Supports the current split-row model and the former `item_returns` model.
 * A split returned row represents only its frozen quantity; an old row can
 * still contain both returned and open quantities through `returns`.
 */
export function returnedQuantity(item) {
  if (isReturnedItem(item)) return quantityOf(item);
  if (item?.status === 'open') return 0;
  return legacyReturns(item).reduce((total, entry) => total + Math.max(0, numberValue(entry.quantity)), 0);
}

export function openQuantity(item) {
  if (isReturnedItem(item)) return 0;
  if (item?.status === 'open') return quantityOf(item);
  return Math.max(0, quantityOf(item) - returnedQuantity(item));
}

function frozenAmountForReturn(rental, item, returnedAt, quantity, persistedAmount) {
  const saved = savedAmount(persistedAmount);
  if (saved !== null) return saved;
  return dayCount(itemStartedAt(rental, item), returnedAt) * dailyPriceOf(item) * quantity;
}

/** Amount that can no longer grow because this row/quantity was returned. */
export function frozenItemTotal(rental, item) {
  if (isReturnedItem(item)) {
    return frozenAmountForReturn(rental, item, item.returnedAt, quantityOf(item), item.frozenAmount);
  }
  if (item?.status === 'open') return 0;
  return legacyReturns(item).reduce((total, entry) => (
    total + frozenAmountForReturn(
      rental,
      { ...item, startedAt: entry.startedAt || itemStartedAt(rental, item) },
      entry.returnedAt,
      Math.max(0, numberValue(entry.quantity)),
      entry.frozenAmount,
    )
  ), 0);
}

/** Real-time debt for only the quantities that remain with the customer. */
export function currentItemTotal(rental, item, now = new Date()) {
  const quantity = openQuantity(item);
  if (!quantity) return 0;
  return dayCount(itemStartedAt(rental, item), now) * dailyPriceOf(item) * quantity;
}

/**
 * The full accrued amount is retained for compatibility with the existing
 * history UI. Use `currentDebtTotal` for a customer's current debt.
 */
export function itemTotal(rental, item, now = new Date()) {
  return frozenItemTotal(rental, item) + currentItemTotal(rental, item, now);
}

export function paidItemAmount(rental, item) {
  const frozen = frozenItemTotal(rental, item);
  const saved = savedAmount(item?.paidAmount);
  const paid = saved !== null ? saved : item?.paid ? frozen : 0;
  return Math.min(frozen, Math.max(0, paid));
}

export function pendingItemAmount(rental, item) {
  return Math.max(0, frozenItemTotal(rental, item) - paidItemAmount(rental, item));
}

export function paidTotal(rental) {
  return rentalItems(rental).reduce((total, item) => total + paidItemAmount(rental, item), 0);
}

export function returnedTotal(rental) {
  return rentalItems(rental).reduce((total, item) => total + frozenItemTotal(rental, item), 0);
}

export function pendingTotal(rental) {
  return rentalItems(rental).reduce((total, item) => total + pendingItemAmount(rental, item), 0);
}

export const frozenRentalTotal = returnedTotal;

export function currentDebtTotal(rental, now = new Date()) {
  return rentalItems(rental).reduce((total, item) => total + currentItemTotal(rental, item, now), 0);
}

// Short alias used by the dashboard and customer views.
export const currentDebt = currentDebtTotal;
export const currentRentalTotal = currentDebtTotal;
export const openRentalTotal = currentDebtTotal;

export function rentalTotal(rental, now = new Date()) {
  return returnedTotal(rental) + currentDebtTotal(rental, now);
}

export function isClosed(rental) {
  const items = rentalItems(rental);
  return items.length > 0 && items.every((item) => openQuantity(item) === 0);
}

export function formatMoney(value) {
  const formatted = new Intl.NumberFormat('uz-UZ').format(Math.round(value || 0)).replace(/\u00a0/g, ' ');
  return `${formatted} so‘m`;
}

/**
 * Human-readable calculation used by every receipt surface.
 * The one-day factor is omitted to keep a new rental concise, while older
 * rentals include it so the displayed multiplication always equals the total.
 */
export function receiptCalculationText(line = {}) {
  const quantity = Math.max(0, numberValue(line.quantity));
  const dailyPrice = Math.max(0, numberValue(line.dailyPrice));
  const days = Math.max(1, numberValue(line.days) || 1);
  const persistedAmount = savedAmount(line.amount ?? line.frozenAmount);
  const amount = persistedAmount ?? quantity * dailyPrice * days;
  const dayFactor = days > 1 ? ` × ${days} kun` : '';
  return `${quantity} ta × ${formatMoney(dailyPrice)}${dayFactor} = ${formatMoney(amount)}`;
}

export function formatDate(value, includeTime = false) {
  const date = new Date(value || new Date());
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
  }
  return new Intl.DateTimeFormat('uz-UZ', options).format(safeDate);
}

export function initials(name = '') {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function receiptType(value) {
  return ['new', 'current', 'partial', 'edit', 'final'].includes(value) ? value : null;
}

/**
 * Receipt helpers accept either a rental directly or an envelope such as:
 * { rental, type: 'partial', returnedItemIds: ['new-return-row-id'] }.
 * `kind` remains accepted while callers are migrated to `type`.
 */
export function resolveReceipt(rentalOrReceipt, receiptContext = {}) {
  const isEnvelope = Boolean(rentalOrReceipt?.rental && Array.isArray(rentalOrReceipt.rental.items));
  const envelope = isEnvelope ? rentalOrReceipt : {};
  const context = receiptContext && typeof receiptContext === 'object' ? receiptContext : {};
  const rental = envelope.rental || context.rental || rentalOrReceipt || { items: [] };
  const requestedType = receiptType(context.type || context.kind || envelope.type || envelope.kind)
    || (isClosed(rental) ? 'final' : 'current');
  const ids = context.returnedItemIds ?? envelope.returnedItemIds ?? [];
  const returnedItemIds = (Array.isArray(ids) ? ids : [ids])
    .map((id) => (typeof id === 'object' && id ? id.id : id))
    .filter((id) => id !== undefined && id !== null)
    .map((id) => String(id));
  const addedIds = context.addedItemIds ?? envelope.addedItemIds ?? [];
  const addedItemIds = (Array.isArray(addedIds) ? addedIds : [addedIds])
    .map((id) => (typeof id === 'object' && id ? id.id : id))
    .filter((id) => id !== undefined && id !== null)
    .map((id) => String(id));
  return { rental, type: requestedType, returnedItemIds, addedItemIds };
}

function returnedLine(rental, item, overrides = {}) {
  const quantity = Math.max(0, numberValue(overrides.quantity ?? item.quantity));
  const startedAt = overrides.startedAt || itemStartedAt(rental, item);
  const returnedAt = overrides.returnedAt || item.returnedAt;
  const amount = frozenAmountForReturn(
    rental,
    { ...item, startedAt },
    returnedAt,
    quantity,
    overrides.frozenAmount ?? item.frozenAmount,
  );
  const savedPaidAmount = savedAmount(overrides.paidAmount ?? item.paidAmount);
  const paidAmount = Math.min(amount, Math.max(0, savedPaidAmount !== null ? savedPaidAmount : item.paid ? amount : 0));
  const outstandingAmount = Math.max(0, amount - paidAmount);
  return {
    ...item,
    ...overrides,
    id: overrides.id || item.id,
    sourceItemId: item.id,
    name: overrides.name || item.name || 'Anjom',
    quantity,
    dailyPrice: dailyPriceOf(item),
    startedAt,
    returnedAt,
    status: 'returned',
    frozenAmount: amount,
    amount,
    paidAmount,
    outstandingAmount,
    paid: outstandingAmount === 0,
    days: dayCount(startedAt, returnedAt),
  };
}

function openLine(rental, item) {
  const quantity = openQuantity(item);
  const startedAt = itemStartedAt(rental, item);
  const amount = currentItemTotal(rental, item);
  return {
    ...item,
    sourceItemId: item.id,
    name: item.name || 'Anjom',
    quantity,
    dailyPrice: dailyPriceOf(item),
    startedAt,
    returnedAt: null,
    status: 'open',
    amount,
    days: dayCount(startedAt),
  };
}

/** Returned lines, including a compatibility expansion of old `returns` arrays. */
export function returnedItemLines(rental) {
  return rentalItems(rental).flatMap((item) => {
    if (isReturnedItem(item)) return [returnedLine(rental, item)];
    if (item?.status === 'open') return [];
    return legacyReturns(item).map((entry, index) => returnedLine(rental, item, {
      ...entry,
      id: entry.id || `${item.id || 'item'}_return_${index}`,
      startedAt: entry.startedAt || itemStartedAt(rental, item),
      returnedAt: entry.returnedAt,
      quantity: entry.quantity,
      frozenAmount: entry.frozenAmount,
    }));
  });
}

/** Rows still physically with the customer and therefore still accruing. */
export function openItemLines(rental) {
  return rentalItems(rental)
    .filter((item) => openQuantity(item) > 0)
    .map((item) => openLine(rental, item));
}

function sumLines(lines) {
  return lines.reduce((total, item) => total + numberValue(item.amount), 0);
}

function selectedReturnedLines(lines, ids) {
  if (!ids.length) return lines;
  const selected = new Set(ids);
  const exact = lines.filter((item) => selected.has(String(item.id)));
  if (exact.length) return exact;
  // Accept a source row ID too, which helps receipts created from pre-split data.
  return lines.filter((item) => selected.has(String(item.sourceItemId)));
}

function selectedOpenLines(lines, ids) {
  if (!ids.length) return lines;
  const selected = new Set(ids);
  const exact = lines.filter((item) => selected.has(String(item.id)));
  return exact.length ? exact : lines.filter((item) => selected.has(String(item.sourceItemId)));
}

/**
 * Gives native UI, HTML/PDF and SMS the same split-aware accounting view.
 * For a partial receipt, `returnedItems` and `returnedTotal` are only the
 * rows returned in that action; pass their newly-created returned row IDs.
 */
export function receiptBreakdown(rentalOrReceipt, receiptContext = {}) {
  const context = resolveReceipt(rentalOrReceipt, receiptContext);
  const allReturnedItems = returnedItemLines(context.rental);
  const openItems = openItemLines(context.rental);
  const inferredFinal = context.type !== 'new' && (context.type === 'final' || isClosed(context.rental));
  const type = inferredFinal ? 'final' : context.type;
  const returnedItems = type === 'partial' || type === 'edit'
    ? selectedReturnedLines(allReturnedItems, context.returnedItemIds)
    : type === 'new'
      ? []
      : allReturnedItems;
  const addedItems = type === 'edit' || type === 'new'
    ? selectedOpenLines(openItems, context.addedItemIds)
    : [];
  const addedIds = new Set(addedItems.map((item) => String(item.id)));
  const otherOpenItems = type === 'edit'
    ? openItems.filter((item) => !addedIds.has(String(item.id)))
    : openItems;
  const returnedTotal = sumLines(returnedItems);
  const currentDebt = sumLines(openItems);
  const returnedPaidTotal = allReturnedItems.reduce((sum, item) => sum + numberValue(item.paidAmount), 0);
  const pendingPaymentTotal = allReturnedItems.reduce((sum, item) => sum + numberValue(item.outstandingAmount), 0);
  const frozenTotal = sumLines(allReturnedItems);
  return {
    ...context,
    type,
    isFinal: type === 'final',
    returnedItems,
    addedItems,
    otherOpenItems,
    openItems,
    returnedTotal,
    currentDebt,
    finalTotal: frozenTotal + currentDebt,
    paidTotal: returnedPaidTotal,
    pendingPaymentTotal,
    allReturnedItems,
    remainingQuantity: openItems.reduce((total, item) => total + item.quantity, 0),
  };
}

function receiptHeading(type) {
  if (type === 'new') return 'YANGI IJARA CHEKI';
  if (type === 'partial') return 'QISMAN QAYTARISH CHEKI';
  if (type === 'edit') return 'IJARA O‘ZGARISHI CHEKI';
  if (type === 'final') return 'YAKUNIY CHEK';
  return 'JORIY HOLAT CHEKI';
}

function receiptDate(value) {
  const parsed = new Date(value || new Date());
  const safeDate = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(safeDate);
}

function outputItems(breakdown) {
  if (breakdown.type === 'new') return breakdown.addedItemIds.length
    ? [...breakdown.allReturnedItems, ...breakdown.openItems]
    : breakdown.openItems;
  if (breakdown.type === 'partial') return [...breakdown.returnedItems, ...breakdown.openItems];
  if (breakdown.type === 'edit') return [...breakdown.allReturnedItems, ...breakdown.openItems];
  if (breakdown.type === 'final') return breakdown.returnedItems;
  return [...breakdown.returnedItems, ...breakdown.openItems];
}

function receiptOutputTotal(breakdown, items) {
  if (breakdown.type === 'partial') return breakdown.returnedTotal;
  if (breakdown.type === 'new') return items.reduce((sum, item) => sum + numberValue(item.amount), 0);
  return breakdown.finalTotal;
}

function receiptActivityLines(activity) {
  if (!Array.isArray(activity) || !activity.length) return [];
  return activity.map((event) => {
    const actor = event.actor || 'Admin';
    if (event.type === 'payment') return `${receiptDate(event.createdAt)} · TO'LOV ${smsMoney(event.amount)} · ${actor}`;
    if (event.type === 'return') {
      const names = Array.isArray(event.details?.items)
        ? event.details.items.map((item) => `${item.quantity} dona ${item.name}`).join(', ')
        : `${event.quantity || 0} dona anjom`;
      return `${receiptDate(event.createdAt)} · QAYTARILDI: ${names} · ${actor}`;
    }
    const changes = Array.isArray(event.details?.after)
      ? event.details.after.map((item) => `${item.quantity} dona ${item.name}`).join(', ')
      : "Ijara ma'lumotlari yangilandi";
    return `${receiptDate(event.createdAt)} · TAHRIRLANDI: ${changes} · ${actor}`;
  });
}

/** Full, detailed receipt for the screen, PDF, print and app sharing. */
export function receiptText(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { rental, type, currentDebt, remainingQuantity } = breakdown;
  const items = outputItems(breakdown);
  const itemLines = items.flatMap((item) => {
    const returned = item.status === 'returned';
    const state = returned ? 'qaytarildi' : 'hozircha mijozda';
    const payment = returned && item.outstandingAmount > 0
      ? [`  ⏳ to'lov kutilmoqda: ${smsMoney(item.outstandingAmount)}`]
      : returned && item.paid
        ? ["  ✅ to'landi"]
        : [];
    return [
      `• ${item.name} × ${item.quantity} — ${smsMoney(item.dailyPrice)}/kun`,
      `  ${item.quantity} dona × ${item.days} kun (${state}) = ${smsMoney(item.amount)}`,
      `  Olindi: ${receiptDate(item.startedAt || rental.startedAt)}`,
      ...payment,
      `  ⤵ Jami: ${smsMoney(item.amount)}`,
    ];
  });
  const lines = [
    `🧾 ${receiptHeading(type)}`,
    '━━━━━━━━━━━━━━━━━━',
    `👤 Mijoz: ${rental.customerName || '—'}`,
    `📞 Tel: ${rental.phone || '—'}`,
    `📅 Olindi: ${receiptDate(rental.startedAt)}`,
    `📅 Hisob sanasi: ${receiptDate(new Date())}`,
    '━━━━━━━━━━━━━━━━━━',
    'Anjomlar:',
    ...(itemLines.length ? itemLines : ['• Anjom topilmadi']),
    '━━━━━━━━━━━━━━━━━━',
  ];

  if (type === 'partial' && breakdown.openItems.length) {
    lines.push(`Qaytarilgan qism: ${smsMoney(breakdown.returnedTotal)}`);
    lines.push(`Joriy qarz: ${smsMoney(currentDebt)} (to'lovga qo'shilmagan)`);
    lines.push(`Eslatma: qolgan ${remainingQuantity} dona anjom uchun kunlik hisob davom etadi.`);
  }
  if (breakdown.pendingPaymentTotal > 0) lines.push(`⏳ TO'LOV KUTILMOQDA: ${smsMoney(breakdown.pendingPaymentTotal)}`);
  lines.push(`💰 JAMI: ${smsMoney(receiptOutputTotal(breakdown, items))}`);

  const activity = receiptActivityLines(rental.activity);
  if (activity.length) lines.push('', 'AMALLAR TARIXI', ...activity);
  lines.push('', 'Rahmat! 🙏');
  return lines.join('\n');
}

function smsMoney(value) {
  return formatMoney(value).replace('so‘m', "so'm");
}

function smsDate(value) {
  const parsed = new Date(value || new Date());
  const safeDate = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const day = String(safeDate.getDate()).padStart(2, '0');
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${safeDate.getFullYear()}`;
}

const CYRILLIC_TO_LATIN = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'Yo', Ж: 'J', З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'X', Ц: 'S', Ч: 'Ch', Ш: 'Sh', Щ: 'Sh', Ъ: '', Ы: 'I', Ь: '', Э: 'E', Ю: 'Yu', Я: 'Ya',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  Ў: "O'", ў: "o'", Қ: 'Q', қ: 'q', Ғ: "G'", ғ: "g'", Ҳ: 'H', ҳ: 'h',
};

function smsLatin(value) {
  return String(value || '')
    .replace(/[А-Яа-яЁёЎўҚқҒғҲҳ]/g, (letter) => CYRILLIC_TO_LATIN[letter] ?? '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortItemName(name) {
  const latin = smsLatin(name || 'anjom');
  return latin.length > 20 ? `${latin.slice(0, 19).trim()}.` : latin;
}

function smsItemsSummary(items) {
  const visible = items.slice(0, 2).map((item) => `${item.quantity} dona ${shortItemName(item.name)}`);
  if (items.length > 2) visible.push(`yana ${items.length - 2} tur anjom`);
  return visible.join(', ');
}

function smsLimit(preferred, fallback) {
  const normalized = smsLatin(preferred);
  if (normalized.length <= 160) return normalized;
  const safeFallback = smsLatin(fallback);
  return safeFallback.length <= 160 ? safeFallback : `${safeFallback.slice(0, 157).trimEnd()}...`;
}

/** A concise Latin-only summary for the manual SMS queue (never over 160 characters). */
export function receiptSmsText(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { rental, type, returnedItems, addedItems, openItems, returnedTotal, currentDebt, finalTotal } = breakdown;
  const openCount = openItems.reduce((sum, item) => sum + numberValue(item.quantity), 0);
  const returnedCount = returnedItems.reduce((sum, item) => sum + numberValue(item.quantity), 0);
  if (type === 'edit') {
    const returnedPart = returnedCount ? `${returnedCount} dona qaytdi. ` : '';
    const addedCount = addedItems.reduce((sum, item) => sum + numberValue(item.quantity), 0);
    const addedPart = addedCount ? `${addedCount} dona qo'shildi. ` : '';
    return smsLimit(
      `Lesachi: ${returnedPart}${addedPart}Sizda ${openCount} dona anjom bor. Joriy qarz ${smsMoney(currentDebt)}. To'liq chek ilovada.`,
      `Lesachi: Ijara yangilandi. Joriy qarz ${smsMoney(currentDebt)}. To'liq chek ilovada.`,
    );
  }
  if (type === 'partial') {
    return smsLimit(
      `Lesachi: ${returnedCount} dona anjom qaytarildi. Hisob ${smsMoney(returnedTotal)}. Sizda ${openCount} dona qoldi; joriy qarz ${smsMoney(currentDebt)}.`,
      `Lesachi: ${returnedCount} dona qaytarildi. Sizda ${openCount} dona qoldi. Joriy qarz ${smsMoney(currentDebt)}.`,
    );
  }
  if (type === 'final') {
    return smsLimit(
      `Lesachi: Barcha anjomlar qaytarildi. Yakuniy hisob ${smsMoney(finalTotal)}. To'liq chek ilovada mavjud.`,
      `Lesachi: Anjomlar qaytarildi. Hisob ${smsMoney(finalTotal)}. Chek ilovada.`,
    );
  }
  if (type === 'new') {
    const items = addedItems.length ? addedItems : openItems;
    const additional = breakdown.addedItemIds.length > 0;
    const startedAt = items[0]?.startedAt || rental.startedAt;
    const action = additional ? "Qo'shimcha" : 'Siz';
    const summary = smsItemsSummary(items);
    const totalCount = items.reduce((sum, item) => sum + numberValue(item.quantity), 0);
    return smsLimit(
      `Lesachi: ${action} ${summary} oldingiz. Hisob ${smsDate(startedAt)} dan yuradi. To'liq chek ilovada mavjud.`,
      `Lesachi: ${additional ? "Qo'shimcha " : ''}${totalCount} dona anjom olindi. Hisob ${smsDate(startedAt)} dan yuradi. To'liq chek ilovada.`,
    );
  }
  if (openItems.length) {
    const days = Math.max(...openItems.map((item) => Math.max(1, numberValue(item.days))), 1);
    return smsLimit(
      `Lesachi: Joriy qarzingiz ${smsMoney(currentDebt)} (${days} kun). To'liq chek ilovada mavjud.`,
      `Lesachi: Joriy qarz ${smsMoney(currentDebt)}. To'liq chek ilovada.`,
    );
  }
  return smsLimit(
    `Lesachi: Yakuniy hisobingiz ${smsMoney(finalTotal)}. To'liq chek ilovada mavjud.`,
    `Lesachi: Yakuniy hisob ${smsMoney(finalTotal)}.`,
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function rowsHtml(lines, status) {
  if (!lines.length) return '<tr><td colspan="4" class="empty">Ma’lumot yo‘q</td></tr>';
  return lines.map((item) => {
    const isReturned = status === 'returned';
    const isPaid = isReturned && item.paid === true;
    const paymentState = isPaid
      ? '✓ TO‘LANDI'
      : item.paidAmount > 0
        ? `◐ QISMAN TO‘LANDI ${formatMoney(item.paidAmount)} · QOLDI ${formatMoney(item.outstandingAmount)}`
        : '◷ TO‘LOV KUTILMOQDA';
    const detail = isReturned
      ? `(qaytarildi) · ${item.days} kun · ${formatDate(item.returnedAt, true)} · ${paymentState}`
      : `(hozircha mijozda) · ${item.days} kun · JORIY QARZ o‘sishda davom etadi`;
    return `<tr>
      <td><strong>${escapeHtml(item.name)}</strong><small>Olindi: ${escapeHtml(receiptDate(item.startedAt))}</small><small class="calculation">${escapeHtml(receiptCalculationText(item))}</small><small class="${isReturned ? 'paid-note' : 'open-note'}">${escapeHtml(detail)}</small></td>
      <td>${escapeHtml(`${item.quantity} ta`)}</td>
      <td>${escapeHtml(formatMoney(item.dailyPrice))}</td>
      <td class="amount ${isPaid ? 'paid-amount' : isReturned ? 'pending-amount' : 'open-amount'}">${escapeHtml(formatMoney(item.amount))}</td>
    </tr>`;
  }).join('');
}

function sectionHtml(title, lines, status) {
  return `<section class="section">
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr><th>ANJOM</th><th>SONI</th><th>KUNLIK NARX</th><th class="right">SUMMA</th></tr></thead>
      <tbody>${rowsHtml(lines, status)}</tbody>
    </table>
  </section>`;
}

function summaryHtml(label, amount, kind = 'paid', detail = '') {
  return `<div class="summary ${kind}"><div><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div><strong>${escapeHtml(formatMoney(amount))}</strong></div>`;
}

function activityHtml(activity) {
  if (!Array.isArray(activity) || !activity.length) return '';
  const rows = activity.map((event) => {
    const actor = event.actor || 'Admin';
    const description = event.type === 'payment'
      ? `To‘lov qabul qilindi — ${formatMoney(event.amount)}`
      : event.type === 'edit'
        ? `Tahrirlandi — ${Array.isArray(event.details?.after) ? event.details.after.map((item) => `${item.quantity} ta ${item.name}, ${formatMoney(item.dailyPrice)}/kun, ${formatDate(item.startedAt)}`).join('; ') : 'ijara ma’lumotlari yangilandi'}`
        : `Qaytarildi — ${Array.isArray(event.details?.items) ? event.details.items.map((item) => `${item.quantity} ta ${item.name}`).join(', ') : `${event.quantity || 0} ta anjom`}`;
    return `<tr><td>${escapeHtml(formatDate(event.createdAt, true))}</td><td>${escapeHtml(description)}</td><td>${escapeHtml(actor)}</td></tr>`;
  }).join('');
  return `<section class="section activity"><h2>AMALLAR TARIXI</h2><table><thead><tr><th>SANA</th><th>AMAL</th><th>KIM</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function receiptHtml(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { rental, type, returnedItems, addedItems, openItems, otherOpenItems, returnedTotal, currentDebt, finalTotal, remainingQuantity } = breakdown;
  const id = String(rental.id || 'CHEK').slice(-8).toUpperCase();
  const paidReturnedItems = returnedItems.filter((item) => item.paid);
  const pendingReturnedItems = returnedItems.filter((item) => !item.paid);
  const paidReturnedTotal = returnedItems.reduce((sum, item) => sum + numberValue(item.paidAmount), 0);
  const pendingReturnedTotal = returnedItems.reduce((sum, item) => sum + numberValue(item.outstandingAmount), 0);
  let body = '';

  if (type === 'final') {
    body = `${paidReturnedItems.length ? sectionHtml('Qaytarilgan anjomlar — TO‘LANDI', paidReturnedItems, 'returned') : ''}
      ${pendingReturnedItems.length ? sectionHtml('Buyum qaytdi — TO‘LOV KUTILMOQDA', pendingReturnedItems, 'returned') : ''}
      ${paidReturnedTotal > 0 ? summaryHtml('TO‘LANGAN SUMMA', paidReturnedTotal, 'paid') : ''}
      ${pendingReturnedItems.length ? summaryHtml('TO‘LOV KUTILMOQDA', pendingReturnedTotal, 'current') : ''}
      ${!pendingReturnedItems.length ? summaryHtml('YAKUNIY TO‘LIQ SUMMA', finalTotal, 'paid') : ''}`;
  } else if (type === 'edit') {
    body = `${returnedItems.length ? `${sectionHtml('Qaytarilgan anjomlar', returnedItems, 'returned')}
      ${pendingReturnedItems.length ? summaryHtml('TO‘LOV KUTILMOQDA', pendingReturnedTotal, 'current') : summaryHtml('QAYTARILGAN SUMMA', returnedTotal, 'paid')}` : ''}
      ${addedItems.length ? sectionHtml('Qo‘shimcha olingan anjomlar — JORIY QARZ', addedItems, 'open') : ''}
      ${otherOpenItems.length ? `${sectionHtml('Hali mijozda — JORIY QARZ', otherOpenItems, 'open')}
      ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa o‘sishda davom etadi.')}` : ''}`;
  } else if (type === 'partial') {
    body = `${sectionHtml('Qaytarilgan qism', returnedItems, 'returned')}
      ${paidReturnedTotal > 0 ? summaryHtml('TO‘LANGAN QISM', paidReturnedTotal, 'paid') : ''}
      ${pendingReturnedItems.length ? summaryHtml('TO‘LOV KUTILMOQDA', pendingReturnedTotal, 'current') : ''}
      ${openItems.length ? `${sectionHtml('Hali mijozda — JORIY QARZ', openItems, 'open')}
        ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa chekdagi to‘lovga qo‘shilmagan.')}
        <p class="note">Eslatma: Qolgan ${escapeHtml(remainingQuantity)} dona anjom qaytarilmaguncha, kunlik hisob davom etadi.</p>` : ''}`;
  } else if (type === 'new') {
    body = `${sectionHtml('Mijozda — JORIY QARZ (hali to‘lanmagan)', openItems, 'open')}
      ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa hali to‘lov sifatida qabul qilinmagan.')}`;
  } else {
    body = `${returnedItems.length ? `${sectionHtml('Oldin qaytarilgan anjomlar', returnedItems, 'returned')}
      ${summaryHtml('TO‘LANGAN JAMI', paidReturnedTotal, 'paid')}
      ${pendingReturnedTotal > 0 ? summaryHtml('TO‘LOV KUTILMOQDA', pendingReturnedTotal, 'current') : ''}` : ''}
      ${openItems.length ? `${sectionHtml('Hali mijozda — JORIY QARZ', openItems, 'open')}
      ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa o‘sishda davom etadi.')}` : ''}`;
  }

  return `<!doctype html>
  <html lang="uz">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>LESA ${escapeHtml(receiptHeading(type))} #${escapeHtml(id)}</title>
      <style>
        @page { size: A4; margin: 16mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #172521; font-family: Arial, Helvetica, sans-serif; background: #fff; }
        .receipt { max-width: 760px; margin: 0 auto; border: 1px solid #dfe6e1; border-radius: 18px; padding: 28px; }
        header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 18px; border-bottom: 1px dashed #aab7b1; }
        .logo { color: #17483b; font-size: 26px; font-weight: 900; letter-spacing: 2px; }
        .logo small { display: block; margin-top: 3px; color: #71807b; font-size: 8px; letter-spacing: 1.4px; }
        .number { color: #71807b; font-size: 11px; }
        .receipt-type { margin: 15px 0 0; color: #17483b; font-size: 11px; font-weight: 800; letter-spacing: .5px; text-align: center; }
        .customer { padding: 19px 0 22px; text-align: center; }
        .customer h1 { margin: 0 0 5px; font-size: 20px; }
        .customer p { margin: 4px 0; color: #71807b; font-size: 12px; }
        .section { margin-top: 18px; }
        h2 { margin: 0 0 8px; color: #17483b; font-size: 11px; letter-spacing: .4px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { padding: 10px 8px; color: #71807b; font-size: 9px; text-align: left; border-bottom: 2px solid #172521; }
        .right { text-align: right; }
        td { padding: 13px 8px; border-bottom: 1px solid #edf1ee; vertical-align: top; }
        td small { display: block; margin-top: 5px; font-size: 9px; }
        .calculation { color: #172521; font-weight: 700; }
        .paid-note, .paid-amount { color: #21754e; }
        .open-note, .open-amount { color: #b5652d; }
        .amount { font-weight: 700; text-align: right; white-space: nowrap; }
        .empty { color: #71807b; text-align: center; }
        .summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 14px; padding: 16px 2px 0; border-top: 2px solid #172521; font-size: 14px; font-weight: 900; }
        .summary span { display: block; }
        .summary small { display: block; max-width: 360px; margin-top: 4px; color: #71807b; font-size: 9px; font-weight: 400; }
        .summary strong { white-space: nowrap; font-size: 18px; }
        .summary.paid strong { color: #17483b; }
        .summary.current { border-top-color: #d78242; }
        .summary.current strong { color: #b5652d; }
        .note { margin: 13px 0 0; padding: 11px 13px; border-radius: 9px; color: #53635d; background: #f0f4e9; font-size: 10px; line-height: 1.45; }
        footer { margin-top: 28px; color: #71807b; font-size: 9px; text-align: center; }
      </style>
    </head>
    <body>
      <main class="receipt">
        <header><div class="logo">LESA<small>IJARA BOSHQARUVI</small></div><div class="number">#${escapeHtml(id)}</div></header>
        <p class="receipt-type">${escapeHtml(receiptHeading(type))}</p>
        <section class="customer"><h1>${escapeHtml(rental.customerName)}</h1><p>${escapeHtml(rental.phone)}</p><p>Olingan sana: ${escapeHtml(receiptDate(rental.startedAt))}</p><p>Hisob sanasi: ${escapeHtml(receiptDate(new Date()))}</p></section>
        ${body}
        ${activityHtml(rental.activity)}
        <footer>Chek ${escapeHtml(formatDate(new Date(), true))} da LESA ilovasi orqali yaratildi.</footer>
      </main>
    </body>
  </html>`;
}
