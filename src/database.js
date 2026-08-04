import { createId } from './utils';

const ITEM_STATUS = {
  OPEN: 'open',
  RETURNED: 'returned',
};

function dayCountInclusive(from, to = new Date()) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Ijara sanasi noto‘g‘ri. Qaytarishni saqlab bo‘lmadi.');
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function toRentalItem(row) {
  const status = row.status === ITEM_STATUS.RETURNED ? ITEM_STATUS.RETURNED : ITEM_STATUS.OPEN;
  const item = {
    id: row.id,
    rentalId: row.rentalId,
    equipmentTypeId: row.equipmentTypeId || null,
    name: row.name,
    quantity: Number(row.quantity),
    dailyPrice: Number(row.dailyPrice),
    startedAt: row.startedAt,
    status,
    returnedAt: row.returnedAt || null,
    frozenAmount: numberOrNull(row.frozenAmount),
  };

  // Kept for callers from the first app version. New UI should use status,
  // returnedAt and frozenAmount directly; a frozen row represents one return.
  item.returns = status === ITEM_STATUS.RETURNED
    ? [{
      id: `return_${item.id}`,
      rentalItemId: item.id,
      quantity: item.quantity,
      returnedAt: item.returnedAt,
      frozenAmount: item.frozenAmount,
    }]
    : [];
  return item;
}

function normaliseReturnRequests(returnsOrItemId, legacyQuantity) {
  const source = Array.isArray(returnsOrItemId)
    ? returnsOrItemId
    : returnsOrItemId && typeof returnsOrItemId === 'object'
      ? [returnsOrItemId]
      : [{ itemId: returnsOrItemId, quantity: legacyQuantity }];

  if (!source.length) {
    throw new Error('Qaytariladigan anjom tanlanmagan.');
  }

  const byItemId = new Map();
  for (const entry of source) {
    const itemId = String(entry?.itemId || '').trim();
    if (!itemId) {
      throw new Error('Qaytariladigan anjom topilmadi.');
    }
    const rawQuantity = entry?.quantity;
    if (rawQuantity === null || rawQuantity === undefined || String(rawQuantity).trim() === '') {
      throw new Error('Qaytarilgan sonini kiriting.');
    }
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error('Qaytarilgan soni butun, manfiy bo‘lmagan son bo‘lishi kerak.');
    }
    if (quantity === 0) continue;
    const combined = (byItemId.get(itemId) || 0) + quantity;
    if (!Number.isSafeInteger(combined)) {
      throw new Error('Qaytarilgan soni juda katta.');
    }
    byItemId.set(itemId, combined);
  }

  const requests = Array.from(byItemId, ([itemId, quantity]) => ({ itemId, quantity }));
  if (!requests.length) {
    throw new Error('Kamida bitta anjom uchun qaytarilgan sonini kiriting.');
  }
  return requests;
}

function isWebExclusiveTransactionError(error) {
  return String(error?.message || error).includes('withExclusiveTransactionAsync is not supported on web');
}

