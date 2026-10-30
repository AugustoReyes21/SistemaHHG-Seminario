const express = require('express');
const ExcelJS = require('exceljs');
const { query, withTransaction, tableExists, columnExists, getColumns, pickTable } = require('../db');
const { safeJson, readJson, canonRole } = require('../helpers');
const { requireRole, getUserRole } = require('../auth');
const {
  productStocksAvailable,
  ensureBranchStockRow,
  adjustBranchStock,
  getBranchStock,
  logAction
} = require('../functions');
const { normalizeBarcode } = require('../utils/normalize');
const { deriveStockInfo } = require('../utils/stock');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { logAuditEvent } = require('../utils/audit');
const { resolvePresentationConfig } = require('../utils/productPresentation');
const {
  normalizeProductType,
  productTypeUsesInventory,
  productTypeIsCombo,
  ensureProductTypeColumn,
  ensureComboItemsTable,
  normalizeComboComponents,
  fetchComboComponents,
  replaceComboComponents,
  computeComboAvailability
} = require('../utils/productCatalog');
const { validateBody, validateQuery, schemas: validationSchemas } = require('../middleware/validate');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const LOT_EXPIRY_ALERT_DAYS = 60;

function roundMoney(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
}

function normalizeBranchName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isEmergencyHospitalTransferRole(role) {
  const normalized = canonRole(role || '');
  return normalized === 'cashiee' || normalized === 'cashierh' || normalized === 'enfermeria';
}

async function resolveEmergencyHospitalBranches(db) {
  const rows = await query('SELECT id, name FROM branches ORDER BY id ASC', [], db);
  let emergency = null;
  let hospital = null;
  for (const row of rows.rows || []) {
    const label = normalizeBranchName(row.name);
    if (!emergency && label.includes('emergencia')) {
      emergency = { id: Number(row.id), name: row.name || 'Emergencia' };
    }
    if (!hospital && (label.includes('hospitalizacion') || label.includes('hospital'))) {
      hospital = { id: Number(row.id), name: row.name || 'Hospitalización' };
    }
  }
  return { emergency, hospital };
}

async function ensureProductBarcodeColumn(db) {
  if (!(await tableExists(db, 'productos'))) return false;
  if (!(await columnExists(db, 'productos', 'codigo_barra'))) {
    try {
      await query('ALTER TABLE productos ADD COLUMN codigo_barra VARCHAR(100)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'productos', 'codigo_barra');
}

async function ensureProductActiveColumn(db) {
  if (!(await tableExists(db, 'productos'))) return false;
  if (!(await columnExists(db, 'productos', 'activo'))) {
    try {
      await query('ALTER TABLE productos ADD COLUMN activo BOOLEAN DEFAULT TRUE', [], db);
      await query('UPDATE productos SET activo = TRUE WHERE activo IS NULL', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'productos', 'activo');
}

async function ensureProductPresentationColumns(db) {
  if (!(await tableExists(db, 'productos'))) return false;
  try {
    await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidades_por_tableta INTEGER DEFAULT 1', [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS tabletas_por_caja INTEGER DEFAULT 1', [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_unidad NUMERIC(12,2)', [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_tableta NUMERIC(12,2)', [], db);
  } catch (_) {}
  try {
    await query(
      'UPDATE productos SET unidades_por_tableta = 1 WHERE unidades_por_tableta IS NULL OR unidades_por_tableta <= 0',
      [],
      db
    );
  } catch (_) {}
  try {
    await query(
      'UPDATE productos SET tabletas_por_caja = 1 WHERE tabletas_por_caja IS NULL OR tabletas_por_caja <= 0',
      [],
      db
    );
  } catch (_) {}
  return true;
}

function normalizeProductInputType(data) {
  return normalizeProductType(data?.tipo);
}

async function getTotalTrackedProductStock(db, productId) {
  const pid = Number(productId || 0);
  if (!pid) return 0;
  let total = 0;
  if (await tableExists(db, 'lots')) {
    const st = await query('SELECT COALESCE(SUM(quantity),0) AS qty FROM lots WHERE product_id = $1 AND quantity > 0', [pid], db);
    total = Math.max(total, Number(st.rows[0]?.qty || 0));
  }
  if (await productStocksAvailable(db)) {
    const st = await query('SELECT COALESCE(SUM(stock),0) AS qty FROM product_stocks WHERE product_id = $1', [pid], db);
    total = Math.max(total, Number(st.rows[0]?.qty || 0));
  }
  const st = await query('SELECT stock FROM productos WHERE id = $1', [pid], db);
  total = Math.max(total, Number(st.rows[0]?.stock || 0));
  return total;
}

async function validateComboComponents(db, comboProductId, components) {
  const normalized = normalizeComboComponents(components);
  if (!normalized.length) {
    throw new Error('El combo debe incluir al menos un medicamento o servicio');
  }
  await ensureProductTypeColumn(db);
  const componentIds = normalized.map((component) => component.component_product_id);
  const st = await query(
    "SELECT id, nombre_comercial, COALESCE(tipo, 'medicamento') AS tipo FROM productos WHERE id = ANY($1)",
    [componentIds],
    db
  );
  const found = new Map((st.rows || []).map((row) => [Number(row.id || 0), row]));
  let hasMedicationComponent = false;
  for (const component of normalized) {
    if (comboProductId && Number(component.component_product_id) === Number(comboProductId)) {
      throw new Error('Un combo no puede incluirse a sí mismo');
    }
    const row = found.get(Number(component.component_product_id));
    if (!row) {
      throw new Error(`No existe el componente ${component.component_product_id}`);
    }
    const componentType = normalizeProductType(row.tipo);
    if (productTypeIsCombo(componentType)) {
      throw new Error(`El componente "${row.nombre_comercial || component.component_product_id}" no puede ser otro combo`);
    }
    if (productTypeUsesInventory(componentType)) {
      hasMedicationComponent = true;
    }
  }
  if (!hasMedicationComponent) {
    throw new Error('El combo debe incluir al menos un medicamento para controlar el stock');
  }
  return normalized;
}

async function ensureTypeChangeAllowed(db, productId, nextType) {
  const pid = Number(productId || 0);
  if (!pid) return;
  await ensureProductTypeColumn(db);
  const st = await query("SELECT id, COALESCE(tipo, 'medicamento') AS tipo FROM productos WHERE id = $1 LIMIT 1", [pid], db);
  const row = st.rows[0];
  if (!row) return;
  const currentType = normalizeProductType(row.tipo);
  const normalizedNext = normalizeProductType(nextType);
  if (currentType === normalizedNext) return;
  if (!productTypeUsesInventory(currentType) || productTypeUsesInventory(normalizedNext)) return;
  const stock = await getTotalTrackedProductStock(db, pid);
  if (stock > 0) {
    throw new Error('No se puede cambiar este producto a servicio o combo mientras tenga stock o lotes activos');
  }
}

async function ensureTransferRequesterColumn(db) {
  if (!(await tableExists(db, 'transfers'))) return false;
  if (!(await columnExists(db, 'transfers', 'requester_name'))) {
    try {
      await query('ALTER TABLE transfers ADD COLUMN requester_name VARCHAR(150)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'transfers', 'requester_name');
}

async function ensureTransferCancellationColumns(db) {
  if (!(await tableExists(db, 'transfers'))) return false;
  try {
    await query("ALTER TABLE transfers ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'", [], db);
  } catch (_) {}
  try {
    await query("UPDATE transfers SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''", [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE transfers ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP NULL', [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE transfers ADD COLUMN IF NOT EXISTS cancelled_by INTEGER NULL', [], db);
  } catch (_) {}
  try {
    await query('ALTER TABLE transfers ADD COLUMN IF NOT EXISTS cancel_note TEXT NULL', [], db);
  } catch (_) {}
  return true;
}

async function ensureTransferLotItemsTable(db) {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS transfer_lot_items (
        id SERIAL PRIMARY KEY,
        transfer_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        source_lot_id INTEGER NULL,
        target_lot_id INTEGER NULL,
        lot_number VARCHAR(150) NULL,
        expiry_date DATE NULL,
        purchase_id INTEGER NULL,
        sale_price NUMERIC(12,2) NULL,
        lot_created_at TIMESTAMP NULL,
        quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
      [],
      db
    );
  } catch (_) {}
  return await tableExists(db, 'transfer_lot_items');
}

async function ensureLotSalePriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'sale_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN sale_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'sale_price');
}

async function ensureInventoryWriteoffsTable(db) {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS inventory_writeoffs (
        id SERIAL PRIMARY KEY,
        lot_id INTEGER NULL,
        product_id INTEGER NOT NULL,
        branch_id INTEGER NULL,
        lot_number VARCHAR(150) NULL,
        expiry_date DATE NULL,
        quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
        unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
        reason VARCHAR(50) NOT NULL DEFAULT 'expired',
        notes TEXT NULL,
        product_label VARCHAR(255) NULL,
        created_by INTEGER NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
      [],
      db
    );
  } catch (_) {}
  try {
    await query(
      'CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_created_at ON inventory_writeoffs (created_at DESC)',
      [],
      db
    );
  } catch (_) {}
  try {
    await query(
      'CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_product_id ON inventory_writeoffs (product_id)',
      [],
      db
    );
  } catch (_) {}
  return await tableExists(db, 'inventory_writeoffs');
}

async function syncLotSalePrice(db, productId, branchId, lotInfo, salePrice) {
  const price = Number(salePrice || 0);
  if (!productId || !Number.isFinite(price) || price < 0) return;
  if (!(await ensureLotSalePriceColumn(db))) return;

  if (branchId && lotInfo && lotInfo.lotNumber) {
    const st = await query(
      'UPDATE lots SET sale_price = $1 WHERE product_id = $2 AND branch_id = $3 AND LOWER(lot_number) = LOWER($4)',
      [price, productId, branchId, lotInfo.lotNumber],
      db
    );
    if (Number(st.rowCount || 0) > 0) return;
  }

  if (branchId) {
    await query('UPDATE lots SET sale_price = $1 WHERE product_id = $2 AND branch_id = $3', [price, productId, branchId], db);
    return;
  }

  await query('UPDATE lots SET sale_price = $1 WHERE product_id = $2', [price, productId], db);
}

async function ensureBranchByName(db, name) {
  if (!name) return null;
  if (!(await tableExists(db, 'branches'))) return null;
  const st = await query('SELECT id FROM branches WHERE LOWER(name) = LOWER($1) LIMIT 1', [name], db);
  if (st.rows[0]) return Number(st.rows[0].id);
  try {
    const ins = await query('INSERT INTO branches (name) VALUES ($1) RETURNING id', [name], db);
    return Number(ins.rows[0].id);
  } catch (_) {
    const st2 = await query('SELECT id FROM branches WHERE LOWER(name) = LOWER($1) LIMIT 1', [name], db);
    return st2.rows[0] ? Number(st2.rows[0].id) : null;
  }
}

function startOfDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getLang(req) {
  const raw = String(req.query.lang || req.headers['x-lang'] || 'es').toLowerCase();
  return raw.startsWith('en') ? 'en' : 'es';
}

function formatDateLocale(value, lang) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const locale = lang === 'en' ? 'en-US' : 'es-GT';
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function tTransfer(lang, key) {
  const map = {
    es: {
      receipt: 'Comprobante de traslado',
      transfer: 'Traslado',
      source: 'Origen',
      target: 'Destino',
      requester: 'Solicitante',
      product: 'Producto',
      qty: 'Cant.',
      cost: 'Costo',
      subtotal: 'Subtotal',
      total_units: 'Total unidades',
      print: 'Imprimir',
      status: 'Estado',
      active: 'Activo',
      cancelled: 'Anulado',
      cancelled_at: 'Anulado el',
      cancelled_by: 'Anulado por',
      cancel_note: 'Motivo de anulación'
    },
    en: {
      receipt: 'Transfer Receipt',
      transfer: 'Transfer',
      source: 'Source',
      target: 'Destination',
      requester: 'Requester',
      product: 'Product',
      qty: 'Qty',
      cost: 'Cost',
      subtotal: 'Subtotal',
      total_units: 'Total units',
      print: 'Print',
      status: 'Status',
      active: 'Active',
      cancelled: 'Cancelled',
      cancelled_at: 'Cancelled at',
      cancelled_by: 'Cancelled by',
      cancel_note: 'Cancellation reason'
    }
  };
  const langMap = map[lang] || map.es;
  return langMap[key] || map.es[key] || key;
}

function normalizeTransferStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'active';
  if (['cancelled', 'canceled', 'anulado', 'annulled'].includes(raw)) return 'cancelled';
  return 'active';
}

function formatTransferStatus(lang, status) {
  return tTransfer(lang, normalizeTransferStatus(status));
}

function parseExpiryInput(value) {
  if (!value) return null;
  if (value instanceof Date) return startOfDay(value);
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
    if (year < 100) year = 2000 + year;
    const dt = new Date(year, month - 1, day);
    if (Number.isNaN(dt.getTime())) return null;
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return startOfDay(dt);
  }
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    let year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (year >= 0 && year < 1000) year = 2000 + year;
    const dt = new Date(year, month - 1, day);
    if (Number.isNaN(dt.getTime())) return null;
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return startOfDay(dt);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return startOfDay(parsed);
}

function validateExpiryNotPast(expiry) {
  if (!expiry) return null;
  const now = new Date();
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth() + 1;
  const year = expiry.getFullYear();
  const month = expiry.getMonth() + 1;
  if (year < yearNow) return 'Fecha inválida: el año no puede ser menor al actual.';
  if (year === yearNow && month < monthNow) return 'Mes inválido: no puede ser anterior al mes actual.';
  return null;
}

function parseLotInfo(payload) {
  const lotRaw =
    payload.lot_number ||
    payload.lote ||
    payload.lot ||
    payload.numero_lote ||
    payload.lote_numero ||
    '';
  const lotNumber = String(lotRaw || '').trim();
  const expiry = parseExpiryInput(payload.expiry_date || payload.expira || payload.fecha_vencimiento || null);
  const expiryError = validateExpiryNotPast(expiry);
  return { lotNumber: lotNumber || null, expiry, expiryError };
}

function normalizeDateOnly(value) {
  const dt = startOfDay(value);
  return dt ? dt.toISOString().slice(0, 10) : null;
}

function sameNullableDate(left, right) {
  return normalizeDateOnly(left) === normalizeDateOnly(right);
}

function sameNullableText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function sameNullableNumber(left, right) {
  const l = left == null || left === '' ? null : Number(left);
  const r = right == null || right === '' ? null : Number(right);
  if (l == null || Number.isNaN(l)) return r == null || Number.isNaN(r);
  if (r == null || Number.isNaN(r)) return false;
  return Math.abs(l - r) <= 0.0001;
}

async function upsertLotQuantity(db, lotMeta, branchId, productId, lotData, quantity) {
  const qty = Number(quantity || 0);
  if (!qty || qty <= 0) return;
  const candidateRes = await query(
    `SELECT id, lot_number, expiry_date, purchase_id, sale_price
       FROM lots
      WHERE product_id = $1 AND branch_id = $2
      ORDER BY id ASC
      FOR UPDATE`,
    [productId, branchId],
    db
  );
  const match = (candidateRes.rows || []).find((row) => {
    return (
      sameNullableText(row.lot_number, lotData.lot_number) &&
      sameNullableDate(row.expiry_date, lotData.expiry_date) &&
      sameNullableNumber(row.purchase_id, lotData.purchase_id) &&
      sameNullableNumber(row.sale_price, lotData.sale_price)
    );
  });
  if (match) {
    await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [qty, match.id], db);
    return Number(match.id);
  }

  const fields = ['product_id', 'branch_id', 'lot_number', 'quantity'];
  const values = [productId, branchId, lotData.lot_number || null, qty];
  if (lotMeta.hasInitial) {
    fields.push('initial_quantity');
    values.push(qty);
  }
  if (lotMeta.hasPurchaseId) {
    fields.push('purchase_id');
    values.push(lotData.purchase_id != null ? lotData.purchase_id : null);
  }
  if (lotMeta.hasExpiry) {
    fields.push('expiry_date');
    values.push(lotData.expiry_date || null);
  }
  if (lotMeta.hasSalePrice) {
    fields.push('sale_price');
    values.push(lotData.sale_price != null ? lotData.sale_price : null);
  }
  if (lotMeta.hasCreated) {
    fields.push('created_at');
    values.push(lotData.lot_created_at || new Date());
  }
  const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
  const ins = await query(
    `INSERT INTO lots (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`,
    values,
    db
  );
  return Number(ins.rows[0]?.id || 0);
}

async function resolveTransferLotMeta(db) {
  const hasLotsTable = await tableExists(db, 'lots');
  if (!hasLotsTable) return null;
  const cols = await getColumns(db, 'lots');
  return {
    hasCostPrice: cols.includes('cost_price'),
    hasPurchaseId: cols.includes('purchase_id'),
    hasExpiry: cols.includes('expiry_date'),
    hasCreated: cols.includes('created_at'),
    hasInitial: cols.includes('initial_quantity'),
    hasLotNumber: cols.includes('lot_number'),
    hasSalePrice: cols.includes('sale_price')
  };
}

async function insertLotRow(db, productId, branchId, quantity, lotInfo, auditMeta) {
  if (!branchId || !productId || quantity <= 0 || !lotInfo || !lotInfo.lotNumber) return;
  const columns = await getColumns(db, 'lots');
  const fields = ['product_id', 'branch_id', 'lot_number', 'quantity'];
  const values = [productId, branchId, lotInfo.lotNumber, quantity];
  if (columns.includes('initial_quantity')) {
    fields.push('initial_quantity');
    values.push(quantity);
  }
  if (columns.includes('expiry_date') && lotInfo.expiry) {
    fields.push('expiry_date');
    values.push(lotInfo.expiry);
  }
  if (columns.includes('created_at')) {
    fields.push('created_at');
    values.push(new Date());
  }
  const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
  await query(`INSERT INTO lots (${fields.join(',')}) VALUES (${placeholders})`, values, db);
  logAuditEvent({
    action: 'lot_created',
    branch_id: branchId || null,
    user_id: auditMeta?.user_id || null,
    product_id: productId,
    delta: quantity
  });
}

async function consumeLotStock(db, productId, branchId, qty, userId) {
  if (!branchId || !productId || qty <= 0) return;
  const rows = await query(
    `SELECT id, quantity
     FROM lots
     WHERE product_id = $1 AND branch_id = $2 AND quantity > 0
     ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, created_at ASC, id ASC`,
    [productId, branchId],
    db
  );
  let remaining = qty;
  for (const row of rows.rows || []) {
    const available = Number(row.quantity || 0);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, row.id], db);
    logAuditEvent({
      action: 'lot_adjusted',
      branch_id: branchId || null,
      user_id: userId || null,
      product_id: productId,
      delta: -1 * take
    });
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    throw new Error('Stock por lote insuficiente para restar el ajuste solicitado');
  }
}

async function adjustBranchStockForProduct(
  db,
  productId,
  branchId,
  targetStock,
  lotInfo,
  adjustmentMode,
  hasBranchStocksTable,
  hasLotsTable,
  userId
) {
  if (!branchId) return 0;
  const normalizedTarget = Number(targetStock || 0);
  if (!Number.isFinite(normalizedTarget)) return 0;
  const current = await getBranchStock(db, productId, branchId);
  const additionMode = adjustmentMode === 'lot';
  const delta = additionMode ? normalizedTarget : normalizedTarget - current;
  const resolvedLotInfo = lotInfo ? { ...lotInfo } : null;
  let existingLot = null;
  if (hasLotsTable && resolvedLotInfo && !resolvedLotInfo.lotNumber && resolvedLotInfo.expiry) {
    const singleLotRes = await query(
      `SELECT id, lot_number, quantity, expiry_date
         FROM lots
        WHERE product_id = $1 AND branch_id = $2 AND quantity > 0
        ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC`,
      [productId, branchId],
      db
    );
    if ((singleLotRes.rows || []).length === 1) {
      existingLot = singleLotRes.rows[0];
      resolvedLotInfo.lotNumber = existingLot.lot_number || null;
    }
  }
  if (hasLotsTable && resolvedLotInfo && resolvedLotInfo.lotNumber) {
    const st = await query(
      'SELECT id, quantity, expiry_date FROM lots WHERE product_id = $1 AND branch_id = $2 AND LOWER(lot_number) = LOWER($3) ORDER BY id ASC LIMIT 1',
      [productId, branchId, resolvedLotInfo.lotNumber],
      db
    );
    existingLot = st.rows[0] || null;
    if (existingLot && resolvedLotInfo.expiry) {
      await query('UPDATE lots SET expiry_date = $1 WHERE id = $2', [resolvedLotInfo.expiry, existingLot.id], db);
      await query('UPDATE productos SET expira = $1 WHERE id = $2', [resolvedLotInfo.expiry, productId], db);
    }
  }
  if (delta === 0) {
    if (normalizedTarget > 0 && hasLotsTable && resolvedLotInfo && resolvedLotInfo.lotNumber && resolvedLotInfo.expiry && !existingLot) {
      const st = await query(
        'SELECT COALESCE(SUM(quantity),0) AS c FROM lots WHERE product_id = $1 AND branch_id = $2',
        [productId, branchId],
        db
      );
      const lotTotal = Number(st.rows[0]?.c || 0);
      if (lotTotal < normalizedTarget) {
        await insertLotRow(db, productId, branchId, normalizedTarget - lotTotal, resolvedLotInfo, {
          user_id: userId
        });
        await query('UPDATE productos SET expira = $1 WHERE id = $2', [resolvedLotInfo.expiry, productId], db);
      }
    }
    return 0;
  }
  if (delta > 0 && hasLotsTable) {
    if (!resolvedLotInfo || !resolvedLotInfo.lotNumber) {
      throw new Error('Número de lote requerido al aumentar stock');
    }
    if (!resolvedLotInfo.expiry) {
      throw new Error('Fecha de vencimiento del lote requerida');
    }
  }
  if (delta < 0 && hasLotsTable) {
    await consumeLotStock(db, productId, branchId, Math.abs(delta), userId);
  }
  if (hasBranchStocksTable) {
    await ensureBranchStockRow(db, productId, branchId);
  }
  await adjustBranchStock(db, productId, branchId, delta);
  if (delta !== 0 && (await tableExists(db, 'inventario_movimientos'))) {
    try {
      await query(
        'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
        [
          productId,
          delta,
          'ajuste',
          String(productId),
          'Ajuste manual desde Inventario'
        ],
        db
      );
    } catch (_) {}
  }
  logAuditEvent({
    action: 'product_adjusted',
    branch_id: branchId || null,
    user_id: userId || null,
    product_id: productId,
    delta
  });
  if (delta > 0 && hasLotsTable) {
    if (existingLot && resolvedLotInfo && resolvedLotInfo.lotNumber) {
      await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [delta, existingLot.id], db);
      logAuditEvent({
        action: 'lot_adjusted',
        branch_id: branchId || null,
        user_id: userId || null,
        product_id: productId,
        delta
      });
    } else {
      await insertLotRow(db, productId, branchId, delta, resolvedLotInfo, { user_id: userId });
    }
    if (resolvedLotInfo && resolvedLotInfo.expiry) {
      await query('UPDATE productos SET expira = $1 WHERE id = $2', [resolvedLotInfo.expiry, productId], db);
    }
  }
  return delta;
}

