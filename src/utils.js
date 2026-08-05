export const DAY_MS = 86_400_000;

export function createId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function dayCount(from, to = new Date()) {
  const start = new Date(from || to);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 1;
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.floor((end - start) / DAY_MS) + 1);
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

export function paidTotal(rental) {
  return rentalItems(rental).reduce((total, item) => total + frozenItemTotal(rental, item), 0);
}

export const frozenRentalTotal = paidTotal;

export function currentDebtTotal(rental, now = new Date()) {
  return rentalItems(rental).reduce((total, item) => total + currentItemTotal(rental, item, now), 0);
}

// Short alias used by the dashboard and customer views.
export const currentDebt = currentDebtTotal;
export const currentRentalTotal = currentDebtTotal;
export const openRentalTotal = currentDebtTotal;

export function rentalTotal(rental, now = new Date()) {
  return paidTotal(rental) + currentDebtTotal(rental, now);
}

export function isClosed(rental) {
  const items = rentalItems(rental);
  return items.length > 0 && items.every((item) => openQuantity(item) === 0);
}

export function formatMoney(value) {
  const formatted = new Intl.NumberFormat('uz-UZ').format(Math.round(value || 0)).replace(/\u00a0/g, ' ');
  return `${formatted} so‘m`;
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
  const paid = sumLines(allReturnedItems);
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
    finalTotal: paid + currentDebt,
    paidTotal: paid,
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

function lineText(line, status) {
  const label = status === 'returned' ? 'TO‘LANDI' : 'JORIY QARZ';
  const growth = status === 'returned' ? '' : ' · o‘sishda davom etadi';
  return `${label} — ${line.name}: ${line.quantity} dona × ${formatMoney(line.dailyPrice)} × ${line.days} kun = ${formatMoney(line.amount)}${growth}`;
}

function openDescription(openItems) {
  const parts = openItems.map((item) => `${item.quantity} dona ${item.name}`);
  if (parts.length < 2) return parts[0] || 'anjom';
  if (parts.length === 2) return `${parts[0]} va ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} va ${parts.at(-1)}`;
}

export function receiptText(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { rental, type, returnedItems, addedItems, openItems, otherOpenItems, returnedTotal, currentDebt, finalTotal, remainingQuantity } = breakdown;
  const lines = [
    `LESA — ${receiptHeading(type)}`,
    `Mijoz: ${rental.customerName || '—'}`,
    `Telefon: ${rental.phone || '—'}`,
    `Olingan sana: ${formatDate(rental.startedAt, true)}`,
    '',
  ];

  if (type === 'final') {
    lines.push('QAYTARILGAN ANJOMLAR — TO‘LANDI');
    lines.push(...returnedItems.map((item) => lineText(item, 'returned')));
    lines.push('', `YAKUNIY TO‘LIQ SUMMA: ${formatMoney(finalTotal)}`);
  } else if (type === 'edit') {
    if (returnedItems.length) {
      lines.push('QAYTARILGAN ANJOMLAR — TO‘LANDI');
      lines.push(...returnedItems.map((item) => lineText(item, 'returned')));
      lines.push('', `QABUL QILINGAN TO‘LOV: ${formatMoney(returnedTotal)}`);
    }
    if (addedItems.length) {
      lines.push('', 'QO‘SHIMCHA OLINGAN ANJOMLAR — JORIY QARZ');
      lines.push(...addedItems.map((item) => lineText(item, 'open')));
    }
    if (otherOpenItems.length) {
      lines.push('', 'HALI MIJOZDA — JORIY QARZ');
      lines.push(...otherOpenItems.map((item) => lineText(item, 'open')));
      lines.push(`JORIY QARZ: ${formatMoney(currentDebt)}`);
    }
  } else if (type === 'partial') {
    lines.push('QAYTARILGAN QISM — TO‘LANDI');
    lines.push(...(returnedItems.length ? returnedItems.map((item) => lineText(item, 'returned')) : ['Qaytarilgan anjom topilmadi.']));
    lines.push('', `QABUL QILINGAN TO‘LOV: ${formatMoney(returnedTotal)}`);
    if (openItems.length) {
      lines.push('', 'HALI MIJOZDA — JORIY QARZ (TO‘LOVGA QO‘SHILMAGAN)');
      lines.push(...openItems.map((item) => lineText(item, 'open')));
      lines.push(`JORIY QARZ: ${formatMoney(currentDebt)}`);
      lines.push(`Eslatma: Qolgan ${remainingQuantity} dona anjom qaytarilmaguncha, kunlik hisob davom etadi.`);
    }
  } else if (type === 'new') {
    lines.push('MIJOZDA — JORIY QARZ (HALI TO‘LANMAGAN)');
    lines.push(...(openItems.length ? openItems.map((item) => lineText(item, 'open')) : ['Anjom topilmadi.']));
    lines.push('', `JORIY QARZ: ${formatMoney(currentDebt)}`);
  } else {
    if (returnedItems.length) {
      lines.push('OLDIN QAYTARILGANLAR — TO‘LANGAN');
      lines.push(...returnedItems.map((item) => lineText(item, 'returned')));
      lines.push('');
    }
    if (openItems.length) {
      lines.push('HALI MIJOZDA — JORIY QARZ');
      lines.push(...openItems.map((item) => lineText(item, 'open')));
      lines.push('', `JORIY QARZ: ${formatMoney(currentDebt)}`);
    } else {
      lines.push(`TO‘LANGAN JAMI: ${formatMoney(returnedTotal)}`);
    }
  }
  return lines.join('\n');
}

/** A concise customer-facing message; the detailed receipt text remains for PDF/share. */
export function receiptSmsText(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { type, returnedItems, addedItems, openItems, returnedTotal, currentDebt, finalTotal } = breakdown;
  if (type === 'edit') {
    const returned = returnedItems.length
      ? ` Qaytarildi: ${returnedItems.map((item) => `${item.quantity} dona ${item.name}`).join(', ')} (${formatMoney(returnedTotal)}).`
      : '';
    const added = addedItems.length
      ? ` Qo‘shimcha olindi: ${addedItems.map((item) => `${item.quantity} dona ${item.name}`).join(', ')}.`
      : '';
    return `Lesachi:${returned}${added} Sizda jami ${openDescription(openItems)} bor, joriy qarzingiz ${formatMoney(currentDebt)}.`.trim();
  }
  if (type === 'partial') {
    const accepted = returnedItems.length
      ? returnedItems.map((item) => `${item.quantity} dona ${item.name} qabul qilindi, ${formatMoney(item.amount)}`).join('; ')
      : 'Qaytarilgan anjom qabul qilindi';
    const stillWithCustomer = openItems.length
      ? ` Sizda yana ${openDescription(openItems)} bor, joriy qarzingiz ${formatMoney(currentDebt)}.`
      : '';
    const payment = returnedItems.length > 1 ? ` Jami qabul qilindi: ${formatMoney(returnedTotal)}.` : '.';
    return `Lesachi: ${accepted}${payment}${stillWithCustomer}${openItems.length ? ' Iltimos qolganini qaytaring.' : ' Barcha anjomlar qaytarildi.'}`;
  }
  if (type === 'final') {
    return `Lesachi: Barcha anjomlar qabul qilindi. Yakuniy to‘lov ${formatMoney(finalTotal)}. Rahmat!`;
  }
  if (type === 'new') {
    return `Lesachi: Sizga ${openDescription(openItems)} ijaraga berildi. Joriy qarzingiz ${formatMoney(currentDebt)}.`;
  }
  if (openItems.length) {
    return `Lesachi: Sizda ${openDescription(openItems)} bor, joriy qarzingiz ${formatMoney(currentDebt)}.`;
  }
  return `Lesachi: Sizning yakuniy to‘lovingiz ${formatMoney(finalTotal)}.`;
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
    const detail = isReturned
      ? `✓ TO‘LANDI · ${item.days} kun · ${formatDate(item.returnedAt, true)}`
      : `JORIY QARZ · ${item.days} kun · o‘sishda davom etadi`;
    return `<tr>
      <td><strong>${escapeHtml(item.name)}</strong><small class="${isReturned ? 'paid-note' : 'open-note'}">${escapeHtml(detail)}</small></td>
      <td>${escapeHtml(`${item.quantity} dona`)}</td>
      <td>${escapeHtml(formatMoney(item.dailyPrice))}</td>
      <td class="amount ${isReturned ? 'paid-amount' : 'open-amount'}">${escapeHtml(formatMoney(item.amount))}</td>
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

export function receiptHtml(rentalOrReceipt, receiptContext = {}) {
  const breakdown = receiptBreakdown(rentalOrReceipt, receiptContext);
  const { rental, type, returnedItems, addedItems, openItems, otherOpenItems, returnedTotal, currentDebt, finalTotal, remainingQuantity } = breakdown;
  const id = String(rental.id || 'CHEK').slice(-8).toUpperCase();
  let body = '';

  if (type === 'final') {
    body = `${sectionHtml('Qaytarilgan anjomlar — TO‘LANDI', returnedItems, 'returned')}
      ${summaryHtml('YAKUNIY TO‘LIQ SUMMA', finalTotal, 'paid')}`;
  } else if (type === 'edit') {
    body = `${returnedItems.length ? `${sectionHtml('Qaytarilgan anjomlar — TO‘LANDI', returnedItems, 'returned')}
      ${summaryHtml('QABUL QILINGAN TO‘LOV', returnedTotal, 'paid')}` : ''}
      ${addedItems.length ? sectionHtml('Qo‘shimcha olingan anjomlar — JORIY QARZ', addedItems, 'open') : ''}
      ${otherOpenItems.length ? `${sectionHtml('Hali mijozda — JORIY QARZ', otherOpenItems, 'open')}
      ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa o‘sishda davom etadi.')}` : ''}`;
  } else if (type === 'partial') {
    body = `${sectionHtml('Qaytarilgan qism — TO‘LANDI', returnedItems, 'returned')}
      ${summaryHtml('QABUL QILINGAN TO‘LOV', returnedTotal, 'paid')}
      ${openItems.length ? `${sectionHtml('Hali mijozda — JORIY QARZ', openItems, 'open')}
        ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa chekdagi to‘lovga qo‘shilmagan.')}
        <p class="note">Eslatma: Qolgan ${escapeHtml(remainingQuantity)} dona anjom qaytarilmaguncha, kunlik hisob davom etadi.</p>` : ''}`;
  } else if (type === 'new') {
    body = `${sectionHtml('Mijozda — JORIY QARZ (hali to‘lanmagan)', openItems, 'open')}
      ${summaryHtml('JORIY QARZ', currentDebt, 'current', 'Bu summa hali to‘lov sifatida qabul qilinmagan.')}`;
  } else {
    body = `${returnedItems.length ? `${sectionHtml('Oldin qaytarilganlar — TO‘LANGAN', returnedItems, 'returned')}
      ${summaryHtml('TO‘LANGAN JAMI', returnedTotal, 'paid')}` : ''}
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
        <section class="customer"><h1>${escapeHtml(rental.customerName)}</h1><p>${escapeHtml(rental.phone)}</p><p>Olingan sana: ${escapeHtml(formatDate(rental.startedAt, true))}</p></section>
        ${body}
        <footer>Chek ${escapeHtml(formatDate(new Date(), true))} da LESA ilovasi orqali yaratildi.</footer>
      </main>
    </body>
  </html>`;
}