async function withWriteTransaction(db, task) {
  // Native platforms get an exclusive connection. The web SQLite implementation
  // intentionally does not support it, so use its regular transaction there.
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    try {
      return await db.withExclusiveTransactionAsync(task);
    } catch (error) {
      if (!isWebExclusiveTransactionError(error)) throw error;
    }
  }
  if (typeof db.withTransactionAsync === 'function') {
    return db.withTransactionAsync(() => task(db));
  }

  // This is only for small test doubles; Expo SQLite exposes one of the APIs above.
  await db.execAsync('BEGIN IMMEDIATE');
  try {
    const result = await task(db);
    await db.execAsync('COMMIT');
    return result;
  } catch (error) {
    await db.execAsync('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function ensureRentalItemColumns(db) {
  const columns = await db.getAllAsync('PRAGMA table_info(rental_items)');
  const names = new Set(columns.map((column) => column.name));
  const missing = [
    ['started_at', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'open'"],
    ['returned_at', 'TEXT'],
    ['frozen_amount', 'INTEGER'],
  ];
  for (const [name, definition] of missing) {
    if (!names.has(name)) {
      await db.execAsync(`ALTER TABLE rental_items ADD COLUMN ${name} ${definition}`);
    }
  }
}

async function ensureEquipmentTypeColumns(db) {
  const columns = await db.getAllAsync('PRAGMA table_info(equipment_types)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('total_quantity')) {
    await db.execAsync("ALTER TABLE equipment_types ADD COLUMN total_quantity INTEGER NOT NULL DEFAULT 0");
  }
}

async function materialiseLegacyReturns(db) {
  const migrationTime = new Date().toISOString();
  await withWriteTransaction(db, async (tx) => {
    // Old databases stored the start date on rentals and every return in
    // item_returns. First make every old item usable by the split-row model.
    await tx.runAsync(`
      UPDATE rental_items
      SET started_at = COALESCE(
        started_at,
        (SELECT started_at FROM rentals WHERE rentals.id = rental_items.rental_id),
        ?
      )
    `, [migrationTime]);
    await tx.execAsync(`
      UPDATE rental_items
      SET status = CASE WHEN status = 'returned' THEN 'returned' ELSE 'open' END
    `);

    const legacyReturns = await tx.getAllAsync(`
      SELECT
        ir.id AS legacyReturnId,
        ir.rental_item_id AS sourceItemId,
        ir.quantity AS returnQuantity,
        ir.returned_at AS returnedAt,
        ri.rental_id AS rentalId,
        ri.equipment_type_id AS equipmentTypeId,
        ri.name,
        ri.quantity AS sourceQuantity,
        ri.daily_price AS dailyPrice,
        COALESCE(ri.started_at, r.started_at) AS startedAt
      FROM item_returns ir
      JOIN rental_items ri ON ri.id = ir.rental_item_id
      JOIN rentals r ON r.id = ri.rental_id
      LEFT JOIN rental_item_legacy_return_migrations migration
        ON migration.legacy_return_id = ir.id
      WHERE migration.legacy_return_id IS NULL
      ORDER BY ir.rental_item_id, ir.returned_at, ir.rowid
    `);

    const remainingBySource = new Map();
    for (const legacyReturn of legacyReturns) {
      const sourceId = legacyReturn.sourceItemId;
      const available = remainingBySource.has(sourceId)
        ? remainingBySource.get(sourceId)
        : Math.max(0, Number(legacyReturn.sourceQuantity) || 0);
      const requestedQuantity = Number(legacyReturn.returnQuantity);
      const quantity = Number.isSafeInteger(requestedQuantity) && requestedQuantity > 0
        ? Math.min(requestedQuantity, available)
        : 0;

      let returnedItemId = null;
      if (quantity > 0) {
        returnedItemId = createId('item');
        const startedAt = legacyReturn.startedAt || migrationTime;
        const returnedAt = legacyReturn.returnedAt || migrationTime;
        const frozenAmount = Math.round(
          dayCountInclusive(startedAt, returnedAt) * Number(legacyReturn.dailyPrice) * quantity,
        );
        await tx.runAsync(`
          INSERT INTO rental_items (
            id, rental_id, equipment_type_id, name, quantity, daily_price,
            started_at, status, returned_at, frozen_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          returnedItemId,
          legacyReturn.rentalId,
          legacyReturn.equipmentTypeId,
          legacyReturn.name,
          quantity,
          legacyReturn.dailyPrice,
          startedAt,
          ITEM_STATUS.RETURNED,
          returnedAt,
          frozenAmount,
        ]);
      }

      await tx.runAsync(`
        INSERT INTO rental_item_legacy_return_migrations (
          legacy_return_id, returned_item_id, migrated_at
        ) VALUES (?, ?, ?)
      `, [legacyReturn.legacyReturnId, returnedItemId, migrationTime]);
      remainingBySource.set(sourceId, Math.max(0, available - quantity));
    }

    for (const [sourceItemId, remainingQuantity] of remainingBySource) {
      // The original source becomes the current open portion. A zero-quantity
      // row is deliberately retained for FK/history safety but omitted by fetches.
      await tx.runAsync(`
        UPDATE rental_items
        SET quantity = ?, status = ?, returned_at = NULL, frozen_amount = NULL
        WHERE id = ?
      `, [remainingQuantity, ITEM_STATUS.OPEN, sourceItemId]);
    }

    // A legacy rental which already had all its items returned should remain
    // visibly closed after the schema upgrade.
    await tx.runAsync(`
      UPDATE rentals
      SET status = 'closed', closed_at = COALESCE(closed_at, ?)
      WHERE status <> 'closed'
        AND EXISTS (SELECT 1 FROM rental_items ri WHERE ri.rental_id = rentals.id)
        AND NOT EXISTS (
          SELECT 1 FROM rental_items ri
          WHERE ri.rental_id = rentals.id
            AND ri.status = 'open'
            AND ri.quantity > 0
        )
    `, [migrationTime]);
  });
}

async function fetchOpenItemsForRental(db, rentalId) {
  const rows = await db.getAllAsync(`
    SELECT
      ri.id,
      ri.rental_id AS rentalId,
      ri.equipment_type_id AS equipmentTypeId,
      ri.name,
      ri.quantity,
      ri.daily_price AS dailyPrice,
      COALESCE(ri.started_at, r.started_at) AS startedAt,
      ri.status,
      ri.returned_at AS returnedAt,
      ri.frozen_amount AS frozenAmount
    FROM rental_items ri
    JOIN rentals r ON r.id = ri.rental_id
    WHERE ri.rental_id = ?
      AND ri.status = ?
      AND ri.quantity > 0
    ORDER BY ri.rowid
  `, [rentalId, ITEM_STATUS.OPEN]);
  return rows.map(toRentalItem);
}

export async function migrateDatabase(db) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_types (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      daily_price INTEGER NOT NULL DEFAULT 0,
      total_quantity INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rentals (
      id TEXT PRIMARY KEY NOT NULL,
      customer_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      closed_at TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS rental_items (
      id TEXT PRIMARY KEY NOT NULL,
      rental_id TEXT NOT NULL,
      equipment_type_id TEXT,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      daily_price INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      returned_at TEXT,
      frozen_amount INTEGER,
      FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE,
      FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id)
    );

    CREATE TABLE IF NOT EXISTS item_returns (
      id TEXT PRIMARY KEY NOT NULL,
      rental_item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      returned_at TEXT NOT NULL,
      FOREIGN KEY (rental_item_id) REFERENCES rental_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rental_item_legacy_return_migrations (
      legacy_return_id TEXT PRIMARY KEY NOT NULL,
      returned_item_id TEXT,
      migrated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sent_messages (
      id TEXT PRIMARY KEY NOT NULL,
      rental_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  await ensureRentalItemColumns(db);
  await ensureEquipmentTypeColumns(db);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_rental_items_rental_status
      ON rental_items (rental_id, status);
    CREATE INDEX IF NOT EXISTS idx_item_returns_rental_item
      ON item_returns (rental_item_id);
  `);
  await materialiseLegacyReturns(db);

  const equipmentCount = await db.getFirstAsync('SELECT COUNT(*) AS count FROM equipment_types');
  if (!equipmentCount?.count) {
    await db.runAsync('INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)', [createId('eq'), 'Lesa komplekti', 25000, 0]);
    await db.runAsync('INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)', [createId('eq'), 'Taxta', 5000, 0]);
    await db.runAsync('INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)', [createId('eq'), 'Opalubka', 30000, 0]);
    await db.runAsync('INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)', [createId('eq'), 'Teleskopik tirgak', 8000, 0]);
  }
  await db.runAsync("INSERT OR IGNORE INTO settings (key, value) VALUES ('message_channel', 'Telegram')");
}

export async function fetchEquipmentTypes(db) {
  const rows = await db.getAllAsync(`
    SELECT
      et.id,
      et.name,
      et.daily_price AS dailyPrice,
      et.total_quantity AS totalQuantity,
      COALESCE(SUM(CASE
        WHEN ri.status = 'open' AND ri.quantity > 0 AND r.status <> 'closed' THEN ri.quantity
        ELSE 0
      END), 0) AS rentedQuantity
    FROM equipment_types et
    LEFT JOIN rental_items ri ON ri.equipment_type_id = et.id
    LEFT JOIN rentals r ON r.id = ri.rental_id
    GROUP BY et.id, et.name, et.daily_price, et.total_quantity
    ORDER BY et.name
  `);
  return rows.map((row) => {
    const totalQuantity = Math.max(0, Number(row.totalQuantity) || 0);
    const rentedQuantity = Math.max(0, Number(row.rentedQuantity) || 0);
    return {
      ...row,
      dailyPrice: Number(row.dailyPrice) || 0,
      totalQuantity,
      rentedQuantity,
      availableQuantity: Math.max(0, totalQuantity - rentedQuantity),
    };
  });
}

function normaliseEquipmentPayload(payload) {
  const name = String(payload?.name || '').trim();
  const rawDailyPrice = payload?.dailyPrice;
  const rawTotalQuantity = payload?.totalQuantity;
  const dailyPrice = Number(payload?.dailyPrice);
  const totalQuantity = Number(payload?.totalQuantity);
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

export async function createEquipmentType(db, payload) {
  const item = normaliseEquipmentPayload(payload);
  const id = createId('eq');
  await db.runAsync(
    'INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)',
    [id, item.name, item.dailyPrice, item.totalQuantity],
  );
  return id;
}

export async function updateEquipmentType(db, equipmentId, payload) {
  const item = normaliseEquipmentPayload(payload);
  return withWriteTransaction(db, async (tx) => {
    const existing = await tx.getFirstAsync('SELECT id FROM equipment_types WHERE id = ?', [equipmentId]);
    if (!existing) throw new Error('Anjom topilmadi.');
    const usage = await tx.getFirstAsync(`
      SELECT COALESCE(SUM(ri.quantity), 0) AS rentedQuantity
      FROM rental_items ri
      JOIN rentals r ON r.id = ri.rental_id
      WHERE ri.equipment_type_id = ?
        AND ri.status = 'open'
        AND ri.quantity > 0
        AND r.status <> 'closed'
    `, [equipmentId]);
    const rentedQuantity = Number(usage?.rentedQuantity) || 0;
    if (item.totalQuantity < rentedQuantity) {
      throw new Error(`Umumiy miqdor band bo‘lgan ${rentedQuantity} donadan kam bo‘lishi mumkin emas.`);
    }
    await tx.runAsync(
      'UPDATE equipment_types SET name = ?, daily_price = ?, total_quantity = ? WHERE id = ?',
      [item.name, item.dailyPrice, item.totalQuantity, equipmentId],
    );
    // Open rows follow a renamed equipment type; returned history keeps its original label.
    await tx.runAsync(
      "UPDATE rental_items SET name = ? WHERE equipment_type_id = ? AND status = 'open'",
      [item.name, equipmentId],
    );
    return equipmentId;
  });
}

export async function deleteEquipmentType(db, equipmentId) {
  return withWriteTransaction(db, async (tx) => {
    const existing = await tx.getFirstAsync('SELECT id, name FROM equipment_types WHERE id = ?', [equipmentId]);
    if (!existing) throw new Error('Anjom topilmadi.');
    const usage = await tx.getFirstAsync(`
      SELECT COALESCE(SUM(ri.quantity), 0) AS rentedQuantity
      FROM rental_items ri
      JOIN rentals r ON r.id = ri.rental_id
      WHERE ri.equipment_type_id = ?
        AND ri.status = 'open'
        AND ri.quantity > 0
        AND r.status <> 'closed'
    `, [equipmentId]);
    if ((Number(usage?.rentedQuantity) || 0) > 0) {
      throw new Error('Bu anjom faol ijarada band. Avval barcha qismlar qaytarilsin.');
    }
    // Detach historical rows first so deleting a type never destroys receipt history.
    await tx.runAsync('UPDATE rental_items SET equipment_type_id = NULL WHERE equipment_type_id = ?', [equipmentId]);
    await tx.runAsync('DELETE FROM equipment_types WHERE id = ?', [equipmentId]);
    return equipmentId;
  });
}

export async function fetchRentals(db) {
  const rentals = await db.getAllAsync(`
    SELECT r.id, r.started_at AS startedAt, r.status, r.closed_at AS closedAt,
           c.full_name AS customerName, c.phone
    FROM rentals r
    JOIN customers c ON c.id = r.customer_id
    ORDER BY r.started_at DESC
  `);
  const itemRows = await db.getAllAsync(`
    SELECT
      ri.id,
      ri.rental_id AS rentalId,
      ri.equipment_type_id AS equipmentTypeId,
      ri.name,
      ri.quantity,
      ri.daily_price AS dailyPrice,
      COALESCE(ri.started_at, r.started_at) AS startedAt,
      ri.status,
      ri.returned_at AS returnedAt,
      ri.frozen_amount AS frozenAmount
    FROM rental_items ri
    JOIN rentals r ON r.id = ri.rental_id
    WHERE ri.quantity > 0
    ORDER BY
      ri.rental_id,
      CASE WHEN ri.status = 'open' THEN 0 ELSE 1 END,
      ri.returned_at DESC,
      ri.rowid
  `);
  const itemsByRental = itemRows.reduce((map, row) => {
    const item = toRentalItem(row);
    if (!map[item.rentalId]) map[item.rentalId] = [];
    map[item.rentalId].push(item);
    return map;
  }, {});
  return rentals.map((rental) => ({ ...rental, items: itemsByRental[rental.id] || [] }));
}

export async function createRental(db, payload) {
  const now = new Date().toISOString();
  let customer = await db.getFirstAsync('SELECT id FROM customers WHERE phone = ?', [payload.phone]);
  let customerId = customer?.id;
  if (customerId) {
    await db.runAsync('UPDATE customers SET full_name = ? WHERE id = ?', [payload.customerName, customerId]);
  } else {
    customerId = createId('customer');
    await db.runAsync(
      'INSERT INTO customers (id, full_name, phone, created_at) VALUES (?, ?, ?, ?)',
      [customerId, payload.customerName, payload.phone, now],
    );
  }

  const rentalId = createId('rental');
  await db.runAsync(
    "INSERT INTO rentals (id, customer_id, started_at, status) VALUES (?, ?, ?, 'active')",
    [rentalId, customerId, now],
  );
  for (const item of payload.items) {
    const knownType = await db.getFirstAsync('SELECT id FROM equipment_types WHERE name = ?', [item.name]);
    let equipmentTypeId = knownType?.id;
    if (!equipmentTypeId) {
      equipmentTypeId = createId('eq');
      await db.runAsync('INSERT INTO equipment_types (id, name, daily_price, total_quantity) VALUES (?, ?, ?, ?)', [equipmentTypeId, item.name, item.dailyPrice, 0]);
    } else {
      await db.runAsync('UPDATE equipment_types SET daily_price = ? WHERE id = ?', [item.dailyPrice, equipmentTypeId]);
    }
    await db.runAsync(`
      INSERT INTO rental_items (
        id, rental_id, equipment_type_id, name, quantity, daily_price,
        started_at, status, returned_at, frozen_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `, [
      createId('item'),
      rentalId,
      equipmentTypeId,
      item.name,
      item.quantity,
      item.dailyPrice,
      now,
      ITEM_STATUS.OPEN,
    ]);
  }
  return rentalId;
}

/**
 * Splits every selected open item in a single transaction.
 *
 * `returnsOrItemId` accepts the new [{ itemId, quantity }] form. The former
 * (itemId, quantity) form is retained for callers that have not upgraded yet.
 */
export async function registerReturn(db, rentalId, returnsOrItemId, legacyQuantity) {
  const requests = normaliseReturnRequests(returnsOrItemId, legacyQuantity);
  const returnedAt = new Date().toISOString();
  const returnedRows = [];
  let remainingRows = [];
  let wasClosed = false;

  await withWriteTransaction(db, async (tx) => {
    const rental = await tx.getFirstAsync(
      'SELECT id, started_at AS startedAt FROM rentals WHERE id = ?',
      [rentalId],
    );
    if (!rental) {
      throw new Error('Ijara topilmadi.');
    }

    // Validate all requests before changing any row. This keeps a multi-row
    // modal submission all-or-nothing even when one quantity is invalid.
    const sourceItems = [];
    for (const request of requests) {
      const source = await tx.getFirstAsync(`
        SELECT
          ri.id,
          ri.rental_id AS rentalId,
          ri.equipment_type_id AS equipmentTypeId,
          ri.name,
          ri.quantity,
          ri.daily_price AS dailyPrice,
          COALESCE(ri.started_at, r.started_at) AS startedAt,
          ri.status,
          ri.returned_at AS returnedAt,
          ri.frozen_amount AS frozenAmount
        FROM rental_items ri
        JOIN rentals r ON r.id = ri.rental_id
        WHERE ri.id = ? AND ri.rental_id = ?
      `, [request.itemId, rentalId]);
      if (!source || source.status !== ITEM_STATUS.OPEN || Number(source.quantity) <= 0) {
        throw new Error('Anjom allaqachon qaytarilgan yoki topilmadi.');
      }
      if (request.quantity > Number(source.quantity)) {
        throw new Error(`${source.name}: mijozdagi ${source.quantity} donadan ko‘p qaytarib bo‘lmaydi.`);
      }
      sourceItems.push({ source, quantity: request.quantity });
    }

    for (const { source, quantity } of sourceItems) {
      const startedAt = source.startedAt || rental.startedAt || returnedAt;
      const days = dayCountInclusive(startedAt, returnedAt);
      const frozenAmount = Math.round(days * Number(source.dailyPrice) * quantity);
      const remainingQuantity = Number(source.quantity) - quantity;

      // Row A: retain the original item id as the immutable, paid portion.
      await tx.runAsync(`
        UPDATE rental_items
        SET quantity = ?, status = ?, returned_at = ?, frozen_amount = ?
        WHERE id = ? AND rental_id = ?
      `, [
        quantity,
        ITEM_STATUS.RETURNED,
        returnedAt,
        frozenAmount,
        source.id,
        rentalId,
      ]);
      returnedRows.push(toRentalItem({
        ...source,
        quantity,
        startedAt,
        status: ITEM_STATUS.RETURNED,
        returnedAt,
        frozenAmount,
      }));

      // Row B: a new open portion keeps the ORIGINAL item start date, so its
      // running amount never restarts from the partial-return date.
      if (remainingQuantity > 0) {
        const remainingId = createId('item');
        await tx.runAsync(`
          INSERT INTO rental_items (
            id, rental_id, equipment_type_id, name, quantity, daily_price,
            started_at, status, returned_at, frozen_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `, [
          remainingId,
          rentalId,
          source.equipmentTypeId,
          source.name,
          remainingQuantity,
          source.dailyPrice,
          startedAt,
          ITEM_STATUS.OPEN,
        ]);
      }
    }

    remainingRows = await fetchOpenItemsForRental(tx, rentalId);
    wasClosed = remainingRows.length === 0;
    if (wasClosed) {
      await tx.runAsync(
        "UPDATE rentals SET status = 'closed', closed_at = ? WHERE id = ?",
        [returnedAt, rentalId],
      );
    } else {
      await tx.runAsync(
        "UPDATE rentals SET status = 'active', closed_at = NULL WHERE id = ?",
        [rentalId],
      );
    }
  });

  return {
    rentalId,
    returnedAt,
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

export async function getSetting(db, key) {
  const row = await db.getFirstAsync('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value;
}

export async function setSetting(db, key, value) {
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

export async function logSentMessage(db, rentalId, channel, message, status = 'sent') {
  await db.runAsync(
    'INSERT INTO sent_messages (id, rental_id, channel, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [createId('message'), rentalId, channel, message, status, new Date().toISOString()],
  );
}