function daysUntil(value) {
  const target = startOfDay(value);
  if (!target) return null;
  const today = startOfDay(new Date());
  if (!today) return null;
  const diff = target.getTime() - today.getTime();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function getExpiryAlertLevel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 15) return 15;
  if (n <= 30) return 30;
  if (n <= 60) return 60;
  return null;
}

function getExpiryAlertLabel(days) {
  const level = getExpiryAlertLevel(days);
  if (level === 15) return 'Alerta 15 días';
  if (level === 30) return 'Alerta 30 días';
  if (level === 60) return 'Alerta 60 días';
  return '';
}

async function resolveLotUnitCost(db, lotRow) {
  if (!lotRow || !lotRow.product_id) return 0;
  let cost = Number(lotRow.cost_price || 0);
  if ((!cost || Number.isNaN(cost)) && lotRow.purchase_id && (await tableExists(db, 'purchase_items'))) {
    try {
      const st = await query(
        `SELECT unit_price
           FROM purchase_items
          WHERE purchase_id = $1 AND product_id = $2
          ORDER BY id ASC
          LIMIT 1`,
        [lotRow.purchase_id, lotRow.product_id],
        db
      );
      cost = Number(st.rows[0]?.unit_price || 0);
    } catch (_) {}
  }
  if ((!cost || Number.isNaN(cost)) && lotRow.product_cost != null) {
    cost = Number(lotRow.product_cost || 0);
  }
  return roundMoney(cost);
}

async function fetchExpiredWriteoffLots(db, options = {}) {
  const lotId = Number(options.lotId || 0);
  const productId = Number(options.productId || 0);
  const branchId = options.branchId != null && options.branchId !== '' ? Number(options.branchId || 0) : null;
  const expiryDate = normalizeDateOnly(options.expiryDate || null);
  const lotMeta = await resolveTransferLotMeta(db);
  const purchaseSelect =
    lotMeta && lotMeta.hasPurchaseId ? 'l.purchase_id,' : 'NULL::integer AS purchase_id,';
  const costSelect =
    lotMeta && lotMeta.hasCostPrice ? 'COALESCE(l.cost_price, 0) AS cost_price,' : 'NULL::numeric AS cost_price,';
  const params = [];
  const where = [
    'l.quantity > 0',
    'l.expiry_date IS NOT NULL',
    "l.expiry_date < CURRENT_DATE + INTERVAL '1 day'"
  ];

  if (lotId) {
    where.push(`l.id = $${params.length + 1}`);
    params.push(lotId);
  } else {
    if (!productId) return [];
    where.push(`l.product_id = $${params.length + 1}`);
    params.push(productId);
    if (branchId && branchId > 0) {
      where.push(`l.branch_id = $${params.length + 1}`);
      params.push(branchId);
    }
    if (expiryDate) {
      where.push(`l.expiry_date = $${params.length + 1}`);
      params.push(expiryDate);
    }
  }

  const lotRes = await query(
    `SELECT
       l.id AS lot_id,
       l.product_id,
       l.branch_id,
       l.lot_number,
       l.expiry_date,
       l.quantity,
       ${purchaseSelect}
       ${costSelect}
       COALESCE(p.precio_costo, 0) AS product_cost,
       p.nombre_comercial,
       b.name AS branch_name
     FROM lots l
     JOIN productos p ON p.id = l.product_id
     LEFT JOIN branches b ON b.id = l.branch_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC
     FOR UPDATE OF l`,
    params,
    db
  );
  return lotRes.rows || [];
}

async function buildExpiredWriteoffsWorkbook(payload = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SistemaHHG';
  workbook.created = new Date();
  workbook.modified = new Date();

  const summary = payload.summary || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const filters = payload.filters || {};
  const theme = {
    navy: '10233B',
    blue: '0F5E9C',
    pale: 'EEF6FF',
    line: 'D7E1EE',
    white: 'FFFFFF',
    ink: '24364B',
    muted: '5A6A7F',
    red: 'B02A37'
  };
  const moneyFormat = '"Q"#,##0.00;[Red]-"Q"#,##0.00';
  const qtyFormat = '#,##0.00';
  const border = {
    top: { style: 'thin', color: { argb: theme.line } },
    left: { style: 'thin', color: { argb: theme.line } },
    bottom: { style: 'thin', color: { argb: theme.line } },
    right: { style: 'thin', color: { argb: theme.line } }
  };

  const dashboard = workbook.addWorksheet('Historial');
  dashboard.columns = Array.from({ length: 12 }, () => ({ width: 18 }));
  dashboard.mergeCells(1, 1, 2, 12);
  const titleCell = dashboard.getCell(1, 1);
  titleCell.value = 'HISTORIAL DE MERMAS POR VENCIMIENTO';
  titleCell.font = { bold: true, size: 22, color: { argb: theme.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.navy } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  titleCell.border = border;

  dashboard.mergeCells(3, 1, 3, 12);
  const filterLabel = [
    filters.from ? `Desde ${filters.from}` : null,
    filters.to ? `Hasta ${filters.to}` : null,
    filters.branch_name ? `Sucursal: ${filters.branch_name}` : null,
    filters.q ? `Filtro: ${filters.q}` : null
  ]
    .filter(Boolean)
    .join(' | ') || 'Sin filtros';
  const filterCell = dashboard.getCell(3, 1);
  filterCell.value = filterLabel;
  filterCell.font = { size: 10, color: { argb: theme.muted } };
  filterCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.pale } };
  filterCell.alignment = { vertical: 'middle', horizontal: 'left' };
  filterCell.border = border;

  const cards = [
    { row: 5, col: 1, label: 'Registros', value: Number(summary.total_rows || 0), numFmt: '#,##0' },
    { row: 5, col: 4, label: 'Productos', value: Number(summary.unique_products || 0), numFmt: '#,##0' },
    { row: 5, col: 7, label: 'Cantidad castigada', value: Number(summary.total_quantity || 0), numFmt: qtyFormat },
    { row: 5, col: 10, label: 'Costo total', value: Number(summary.total_cost || 0), numFmt: moneyFormat }
  ];
  cards.forEach((card) => {
    dashboard.mergeCells(card.row, card.col, card.row, card.col + 2);
    dashboard.mergeCells(card.row + 1, card.col, card.row + 2, card.col + 2);
    const labelCell = dashboard.getCell(card.row, card.col);
    labelCell.value = card.label;
    labelCell.font = { bold: true, size: 10, color: { argb: theme.muted } };
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } };
    labelCell.alignment = { vertical: 'middle', horizontal: 'left' };
    labelCell.border = border;
    const valueCell = dashboard.getCell(card.row + 1, card.col);
    valueCell.value = card.value;
    valueCell.numFmt = card.numFmt;
    valueCell.font = { bold: true, size: 18, color: { argb: card.col === 10 ? theme.red : theme.blue } };
    valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } };
    valueCell.alignment = { vertical: 'middle', horizontal: 'left' };
    valueCell.border = border;
  });

  const detail = workbook.addWorksheet('Detalle');
  detail.columns = [
    { header: 'Fecha', key: 'created_at', width: 20 },
    { header: 'Producto', key: 'product_label', width: 32 },
    { header: 'Sucursal', key: 'branch_name', width: 20 },
    { header: 'Lote', key: 'lot_number', width: 18 },
    { header: 'Vence', key: 'expiry_date', width: 14 },
    { header: 'Cantidad', key: 'quantity', width: 14 },
    { header: 'Costo unitario', key: 'unit_cost', width: 16 },
    { header: 'Costo total', key: 'total_cost', width: 16 },
    { header: 'Usuario', key: 'created_by_name', width: 18 },
    { header: 'Notas', key: 'notes', width: 36 }
  ];
  detail.getRow(1).font = { bold: true, color: { argb: theme.white } };
  detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.blue } };
  detail.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  detail.getRow(1).eachCell((cell) => {
    cell.border = border;
  });
  rows.forEach((row) => {
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const excelRow = detail.addRow({
      created_at: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : row.created_at || '',
      product_label: row.product_label || '',
      branch_name: row.branch_name || '',
      lot_number: row.lot_number || '',
      expiry_date: row.expiry_date || '',
      quantity: Number(row.quantity || 0),
      unit_cost: Number(row.unit_cost || 0),
      total_cost: Number(row.total_cost || 0),
      created_by_name: row.created_by_name || '',
      notes: row.notes || ''
    });
    excelRow.eachCell((cell, colNumber) => {
      cell.border = border;
      cell.alignment = { vertical: 'middle', horizontal: colNumber >= 6 && colNumber <= 8 ? 'right' : 'left' };
      if (colNumber === 6) cell.numFmt = qtyFormat;
      if (colNumber === 7 || colNumber === 8) cell.numFmt = moneyFormat;
      if (colNumber === 1 && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function inputBranchId(req, payload) {
  if (payload && payload.branch_id != null && payload.branch_id !== '') {
    const bid = Number(payload.branch_id);
    if (bid > 0) return bid;
  }
  if (req.query.branch_id != null && req.query.branch_id !== '') {
    const bid = Number(req.query.branch_id);
    if (bid > 0) return bid;
  }
  return null;
}

function isCoreInventoryScope(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'core_inventory' || raw === 'inventory_core' || raw === 'main_inventory';
}

function isCoreInventoryBranchName(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw.includes('principal') || raw.includes('emergencia') || raw.includes('hospital');
}

function coreInventoryBranchWhere(alias = 'b') {
  return `(
    LOWER(COALESCE(${alias}.name, '')) LIKE '%principal%'
    OR LOWER(COALESCE(${alias}.name, '')) LIKE '%emergencia%'
    OR LOWER(COALESCE(${alias}.name, '')) LIKE '%hospital%'
  )`;
}

async function shouldUseCoreInventoryTotals(branchId, scopeRaw) {
  if (isCoreInventoryScope(scopeRaw)) return true;
  if (!branchId || !(await tableExists(null, 'branches'))) return false;
  try {
    const st = await query('SELECT name FROM branches WHERE id = $1 LIMIT 1', [branchId]);
    return isCoreInventoryBranchName(st.rows[0]?.name || '');
  } catch (_) {
    return false;
  }
}

router.get(
  '/productos',
  asyncHandler(async (req, res) => {
    await ensureProductActiveColumn(null);
    await ensureProductPresentationColumns(null);
    await ensureProductTypeColumn(null);
    await ensureComboItemsTable(null);
    const q = req.query.q ? String(req.query.q).trim() : '';
    const includeInactive = String(req.query.include_inactive || '').toLowerCase() === '1';
    const typeFilterRaw = req.query.tipo ? String(req.query.tipo).trim() : '';
    const typeFilter = typeFilterRaw ? normalizeProductType(typeFilterRaw) : '';
    const branchId =
      req.query.branch_id != null && req.query.branch_id !== '' ? Number(req.query.branch_id) : null;
    const hasStock = await productStocksAvailable(null);
    const useCoreInventoryTotals =
      hasStock && (await shouldUseCoreInventoryTotals(branchId, req.query.branch_scope || ''));
    const hasBranchStock = branchId && branchId > 0 && hasStock;
    const hasLots = await tableExists(null, 'lots');
    const hasLotSalePrice = hasLots ? await columnExists(null, 'lots', 'sale_price') : false;
    const hasBarcode = await ensureProductBarcodeColumn(null);
    const stockTotalExpr =
      hasStock && useCoreInventoryTotals
        ? `(SELECT COALESCE(SUM(ps_total.stock),0)
            FROM product_stocks ps_total
            JOIN branches b_total ON b_total.id = ps_total.branch_id
            WHERE ps_total.product_id = p.id
              AND ${coreInventoryBranchWhere('b_total')})`
        : '(SELECT COALESCE(SUM(stock),0) FROM product_stocks WHERE product_id = p.id)';

    let select =
      "SELECT p.id, p.nombre_comercial, p.presentacion, p.principio_activo, p.casa, p.expira, p.stock, p.precio_costo, p.precio_publico, p.unidades_por_tableta, p.tabletas_por_caja, p.precio_unidad, p.precio_tableta, COALESCE(p.tipo, 'medicamento') AS tipo";
    if (hasBarcode) {
      select += ', p.codigo_barra';
    }
    if (hasBranchStock) {
      select += `, COALESCE(ps.stock,0) AS stock_branch, ${stockTotalExpr} AS stock_total`;
    } else if (hasStock) {
      select += `, ${stockTotalExpr} AS stock_total`;
    }
    if (hasLots) {
      if (branchId && branchId > 0) {
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id AND branch_id = $1) AS lot_stock_branch';
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id) AS lot_stock_total';
        select +=
          ", (SELECT MIN(expiry_date) FROM lots WHERE product_id = p.id AND branch_id = $1 AND quantity > 0 AND expiry_date IS NOT NULL) AS next_expiry";
        select +=
          ", (SELECT l.lot_number FROM lots l WHERE l.product_id = p.id AND l.branch_id = $1 AND l.quantity > 0 ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_number";
        if (hasLotSalePrice) {
          select +=
            ", (SELECT COALESCE(l.sale_price, p.precio_publico) FROM lots l WHERE l.product_id = p.id AND l.branch_id = $1 AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        } else {
          select +=
            ", (SELECT p.precio_publico FROM lots l WHERE l.product_id = p.id AND l.branch_id = $1 AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        }
      } else {
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id) AS lot_stock_total';
        select +=
          ", (SELECT MIN(expiry_date) FROM lots WHERE product_id = p.id AND quantity > 0 AND expiry_date IS NOT NULL) AS next_expiry";
        select +=
          ", (SELECT l.lot_number FROM lots l WHERE l.product_id = p.id AND l.quantity > 0 ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_number";
        if (hasLotSalePrice) {
          select +=
            ", (SELECT COALESCE(l.sale_price, p.precio_publico) FROM lots l WHERE l.product_id = p.id AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        } else {
          select +=
            ", (SELECT p.precio_publico FROM lots l WHERE l.product_id = p.id AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        }
      }
    }
    let sql = `${select} FROM productos p`;
    const params = [];
    const useBranchParam = branchId && branchId > 0 && (hasBranchStock || (hasLots && branchId > 0));
    if (useBranchParam) {
      params.push(branchId);
    }
    if (hasBranchStock) {
      sql += ' LEFT JOIN product_stocks ps ON ps.product_id = p.id AND ps.branch_id = $1';
    }
    const where = [];
    if (!includeInactive) {
      where.push('COALESCE(p.activo, TRUE) = TRUE');
    }
    if (typeFilter) {
      where.push(`LOWER(COALESCE(p.tipo, 'medicamento')) = $${params.length + 1}`);
      params.push(typeFilter);
    }
    if (q) {
      const searchStart = params.length;
      const pattern = `%${q.toLowerCase()}%`;
      const searchClauses = [
        `LOWER(p.nombre_comercial) LIKE $${searchStart + 1}`,
        `LOWER(p.principio_activo) LIKE $${searchStart + 2}`,
        `LOWER(p.presentacion) LIKE $${searchStart + 3}`,
        `LOWER(p.casa) LIKE $${searchStart + 4}`
      ];
      params.push(pattern, pattern, pattern, pattern);
      if (hasBarcode) {
        searchClauses.push(`LOWER(COALESCE(p.codigo_barra, '')) LIKE $${params.length + 1}`);
        params.push(pattern);
      }
      where.push(`(${searchClauses.join(' OR ')})`);
    }
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY p.id ASC';
    const st = await query(sql, params);
    const availabilityCache = {};
    const comboIds = (st.rows || [])
      .filter((row) => productTypeIsCombo(row.tipo))
      .map((row) => Number(row.id || 0))
      .filter(Boolean);
    const comboComponentsMap = await fetchComboComponents(null, comboIds);
    const items = await Promise.all((st.rows || []).map(async (row) => {
      const exp = startOfDay(row.expira);
      const days = daysUntil(row.expira);
      const normalized = { ...row };
      normalized.tipo = normalizeProductType(row.tipo);
      const presentationConfig = resolvePresentationConfig(row);
      if (productTypeUsesInventory(normalized.tipo)) {
        const stockInfo = deriveStockInfo(row, { branchId, hasLots, hasBranchStock, hasStock });
        if (stockInfo.stock != null) normalized.stock = stockInfo.stock;
        if (stockInfo.stock_total != null) normalized.stock_total = stockInfo.stock_total;
        if (stockInfo.branch_id != null) normalized.branch_id = stockInfo.branch_id;
      } else if (productTypeIsCombo(normalized.tipo)) {
        const comboComponents = comboComponentsMap.get(Number(row.id || 0)) || [];
        normalized.combo_components = comboComponents;
        const comboAvailability = await computeComboAvailability(null, comboComponents, branchId, availabilityCache);
        normalized.stock = comboAvailability.stock;
        normalized.stock_total = comboAvailability.stock_total;
        normalized.stock_missing_components = comboAvailability.missing_components || [];
        if (branchId) normalized.branch_id = branchId;
      } else {
        normalized.stock = null;
        normalized.stock_total = null;
        normalized.stock_missing_components = [];
      }
      normalized.unidades_por_tableta = presentationConfig.unidades_por_tableta;
      normalized.tabletas_por_caja = presentationConfig.tabletas_por_caja;
      normalized.unidades_por_caja = presentationConfig.unidades_por_caja;
      normalized.precio_unidad = presentationConfig.precio_unidad;
      normalized.precio_tableta = presentationConfig.precio_tableta;
      normalized.precio_caja = presentationConfig.precio_caja;
      normalized.precio_publico = presentationConfig.precio_publico;
      normalized.precio_venta_actual = productTypeUsesInventory(normalized.tipo) && hasLots
        ? Number(row.next_lot_price || presentationConfig.precio_caja || 0)
        : Number(presentationConfig.precio_caja || 0);
      normalized.expira = exp ? exp.toISOString().slice(0, 10) : null;
      normalized.days_to_expire = days;
      normalized.expiring_soon = productTypeUsesInventory(normalized.tipo)
        ? days != null && days >= 0 && days <= LOT_EXPIRY_ALERT_DAYS
        : false;
      return normalized;
    }));
    return safeJson(res, items);
  })
);

router.post(
  '/productos',
  validateBody(validationSchemas.productSchema),
  asyncHandler(async (req, res) => {
    const data = req.validatedBody;
    const branchId = inputBranchId(req, data);
    const productType = normalizeProductInputType(data);
    const lotInfo = productTypeUsesInventory(productType)
      ? parseLotInfo(data)
      : { lotNumber: null, expiry: null, expiryError: null };
    const presentationConfig = resolvePresentationConfig(data);
    if (lotInfo.expiryError) {
      return safeJson(res, { ok: false, error: lotInfo.expiryError }, 400);
    }
    const barcode = normalizeBarcode(data.codigo_barra) || null;
    const userId = req.session?.user?.id || null;
    if (barcode) {
      const dup = await query('SELECT id FROM productos WHERE codigo_barra = $1 LIMIT 1', [barcode]);
      if (dup.rows[0]) {
        return safeJson(res, { ok: false, error: 'El código de barras ya existe en otro producto' }, 400);
      }
    }
    const result = await withTransaction(async (db) => {
      await ensureProductBarcodeColumn(db);
      await ensureProductActiveColumn(db);
      await ensureProductPresentationColumns(db);
      await ensureProductTypeColumn(db);
      await ensureComboItemsTable(db);
      const comboComponents = productTypeIsCombo(productType)
        ? await validateComboComponents(db, null, data.combo_components)
        : [];
      const trackedStock = productTypeUsesInventory(productType) ? Number(data.stock || 0) : 0;
      const expira = productTypeUsesInventory(productType) && data.expira ? data.expira : null;
      const ins = await query(
        'INSERT INTO productos (nombre_comercial, codigo_barra, tipo, presentacion, principio_activo, casa, expira, stock, precio_costo, precio_publico, unidades_por_tableta, tabletas_por_caja, precio_unidad, precio_tableta, activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE) RETURNING id',
        [
          data.nombre_comercial || '',
          barcode,
          productType,
          data.presentacion || null,
          data.principio_activo || null,
          data.casa || null,
          expira,
          trackedStock,
          Number(data.precio_costo || 0),
          presentationConfig.precio_caja,
          presentationConfig.unidades_por_tableta,
          presentationConfig.tabletas_por_caja,
          presentationConfig.precio_unidad,
          presentationConfig.precio_tableta
        ],
        db
      );
      const newId = Number(ins.rows[0].id);
      const hasBranchStocks = await productStocksAvailable(db);
      const hasLotsTable = await tableExists(db, 'lots');
      if (productTypeUsesInventory(productType) && branchId && hasBranchStocks) {
        await adjustBranchStockForProduct(
          db,
          newId,
          branchId,
          trackedStock,
          lotInfo,
          data.adjust_branch_stock || '',
          hasBranchStocks,
          hasLotsTable,
          userId
        );
      }
      await replaceComboComponents(db, newId, comboComponents);
      await logAction(db, userId, 'producto_creado', {
        entity_type: 'producto',
        entity_id: newId,
        branch_id: branchId || null,
        nombre_comercial: data.nombre_comercial || '',
        tipo: productType,
        precio_publico: presentationConfig.precio_caja,
        stock: trackedStock,
        combo_components: comboComponents
      });
      logInfo('Producto creado', { producto_id: newId, branchId, barcode });
      logAuditEvent({
        action: 'product_created',
        branch_id: branchId || null,
        user_id: userId,
        product_id: newId,
        product_name: data.nombre_comercial || '',
        product_type: productType,
        public_price: presentationConfig.precio_caja,
        stock: trackedStock
      });
      return newId;
    });
    return safeJson(res, { ok: true, id: result });
  })
);

router.put(
  '/productos',
  validateBody(validationSchemas.productSchema),
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    const id = req.query.id ? Number(req.query.id) : 0;
    if (!id) return safeJson(res, { ok: false, error: 'Falta id' }, 400);
    const data = req.validatedBody;
    const branchId = inputBranchId(req, data);
    const productType = normalizeProductInputType(data);
    const barcode = normalizeBarcode(data.codigo_barra) || null;
    const lotInfo = productTypeUsesInventory(productType)
      ? parseLotInfo(data)
      : { lotNumber: null, expiry: null, expiryError: null };
    const presentationConfig = resolvePresentationConfig(data);
    if (lotInfo.expiryError) {
      return safeJson(res, { ok: false, error: lotInfo.expiryError }, 400);
    }
    const userId = req.session?.user?.id || null;
    if (barcode) {
      const dup = await query(
        'SELECT id FROM productos WHERE codigo_barra = $1 AND id <> $2 LIMIT 1',
        [barcode, id]
      );
      if (dup.rows[0]) {
        return safeJson(res, { ok: false, error: 'El código de barras ya existe en otro producto' }, 400);
      }
    }
    await withTransaction(async (db) => {
      await ensureProductBarcodeColumn(db);
      await ensureProductActiveColumn(db);
      await ensureProductPresentationColumns(db);
      await ensureProductTypeColumn(db);
      await ensureComboItemsTable(db);
      await ensureTypeChangeAllowed(db, id, productType);
      const comboComponents = productTypeIsCombo(productType)
        ? await validateComboComponents(db, id, data.combo_components)
        : [];
      let prevProduct = null;
      try {
        const prevRes = await query(
          `SELECT nombre_comercial, tipo, precio_publico, stock, presentacion, principio_activo, casa, expira
             FROM productos
            WHERE id = $1
            LIMIT 1`,
          [id],
          db
        );
        prevProduct = prevRes.rows[0] || null;
      } catch (_) {
        prevProduct = null;
      }
      let prevStock = null;
      try {
        const st = await query('SELECT stock FROM productos WHERE id = $1', [id], db);
        prevStock = st.rows[0]?.stock != null ? Number(st.rows[0].stock) : null;
      } catch (_) {
        prevStock = null;
      }
      const trackedStock = productTypeUsesInventory(productType) ? Number(data.stock || 0) : 0;
      const expira = productTypeUsesInventory(productType) && data.expira ? data.expira : null;
      await query(
        'UPDATE productos SET nombre_comercial=$1, codigo_barra=$2, tipo=$3, presentacion=$4, principio_activo=$5, casa=$6, expira=$7, stock=$8, precio_costo=$9, precio_publico=$10, unidades_por_tableta=$11, tabletas_por_caja=$12, precio_unidad=$13, precio_tableta=$14 WHERE id=$15',
        [
          data.nombre_comercial || '',
          barcode,
          productType,
          data.presentacion || null,
          data.principio_activo || null,
          data.casa || null,
          expira,
          trackedStock,
          Number(data.precio_costo || 0),
          presentationConfig.precio_caja,
          presentationConfig.unidades_por_tableta,
          presentationConfig.tabletas_por_caja,
          presentationConfig.precio_unidad,
          presentationConfig.precio_tableta,
          id
        ],
        db
      );
      if (productTypeUsesInventory(productType)) {
        await syncLotSalePrice(db, id, branchId, lotInfo, presentationConfig.precio_caja);
      }
      const hasBranchStocks = await productStocksAvailable(db);
      const hasLotsTable = await tableExists(db, 'lots');
      if (productTypeUsesInventory(productType) && branchId && hasBranchStocks) {
        await adjustBranchStockForProduct(
          db,
          id,
          branchId,
          trackedStock,
          lotInfo,
          data.adjust_branch_stock || '',
          hasBranchStocks,
          hasLotsTable,
          userId
        );
      } else if (productTypeUsesInventory(productType)) {
        const newStock = trackedStock;
        const delta = prevStock != null ? newStock - prevStock : 0;
        if (delta !== 0 && (await tableExists(db, 'inventario_movimientos'))) {
          try {
            await query(
              'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
              [
                id,
                delta,
                'ajuste',
                String(id),
                'Ajuste manual desde Inventario'
              ],
              db
            );
          } catch (_) {}
        }
      }
      await replaceComboComponents(db, id, comboComponents);
      await logAction(db, userId, 'producto_actualizado', {
        entity_type: 'producto',
        entity_id: id,
        branch_id: branchId || null,
        before: prevProduct || null,
        after: {
          nombre_comercial: data.nombre_comercial || '',
          tipo: productType,
          precio_publico: presentationConfig.precio_caja,
          stock: trackedStock,
          presentacion: data.presentacion || null,
          principio_activo: data.principio_activo || null,
          casa: data.casa || null,
          expira
        },
        combo_components: comboComponents
      });
      logInfo('Producto actualizado', { producto_id: id, branchId, barcode });
      logAuditEvent({
        action: 'product_updated',
        branch_id: branchId || null,
        user_id: userId,
        product_id: id,
        product_name: data.nombre_comercial || prevProduct?.nombre_comercial || '',
        product_type: productType,
        public_price: presentationConfig.precio_caja,
        stock: trackedStock
      });
    });
    return safeJson(res, { ok: true });
  })
);

router.delete(
  '/productos',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    const id = req.query.id ? Number(req.query.id) : 0;
    if (!id) return safeJson(res, { ok: false, error: 'Falta id' }, 400);
    await ensureProductActiveColumn(null);
    try {
      const userId = req.session?.user?.id || null;
      let productRow = null;
      try {
        const st = await query(
          "SELECT nombre_comercial, COALESCE(tipo, 'medicamento') AS tipo, precio_publico, stock FROM productos WHERE id = $1 LIMIT 1",
          [id]
        );
        productRow = st.rows[0] || null;
      } catch (_) {
        productRow = null;
      }
      await query('UPDATE productos SET activo = FALSE WHERE id = $1', [id]);
      await logAction(null, userId, 'producto_desactivado', {
        entity_type: 'producto',
        entity_id: id,
        before: productRow || null,
        status: 'ok',
        source_module: 'inventario'
      });
      logAuditEvent({
        action: 'product_deleted',
        user_id: userId,
        product_id: id,
        product_name: productRow?.nombre_comercial || '',
        product_type: normalizeProductType(productRow?.tipo),
        public_price: Number(productRow?.precio_publico || 0),
        stock: Number(productRow?.stock || 0)
      });
      logInfo('Producto desactivado', { producto_id: id });
      return safeJson(res, { ok: true, inactive: true });
    } catch (err) {
      return safeJson(res, { ok: false, error: 'No se pudo eliminar el producto' }, 500);
    }
  })
);
router.get(
  '/lot_lookup',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'cashier', 'cajero', 'cashiee', 'cashierh', 'farmacia', 'contabilidad', 'user'])(req, res, async () => {});
    if (res.headersSent) return;
    const codeRaw = req.query.code ?? req.query.lote ?? req.query.lot ?? req.query.barcode ?? '';
    const code = String(codeRaw || '').trim();
    if (!code) return safeJson(res, { ok: false, error: 'Código requerido' }, 400);
    const branchId = inputBranchId(req, null);
    if (!branchId) return safeJson(res, { ok: false, error: 'Sucursal requerida' }, 400);
    if (!(await tableExists(null, 'lots'))) {
      return safeJson(res, { ok: false, error: 'No hay control de lotes configurado' }, 400);
    }
    const hasSalePrice = await columnExists(null, 'lots', 'sale_price');
    const saleSelect = hasSalePrice ? 'l.sale_price' : 'NULL AS sale_price';
    const lotRes = await query(
      `SELECT l.id AS lot_id, l.product_id, l.lot_number, l.expiry_date, l.quantity, ${saleSelect},
              p.nombre_comercial, p.presentacion, p.principio_activo, p.casa, p.precio_publico
       FROM lots l
       JOIN productos p ON p.id = l.product_id
       WHERE l.branch_id = $1 AND l.lot_number = $2
         AND l.quantity > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date >= CURRENT_DATE
       ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC
       LIMIT 1`,
      [branchId, code]
    );
    const row = lotRes.rows[0];
    if (!row) {
      return safeJson(res, { ok: false, error: 'Lote no disponible' }, 404);
    }
    const exp = startOfDay(row.expiry_date);
    const days = daysUntil(row.expiry_date);
    const expiryDate = exp ? exp.toISOString().slice(0, 10) : null;
    const price = Number(row.sale_price || row.precio_publico || 0);
    return safeJson(res, {
      ok: true,
      lot: {
        id: Number(row.lot_id || 0),
        lot_number: row.lot_number || null,
        expiry_date: expiryDate,
        quantity: Number(row.quantity || 0)
      },
      product: {
        id: Number(row.product_id || 0),
        nombre_comercial: row.nombre_comercial || '',
        presentacion: row.presentacion || '',
        principio_activo: row.principio_activo || '',
        casa: row.casa || '',
        precio_publico: Number(row.precio_publico || 0)
      },
      price,
      expiring_soon: days != null && days >= 0 && days <= LOT_EXPIRY_ALERT_DAYS,
      days_to_expire: days,
      expiry_date: expiryDate
    });
  })
);

router.get(
  '/barcode_lookup',
  validateQuery(validationSchemas.barcodeLookupSchema),
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'cashier', 'cajero', 'cashiee', 'cashierh', 'farmacia', 'contabilidad', 'user'])(req, res, async () => {});
    if (res.headersSent) return;
    const rawCode = String(req.validatedQuery.code || '');
    const branchId = Number(req.validatedQuery.branch_id || 0);
    const normalizedCode = normalizeBarcode(rawCode);
    const hasBarcode = await ensureProductBarcodeColumn(null);
    await ensureProductPresentationColumns(null);
    await ensureProductTypeColumn(null);
    await ensureComboItemsTable(null);
    const hasStock = await productStocksAvailable(null);
    const hasBranchStock = branchId && branchId > 0 && hasStock;
    const hasLots = await tableExists(null, 'lots');
    const hasLotSalePrice = hasLots ? await columnExists(null, 'lots', 'sale_price') : false;

    let select =
      "SELECT p.id, p.nombre_comercial, p.presentacion, p.principio_activo, p.casa, p.expira, p.stock, p.precio_costo, p.precio_publico, p.unidades_por_tableta, p.tabletas_por_caja, p.precio_unidad, p.precio_tableta, COALESCE(p.tipo, 'medicamento') AS tipo";
    if (hasBarcode) {
      select += ', p.codigo_barra';
    }
    if (hasBranchStock) {
      select +=
        ', COALESCE(ps.stock,0) AS stock_branch, (SELECT COALESCE(SUM(stock),0) FROM product_stocks WHERE product_id = p.id) AS stock_total';
    } else if (hasStock) {
      select += ', (SELECT COALESCE(SUM(stock),0) FROM product_stocks WHERE product_id = p.id) AS stock_total';
    }
    if (hasLots) {
      if (branchId && branchId > 0) {
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id AND branch_id = $1) AS lot_stock_branch';
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id) AS lot_stock_total';
        select +=
          ", (SELECT MIN(expiry_date) FROM lots WHERE product_id = p.id AND branch_id = $1 AND quantity > 0 AND expiry_date IS NOT NULL) AS next_expiry";
        if (hasLotSalePrice) {
          select +=
            ", (SELECT COALESCE(l.sale_price, p.precio_publico) FROM lots l WHERE l.product_id = p.id AND l.branch_id = $1 AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        } else {
          select +=
            ", (SELECT p.precio_publico FROM lots l WHERE l.product_id = p.id AND l.branch_id = $1 AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        }
      } else {
        select +=
          ', (SELECT COALESCE(SUM(quantity),0) FROM lots WHERE product_id = p.id) AS lot_stock_total';
        select +=
          ", (SELECT MIN(expiry_date) FROM lots WHERE product_id = p.id AND quantity > 0 AND expiry_date IS NOT NULL) AS next_expiry";
        if (hasLotSalePrice) {
          select +=
            ", (SELECT COALESCE(l.sale_price, p.precio_publico) FROM lots l WHERE l.product_id = p.id AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        } else {
          select +=
            ", (SELECT p.precio_publico FROM lots l WHERE l.product_id = p.id AND l.quantity > 0 AND l.expiry_date >= CURRENT_DATE AND l.expiry_date IS NOT NULL ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC LIMIT 1) AS next_lot_price";
        }
      }
    }
    let sql = `${select} FROM productos p`;
    const params = [];
    const useBranchParam = branchId && branchId > 0 && (hasBranchStock || (hasLots && branchId > 0));
    if (useBranchParam) {
      params.push(branchId);
    }
    if (hasBranchStock) {
      sql += ' LEFT JOIN product_stocks ps ON ps.product_id = p.id AND ps.branch_id = $1';
    }
    const where = [];
    if (hasBarcode) {
      where.push(`LOWER(TRIM(COALESCE(p.codigo_barra, ''))) = $${params.length + 1}`);
      params.push(normalizedCode);
    }
    if (/^\\d+$/.test(rawCode)) {
      where.push(`p.id = $${params.length + 1}`);
      params.push(Number(rawCode));
    }
    if (!where.length) {
      logError('Barcode lookup sin criterios válidos', { code: rawCode, branchId });
      return safeJson(res, { ok: false, error: 'No se puede buscar por ese código' }, 400);
    }
    sql += ` WHERE (${where.join(' OR ')}) ORDER BY p.id ASC LIMIT 1`;
    const st = await query(sql, params);
    const row = st.rows[0];
    if (!row) {
      logWarn('Barcode lookup sin coincidencias', { code: normalizedCode, branchId });
      return safeJson(res, { ok: false, error: 'Producto no encontrado' }, 404);
    }
    const presentationConfig = resolvePresentationConfig(row);
    const out = { ...row, casa_nombre: row.casa || '' };
    out.tipo = normalizeProductType(row.tipo);
    if (productTypeUsesInventory(out.tipo)) {
      const stockInfo = deriveStockInfo(row, { branchId, hasLots, hasBranchStock, hasStock });
      Object.assign(out, stockInfo);
    } else if (productTypeIsCombo(out.tipo)) {
      const comboComponentsMap = await fetchComboComponents(null, [Number(row.id || 0)]);
      const comboComponents = comboComponentsMap.get(Number(row.id || 0)) || [];
      out.combo_components = comboComponents;
      const comboAvailability = await computeComboAvailability(null, comboComponents, branchId, {});
      out.stock = comboAvailability.stock;
      out.stock_total = comboAvailability.stock_total;
      out.stock_missing_components = comboAvailability.missing_components || [];
      out.branch_id = branchId;
    } else {
      out.stock = null;
      out.stock_total = null;
      out.stock_missing_components = [];
      out.branch_id = branchId;
    }
    delete out.stock_branch;
    delete out.lot_stock_branch;
    delete out.lot_stock_total;
    out.unidades_por_tableta = presentationConfig.unidades_por_tableta;
    out.tabletas_por_caja = presentationConfig.tabletas_por_caja;
    out.unidades_por_caja = presentationConfig.unidades_por_caja;
    out.precio_unidad = presentationConfig.precio_unidad;
    out.precio_tableta = presentationConfig.precio_tableta;
    out.precio_caja = presentationConfig.precio_caja;
    out.precio_publico = presentationConfig.precio_publico;
    if (productTypeUsesInventory(out.tipo) && hasLots) {
      out.precio_venta_actual = Number(row.next_lot_price || row.precio_publico || 0);
    } else {
      out.precio_venta_actual = Number(row.precio_publico || 0);
    }
    if (productTypeUsesInventory(out.tipo) && row.next_expiry) {
      const exp = startOfDay(row.next_expiry);
      const days = daysUntil(row.next_expiry);
      out.next_expiry = exp ? exp.toISOString().slice(0, 10) : null;
      out.days_to_expire = days;
      out.expiring_soon = days != null && days >= 0 && days <= LOT_EXPIRY_ALERT_DAYS;
    } else {
      out.days_to_expire = null;
      out.expiring_soon = false;
    }
    logInfo('Barcode lookup', { producto_id: Number(out.id || 0), branchId });
    return safeJson(res, { ok: true, product: out });
  })
);

router.get(
  '/expiring_products',
  asyncHandler(async (req, res) => {
    await requireRole(
      ['admin', 'administrador', 'contabilidad', 'farmacia', 'cashier', 'cajero', 'cashiee', 'cashierh', 'superadmin', 'enfermeria', 'user']
    )(req, res, async () => {});
    if (res.headersSent) return;
    await ensureProductActiveColumn(null);
    const hasLots = await tableExists(null, 'lots');
    const hasStockTable = await productStocksAvailable(null);
    if (!hasLots && !hasStockTable) {
      return safeJson(
        res,
        { ok: true, items: [], summary: { total: 0, expired: 0, expired_cost: 0, alert60: 0, alert30: 0, alert15: 0 } }
      );
    }

    const branchId = req.query.branch_id != null && req.query.branch_id !== '' ? Number(req.query.branch_id) : null;
    const q = String(req.query.q || '').trim().toLowerCase();
    const alertFilterRaw = String(req.query.alert || '').trim();
    const alertFilter = ['60', '30', '15'].includes(alertFilterRaw) ? Number(alertFilterRaw) : null;
    const scopeRaw = String(req.query.scope || '').trim().toLowerCase();
    const scope = ['expired', 'all'].includes(scopeRaw) ? scopeRaw : 'upcoming';
    const hasBranchStock = hasStockTable && branchId && branchId > 0;
    const params = [];
    const where = ['COALESCE(p.activo, TRUE) = TRUE'];
    let sql = '';

    if (hasStockTable) {
      where.push('COALESCE(ps.stock, 0) > 0');
      if (branchId && branchId > 0) {
        where.push(`ps.branch_id = $${params.length + 1}`);
        params.push(branchId);
      }
      if (q) {
        const pattern = `%${q}%`;
        where.push(
          `(
            LOWER(COALESCE(p.nombre_comercial,'')) LIKE $${params.length + 1}
            OR LOWER(COALESCE(p.presentacion,'')) LIKE $${params.length + 2}
            OR LOWER(COALESCE(p.principio_activo,'')) LIKE $${params.length + 3}
            OR LOWER(COALESCE(p.casa,'')) LIKE $${params.length + 4}
            OR LOWER(COALESCE(b.name,'')) LIKE $${params.length + 5}
            ${
              hasLots
                ? `OR LOWER(COALESCE((
              SELECT l.lot_number
              FROM lots l
              WHERE l.product_id = p.id AND l.branch_id = ps.branch_id AND l.quantity > 0
              ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
              LIMIT 1
            ),'')) LIKE $${params.length + 6}`
                : ''
            }
          )`
        );
        params.push(pattern, pattern, pattern, pattern, pattern);
        if (hasLots) params.push(pattern);
      }
      sql = `
        SELECT
          p.id AS product_id,
          ps.branch_id,
          b.name AS branch_name,
          p.nombre_comercial,
          p.presentacion,
          p.principio_activo,
          p.casa,
          p.expira,
          p.stock AS product_stock,
          COALESCE(ps.stock, 0) AS inventory_stock,
          (SELECT COALESCE(SUM(stock),0) FROM product_stocks WHERE product_id = p.id) AS stock_total,
          COALESCE(p.precio_costo, 0) AS product_cost,
          ${
            hasLots
              ? `(SELECT MIN(l.expiry_date)
                  FROM lots l
                  WHERE l.product_id = p.id
                    AND l.branch_id = ps.branch_id
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL) AS next_expiry,
                 (SELECT l.id
                  FROM lots l
                  WHERE l.product_id = p.id
                    AND l.branch_id = ps.branch_id
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL
                    AND l.expiry_date < CURRENT_DATE + INTERVAL '1 day'
                  ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC
                  LIMIT 1) AS expired_lot_id,
                 (SELECT l.id
                  FROM lots l
                  WHERE l.product_id = p.id
                    AND l.branch_id = ps.branch_id
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL
                  ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
                  LIMIT 1) AS next_lot_id,
                 (SELECT l.lot_number
                  FROM lots l
                  WHERE l.product_id = p.id
                    AND l.branch_id = ps.branch_id
                    AND l.quantity > 0
                  ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
                  LIMIT 1) AS next_lot_number`
              : `NULL::date AS next_expiry,
                 NULL::integer AS expired_lot_id,
                 NULL::integer AS next_lot_id,
                 NULL::varchar AS next_lot_number`
          }
        FROM productos p
        INNER JOIN product_stocks ps ON ps.product_id = p.id
        LEFT JOIN branches b ON b.id = ps.branch_id
        WHERE ${where.join(' AND ')}
      `;
    } else {
      where.push('COALESCE(p.stock, 0) > 0');
      let branchParamIndex = null;
      if (q) {
        const pattern = `%${q}%`;
        const searchStart = params.length + 1;
        const lotBranchPlaceholder = hasLots && branchId && branchId > 0 ? searchStart + 4 : null;
        const lotSearchPlaceholder = hasLots
          ? branchId && branchId > 0
            ? searchStart + 5
            : searchStart + 4
          : null;
        where.push(
          `(
            LOWER(COALESCE(p.nombre_comercial,'')) LIKE $${searchStart}
            OR LOWER(COALESCE(p.presentacion,'')) LIKE $${searchStart + 1}
            OR LOWER(COALESCE(p.principio_activo,'')) LIKE $${searchStart + 2}
            OR LOWER(COALESCE(p.casa,'')) LIKE $${searchStart + 3}
            ${
              hasLots
                ? `OR LOWER(COALESCE((
              SELECT l.lot_number
              FROM lots l
              WHERE l.product_id = p.id
                ${lotBranchPlaceholder ? `AND l.branch_id = $${lotBranchPlaceholder}` : ''}
                AND l.quantity > 0
              ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
              LIMIT 1
            ),'')) LIKE $${lotSearchPlaceholder}`
                : ''
            }
          )`
        );
        params.push(pattern, pattern, pattern, pattern);
        if (hasLots && branchId && branchId > 0) {
          branchParamIndex = params.length + 1;
          params.push(branchId, pattern);
        } else if (hasLots) {
          params.push(pattern);
        } else if (branchId && branchId > 0) {
          branchParamIndex = params.length + 1;
          params.push(branchId);
        }
      } else if (branchId && branchId > 0) {
        branchParamIndex = params.length + 1;
        params.push(branchId);
      }
      const branchSql =
        branchParamIndex
          ? `(SELECT name FROM branches WHERE id = $${branchParamIndex})`
          : `CASE WHEN ${hasLots ? 'EXISTS (SELECT 1 FROM lots l2 WHERE l2.product_id = p.id AND l2.quantity > 0)' : 'FALSE'} THEN 'Varias sucursales' ELSE '' END`;
      sql = `
        SELECT
          p.id AS product_id,
          ${branchParamIndex ? `$${branchParamIndex}::integer` : 'NULL::integer'} AS branch_id,
          ${branchSql} AS branch_name,
          p.nombre_comercial,
          p.presentacion,
          p.principio_activo,
          p.casa,
          p.expira,
          p.stock AS product_stock,
          COALESCE(p.stock, 0) AS inventory_stock,
          COALESCE(p.stock, 0) AS stock_total,
          COALESCE(p.precio_costo, 0) AS product_cost,
          ${
            hasLots
              ? `(SELECT MIN(l.expiry_date)
                  FROM lots l
                  WHERE l.product_id = p.id
                    ${branchParamIndex ? `AND l.branch_id = $${branchParamIndex}` : ''}
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL) AS next_expiry,
                 (SELECT l.id
                  FROM lots l
                  WHERE l.product_id = p.id
                    ${branchParamIndex ? `AND l.branch_id = $${branchParamIndex}` : ''}
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL
                    AND l.expiry_date < CURRENT_DATE + INTERVAL '1 day'
                  ORDER BY l.expiry_date ASC, l.created_at ASC, l.id ASC
                  LIMIT 1) AS expired_lot_id,
                 (SELECT l.id
                  FROM lots l
                  WHERE l.product_id = p.id
                    ${branchParamIndex ? `AND l.branch_id = $${branchParamIndex}` : ''}
                    AND l.quantity > 0
                    AND l.expiry_date IS NOT NULL
                  ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
                  LIMIT 1) AS next_lot_id,
                 (SELECT l.lot_number
                  FROM lots l
                  WHERE l.product_id = p.id
                    ${branchParamIndex ? `AND l.branch_id = $${branchParamIndex}` : ''}
                    AND l.quantity > 0
                  ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, l.id ASC
                  LIMIT 1) AS next_lot_number`
              : `NULL::date AS next_expiry,
                 NULL::integer AS expired_lot_id,
                 NULL::integer AS next_lot_id,
                 NULL::varchar AS next_lot_number`
          }
        FROM productos p
        WHERE ${where.join(' AND ')}
      `;
    }

    sql = `
      SELECT *
      FROM (${sql}) expiring_inventory
      ORDER BY COALESCE(expira, next_expiry) ASC NULLS LAST, nombre_comercial ASC, product_id ASC
    `;

    const st = await query(sql, params);
    const itemsAll = (st.rows || [])
      .map((row) => {
        const quantity = Number(
          hasStockTable ? row.inventory_stock || 0 : row.inventory_stock != null ? row.inventory_stock : row.product_stock || 0
        );
        const expiryValue = row.expira || row.next_expiry || null;
        const days = daysUntil(expiryValue);
        const alertLevel = getExpiryAlertLevel(days);
        const expired = Number.isFinite(days) && days < 0;
        const unitCost = roundMoney(row.product_cost || 0);
        const primaryLotId = Number((expired ? row.expired_lot_id : row.next_lot_id) || 0);
        return {
          lot_id: primaryLotId,
          product_id: Number(row.product_id || 0),
          branch_id: Number(row.branch_id || 0),
          lot_number: row.next_lot_number || '',
          expiry_date: normalizeDateOnly(expiryValue),
          quantity,
          unit_cost: unitCost,
          total_cost: roundMoney(quantity * unitCost),
          nombre_comercial: row.nombre_comercial || '',
          presentacion: row.presentacion || '',
          principio_activo: row.principio_activo || '',
          casa: row.casa || '',
          branch_name: row.branch_name || '',
          days_to_expire: days,
          expired,
          status: expired ? 'expired' : 'upcoming',
          alert_level: alertLevel,
          alert_label: expired ? 'Vencido' : getExpiryAlertLabel(days)
        };
      })
      .filter((row) => Number(row.quantity || 0) > 0 && (row.expired || row.alert_level != null));

    let items = itemsAll;
    if (scope === 'expired') {
      items = itemsAll.filter((row) => row.expired);
    } else if (scope === 'upcoming') {
      items = itemsAll.filter((row) => !row.expired);
    }
    if (alertFilter && scope !== 'expired') {
      items = items.filter((row) => row.alert_level === alertFilter);
    }
    const upcomingItems = itemsAll.filter((row) => !row.expired);
    const expiredItems = itemsAll.filter((row) => row.expired);
    const summary = {
      total: upcomingItems.length,
      expired: expiredItems.length,
      expired_cost: roundMoney(expiredItems.reduce((sum, row) => sum + Number(row.total_cost || 0), 0)),
      alert60: upcomingItems.filter((row) => row.alert_level === 60).length,
      alert30: upcomingItems.filter((row) => row.alert_level === 30).length,
      alert15: upcomingItems.filter((row) => row.alert_level === 15).length,
      total_cost: roundMoney(itemsAll.reduce((sum, row) => sum + Number(row.total_cost || 0), 0))
    };
    return safeJson(res, { ok: true, items, summary });
  })
);

router.post(
  '/expired_writeoff',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    if (!(await tableExists(null, 'lots'))) {
      return safeJson(res, { ok: false, error: 'No hay control de lotes configurado' }, 400);
    }

    const input = readJson(req);
    const lotId = Number(input.lot_id || input.id || 0);
    const productId = Number(input.product_id || 0);
    const branchIdInput =
      input.branch_id == null || input.branch_id === '' ? null : Number(input.branch_id || 0);
    const expiryDate = normalizeDateOnly(input.expiry_date || null);
    const requestedQty =
      input.quantity == null || input.quantity === '' ? null : Number(input.quantity || 0);
    const notes = String(input.notes || input.note || '').trim();
    const userId = req.session?.user?.id || req.session?.user_id || null;

    if (!lotId && !productId) {
      return safeJson(res, { ok: false, error: 'lot_id o product_id requerido' }, 400);
    }
    if (requestedQty != null && (!Number.isFinite(requestedQty) || requestedQty <= 0)) {
      return safeJson(res, { ok: false, error: 'La cantidad debe ser mayor a cero' }, 400);
    }

    try {
      const result = await withTransaction(async (db) => {
        await ensureInventoryWriteoffsTable(db);
        const lots = await fetchExpiredWriteoffLots(db, {
          lotId,
          productId,
          branchId: branchIdInput,
          expiryDate
        });
        if (!lots.length) {
          const err = new Error(lotId ? 'Lote no encontrado' : 'No hay lotes vencidos disponibles para este producto');
          err.statusCode = 404;
          throw err;
        }

        const availableTotal = roundMoney(
          lots.reduce((sum, lot) => sum + Number(lot.quantity || 0), 0)
        );
        if (!Number.isFinite(availableTotal) || availableTotal <= 0) {
          const err = new Error('El lote ya no tiene existencia disponible');
          err.statusCode = 400;
          throw err;
        }

        const quantity = requestedQty == null ? availableTotal : Number(requestedQty || 0);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          const err = new Error('La cantidad debe ser mayor a cero');
          err.statusCode = 400;
          throw err;
        }
        if (quantity > availableTotal + 0.0001) {
          const err = new Error(`La cantidad excede el stock disponible (${availableTotal})`);
          err.statusCode = 400;
          throw err;
        }

        const resolvedProductId = Number(lots[0].product_id || 0);
        const resolvedBranchId = Number(lots[0].branch_id || 0) || null;
        const productLabel =
          String(lots[0].nombre_comercial || '').trim() || `Producto ${resolvedProductId}`;
        const branchName = lots[0].branch_name || '';
        const writeoffIds = [];
        const affectedLots = [];
        let remaining = quantity;
        let totalCost = 0;

        for (const lot of lots) {
          if (remaining <= 0.0001) break;
          const available = Number(lot.quantity || 0);
          if (!Number.isFinite(available) || available <= 0) continue;
          const take = Math.min(available, remaining);
          const unitCost = await resolveLotUnitCost(db, lot);
          const lineCost = roundMoney(take * unitCost);
          totalCost = roundMoney(totalCost + lineCost);

          await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, lot.lot_id], db);

          const writeoffIns = await query(
            `INSERT INTO inventory_writeoffs
              (lot_id, product_id, branch_id, lot_number, expiry_date, quantity, unit_cost, total_cost, reason, notes, product_label, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id`,
            [
              Number(lot.lot_id || 0),
              resolvedProductId,
              resolvedBranchId,
              lot.lot_number || null,
              lot.expiry_date || null,
              take,
              unitCost,
              lineCost,
              'expired',
              notes || null,
              productLabel,
              userId
            ],
            db
          );
          writeoffIds.push(Number(writeoffIns.rows[0]?.id || 0));
          affectedLots.push({
            lot_id: Number(lot.lot_id || 0),
            lot_number: lot.lot_number || '',
            expiry_date: normalizeDateOnly(lot.expiry_date),
            quantity: roundMoney(take),
            unit_cost: unitCost,
            total_cost: lineCost
          });
          remaining = roundMoney(remaining - take);
        }

        if (remaining > 0.0001) {
          const err = new Error('No se pudo completar la merma con los lotes vencidos disponibles');
          err.statusCode = 400;
          throw err;
        }

        if (resolvedBranchId) {
          await adjustBranchStock(db, resolvedProductId, resolvedBranchId, -1 * quantity);
        } else {
          await query('UPDATE productos SET stock = GREATEST(0, stock - $1) WHERE id = $2', [quantity, resolvedProductId], db);
        }

        const movementNote = [
          'Merma por vencimiento',
          affectedLots.length
            ? `Lotes ${affectedLots.map((lot) => lot.lot_number || `#${lot.lot_id}`).join(', ')}`
            : null,
          notes || null
        ]
          .filter(Boolean)
          .join(' | ');

        if (await tableExists(db, 'inventario_movimientos')) {
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [resolvedProductId, -1 * quantity, 'merma_vencimiento', String(writeoffIds[0] || lotId || resolvedProductId), movementNote],
            db
          );
        }

        await logAction(db, userId, 'merma_vencimiento_registrada', {
          writeoff_ids: writeoffIds,
          lot_ids: affectedLots.map((lot) => lot.lot_id),
          product_id: resolvedProductId,
          branch_id: resolvedBranchId,
          quantity,
          total_cost: totalCost
        });
        logAuditEvent({
          action: 'lot_adjusted',
          branch_id: resolvedBranchId,
          user_id: userId || null,
          product_id: resolvedProductId,
          delta: -1 * quantity
        });
        logAuditEvent({
          action: 'product_adjusted',
          branch_id: resolvedBranchId,
          user_id: userId || null,
          product_id: resolvedProductId,
          delta: -1 * quantity
        });
        logInfo('Merma por vencimiento registrada', {
          writeoff_ids: writeoffIds,
          product_id: resolvedProductId,
          branch_id: resolvedBranchId,
          quantity,
          total_cost: totalCost
        });

        return {
          writeoff_id: writeoffIds[0] || null,
          writeoff_ids: writeoffIds,
          lot_id: affectedLots[0]?.lot_id || lotId || null,
          product_id: resolvedProductId,
          branch_id: resolvedBranchId,
          lot_number: affectedLots.map((lot) => lot.lot_number).filter(Boolean).join(', '),
          expiry_date: affectedLots[0]?.expiry_date || null,
          quantity: roundMoney(quantity),
          unit_cost: roundMoney(quantity > 0 ? totalCost / quantity : 0),
          total_cost: totalCost,
          branch_name: branchName,
          nombre_comercial: productLabel,
          remaining_quantity: roundMoney(availableTotal - quantity),
          affected_lots: affectedLots
        };
      });

      return safeJson(res, { ok: true, ...result });
    } catch (err) {
      return safeJson(
        res,
        { ok: false, error: err.message || 'No se pudo registrar la merma' },
        err.statusCode || 500
      );
    }
  })
);

router.get(
  '/expired_writeoffs',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'farmacia', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureInventoryWriteoffsTable(null);

    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '').trim())
      ? String(req.query.from).trim()
      : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '').trim())
      ? String(req.query.to).trim()
      : null;
    const q = String(req.query.q || '').trim();
    const branchId = req.query.branch_id != null && req.query.branch_id !== '' ? Number(req.query.branch_id) : null;
    const format = String(req.query.format || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 5000);

    const hasBranches = await tableExists(null, 'branches');
    const hasUsers = await tableExists(null, 'users');
    const hasProducts = await tableExists(null, 'productos');
    const userCols = hasUsers ? await getColumns(null, 'users') : [];
    const userNameExpr = userCols.includes('username')
      ? 'u.username'
      : userCols.includes('nombre')
      ? 'u.nombre'
      : userCols.includes('name')
      ? 'u.name'
      : "''";

    const params = [];
    const where = [];
    if (from) {
      where.push(`DATE(i.created_at) >= $${params.length + 1}`);
      params.push(from);
    }
    if (to) {
      where.push(`DATE(i.created_at) <= $${params.length + 1}`);
      params.push(to);
    }
    if (branchId && branchId > 0) {
      where.push(`i.branch_id = $${params.length + 1}`);
      params.push(branchId);
    }
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(
        `(
          LOWER(COALESCE(i.product_label, '')) LIKE $${params.length + 1}
          OR LOWER(COALESCE(i.lot_number, '')) LIKE $${params.length + 2}
          OR LOWER(COALESCE(i.notes, '')) LIKE $${params.length + 3}
          ${hasBranches ? `OR LOWER(COALESCE(b.name, '')) LIKE $${params.length + 4}` : ''}
        )`
      );
      params.push(like, like, like);
      if (hasBranches) params.push(like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const branchJoin = hasBranches ? 'LEFT JOIN branches b ON b.id = i.branch_id' : '';
    const userJoin = hasUsers ? 'LEFT JOIN users u ON u.id = i.created_by' : '';
    const productJoin = hasProducts ? 'LEFT JOIN productos p ON p.id = i.product_id' : '';
    const branchSelect = hasBranches ? 'b.name AS branch_name,' : 'NULL AS branch_name,';
    const userSelect = hasUsers ? `COALESCE(${userNameExpr}, '') AS created_by_name,` : "'' AS created_by_name,";
    const productSelect = hasProducts
      ? "COALESCE(i.product_label, p.nombre_comercial, '') AS product_label"
      : "COALESCE(i.product_label, '') AS product_label";

    const summaryRes = await query(
      `SELECT
         COUNT(*) AS total_rows,
         COALESCE(SUM(i.quantity), 0) AS total_quantity,
         COALESCE(SUM(i.total_cost), 0) AS total_cost,
         COUNT(DISTINCT i.product_id) AS unique_products
       FROM inventory_writeoffs i
       ${branchJoin}
       ${whereSql}`,
      params
    );
    const summaryRow = summaryRes.rows[0] || {};
    const summary = {
      total_rows: Number(summaryRow.total_rows || 0),
      total_quantity: roundMoney(summaryRow.total_quantity || 0),
      total_cost: roundMoney(summaryRow.total_cost || 0),
      unique_products: Number(summaryRow.unique_products || 0)
    };

    const detailLimit = format === 'xlsx' ? '' : `LIMIT ${limit}`;
    const rowsRes = await query(
      `SELECT
         i.id,
         i.created_at,
         i.product_id,
         i.branch_id,
         i.lot_id,
         i.lot_number,
         i.expiry_date,
         i.quantity,
         i.unit_cost,
         i.total_cost,
         i.notes,
         i.reason,
         ${branchSelect}
         ${userSelect}
         ${productSelect}
       FROM inventory_writeoffs i
       ${branchJoin}
       ${userJoin}
       ${productJoin}
       ${whereSql}
       ORDER BY i.created_at DESC, i.id DESC
       ${detailLimit}`,
      params
    );
    const rows = (rowsRes.rows || []).map((row) => ({
      ...row,
      id: Number(row.id || 0),
      product_id: Number(row.product_id || 0),
      branch_id: Number(row.branch_id || 0),
      lot_id: Number(row.lot_id || 0),
      quantity: Number(row.quantity || 0),
      unit_cost: roundMoney(row.unit_cost || 0),
      total_cost: roundMoney(row.total_cost || 0),
      expiry_date: normalizeDateOnly(row.expiry_date),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null
    }));

    let branchName = '';
    if (branchId && hasBranches) {
      const branchRes = await query('SELECT name FROM branches WHERE id = $1 LIMIT 1', [branchId]);
      branchName = String(branchRes.rows[0]?.name || '');
    }

    if (format === 'xlsx') {
      const buffer = await buildExpiredWriteoffsWorkbook({
        summary,
        rows,
        filters: { from, to, q, branch_id: branchId, branch_name: branchName }
      });
      const stampParts = [];
      if (from) stampParts.push(from);
      if (to) stampParts.push(to);
      const stamp = stampParts.length ? stampParts.join('_') : new Date().toISOString().slice(0, 10);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="mermas_vencimiento_${stamp.replace(/[^0-9_-]/g, '')}.xlsx"`
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      return res.send(buffer);
    }

    return safeJson(res, {
      ok: true,
      from,
      to,
      q,
      branch_id: branchId,
      summary,
      rows
    });
  })
);

router.get(
  '/branches',
  asyncHandler(async (req, res) => {
    try {
      const includeQuirfano =
        req.query.include_quirfano === '1' || req.query.include_quirfano === 'true';
      if (includeQuirfano) {
        await ensureBranchByName(null, 'Quirófano');
      }
      const st = await query('SELECT id, name, address, created_at FROM branches ORDER BY id');
      let rows = st.rows || [];
      if (!includeQuirfano) {
        rows = rows.filter((row) => !String(row.name || '').toLowerCase().includes('quirófano'));
      }
      const role = getUserRole(req);
      if (role === 'cashier') {
        rows = rows.filter((row) => {
          const name = String(row.name || '').toLowerCase();
          const isHospital = name.includes('hospital');
          const isPrincipal = name.includes('principal');
          const isEmergencia = name.includes('emergencia');
          return isHospital || isPrincipal || isEmergencia;
        });
      } else if (role === 'cashierh') {
        // Hospitalización puede ver inventario de todas las sucursales
        // (Principal, Emergencia y Hospitalización).
      }
      return safeJson(res, rows);
    } catch (_) {
      return safeJson(res, { error: 'Error cargando sucursales' }, 500);
    }
  })
);

router.get(
  '/proveedores',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const exists = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('proveedores','suppliers')"
    );
    const tables = exists.rows.map((r) => r.table_name);
    if (!tables.length) return safeJson(res, { ok: true, proveedores: [] });
    const supplierTable = tables.includes('proveedores') ? 'proveedores' : 'suppliers';
    const cols = await getColumns(null, supplierTable);
    const idCol = cols.includes('id') ? 'id' : cols.includes('supplier_id') ? 'supplier_id' : cols[0];
    const nameCol = cols.includes('nombre')
      ? 'nombre'
      : cols.includes('name')
      ? 'name'
      : cols.includes('razon_social')
      ? 'razon_social'
      : cols[1];

    const rows = [];
    try {
      const prodCols = await getColumns(null, 'productos');
      if (prodCols.includes('casa')) {
        const houseRes = await query(
          "SELECT DISTINCT casa FROM productos WHERE casa IS NOT NULL AND casa <> '' ORDER BY casa ASC"
        );
        for (const casa of houseRes.rows.map((r) => r.casa)) {
          rows.push({ id: casa, nombre: casa });
        }
      }
    } catch (_) {}

    const supplierRows = await query(
      `SELECT ${idCol} AS id, ${nameCol} AS nombre FROM ${supplierTable} ORDER BY ${nameCol} ASC`
    );
    for (const sr of supplierRows.rows) {
      if (!rows.some((r) => String(r.nombre).toLowerCase() === String(sr.nombre).toLowerCase())) {
        rows.push(sr);
      }
    }
    return safeJson(res, { ok: true, proveedores: rows });
  })
);

router.all(
  '/suppliers',
  asyncHandler(async (req, res) => {
    const method = req.method;
    if (method === 'GET') {
      const st = await query('SELECT id, name FROM suppliers ORDER BY name');
      return safeJson(res, st.rows);
    }
    if (method === 'POST') {
      await requireRole('admin')(req, res, async () => {});
      if (res.headersSent) return;
      const data = readJson(req);
      const name = String(data.name || '').trim();
      const contact = String(data.contact_info || '').trim();
      if (!name) return safeJson(res, { error: 'Nombre requerido' }, 400);
      const ins = await query(
        'INSERT INTO suppliers (name, contact_info) VALUES ($1,$2) RETURNING id',
        [name, contact]
      );
      return safeJson(res, { id: Number(ins.rows[0].id), name });
    }
    return safeJson(res, { error: 'Método no permitido' }, 405);
  })
);

router.post(
  '/transfer',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const role = canonRole(roleRaw || 'user');
    const allowedRoles = ['admin', 'farmacia', 'cashier', 'superadmin', 'cashiee', 'cashierh', 'enfermeria'];
    if (!allowedRoles.includes(role)) {
      return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    }

    const input = readJson(req);
    const targetBranchId = Number(input.target_branch_id || 0);
    let sourceBranchId = Number(input.source_branch_id || 0);
    const note = String(input.note || '').trim();
    const requesterName = String(input.requester_name || '').trim();
    const itemsIn = Array.isArray(input.items) ? input.items : [];
    const userId = req.session.user_id || req.session.user.id || null;
    const ehOnlyTransfer = isEmergencyHospitalTransferRole(role);
    let ehBranches = null;

    if (!requesterName) {
      return safeJson(res, { ok: false, error: 'Nombre del solicitante requerido' }, 400);
    }

    if (ehOnlyTransfer) {
      ehBranches = await resolveEmergencyHospitalBranches(null);
      if (!ehBranches.emergency || !ehBranches.hospital) {
        return safeJson(
          res,
          { ok: false, error: 'No se encontraron las sucursales de Emergencia y Hospitalización' },
          400
        );
      }
    }

    if (!sourceBranchId) {
      if (ehOnlyTransfer) {
        if (role === 'cashiee') {
          sourceBranchId = ehBranches.emergency.id;
        } else if (role === 'cashierh') {
          sourceBranchId = ehBranches.hospital.id;
        } else {
          return safeJson(res, { ok: false, error: 'Sucursal de origen requerida' }, 400);
        }
      } else {
        const st = await query("SELECT id FROM branches WHERE LOWER(name) LIKE '%principal%' LIMIT 1");
        sourceBranchId = Number(st.rows[0]?.id || 0);
      }
    }
    if (!sourceBranchId) {
      return safeJson(res, { ok: false, error: 'No se encontró la sucursal de origen' }, 400);
    }
    if (!targetBranchId) {
      return safeJson(res, { ok: false, error: 'Sucursal destino requerida' }, 400);
    }
    if (targetBranchId === sourceBranchId) {
      return safeJson(res, { ok: false, error: 'El destino debe ser diferente al origen' }, 400);
    }
    if (ehOnlyTransfer) {
      const allowedBranchIds = new Set([ehBranches.emergency.id, ehBranches.hospital.id]);
      if (!allowedBranchIds.has(sourceBranchId) || !allowedBranchIds.has(targetBranchId)) {
        return safeJson(
          res,
          { ok: false, error: 'Solo se permiten traslados entre Emergencia y Hospitalización' },
          400
        );
      }
    }

    const items = [];
    for (const row of itemsIn) {
      if (!row || typeof row !== 'object') continue;
      const pid = Number(row.product_id || row.producto_id || 0);
      const qty = Number(row.quantity || row.cantidad || 0);
      if (pid > 0 && qty > 0) items.push({ product_id: pid, quantity: qty });
    }
    if (!items.length) {
      return safeJson(res, { ok: false, error: 'No hay productos para trasladar' }, 400);
    }

    const hasLotsGlobal = await tableExists(null, 'lots');
    let sourceBranchName = 'origen';
    try {
      const branchRes = await query('SELECT name FROM branches WHERE id = $1 LIMIT 1', [sourceBranchId]);
      sourceBranchName = String(branchRes.rows[0]?.name || sourceBranchName);
    } catch (_) {}
    for (const it of items) {
      let available = 0;
      if (hasLotsGlobal) {
        const st = await query(
          'SELECT COALESCE(SUM(quantity),0) AS c FROM lots WHERE product_id = $1 AND branch_id = $2 AND quantity > 0',
          [it.product_id, sourceBranchId]
        );
        available = Number(st.rows[0]?.c || 0);
      } else {
        available = await getBranchStock(null, it.product_id, sourceBranchId);
      }
      if (available < it.quantity) {
        return safeJson(
          res,
          {
            ok: false,
            error: `Stock insuficiente en ${sourceBranchName} para producto ${it.product_id} (disponible ${available})`
          },
          400
        );
      }
    }

    const result = await withTransaction(async (db) => {
      await ensureTransferRequesterColumn(db);
      await ensureTransferCancellationColumns(db);
      const hasTransferLotItems = await ensureTransferLotItemsTable(db);
      const totalItems = items.length;
      const totalQty = items.reduce((sum, it) => sum + it.quantity, 0);
      const tCols = await getColumns(db, 'transfers');
      const cols = ['source_branch_id', 'target_branch_id', 'user_id', 'total_items', 'total_quantity', 'note'];
      const vals = [sourceBranchId, targetBranchId, userId, totalItems, totalQty, note || null];
      if (tCols.includes('requester_name')) {
        cols.push('requester_name');
        vals.push(requesterName);
      }
      if (tCols.includes('status')) {
        cols.push('status');
        vals.push('active');
      }
      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(',');
      const ins = await query(
        `INSERT INTO transfers (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`,
        vals,
        db
      );
      const transferId = Number(ins.rows[0].id);

      const lotMeta = await resolveTransferLotMeta(db);
      const hasLotsTable = !!lotMeta;

      const prodStmt = async (pid) =>
        query('SELECT id, nombre_comercial AS name, precio_costo FROM productos WHERE id = $1', [pid], db);
      const productCache = {};

      for (const it of items) {
        if (!productCache[it.product_id]) {
          const prod = await prodStmt(it.product_id);
          productCache[it.product_id] = prod.rows[0] || {
            name: `Producto ${it.product_id}`,
            precio_costo: 0
          };
        }
        const cost = Number(productCache[it.product_id].precio_costo || 0);
        const sub = cost * it.quantity;

        if (hasLotsTable) {
          const lotsRes = await query(
            `SELECT id, lot_number, expiry_date, quantity, purchase_id, created_at
             FROM lots
             WHERE product_id = $1 AND branch_id = $2 AND quantity > 0
             ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
             FOR UPDATE`,
            [it.product_id, sourceBranchId],
            db
          );
          let remaining = it.quantity;
          let autoIndex = 0;
          for (const lot of lotsRes.rows || []) {
            if (remaining <= 0) break;
            const available = Number(lot.quantity || 0);
            if (available <= 0) continue;
            const take = Math.min(available, remaining);
            autoIndex += 1;
            const lotNumber =
              lot.lot_number || `TR-${transferId}-${it.product_id}-${autoIndex}`;
            await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, lot.id], db);
            logAuditEvent({
              action: 'lot_adjusted',
              branch_id: sourceBranchId || null,
              user_id: userId || null,
              product_id: it.product_id,
              delta: -1 * take
            });
            const fields = ['product_id', 'branch_id', 'lot_number', 'quantity'];
            const values = [it.product_id, targetBranchId, lotNumber, take];
            if (lotMeta && lotMeta.hasInitial) {
              fields.push('initial_quantity');
              values.push(take);
            }
            if (lotMeta && lotMeta.hasPurchaseId) {
              fields.push('purchase_id');
              values.push(lot.purchase_id || null);
            }
            if (lotMeta && lotMeta.hasExpiry) {
              fields.push('expiry_date');
              values.push(lot.expiry_date || null);
            }
            if (lotMeta && lotMeta.hasSalePrice) {
              fields.push('sale_price');
              values.push(lot.sale_price || null);
            }
            if (lotMeta && lotMeta.hasCreated) {
              fields.push('created_at');
              values.push(lot.created_at || new Date());
            }
            const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
            const targetLotIns = await query(
              `INSERT INTO lots (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`,
              values,
              db
            );
            const targetLotId = Number(targetLotIns.rows[0]?.id || 0);
            logAuditEvent({
              action: 'lot_created',
              branch_id: targetBranchId || null,
              user_id: userId || null,
              product_id: it.product_id,
              delta: take
            });
            if (hasTransferLotItems) {
              await query(
                `INSERT INTO transfer_lot_items
                  (transfer_id, product_id, source_lot_id, target_lot_id, lot_number, expiry_date, purchase_id, sale_price, lot_created_at, quantity)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  transferId,
                  it.product_id,
                  lot.id,
                  targetLotId || null,
                  lotNumber,
                  lotMeta && lotMeta.hasExpiry ? lot.expiry_date || null : null,
                  lotMeta && lotMeta.hasPurchaseId ? lot.purchase_id || null : null,
                  lotMeta && lotMeta.hasSalePrice ? lot.sale_price || null : null,
                  lotMeta && lotMeta.hasCreated ? lot.created_at || new Date() : null,
                  take
                ],
                db
              );
            }
            remaining -= take;
          }
          if (remaining > 0) {
            throw new Error(`Stock por lote insuficiente para producto ${it.product_id}`);
          }
        }

        await adjustBranchStock(db, it.product_id, sourceBranchId, -1 * it.quantity);
        await adjustBranchStock(db, it.product_id, targetBranchId, it.quantity);
        logAuditEvent({
          action: 'product_adjusted',
          branch_id: sourceBranchId || null,
          user_id: userId || null,
          product_id: it.product_id,
          delta: -1 * it.quantity
        });
        logAuditEvent({
          action: 'product_adjusted',
          branch_id: targetBranchId || null,
          user_id: userId || null,
          product_id: it.product_id,
          delta: it.quantity
        });

        await query(
          'INSERT INTO transfer_items (transfer_id, product_id, quantity, unit_cost, subtotal) VALUES ($1,$2,$3,$4,$5)',
          [transferId, it.product_id, it.quantity, cost, sub],
          db
        );
      }

      await logAction(db, userId, 'transferencia_creada', {
        transfer_id: transferId,
        src: sourceBranchId,
        dst: targetBranchId
      });

      if (await tableExists(db, 'inventario_movimientos')) {
        for (const it of items) {
          const pid = Number(it.product_id || 0);
          const qty = Number(it.quantity || 0);
          if (!pid || qty <= 0) continue;
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [pid, -1 * qty, 'traslado_salida', String(transferId), `De sucursal ${sourceBranchId} a ${targetBranchId}`],
            db
          );
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [pid, qty, 'traslado_entrada', String(transferId), `De sucursal ${sourceBranchId} a ${targetBranchId}`],
            db
          );
        }
      }

      return { transferId, totalQty, productCache };
    });

    const branchName = async (bid) => {
      const st = await query('SELECT name FROM branches WHERE id = $1', [bid]);
      return st.rows[0]?.name || `Sucursal #${bid}`;
    };

    const receiptItems = [];
    for (const it of items) {
      const prod = result.productCache[it.product_id] || {};
      receiptItems.push({
        product_id: it.product_id,
        name: prod.name || `Producto ${it.product_id}`,
        qty: it.quantity,
        unit_cost: Number(prod.precio_costo || 0),
        subtotal: Number(prod.precio_costo || 0) * it.quantity
      });
    }

    const receipt = {
      transfer_id: result.transferId,
      source: await branchName(sourceBranchId),
      target: await branchName(targetBranchId),
      requester_name: requesterName,
      items: receiptItems,
      total_qty: result.totalQty,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    };

    return safeJson(res, { ok: true, transfer_id: result.transferId, receipt });
  })
);

router.post(
  '/transfer_cancel',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const role = String(roleRaw).toLowerCase();
    const allowedRoles = ['admin', 'administrador', 'farmacia', 'cashier', 'cajero', 'superadmin'];
    if (!allowedRoles.includes(role)) {
      return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    }

    const input = readJson(req);
    const transferId = Number(input.transfer_id || input.id || 0);
    const cancelNote = String(input.note || input.reason || '').trim();
    const userId = req.session.user_id || req.session.user.id || null;
    if (!transferId) {
      return safeJson(res, { ok: false, error: 'transfer_id requerido' }, 400);
    }

    const result = await withTransaction(async (db) => {
      await ensureTransferCancellationColumns(db);
      await ensureTransferLotItemsTable(db);

      const transferRes = await query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId], db);
      const transfer = transferRes.rows[0];
      if (!transfer) {
        const err = new Error('Traslado no encontrado');
        err.statusCode = 404;
        throw err;
      }
      if (normalizeTransferStatus(transfer.status || (transfer.cancelled_at ? 'cancelled' : 'active')) === 'cancelled') {
        const err = new Error('El traslado ya fue anulado');
        err.statusCode = 400;
        throw err;
      }

      const itemsRes = await query(
        'SELECT product_id, quantity FROM transfer_items WHERE transfer_id = $1 ORDER BY id ASC',
        [transferId],
        db
      );
      const items = (itemsRes.rows || []).map((row) => ({
        product_id: Number(row.product_id || 0),
        quantity: Number(row.quantity || 0)
      })).filter((row) => row.product_id > 0 && row.quantity > 0);
      if (!items.length) {
        const err = new Error('El traslado no tiene productos válidos para anular');
        err.statusCode = 400;
        throw err;
      }

      const sourceBranchId = Number(transfer.source_branch_id || 0);
      const targetBranchId = Number(transfer.target_branch_id || 0);
      if (!sourceBranchId || !targetBranchId) {
        const err = new Error('El traslado no tiene sucursales válidas');
        err.statusCode = 400;
        throw err;
      }

      const lotMeta = await resolveTransferLotMeta(db);
      if (lotMeta) {
        const mappedLotsRes = await query(
          'SELECT * FROM transfer_lot_items WHERE transfer_id = $1 ORDER BY id ASC',
          [transferId],
          db
        );
        const mappedLots = mappedLotsRes.rows || [];

        if (mappedLots.length) {
          for (const row of mappedLots) {
            const productId = Number(row.product_id || 0);
            const qty = Number(row.quantity || 0);
            if (!productId || qty <= 0) continue;

            const targetLotRes = await query(
              `SELECT id, lot_number, expiry_date, purchase_id, sale_price, created_at, quantity
                 FROM lots
                WHERE id = $1 AND product_id = $2 AND branch_id = $3
                FOR UPDATE`,
              [row.target_lot_id, productId, targetBranchId],
              db
            );
            const targetLot = targetLotRes.rows[0];
            if (!targetLot) {
              const err = new Error(`No se encontró el lote destino del producto ${productId}. No se puede anular.`);
              err.statusCode = 400;
              throw err;
            }
            if (Number(targetLot.quantity || 0) + 0.0001 < qty) {
              const err = new Error(
                `No hay suficiente stock en la sucursal destino para anular el producto ${productId}. Ya fue usado parcialmente.`
              );
              err.statusCode = 400;
              throw err;
            }
            await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [qty, targetLot.id], db);
            logAuditEvent({
              action: 'lot_adjusted',
              branch_id: targetBranchId || null,
              user_id: userId || null,
              product_id: productId,
              delta: -1 * qty
            });

            const restoreLotData = {
              lot_number: row.lot_number || targetLot.lot_number || null,
              expiry_date: row.expiry_date || targetLot.expiry_date || null,
              purchase_id: row.purchase_id != null ? row.purchase_id : targetLot.purchase_id,
              sale_price: row.sale_price != null ? row.sale_price : targetLot.sale_price,
              lot_created_at: row.lot_created_at || targetLot.created_at || new Date()
            };

            if (row.source_lot_id) {
              const sourceLotRes = await query(
                `SELECT id
                   FROM lots
                  WHERE id = $1 AND product_id = $2 AND branch_id = $3
                  FOR UPDATE`,
                [row.source_lot_id, productId, sourceBranchId],
                db
              );
              const sourceLot = sourceLotRes.rows[0];
              if (sourceLot) {
                await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [qty, sourceLot.id], db);
              } else {
                await upsertLotQuantity(db, lotMeta, sourceBranchId, productId, restoreLotData, qty);
              }
            } else {
              await upsertLotQuantity(db, lotMeta, sourceBranchId, productId, restoreLotData, qty);
            }
            logAuditEvent({
              action: 'lot_adjusted',
              branch_id: sourceBranchId || null,
              user_id: userId || null,
              product_id: productId,
              delta: qty
            });
          }
        } else {
          for (const item of items) {
            let remaining = Number(item.quantity || 0);
            const lotsRes = await query(
              `SELECT id, lot_number, expiry_date, purchase_id, sale_price, created_at, quantity
                 FROM lots
                WHERE product_id = $1 AND branch_id = $2 AND quantity > 0
                ORDER BY id DESC
                FOR UPDATE`,
              [item.product_id, targetBranchId],
              db
            );
            for (const lot of lotsRes.rows || []) {
              if (remaining <= 0) break;
              const available = Number(lot.quantity || 0);
              if (available <= 0) continue;
              const take = Math.min(available, remaining);
              await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, lot.id], db);
              await upsertLotQuantity(
                db,
                lotMeta,
                sourceBranchId,
                item.product_id,
                {
                  lot_number: lot.lot_number || null,
                  expiry_date: lot.expiry_date || null,
                  purchase_id: lot.purchase_id != null ? lot.purchase_id : null,
                  sale_price: lot.sale_price != null ? lot.sale_price : null,
                  lot_created_at: lot.created_at || new Date()
                },
                take
              );
              logAuditEvent({
                action: 'lot_adjusted',
                branch_id: targetBranchId || null,
                user_id: userId || null,
                product_id: item.product_id,
                delta: -1 * take
              });
              logAuditEvent({
                action: 'lot_adjusted',
                branch_id: sourceBranchId || null,
                user_id: userId || null,
                product_id: item.product_id,
                delta: take
              });
              remaining -= take;
            }
            if (remaining > 0.0001) {
              const err = new Error(
                `No hay suficiente stock disponible en la sucursal destino para anular el producto ${item.product_id}.`
              );
              err.statusCode = 400;
              throw err;
            }
          }
        }
      } else {
        for (const item of items) {
          const available = await getBranchStock(db, item.product_id, targetBranchId);
          if (available + 0.0001 < item.quantity) {
            const err = new Error(
              `No hay suficiente stock disponible en la sucursal destino para anular el producto ${item.product_id}.`
            );
            err.statusCode = 400;
            throw err;
          }
        }
      }

      for (const item of items) {
        await adjustBranchStock(db, item.product_id, targetBranchId, -1 * item.quantity);
        await adjustBranchStock(db, item.product_id, sourceBranchId, item.quantity);
      }

      if (await tableExists(db, 'inventario_movimientos')) {
        for (const item of items) {
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [
              item.product_id,
              -1 * item.quantity,
              'anulacion_traslado_salida',
              String(transferId),
              `Anulación traslado #${transferId}: de sucursal ${targetBranchId} a ${sourceBranchId}`
            ],
            db
          );
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [
              item.product_id,
              item.quantity,
              'anulacion_traslado_entrada',
              String(transferId),
              `Anulación traslado #${transferId}: de sucursal ${targetBranchId} a ${sourceBranchId}`
            ],
            db
          );
        }
      }

      await query(
        `UPDATE transfers
            SET status = 'cancelled',
                cancelled_at = NOW(),
                cancelled_by = $1,
                cancel_note = $2
          WHERE id = $3`,
        [userId, cancelNote || null, transferId],
        db
      );

      await logAction(db, userId, 'transferencia_anulada', {
        transfer_id: transferId,
        source_branch_id: sourceBranchId,
        target_branch_id: targetBranchId,
        note: cancelNote || null
      });

      return {
        transferId,
        receipt: await buildTransferReceipt(db, transferId)
      };
    });

    return safeJson(res, { ok: true, transfer_id: result.transferId, receipt: result.receipt });
  })
);

async function buildTransferReceipt(db, transferId) {
  const transfersTable = await pickTable(db, ['transfers'], 'transfers');
  const itemsTable = await pickTable(db, ['transfer_items'], 'transfer_items');
  if (!(await tableExists(db, transfersTable)) || !(await tableExists(db, itemsTable))) return null;
  await ensureTransferCancellationColumns(db);
  const tCols = await getColumns(db, transfersTable);
  const requesterCol = tCols.includes('requester_name') ? 'requester_name' : null;
  const dateCol = tCols.includes('created_at') ? 'created_at' : tCols.includes('fecha') ? 'fecha' : null;

  const tRes = await query(
    `SELECT * FROM ${transfersTable} WHERE id = $1 LIMIT 1`,
    [transferId],
    db
  );
  const tr = tRes.rows[0];
  if (!tr) return null;

  let cancelledBy = null;
  if (tr.cancelled_by) {
    const usr = await query('SELECT username FROM users WHERE id = $1 LIMIT 1', [tr.cancelled_by], db);
    cancelledBy = usr.rows[0]?.username || null;
  }

  const branchName = async (bid) => {
    const st = await query('SELECT name FROM branches WHERE id = $1', [bid], db);
    return st.rows[0]?.name || `Sucursal #${bid}`;
  };

  const itemsRes = await query(
    `SELECT ti.product_id, ti.quantity, ti.unit_cost, ti.subtotal, p.nombre_comercial AS name
     FROM ${itemsTable} ti
     LEFT JOIN productos p ON p.id = ti.product_id
     WHERE ti.transfer_id = $1`,
    [transferId],
    db
  );
  const receiptItems = (itemsRes.rows || []).map((it) => ({
    product_id: it.product_id,
    name: it.name || `Producto ${it.product_id}`,
    qty: Number(it.quantity || 0),
    unit_cost: Number(it.unit_cost || 0),
    subtotal: Number(it.subtotal || 0)
  }));
  const totalQty = receiptItems.reduce((s, it) => s + Number(it.qty || 0), 0);

  return {
    transfer_id: Number(tr.id),
    source: await branchName(tr.source_branch_id),
    target: await branchName(tr.target_branch_id),
    requester_name: requesterCol ? tr[requesterCol] : null,
    items: receiptItems,
    total_qty: totalQty,
    created_at: dateCol && tr[dateCol] ? String(tr[dateCol]) : null,
    status: normalizeTransferStatus(tr.status || (tr.cancelled_at ? 'cancelled' : 'active')),
    cancelled_at: tr.cancelled_at ? String(tr.cancelled_at) : null,
    cancelled_by: cancelledBy,
    cancel_note: tr.cancel_note || null
  };
}

router.get(
  '/transfer_receipt',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'farmacia', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    const lang = getLang(req);
    const id = Number(req.query.id || 0);
    if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
    const receipt = await buildTransferReceipt(null, id);
    if (!receipt) return res.type('text/plain').send('Traslado no encontrado');
    const items = receipt.items || [];
    const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${tTransfer(lang, 'receipt')} #${receipt.transfer_id}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:16px;color:#111;}
    h3{margin:0 0 8px;text-align:center;}
    table{width:100%;border-collapse:collapse;margin-top:10px;}
    th,td{border-bottom:1px solid #eee;padding:6px;text-align:left;font-size:12px;}
    th{text-align:left;background:#f5f5f5;}
    .right{text-align:right;}
    .muted{color:#666;font-size:12px;}
    @media print{button{display:none} body{margin:0}}
  </style>
</head>
<body>
  <h3>${tTransfer(lang, 'receipt')}</h3>
  <div><strong>${tTransfer(lang, 'transfer')} #${receipt.transfer_id}</strong></div>
  <div class="muted">${formatDateLocale(receipt.created_at || '', lang)}</div>
  <div>${tTransfer(lang, 'source')}: ${receipt.source || ''}</div>
  <div>${tTransfer(lang, 'target')}: ${receipt.target || ''}</div>
  <div>${tTransfer(lang, 'requester')}: ${receipt.requester_name || ''}</div>
  <div>${tTransfer(lang, 'status')}: ${formatTransferStatus(lang, receipt.status)}</div>
  ${receipt.status === 'cancelled' && receipt.cancelled_at ? `<div>${tTransfer(lang, 'cancelled_at')}: ${formatDateLocale(receipt.cancelled_at, lang)}</div>` : ''}
  ${receipt.status === 'cancelled' && receipt.cancelled_by ? `<div>${tTransfer(lang, 'cancelled_by')}: ${receipt.cancelled_by}</div>` : ''}
  ${receipt.status === 'cancelled' && receipt.cancel_note ? `<div>${tTransfer(lang, 'cancel_note')}: ${receipt.cancel_note}</div>` : ''}
  <table>
    <thead><tr><th>${tTransfer(lang, 'product')}</th><th class="right">${tTransfer(
      lang,
      'qty'
    )}</th><th class="right">${tTransfer(lang, 'cost')}</th><th class="right">${tTransfer(
      lang,
      'subtotal'
    )}</th></tr></thead>
    <tbody>
      ${items.map(it=>`<tr><td>${it.name || ('Prod '+it.product_id)}</td><td class="right">${it.qty}</td><td class="right">Q${Number(it.unit_cost||0).toFixed(2)}</td><td class="right">Q${Number(it.subtotal||0).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <div class="right" style="margin-top:8px;"><strong>${tTransfer(
    lang,
    'total_units'
  )}: ${receipt.total_qty}</strong></div>
  <div style="margin-top:12px;text-align:right;"><button onclick="window.print()">${tTransfer(
    lang,
    'print'
  )}</button></div>
</body>
</html>`;
    return res.type('text/html').send(html);
  })
);

router.get(
  '/transfer_history',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'farmacia', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    const transfersTable = await pickTable(null, ['transfers'], 'transfers');
    if (!(await tableExists(null, transfersTable))) return safeJson(res, []);
    await ensureTransferCancellationColumns(null);
    const tCols = await getColumns(null, transfersTable);
    const requesterCol = tCols.includes('requester_name') ? 'requester_name' : null;
    const dateCol = tCols.includes('created_at') ? 'created_at' : tCols.includes('fecha') ? 'fecha' : null;
    const dateExpr = dateCol ? `t.${dateCol}` : null;

    const nameFilter = String(req.query.name || '').trim().toLowerCase();
    const startRaw = String(req.query.from || '').trim();
    const endRaw = String(req.query.to || '').trim();
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;

    const where = [];
    const params = [];
    if (requesterCol && nameFilter) {
      where.push(`LOWER(${requesterCol}) LIKE $${params.length + 1}`);
      params.push(`%${nameFilter}%`);
    }
    if (dateExpr && startDate) {
      where.push(`${dateExpr} >= $${params.length + 1}`);
      params.push(startDate);
    }
    if (dateExpr && endDate) {
      where.push(`${dateExpr} < ($${params.length + 1}::date + interval '1 day')`);
      params.push(endDate);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const st = await query(
      `SELECT t.*, bs.name AS source_name, bt.name AS target_name, u.username AS usuario, uc.username AS cancelled_by_username
       FROM ${transfersTable} t
       LEFT JOIN branches bs ON bs.id = t.source_branch_id
       LEFT JOIN branches bt ON bt.id = t.target_branch_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users uc ON uc.id = t.cancelled_by
       ${whereSql}
       ORDER BY ${dateExpr || 't.id'} DESC
       LIMIT 500`,
      params
    );
    return safeJson(res, st.rows || []);
  })
);

router.get(
  '/inventory_movements',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    if (!(await tableExists(null, 'inventario_movimientos'))) {
      return safeJson(res, { ok: true, rows: [] });
    }

    const productId = req.query.product_id != null ? Number(req.query.product_id) : null;
    const typeFilter = req.query.type ? String(req.query.type).trim().toLowerCase() : '';
    const startRaw = String(req.query.from || '').trim();
    const endRaw = String(req.query.to || '').trim();
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);

    const params = [];
    const where = [];
    if (productId && productId > 0) {
      where.push(`m.producto_id = $${params.length + 1}`);
      params.push(productId);
    }
    if (typeFilter) {
      if (typeFilter === 'traslado') {
        where.push(`LOWER(m.tipo) IN ($${params.length + 1}, $${params.length + 2}, $${params.length + 3})`);
        params.push('traslado', 'traslado_salida', 'traslado_entrada');
      } else {
        where.push(`LOWER(m.tipo) = $${params.length + 1}`);
        params.push(typeFilter);
      }
    }
    if (startDate) {
      where.push(`m.fecha >= $${params.length + 1}::date`);
      params.push(startDate);
    }
    if (endDate) {
      where.push(`m.fecha < ($${params.length + 1}::date + interval '1 day')`);
      params.push(endDate);
    }

    let sql =
      'SELECT m.id, m.fecha, m.tipo, m.referencia, m.notas, m.cantidad, m.producto_id, ' +
      'p.nombre_comercial, p.presentacion, p.principio_activo, p.casa ' +
      'FROM inventario_movimientos m ' +
      'LEFT JOIN productos p ON p.id = m.producto_id';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY m.fecha DESC, m.id DESC';
    sql += ` LIMIT ${limit}`;

    const rows = await query(sql, params);
    return safeJson(res, { ok: true, rows: rows.rows || [] });
  })
);

module.exports = router;
