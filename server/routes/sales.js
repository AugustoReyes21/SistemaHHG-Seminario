const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx-js-style');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const {
  query,
  withTransaction,
  tableExists,
  pickTable,
  pickColumn,
  getColumns,
  columnExists,
  quoteIdent
} = require('../db');
const { safeJson, readJson, safeNumber, canonRole } = require('../helpers');
const { requireRole } = require('../auth');
const { sendMail } = require('../email');
const config = require('../config');
const {
  productStocksAvailable,
  adjustBranchStock,
  getBranchStock,
  branchAllowedForRole,
  logAction,
  branchIdByHint
} = require('../functions');
const { autoEntryForSale } = require('../accounting');
const { validateBody, schemas: validationSchemas } = require('../middleware/validate');
const { logAuditEvent } = require('../utils/audit');
const {
  normalizeProductType,
  productTypeUsesInventory,
  productTypeIsCombo,
  ensureProductTypeColumn,
  ensureComboItemsTable,
  ensureLotSaleProductColumn,
  fetchComboComponents,
  fetchProductTypeMap
} = require('../utils/productCatalog');
const { certifySaleIfEnabled, getFelDocument } = require('../utils/fel');
const { idempotency } = require('../middleware/idempotency');
const { conflict, unprocessable } = require('../utils/httpError');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const RETURN_WINDOW_DAYS = 5;

function isReturnSupervisorRole(role) {
  return ['admin', 'superadmin'].includes(canonRole(role || ''));
}

function parseDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function returnWindowStartOfDay(value) {
  const date = parseDateValue(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function diffCalendarDays(startValue, endValue = new Date()) {
  const start = returnWindowStartOfDay(startValue);
  const end = returnWindowStartOfDay(endValue);
  if (!start || !end) return null;
  const diff = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return Math.max(0, diff);
}

function buildApprovalRequiredError(message, reason = 'approval_required') {
  const err = new Error(message);
  err.approval_required = true;
  err.reason = reason;
  return err;
}

function getReturnPermissionContext(userId, options = {}) {
  const actorRole = canonRole(options.actorRole || '');
  const approvedById = Number(options.approvedById || 0) || null;
  const authorizedById = Number(options.authorizedById || approvedById || userId || 0) || null;
  return {
    actorRole,
    approvedById,
    authorizedById,
    canBypassPolicy: approvedById != null
  };
}

function fmtMoney(value) {
  const n = Number(value || 0);
  return n.toFixed(2);
}

function roundDiscountedPayable(value, originalTotal = null) {
  const amount = Number(value || 0);
  const gross = originalTotal != null ? Number(originalTotal || 0) : null;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const whole = Math.floor(amount);
  const cents = Number((amount - whole).toFixed(2));
  let rounded = amount;
  if (cents > 0) {
    rounded = cents <= 0.5 ? whole + 0.5 : whole + 1;
  }
  if (gross != null && Number.isFinite(gross)) {
    rounded = Math.min(gross, rounded);
  }
  return Number(rounded.toFixed(2));
}

function resolvePercentDiscountTotals(grossTotal, discountPercent) {
  const gross = Number(grossTotal || 0);
  const pct = Number(discountPercent || 0);
  if (!Number.isFinite(gross) || gross <= 0) {
    return { discountAmount: 0, saleTotal: 0 };
  }
  if (!Number.isFinite(pct) || pct <= 0) {
    return { discountAmount: 0, saleTotal: Number(gross.toFixed(2)) };
  }
  const rawDiscount = Number((gross * (pct / 100)).toFixed(2));
  const rawNet = Math.max(0, gross - rawDiscount);
  const saleTotal = roundDiscountedPayable(rawNet, gross);
  const discountAmount = Number(Math.max(0, gross - saleTotal).toFixed(2));
  return {
    discountAmount,
    saleTotal
  };
}

async function ensureMovementsProductNullable(db) {
  if (!(await tableExists(db, 'inventario_movimientos'))) return false;
  const cols = await getColumns(db, 'inventario_movimientos');
  if (!cols.includes('producto_id')) return false;
  try {
    await query('ALTER TABLE inventario_movimientos ALTER COLUMN producto_id DROP NOT NULL', [], db);
  } catch (_) {}
  return true;
}

async function validateOpenCajaForSale(db, cajaId, userId, branchId, userRole) {
  const targetCajaId = Number(cajaId || 0);
  if (!targetCajaId) {
    return { ok: false, error: 'No hay caja abierta. Abra la caja antes de registrar una venta.' };
  }
  const cajaTable = await pickTable(db, ['cajas', 'caja', 'cashbox'], 'cajas');
  if (!(await tableExists(db, cajaTable))) {
    return { ok: false, error: 'No existe la tabla de cajas en el sistema.' };
  }
  const cols = await getColumns(db, cajaTable);
  const idCol = cols.includes('id') ? 'id' : cols.includes('caja_id') ? 'caja_id' : null;
  const userCol = cols.includes('user_id') ? 'user_id' : null;
  const branchCol = cols.includes('branch_id') ? 'branch_id' : null;
  const closeCol = cols.includes('fecha_cierre') ? 'fecha_cierre' : cols.includes('closed_at') ? 'closed_at' : null;
  const stateCol = cols.includes('estado') ? 'estado' : cols.includes('status') ? 'status' : null;
  if (!idCol) {
    return { ok: false, error: 'No se pudo validar la caja abierta.' };
  }
  const selectCols = [
    `${quoteIdent(idCol)} AS id`,
    userCol ? `${quoteIdent(userCol)} AS user_id` : 'NULL AS user_id',
    branchCol ? `${quoteIdent(branchCol)} AS branch_id` : 'NULL AS branch_id',
    closeCol ? `${quoteIdent(closeCol)} AS closed_at` : 'NULL AS closed_at',
    stateCol ? `${quoteIdent(stateCol)} AS status` : 'NULL AS status'
  ];
  const cajaRes = await query(
    `SELECT ${selectCols.join(', ')} FROM ${quoteIdent(cajaTable)} WHERE ${quoteIdent(idCol)} = $1 LIMIT 1`,
    [targetCajaId],
    db
  );
  const caja = cajaRes.rows[0];
  if (!caja) {
    return { ok: false, error: 'La caja seleccionada ya no existe.' };
  }
  if (caja.closed_at != null) {
    return { ok: false, error: 'La caja seleccionada ya está cerrada.' };
  }
  const status = String(caja.status || '').trim().toLowerCase();
  if (status && !['abierta', 'open'].includes(status)) {
    return { ok: false, error: 'La caja seleccionada no está abierta.' };
  }
  if (branchId && caja.branch_id != null && Number(caja.branch_id) !== Number(branchId)) {
    return { ok: false, error: 'La caja seleccionada pertenece a otra sucursal.' };
  }
  if (
    userId &&
    caja.user_id != null &&
    Number(caja.user_id) !== Number(userId) &&
    !['admin', 'administrador', 'superadmin'].includes(canonRole(userRole || ''))
  ) {
    return { ok: false, error: 'La caja seleccionada pertenece a otro usuario.' };
  }
  return { ok: true, cajaId: Number(caja.id) };
}

function fmtQty(value) {
  const n = Number(value || 0);
  return Math.abs(n - Math.round(n)) < 0.0001 ? String(Math.round(n)) : n.toFixed(2);
}

function formatDateES(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat('es-GT', {
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

function tReceipt(lang, key) {
  const map = {
    es: {
      invoice: 'Factura',
      invoice_sale: 'Factura de Venta',
      sale_receipt: 'Comprobante de Venta',
      receipt: 'Comprobante',
      date: 'Fecha',
      cashier: 'Cajero',
      seller: 'Vendedor',
      product: 'Producto',
      quantity: 'Cantidad',
      unit_price: 'Precio unit.',
      subtotal: 'Subtotal',
      total: 'Total',
      detail: 'Detalle',
      payments: 'Pagos',
      cash: 'Efectivo',
      received: 'Recibido',
      change: 'Cambio',
      on_behalf_of: 'A nombre de',
      thanks: 'Gracias por su preferencia.',
      total_to_pay: 'Total a pagar',
      discount: 'Descuento',
      note: 'Motivo / Nota',
      billing_data: 'Facturación',
      consumer_final: 'Consumidor final',
      nit: 'NIT',
      cui: 'CUI',
      hospital_services: 'Servicios Hospitalarios',
      cancellations: 'Anulaciones',
      cancelled_services: 'Servicios anulados',
      total_cancelled: 'Total anulado',
      sale_cancelled: 'Venta anulada',
      partial_refund: 'Venta con reintegro parcial',
      refund_cashbox: 'Caja devolución',
      original_cashbox: 'Caja origen',
      requested_by: 'Solicitado por',
      approved_by: 'Autorizado por',
      refund_total: 'Total devuelto',
      refunded_at: 'Fecha devolución'
    },
    en: {
      invoice: 'Invoice',
      invoice_sale: 'Sales Invoice',
      sale_receipt: 'Sales Receipt',
      receipt: 'Receipt',
      date: 'Date',
      cashier: 'Cashier',
      seller: 'Seller',
      product: 'Product',
      quantity: 'Qty',
      unit_price: 'Unit price',
      subtotal: 'Subtotal',
      total: 'Total',
      detail: 'Detail',
      payments: 'Payments',
      cash: 'Cash',
      received: 'Received',
      change: 'Change',
      on_behalf_of: 'On behalf of',
      thanks: 'Thank you for your preference.',
      total_to_pay: 'Total to pay',
      discount: 'Discount',
      note: 'Reason / Note',
      billing_data: 'Billing',
      consumer_final: 'Final consumer',
      nit: 'NIT',
      cui: 'CUI',
      hospital_services: 'Hospital Services',
      cancellations: 'Cancellations',
      cancelled_services: 'Cancelled services',
      total_cancelled: 'Total cancelled',
      sale_cancelled: 'Sale cancelled',
      partial_refund: 'Sale partially refunded',
      refund_cashbox: 'Refund cashbox',
      original_cashbox: 'Original cashbox',
      requested_by: 'Requested by',
      approved_by: 'Approved by',
      refund_total: 'Refunded total',
      refunded_at: 'Refund date'
    }
  };
  const langMap = map[lang] || map.es;
  return langMap[key] || map.es[key] || key;
}

function translatePaymentType(lang, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const v = raw.toLowerCase();
  if (lang === 'en') {
    if (v === 'efectivo' || v === 'cash') return 'Cash';
    if (v === 'tarjeta' || v === 'card') return 'Card';
    if (v === 'mixto' || v === 'mixed') return 'Mixed';
  }
  return raw;
}

function normalizeHash(hash) {
  if (!hash) return '';
  if (hash.startsWith('$2y$')) return `$2b$${hash.slice(4)}`;
  return hash;
}

async function verifyPassword(plain, hash) {
  const normalized = normalizeHash(hash);
  try {
    if (normalized.startsWith('$2')) {
      return await bcrypt.compare(plain, normalized);
    }
  } catch (_) {}
  return plain === hash;
}

async function verifyAdminCredentials(db, username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '').trim();
  if (!user || !pass) return null;
  if (!(await tableExists(db, 'users'))) return null;
  const cols = await getColumns(db, 'users');
  const uCol = cols.includes('username') ? 'username' : null;
  const pCol = cols.includes('password') ? 'password' : null;
  const rCol = cols.includes('rol') ? 'rol' : cols.includes('role') ? 'role' : null;
  if (!uCol || !pCol) return null;
  const st = await query(`SELECT id, ${uCol} AS username, ${pCol} AS password ${rCol ? `, ${rCol} AS role` : ''} FROM users WHERE LOWER(${uCol}) = LOWER($1) LIMIT 1`, [user], db);
  const row = st.rows[0];
  if (!row) return null;
  const ok = await verifyPassword(pass, row.password || '');
  if (!ok) return null;
  const role = canonRole(row.role || '');
  if (!['admin', 'administrador', 'superadmin'].includes(role)) return null;
  return { id: Number(row.id), username: row.username || user, role };
}

const LOT_EXPIRY_ALERT_DAYS = 60;

async function ensureLotSalePriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'sale_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN sale_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'sale_price');
}

async function ensureLotCostPriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'cost_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN cost_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'cost_price');
}

async function ensureSaleReturnTotals(db) {
  const returnsTable = await pickTable(db, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
  if (!(await tableExists(db, returnsTable))) {
    return { table: returnsTable, totalCol: null, serviceCol: null };
  }
  let cols = await getColumns(db, returnsTable);
  let totalCol = cols.includes('total_return') ? 'total_return' : cols.includes('total') ? 'total' : null;
  let serviceCol = cols.includes('service_total') ? 'service_total' : null;

  if (!totalCol) {
    try {
      await query(`ALTER TABLE ${quoteIdent(returnsTable)} ADD COLUMN total_return NUMERIC(12,2)`, [], db);
    } catch (_) {}
    cols = await getColumns(db, returnsTable);
    totalCol = cols.includes('total_return') ? 'total_return' : totalCol;
  }
  if (!serviceCol) {
    try {
      await query(`ALTER TABLE ${quoteIdent(returnsTable)} ADD COLUMN service_total NUMERIC(12,2)`, [], db);
    } catch (_) {}
    cols = await getColumns(db, returnsTable);
    serviceCol = cols.includes('service_total') ? 'service_total' : serviceCol;
  }
  return { table: returnsTable, totalCol, serviceCol };
}

async function ensureSaleReturnItemsDescriptionColumn(db) {
  const table = await pickTable(db, ['sale_return_items'], 'sale_return_items');
  if (!(await tableExists(db, table))) return null;
  if (!(await columnExists(db, table, 'descripcion'))) {
    try {
      await query(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN descripcion TEXT`, [], db);
    } catch (_) {}
  }
  const cols = await getColumns(db, table);
  return cols.includes('descripcion') ? 'descripcion' : null;
}

async function ensureSaleReturnItemsProductNullable(db) {
  const table = await pickTable(db, ['sale_return_items'], 'sale_return_items');
  if (!(await tableExists(db, table))) return false;
  if (!(await columnExists(db, table, 'product_id'))) return false;
  try {
    await query(`ALTER TABLE ${quoteIdent(table)} ALTER COLUMN product_id DROP NOT NULL`, [], db);
  } catch (_) {}
  return true;
}

async function ensureSaleReturnItemsTable(db) {
  const table = await pickTable(db, ['sale_return_items'], 'sale_return_items');
  if (await tableExists(db, table)) return true;
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        return_id BIGINT NOT NULL,
        product_id BIGINT NULL,
        quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
        unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
        subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
        descripcion TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`,
      [],
      db
    );
  } catch (_) {}
  return await tableExists(db, table);
}

async function ensureSaleReturnsManualTable(db) {
  if (await tableExists(db, 'sale_returns_manual')) return true;
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS sale_returns_manual (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        amount NUMERIC(12,2) NOT NULL,
        motive TEXT NOT NULL,
        caja_id BIGINT NULL,
        admin_id BIGINT NULL,
        user_id BIGINT NULL,
        branch_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_sale_returns_manual_admin FOREIGN KEY (admin_id) REFERENCES users(id),
        CONSTRAINT fk_sale_returns_manual_user FOREIGN KEY (user_id) REFERENCES users(id),
        CONSTRAINT fk_sale_returns_manual_branch FOREIGN KEY (branch_id) REFERENCES branches(id)
      )`
    );
  } catch (_) {}
  return await tableExists(db, 'sale_returns_manual');
}

async function ensureSaleReturnAuditColumns(db, tableName) {
  if (!tableName || !(await tableExists(db, tableName))) {
    return { saleDateCol: null, saleCajaCol: null, authorizedByCol: null };
  }
  const defs = [
    ['sale_date', 'TIMESTAMP NULL'],
    ['sale_caja_id', 'BIGINT NULL'],
    ['authorized_by_id', 'BIGINT NULL']
  ];
  for (const [col, def] of defs) {
    if (!(await columnExists(db, tableName, col))) {
      try {
        await query(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(col)} ${def}`, [], db);
      } catch (_) {}
    }
  }
  const cols = await getColumns(db, tableName);
  return {
    saleDateCol: cols.includes('sale_date') ? 'sale_date' : null,
    saleCajaCol: cols.includes('sale_caja_id') ? 'sale_caja_id' : null,
    authorizedByCol: cols.includes('authorized_by_id') ? 'authorized_by_id' : null
  };
}

async function ensureSaleReturnsCajaColumn(db, tableName) {
  if (!tableName || !(await tableExists(db, tableName))) return false;
  if (!(await columnExists(db, tableName, 'caja_id'))) {
    try {
      await query(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN caja_id BIGINT NULL`, [], db);
    } catch (_) {}
  }
  return await columnExists(db, tableName, 'caja_id');
}

async function ensureSaleReturnsManualCajaColumn(db) {
  if (!(await tableExists(db, 'sale_returns_manual'))) return false;
  if (!(await columnExists(db, 'sale_returns_manual', 'caja_id'))) {
    try {
      await query('ALTER TABLE sale_returns_manual ADD COLUMN caja_id BIGINT NULL', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'sale_returns_manual', 'caja_id');
}

async function ensureSaleReturnsManualAuditColumns(db) {
  if (!(await tableExists(db, 'sale_returns_manual'))) {
    return { hasAdminId: false, hasUserId: false, hasBranchId: false, hasCajaId: false };
  }
  const defs = [
    ['admin_id', 'BIGINT NULL'],
    ['user_id', 'BIGINT NULL'],
    ['branch_id', 'BIGINT NULL'],
    ['caja_id', 'BIGINT NULL']
  ];
  for (const [col, def] of defs) {
    if (!(await columnExists(db, 'sale_returns_manual', col))) {
      try {
        await query(`ALTER TABLE sale_returns_manual ADD COLUMN ${quoteIdent(col)} ${def}`, [], db);
      } catch (_) {}
    }
  }
  const cols = await getColumns(db, 'sale_returns_manual');
  return {
    hasAdminId: cols.includes('admin_id'),
    hasUserId: cols.includes('user_id'),
    hasBranchId: cols.includes('branch_id'),
    hasCajaId: cols.includes('caja_id')
  };
}

async function loadCashboxLabels(db, ids) {
  const uniqueIds = [...new Set((ids || []).map((id) => Number(id || 0)).filter((id) => id > 0))];
  const labels = {};
  if (!uniqueIds.length) return labels;

  const branchNames = {};
  const branchesTable = await pickTable(db, ['branches', 'sucursales'], 'branches');
  if (await tableExists(db, branchesTable)) {
    const branchCols = await getColumns(db, branchesTable);
    const branchIdCol = branchCols.includes('id') ? 'id' : branchCols.includes('branch_id') ? 'branch_id' : null;
    const branchNameCol = branchCols.includes('name') ? 'name' : branchCols.includes('nombre') ? 'nombre' : null;
    if (branchIdCol && branchNameCol) {
      const bq = await query(
        `SELECT ${quoteIdent(branchIdCol)} AS id, ${quoteIdent(branchNameCol)} AS name FROM ${quoteIdent(branchesTable)}`
      );
      for (const b of bq.rows || []) {
        branchNames[Number(b.id)] = String(b.name || '').trim();
      }
    }
  }

  const cajaTable = await pickTable(db, ['cajas', 'caja', 'cashbox'], 'cajas');
  if (!(await tableExists(db, cajaTable))) {
    for (const id of uniqueIds) labels[id] = `Caja #${id}`;
    return labels;
  }

  const cajaCols = await getColumns(db, cajaTable);
  const cajaIdCol = cajaCols.includes('id') ? 'id' : cajaCols.includes('caja_id') ? 'caja_id' : null;
  const cajaBranchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;
  if (!cajaIdCol) {
    for (const id of uniqueIds) labels[id] = `Caja #${id}`;
    return labels;
  }

  const cq = await query(
    `SELECT ${quoteIdent(cajaIdCol)} AS id ${cajaBranchCol ? `, ${quoteIdent(cajaBranchCol)} AS branch_id` : ''}
     FROM ${quoteIdent(cajaTable)}
     WHERE ${quoteIdent(cajaIdCol)} = ANY($1)`,
    [uniqueIds],
    db
  );
  for (const row of cq.rows || []) {
    const id = Number(row.id || 0);
    if (!id) continue;
    const branchName =
      row.branch_id && branchNames[Number(row.branch_id)] ? branchNames[Number(row.branch_id)] : '';
    labels[id] = branchName ? `Caja #${id} - ${branchName}` : `Caja #${id}`;
  }
  for (const id of uniqueIds) {
    if (!labels[id]) labels[id] = `Caja #${id}`;
  }
  return labels;
}

async function fetchSaleReturnSummary(db, saleId) {
  const normalizedSaleId = Number(saleId || 0);
  if (!normalizedSaleId) {
    return { total: 0, events: [] };
  }

  const returnsMeta = await ensureSaleReturnTotals(db);
  const returnsTable = returnsMeta.table || 'sale_returns';
  if (!(await tableExists(db, returnsTable))) {
    return { total: 0, events: [] };
  }

  const returnCols = await getColumns(db, returnsTable);
  const createdCol = returnCols.includes('created_at') ? 'created_at' : returnCols.includes('fecha') ? 'fecha' : null;
  const motiveCol = returnCols.includes('motive') ? 'motive' : returnCols.includes('motivo') ? 'motivo' : null;
  const userCol = returnCols.includes('user_id') ? 'user_id' : null;
  const refundCajaCol = returnCols.includes('caja_id') ? 'caja_id' : null;
  const saleCajaCol = returnCols.includes('sale_caja_id') ? 'sale_caja_id' : null;
  const authCol = returnCols.includes('authorized_by_id') ? 'authorized_by_id' : null;
  const totalCol = returnsMeta.totalCol || (returnCols.includes('total') ? 'total' : null);

  const retRes = await query(
    `SELECT id ${createdCol ? `, ${quoteIdent(createdCol)} AS created_at` : ', NULL AS created_at'} ${
      motiveCol ? `, ${quoteIdent(motiveCol)} AS motive` : ', NULL AS motive'
    } ${userCol ? `, ${quoteIdent(userCol)} AS user_id` : ', NULL AS user_id'} ${
      refundCajaCol ? `, ${quoteIdent(refundCajaCol)} AS refund_caja_id` : ', NULL AS refund_caja_id'
    } ${saleCajaCol ? `, ${quoteIdent(saleCajaCol)} AS sale_caja_id` : ', NULL AS sale_caja_id'} ${
      authCol ? `, ${quoteIdent(authCol)} AS authorized_by_id` : ', NULL AS authorized_by_id'
    } ${totalCol ? `, ${quoteIdent(totalCol)} AS total_return` : ', NULL AS total_return'}
     FROM ${quoteIdent(returnsTable)}
     WHERE sale_id = $1
     ORDER BY ${createdCol ? quoteIdent(createdCol) : 'id'} DESC, id DESC`,
    [normalizedSaleId],
    db
  );
  const rows = retRes.rows || [];
  if (!rows.length) {
    return { total: 0, events: [] };
  }

  const totalsByReturn = {};
  const returnItemsTable = await pickTable(db, ['sale_return_items'], 'sale_return_items');
  if ((!totalCol || rows.some((row) => row.total_return == null)) && (await tableExists(db, returnItemsTable))) {
    const riSubCol = await pickColumn(db, returnItemsTable, ['subtotal', 'total', 'importe'], 'subtotal');
    const riReturnCol = await pickColumn(db, returnItemsTable, ['return_id'], 'return_id');
    if (riSubCol && riReturnCol) {
      const returnIds = rows.map((row) => Number(row.id || 0)).filter(Boolean);
      if (returnIds.length) {
        const sumRes = await query(
          `SELECT ${quoteIdent(riReturnCol)} AS return_id, COALESCE(SUM(${quoteIdent(riSubCol)}),0) AS total
           FROM ${quoteIdent(returnItemsTable)}
           WHERE ${quoteIdent(riReturnCol)} = ANY($1)
           GROUP BY ${quoteIdent(riReturnCol)}`,
          [returnIds],
          db
        );
        for (const sum of sumRes.rows || []) {
          totalsByReturn[Number(sum.return_id)] = Number(sum.total || 0);
        }
      }
    }
  }

  const userIds = new Set();
  const cajaIds = new Set();
  for (const row of rows) {
    if (row.user_id) userIds.add(Number(row.user_id));
    if (row.authorized_by_id) userIds.add(Number(row.authorized_by_id));
    if (row.refund_caja_id) cajaIds.add(Number(row.refund_caja_id));
    if (row.sale_caja_id) cajaIds.add(Number(row.sale_caja_id));
  }

  const usernames = {};
  const usersTable = await pickTable(db, ['users', 'usuarios'], 'users');
  const userNameCol =
    usersTable && (await tableExists(db, usersTable))
      ? await pickColumn(db, usersTable, ['username', 'nombre', 'name', 'usuario'], 'username')
      : null;
  if (userIds.size && usersTable && userNameCol && (await tableExists(db, usersTable))) {
    const us = await query(
      `SELECT id, ${quoteIdent(userNameCol)} AS username FROM ${quoteIdent(usersTable)} WHERE id = ANY($1)`,
      [[...userIds]],
      db
    );
    for (const u of us.rows || []) {
      usernames[Number(u.id)] = String(u.username || '').trim();
    }
  }

  const cajaLabels = await loadCashboxLabels(db, [...cajaIds]);
  const events = rows.map((row) => {
    const eventTotal =
      row.total_return != null ? Number(row.total_return || 0) : Number(totalsByReturn[Number(row.id)] || 0);
    const refundCajaId = row.refund_caja_id != null ? Number(row.refund_caja_id) : null;
    const sourceCajaId = row.sale_caja_id != null ? Number(row.sale_caja_id) : null;
    return {
      id: Number(row.id || 0),
      created_at: row.created_at || null,
      motive: row.motive ? String(row.motive) : '',
      total: eventTotal,
      refund_caja_id: refundCajaId,
      refund_caja_label: refundCajaId ? cajaLabels[refundCajaId] || `Caja #${refundCajaId}` : '',
      sale_caja_id: sourceCajaId,
      sale_caja_label: sourceCajaId ? cajaLabels[sourceCajaId] || `Caja #${sourceCajaId}` : '',
      user_name: row.user_id ? usernames[Number(row.user_id)] || '' : '',
      authorized_by_name: row.authorized_by_id ? usernames[Number(row.authorized_by_id)] || '' : ''
    };
  });

  return {
    total: Number(events.reduce((sum, event) => sum + Number(event.total || 0), 0).toFixed(2)),
    events
  };
}

async function resolveSaleReturnContext(db, saleId) {
  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
  const saleBranchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);
  const saleDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], null);
  const saleCajaCol = await pickColumn(db, salesTable, ['caja_id', 'cashbox_id', 'id_caja'], null);

  const saleRes = await query(
    `SELECT * FROM ${quoteIdent(salesTable)} WHERE ${quoteIdent(saleIdCol)} = $1 LIMIT 1`,
    [saleId],
    db
  );
  const sale = saleRes.rows[0];
  if (!sale) throw new Error('Venta no encontrada');

  return {
    salesTable,
    sale,
    saleIdCol,
    saleBranchCol,
    saleDateCol,
    saleCajaCol,
    branchId:
      saleBranchCol && sale[saleBranchCol] != null ? Number(sale[saleBranchCol]) : null,
    saleDate: saleDateCol ? parseDateValue(sale[saleDateCol]) : null,
    saleCajaId:
      saleCajaCol && sale[saleCajaCol] != null ? Number(sale[saleCajaCol]) : null
  };
}

function enforceReturnWindowPolicy(saleDate, permissionCtx) {
  const parsed = parseDateValue(saleDate);
  const daysSinceSale = parsed ? diffCalendarDays(parsed, new Date()) : null;
  const withinWindow = daysSinceSale != null && daysSinceSale <= RETURN_WINDOW_DAYS;

  if (!withinWindow && !permissionCtx.canBypassPolicy) {
    if (parsed) {
      throw buildApprovalRequiredError(
        `La venta supera el límite de ${RETURN_WINDOW_DAYS} días calendario. Requiere aprobación de admin o superadmin.`,
        'return_outside_window'
      );
    }
    throw buildApprovalRequiredError(
      'No se pudo validar la fecha de la venta. Requiere aprobación de admin o superadmin.',
      'return_missing_sale_date'
    );
  }

  return { saleDate: parsed, daysSinceSale, withinWindow };
}

function enforceReturnCajaPolicy(selectedCajaId, saleCajaId, permissionCtx) {
  const targetCajaId = Number(selectedCajaId || 0) || null;
  const originCajaId = Number(saleCajaId || 0) || null;
  const sameCaja = !targetCajaId || !originCajaId || targetCajaId === originCajaId;
  if (!sameCaja && !permissionCtx.canBypassPolicy) {
    throw buildApprovalRequiredError(
      'La devolución se está registrando en una caja distinta a la caja original de la venta. Requiere aprobación de admin o superadmin.',
      'different_cashbox_requires_approval'
    );
  }
  return { sameCaja };
}

async function ensureReturnApprovalTable(db) {
  if (await tableExists(db, 'return_approval_requests')) return true;
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS return_approval_requests (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        token VARCHAR(80) NOT NULL,
        type VARCHAR(20) NOT NULL,
        payload TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_by BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        approved_by BIGINT NULL,
        approved_at TIMESTAMP NULL,
        approved_ip VARCHAR(60) NULL
      )`
    );
    await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_return_approval_token ON return_approval_requests(token)');
  } catch (_) {}
  return await tableExists(db, 'return_approval_requests');
}

async function fetchAdminEmails(db) {
  if (!(await tableExists(db, 'users'))) return [];
  const cols = await getColumns(db, 'users');
  const roleCol = cols.includes('rol') ? 'rol' : cols.includes('role') ? 'role' : null;
  const emailCol = cols.includes('email') ? 'email' : null;
  if (!roleCol || !emailCol) return [];
  const st = await query(`SELECT ${emailCol} AS email FROM users WHERE ${roleCol} ILIKE ANY($1)`, [[
    '%admin%','%administrador%','%superadmin%'
  ]], db);
  return (st.rows || []).map(r => String(r.email || '').trim()).filter(Boolean);
}

function buildApprovalLink(req, token) {
  const base = process.env.APP_URL || config.appUrl || '';
  const host = req.headers.host ? `http://${req.headers.host}` : '';
  const root = base || host;
  return `${root}/Pos/merged/aprobar_devoluciones.html?token=${encodeURIComponent(token)}`;
}

async function createApprovalRequest(db, type, payload, requestedBy, req) {
  await ensureReturnApprovalTable(db);
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await query(
    `INSERT INTO return_approval_requests (token, type, payload, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [token, type, JSON.stringify(payload), requestedBy || null, expiresAt],
    db
  );
  const emails = await fetchAdminEmails(db);
  if (emails.length) {
    let cashierName = 'No identificado';
    if (requestedBy && (await tableExists(db, 'users'))) {
      try {
        const userRes = await query('SELECT username FROM users WHERE id = $1 LIMIT 1', [requestedBy], db);
        cashierName = String(userRes.rows[0]?.username || '').trim() || cashierName;
      } catch (_) {}
    }
    const subject = 'Solicitud de anulacion o reintegro';
    const body = `El Cajero: ${cashierName}, esta solicitando hacer una Anulacion o Reintegro, contactate con Cajero para completar la autorizacion.`;
    try { await sendMail({ to: emails.join(','), subject, text: body }); } catch (_) {}
  }
  return token;
}

async function approveReturnRequest(db, token, adminUserId, adminPassword, req) {
  await ensureReturnApprovalTable(db);
  const st = await query(
    'SELECT * FROM return_approval_requests WHERE token = $1 LIMIT 1',
    [token],
    db
  );
  const row = st.rows[0];
  if (!row) throw new Error('Solicitud no encontrada');
  if (row.status !== 'pending') throw new Error('Solicitud ya procesada');
  const exp = row.expires_at ? new Date(row.expires_at) : null;
  if (exp && exp.getTime() < Date.now()) throw new Error('Solicitud expirada');

  const ucols = await getColumns(db, 'users');
  const passCol = ucols.includes('password') ? 'password' : null;
  const roleCol = ucols.includes('rol') ? 'rol' : ucols.includes('role') ? 'role' : null;
  if (!passCol || !roleCol) throw new Error('No se puede validar admin');
  const userRes = await query(`SELECT id, ${passCol} AS password, ${roleCol} AS role FROM users WHERE id = $1`, [adminUserId], db);
  const u = userRes.rows[0];
  if (!u) throw new Error('Admin inválido');
  const role = canonRole(u.role || '');
  if (!['admin','administrador','superadmin'].includes(role)) throw new Error('No autorizado');
  const ok = await verifyPassword(adminPassword, u.password || '');
  if (!ok) throw new Error('Contraseña incorrecta');

  await query(
    'UPDATE return_approval_requests SET status = $1, approved_by = $2, approved_at = NOW(), approved_ip = $3 WHERE id = $4',
    ['approved', adminUserId, req.ip || null, row.id],
    db
  );
  return row;
}

async function performReturnSale(input, userId, options = {}) {
  const saleId = Number(input.sale_id || input.venta_id || 0);
  const motive = String(input.motive || '').trim();
  const cajaId = input.caja_id != null && input.caja_id !== '' ? Number(input.caja_id) : null;
  let branchId = input.branch_id != null && input.branch_id !== '' ? Number(input.branch_id) : null;
  const permissionCtx = getReturnPermissionContext(userId, options);

  if (!saleId) throw new Error('sale_id requerido');
  if (!motive) throw new Error('Motivo requerido');
  if (!cajaId) throw new Error('Seleccione la caja a la que se aplicará la devolución');

  const result = await withTransaction(async (db) => {
    const saleContext = await resolveSaleReturnContext(db, saleId);
    const sale = saleContext.sale;
    const policy = enforceReturnWindowPolicy(saleContext.saleDate, permissionCtx);

    if (!branchId && saleContext.branchId != null) {
      branchId = saleContext.branchId;
    }

    const cajaCheck = await validateOpenCajaForSale(
      db,
      cajaId,
      userId,
      branchId,
      permissionCtx.actorRole
    );
    if (!cajaCheck.ok) throw new Error(cajaCheck.error || 'La caja seleccionada no es válida');
    enforceReturnCajaPolicy(cajaId, saleContext.saleCajaId, permissionCtx);

    const existingReturns = await fetchSaleReturnSummary(db, saleId);
    if (Array.isArray(existingReturns.events) && existingReturns.events.length) {
      throw new Error(
        'La venta ya tiene una anulación o devolución registrada. Solo se permite anular el comprobante completo una vez.'
      );
    }

    const saleItemsTable = await pickTable(db, ['venta_items', 'sale_items', 'detalle_venta', 'detalle_ventas'], 'venta_items');
    const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
    const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
    const hasInventoryMovements = await tableExists(db, 'inventario_movimientos');

    const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
    const siProdIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
    const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], 'cantidad');
    const siUnitCol = await pickColumn(db, saleItemsTable, ['precio_unit', 'precio_unitario', 'unit_price'], null);
    const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], null);
    const saleTotalCol = await pickColumn(
      db,
      saleContext.salesTable,
      ['total', 'monto_total', 'importe_total', 'amount_total'],
      null
    );
    const saleTotalValue =
      saleTotalCol && sale[saleTotalCol] != null ? Number(sale[saleTotalCol] || 0) : 0;

    const itemsOriginal = {};
    if (saleItemsTable && (await tableExists(db, saleItemsTable))) {
      const sel = [
        `${siProdIdCol} AS pid`,
        `${siQtyCol} AS qty`,
        siUnitCol ? `${siUnitCol} AS unit_price` : null,
        siSubCol ? `${siSubCol} AS subtotal` : null
      ]
        .filter(Boolean)
        .join(',');
      const stItems = await query(
        `SELECT ${sel} FROM ${saleItemsTable} WHERE ${siSaleIdCol} = $1`,
        [saleId],
        db
      );
      for (const r of stItems.rows) {
        const pid = Number(r.pid || 0);
        const qty = Number(r.qty || 0);
        if (!pid || qty <= 0) continue;
        let unit = r.unit_price != null ? Number(r.unit_price) : null;
        const subtotal = r.subtotal != null ? Number(r.subtotal) : null;
        if ((unit == null || unit <= 0) && subtotal != null && qty > 0) {
          unit = subtotal / qty;
        }
        const current = itemsOriginal[pid] || { qty: 0, unit_price: 0, subtotal: 0 };
        current.qty += qty;
        current.subtotal += subtotal != null ? subtotal : (unit || 0) * qty;
        current.unit_price = current.qty > 0 ? current.subtotal / current.qty : unit || 0;
        itemsOriginal[pid] = current;
      }
    }

    let salePayments = [];
    if (paymentsTable && (await tableExists(db, paymentsTable))) {
      const paySaleIdCol = await pickColumn(db, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
      const payDetCol = await pickColumn(
        db,
        paymentsTable,
        ['payment_method_details', 'metodo_detalle', 'method_details', 'detalles', 'meta'],
        'payment_method_details'
      );
      const payTypeCol = await pickColumn(db, paymentsTable, ['payment_type', 'tipo_pago', 'forma', 'metodo'], null);
      const payAmountCol = await pickColumn(db, paymentsTable, ['amount', 'monto', 'importe', 'total'], null);
      const payFields = [
        payTypeCol ? `${quoteIdent(payTypeCol)} AS payment_type` : 'NULL AS payment_type',
        payAmountCol ? `${quoteIdent(payAmountCol)} AS amount` : 'NULL AS amount',
        payDetCol ? `${quoteIdent(payDetCol)} AS payment_method_details` : 'NULL AS payment_method_details'
      ];
      const payRes = await query(
        `SELECT ${payFields.join(', ')} FROM ${quoteIdent(paymentsTable)} WHERE ${quoteIdent(paySaleIdCol)} = $1`,
        [saleId],
        db
      );
      salePayments = payRes.rows || [];
    }

    const returnItems = [];
    const serviceLines = collectServiceLines(salePayments).map((sv) => ({
      descripcion: String(sv.producto || sv.descripcion || 'Servicio').trim() || 'Servicio',
      subtotal: Number(sv.subtotal != null ? sv.subtotal : sv.precio_unit != null ? sv.precio_unit : 0) || 0
    }));
    const productLines = Object.keys(itemsOriginal).map((pid) => ({
      product_id: Number(pid),
      quantity: Number(itemsOriginal[pid].qty || 0),
      unit_price: Number(itemsOriginal[pid].unit_price || 0),
      subtotal: Number(itemsOriginal[pid].subtotal || 0)
    }));
    const grossReturn = Number(
      (
        productLines.reduce((sum, row) => sum + Number(row.subtotal || 0), 0) +
        serviceLines.reduce((sum, row) => sum + Number(row.subtotal || 0), 0)
      ).toFixed(2)
    );
    const baseReturnTotal = saleTotalValue > 0 ? saleTotalValue : grossReturn;

    if (!productLines.length && !serviceLines.length && baseReturnTotal <= 0) {
      throw new Error('La venta no tiene datos válidos para anularse por completo');
    }

    const ratio =
      grossReturn > 0 && baseReturnTotal > 0
        ? Math.max(0, Math.min(1, Number((baseReturnTotal / grossReturn).toFixed(6))))
        : 1;

    for (const row of productLines) {
      const qty = Number(row.quantity || 0);
      const originalSubtotal = Number(row.subtotal || 0);
      if (!row.product_id || qty <= 0 || originalSubtotal <= 0) continue;
      const adjustedSubtotal = Number((originalSubtotal * ratio).toFixed(2));
      returnItems.push({
        product_id: row.product_id,
        quantity: qty,
        unit_price: qty > 0 ? Number((adjustedSubtotal / qty).toFixed(2)) : 0,
        subtotal: adjustedSubtotal
      });
    }
    for (const row of serviceLines) {
      const originalSubtotal = Number(row.subtotal || 0);
      if (originalSubtotal <= 0) continue;
      const adjustedSubtotal = Number((originalSubtotal * ratio).toFixed(2));
      returnItems.push({
        product_id: null,
        quantity: 0,
        unit_price: 0,
        subtotal: adjustedSubtotal,
        is_service: true,
        descripcion: row.descripcion || 'Servicio'
      });
    }

    if (!returnItems.length && baseReturnTotal > 0) {
      returnItems.push({
        product_id: null,
        quantity: 0,
        unit_price: 0,
        subtotal: Number(baseReturnTotal.toFixed(2)),
        is_service: true,
        descripcion: 'Comprobante completo'
      });
    }

    let totalReturn = Number(returnItems.reduce((sum, row) => sum + Number(row.subtotal || 0), 0).toFixed(2));
    if (baseReturnTotal > 0 && returnItems.length) {
      const diff = Number((baseReturnTotal - totalReturn).toFixed(2));
      if (Math.abs(diff) >= 0.01) {
        const lastRow = returnItems[returnItems.length - 1];
        lastRow.subtotal = Number((Number(lastRow.subtotal || 0) + diff).toFixed(2));
        if (!lastRow.is_service && Number(lastRow.quantity || 0) > 0) {
          lastRow.unit_price = Number((lastRow.subtotal / Number(lastRow.quantity || 1)).toFixed(2));
        }
        totalReturn = Number((totalReturn + diff).toFixed(2));
      }
    }
    const serviceRefundTotal = Number(
      returnItems
        .filter((row) => row.is_service)
        .reduce((sum, row) => sum + Number(row.subtotal || 0), 0)
        .toFixed(2)
    );

    if (totalReturn <= 0) throw new Error('Total de devolución inválido');

    const returnsMeta = await ensureSaleReturnTotals(db);
    const returnsTable = returnsMeta.table || 'sale_returns';
    const auditCols = await ensureSaleReturnAuditColumns(db, returnsTable);
    const insertCols = ['sale_id', 'user_id', 'branch_id', 'motive'];
    const insertVals = [saleId, userId, branchId, motive];
    if (cajaId) {
      if (await ensureSaleReturnsCajaColumn(db, returnsTable)) {
        insertCols.push('caja_id');
        insertVals.push(cajaId);
      }
    }
    if (auditCols.saleDateCol) {
      insertCols.push(auditCols.saleDateCol);
      insertVals.push(policy.saleDate);
    }
    if (auditCols.saleCajaCol) {
      insertCols.push(auditCols.saleCajaCol);
      insertVals.push(saleContext.saleCajaId);
    }
    if (auditCols.authorizedByCol) {
      insertCols.push(auditCols.authorizedByCol);
      insertVals.push(permissionCtx.authorizedById);
    }
    const placeholders = insertVals.map((_, idx) => `$${idx + 1}`).join(',');
    const returnRes = await query(
      `INSERT INTO ${quoteIdent(returnsTable)} (${insertCols.map(quoteIdent).join(',')}) VALUES (${placeholders}) RETURNING id`,
      insertVals,
      db
    );
    const returnId = Number(returnRes.rows[0].id);
    if (returnsMeta.totalCol || returnsMeta.serviceCol) {
      const sets = [];
      const vals = [];
      if (returnsMeta.totalCol) {
        sets.push(`${quoteIdent(returnsMeta.totalCol)} = $${vals.length + 1}`);
        vals.push(totalReturn);
      }
      if (returnsMeta.serviceCol) {
        sets.push(`${quoteIdent(returnsMeta.serviceCol)} = $${vals.length + 1}`);
        vals.push(serviceRefundTotal);
      }
      if (sets.length) {
        vals.push(returnId);
        await query(
          `UPDATE ${quoteIdent(returnsTable)} SET ${sets.join(', ')} WHERE id = $${vals.length}`,
          vals,
          db
        );
      }
    }

    await ensureSaleReturnItemsTable(db);
    const returnItemsDescCol = await ensureSaleReturnItemsDescriptionColumn(db);
    await ensureSaleReturnItemsProductNullable(db);
    await ensureProductTypeColumn(db);
    const returnProductTypeMap = await fetchProductTypeMap(
      db,
      returnItems.map((row) => Number(row.product_id || 0)).filter(Boolean)
    );
    if (returnItems.length) {
      for (const row of returnItems) {
        if (row.product_id) {
          await query(
            'INSERT INTO sale_return_items (return_id, product_id, quantity, unit_price, subtotal) VALUES ($1,$2,$3,$4,$5)',
            [returnId, row.product_id, row.quantity, row.unit_price, row.subtotal],
            db
          );
          const soldProductType = normalizeProductType(returnProductTypeMap.get(Number(row.product_id || 0)));
          const restoredProducts = await restoreLotsForReturn(db, saleId, row.product_id, userId);
          if (branchId && productTypeUsesInventory(soldProductType)) {
            await adjustBranchStock(db, row.product_id, branchId, row.quantity);
          } else if (branchId) {
            for (const [inventoryProductId, restoredQty] of restoredProducts.entries()) {
              await adjustBranchStock(db, inventoryProductId, branchId, restoredQty);
            }
          } else if (productTypeUsesInventory(soldProductType)) {
            const stockCol = await pickColumn(db, productsTable, ['stock', 'existencias', 'cantidad'], 'stock');
            const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
            await query(
              `UPDATE ${productsTable} SET ${stockCol} = ${stockCol} + $1 WHERE ${prodIdCol} = $2`,
              [row.quantity, row.product_id],
              db
            );
          } else {
            const stockCol = await pickColumn(db, productsTable, ['stock', 'existencias', 'cantidad'], 'stock');
            const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
            for (const [inventoryProductId, restoredQty] of restoredProducts.entries()) {
              await query(
                `UPDATE ${productsTable} SET ${stockCol} = ${stockCol} + $1 WHERE ${prodIdCol} = $2`,
                [restoredQty, inventoryProductId],
                db
              );
            }
          }
          if (hasInventoryMovements) {
            if (productTypeUsesInventory(soldProductType)) {
              await query(
                'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
                [row.product_id, row.quantity, 'devolucion', String(saleId), motive || null],
                db
              );
            } else {
              for (const [inventoryProductId, restoredQty] of restoredProducts.entries()) {
                await query(
                  'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
                  [inventoryProductId, restoredQty, 'devolucion', String(saleId), motive || `Devolución combo ${row.product_id}`],
                  db
                );
              }
            }
          }
          if (branchId && productTypeUsesInventory(soldProductType)) {
            await updateProductCostFromLots(db, row.product_id, branchId);
            await updateProductSalePriceFromLots(db, row.product_id, branchId);
          } else if (branchId) {
            for (const [inventoryProductId] of restoredProducts.entries()) {
              await updateProductCostFromLots(db, inventoryProductId, branchId);
              await updateProductSalePriceFromLots(db, inventoryProductId, branchId);
            }
          }
          await logAction(db, userId, 'venta_devuelta', {
            sale_id: saleId,
            product_id: row.product_id,
            qty: row.quantity,
            authorized_by_id: permissionCtx.authorizedById || null,
            sale_days_since: policy.daysSinceSale
          });
        } else if (row.is_service) {
          if (returnItemsDescCol) {
            await query(
              `INSERT INTO sale_return_items (return_id, product_id, quantity, unit_price, subtotal, ${quoteIdent(
                returnItemsDescCol
              )}) VALUES ($1,$2,$3,$4,$5,$6)`,
              [returnId, null, 0, 0, row.subtotal, row.descripcion || 'Servicio'],
              db
            );
          } else {
            await query(
              'INSERT INTO sale_return_items (return_id, product_id, quantity, unit_price, subtotal) VALUES ($1,$2,$3,$4,$5)',
              [returnId, null, 0, 0, row.subtotal],
              db
            );
          }
          await logAction(db, userId, 'venta_devuelta_servicio', {
            sale_id: saleId,
            monto: row.subtotal,
            descripcion: row.descripcion || 'Servicio',
            authorized_by_id: permissionCtx.authorizedById || null,
            sale_days_since: policy.daysSinceSale
          });
        }
      }
    } else {
      await logAction(db, userId, 'venta_devuelta_sin_producto', {
        sale_id: saleId,
        monto: totalReturn,
        authorized_by_id: permissionCtx.authorizedById || null,
        sale_days_since: policy.daysSinceSale
      });
    }

    return { returnId, totalReturn };
  });

  return result;
}

async function performReturnSaleManual(input, userId, options = {}) {
  const amount = Number(input.amount || input.monto || 0);
  const motive = String(input.motive || '').trim();
  const branchId = input.branch_id != null && input.branch_id !== '' ? Number(input.branch_id) : null;
  const cajaId = input.caja_id != null && input.caja_id !== '' ? Number(input.caja_id) : null;
  const permissionCtx = getReturnPermissionContext(userId, options);
  if (!motive) throw new Error('Motivo requerido');
  if (!amount || amount <= 0) throw new Error('Monto inválido');
  if (!cajaId) throw new Error('Seleccione la caja a la que se aplicará la devolución');
  if (!permissionCtx.canBypassPolicy) {
    throw buildApprovalRequiredError(
      'Las devoluciones sin ID requieren aprobación de admin o superadmin.',
      'manual_return_requires_approval'
    );
  }

  const result = await withTransaction(async (db) => {
    await ensureSaleReturnsManualTable(db);
    const auditCols = await ensureSaleReturnsManualAuditColumns(db);
    const cajaCheck = await validateOpenCajaForSale(
      db,
      cajaId,
      userId,
      branchId,
      permissionCtx.actorRole
    );
    if (!cajaCheck.ok) throw new Error(cajaCheck.error || 'La caja seleccionada no es válida');

    const cols = ['amount', 'motive'];
    const vals = [amount, motive];
    if (auditCols.hasAdminId) {
      cols.push('admin_id');
      vals.push(permissionCtx.authorizedById);
    }
    if (auditCols.hasUserId) {
      cols.push('user_id');
      vals.push(userId || null);
    }
    if (auditCols.hasBranchId) {
      cols.push('branch_id');
      vals.push(branchId);
    }
    if (auditCols.hasCajaId) {
      cols.push('caja_id');
      vals.push(cajaId);
    }
    const placeholders = vals.map((_, idx) => `$${idx + 1}`).join(',');
    const ins = await query(
      `INSERT INTO sale_returns_manual (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`,
      vals,
      db
    );
    return Number(ins.rows[0].id);
  });

  await logAction(null, userId, 'venta_devuelta_manual', {
    amount,
    motive,
    admin_id: permissionCtx.authorizedById || null,
    branch_id: branchId || null,
    caja_id: cajaId || null
  });

  return { manual_return_id: result, amount };
}

async function resolveNextLotCost(db, productId, branchId) {
  if (!productId || !branchId) return null;
  if (!(await tableExists(db, 'lots'))) return null;
  const hasCost = await ensureLotCostPriceColumn(db);
  const costSelect = hasCost ? 'cost_price' : 'NULL AS cost_price';
  const lotRes = await query(
    `SELECT ${costSelect} AS cost_price, purchase_id
     FROM lots
     WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE
     ORDER BY expiry_date ASC, created_at ASC, id ASC
     LIMIT 1`,
    [productId, branchId],
    db
  );
  const lot = lotRes.rows[0];
  if (!lot) return null;
  let cost = Number(lot.cost_price || 0);
  if ((!cost || Number.isNaN(cost)) && lot.purchase_id) {
    const purchaseItemsTable = await pickTable(db, ['purchase_items'], 'purchase_items');
    if (await tableExists(db, purchaseItemsTable)) {
      const piRes = await query(
        `SELECT unit_price FROM ${quoteIdent(purchaseItemsTable)} WHERE purchase_id = $1 AND product_id = $2 ORDER BY id ASC LIMIT 1`,
        [lot.purchase_id, productId],
        db
      );
      cost = Number(piRes.rows[0]?.unit_price || 0);
    }
  }
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

async function updateProductCostFromLots(db, productId, branchId) {
  const cost = await resolveNextLotCost(db, productId, branchId);
  if (cost == null) return;
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
  if (!(await tableExists(db, productsTable))) return;
  const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
  if (!prodIdCol) return;
  await query(
    `UPDATE ${quoteIdent(productsTable)} SET precio_costo = $1 WHERE ${quoteIdent(prodIdCol)} = $2`,
    [cost, productId],
    db
  );
}

async function resolveNextLotSalePrice(db, productId, branchId) {
  if (!productId || !branchId) return null;
  if (!(await tableExists(db, 'lots'))) return null;
  const hasSale = await ensureLotSalePriceColumn(db);
  const saleSelect = hasSale ? 'sale_price' : 'NULL AS sale_price';
  const lotRes = await query(
    `SELECT ${saleSelect} AS sale_price, purchase_id
     FROM lots
     WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE
     ORDER BY expiry_date ASC, created_at ASC, id ASC
     LIMIT 1`,
    [productId, branchId],
    db
  );
  const lot = lotRes.rows[0];
  if (!lot) return null;
  let price = Number(lot.sale_price || 0);
  if ((!price || Number.isNaN(price)) && lot.purchase_id) {
    const purchaseItemsTable = await pickTable(db, ['purchase_items'], 'purchase_items');
    if (await tableExists(db, purchaseItemsTable)) {
      const piCols = await getColumns(db, purchaseItemsTable);
      if (piCols.includes('sale_price')) {
        const piRes = await query(
          `SELECT sale_price FROM ${quoteIdent(purchaseItemsTable)} WHERE purchase_id = $1 AND product_id = $2 ORDER BY id ASC LIMIT 1`,
          [lot.purchase_id, productId],
          db
        );
        price = Number(piRes.rows[0]?.sale_price || 0);
      }
    }
  }
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function updateProductSalePriceFromLots(db, productId, branchId) {
  const price = await resolveNextLotSalePrice(db, productId, branchId);
  if (price == null) return;
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
  if (!(await tableExists(db, productsTable))) return;
  const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
  if (!prodIdCol) return;
  await query(
    `UPDATE ${quoteIdent(productsTable)} SET precio_publico = $1 WHERE ${quoteIdent(prodIdCol)} = $2`,
    [price, productId],
    db
  );
}

function startOfDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysUntil(value) {
  const target = startOfDay(value);
  if (!target) return null;
  const today = startOfDay(new Date());
  if (!today) return null;
  const diff = target.getTime() - today.getTime();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function isoDate(value) {
  const d = startOfDay(value);
  return d ? d.toISOString().slice(0, 10) : '';
}

function collectServiceLines(pagos) {
  const services = [];
  for (const p of pagos || []) {
    if (!p) continue;
    let det =
      p.payment_method_details ??
      p.det ??
      p.detalles ??
      p.meta ??
      null;
    if (!det) continue;
    if (typeof det === 'string') {
      try {
        det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
    }
    let list = [];
    if (det) {
      if (Array.isArray(det.services)) list = det.services;
      else if (Array.isArray(det.servicios)) list = det.servicios;
      else if (Array.isArray(det.items)) list = det.items;
      else if (Array.isArray(det.detalle)) list = det.detalle;
      else if (det.descripcion && det.monto != null) list = [det];
    }
    for (const sv of list) {
      const descripcion = String(
        sv.descripcion ||
          sv.detalle ||
          sv.servicio ||
          'Servicio'
      ).trim();
      const monto =
        safeNumber(
          sv.monto ??
            sv.valor ??
            sv.amount ??
            sv.precio ??
            sv.total
        ) || 0;
      if (monto <= 0) continue;
      services.push({
        producto: descripcion || 'Servicio',
        producto_id: Number(sv.producto_id ?? sv.product_id ?? sv.id_producto ?? 0) || null,
        cantidad: 1,
        precio_unit: monto,
        subtotal: monto,
        is_service: true
      });
    }
  }
  return services;
}

async function restoreLotsForReturn(db, saleId, productId, userId) {
  if (!saleId || !productId) return new Map();
  if (!(await tableExists(db, 'lots'))) return new Map();
  if (!(await tableExists(db, 'lot_sales'))) return new Map();
  await ensureLotSaleProductColumn(db);
  const restoredByProduct = new Map();
  const rows = await query(
    `SELECT ls.id AS lot_sale_id, ls.quantity AS sold_qty, l.id AS lot_id, l.branch_id AS branch_id, l.product_id AS inventory_product_id
     FROM lot_sales ls
     JOIN lots l ON l.id = ls.lot_id
     WHERE ls.sale_id = $1 AND COALESCE(ls.sale_product_id, l.product_id) = $2
     ORDER BY ls.id ASC
     FOR UPDATE`,
    [saleId, productId],
    db
  );
  for (const row of rows.rows || []) {
    const soldQty = Number(row.sold_qty || 0);
    if (soldQty <= 0) continue;
    const restore = soldQty;
    await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [restore, row.lot_id], db);
    const inventoryProductId = Number(row.inventory_product_id || 0);
    if (inventoryProductId) {
      restoredByProduct.set(
        inventoryProductId,
        Number((Number(restoredByProduct.get(inventoryProductId) || 0) + restore).toFixed(2))
      );
    }
    logAuditEvent({
      action: 'lot_adjusted',
      branch_id: row.branch_id || null,
      user_id: userId || null,
      product_id: inventoryProductId || productId,
      delta: restore
    });
    await query('DELETE FROM lot_sales WHERE id = $1', [row.lot_sale_id], db);
  }
  return restoredByProduct;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getServiceProductId(service) {
  const productId = Number(service?.producto_id ?? service?.product_id ?? service?.id_producto ?? 0);
  return Number.isFinite(productId) && productId > 0 ? productId : 0;
}

function isRayosXProductMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const code = normalizeText(meta.code || meta.codigo_barra || '');
  const fingerprint = normalizeText(
    [meta.name, meta.house, meta.category, meta.type]
      .filter(Boolean)
      .join(' ')
  );
  return code.startsWith('rx') || fingerprint.includes('rayos x') || fingerprint.includes('rayosx');
}

function parseDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [yy, mm, dd] = raw.split('-').map((v) => Number(v));
    if (!yy || !mm || !dd) return null;
    return new Date(yy, mm - 1, dd);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(value) {
  const d = parseDateInput(value);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear());
  return `${dd}/${mm}/${yy}`;
}

function formatLongDate(value) {
  const d = parseDateInput(value);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('es-GT', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(d);
  } catch (_) {
    return formatShortDate(d);
  }
}

function dateRangeLabel(startDate, endDate) {
  if (startDate && endDate) {
    if (String(startDate) === String(endDate)) {
      return formatLongDate(startDate);
    }
    return `Del ${formatShortDate(startDate)} al ${formatShortDate(endDate)}`;
  }
  if (startDate) return `Desde ${formatShortDate(startDate)}`;
  if (endDate) return `Hasta ${formatShortDate(endDate)}`;
  return formatLongDate(new Date());
}

function detectContextOverride(label) {
  const text = normalizeText(label);
  if (!text) return null;
  if (text.includes('emergencia')) return 'emergencia';
  if (text.includes('hospitalizacion') || text.includes('hospital') || text.includes('hospitalario')) {
    return 'hospital';
  }
  if (
    text.includes('consulta externa') ||
    text.includes('consultaexterna') ||
    text.includes('consulta ext')
  ) {
    return 'consulta';
  }
  return null;
}

function classifyServiceBucket(label, isProduct, context, productMeta = null) {
  if (!isProduct && isRayosXProductMeta(productMeta)) {
    return 'rxusg';
  }
  const text = normalizeText(label);
  if (!text) return isProduct ? 'medicina' : 'otros';
  if (text.includes('preop') || text.includes('preoperator') || text.includes('grupo')) {
    return 'preop';
  }
  if (text.includes('donacion')) {
    return 'donacion';
  }
  if (
    text.includes('medicina') ||
    text.includes('medicamento') ||
    text.includes('farmacia') ||
    text.includes('farmaco')
  ) {
    return 'medicina';
  }
  if (text.includes('laborat') || text.includes('lab')) return 'laborat';
  if (text.includes('rx') || text.includes('rayos') || text.includes('usg') || text.includes('ultrason')) {
    return 'rxusg';
  }
  if (context === 'hospital') {
    if (
      text.includes('habitacion') ||
      text.includes('hospitalizacion') ||
      text.includes('hospital') ||
      text.includes('cama') ||
      text.includes('sala') ||
      text.includes('hosp')
    ) {
      return 'hospi';
    }
  }
  if (text.includes('consulta')) {
    return context === 'hospital' ? 'hospi' : 'consulta';
  }
  if (isProduct) return 'medicina';
  return 'otros';
}

function initCashCutRow() {
  return {
    fecha: '',
    paciente: '',
    recibo: '',
    caja_id: '',
    cajero: '',
    ce_consulta: 0,
    ce_medicina: 0,
    ce_laborat: 0,
    ce_rxusg: 0,
    ce_otros: 0,
    em_consulta: 0,
    em_medicina: 0,
    em_laborat: 0,
    em_rxusg: 0,
    em_otros: 0,
    hs_hospi: 0,
    hs_medicina: 0,
    hs_laborat: 0,
    hs_rxusg: 0,
    hs_otros: 0,
    preop: 0,
    donacion: 0,
    otros_global: 0,
    total: 0
  };
}

function addCashCutAmount(row, context, bucket, amount) {
  if (!amount) return;
  if (bucket === 'preop') {
    row.preop += amount;
    return;
  }
  if (bucket === 'donacion') {
    row.donacion += amount;
    return;
  }
  if (bucket === 'otros_global') {
    row.otros_global += amount;
    return;
  }
  const ctx = context || 'consulta';
  if (ctx === 'emergencia') {
    if (bucket === 'consulta') row.em_consulta += amount;
    else if (bucket === 'medicina') row.em_medicina += amount;
    else if (bucket === 'laborat') row.em_laborat += amount;
    else if (bucket === 'rxusg') row.em_rxusg += amount;
    else row.em_otros += amount;
    return;
  }
  if (ctx === 'hospital') {
    if (bucket === 'hospi') row.hs_hospi += amount;
    else if (bucket === 'medicina') row.hs_medicina += amount;
    else if (bucket === 'laborat') row.hs_laborat += amount;
    else if (bucket === 'rxusg') row.hs_rxusg += amount;
    else row.hs_otros += amount;
    return;
  }
  if (bucket === 'consulta') row.ce_consulta += amount;
  else if (bucket === 'medicina') row.ce_medicina += amount;
  else if (bucket === 'laborat') row.ce_laborat += amount;
  else if (bucket === 'rxusg') row.ce_rxusg += amount;
  else row.ce_otros += amount;
}

function parsePaymentDetails(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractOrigin(details) {
  if (!details) return '';
  const origin = details.origen || details.origin || details.tipo || details.type || '';
  return String(origin || '').toLowerCase();
}

function extractPatientName(details) {
  if (!details) return '';
  const candidates = [
    details.nombre_comprobante,
    details.paciente,
    details.paciente_nombre,
    details.cliente_nombre,
    details.patient,
    details.nombre
  ];
  for (const cand of candidates) {
    if (cand != null && String(cand).trim()) return String(cand).trim();
  }
  return '';
}

function extractReceiptName(pagos, saleNote = '') {
  for (const p of pagos || []) {
    if (!p) continue;
    const det = parsePaymentDetails(
      p.payment_method_details ??
        p.det ??
        p.detalles ??
        p.meta ??
        null
    );
    const fromDetails = extractPatientName(det);
    if (fromDetails) return fromDetails;
  }
  if (saleNote && String(saleNote).toLowerCase().includes('a nombre de:')) {
    return String(saleNote).replace(/^.*a nombre de:\s*/i, '').trim();
  }
  return '';
}

function normalizeCustomerIdentityType(value) {
  const raw = normalizeLooseText(value).replace(/[_-]+/g, ' ');
  if (!raw) return '';
  if (['consumidor final', 'cf', 'final consumer', 'final'].includes(raw)) return 'consumidor_final';
  if (raw === 'nit') return 'nit';
  if (raw === 'cui') return 'cui';
  return raw.replace(/\s+/g, '_');
}

function formatCustomerIdentityLabel(type, lang) {
  const key = normalizeCustomerIdentityType(type);
  if (key === 'consumidor_final') return tReceipt(lang, 'consumer_final');
  if (key === 'nit') return tReceipt(lang, 'nit');
  if (key === 'cui') return tReceipt(lang, 'cui');
  return String(type || '').trim();
}

function extractCustomerIdentity(sale = {}, pagos = []) {
  let saleType = normalizeCustomerIdentityType(
    sale.cliente_tipo || sale.tipo_cliente || sale.customer_type || ''
  );
  const saleDocument = String(
    sale.cliente_documento || sale.documento_cliente || sale.customer_document || sale.nit || sale.cui || ''
  ).trim();
  if (!saleType) {
    if (sale.nit != null && String(sale.nit).trim()) saleType = 'nit';
    else if (sale.cui != null && String(sale.cui).trim()) saleType = 'cui';
  }
  if (saleType || saleDocument) {
    return {
      type: saleType,
      document: saleDocument
    };
  }

  for (const p of pagos || []) {
    if (!p) continue;
    const det = parsePaymentDetails(
      p.payment_method_details ??
        p.det ??
        p.detalles ??
        p.meta ??
        null
    );
    if (!det) continue;
    const type = normalizeCustomerIdentityType(det.cliente_tipo || det.customer_type || det.tipo_cliente || '');
    const document = String(det.cliente_doc || det.customer_document || det.documento_cliente || '').trim();
    if (type || document) {
      return { type, document };
    }
  }

  return { type: '', document: '' };
}

function normalizeLooseText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function extractHospitalDiscount(pagos) {
  let total = 0;
  for (const p of pagos || []) {
    if (!p) continue;
    let det =
      p.payment_method_details ??
      p.det ??
      p.detalles ??
      p.meta ??
      null;
    if (!det) continue;
    if (typeof det === 'string') {
      try {
        det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
    }
    if (!det || typeof det !== 'object') continue;
    const amt = safeNumber(det.discount_amount ?? det.descuento ?? det.discount);
    if (amt != null && Number.isFinite(amt)) {
      total += amt;
    }
  }
  return Number(total.toFixed(2));
}

async function buildCashCutRows(db, opts) {
  const startDate = opts?.startDate || null;
  const endDate = opts?.endDate || null;
  const branchId = opts?.branchId || null;
  const cajaId = opts?.cajaId || null;

  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleItemsTable = await pickTable(db, ['venta_items', 'detalle_venta', 'sale_items'], 'venta_items');
  const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');

  const salesIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
  const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
  const salesTotalCol = await pickColumn(
    db,
    salesTable,
    ['total', 'monto_total', 'importe_total', 'amount_total'],
    null
  );
  const salesNoteCol = await pickColumn(db, salesTable, ['note', 'nota', 'observacion', 'motivo'], null);
  const salesBranchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);
  const salesBoxCol = await pickColumn(db, salesTable, ['caja_id', 'cashbox_id', 'id_caja'], null);

  if (!salesIdCol || !salesDateCol) return [];

  const params = [];
  const where = [];
  if (startDate) {
    where.push(`${quoteIdent(salesDateCol)} >= $${params.length + 1}::date`);
    params.push(startDate);
  }
  if (endDate) {
    where.push(`${quoteIdent(salesDateCol)} < ($${params.length + 1}::date + interval '1 day')`);
    params.push(endDate);
  }
  if (branchId && salesBranchCol) {
    where.push(`${quoteIdent(salesBranchCol)} = $${params.length + 1}`);
    params.push(branchId);
  }
  if (cajaId && salesBoxCol) {
    where.push(`${quoteIdent(salesBoxCol)} = $${params.length + 1}`);
    params.push(cajaId);
  }

  const selectCols = [
    `${quoteIdent(salesIdCol)} AS id`,
    `${quoteIdent(salesDateCol)} AS fecha`
  ];
  if (salesTotalCol) selectCols.push(`${quoteIdent(salesTotalCol)} AS total`);
  if (salesNoteCol) selectCols.push(`${quoteIdent(salesNoteCol)} AS note`);
  if (salesBranchCol) selectCols.push(`${quoteIdent(salesBranchCol)} AS branch_id`);
  if (salesBoxCol) selectCols.push(`${quoteIdent(salesBoxCol)} AS caja_id`);

  let sql = `SELECT ${selectCols.join(',')} FROM ${quoteIdent(salesTable)}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${quoteIdent(salesDateCol)} ASC`;

  const salesRes = await query(sql, params, db);
  const sales = salesRes.rows || [];
  if (!sales.length) return [];

  const saleIds = sales.map((s) => Number(s.id || 0)).filter((id) => id > 0);
  if (!saleIds.length) return [];

  const cajaById = new Map();
  if (salesBoxCol && (await tableExists(db, 'cajas'))) {
    const cajaIds = sales
      .map((s) => Number(s.caja_id || 0))
      .filter((id) => id > 0);
    if (cajaIds.length) {
      const cajaTable = await pickTable(db, ['cajas', 'caja', 'cashbox'], 'cajas');
      const cajaCols = await getColumns(db, cajaTable);
      const cajaUserCol = cajaCols.includes('user_id') ? 'user_id' : null;
      if (cajaUserCol) {
        const cajaRes = await query(
          `SELECT c.id, c.${quoteIdent(cajaUserCol)} AS user_id, u.username
           FROM ${quoteIdent(cajaTable)} c
           LEFT JOIN users u ON u.id = c.${quoteIdent(cajaUserCol)}
           WHERE c.id = ANY($1)`,
          [cajaIds],
          db
        );
        for (const row of cajaRes.rows || []) {
          cajaById.set(Number(row.id), row.username || null);
        }
      }
    }
  }

  const itemsBySale = new Map();
  if (await tableExists(db, saleItemsTable)) {
    const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
    const siProdIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], null);
    const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], null);
    const siUnitCol = await pickColumn(db, saleItemsTable, ['precio_unit', 'precio_unitario', 'unit_price'], null);
    const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], null);
    if (siSaleIdCol && siProdIdCol && siQtyCol && siUnitCol) {
      const sqlItems = `SELECT ${quoteIdent(siSaleIdCol)} AS sale_id, ${quoteIdent(
        siProdIdCol
      )} AS product_id, ${quoteIdent(siQtyCol)} AS quantity, ${quoteIdent(siUnitCol)} AS unit_price${
        siSubCol ? `, ${quoteIdent(siSubCol)} AS subtotal` : ''
      } FROM ${quoteIdent(saleItemsTable)} WHERE ${quoteIdent(siSaleIdCol)} = ANY($1)`;
      const itemRes = await query(sqlItems, [saleIds], db);
      for (const row of itemRes.rows || []) {
        const saleId = Number(row.sale_id || 0);
        if (!itemsBySale.has(saleId)) itemsBySale.set(saleId, []);
        itemsBySale.get(saleId).push(row);
      }
    }
  }

  const productNameMap = new Map();
  const productMetaMap = new Map();

  const paymentsBySale = new Map();
  if (await tableExists(db, paymentsTable)) {
    const paySaleIdCol = await pickColumn(db, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], null);
    const payAmountCol = await pickColumn(db, paymentsTable, ['amount', 'monto', 'total'], null);
    const payTypeCol = await pickColumn(db, paymentsTable, ['payment_type', 'tipo_pago', 'metodo'], null);
    const payDetCol = await pickColumn(
      db,
      paymentsTable,
      ['payment_method_details', 'detalles', 'det', 'meta'],
      null
    );
    const payCreatedCol = await pickColumn(db, paymentsTable, ['created_at', 'fecha'], null);
    if (paySaleIdCol) {
      const cols = [
        `${quoteIdent(paySaleIdCol)} AS sale_id`,
        payAmountCol ? `${quoteIdent(payAmountCol)} AS amount` : 'NULL AS amount',
        payTypeCol ? `${quoteIdent(payTypeCol)} AS payment_type` : 'NULL AS payment_type',
        payDetCol ? `${quoteIdent(payDetCol)} AS payment_method_details` : 'NULL AS payment_method_details',
        payCreatedCol ? `${quoteIdent(payCreatedCol)} AS created_at` : 'NULL AS created_at'
      ];
      const payRes = await query(
        `SELECT ${cols.join(',')} FROM ${quoteIdent(paymentsTable)} WHERE ${quoteIdent(
          paySaleIdCol
        )} = ANY($1)`,
        [saleIds],
        db
      );
      for (const row of payRes.rows || []) {
        const saleId = Number(row.sale_id || 0);
        if (!paymentsBySale.has(saleId)) paymentsBySale.set(saleId, []);
        paymentsBySale.get(saleId).push(row);
      }
    }
  }

  if (await tableExists(db, productsTable)) {
    const prodCols = await getColumns(db, productsTable);
    const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
    const prodNameCol = await pickColumn(
      db,
      productsTable,
      ['nombre_comercial', 'nombre', 'name', 'descripcion'],
      'nombre_comercial'
    );
    const prodCodeCol = prodCols.includes('codigo_barra') ? 'codigo_barra' : null;
    const prodHouseCol = prodCols.includes('casa') ? 'casa' : null;
    const prodTypeCol = prodCols.includes('tipo') ? 'tipo' : null;
    const productIds = new Set();
    for (const items of itemsBySale.values()) {
      for (const item of items) {
        const pid = Number(item.product_id || 0);
        if (pid) productIds.add(pid);
      }
    }
    for (const payments of paymentsBySale.values()) {
      const services = collectServiceLines(payments);
      for (const service of services) {
        const pid = getServiceProductId(service);
        if (pid) productIds.add(pid);
      }
    }
    if (productIds.size && prodIdCol && prodNameCol) {
      const list = Array.from(productIds);
      const prodRes = await query(
        `SELECT ${quoteIdent(prodIdCol)} AS id,
                ${quoteIdent(prodNameCol)} AS name
                ${prodCodeCol ? `, ${quoteIdent(prodCodeCol)} AS code` : ", '' AS code"}
                ${prodHouseCol ? `, ${quoteIdent(prodHouseCol)} AS house` : ", '' AS house"}
                ${prodTypeCol ? `, ${quoteIdent(prodTypeCol)} AS type` : ", 'medicamento' AS type"}
           FROM ${quoteIdent(productsTable)}
          WHERE ${quoteIdent(prodIdCol)} = ANY($1)`,
        [list],
        db
      );
      for (const row of prodRes.rows || []) {
        const productId = Number(row.id || 0);
        if (!productId) continue;
        const name = String(row.name || '').trim();
        productNameMap.set(productId, name);
        productMetaMap.set(productId, {
          id: productId,
          name,
          code: String(row.code || '').trim(),
          house: String(row.house || '').trim(),
          type: String(row.type || '').trim()
        });
      }
    }
  }

  const hospitalBySale = new Map();
  if (await tableExists(db, 'hospital_payments')) {
    const hospRes = await query(
      `SELECT hp.sale_id, hp.admission_id, a.tipo, c.nombre, c.documento
       FROM hospital_payments hp
       JOIN hospital_admissions a ON a.id = hp.admission_id
       JOIN hospital_clients c ON c.id = a.client_id
       WHERE hp.sale_id = ANY($1)`,
      [saleIds],
      db
    );
    for (const row of hospRes.rows || []) {
      const saleId = Number(row.sale_id || 0);
      if (!hospitalBySale.has(saleId)) {
        hospitalBySale.set(saleId, {
          admission_id: Number(row.admission_id || 0),
          tipo: String(row.tipo || '').toLowerCase(),
          nombre: row.nombre ? String(row.nombre) : '',
          documento: row.documento ? String(row.documento) : ''
        });
      }
    }
  }

  const rows = [];

  const returnsBySale = new Map();
  const returnsMeta = await ensureSaleReturnTotals(db);
  if (returnsMeta?.table && (await tableExists(db, returnsMeta.table)) && returnsMeta.totalCol) {
    const rs = await query(
      `SELECT sale_id, COALESCE(SUM(${quoteIdent(returnsMeta.totalCol)}),0) AS total
       FROM ${quoteIdent(returnsMeta.table)}
       WHERE sale_id = ANY($1)
       GROUP BY sale_id`,
      [saleIds],
      db
    );
    for (const r of rs.rows || []) {
      returnsBySale.set(Number(r.sale_id), Number(r.total || 0));
    }
  }

  const returnItemsBySale = new Map();
  let returnItemDescCol = null;
  if (returnsMeta?.table && (await tableExists(db, returnsMeta.table))) {
    const returnItemsTable = await pickTable(db, ['sale_return_items'], 'sale_return_items');
    if (await tableExists(db, returnItemsTable)) {
      const riCols = await getColumns(db, returnItemsTable);
      const riReturnIdCol = riCols.includes('return_id') ? 'return_id' : null;
      const riProdCol = riCols.includes('product_id') ? 'product_id' : null;
      const riQtyCol = riCols.includes('quantity') ? 'quantity' : null;
      const riUnitCol = riCols.includes('unit_price') ? 'unit_price' : null;
      const riSubCol = riCols.includes('subtotal') ? 'subtotal' : null;
      returnItemDescCol = riCols.includes('descripcion') ? 'descripcion' : null;
      if (riReturnIdCol && riProdCol && riQtyCol) {
        const q = await query(
          `SELECT r.sale_id, ri.${quoteIdent(riProdCol)} AS product_id, ri.${quoteIdent(
            riQtyCol
          )} AS quantity ${riUnitCol ? `, ri.${quoteIdent(riUnitCol)} AS unit_price` : ''} ${
            riSubCol ? `, ri.${quoteIdent(riSubCol)} AS subtotal` : ''
          }
          ${returnItemDescCol ? `, ri.${quoteIdent(returnItemDescCol)} AS descripcion` : ''}
           FROM ${quoteIdent(returnsMeta.table)} r
           JOIN ${quoteIdent(returnItemsTable)} ri ON ri.${quoteIdent(riReturnIdCol)} = r.id
           WHERE r.sale_id = ANY($1)`,
          [saleIds],
          db
        );
        for (const row of q.rows || []) {
          const sid = Number(row.sale_id || 0);
          if (!sid) continue;
          if (!returnItemsBySale.has(sid)) returnItemsBySale.set(sid, []);
          returnItemsBySale.get(sid).push(row);
        }
      }
    }
  }
  for (const sale of sales) {
    const saleId = Number(sale.id || 0);
    if (!saleId) continue;
    const row = initCashCutRow();
    row.fecha = formatShortDate(sale.fecha || sale.created_at || sale.fecha_venta || null);
    row.recibo = saleId;
    row.caja_id = sale.caja_id != null ? String(sale.caja_id) : '';
    row.cajero = sale.caja_id && cajaById.has(Number(sale.caja_id)) ? cajaById.get(Number(sale.caja_id)) || '' : '';
    const saleTotal = sale.total != null ? Number(sale.total) : 0;
    const returnTotal = returnsBySale.get(saleId) || 0;
    row.total = saleTotal - returnTotal;

    const pagos = paymentsBySale.get(saleId) || [];
    const services = collectServiceLines(pagos);
    const admissionInfo = hospitalBySale.get(saleId) || null;
    let context = 'consulta';
    if (admissionInfo) {
      context = admissionInfo.tipo === 'emergencia' ? 'emergencia' : 'hospital';
    } else {
      for (const p of pagos) {
        const details = parsePaymentDetails(p.payment_method_details);
        const origin = extractOrigin(details);
        if (origin === 'emergencia') {
          context = 'emergencia';
          break;
        }
        if (origin === 'hospital' || origin === 'hospitalizacion' || origin === 'hospitalización') {
          context = 'hospital';
          break;
        }
      }
    }

    if (admissionInfo && admissionInfo.nombre) {
      row.paciente = admissionInfo.nombre;
    } else {
      let name = '';
      for (const p of pagos) {
        const details = parsePaymentDetails(p.payment_method_details);
        name = extractPatientName(details);
        if (name) break;
      }
      if (!name && sale.note) name = String(sale.note);
      row.paciente = name;
    }

    const items = itemsBySale.get(saleId) || [];
    const saleGross =
      items.reduce((s, it) => {
        const qty = Number(it.quantity || 0);
        const unit = Number(it.unit_price || 0);
        const sub =
          it.subtotal != null
            ? Number(it.subtotal)
            : Number.isFinite(qty) && Number.isFinite(unit)
            ? qty * unit
            : 0;
        return s + (Number.isFinite(sub) ? sub : 0);
      }, 0) +
      services.reduce((s, sv) => {
        const amount =
          sv.subtotal != null
            ? Number(sv.subtotal)
            : Number(sv.cantidad || 1) * Number(sv.precio_unit || 0);
        return s + (Number.isFinite(amount) ? amount : 0);
      }, 0);
    const saleNet = saleTotal;
    const saleRatio = saleGross > 0 && saleNet > 0 ? saleNet / saleGross : 1;
    for (const item of items) {
      const qty = Number(item.quantity || 0);
      const unit = Number(item.unit_price || 0);
      const sub =
        item.subtotal != null
          ? Number(item.subtotal)
          : Number.isFinite(qty) && Number.isFinite(unit)
          ? qty * unit
          : 0;
      const pid = Number(item.product_id || 0);
      const label = productNameMap.get(pid) || (pid ? `Producto ${pid}` : 'Producto');
      const bucket = classifyServiceBucket(label, true, context);
      const adj = saleRatio !== 1 ? sub * saleRatio : sub;
      addCashCutAmount(row, context, bucket, adj);
    }

    for (const sv of services) {
      const label = sv.producto || sv.descripcion || 'Servicio';
      const serviceMeta = productMetaMap.get(getServiceProductId(sv)) || null;
      const amount =
        sv.subtotal != null
          ? Number(sv.subtotal)
          : Number(sv.cantidad || 1) * Number(sv.precio_unit || 0);
      let svcContext = context;
      if (context === 'consulta') {
        const override = detectContextOverride(label);
        if (override) svcContext = override;
      }
      const bucket = classifyServiceBucket(label, false, svcContext, serviceMeta);
      const adj = saleRatio !== 1 ? amount * saleRatio : amount;
      addCashCutAmount(row, svcContext, bucket, adj);
    }

    const returnItems = returnItemsBySale.get(saleId) || [];
    let serviceReturnItemsTotal = 0;
    for (const r of returnItems) {
      const qty = Number(r.quantity || 0);
      const unit = Number(r.unit_price || 0);
      const sub =
        r.subtotal != null
          ? Number(r.subtotal)
          : Number.isFinite(qty) && Number.isFinite(unit)
          ? qty * unit
          : 0;
      if (!sub) continue;
      const pid = Number(r.product_id || 0);
      if (pid) {
        const label = productNameMap.get(pid) || `Producto ${pid}`;
        const bucket = classifyServiceBucket(label, true, context);
        const adj = saleRatio !== 1 ? sub * saleRatio : sub;
        addCashCutAmount(row, context, bucket, -1 * adj);
      } else {
        const desc = r.descripcion ? String(r.descripcion) : 'Servicio';
        let svcContext = context;
        if (context === 'consulta') {
          const override = detectContextOverride(desc);
          if (override) svcContext = override;
        }
        const bucket = classifyServiceBucket(desc, false, svcContext, null);
        const adj = saleRatio !== 1 ? sub * saleRatio : sub;
        addCashCutAmount(row, svcContext, bucket, -1 * adj);
        serviceReturnItemsTotal += sub;
      }
    }
    if (returnsMeta?.table && returnsMeta.serviceCol) {
      const svcRow = await query(
        `SELECT COALESCE(SUM(${quoteIdent(returnsMeta.serviceCol)}),0) AS total
         FROM ${quoteIdent(returnsMeta.table)}
         WHERE sale_id = $1`,
        [saleId],
        db
      );
      const svcTotal = Number(svcRow.rows[0]?.total || 0);
      const remainingServiceRefund = Math.max(0, svcTotal - serviceReturnItemsTotal);
      if (remainingServiceRefund > 0.0001) {
        let pending = remainingServiceRefund;
        for (const sv of services) {
          if (pending <= 0.0001) break;
          const label = sv.producto || sv.descripcion || 'Servicio';
          const serviceMeta = productMetaMap.get(getServiceProductId(sv)) || null;
          const amount =
            sv.subtotal != null
              ? Number(sv.subtotal)
              : Number(sv.cantidad || 1) * Number(sv.precio_unit || 0);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          let svcContext = context;
          if (context === 'consulta') {
            const override = detectContextOverride(label);
            if (override) svcContext = override;
          }
          const bucket = classifyServiceBucket(label, false, svcContext, serviceMeta);
          const refundPortion = Math.min(amount, pending);
          const adj = saleRatio !== 1 ? refundPortion * saleRatio : refundPortion;
          addCashCutAmount(row, svcContext, bucket, -1 * adj);
          pending -= refundPortion;
        }
      }
    }

    const sumValues =
      row.ce_consulta +
      row.ce_medicina +
      row.ce_laborat +
      row.ce_rxusg +
      row.ce_otros +
      row.em_consulta +
      row.em_medicina +
      row.em_laborat +
      row.em_rxusg +
      row.em_otros +
      row.hs_hospi +
      row.hs_medicina +
      row.hs_laborat +
      row.hs_rxusg +
      row.hs_otros +
      row.preop +
      row.donacion +
      row.otros_global;
    if (sumValues <= 0.0001 && row.total > 0) {
      addCashCutAmount(row, context, 'otros', row.total);
    }

    if (Math.abs(row.total) <= 0.0001) {
      row.ce_consulta = 0;
      row.ce_medicina = 0;
      row.ce_laborat = 0;
      row.ce_rxusg = 0;
      row.ce_otros = 0;
      row.em_consulta = 0;
      row.em_medicina = 0;
      row.em_laborat = 0;
      row.em_rxusg = 0;
      row.em_otros = 0;
      row.hs_hospi = 0;
      row.hs_medicina = 0;
      row.hs_laborat = 0;
      row.hs_rxusg = 0;
      row.hs_otros = 0;
      row.preop = 0;
      row.donacion = 0;
      row.otros_global = 0;
    }

    rows.push(row);
  }

  if (await tableExists(db, 'sale_returns_manual')) {
    const mCols = await getColumns(db, 'sale_returns_manual');
    const amountCol = mCols.includes('amount') ? 'amount' : mCols.includes('monto') ? 'monto' : null;
    const dateCol = mCols.includes('created_at') ? 'created_at' : mCols.includes('fecha') ? 'fecha' : null;
    const motiveCol = mCols.includes('motive') ? 'motive' : mCols.includes('motivo') ? 'motivo' : null;
    const cajaCol = mCols.includes('caja_id') ? 'caja_id' : null;
    const whereM = [];
    const paramsM = [];
    if (amountCol && dateCol) {
      if (startDate) {
        whereM.push(`${quoteIdent(dateCol)} >= $${paramsM.length + 1}::date`);
        paramsM.push(startDate);
      }
      if (endDate) {
        whereM.push(`${quoteIdent(dateCol)} < ($${paramsM.length + 1}::date + interval '1 day')`);
        paramsM.push(endDate);
      }
      if (cajaId && cajaCol) {
        whereM.push(`${quoteIdent(cajaCol)} = $${paramsM.length + 1}`);
        paramsM.push(cajaId);
      }
      const cols = [
        'id',
        `${quoteIdent(dateCol)} AS fecha`,
        `${quoteIdent(amountCol)} AS amount`
      ];
      if (motiveCol) cols.push(`${quoteIdent(motiveCol)} AS motive`);
      let sqlM = `SELECT ${cols.join(',')} FROM sale_returns_manual`;
      if (whereM.length) sqlM += ` WHERE ${whereM.join(' AND ')}`;
      sqlM += ` ORDER BY ${quoteIdent(dateCol)} ASC`;
      const ms = await query(sqlM, paramsM, db);
      for (const r of ms.rows || []) {
        const amt = Number(r.amount || 0);
        if (!amt) continue;
        const row = initCashCutRow();
        row.fecha = formatShortDate(r.fecha || r.created_at || null);
        row.paciente = r.motive || 'ANULACION SIN ID';
        row.recibo = `ANULACION SIN ID #${r.id}`;
        row.caja_id = r.caja_id != null ? String(r.caja_id) : '';
        row.cajero = r.caja_id && cajaById.has(Number(r.caja_id)) ? cajaById.get(Number(r.caja_id)) || '' : '';
        row.total = -1 * amt;
        rows.push(row);
      }
    }
  }

  return rows;
}

function cashCutAmountCell(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num === 0) return null;
  return num;
}

function cashCutRowToArray(row) {
  return [
    row.fecha || '',
    row.paciente || '',
    row.recibo || '',
    row.caja_id || '',
    row.cajero || '',
    cashCutAmountCell(row.ce_consulta),
    cashCutAmountCell(row.ce_medicina),
    cashCutAmountCell(row.ce_laborat),
    cashCutAmountCell(row.ce_rxusg),
    cashCutAmountCell(row.ce_otros),
    cashCutAmountCell(row.em_consulta),
    cashCutAmountCell(row.em_medicina),
    cashCutAmountCell(row.em_laborat),
    cashCutAmountCell(row.em_rxusg),
    cashCutAmountCell(row.em_otros),
    cashCutAmountCell(row.hs_hospi),
    cashCutAmountCell(row.hs_medicina),
    cashCutAmountCell(row.hs_laborat),
    cashCutAmountCell(row.hs_rxusg),
    cashCutAmountCell(row.hs_otros),
    cashCutAmountCell(row.preop),
    cashCutAmountCell(row.donacion),
    cashCutAmountCell(row.otros_global),
    cashCutAmountCell(row.total)
  ];
}

function buildCashCutWorkbook(rows, label) {
  const empty = Array(24).fill('');
  const titleRow = [...empty];
  titleRow[0] = 'CORTE DE CAJA';
  const dateRow = [...empty];
  dateRow[5] = label || '';

  const groupRow = [...empty];
  groupRow[0] = 'FECHA';
  groupRow[1] = 'PACIENTE';
  groupRow[2] = 'RECIBO';
  groupRow[3] = 'CAJA';
  groupRow[4] = 'CAJERO';
  groupRow[5] = 'CONSULTA EXTERNA';
  groupRow[10] = 'EMERGENCIA';
  groupRow[15] = 'SERVICIOS HOSPITALARIOS';
  groupRow[20] = 'preop , GRUPOS';
  groupRow[21] = 'donacion';
  groupRow[22] = 'OTROS';
  groupRow[23] = 'TOTAL';

  const subRow = [...empty];
  subRow[5] = 'CONSULTA';
  subRow[6] = 'MEDICINA';
  subRow[7] = 'LABORAT';
  subRow[8] = 'RX y USG';
  subRow[9] = 'OTRO';
  subRow[10] = 'CONSULTA';
  subRow[11] = 'MEDICINA';
  subRow[12] = 'LABORAT';
  subRow[13] = 'RX y USG';
  subRow[14] = 'OTROS';
  subRow[15] = 'HOSPI';
  subRow[16] = 'MEDICINA';
  subRow[17] = 'LABORAT';
  subRow[18] = 'RX y USG';
  subRow[19] = 'OTROS';
  subRow[20] = 'Preop';
  subRow[21] = 'Donacion';
  subRow[22] = 'Otros';
  subRow[23] = 'Total';

  const dataRows = [titleRow, dateRow, groupRow, subRow];
  for (const row of rows) {
    dataRows.push(cashCutRowToArray(row));
  }
  const totalRowIndex = dataRows.length;
  const totalRow = [...empty];
  totalRow[22] = 'TOTAL GENERAL';
  dataRows.push(totalRow);

  const ws = XLSX.utils.aoa_to_sheet(dataRows);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 26 },
    { wch: 10 },
    { wch: 8 },
    { wch: 16 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 }
  ];
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 0, c: 5 }, e: { r: 0, c: 23 } },
    { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
    { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
    { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } },
    { s: { r: 2, c: 3 }, e: { r: 3, c: 3 } },
    { s: { r: 2, c: 4 }, e: { r: 3, c: 4 } },
    { s: { r: 2, c: 5 }, e: { r: 2, c: 9 } },
    { s: { r: 2, c: 10 }, e: { r: 2, c: 14 } },
    { s: { r: 2, c: 15 }, e: { r: 2, c: 19 } }
  ];

  const totalCell = XLSX.utils.encode_cell({ r: totalRowIndex, c: 23 });
  if (rows.length > 0) {
    const firstDataRow = 4;
    const lastDataRow = 4 + rows.length - 1;
    const startAddr = XLSX.utils.encode_cell({ r: firstDataRow, c: 23 });
    const endAddr = XLSX.utils.encode_cell({ r: lastDataRow, c: 23 });
    ws[totalCell] = { t: 'n', f: `SUM(${startAddr}:${endAddr})` };
  } else {
    ws[totalCell] = { t: 'n', v: 0 };
  }

  const moneyFmt = '"Q" #,##0.00';
  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    const startRow = 4;
    for (let r = startRow; r <= range.e.r; r += 1) {
      for (let c = 5; c <= 23; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;
        if (cell.t === 'n' || cell.f) {
          cell.s = { ...(cell.s || {}), numFmt: moneyFmt };
        }
      }
    }
  }

  const border = {
    top: { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left: { style: 'thin', color: { rgb: '000000' } },
    right: { style: 'thin', color: { rgb: '000000' } }
  };
  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) {
          ws[addr] = { t: 's', v: '' };
        }
        ws[addr].s = { ...(ws[addr].s || {}), border };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Corte de Caja');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function parseTopSoldDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function parseTopSoldLimit(value) {
  const n = Number(value || 50);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function addSaleFilters(parts, params, options = {}) {
  const { startDate, endDate, branchId, dateCol, branchCol, saleAlias = 'v', branchExpr = null } = options;
  if (startDate && dateCol) {
    parts.push(`${saleAlias}.${quoteIdent(dateCol)} >= $${params.length + 1}::date`);
    params.push(startDate);
  }
  if (endDate && dateCol) {
    parts.push(`${saleAlias}.${quoteIdent(dateCol)} < ($${params.length + 1}::date + interval '1 day')`);
    params.push(endDate);
  }
  if (branchId) {
    if (branchCol) {
      parts.push(`${saleAlias}.${quoteIdent(branchCol)} = $${params.length + 1}`);
      params.push(branchId);
    } else if (branchExpr) {
      parts.push(`${branchExpr} = $${params.length + 1}`);
      params.push(branchId);
    }
  }
}

function soldMedicineMetaSelect(alias, cols) {
  return [
    `${alias}.${quoteIdent(cols.id)} AS product_id`,
    `${alias}.${quoteIdent(cols.name)} AS nombre`,
    cols.code ? `${alias}.${quoteIdent(cols.code)} AS codigo` : "'' AS codigo",
    cols.presentation ? `${alias}.${quoteIdent(cols.presentation)} AS presentacion` : "'' AS presentacion",
    cols.house ? `${alias}.${quoteIdent(cols.house)} AS casa` : "'' AS casa"
  ].join(', ');
}

function soldMedicineMetaGroup(alias, cols) {
  return [
    `${alias}.${quoteIdent(cols.id)}`,
    `${alias}.${quoteIdent(cols.name)}`,
    cols.code ? `${alias}.${quoteIdent(cols.code)}` : null,
    cols.presentation ? `${alias}.${quoteIdent(cols.presentation)}` : null,
    cols.house ? `${alias}.${quoteIdent(cols.house)}` : null
  ].filter(Boolean).join(', ');
}

function soldMedicineTypeExpr(alias, typeCol) {
  return typeCol ? `LOWER(COALESCE(${alias}.${quoteIdent(typeCol)}, 'medicamento'))` : "'medicamento'";
}

function ensureSoldMedicineRow(map, row) {
  const productId = Number(row.product_id || 0);
  if (!productId) return null;
  if (!map.has(productId)) {
    map.set(productId, {
      product_id: productId,
      nombre: String(row.nombre || `Producto ${productId}`).trim(),
      codigo: String(row.codigo || '').trim(),
      presentacion: String(row.presentacion || '').trim(),
      casa: String(row.casa || '').trim(),
      direct_qty: 0,
      combo_qty: 0,
      total_qty: 0,
      direct_total: 0,
      sale_count: 0
    });
  }
  const item = map.get(productId);
  if (!item.nombre && row.nombre) item.nombre = String(row.nombre).trim();
  if (!item.codigo && row.codigo) item.codigo = String(row.codigo).trim();
  if (!item.presentacion && row.presentacion) item.presentacion = String(row.presentacion).trim();
  if (!item.casa && row.casa) item.casa = String(row.casa).trim();
  return item;
}

async function buildTopSoldMedicinesRows(db, options = {}) {
  const startDate = parseTopSoldDate(options.startDate);
  const endDate = parseTopSoldDate(options.endDate);
  const branchId = options.branchId ? Number(options.branchId) : null;
  const limit = parseTopSoldLimit(options.limit);

  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleItemsTable = await pickTable(db, ['venta_items', 'detalle_venta', 'sale_items'], 'venta_items');
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
  if (!(await tableExists(db, salesTable)) || !(await tableExists(db, productsTable))) return [];
  await ensureProductTypeColumn(db);

  const salesIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
  const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
  const salesBranchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);

  const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
  const prodNameCol = await pickColumn(db, productsTable, ['nombre_comercial', 'nombre', 'name', 'descripcion'], 'nombre_comercial');
  const prodCols = await getColumns(db, productsTable);
  const prodTypeCol = prodCols.includes('tipo') ? 'tipo' : null;
  const prodCodeCol = prodCols.includes('codigo_barra') ? 'codigo_barra' : null;
  const prodPresentationCol = prodCols.includes('presentacion') ? 'presentacion' : null;
  const prodHouseCol = prodCols.includes('casa') ? 'casa' : null;
  const prodMetaCols = {
    id: prodIdCol,
    name: prodNameCol,
    code: prodCodeCol,
    presentation: prodPresentationCol,
    house: prodHouseCol
  };
  const rowsByProduct = new Map();

  const lotsTable = await pickTable(db, ['lots'], 'lots');
  const lotSalesTable = await pickTable(db, ['lot_sales'], 'lot_sales');
  const hasLotSales = (await tableExists(db, lotsTable)) && (await tableExists(db, lotSalesTable));
  if (hasLotSales) {
    await ensureLotSaleProductColumn(db);
    const lotCols = await getColumns(db, lotsTable);
    const lotSalesCols = await getColumns(db, lotSalesTable);
    const lotIdCol = lotCols.includes('id') ? 'id' : null;
    const lotProductCol = lotCols.includes('product_id') ? 'product_id' : null;
    const lotBranchCol = lotCols.includes('branch_id') ? 'branch_id' : null;
    const lsSaleCol = lotSalesCols.includes('sale_id') ? 'sale_id' : null;
    const lsLotCol = lotSalesCols.includes('lot_id') ? 'lot_id' : null;
    const lsQtyCol = lotSalesCols.includes('quantity') ? 'quantity' : null;
    const lsSaleProductCol = lotSalesCols.includes('sale_product_id') ? 'sale_product_id' : null;
    if (lotIdCol && lotProductCol && lsSaleCol && lsLotCol && lsQtyCol) {
      const params = [];
      const where = [`${soldMedicineTypeExpr('p', prodTypeCol)} = 'medicamento'`];
      addSaleFilters(where, params, {
        startDate,
        endDate,
        branchId,
        dateCol: salesDateCol,
        branchCol: salesBranchCol,
        saleAlias: 'v',
        branchExpr: lotBranchCol ? `l.${quoteIdent(lotBranchCol)}` : null
      });
      const soldTypeExpr = lsSaleProductCol
        ? `LOWER(COALESCE(sp.${quoteIdent(prodTypeCol || prodIdCol)}, p.${quoteIdent(prodTypeCol || prodIdCol)}, 'medicamento'))`
        : "'medicamento'";
      const soldTypeSafeExpr = prodTypeCol
        ? soldTypeExpr
        : "'medicamento'";
      const soldProductExpr = lsSaleProductCol
        ? `COALESCE(ls.${quoteIdent(lsSaleProductCol)}, l.${quoteIdent(lotProductCol)})`
        : `l.${quoteIdent(lotProductCol)}`;
      const comboCondition = `(${soldTypeSafeExpr} = 'combo' AND ${soldProductExpr} <> l.${quoteIdent(lotProductCol)})`;
      const lotSql = `
        SELECT ${soldMedicineMetaSelect('p', prodMetaCols)},
               COALESCE(SUM(CASE WHEN ${comboCondition} THEN 0 ELSE ls.${quoteIdent(lsQtyCol)} END),0) AS direct_qty,
               COALESCE(SUM(CASE WHEN ${comboCondition} THEN ls.${quoteIdent(lsQtyCol)} ELSE 0 END),0) AS combo_qty,
               COUNT(DISTINCT v.${quoteIdent(salesIdCol)})::INT AS sale_count
          FROM ${quoteIdent(lotSalesTable)} ls
          JOIN ${quoteIdent(lotsTable)} l ON l.${quoteIdent(lotIdCol)} = ls.${quoteIdent(lsLotCol)}
          JOIN ${quoteIdent(salesTable)} v ON v.${quoteIdent(salesIdCol)} = ls.${quoteIdent(lsSaleCol)}
          JOIN ${quoteIdent(productsTable)} p ON p.${quoteIdent(prodIdCol)} = l.${quoteIdent(lotProductCol)}
          ${lsSaleProductCol ? `LEFT JOIN ${quoteIdent(productsTable)} sp ON sp.${quoteIdent(prodIdCol)} = ls.${quoteIdent(lsSaleProductCol)}` : ''}
         WHERE ${where.join(' AND ')}
         GROUP BY ${soldMedicineMetaGroup('p', prodMetaCols)}
      `;
      const lotRes = await query(lotSql, params, db);
      for (const row of lotRes.rows || []) {
        const item = ensureSoldMedicineRow(rowsByProduct, row);
        if (!item) continue;
        const directQty = Number(row.direct_qty || 0);
        const comboQty = Number(row.combo_qty || 0);
        item.direct_qty += Number.isFinite(directQty) ? directQty : 0;
        item.combo_qty += Number.isFinite(comboQty) ? comboQty : 0;
        item.sale_count += Number(row.sale_count || 0) || 0;
      }
    }
  }

  if (await tableExists(db, saleItemsTable)) {
    const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
    const siProductIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
    const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], 'cantidad');
    const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], null);
    if (siSaleIdCol && siProductIdCol && siQtyCol) {
      const params = [];
      const itemWhere = [`${soldMedicineTypeExpr('p', prodTypeCol)} = 'medicamento'`];
      addSaleFilters(itemWhere, params, {
        startDate,
        endDate,
        branchId,
        dateCol: salesDateCol,
        branchCol: salesBranchCol,
        saleAlias: 'v'
      });
      const returnTable = await pickTable(db, ['sale_returns'], 'sale_returns');
      const returnItemsTable = await pickTable(db, ['sale_return_items'], 'sale_return_items');
      const hasReturns = (await tableExists(db, returnTable)) && (await tableExists(db, returnItemsTable));
      const returnQtySql = hasReturns
        ? `LEFT JOIN (
             SELECT r.sale_id, ri.product_id,
                    COALESCE(SUM(ri.quantity),0) AS returned_qty,
                    COALESCE(SUM(ri.subtotal),0) AS returned_subtotal
               FROM ${quoteIdent(returnTable)} r
               JOIN ${quoteIdent(returnItemsTable)} ri ON ri.return_id = r.id
              GROUP BY r.sale_id, ri.product_id
           ) rr ON rr.sale_id = ir.sale_id AND rr.product_id = ir.product_id`
        : '';
      const returnedSubtotalExpr = hasReturns ? 'COALESCE(rr.returned_subtotal,0)' : '0';
      const returnedQtyExpr = hasReturns ? 'COALESCE(rr.returned_qty,0)' : '0';
      const directTotalSql = `
        WITH item_rows AS (
          SELECT v.${quoteIdent(salesIdCol)} AS sale_id,
                 vi.${quoteIdent(siProductIdCol)} AS product_id,
                 COALESCE(SUM(vi.${quoteIdent(siQtyCol)}),0) AS quantity,
                 COALESCE(SUM(${siSubCol ? `vi.${quoteIdent(siSubCol)}` : `vi.${quoteIdent(siQtyCol)} * 0`}),0) AS subtotal
            FROM ${quoteIdent(saleItemsTable)} vi
            JOIN ${quoteIdent(salesTable)} v ON v.${quoteIdent(salesIdCol)} = vi.${quoteIdent(siSaleIdCol)}
            JOIN ${quoteIdent(productsTable)} p ON p.${quoteIdent(prodIdCol)} = vi.${quoteIdent(siProductIdCol)}
           WHERE ${itemWhere.join(' AND ')}
           GROUP BY v.${quoteIdent(salesIdCol)}, vi.${quoteIdent(siProductIdCol)}
        )
        SELECT ${soldMedicineMetaSelect('p', prodMetaCols)},
               COALESCE(SUM(GREATEST(ir.subtotal - ${returnedSubtotalExpr},0)),0) AS direct_total
          FROM item_rows ir
          JOIN ${quoteIdent(productsTable)} p ON p.${quoteIdent(prodIdCol)} = ir.product_id
          ${returnQtySql}
         GROUP BY ${soldMedicineMetaGroup('p', prodMetaCols)}
      `;
      const totalRes = await query(directTotalSql, params, db);
      for (const row of totalRes.rows || []) {
        const item = ensureSoldMedicineRow(rowsByProduct, row);
        if (!item) continue;
        const directTotal = Number(row.direct_total || 0);
        item.direct_total = Number((item.direct_total + (Number.isFinite(directTotal) ? directTotal : 0)).toFixed(2));
      }

      const fallbackParams = [];
      const fallbackWhere = [`${soldMedicineTypeExpr('p', prodTypeCol)} = 'medicamento'`];
      addSaleFilters(fallbackWhere, fallbackParams, {
        startDate,
        endDate,
        branchId,
        dateCol: salesDateCol,
        branchCol: salesBranchCol,
        saleAlias: 'v'
      });
      const noLotClause = hasLotSales
        ? `AND NOT EXISTS (
             SELECT 1
               FROM ${quoteIdent(lotSalesTable)} ls2
               JOIN ${quoteIdent(lotsTable)} l2 ON l2.id = ls2.lot_id
              WHERE ls2.sale_id = ir.sale_id
                AND l2.product_id = ir.product_id
                AND COALESCE(ls2.sale_product_id, l2.product_id) = ir.product_id
           )`
        : '';
      const fallbackSql = `
        WITH item_rows AS (
          SELECT v.${quoteIdent(salesIdCol)} AS sale_id,
                 vi.${quoteIdent(siProductIdCol)} AS product_id,
                 COALESCE(SUM(vi.${quoteIdent(siQtyCol)}),0) AS quantity
            FROM ${quoteIdent(saleItemsTable)} vi
            JOIN ${quoteIdent(salesTable)} v ON v.${quoteIdent(salesIdCol)} = vi.${quoteIdent(siSaleIdCol)}
            JOIN ${quoteIdent(productsTable)} p ON p.${quoteIdent(prodIdCol)} = vi.${quoteIdent(siProductIdCol)}
           WHERE ${fallbackWhere.join(' AND ')}
           GROUP BY v.${quoteIdent(salesIdCol)}, vi.${quoteIdent(siProductIdCol)}
        )
        SELECT ${soldMedicineMetaSelect('p', prodMetaCols)},
               COALESCE(SUM(GREATEST(ir.quantity - ${returnedQtyExpr},0)),0) AS direct_qty,
               COUNT(DISTINCT ir.sale_id)::INT AS sale_count
          FROM item_rows ir
          JOIN ${quoteIdent(productsTable)} p ON p.${quoteIdent(prodIdCol)} = ir.product_id
          ${returnQtySql}
         WHERE 1=1 ${noLotClause}
         GROUP BY ${soldMedicineMetaGroup('p', prodMetaCols)}
      `;
      const fallbackRes = await query(fallbackSql, fallbackParams, db);
      for (const row of fallbackRes.rows || []) {
        const item = ensureSoldMedicineRow(rowsByProduct, row);
        if (!item) continue;
        const directQty = Number(row.direct_qty || 0);
        item.direct_qty += Number.isFinite(directQty) ? directQty : 0;
        item.sale_count += Number(row.sale_count || 0) || 0;
      }
    }
  }

  return Array.from(rowsByProduct.values())
    .map((row) => ({
      ...row,
      direct_qty: Number(row.direct_qty.toFixed(2)),
      combo_qty: Number(row.combo_qty.toFixed(2)),
      total_qty: Number((row.direct_qty + row.combo_qty).toFixed(2)),
      direct_total: Number(row.direct_total.toFixed(2)),
      sale_count: Number(row.sale_count || 0)
    }))
    .filter((row) => row.total_qty > 0 || row.direct_total > 0)
    .sort((a, b) => Number(b.total_qty || 0) - Number(a.total_qty || 0) || Number(b.direct_total || 0) - Number(a.direct_total || 0))
    .slice(0, limit);
}

function buildTopSoldMedicinesWorkbook(rows, label) {
  const dataRows = [
    ['Medicamentos más vendidos'],
    [label || ''],
    [],
    ['#', 'Medicamento', 'Código', 'Presentación', 'Casa', 'Cantidad neta', 'Venta directa', 'En combos', 'Monto directo', 'Ventas']
  ];
  rows.forEach((row, idx) => {
    dataRows.push([
      idx + 1,
      row.nombre || '',
      row.codigo || '',
      row.presentacion || '',
      row.casa || '',
      Number(row.total_qty || 0),
      Number(row.direct_qty || 0),
      Number(row.combo_qty || 0),
      Number(row.direct_total || 0),
      Number(row.sale_count || 0)
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(dataRows);
  ws['!cols'] = [
    { wch: 6 },
    { wch: 42 },
    { wch: 18 },
    { wch: 32 },
    { wch: 20 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 }
  ];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '0F4C81' } },
    alignment: { horizontal: 'center', vertical: 'center' }
  };
  for (let c = 0; c <= 9; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: 3, c });
    if (ws[addr]) ws[addr].s = headerStyle;
  }
  if (ws.A1) {
    ws.A1.s = {
      font: { bold: true, sz: 16, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center' }
    };
  }
  const moneyFmt = '"Q" #,##0.00';
  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 4; r <= range.e.r; r += 1) {
      for (const c of [5, 6, 7]) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) ws[addr].s = { ...(ws[addr].s || {}), numFmt: '#,##0.00' };
      }
      const moneyAddr = XLSX.utils.encode_cell({ r, c: 8 });
      if (ws[moneyAddr]) ws[moneyAddr].s = { ...(ws[moneyAddr].s || {}), numFmt: moneyFmt };
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Más vendidos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function isHospitalReceipt(sale, pagos) {
  const note = String(sale?.note || '').toLowerCase();
  const noteHasHosp =
    note.includes('hospitalizacion') ||
    note.includes('hospitalización') ||
    note.includes('hospital');
  const noteHasEmerg = note.includes('emergencia');
  if (noteHasHosp && !noteHasEmerg) return true;
  for (const p of pagos || []) {
    if (!p) continue;
    let det =
      p.payment_method_details ??
      p.det ??
      p.detalles ??
      p.meta ??
      null;
    if (!det) continue;
    if (typeof det === 'string') {
      try {
        det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
    }
    if (!det || typeof det !== 'object') continue;
    const tipoRaw = det.origen ?? det.origin ?? det.tipo ?? det.type ?? '';
    const tipo = String(tipoRaw || '').toLowerCase();
    if (tipo.includes('emergencia')) return false;
    if (tipo.includes('hospital')) return true;
    if (tipo.includes('hospitalizacion') || tipo.includes('hospitalización')) return true;
  }
  return false;
}

async function fetchSaleDetails(db, saleId) {
  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleItemsTable = await pickTable(db, ['venta_items', 'detalle_venta', 'sale_items'], 'venta_items');
  const usersTable = await pickTable(db, ['users', 'usuarios'], 'users');
  const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');

  const salesIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
  const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
  const salesUserCol = await pickColumn(db, salesTable, ['usuario_id', 'user_id', 'cajero_id'], null);
  const salesTotalCol = await pickColumn(
    db,
    salesTable,
    ['total', 'monto_total', 'importe_total', 'amount_total'],
    'total'
  );
  const salesNoteCol = await pickColumn(db, salesTable, ['note', 'nota', 'motivo', 'observacion'], null);
  const salesCustomerTypeCol = await pickColumn(db, salesTable, ['cliente_tipo', 'tipo_cliente', 'customer_type'], null);
  const salesCustomerDocCol = await pickColumn(
    db,
    salesTable,
    ['cliente_documento', 'documento_cliente', 'customer_document', 'nit', 'cui'],
    null
  );
  const salesNitCol =
    salesCustomerDocCol === 'nit' ? 'nit' : await pickColumn(db, salesTable, ['nit'], null);
  const salesCuiCol =
    salesCustomerDocCol === 'cui' ? 'cui' : await pickColumn(db, salesTable, ['cui'], null);

  const userNameCol = usersTable
    ? await pickColumn(db, usersTable, ['username', 'nombre', 'name', 'usuario'], 'username')
    : null;

  const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
  const siProductIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
  const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], 'cantidad');
  const siUnitPriceCol = await pickColumn(
    db,
    saleItemsTable,
    ['precio_unit', 'precio_unitario', 'unit_price'],
    'precio_unit'
  );
  const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], null);

  const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
  const prodNameCol = await pickColumn(db, productsTable, ['nombre_comercial', 'name', 'nombre'], 'nombre_comercial');

  const paySaleIdCol = await pickColumn(db, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
  const payTypeCol = await pickColumn(db, paymentsTable, ['payment_type', 'tipo_pago', 'forma', 'metodo'], 'payment_type');
  const payAmountCol = await pickColumn(db, paymentsTable, ['amount', 'monto', 'importe', 'total'], 'amount');
  const payDetCol = await pickColumn(
    db,
    paymentsTable,
    ['payment_method_details', 'metodo_detalle', 'method_details', 'detalles', 'meta'],
    'payment_method_details'
  );

  const saleRes = await query(
    `SELECT ${salesIdCol} AS id, ${salesDateCol ? salesDateCol : 'NULL'} AS fecha, ${
      salesUserCol ? salesUserCol : 'NULL'
    } AS usuario_id, ${salesTotalCol ? salesTotalCol : 'NULL'} AS total, ${
      salesNoteCol ? salesNoteCol : 'NULL'
    } AS note ${salesCustomerTypeCol ? `, ${salesCustomerTypeCol} AS cliente_tipo` : ', NULL AS cliente_tipo'} ${
      salesCustomerDocCol ? `, ${salesCustomerDocCol} AS cliente_documento` : ', NULL AS cliente_documento'
    } ${salesNitCol ? `, ${salesNitCol} AS nit` : ', NULL AS nit'} ${
      salesCuiCol ? `, ${salesCuiCol} AS cui` : ', NULL AS cui'
    } FROM ${salesTable} WHERE ${salesIdCol} = $1 LIMIT 1`,
    [saleId],
    db
  );
  const sale = saleRes.rows[0];
  if (!sale) return null;

  let username = '';
  if (sale.usuario_id && usersTable && userNameCol) {
    const us = await query(`SELECT ${userNameCol} AS uname FROM ${usersTable} WHERE id = $1`, [sale.usuario_id], db);
    username = us.rows[0]?.uname ? String(us.rows[0].uname) : '';
  }

  let items = [];
  if (saleItemsTable) {
    const itRes = await query(
      `SELECT si.${siProductIdCol} AS producto_id, si.${siQtyCol} AS cantidad, si.${siUnitPriceCol} AS precio_unit ${
        siSubCol ? `, si.${siSubCol} AS subtotal` : ''
      }, p.${prodNameCol} AS producto
       FROM ${saleItemsTable} si
       JOIN ${productsTable} p ON p.${prodIdCol} = si.${siProductIdCol}
       WHERE si.${siSaleIdCol} = $1`,
      [saleId],
      db
    );
    items = itRes.rows || [];
  }

  let pagos = [];
  if (paymentsTable) {
    const payRes = await query(
      `SELECT ${payTypeCol} AS payment_type, ${payAmountCol} AS amount ${
        payDetCol ? `, ${payDetCol} AS det` : ''
      } FROM ${paymentsTable} WHERE ${paySaleIdCol} = $1`,
      [saleId],
      db
    );
    pagos = payRes.rows || [];
  }

  const returns = await fetchSaleReturnSummary(db, saleId);

  return { sale, username, items, pagos, returns };
}

router.post(
  '/checkout',
  validateBody(validationSchemas.saleCheckoutSchema),
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);
    if (!['user', 'cashier', 'cashiee', 'admin', 'farmacia', 'superadmin'].includes(userRole)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }

    const input = req.validatedBody || readJson(req);
    const items = Array.isArray(input.items) ? input.items : [];
    const services = Array.isArray(input.services) ? input.services : [];
    if (!items.length && !services.length) {
      return safeJson(res, { ok: false, error: 'No hay ítems en la venta' }, 400);
    }

    const paymentType = input.payment_type || input.payment_form || 'efectivo';
    const customerType = input.customer_type || 'consumidor_final';
    const customerDocument = input.customer_document || '';
    const note = input.note || null;
    let branchId = input.branch_id != null && input.branch_id !== '' ? Number(input.branch_id) : null;
    if (!branchId && req.session?.branch_id) {
      const sessionBranch = Number(req.session.branch_id);
      if (Number.isFinite(sessionBranch) && sessionBranch > 0) branchId = sessionBranch;
    }

    if (branchId && !(await branchAllowedForRole(null, branchId, userRole))) {
      const msg =
        userRole === 'cashierh'
          ? 'Sólo puede operar ventas en Hospitalización'
          : 'Su rol sólo permite ventas en Principal o Emergencia';
      return safeJson(res, { ok: false, error: msg }, 403);
    }

    let total = 0;
    const normalizedItems = [];
    for (const it of items) {
      const pid = Number(it.producto_id || 0);
      const qty = Number(it.cantidad || 0);
      const pu = safeNumber(it.precio_unit) || 0;
      if (pid <= 0 || qty <= 0 || pu < 0) continue;
      const subtotal = qty * pu;
      normalizedItems.push({ producto_id: pid, cantidad: qty, precio_unit: pu, subtotal });
      total += subtotal;
    }
    for (const sv of services) {
      const amt = safeNumber(sv.monto) || 0;
      if (amt > 0) total += amt;
    }
    if (total <= 0) {
      return safeJson(res, { ok: false, error: 'Total inválido' }, 400);
    }

    const userId = req.session.user.id || null;
    const ventaId = await withTransaction(async (db) => {
      const cols = await getColumns(db, 'ventas');
      const fechaCol = cols.includes('fecha') ? 'fecha' : cols.includes('created_at') ? 'created_at' : null;
      const saleIns = await query(
        `INSERT INTO ventas (usuario_id, total, ${fechaCol || 'fecha'}) VALUES ($1,$2,NOW()) RETURNING id`,
        [userId, total],
        db
      );
      const id = Number(saleIns.rows[0].id);

      for (const it of normalizedItems) {
        await query(
          'INSERT INTO venta_items (venta_id, producto_id, cantidad, precio_unit, subtotal) VALUES ($1,$2,$3,$4,$5)',
          [id, it.producto_id, it.cantidad, it.precio_unit, it.subtotal],
          db
        );
        await query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [it.cantidad, it.producto_id], db);
      }

      if (await tableExists(db, 'payments')) {
        const payCols = await getColumns(db, 'payments');
        const hasCreated = payCols.includes('created_at');
        const details = {
          forma: paymentType,
          cliente_tipo: customerType,
          cliente_doc: customerDocument,
          nota: note,
          services
        };
        const isCredit = String(paymentType).toLowerCase().startsWith('cred') ? 1 : 0;
        const sql = hasCreated
          ? 'INSERT INTO payments (sale_id, purchase_id, branch_id, user_id, amount, payment_type, payment_method_details, is_credit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())'
          : 'INSERT INTO payments (sale_id, purchase_id, branch_id, user_id, amount, payment_type, payment_method_details, is_credit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
        await query(
          sql,
          [
            id,
            null,
            branchId,
            userId,
            total,
            paymentType,
            JSON.stringify(details),
            isCredit
          ],
          db
        );
      }

      if (await tableExists(db, 'cajas')) {
        const colsCaja = await getColumns(db, 'cajas');
        const userCol = colsCaja.includes('user_id') ? 'user_id' : null;
        const branchCol = colsCaja.includes('branch_id') ? 'branch_id' : null;
        let cajaId = input.caja_id ? Number(input.caja_id) : null;
        if (!cajaId && userCol && userId) {
          let sqlCaja =
            "SELECT id FROM cajas WHERE (estado='ABIERTA' OR estado IS NULL) AND fecha_cierre IS NULL AND " +
            `${userCol} = $1`;
          const params = [userId];
          if (branchCol && branchId) {
            sqlCaja += ` AND ${branchCol} = $2`;
            params.push(branchId);
          }
          sqlCaja += ' ORDER BY id DESC LIMIT 1';
          const cajaRes = await query(sqlCaja, params, db);
          cajaId = cajaRes.rows[0]?.id || null;
        }
        if (cajaId) {
          await query('UPDATE cajas SET total_ventas = COALESCE(total_ventas,0) + $1 WHERE id = $2', [
            total,
            cajaId
          ]);
        }
      }

      return id;
    });

    return safeJson(res, { ok: true, venta_id: ventaId, payment_type: paymentType, total });
  })
);

router.post(
  '/register_sale',
  validateBody(validationSchemas.saleRegisterSchema),
  idempotency({ scope: 'POST /api/register_sale' }),
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);
    if (!['user', 'cashier', 'cashiee', 'admin', 'farmacia', 'superadmin'].includes(userRole)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }
    const input = req.validatedBody || readJson(req);
    const userId = req.session.user.id || 0;
    let branchId = input.branch_id != null && input.branch_id !== '' ? Number(input.branch_id) : null;
    const sessionBranch = req.session.branch_id ? Number(req.session.branch_id) : null;
    if ((!branchId || branchId <= 0) && sessionBranch) branchId = sessionBranch;
    if (userRole === 'cashier' || userRole === 'farmacia') {
      const principalId = await branchIdByHint(null, 'principal');
      if (principalId) branchId = principalId;
    } else if (userRole === 'cashiee') {
      const emergId = await branchIdByHint(null, 'emergencia');
      if (emergId) branchId = emergId;
    }
    const note = input.note != null ? String(input.note).trim() : null;
    const clienteTipo = input.cliente_tipo != null ? String(input.cliente_tipo) : null;
    const clienteDocumento = input.cliente_documento != null ? String(input.cliente_documento) : null;
    const cajaIdInput = input.caja_id != null && input.caja_id !== '' ? Number(input.caja_id) : null;

    if (!branchId || branchId <= 0) {
      return safeJson(res, { ok: false, error: 'Seleccione una sucursal antes de registrar la venta' }, 400);
    }
    req.session.branch_id = branchId;

    const cajaCheck = await validateOpenCajaForSale(null, cajaIdInput, userId, branchId, userRole);
    if (!cajaCheck.ok) {
      return safeJson(res, { ok: false, error: cajaCheck.error }, 400);
    }
    const cajaId = cajaCheck.cajaId;

    const itemsInput = Array.isArray(input.items) ? input.items : [];
    const services = Array.isArray(input.services) ? input.services : [];
    const ventaSinProducto = !!input.venta_sin_producto;
    const cantidadCobro = safeNumber(input.cantidad_cobro);

    const items = [];
    for (const it of itemsInput) {
      const pid = Number(it.producto_id || 0);
      const qty = safeNumber(it.cantidad) || 0;
      const pu = safeNumber(it.precio_unit) || 0;
      if (pid > 0 && qty > 0 && pu >= 0) {
        items.push({ producto_id: pid, cantidad: qty, precio_unit: pu, subtotal: qty * pu });
      }
    }

    const paymentMethod = String(input.payment_method || 'efectivo');
    const paymentTerms = String(input.payment_terms || 'contado');
    const discountPercent = input.discount_percent != null ? safeNumber(input.discount_percent) : null;
    const nombreComprobante = input.nombre_comprobante != null ? String(input.nombre_comprobante).trim() : '';
    if (!nombreComprobante) {
      return safeJson(
        res,
        { ok: false, error: 'El campo "A nombre de quién saldrá el comprobante" es obligatorio.' },
        400
      );
    }
    const splitInput = input.payment_split || null;
    const splitCash = splitInput && splitInput.efectivo != null ? safeNumber(splitInput.efectivo) : null;
    const splitCard = splitInput && splitInput.tarjeta != null ? safeNumber(splitInput.tarjeta) : null;
    const cashReceivedInput = input.efectivo_recibido != null ? safeNumber(input.efectivo_recibido) : null;

    const servicesNorm = [];
    if (services.length) {
      const receiptNameNorm = normalizeLooseText(nombreComprobante);
      for (const sv of services) {
        const amt = safeNumber(sv.monto) || 0;
        const desc = String(sv.descripcion || 'Servicio').trim();
        if (amt <= 0) continue;
        if (receiptNameNorm && normalizeLooseText(desc) === receiptNameNorm) continue;
        const productId = Number(sv.producto_id || sv.product_id || 0) || null;
        servicesNorm.push({ monto: amt, descripcion: desc, producto_id: productId });
      }
    }

    if (ventaSinProducto) {
      if (!cantidadCobro || cantidadCobro <= 0) {
        return safeJson(res, { ok: false, error: 'Monto para venta sin producto inválido' }, 400);
      }
    } else {
      if (!items.length && !servicesNorm.length) {
        return safeJson(res, { ok: false, error: 'Sin ítems válidos' }, 400);
      }
    }

    const result = await withTransaction(async (db) => {
      const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
      const saleItemsTable = await pickTable(db, ['venta_items', 'detalle_venta', 'sale_items'], 'venta_items');
      const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
      const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
      await ensureProductTypeColumn(db);
      await ensureComboItemsTable(db);
      await ensureLotSaleProductColumn(db);

      const salesIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
      const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
      const salesUserCol = await pickColumn(db, salesTable, ['usuario_id', 'user_id', 'cajero_id'], 'usuario_id');
      const salesTotalCol = await pickColumn(
        db,
        salesTable,
        ['total', 'monto_total', 'importe_total', 'amount_total'],
        'total'
      );
      const noteCol = await pickColumn(db, salesTable, ['note', 'nota', 'motivo', 'observacion'], null);
      const cliTipoCol = await pickColumn(db, salesTable, ['cliente_tipo', 'tipo_cliente'], null);
      const cliDocCol = await pickColumn(db, salesTable, ['cliente_documento', 'documento_cliente', 'nit', 'cui'], null);
      const cajaIdCol = await pickColumn(db, salesTable, ['caja_id', 'cashbox_id', 'id_caja'], null);
      const branchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);

      const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
      const siProdIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
      const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], 'cantidad');
      const siUnitCol = await pickColumn(db, saleItemsTable, ['precio_unit', 'precio_unitario', 'unit_price'], 'precio_unit');
      const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], 'subtotal');

      const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
      const prodStockCol = await pickColumn(db, productsTable, ['stock', 'existencias', 'cantidad'], 'stock');

      const expiringAlerts = [];
      const saleItemLines = [];
      const lotMoves = [];
      const productQty = new Map();
      const servicesTotal = servicesNorm.reduce((sum, s) => sum + s.monto, 0);
      let itemsTotal = 0;
      const hasInventoryMovements = await tableExists(db, 'inventario_movimientos');

      if (!ventaSinProducto && items.length && (await tableExists(db, saleItemsTable))) {
        const hasLots = await tableExists(db, 'lots');
        if (!hasLots) {
          throw new Error('No hay control de lotes configurado');
        }
        const hasLotSales = await tableExists(db, 'lot_sales');
        if (!hasLotSales) {
          throw new Error('No existe la tabla de lotes para ventas');
        }
        const hasLotSalePrice = await ensureLotSalePriceColumn(db);

        const prodNameCol = await pickColumn(db, productsTable, ['nombre_comercial', 'name', 'nombre'], null);
        const prodPriceCol = await pickColumn(db, productsTable, ['precio_publico', 'sale_price', 'price'], 'precio_publico');
        const productIds = items.map((r) => r.producto_id);
        const productMetaMap = new Map();
        if (productIds.length) {
          const prodRes = await query(
            `SELECT ${prodIdCol} AS id,
                    ${prodNameCol ? prodNameCol : prodIdCol} AS name,
                    ${prodPriceCol} AS price,
                    COALESCE(tipo, 'medicamento') AS tipo
               FROM ${productsTable}
              WHERE ${prodIdCol} = ANY($1)`,
            [productIds],
            db
          );
          for (const row of prodRes.rows || []) {
            productMetaMap.set(Number(row.id), {
              name: row.name || null,
              price: Number(row.price || 0),
              type: normalizeProductType(row.tipo)
            });
          }
        }
        const comboIds = items
          .filter((row) => productTypeIsCombo(productMetaMap.get(Number(row.producto_id || 0))?.type))
          .map((row) => Number(row.producto_id || 0))
          .filter(Boolean);
        const comboComponentsMap = await fetchComboComponents(db, comboIds);

        for (const r of items) {
          if (!productMetaMap.has(r.producto_id)) {
            throw unprocessable(`No existe el producto ${r.producto_id}`, 'PRODUCT_NOT_FOUND');
          }
          const productMeta = productMetaMap.get(r.producto_id) || {
            name: null,
            price: Number(r.precio_unit || 0),
            type: 'medicamento'
          };
          const productLabel = productMeta.name || `Producto ${r.producto_id}`;
          const productType = normalizeProductType(productMeta.type);
          if (!productTypeUsesInventory(productType) && !productTypeIsCombo(productType)) {
            throw unprocessable(`El producto ${productLabel} debe agregarse como servicio, no como medicamento`, 'PRODUCT_IS_SERVICE');
          }

          const lotSelect = hasLotSalePrice ? 'sale_price' : 'NULL AS sale_price';
          const requestedLotRaw =
            r.lot_number ??
            r.lote ??
            r.lot ??
            r.barcode ??
            r.codigo_barra ??
            r.codigo_barras ??
            null;
          const requestedLot = requestedLotRaw != null ? String(requestedLotRaw).trim() : '';

          if (productTypeUsesInventory(productType)) {
            const missingExpiry = await query(
              'SELECT COUNT(*) AS c FROM lots WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date IS NULL',
              [r.producto_id, branchId],
              db
            );
            if (Number(missingExpiry.rows[0]?.c || 0) > 0) {
              throw conflict(`Producto ${productLabel} tiene lotes sin fecha de vencimiento`, 'LOT_WITHOUT_EXPIRY');
            }

            const lotsRes = requestedLot
              ? await query(
                  `SELECT id, lot_number, expiry_date, quantity, created_at, ${lotSelect}
                   FROM lots
                    WHERE product_id = $1 AND branch_id = $2 AND LOWER(lot_number) = LOWER($3)
                      AND quantity > 0 AND expiry_date >= CURRENT_DATE
                   ORDER BY expiry_date ASC, created_at ASC, id ASC
                   FOR UPDATE`,
                  [r.producto_id, branchId, requestedLot],
                  db
                )
              : await query(
                  `SELECT id, lot_number, expiry_date, quantity, created_at, ${lotSelect}
                   FROM lots
                   WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date >= CURRENT_DATE
                   ORDER BY expiry_date ASC, created_at ASC, id ASC
                   FOR UPDATE`,
                  [r.producto_id, branchId],
                  db
                );
            const lots = lotsRes.rows || [];
            if (!lots.length) {
              if (requestedLot) {
                throw conflict(`Lote ${requestedLot} no disponible para ${productLabel}`, 'LOT_NOT_AVAILABLE');
              }
              throw conflict(`No hay lotes disponibles para ${productLabel}`, 'OUT_OF_STOCK');
            }

            let remaining = Number(r.cantidad || 0);
            for (const lot of lots) {
              if (remaining <= 0) break;
              const available = Number(lot.quantity || 0);
              if (available <= 0) continue;
              const take = Math.min(available, remaining);
              if (take <= 0) continue;
              let unitPrice = Number(lot.sale_price || 0);
              if (!unitPrice || Number.isNaN(unitPrice)) {
                unitPrice = Number(productMeta.price || 0);
              }
              const subtotal = unitPrice * take;
              saleItemLines.push({
                producto_id: r.producto_id,
                cantidad: take,
                precio_unit: unitPrice,
                subtotal
              });
              itemsTotal += subtotal;
              lotMoves.push({
                lot_id: lot.id,
                quantity: take,
                product_id: r.producto_id,
                sale_product_id: r.producto_id,
                branch_id: branchId
              });
              remaining -= take;

              const days = daysUntil(lot.expiry_date);
              if (days != null && days <= LOT_EXPIRY_ALERT_DAYS) {
                expiringAlerts.push({
                  product_id: r.producto_id,
                  producto: productLabel,
                  lot_number: lot.lot_number || null,
                  expiry_date: isoDate(lot.expiry_date),
                  days_left: days
                });
              }
            }

            if (remaining > 0) {
              if (requestedLot) {
                throw conflict(`Stock insuficiente para lote ${requestedLot} (${productLabel})`, 'INSUFFICIENT_STOCK');
              }
              throw conflict(`Stock insuficiente por lote para ${productLabel}`, 'INSUFFICIENT_STOCK');
            }

            const current = productQty.get(r.producto_id) || 0;
            productQty.set(r.producto_id, current + Number(r.cantidad || 0));
            continue;
          }

          const comboComponents = comboComponentsMap.get(r.producto_id) || [];
          if (!comboComponents.length) {
            throw unprocessable(`El combo ${productLabel} no tiene componentes configurados`, 'COMBO_INVALID');
          }

          const comboQty = Number(r.cantidad || 0);
          const comboUnitPrice = Number(productMeta.price || 0);
          saleItemLines.push({
            producto_id: r.producto_id,
            cantidad: comboQty,
            precio_unit: comboUnitPrice,
            subtotal: comboQty * comboUnitPrice
          });
          itemsTotal += comboQty * comboUnitPrice;
          let hasTrackedComponent = false;

          for (const component of comboComponents) {
            const componentProductId = Number(component.component_product_id || 0);
            const componentQty = Number(component.quantity || 0) * comboQty;
            if (!componentProductId || componentQty <= 0) continue;
            const componentLabel = component.nombre_comercial || `Producto ${componentProductId}`;
            const componentType = normalizeProductType(component.tipo);
            if (productTypeIsCombo(componentType)) {
              throw unprocessable(`El combo ${productLabel} no puede incluir el combo ${componentLabel}`, 'COMBO_INVALID');
            }
            if (!productTypeUsesInventory(componentType)) {
              continue;
            }
            hasTrackedComponent = true;
            const missingExpiry = await query(
              'SELECT COUNT(*) AS c FROM lots WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date IS NULL',
              [componentProductId, branchId],
              db
            );
            if (Number(missingExpiry.rows[0]?.c || 0) > 0) {
              throw conflict(`El componente ${componentLabel} del combo ${productLabel} tiene lotes sin fecha de vencimiento`, 'LOT_WITHOUT_EXPIRY');
            }
            const lotsRes = await query(
              `SELECT id, lot_number, expiry_date, quantity, created_at, ${lotSelect}
                 FROM lots
                WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date >= CURRENT_DATE
                ORDER BY expiry_date ASC, created_at ASC, id ASC
                FOR UPDATE`,
              [componentProductId, branchId],
              db
            );
            const lots = lotsRes.rows || [];
            if (!lots.length) {
              throw conflict(`El producto ${componentLabel} que pertenece al combo ${productLabel} no tiene stock`, 'OUT_OF_STOCK');
            }

            let remainingComponent = componentQty;
            for (const lot of lots) {
              if (remainingComponent <= 0) break;
              const available = Number(lot.quantity || 0);
              if (available <= 0) continue;
              const take = Math.min(available, remainingComponent);
              if (take <= 0) continue;
              lotMoves.push({
                lot_id: lot.id,
                quantity: take,
                product_id: componentProductId,
                sale_product_id: r.producto_id,
                branch_id: branchId
              });
              remainingComponent -= take;

              const days = daysUntil(lot.expiry_date);
              if (days != null && days <= LOT_EXPIRY_ALERT_DAYS) {
                expiringAlerts.push({
                  product_id: componentProductId,
                  producto: componentLabel,
                  lot_number: lot.lot_number || null,
                  expiry_date: isoDate(lot.expiry_date),
                  days_left: days
                });
              }
            }

            if (remainingComponent > 0) {
              throw conflict(`El producto ${componentLabel} que pertenece al combo ${productLabel} no tiene stock suficiente`, 'INSUFFICIENT_STOCK');
            }

            const current = productQty.get(componentProductId) || 0;
            productQty.set(componentProductId, current + componentQty);
          }

          if (!hasTrackedComponent) {
            throw unprocessable(`El combo ${productLabel} no tiene medicamentos configurados para descontar stock`, 'COMBO_INVALID');
          }
        }
      }

      const grossTotal = ventaSinProducto ? cantidadCobro : itemsTotal + servicesTotal;
      const { discountAmount, saleTotal } = resolvePercentDiscountTotals(grossTotal, discountPercent);

      let cashReceived = null;
      let cashChange = null;
      const normalizeMoneyValue = (value) =>
        value != null && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;

      // Evita ventas en efectivo con monto recibido menor al total (o al efectivo en mixto)
      if (paymentTerms !== 'credito' && paymentTerms !== 'crédito') {
        if (paymentMethod === 'efectivo' && cashReceivedInput != null) {
          cashReceived = normalizeMoneyValue(cashReceivedInput);
          cashChange = normalizeMoneyValue(cashReceived - saleTotal);
          if (cashChange == null || cashChange < -0.01) {
            throw unprocessable('El monto recibido es menor al total', 'CASH_INSUFFICIENT');
          }
        }
        if (paymentMethod === 'mixto' && splitCash != null && splitCash >= 0 && cashReceivedInput != null) {
          cashReceived = normalizeMoneyValue(cashReceivedInput);
          cashChange = normalizeMoneyValue(cashReceived - splitCash);
          if (cashChange == null || cashChange < -0.01) {
            throw unprocessable('El monto recibido es menor al efectivo a cobrar', 'CASH_INSUFFICIENT');
          }
        }
      }

      const cols = [];
      const vals = [];
      if (salesDateCol) {
        cols.push(salesDateCol);
        vals.push(new Date());
      }
      if (salesUserCol && userId) {
        cols.push(salesUserCol);
        vals.push(userId);
      }
      if (salesTotalCol) {
        cols.push(salesTotalCol);
        vals.push(saleTotal);
      }
      if (noteCol && note) {
        cols.push(noteCol);
        vals.push(note);
      }
      if (cliTipoCol && clienteTipo) {
        cols.push(cliTipoCol);
        vals.push(clienteTipo);
      }
      if (cliDocCol && clienteDocumento) {
        cols.push(cliDocCol);
        vals.push(clienteDocumento);
      }
      if (cajaIdCol && cajaId) {
        cols.push(cajaIdCol);
        vals.push(cajaId);
      }
      if (branchCol && branchId) {
        cols.push(branchCol);
        vals.push(branchId);
      }

      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(',');
      const saleIns = await query(
        `INSERT INTO ${salesTable} (${cols.join(',')}) VALUES (${placeholders}) RETURNING ${salesIdCol} AS id`,
        vals,
        db
      );
      const ventaId = Number(saleIns.rows[0].id);
      // Idempotencia: la llave queda ligada a esta venta dentro de la misma transacción.
      if (req.idempotency) {
        await req.idempotency.markCommitted(db, ventaId);
      }

      if (!ventaSinProducto && saleItemLines.length && (await tableExists(db, saleItemsTable))) {
        for (const line of saleItemLines) {
          await query(
            `INSERT INTO ${saleItemsTable} (${siSaleIdCol},${siProdIdCol},${siQtyCol},${siUnitCol},${siSubCol}) VALUES ($1,$2,$3,$4,$5)`,
            [ventaId, line.producto_id, line.cantidad, line.precio_unit, line.subtotal],
            db
          );
        }
        for (const mv of lotMoves) {
          await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [mv.quantity, mv.lot_id], db);
          logAuditEvent({
            action: 'lot_adjusted',
            branch_id: mv.branch_id || null,
            user_id: userId || null,
            product_id: mv.product_id || null,
            delta: -1 * Number(mv.quantity || 0)
          });
          await query(
            'INSERT INTO lot_sales (sale_id, lot_id, quantity, sale_product_id) VALUES ($1,$2,$3,$4)',
            [ventaId, mv.lot_id, mv.quantity, mv.sale_product_id || mv.product_id || null],
            db
          );
        }
        if (branchId && (await productStocksAvailable(db))) {
          for (const [pid, qty] of productQty.entries()) {
            await adjustBranchStock(db, pid, branchId, -1 * qty);
            if (hasInventoryMovements) {
              await query(
                'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
                [pid, -1 * qty, 'venta', String(ventaId), note || null],
                db
              );
            }
          }
        } else if (prodStockCol) {
          for (const [pid, qty] of productQty.entries()) {
            await query(
              `UPDATE ${productsTable} SET ${prodStockCol} = CASE WHEN ${prodStockCol} - $1 < 0 THEN 0 ELSE ${prodStockCol} - $1 END WHERE ${prodIdCol} = $2`,
              [qty, pid],
              db
            );
            if (hasInventoryMovements) {
              await query(
                'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
                [pid, -1 * qty, 'venta', String(ventaId), note || null],
                db
              );
            }
          }
        }
        if (branchId) {
          for (const [pid] of productQty.entries()) {
            await updateProductCostFromLots(db, pid, branchId);
            await updateProductSalePriceFromLots(db, pid, branchId);
          }
        }
      }

      if (hasInventoryMovements) {
        await ensureMovementsProductNullable(db);
        const serviceMovements = [];
        if (ventaSinProducto) {
          const desc = note ? `Venta sin producto: ${note}` : 'Venta sin producto';
          serviceMovements.push({ desc, amount: Number(cantidadCobro || 0) });
        } else if (servicesNorm.length) {
          for (const sv of servicesNorm) {
            const desc = String(sv.descripcion || 'Servicio').trim();
            const amount = Number(sv.monto || 0);
            if (amount > 0) serviceMovements.push({ desc, amount });
          }
        }
        for (const sv of serviceMovements) {
          const label = sv.desc || 'Servicio';
          const notes = `${label} | Q${Number(sv.amount || 0).toFixed(2)}`;
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [null, 0, 'venta', String(ventaId), notes],
            db
          );
        }
      }

      if (await tableExists(db, paymentsTable)) {
        const paySaleIdCol = await pickColumn(db, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
        const payTypeCol = await pickColumn(db, paymentsTable, ['payment_type', 'tipo_pago', 'forma', 'metodo'], 'payment_type');
        const payAmountCol = await pickColumn(db, paymentsTable, ['amount', 'monto', 'importe', 'total'], 'amount');
        const payBranchCol = await pickColumn(db, paymentsTable, ['branch_id', 'sucursal_id'], 'branch_id');
        const payUserCol = await pickColumn(db, paymentsTable, ['user_id', 'usuario_id'], 'user_id');
        const payDetCol = await pickColumn(
          db,
          paymentsTable,
          ['payment_method_details', 'metodo_detalle', 'method_details'],
          'payment_method_details'
        );
        const payCreditCol = await pickColumn(db, paymentsTable, ['is_credit', 'es_credito'], null);

        const details = {
          forma: paymentMethod,
          terminos: paymentTerms,
          note
        };
        if (clienteTipo) {
          details.cliente_tipo = clienteTipo;
          details.customer_type = clienteTipo;
        }
        if (clienteDocumento) {
          details.cliente_doc = clienteDocumento;
          details.cliente_documento = clienteDocumento;
          details.customer_document = clienteDocumento;
        }
        if (discountPercent != null && discountPercent > 0) {
          details.discount_percent = discountPercent;
          details.discount_amount = Number(discountAmount || 0);
        }
        if (nombreComprobante) {
          details.nombre_comprobante = nombreComprobante;
        }
        if (cashReceived != null && cashReceived >= 0) details.efectivo_recibido = cashReceived;
        if (cashChange != null && cashChange >= 0) details.cambio = cashChange;
        const insertPayment = async (amount, type, extraDetails = {}) => {
          const colsPay = [paySaleIdCol, payBranchCol, payUserCol, payAmountCol, payTypeCol, payDetCol].filter(Boolean);
          const det = { ...details, services: servicesNorm, ...extraDetails };
          const values = [ventaId, branchId, userId, amount, type, JSON.stringify(det)];
          if (payCreditCol) {
            colsPay.push(payCreditCol);
            values.push(0);
          }
          const placeholdersPay = colsPay.map((_, idx) => `$${idx + 1}`).join(',');
          await query(`INSERT INTO ${paymentsTable} (${colsPay.join(',')}) VALUES (${placeholdersPay})`, values, db);
        };

        const hasSplit =
          paymentMethod === 'mixto' &&
          splitCash != null &&
          splitCard != null &&
          splitCash >= 0 &&
          splitCard >= 0 &&
          Math.abs((splitCash + splitCard) - saleTotal) <= 0.01;
        if (hasSplit && (splitCash > 0 || splitCard > 0)) {
          if (splitCash > 0) {
            await insertPayment(splitCash, 'efectivo', {
              split: { efectivo: splitCash, tarjeta: splitCard },
              services: servicesNorm
            });
          }
          if (splitCard > 0) {
            await insertPayment(splitCard, 'tarjeta', {
              split: { efectivo: splitCash, tarjeta: splitCard },
              services: []
            });
          }
        } else {
          await insertPayment(saleTotal, paymentMethod, { services: servicesNorm });
        }
      }

      await logAction(db, userId, 'venta_registrada', {
        venta_id: ventaId,
        total: saleTotal,
        items,
        venta_sin_producto: ventaSinProducto,
        branch_id: branchId
      });

      await autoEntryForSale(db, ventaId, saleTotal, branchId, paymentMethod, paymentTerms, userId);

      return { ventaId, expiringAlerts, total: saleTotal };
    });

    const fel = await certifySaleIfEnabled(null, result.ventaId, {
      userId,
      source: 'ventas'
    }).catch((err) => ({
      ok: false,
      status: 'failed',
      error: err?.message || 'Error FEL'
    }));

    return safeJson(res, {
      ok: true,
      venta_id: result.ventaId,
      total: result.total,
      expiring_alerts: result.expiringAlerts || [],
      fel
    });
  })
);

router.get(
  '/sale_details',
  asyncHandler(async (req, res) => {
    const saleId =
      Number(req.query.id || 0) || Number(req.query.sale_id || 0) || Number(req.query.venta_id || 0);
    if (!saleId) return safeJson(res, { ok: false, error: 'ID de venta inválido' }, 400);
    const ventasT = await pickTable(null, ['ventas', 'sales', 'venta', 'tbl_ventas', 't_ventas'], 'ventas');
    const itemsT = await pickTable(null, ['venta_items', 'detalle_venta', 'sale_items'], 'venta_items');
    const ventIdCol = await pickColumn(null, ventasT, ['id', 'venta_id', 'sale_id', 'id_venta'], 'id');
    const ventTotalCol = await pickColumn(
      null,
      ventasT,
      ['total', 'monto_total', 'importe_total', 'amount_total'],
      'total'
    );
    const ventDateCol = await pickColumn(null, ventasT, ['fecha', 'created_at', 'fecha_venta'], null);
    const ventCajaCol = await pickColumn(null, ventasT, ['caja_id', 'cashbox_id', 'id_caja'], null);

    const st = await query(`SELECT * FROM ${ventasT} WHERE ${ventIdCol} = $1 LIMIT 1`, [saleId]);
    const venta = st.rows[0];
    if (!venta) return safeJson(res, { ok: false, error: 'Venta no encontrada' }, 404);

    const total = venta[ventTotalCol] != null ? Number(venta[ventTotalCol]) : 0;
    const saleDate = ventDateCol ? parseDateValue(venta[ventDateCol]) : null;
    const daysSinceSale = saleDate ? diffCalendarDays(saleDate, new Date()) : null;
    const withinWindow = daysSinceSale != null && daysSinceSale <= RETURN_WINDOW_DAYS;
    const returnSummary = await fetchSaleReturnSummary(null, saleId);
    const alreadyReturned = Array.isArray(returnSummary.events) && returnSummary.events.length > 0;
    const items = [];
    if (itemsT && (await tableExists(null, itemsT))) {
      const siSaleCol = await pickColumn(null, itemsT, ['venta_id', 'sale_id', 'id_venta'], 'venta_id');
      const siProdCol = await pickColumn(null, itemsT, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
      const siQtyCol = await pickColumn(null, itemsT, ['cantidad', 'quantity', 'qty'], 'cantidad');
      const siUnitCol = await pickColumn(null, itemsT, ['precio_unit', 'precio_unitario', 'unit_price'], 'precio_unit');
      const siSubCol = await pickColumn(null, itemsT, ['subtotal', 'importe', 'total_linea'], 'subtotal');
      const stmt = await query(
        `SELECT ${siProdCol} AS producto_id, ${siQtyCol} AS cantidad, ${siUnitCol} AS precio_unit, ${siSubCol} AS subtotal FROM ${itemsT} WHERE ${siSaleCol} = $1`,
        [saleId]
      );
      for (const row of stmt.rows) {
        items.push({
          product_id: Number(row.producto_id || 0),
          cantidad: Number(row.cantidad || 0),
          precio_unit: Number(row.precio_unit || 0),
          subtotal: row.subtotal != null ? Number(row.subtotal) : null,
          id_producto: Number(row.producto_id || 0),
          qty: Number(row.cantidad || 0),
          unit_price: Number(row.precio_unit || 0)
        });
      }
    }
    let services = [];
    try {
      const paymentsTable = await pickTable(null, ['payments', 'pagos', 'payment_methods'], 'payments');
      if (paymentsTable && (await tableExists(null, paymentsTable))) {
        const paySaleIdCol = await pickColumn(null, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
        const payDetCol = await pickColumn(
          null,
          paymentsTable,
          ['payment_method_details', 'metodo_detalle', 'method_details'],
          'payment_method_details'
        );
        if (payDetCol) {
          const payRes = await query(
            `SELECT ${payDetCol} AS payment_method_details FROM ${paymentsTable} WHERE ${paySaleIdCol} = $1`,
            [saleId]
          );
          services = collectServiceLines(payRes.rows || []);
        }
      }
    } catch (_) {}
    return safeJson(res, {
      ok: true,
      sale: {
        id: venta[ventIdCol],
        total,
        customer_name: venta.customer_name || venta.cliente || null,
        date: saleDate ? saleDate.toISOString() : ventDateCol ? venta[ventDateCol] || null : null,
        caja_id: ventCajaCol && venta[ventCajaCol] != null ? Number(venta[ventCajaCol]) : null
      },
      items,
      services,
      total,
      return_policy: {
        limit_days: RETURN_WINDOW_DAYS,
        sale_date: saleDate ? saleDate.toISOString() : null,
        days_since_sale: daysSinceSale,
        within_window: withinWindow,
        full_sale_only: true,
        already_returned: alreadyReturned
      },
      already_returned: alreadyReturned,
      returned_total: Number(returnSummary.total || 0)
    });
  })
);

router.get(
  '/sales_recent',
  asyncHandler(async (req, res) => {
    await requireRole('user')(req, res, async () => {});
    if (res.headersSent) return;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const st = await query('SELECT id, total, fecha FROM ventas ORDER BY id DESC LIMIT $1', [limit]);
    return safeJson(res, st.rows);
  })
);

router.get(
  '/history_sales',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { error: 'No autenticado' }, 401);
    const roleRaw = String(req.session.user.rol || req.session.user.role || 'user').toLowerCase();
      const canon = {
        admin: 'admin',
        administrador: 'admin',
        cashier: 'cashier',
        cajero: 'cashier',
        farmacia: 'farmacia',
        cashiee: 'cashiee',
        superadmin: 'superadmin',
        user: 'user',
        usuario: 'user'
      };
      const role = canon[roleRaw] || 'user';
    if (!['admin', 'cashier', 'cashiee', 'user', 'farmacia', 'superadmin'].includes(role)) {
      return safeJson(res, { error: 'No autorizado' }, 403);
    }

    const start = req.query.start || null;
    const end = req.query.end || null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    let page = Math.max(1, Number(req.query.page || 1));
    let pageSize = Number(req.query.pageSize || 20);
    if (![10, 20, 50].includes(pageSize)) pageSize = 20;
    let branchFilter = req.query.branch_id ? Number(req.query.branch_id) : null;
    if (role === 'cashiee') branchFilter = 2;

    const dateCol = (await columnExists(null, 'ventas', 'fecha'))
      ? 'fecha'
      : (await columnExists(null, 'ventas', 'created_at'))
      ? 'created_at'
      : (await columnExists(null, 'ventas', 'fecha_venta'))
      ? 'fecha_venta'
      : null;

    const conds = [];
    const params = [];
    if (dateCol) {
      if (start) {
        conds.push(`DATE(${dateCol}) >= $${params.length + 1}`);
        params.push(start);
      }
      if (end) {
        conds.push(`DATE(${dateCol}) <= $${params.length + 1}`);
        params.push(end);
      }
    }
    if (branchFilter && (await columnExists(null, 'ventas', 'branch_id'))) {
      conds.push(`v.branch_id = $${params.length + 1}`);
      params.push(branchFilter);
    } else if (['cashier', 'cajero', 'farmacia'].includes(role) && (await columnExists(null, 'ventas', 'branch_id'))) {
      conds.push('v.branch_id <> 2');
    }

    let searchSql = '';
    if (q) {
      const parts = [`u.username ILIKE $${params.length + 1}`];
      params.push(`%${q}%`);
      if (await columnExists(null, 'ventas', 'note')) {
        parts.push(`v.note ILIKE $${params.length + 1}`);
        params.push(`%${q}%`);
      }
      if (await columnExists(null, 'ventas', 'cliente_documento')) {
        parts.push(`v.cliente_documento ILIKE $${params.length + 1}`);
        params.push(`%${q}%`);
      }
      searchSql = ` AND (${parts.join(' OR ')})`;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE 1=1';
    const countRes = await query(
      `SELECT COUNT(*) AS c FROM ventas v LEFT JOIN users u ON u.id = v.usuario_id ${where} ${searchSql}`,
      params
    );
    const total = Number(countRes.rows[0]?.c || 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) page = pages;
    const offset = (page - 1) * pageSize;

    const listRes = await query(
      `SELECT v.id, ${dateCol ? dateCol : 'NULL'} AS fecha, u.username AS usuario, v.total
       FROM ventas v
       LEFT JOIN users u ON u.id = v.usuario_id
       ${where} ${searchSql}
       ORDER BY ${dateCol ? `${dateCol} DESC, v.id DESC` : 'v.id DESC'}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );
    const items = listRes.rows || [];

    if (items.length) {
      const saleIds = items.map((i) => Number(i.id));
      const payRes = await query(
        'SELECT sale_id, payment_type, payment_method_details FROM payments WHERE sale_id = ANY($1)',
        [saleIds]
      );
      const payMap = new Map();
      for (const row of payRes.rows) {
        if (payMap.has(row.sale_id)) continue;
        let form = row.payment_type || '';
        if (row.payment_method_details) {
          try {
            const det =
              typeof row.payment_method_details === 'string'
                ? JSON.parse(row.payment_method_details)
                : row.payment_method_details;
            form = det.forma || det.metodo || det.method || form;
          } catch (_) {}
        }
        payMap.set(row.sale_id, form);
      }
      for (const item of items) {
        item.payment_form = payMap.get(item.id) || null;
      }
    }

    return safeJson(res, {
      ok: true,
      page,
      pages,
      pageSize,
      total,
      items
    });
  })
);

router.post(
  '/return_sale',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    const input = readJson(req);
    const userId = req.session.user_id || req.session.user.id || null;
    const userRole = canonRole(req.session.user.rol || req.session.user.role || '');
    try {
      const result = await performReturnSale(input, userId, {
        actorRole: userRole,
        authorizedById: userId
      });
      return safeJson(res, { ok: true, return_id: result.returnId, total: result.totalReturn });
    } catch (err) {
      return safeJson(
        res,
        {
          ok: false,
          error: err.message || 'Error registrando devolución',
          approval_required: !!err.approval_required,
          reason: err.reason || null
        },
        err.approval_required ? 403 : 400
      );
    }
  })
);

router.post(
  '/return_sale_manual',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    const input = readJson(req);
    const userId = req.session.user_id || req.session.user.id || null;
    const userRole = canonRole(req.session.user.rol || req.session.user.role || '');
    try {
      const result = await performReturnSaleManual(input, userId, {
        actorRole: userRole,
        authorizedById: userId
      });
      return safeJson(res, { ok: true, manual_return_id: result.manual_return_id, amount: result.amount });
    } catch (err) {
      return safeJson(
        res,
        {
          ok: false,
          error: err.message || 'Error registrando devolución',
          approval_required: !!err.approval_required,
          reason: err.reason || null
        },
        err.approval_required ? 403 : 400
      );
    }
  })
);

router.post(
  '/return_sale_request',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    const input = readJson(req);
    const userId = req.session.user_id || req.session.user.id || null;
    try {
      const token = await withTransaction(async (db) => {
        return await createApprovalRequest(db, 'venta', input, userId, req);
      });
      return safeJson(res, { ok: true, token, approval_url: buildApprovalLink(req, token) });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'No se pudo solicitar aprobación' }, 400);
    }
  })
);

router.post(
  '/return_sale_manual_request',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    const input = readJson(req);
    const userId = req.session.user_id || req.session.user.id || null;
    try {
      const token = await withTransaction(async (db) => {
        return await createApprovalRequest(db, 'manual', input, userId, req);
      });
      return safeJson(res, { ok: true, token, approval_url: buildApprovalLink(req, token) });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'No se pudo solicitar aprobación' }, 400);
    }
  })
);

router.get(
  '/return_approval_info',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) return safeJson(res, { ok: false, error: 'Token requerido' }, 400);
    await ensureReturnApprovalTable(null);
    const st = await query('SELECT id, type, payload, status, expires_at FROM return_approval_requests WHERE token = $1 LIMIT 1', [token]);
    const row = st.rows[0];
    if (!row) return safeJson(res, { ok: false, error: 'Solicitud no encontrada' }, 404);
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
    return safeJson(res, {
      ok: true,
      id: row.id,
      type: row.type,
      status: row.status,
      expires_at: row.expires_at,
      payload
    });
  })
);

router.post(
  '/return_approval_approve',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    const role = canonRole(req.session.user.rol || req.session.user.role || '');
    if (!['admin', 'administrador', 'superadmin'].includes(role)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }
    const input = readJson(req);
    const token = String(input.token || '').trim();
    const password = String(input.password || '').trim();
    if (!token || !password) return safeJson(res, { ok: false, error: 'Datos incompletos' }, 400);
    const adminUserId = req.session.user.id || null;
    try {
      const approved = await withTransaction(async (db) => {
        const row = await approveReturnRequest(db, token, adminUserId, password, req);
        let payload = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
        if (row.type === 'manual') {
          await performReturnSaleManual(payload, row.requested_by || adminUserId, {
            actorRole: role,
            approvedById: adminUserId,
            authorizedById: adminUserId
          });
        } else {
          await performReturnSale(payload, row.requested_by || adminUserId, {
            actorRole: role,
            approvedById: adminUserId,
            authorizedById: adminUserId
          });
        }
        return row;
      });
      return safeJson(res, { ok: true, approved_id: approved.id });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'No se pudo aprobar' }, 400);
    }
  })
);

router.post(
  '/return_approval_approve_public',
  asyncHandler(async (req, res) => {
    const input = readJson(req);
    const token = String(input.token || '').trim();
    const username = String(input.username || '').trim();
    const password = String(input.password || '').trim();
    if (!token || !username || !password) {
      return safeJson(res, { ok: false, error: 'Datos incompletos' }, 400);
    }
    try {
      const adminAuth = await verifyAdminCredentials(null, username, password);
      if (!adminAuth) return safeJson(res, { ok: false, error: 'Credenciales inválidas' }, 403);
      const approved = await withTransaction(async (db) => {
        const row = await approveReturnRequest(db, token, adminAuth.id, password, req);
        let payload = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
        if (row.type === 'manual') {
          await performReturnSaleManual(payload, row.requested_by || adminAuth.id, {
            actorRole: adminAuth.role,
            approvedById: adminAuth.id,
            authorizedById: adminAuth.id
          });
        } else {
          await performReturnSale(payload, row.requested_by || adminAuth.id, {
            actorRole: adminAuth.role,
            approvedById: adminAuth.id,
            authorizedById: adminAuth.id
          });
        }
        return row;
      });
      return safeJson(res, { ok: true, approved_id: approved.id });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'No se pudo aprobar' }, 400);
    }
  })
);


router.post(
  '/return_sale_admin',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador'])(req, res, async () => {});
    if (res.headersSent) return;
    const input = readJson(req);
    const saleId = Number(input.sale_id || 0);
    const motive = String(input.motive || 'Devolución').trim();
    const cajaId = input.caja_id != null && input.caja_id !== '' ? Number(input.caja_id) : null;
    if (!saleId) return safeJson(res, { ok: false, error: 'sale_id requerido' }, 400);
    const userId = req.session?.user?.id || null;
    const userRole = canonRole(req.session?.user?.rol || req.session?.user?.role || '');
    const payload = { sale_id: saleId, motive, caja_id: cajaId };

    const result = await performReturnSale(payload, userId, {
      actorRole: userRole,
      authorizedById: userId
    });

    return safeJson(res, { ok: true, return_id: result.returnId, total: result.totalReturn });
  })
);

router.get(
  '/history_sale_returns',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador'])(req, res, async () => {});
    if (res.headersSent) return;
    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    if (!(await tableExists(null, returnsTable))) return safeJson(res, []);
    const returnCols = await getColumns(null, returnsTable);
    const branchCol = returnCols.includes('branch_id') ? 'branch_id' : null;
    const userCol = returnCols.includes('user_id') ? 'user_id' : null;
    const motiveCol = returnCols.includes('motive') ? 'motive' : returnCols.includes('motivo') ? 'motivo' : null;

    const salesTable = await pickTable(null, ['ventas', 'sales'], 'ventas');
    const saleTotalCol = await pickColumn(null, salesTable, ['total', 'monto_total', 'importe_total'], 'total');
    const saleBranchCol = await pickColumn(null, salesTable, ['branch_id', 'sucursal_id'], null);
    const saleFechaCol = await pickColumn(null, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');

    const branches = {};
    if (await tableExists(null, 'branches')) {
      const bq = await query('SELECT id, name FROM branches');
      for (const b of bq.rows) branches[Number(b.id)] = b.name;
    }

    const rows = await query(
      `SELECT id, sale_id, created_at ${branchCol ? `, ${branchCol} AS branch_id` : ''} ${
        userCol ? `, ${userCol} AS user_id` : ''
      } ${motiveCol ? `, ${motiveCol} AS motive` : ''} FROM ${returnsTable} ORDER BY created_at DESC`
    );

    const userIds = new Set();
    for (const r of rows.rows) if (r.user_id) userIds.add(Number(r.user_id));
    const usernames = {};
    if (userIds.size) {
      const us = await query('SELECT id, username FROM users WHERE id = ANY($1)', [[...userIds]]);
      for (const u of us.rows) usernames[Number(u.id)] = u.username;
    }

    const saleStmt = async (sid) =>
      query(
        `SELECT ${saleTotalCol} AS total ${saleBranchCol ? `, ${saleBranchCol} AS branch_id` : ''} ${
          saleFechaCol ? `, ${saleFechaCol} AS fecha` : ''
        } FROM ${salesTable} WHERE id = $1 LIMIT 1`,
        [sid]
      );

    const out = [];
    for (const r of rows.rows) {
      const sale = (await saleStmt(r.sale_id)).rows[0] || {};
      const branchId = r.branch_id || sale.branch_id || null;
      out.push({
        id: Number(r.id),
        sale_id: Number(r.sale_id),
        fecha: r.created_at,
        sale_fecha: sale.fecha || null,
        branch_id: branchId ? Number(branchId) : null,
        branch: branchId && branches[Number(branchId)] ? branches[Number(branchId)] : null,
        total_sale: sale.total != null ? Number(sale.total) : null,
        motive: r.motive || null,
        user: r.user_id && usernames[Number(r.user_id)] ? usernames[Number(r.user_id)] : null
      });
    }

    return safeJson(res, out);
  })
);

router.get(
  '/invoice',
  asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const ventaId = req.query.venta_id ? Number(req.query.venta_id) : 0;
    if (!ventaId) return res.type('text/plain').send('venta_id requerido');
    const ventaRes = await query(
      'SELECT v.*, u.username FROM ventas v LEFT JOIN users u ON u.id = v.usuario_id WHERE v.id = $1',
      [ventaId]
    );
    const venta = ventaRes.rows[0];
    if (!venta) return res.type('text/plain').send('Venta no encontrada');
    const itemsRes = await query(
      'SELECT vi.*, p.nombre_comercial FROM venta_items vi LEFT JOIN productos p ON p.id = vi.producto_id WHERE vi.venta_id = $1',
      [ventaId]
    );
    const rows = itemsRes.rows || [];
    const fecha = formatDateLocale(venta.fecha, lang);

    const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${tReceipt(lang, 'invoice')} #${ventaId}</title>
<style>body{font-family:Arial,Helvetica,sans-serif}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}</style>
</head><body>
<h2>${tReceipt(lang, 'invoice')} #${ventaId}</h2>
<p>${tReceipt(lang, 'date')}: ${fecha || ''}<br>${tReceipt(lang, 'seller')}: ${venta.username || ''}</p>
<table><thead><tr><th>${tReceipt(lang, 'product')}</th><th>${tReceipt(lang, 'quantity')}</th><th>${tReceipt(
      lang,
      'unit_price'
    )}</th><th>${tReceipt(lang, 'subtotal')}</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${r.nombre_comercial || ''}</td><td>${Number(r.cantidad || 0)}</td><td>${fmtMoney(
        r.precio_unit
      )}</td><td>${fmtMoney(Number(r.cantidad || 0) * Number(r.precio_unit || 0))}</td></tr>`
  )
  .join('')}
</tbody>
<tfoot><tr><td colspan="3" style="text-align:right"><strong>${tReceipt(lang, 'total')}</strong></td><td>${fmtMoney(
      venta.total
    )}</td></tr></tfoot></table>
</body></html>`;
    res.type('text/html').send(html);
  })
);

router.get(
  '/invoice_pdf',
  asyncHandler(async (req, res) => {
    await requireRole('user')(req, res, async () => {});
    if (res.headersSent) return;
    const lang = getLang(req);
    const id =
      Number(req.query.id || 0) ||
      Number(req.query.venta_id || 0) ||
      Number(req.query.id_venta || 0) ||
      Number(req.query.sale_id || 0);
    if (!id) return res.type('text/plain').send('ID inválido');

    const saleRes = await query(
      'SELECT v.*, u.username FROM ventas v LEFT JOIN users u ON u.id=v.usuario_id WHERE v.id = $1',
      [id]
    );
    const venta = saleRes.rows[0];
    if (!venta) return res.type('text/plain').send('Venta no encontrada');
    const itemsRes = await query(
      'SELECT vi.*, p.nombre_comercial AS producto FROM venta_items vi LEFT JOIN productos p ON p.id=vi.producto_id WHERE vi.venta_id=$1',
      [id]
    );
    const items = itemsRes.rows || [];
    const payRes = await query('SELECT payment_type, amount, payment_method_details FROM payments WHERE sale_id=$1', [id]);
    const pagos = payRes.rows || [];

    const services = collectServiceLines(pagos);

    res.setHeader('Content-Type', 'application/pdf');
    const doc = new PDFDocument({ size: [396, 612], margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text(`${tReceipt(lang, 'sale_receipt')} #${id}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(tReceipt(lang, 'invoice_sale'), { align: 'center' });
    doc.moveDown(0.5);
    const receiptName = extractReceiptName(pagos, venta.note);
    const customerIdentity = extractCustomerIdentity(venta, pagos);
    const customerLabel = formatCustomerIdentityLabel(customerIdentity.type, lang);
    const customerDocument = String(customerIdentity.document || '').trim();
    if (receiptName) {
      doc.fontSize(10).text(`${tReceipt(lang, 'on_behalf_of')}: ${receiptName}`);
    }
    doc.fontSize(10).text(`${tReceipt(lang, 'date')}: ${formatDateLocale(venta.fecha, lang) || ''}`);
    doc.fontSize(10).text(`${tReceipt(lang, 'cashier')}: ${venta.username || ''}`);
    if (customerLabel || customerDocument) {
      const billingLine =
        customerLabel && customerDocument
          ? `${customerLabel}: ${customerDocument}`
          : customerLabel || customerDocument;
      doc.fontSize(10).text(`${tReceipt(lang, 'billing_data')}: ${billingLine}`);
    }
    doc.moveDown(1);

    const rows = [...items, ...services];
    doc.fontSize(10).text(tReceipt(lang, 'product'), 40, doc.y, { continued: true });
    doc.text(tReceipt(lang, 'quantity'), 300, doc.y, { continued: true });
    doc.text(tReceipt(lang, 'unit_price'), 360, doc.y, { continued: true });
    doc.text(tReceipt(lang, 'subtotal'), 430, doc.y);
    doc.moveDown(0.3);

    let total = 0;
    for (const r of rows) {
      const subtotal = Number(
        r.subtotal != null ? r.subtotal : Number(r.cantidad || 0) * Number(r.precio_unit || 0)
      );
      total += subtotal;
      doc.text(r.producto || '', 40, doc.y, { continued: true });
      doc.text(fmtQty(r.cantidad || 1), 300, doc.y, { continued: true });
      doc.text(fmtMoney(r.precio_unit || 0), 360, doc.y, { continued: true });
      doc.text(fmtMoney(subtotal), 430, doc.y);
    }

    doc.moveDown(0.5);
    doc.fontSize(11).text(`${tReceipt(lang, 'total')}: Q${fmtMoney(total)}`, { align: 'right' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(tReceipt(lang, 'payments'));
    for (const p of pagos) {
      doc.text(`${translatePaymentType(lang, p.payment_type || tReceipt(lang, 'payments'))}: Q${fmtMoney(p.amount || 0)}`);
    }
    let efectivoRecibido = null;
    let cambio = null;
    for (const p of pagos || []) {
      if (!p.payment_method_details) continue;
      try {
        const det =
          typeof p.payment_method_details === 'string'
            ? JSON.parse(p.payment_method_details)
            : p.payment_method_details;
        if (det && det.efectivo_recibido != null) efectivoRecibido = Number(det.efectivo_recibido);
        if (det && det.cambio != null) cambio = Number(det.cambio);
      } catch (_) {}
    }
    if (efectivoRecibido != null || cambio != null) {
      doc.moveDown(0.2);
      if (efectivoRecibido != null) doc.text(`${tReceipt(lang, 'received')}: Q${fmtMoney(efectivoRecibido)}`);
      if (cambio != null) doc.text(`${tReceipt(lang, 'change')}: Q${fmtMoney(cambio)}`);
    }
    doc.end();
  })
);

router.get(
  '/invoice_print',
  asyncHandler(async (req, res) => {
    await requireRole('user')(req, res, async () => {});
    if (res.headersSent) return;
    const lang = getLang(req);
    const id =
      Number(req.query.venta_id || 0) ||
      Number(req.query.id_venta || 0) ||
      Number(req.query.sale_id || 0) ||
      Number(req.query.id || 0);
    if (!id) return res.type('text/plain').send('ID inválido');

    const data = await fetchSaleDetails(null, id);
    if (!data) return res.type('text/plain').send('Venta no encontrada');

    const servicesRaw = collectServiceLines(data.pagos);
    const serviceMap = new Map();
    for (const s of servicesRaw) {
      const rawName = String(s.producto || s.descripcion || 'servicio');
      const key = rawName.trim().toLowerCase().replace(/\s+/g, ' ');
      const sub = s.subtotal != null ? Number(s.subtotal) : Number(s.cantidad || 0) * Number(s.precio_unit || 0);
      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          ...s,
          producto: rawName.trim(),
          cantidad: Number(s.cantidad || 1),
          subtotal: Number.isFinite(sub) ? sub : 0,
          is_service: true
        });
      } else {
        const cur = serviceMap.get(key);
        cur.cantidad = Number(cur.cantidad || 1) + Number(s.cantidad || 1);
        cur.subtotal = Number(cur.subtotal || 0) + (Number.isFinite(sub) ? sub : 0);
      }
    }
    const services = Array.from(serviceMap.values());
    const rows = [...data.items, ...services];
    const grossTotal = rows.reduce((s, r) => {
      const sub = r.subtotal != null ? Number(r.subtotal) : Number(r.cantidad || 0) * Number(r.precio_unit || 0);
      return s + (Number.isFinite(sub) ? sub : 0);
    }, 0);
    const total = data.sale.total != null ? Number(data.sale.total) : grossTotal;

    let efectivoRecibido = null;
    let cambio = null;
    let discountPercent = null;
    let nombreComprobante = extractReceiptName(data.pagos, data.sale.note);
    for (const p of data.pagos || []) {
      let det =
        p.payment_method_details ??
        p.det ??
        p.detalles ??
        p.meta ??
        null;
      if (!det) continue;
      try {
        if (typeof det === 'string') det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
      if (!det || typeof det !== 'object') continue;
      if (det.efectivo_recibido != null) efectivoRecibido = Number(det.efectivo_recibido);
      if (det.cambio != null) cambio = Number(det.cambio);
      if (det.discount_percent != null) discountPercent = Number(det.discount_percent);
    }
    let discountAmount = null;
    let discountLabelPercent = null;
    let netTotal = total;
    if (discountPercent != null && discountPercent > 0) {
      discountAmount = grossTotal * (discountPercent / 100);
      discountLabelPercent = discountPercent;
      netTotal = Math.max(0, grossTotal - discountAmount);
      if (Number.isFinite(total) && Math.abs(total - netTotal) > 0.02) {
        netTotal = total;
        discountAmount = Math.max(0, grossTotal - netTotal);
      }
    } else if (Number.isFinite(grossTotal) && Number.isFinite(total) && grossTotal - total > 0.009) {
      discountAmount = grossTotal - total;
      discountLabelPercent = grossTotal > 0 ? (discountAmount / grossTotal) * 100 : null;
      netTotal = total;
    }
    const fmtPct = (v) => {
      if (v == null || !Number.isFinite(v)) return '';
      const fixed = Number(v).toFixed(2);
      return fixed.replace(/\.00$/, '');
    };

    const escape = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const grouped = [];
    const keyMap = new Map();
    for (const r of rows) {
      if (r.is_service) {
        grouped.push({
          producto: r.producto || 'Servicio',
          cantidad: Number(r.cantidad || 1),
          subtotal: r.subtotal != null ? Number(r.subtotal) : Number(r.cantidad || 0) * Number(r.precio_unit || 0),
          is_service: true
        });
        continue;
      }
      const name = String(r.producto || 'Producto');
      const unit = Number(r.precio_unit || 0);
      const key = `${name}__${unit}`;
      if (!keyMap.has(key)) {
        keyMap.set(key, { producto: name, cantidad: 0, subtotal: 0, unit });
      }
      const entry = keyMap.get(key);
      const qty = Number(r.cantidad || 0);
      const sub = r.subtotal != null ? Number(r.subtotal) : qty * unit;
      entry.cantidad += qty;
      entry.subtotal += sub;
    }
    grouped.unshift(...Array.from(keyMap.values()));

    const ratio = discountAmount && grossTotal > 0 ? Math.max(0, Math.min(1, netTotal / grossTotal)) : 1;
    const itemLines = grouped.map((r) => {
      const qty = Number(r.cantidad || 1);
      const name = escape(r.producto || 'Servicio');
      const unit = Number(r.unit != null ? r.unit : r.precio_unit != null ? r.precio_unit : qty > 0 ? Number(r.subtotal || 0) / qty : 0);
      const sub = Number(r.subtotal || 0);
      const adj = ratio < 1 ? sub * ratio : sub;
      const meta = r.is_service
        ? `Servicio${qty > 1 ? ` · ${fmtQty(qty)} registros` : ''}`
        : `${fmtQty(qty)} unidad${Math.abs(qty - 1) < 0.0001 ? '' : 'es'}${unit > 0 ? ` · Q${fmtMoney(unit)}` : ''}`;
      return `<div class="item-row">
        <div>
          <div class="item-title">${name}</div>
          <div class="item-sub">${meta}</div>
        </div>
        <div class="item-amt">Q${fmtMoney(adj)}</div>
      </div>`;
    });

    const paymentLines = (data.pagos || []).map((p) => {
      const label = escape(translatePaymentType(lang, p.payment_type || tReceipt(lang, 'payments')));
      return `<div class="line"><span class="name">${label}</span><span class="amt">Q${fmtMoney(p.amount || 0)}</span></div>`;
    });
    const compactItemRows = grouped
      .map((r) => {
        const qty = Number(r.cantidad || 1);
        const name = escape(r.producto || 'Servicio');
        const unit = Number(r.unit != null ? r.unit : r.precio_unit != null ? r.precio_unit : qty > 0 ? Number(r.subtotal || 0) / qty : 0);
        const sub = Number(r.subtotal || 0);
        const adj = ratio < 1 ? sub * ratio : sub;
        const meta = r.is_service
          ? `Servicio${qty > 1 ? ` · ${fmtQty(qty)} registros` : ''}`
          : `${fmtQty(qty)} unidad${Math.abs(qty - 1) < 0.0001 ? '' : 'es'}${unit > 0 ? ` · Q${fmtMoney(unit)}` : ''}`;
        return `<tr>
          <td>
            <div class="print-item-name">${name}</div>
            <div class="print-item-meta">${meta}</div>
          </td>
          <td class="print-money">Q${fmtMoney(adj)}</td>
        </tr>`;
      })
      .join('');
    const compactPaymentRows = (data.pagos || [])
      .map((p) => {
        const label = escape(translatePaymentType(lang, p.payment_type || tReceipt(lang, 'payments')));
        return `<tr><td>${label}</td><td class="print-money">Q${fmtMoney(p.amount || 0)}</td></tr>`;
      })
      .join('');

    const receiptDate = escape(formatDateLocale(data.sale.fecha, lang) || '');
    const cashierName = escape(data.username || '--');
    const extraNoteRaw = String(data.sale.note || '').trim();
    const extraNote =
      extraNoteRaw && !/^a nombre de:\s*/i.test(extraNoteRaw)
        ? escape(extraNoteRaw).replace(/\r?\n/g, '<br>')
        : '';
    const receiptNameHtml = nombreComprobante
      ? escape(nombreComprobante)
      : data.sale.note && String(data.sale.note).toLowerCase().includes('a nombre de:')
      ? escape(String(data.sale.note).replace(/^.*a nombre de:\s*/i, '').trim())
      : '';
    const customerIdentity = extractCustomerIdentity(data.sale, data.pagos);
    const customerLabelRaw = formatCustomerIdentityLabel(customerIdentity.type, lang);
    const customerDocumentRaw = String(customerIdentity.document || '').trim();
    const billingSummaryRaw =
      customerLabelRaw && customerDocumentRaw
        ? `${customerLabelRaw}: ${customerDocumentRaw}`
        : customerLabelRaw || customerDocumentRaw;
    const billingSummaryHtml = billingSummaryRaw ? escape(billingSummaryRaw) : '';
    const felDocument = await getFelDocument(null, id).catch(() => null);
    const felCertified = felDocument && String(felDocument.status || '').toLowerCase() === 'certified';
    const felSummaryHtml = felCertified
      ? [
          felDocument.uuid ? `UUID: ${escape(felDocument.uuid)}` : '',
          felDocument.serie ? `Serie: ${escape(felDocument.serie)}` : '',
          felDocument.numero ? `Numero: ${escape(felDocument.numero)}` : ''
        ]
          .filter(Boolean)
          .join(' | ')
      : '';
    const returnSummary =
      data.returns && typeof data.returns === 'object'
        ? data.returns
        : { total: 0, events: [] };
    const returnEvents = Array.isArray(returnSummary.events) ? returnSummary.events : [];
    const totalRefunded = Number(returnSummary.total || 0);
    const hasReturns = returnEvents.length > 0 || totalRefunded > 0;
    const isFullyCancelled = hasReturns && total > 0 && totalRefunded >= total - 0.01;
    const returnStatus = hasReturns
      ? escape(tReceipt(lang, isFullyCancelled ? 'sale_cancelled' : 'partial_refund'))
      : '';
    const returnBannerAmount = hasReturns
      ? `<span>Q${fmtMoney(totalRefunded)}</span>`
      : '';
    const returnEventCards = returnEvents
      .map((event) => {
        const eventDate = escape(formatDateLocale(event.created_at, lang) || '--');
        const refundBox = escape(event.refund_caja_label || '--');
        const originalBox = escape(event.sale_caja_label || '--');
        const requestedBy = escape(event.user_name || '--');
        const approvedBy = escape(event.authorized_by_name || '--');
        const motive = escape(event.motive || '');
        return `<div class="return-card">
          <div class="return-card-top">
            <strong>Anulación #${Number(event.id || 0)}</strong>
            <span>Q${fmtMoney(event.total || 0)}</span>
          </div>
          <div class="return-grid">
            <div class="return-field">
              <span class="return-label">${tReceipt(lang, 'refunded_at')}</span>
              <span>${eventDate}</span>
            </div>
            <div class="return-field">
              <span class="return-label">${tReceipt(lang, 'refund_cashbox')}</span>
              <span>${refundBox}</span>
            </div>
            ${
              event.sale_caja_label
                ? `<div class="return-field">
                    <span class="return-label">${tReceipt(lang, 'original_cashbox')}</span>
                    <span>${originalBox}</span>
                  </div>`
                : ''
            }
            <div class="return-field">
              <span class="return-label">${tReceipt(lang, 'requested_by')}</span>
              <span>${requestedBy}</span>
            </div>
            ${
              event.authorized_by_name
                ? `<div class="return-field">
                    <span class="return-label">${tReceipt(lang, 'approved_by')}</span>
                    <span>${approvedBy}</span>
                  </div>`
                : ''
            }
          </div>
          ${
            motive
              ? `<div class="return-note">
                  <span class="return-label">${tReceipt(lang, 'note')}</span>
                  <div>${motive}</div>
                </div>`
              : ''
          }
        </div>`;
      })
      .join('');
    const compactReturnEvents = returnEvents
      .map((event) => {
        const eventDate = escape(formatDateLocale(event.created_at, lang) || '--');
        const refundBox = escape(event.refund_caja_label || '--');
        const requestedBy = escape(event.user_name || '--');
        const approvedBy = escape(event.authorized_by_name || '');
        const motive = escape(event.motive || '');
        return `<div class="print-return-card">
          <div class="print-return-row">
            <span>Anulación #${Number(event.id || 0)}</span>
            <strong>Q${fmtMoney(event.total || 0)}</strong>
          </div>
          <div class="print-return-row"><span>${tReceipt(lang, 'refunded_at')}</span><strong>${eventDate}</strong></div>
          <div class="print-return-row"><span>${tReceipt(lang, 'refund_cashbox')}</span><strong>${refundBox}</strong></div>
          <div class="print-return-row"><span>${tReceipt(lang, 'requested_by')}</span><strong>${requestedBy}</strong></div>
          ${
            approvedBy
              ? `<div class="print-return-row"><span>${tReceipt(lang, 'approved_by')}</span><strong>${approvedBy}</strong></div>`
              : ''
          }
          ${
            motive
              ? `<div class="print-return-note"><span>${tReceipt(lang, 'note')}:</span> ${motive}</div>`
              : ''
          }
        </div>`;
      })
      .join('');

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Comprobante #${id}</title>
  <style>
    :root{
      --ink:#13263f;
      --muted:#62748a;
      --line:#d7e4ef;
      --accent:#53c7f5;
      --accent-mid:#1f8fd6;
      --accent-deep:#1558a6;
      --paper:#ffffff;
      --soft:#f4f9fd;
      --soft-accent:#eef7ff;
    }
    @page {
      size: 5.5in 8.5in;
      margin: 0.16in;
    }
    *{
      box-sizing:border-box;
      -webkit-print-color-adjust:exact;
      print-color-adjust:exact;
    }
    body{
      margin:0;
      padding:24px;
      background:
        radial-gradient(circle at top, #f3fbff 0%, #e7f0f9 36%, #d9e4ef 100%);
      font-family:"Bahnschrift","Segoe UI Variable","Segoe UI",sans-serif;
      color:var(--ink);
    }
    .stage{
      display:flex;
      justify-content:center;
    }
    .receipt{
      width:min(5.06in, calc(100vw - 24px));
      min-height:calc(8.5in - 0.44in);
      background:var(--paper);
      border:1px solid rgba(18,32,51,.08);
      border-radius:28px;
      box-shadow:0 18px 48px rgba(18,32,51,.16);
      overflow:hidden;
      display:flex;
      flex-direction:column;
    }
    .receipt-print{
      display:none;
    }
    .hero{
      background:
        radial-gradient(circle at top left, rgba(255,255,255,.28) 0%, transparent 34%),
        linear-gradient(135deg, var(--accent-deep) 0%, var(--accent-mid) 46%, var(--accent) 100%);
      color:#fff;
      padding:24px 24px 20px;
    }
    .hero-top{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:18px;
    }
    .brand{
      display:flex;
      align-items:center;
      gap:14px;
      min-width:0;
    }
    .brand-mark{
      width:54px;
      height:54px;
      border-radius:16px;
      border:1px solid rgba(255,255,255,.34);
      background:rgba(255,255,255,.14);
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:16px;
      font-weight:800;
      letter-spacing:.14em;
      flex:none;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.18);
    }
    .brand-copy{
      min-width:0;
    }
    .eyebrow{
      font-size:10px;
      letter-spacing:.18em;
      text-transform:uppercase;
      opacity:.82;
    }
    .hero h1{
      margin:6px 0 0;
      font-size:30px;
      line-height:1.02;
      letter-spacing:.02em;
    }
    .hero-sub{
      margin-top:18px;
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:18px;
      font-size:12px;
      line-height:1.45;
    }
    .hero-pill{
      padding:9px 14px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.26);
      background:rgba(255,255,255,.14);
      font-weight:700;
      white-space:nowrap;
      font-size:13px;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.22);
    }
    .contact{
      padding:14px 24px;
      background:var(--soft);
      border-bottom:1px solid var(--line);
      font-size:11px;
      line-height:1.6;
      color:var(--muted);
      text-align:left;
    }
    .billing-strip{
      padding:10px 24px;
      border-bottom:1px solid var(--line);
      background:#f8fbff;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .billing-label{
      font-size:10px;
      text-transform:uppercase;
      letter-spacing:.16em;
      color:var(--muted);
      white-space:nowrap;
    }
    .billing-value{
      font-size:13px;
      font-weight:700;
      color:var(--ink);
      text-align:right;
      word-break:break-word;
    }
    .meta{
      padding:18px 24px 10px;
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:12px;
    }
    .meta-card{
      border:1px solid var(--line);
      border-radius:18px;
      padding:14px 16px;
      min-height:86px;
      background:#fff;
    }
    .meta-label{
      font-size:10px;
      text-transform:uppercase;
      letter-spacing:.14em;
      color:var(--muted);
    }
    .meta-value{
      margin-top:7px;
      font-size:16px;
      line-height:1.35;
      font-weight:700;
      word-break:break-word;
    }
    .section{
      padding:0 24px 18px;
    }
    .hero,
    .contact,
    .meta,
    .section,
    .summary,
    .footer,
    .meta-card,
    .items,
    .note-box{
      page-break-inside:avoid;
      break-inside:avoid;
    }
    .section-title{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      margin-bottom:10px;
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.16em;
      color:var(--muted);
    }
    .items{
      border:1px solid var(--line);
      border-radius:20px;
      overflow:hidden;
      background:#fff;
    }
    .items-head{
      display:grid;
      grid-template-columns:1fr auto;
      gap:12px;
      padding:12px 16px;
      background:var(--soft);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      color:var(--muted);
    }
    .item-row{
      display:grid;
      grid-template-columns:1fr auto;
      gap:14px;
      padding:14px 16px;
      border-top:1px dashed var(--line);
      align-items:center;
    }
    .item-title{
      font-size:15px;
      line-height:1.35;
      font-weight:700;
    }
    .item-sub{
      margin-top:5px;
      font-size:12px;
      color:var(--muted);
    }
    .item-amt{
      font-size:16px;
      font-weight:800;
      white-space:nowrap;
      text-align:right;
    }
    .summary{
      margin:0 24px 18px;
      padding:16px 18px;
      border-radius:22px;
      border:1px solid rgba(31,143,214,.24);
      background:linear-gradient(180deg, #fbfdff 0%, var(--soft-accent) 100%);
    }
    .line{
      display:flex;
      justify-content:space-between;
      gap:16px;
      margin:6px 0;
      align-items:flex-end;
    }
    .name{
      flex:1;
      color:var(--ink);
      font-size:14px;
    }
    .amt{
      min-width:104px;
      text-align:right;
      font-weight:700;
      white-space:nowrap;
      font-size:15px;
    }
    .grand{
      margin-top:12px;
      padding-top:12px;
      border-top:1px dashed rgba(31,143,214,.3);
    }
    .grand .name,
    .grand .amt{
      font-size:20px;
      font-weight:900;
    }
    .note-box{
      border:1px solid var(--line);
      border-radius:18px;
      background:#fff;
      padding:14px 16px;
      font-size:13px;
      line-height:1.6;
    }
    .footer{
      padding:0 24px 24px;
      text-align:center;
      color:var(--muted);
      font-size:11px;
      line-height:1.6;
      margin-top:auto;
    }
    .footer strong{
      display:block;
      font-size:13px;
      color:var(--ink);
      margin-bottom:4px;
      letter-spacing:.04em;
    }
    .return-section{
      padding-top:0;
    }
    .return-banner{
      margin-bottom:12px;
      padding:14px 16px;
      border-radius:18px;
      border:1px solid #f1c3bc;
      background:linear-gradient(180deg, #fff7f5 0%, #fff1ed 100%);
      color:#7f2b24;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      font-size:14px;
      font-weight:700;
    }
    .return-banner.full{
      border-color:#e7b0a8;
      background:linear-gradient(180deg, #fff4f2 0%, #ffe8e3 100%);
    }
    .return-cards{
      display:grid;
      gap:10px;
    }
    .return-card{
      border:1px solid #f0d3cd;
      border-radius:18px;
      background:#fffaf8;
      padding:14px 16px;
    }
    .return-card-top{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      font-size:14px;
      color:#7f2b24;
    }
    .return-grid{
      margin-top:10px;
      display:grid;
      grid-template-columns:repeat(2, minmax(0, 1fr));
      gap:10px 12px;
    }
    .return-field{
      display:flex;
      flex-direction:column;
      gap:4px;
      font-size:13px;
      line-height:1.4;
    }
    .return-label{
      font-size:10px;
      text-transform:uppercase;
      letter-spacing:.14em;
      color:var(--muted);
    }
    .return-note{
      margin-top:10px;
      padding-top:10px;
      border-top:1px dashed #f0d3cd;
      font-size:13px;
      line-height:1.55;
      color:var(--ink);
    }
    .print-sheet{
      width:100%;
      background:#fff;
      border:1px solid rgba(18,32,51,.08);
      border-radius:18px;
      overflow:hidden;
      color:var(--ink);
    }
    .print-head{
      padding:14px 16px 12px;
      background:linear-gradient(135deg, var(--accent-deep) 0%, var(--accent-mid) 54%, var(--accent) 100%);
      color:#fff;
    }
    .print-head-top{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:12px;
    }
    .print-brand{
      min-width:0;
    }
    .print-brand-name{
      font-size:8px;
      letter-spacing:.18em;
      text-transform:uppercase;
      opacity:.84;
    }
    .print-title{
      margin-top:4px;
      font-size:22px;
      line-height:1.05;
      font-weight:800;
    }
    .print-badge{
      padding:7px 11px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.24);
      background:rgba(255,255,255,.14);
      font-size:10px;
      font-weight:700;
      white-space:nowrap;
    }
    .print-sub{
      margin-top:9px;
      display:flex;
      justify-content:space-between;
      gap:10px;
      font-size:9px;
      line-height:1.4;
    }
    .print-contact{
      padding:8px 16px;
      background:var(--soft);
      border-bottom:1px solid var(--line);
      font-size:8px;
      line-height:1.45;
      color:var(--muted);
    }
    .print-billing{
      padding:6px 16px;
      border-bottom:1px solid var(--line);
      background:#f8fbff;
      display:flex;
      justify-content:space-between;
      gap:8px;
      font-size:8px;
      line-height:1.35;
    }
    .print-billing strong{
      white-space:nowrap;
      color:var(--muted);
      text-transform:uppercase;
      letter-spacing:.16em;
    }
    .print-billing span:last-child{
      text-align:right;
      font-size:9px;
      font-weight:700;
      color:var(--ink);
    }
    .print-grid{
      padding:10px 16px 6px;
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:7px;
    }
    .print-box{
      border:1px solid var(--line);
      border-radius:12px;
      padding:8px 10px;
      min-height:50px;
      background:#fff;
    }
    .print-box.full{
      grid-column:1 / -1;
    }
    .print-label{
      font-size:8px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:var(--muted);
    }
    .print-value{
      margin-top:4px;
      font-size:11px;
      font-weight:700;
      line-height:1.25;
      word-break:break-word;
    }
    .print-section{
      padding:0 16px 8px;
    }
    .print-section-head{
      margin-bottom:5px;
      display:flex;
      justify-content:space-between;
      gap:10px;
      font-size:8px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:var(--muted);
    }
    .print-table{
      width:100%;
      border:1px solid var(--line);
      border-radius:12px;
      border-collapse:separate;
      border-spacing:0;
      overflow:hidden;
      background:#fff;
    }
    .print-table thead th{
      padding:7px 10px;
      background:var(--soft);
      font-size:8px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:var(--muted);
      text-align:left;
    }
    .print-table thead th:last-child,
    .print-table tbody td:last-child{
      text-align:right;
    }
    .print-table tbody td{
      padding:7px 10px;
      border-top:1px dashed var(--line);
      font-size:10px;
      vertical-align:top;
    }
    .print-item-name{
      font-weight:700;
      line-height:1.25;
    }
    .print-item-meta{
      margin-top:2px;
      font-size:8px;
      color:var(--muted);
      line-height:1.35;
    }
    .print-money{
      white-space:nowrap;
      font-weight:700;
    }
    .print-total{
      margin:0 16px 8px;
      padding:9px 10px;
      border:1px solid rgba(31,143,214,.24);
      border-radius:14px;
      background:linear-gradient(180deg, #fbfdff 0%, var(--soft-accent) 100%);
    }
    .print-line{
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:flex-end;
      padding:1px 0;
      font-size:10px;
    }
    .print-line span:first-child{
      flex:1;
    }
    .print-line strong{
      white-space:nowrap;
    }
    .print-line.total{
      margin-top:5px;
      padding-top:5px;
      border-top:1px dashed rgba(31,143,214,.32);
      font-size:13px;
      font-weight:800;
    }
    .print-note{
      padding:7px 10px;
      border:1px solid var(--line);
      border-radius:12px;
      background:#fff;
      font-size:9px;
      line-height:1.45;
    }
    .print-foot{
      padding:2px 16px 10px;
      text-align:center;
      font-size:8px;
      line-height:1.45;
      color:var(--muted);
    }
    .print-foot strong{
      display:block;
      margin-bottom:2px;
      color:var(--ink);
      font-size:10px;
      letter-spacing:.04em;
    }
    .print-return-banner{
      margin-bottom:6px;
      padding:7px 8px;
      border-radius:12px;
      border:1px solid #f0c7bf;
      background:#fff3ef;
      color:#7f2b24;
      display:flex;
      justify-content:space-between;
      gap:10px;
      font-size:9px;
      font-weight:700;
    }
    .print-return-card{
      border:1px solid #f0d8d3;
      border-radius:10px;
      padding:6px 8px;
      background:#fffaf8;
    }
    .print-return-card + .print-return-card{
      margin-top:5px;
    }
    .print-return-row{
      display:flex;
      justify-content:space-between;
      gap:8px;
      font-size:8px;
      line-height:1.35;
    }
    .print-return-row strong{
      text-align:right;
    }
    .print-return-note{
      margin-top:4px;
      padding-top:4px;
      border-top:1px dashed #f0d8d3;
      font-size:8px;
      line-height:1.35;
      color:var(--ink);
    }
    @media (max-width: 620px){
      body{
        padding:10px;
      }
      .receipt{
        width:100%;
        border-radius:20px;
      }
      .hero{
        padding:18px 18px 16px;
      }
      .hero h1{
        font-size:22px;
      }
      .hero-top,
      .hero-sub{
        flex-direction:column;
        align-items:flex-start;
      }
      .contact,
      .billing-strip,
      .meta,
      .section,
      .footer{
        padding-left:18px;
        padding-right:18px;
      }
      .summary{
        margin-left:18px;
        margin-right:18px;
      }
      .meta{
        grid-template-columns:1fr;
      }
      .return-grid{
        grid-template-columns:1fr;
      }
    }
    @media print{
      html,
      body{
        margin:0;
        padding:0;
        background:#fff;
        height:auto;
      }
      .stage{
        display:block;
      }
      .receipt{
        display:none !important;
      }
      .receipt-print{
        display:block !important;
      }
      .print-sheet{
        width:100%;
        border:none;
        border-radius:0;
        box-shadow:none;
      }
      .print-head{
        padding:10px 11px 8px;
      }
      .print-title{
        font-size:18px;
      }
      .print-badge{
        padding:5px 8px;
        font-size:9px;
      }
      .print-sub{
        margin-top:7px;
        font-size:8px;
      }
      .print-contact{
        padding:6px 11px;
        font-size:7px;
      }
      .print-grid{
        padding:8px 11px 4px;
        gap:6px;
      }
      .print-box{
        min-height:42px;
        padding:7px 8px;
        border-radius:10px;
      }
      .print-value{
        font-size:10px;
      }
      .print-section{
        padding:0 11px 6px;
      }
      .print-section-head{
        margin-bottom:4px;
        font-size:7px;
      }
      .print-table{
        border-radius:10px;
      }
      .print-table thead th{
        padding:6px 8px;
        font-size:7px;
      }
      .print-table tbody td{
        padding:6px 8px;
        font-size:9px;
      }
      .print-item-meta{
        font-size:7px;
      }
      .print-total{
        margin:0 11px 6px;
        padding:7px 8px;
      }
      .print-line{
        font-size:9px;
      }
      .print-line.total{
        margin-top:4px;
        padding-top:4px;
        font-size:12px;
      }
      .print-note{
        padding:6px 8px;
        font-size:8px;
      }
      .print-foot{
        padding:1px 11px 4px;
        font-size:7px;
      }
      .print-foot strong{
        font-size:9px;
      }
      .print-return-banner{
        margin-bottom:4px;
        padding:6px 7px;
        font-size:8px;
      }
      .print-return-card{
        padding:5px 7px;
      }
      .print-return-row,
      .print-return-note{
        font-size:7px;
      }
      .receipt{
        width:4.86in;
        max-width:100%;
        margin:0 auto;
        min-height:0;
        height:auto;
        border:none;
        border-radius:0;
        box-shadow:none;
        overflow:visible;
        display:block;
        page-break-after:avoid;
        break-after:avoid-page;
      }
      .hero,
      .contact,
      .meta,
      .section,
      .summary,
      .footer,
      .meta-card,
      .items,
      .note-box{
        page-break-inside:auto;
        break-inside:auto;
      }
      .hero-top{
        display:block;
      }
      .hero-pill{
        display:inline-block;
        margin-top:10px;
      }
      .hero{
        padding:16px 16px 14px;
        border-bottom:none;
      }
      .hero h1{
        font-size:22px;
      }
      .hero-sub{
        margin-top:10px;
        font-size:10px;
        gap:8px;
      }
      .contact,
      .items-head{
        background:var(--soft);
      }
      .billing-strip{
        padding:7px 16px;
      }
      .billing-label{
        font-size:9px;
      }
      .billing-value{
        font-size:11px;
      }
      .contact{
        padding:8px 16px;
        font-size:9px;
        line-height:1.45;
      }
      .print-billing{
        padding:5px 11px;
        font-size:7px;
      }
      .print-billing span:last-child{
        font-size:8px;
      }
      .meta{
        padding:10px 16px 4px;
        gap:8px;
      }
      .meta-card{
        min-height:64px;
        padding:9px 11px;
      }
      .meta-value{
        margin-top:4px;
        font-size:13px;
      }
      .section{
        padding:0 16px 10px;
      }
      .section-title{
        margin-bottom:6px;
        font-size:9px;
      }
      .items-head{
        padding:8px 10px;
        font-size:9px;
      }
      .item-row{
        padding:8px 10px;
        gap:8px;
      }
      .item-title{
        font-size:12px;
      }
      .item-sub{
        margin-top:2px;
        font-size:9px;
      }
      .item-amt{
        font-size:13px;
      }
      .summary{
        margin:0 16px 10px;
        padding:10px 12px;
        background:var(--soft-accent);
      }
      .name{
        font-size:12px;
      }
      .amt{
        min-width:84px;
        font-size:13px;
      }
      .grand{
        margin-top:8px;
        padding-top:8px;
      }
      .grand .name,
      .grand .amt{
        font-size:16px;
      }
      .note-box{
        padding:10px 12px;
        font-size:11px;
      }
      .footer{
        padding:0 16px 8px;
        font-size:9px;
        margin-top:0;
      }
      .footer strong{
        font-size:11px;
      }
    }
  </style>
</head>
<body>
  <main class="stage">
    <article class="receipt">
      <header class="hero">
        <div class="hero-top">
          <div class="brand">
            <div class="brand-mark">HHG</div>
            <div class="brand-copy">
              <div class="eyebrow">Hospital Hilario Galindo</div>
              <h1>${tReceipt(lang, 'sale_receipt')}</h1>
            </div>
          </div>
          <div class="hero-pill">${tReceipt(lang, 'receipt')} #${id}</div>
        </div>
        <div class="hero-sub">
          <span>Documento de cobro emitido</span>
          <span>${receiptDate}</span>
        </div>
      </header>

      <div class="contact">
        <div>Finca San Cayetano, San Felipe, Retalhuleu, Guatemala</div>
        <div>Tel: (502) 7772-5059 · informacion@hospitalhilariogalindo.org</div>
      </div>

      ${
        billingSummaryHtml
          ? `<div class="billing-strip">
              <span class="billing-label">${tReceipt(lang, 'billing_data')}</span>
              <span class="billing-value">${billingSummaryHtml}</span>
            </div>`
          : ''
      }
      ${
        felSummaryHtml
          ? `<div class="billing-strip">
              <span class="billing-label">FEL</span>
              <span class="billing-value">${felSummaryHtml}</span>
            </div>`
          : ''
      }

      <section class="meta">
        <div class="meta-card">
          <div class="meta-label">${tReceipt(lang, 'date')}</div>
          <div class="meta-value">${receiptDate}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">${tReceipt(lang, 'cashier')}</div>
          <div class="meta-value">${cashierName}</div>
        </div>
        ${
          receiptNameHtml
            ? `<div class="meta-card" style="grid-column:1 / -1;">
                <div class="meta-label">${tReceipt(lang, 'on_behalf_of')}</div>
                <div class="meta-value">${receiptNameHtml}</div>
              </div>`
            : ''
        }
      </section>

      <section class="section">
        <div class="section-title">
          <span>${tReceipt(lang, 'detail')}</span>
          <span>${grouped.length} linea${grouped.length === 1 ? '' : 's'}</span>
        </div>
        <div class="items">
          <div class="items-head">
            <span>${tReceipt(lang, 'product')}</span>
            <span>${tReceipt(lang, 'subtotal')}</span>
          </div>
          ${itemLines.join('')}
        </div>
      </section>

      <section class="summary">
        ${
          discountAmount != null && discountAmount > 0
            ? `<div class="line"><span class="name">${tReceipt(lang, 'total')}</span><span class="amt">Q${fmtMoney(
                grossTotal
              )}</span></div>
               <div class="line"><span class="name">${tReceipt(lang, 'discount')}${
                 discountLabelPercent != null ? ` ${fmtPct(discountLabelPercent)}%` : ''
               }</span><span class="amt">Q${fmtMoney(discountAmount)}</span></div>
               <div class="line grand"><span class="name">${tReceipt(
                 lang,
                 'total_to_pay'
               )}</span><span class="amt">Q${fmtMoney(netTotal)}</span></div>`
            : `<div class="line grand"><span class="name">${tReceipt(lang, 'total')}</span><span class="amt">Q${fmtMoney(
                total
              )}</span></div>`
        }
      </section>

      ${
        paymentLines.length
          ? `<section class="section">
              <div class="section-title">
                <span>${tReceipt(lang, 'payments')}</span>
                <span>${paymentLines.length} registro${paymentLines.length === 1 ? '' : 's'}</span>
              </div>
              <div class="items">
                <div class="items-head">
                  <span>${tReceipt(lang, 'payments')}</span>
                  <span>${tReceipt(lang, 'total')}</span>
                </div>
                <div style="padding:6px 10px 8px;">
                  ${paymentLines.join('')}
                  ${
                    efectivoRecibido != null || cambio != null
                      ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);">
                          ${efectivoRecibido != null ? `<div class="line"><span class="name">${tReceipt(
                            lang,
                            'received'
                          )}</span><span class="amt">Q${fmtMoney(efectivoRecibido)}</span></div>` : ''}
                          ${cambio != null ? `<div class="line"><span class="name">${tReceipt(
                            lang,
                            'change'
                          )}</span><span class="amt">Q${fmtMoney(cambio)}</span></div>` : ''}
                        </div>`
                      : ''
                  }
                </div>
              </div>
            </section>`
          : ''
      }

      ${
        hasReturns
          ? `<section class="section return-section">
              <div class="section-title">
                <span>${tReceipt(lang, 'cancellations')}</span>
                <span>${returnEvents.length} registro${returnEvents.length === 1 ? '' : 's'}</span>
              </div>
              <div class="return-banner ${isFullyCancelled ? 'full' : ''}">
                <strong>${returnStatus}</strong>
                ${returnBannerAmount}
              </div>
              <div class="return-cards">
                ${returnEventCards}
              </div>
            </section>`
          : ''
      }

      ${
        extraNote
          ? `<section class="section">
              <div class="section-title">
                <span>${tReceipt(lang, 'note')}</span>
                <span>Registro</span>
              </div>
              <div class="note-box">${extraNote}</div>
            </section>`
          : ''
      }

      <footer class="footer">
        <strong>${tReceipt(lang, 'thanks')}</strong>
        <span> Hospital Hilario Galindo. </span>
      </footer>
    </article>
    <article class="receipt-print">
      <section class="print-sheet">
        <header class="print-head">
          <div class="print-head-top">
            <div class="print-brand">
              <div class="print-brand-name">Hospital Hilario Galindo</div>
              <div class="print-title">${tReceipt(lang, 'sale_receipt')}</div>
            </div>
            <div class="print-badge">${tReceipt(lang, 'receipt')} #${id}</div>
          </div>
          <div class="print-sub">
            <span>Documento de cobro emitido</span>
            <span>${receiptDate}</span>
          </div>
        </header>

        <div class="print-contact">
          Finca San Cayetano, San Felipe, Retalhuleu, Guatemala
          <br>
          Tel: (502) 7772-5059 · informacion@hospitalhilariogalindo.org
        </div>

        ${
          billingSummaryHtml
            ? `<div class="print-billing">
                <strong>${tReceipt(lang, 'billing_data')}</strong>
                <span>${billingSummaryHtml}</span>
              </div>`
            : ''
        }
        ${
          felSummaryHtml
            ? `<div class="print-billing">
                <strong>FEL</strong>
                <span>${felSummaryHtml}</span>
              </div>`
            : ''
        }

        <section class="print-grid">
          <div class="print-box">
            <div class="print-label">${tReceipt(lang, 'date')}</div>
            <div class="print-value">${receiptDate}</div>
          </div>
          <div class="print-box">
            <div class="print-label">${tReceipt(lang, 'cashier')}</div>
            <div class="print-value">${cashierName}</div>
          </div>
          ${
            receiptNameHtml
              ? `<div class="print-box full">
                  <div class="print-label">${tReceipt(lang, 'on_behalf_of')}</div>
                  <div class="print-value">${receiptNameHtml}</div>
                </div>`
              : ''
          }
        </section>

        <section class="print-section">
          <div class="print-section-head">
            <span>${tReceipt(lang, 'detail')}</span>
            <span>${grouped.length} linea${grouped.length === 1 ? '' : 's'}</span>
          </div>
          <table class="print-table">
            <thead>
              <tr>
                <th>${tReceipt(lang, 'product')}</th>
                <th>${tReceipt(lang, 'subtotal')}</th>
              </tr>
            </thead>
            <tbody>
              ${compactItemRows}
            </tbody>
          </table>
        </section>

        <section class="print-total">
          ${
            discountAmount != null && discountAmount > 0
              ? `<div class="print-line"><span>${tReceipt(lang, 'total')}</span><strong>Q${fmtMoney(grossTotal)}</strong></div>
                 <div class="print-line"><span>${tReceipt(lang, 'discount')}${
                   discountLabelPercent != null ? ` ${fmtPct(discountLabelPercent)}%` : ''
                 }</span><strong>Q${fmtMoney(discountAmount)}</strong></div>
                 <div class="print-line total"><span>${tReceipt(lang, 'total_to_pay')}</span><strong>Q${fmtMoney(
                   netTotal
                 )}</strong></div>`
              : `<div class="print-line total"><span>${tReceipt(lang, 'total')}</span><strong>Q${fmtMoney(
                  total
                )}</strong></div>`
          }
        </section>

        ${
          compactPaymentRows
            ? `<section class="print-section">
                <div class="print-section-head">
                  <span>${tReceipt(lang, 'payments')}</span>
                  <span>${paymentLines.length} registro${paymentLines.length === 1 ? '' : 's'}</span>
                </div>
                <table class="print-table">
                  <thead>
                    <tr>
                      <th>${tReceipt(lang, 'payments')}</th>
                      <th>${tReceipt(lang, 'total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${compactPaymentRows}
                    ${
                      efectivoRecibido != null
                        ? `<tr><td>${tReceipt(lang, 'received')}</td><td class="print-money">Q${fmtMoney(
                            efectivoRecibido
                          )}</td></tr>`
                        : ''
                    }
                    ${
                      cambio != null
                        ? `<tr><td>${tReceipt(lang, 'change')}</td><td class="print-money">Q${fmtMoney(cambio)}</td></tr>`
                        : ''
                    }
                  </tbody>
                </table>
              </section>`
            : ''
        }

        ${
          hasReturns
            ? `<section class="print-section">
                <div class="print-section-head">
                  <span>${tReceipt(lang, 'cancellations')}</span>
                  <span>${returnEvents.length} registro${returnEvents.length === 1 ? '' : 's'}</span>
                </div>
                <div class="print-return-banner">
                  <span>${returnStatus}</span>
                  <strong>Q${fmtMoney(totalRefunded)}</strong>
                </div>
                ${compactReturnEvents}
              </section>`
            : ''
        }

        ${
          extraNote
            ? `<section class="print-section">
                <div class="print-section-head">
                  <span>${tReceipt(lang, 'note')}</span>
                  <span>Registro</span>
                </div>
                <div class="print-note">${extraNote}</div>
              </section>`
            : ''
        }

        <footer class="print-foot">
          <strong>${tReceipt(lang, 'thanks')}</strong>
          <span>Hospital Hilario Galindo.</span>
        </footer>
      </section>
    </article>
  </main>
  <script>
    window.addEventListener('afterprint', () => {
      try { window.close(); } catch (_) {}
    });
    window.onload = () => {
      window.print();
      setTimeout(() => {
        try { window.close(); } catch (_) {}
      }, 1400);
    };
  </script>
</body>
</html>`;
    res.type('text/html').send(html);
  })
);

router.get(
  '/invoice_pdf_fpdf',
  asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const id =
      Number(req.query.venta_id || 0) ||
      Number(req.query.id_venta || 0) ||
      Number(req.query.sale_id || 0) ||
      Number(req.query.id || 0);
    if (!id) return res.type('text/plain').send('ID inválido');

    const data = await fetchSaleDetails(null, id);
    if (!data) return res.type('text/plain').send('Venta no encontrada');

    const servicesRaw = collectServiceLines(data.pagos);
    const serviceMap = new Map();
    for (const s of servicesRaw) {
      const rawName = String(s.producto || s.descripcion || 'servicio');
      const key = rawName.trim().toLowerCase().replace(/\s+/g, ' ');
      const sub = s.subtotal != null ? Number(s.subtotal) : Number(s.cantidad || 0) * Number(s.precio_unit || 0);
      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          ...s,
          producto: rawName.trim(),
          cantidad: Number(s.cantidad || 1),
          subtotal: Number.isFinite(sub) ? sub : 0,
          is_service: true
        });
      } else {
        const cur = serviceMap.get(key);
        cur.cantidad = Number(cur.cantidad || 1) + Number(s.cantidad || 1);
        cur.subtotal = Number(cur.subtotal || 0) + (Number.isFinite(sub) ? sub : 0);
      }
    }
    const services = Array.from(serviceMap.values());
    const isHospital = isHospitalReceipt(data.sale, data.pagos);
    const rows = [...data.items, ...services];
    const baseHeight = 260;
    const lineHeight = 14;
    const noteHeight = data.sale.note ? 24 : 0;
    const paymentsHeight = data.pagos.length ? 16 + data.pagos.length * 12 : 0;
    const rowCount = isHospital ? 1 : rows.length;

    const grossTotal = rows.reduce((sum, r) => {
      const sub = r.subtotal != null ? Number(r.subtotal) : Number(r.cantidad || 0) * Number(r.precio_unit || 0);
      return sum + (Number.isFinite(sub) ? sub : 0);
    }, 0);
    const totalValue = data.sale.total != null ? Number(data.sale.total) : grossTotal;
    let discountPercent = null;
    for (const p of data.pagos || []) {
      let det =
        p.payment_method_details ??
        p.det ??
        p.detalles ??
        p.meta ??
        null;
      if (!det) continue;
      try {
        if (typeof det === 'string') det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
      if (!det || typeof det !== 'object') continue;
      if (det.discount_percent != null) discountPercent = Number(det.discount_percent);
    }
    let discountAmount = null;
    if (!isHospital) {
      if (discountPercent != null && discountPercent > 0) {
        discountAmount = grossTotal * (discountPercent / 100);
        const net = Math.max(0, grossTotal - discountAmount);
        if (Number.isFinite(totalValue) && Math.abs(totalValue - net) > 0.02) {
          discountAmount = Math.max(0, grossTotal - totalValue);
        }
      } else if (Number.isFinite(grossTotal) && Number.isFinite(totalValue) && grossTotal - totalValue > 0.009) {
        discountAmount = grossTotal - totalValue;
      }
    }

    const discountHeight = isHospital ? 12 : discountAmount && discountAmount > 0 ? 24 : 0;
    const pageHeight = Math.max(
      320,
      baseHeight + rowCount * lineHeight + paymentsHeight + noteHeight + discountHeight
    );
    const servicesTotal = services.reduce((sum, r) => {
      const sub = r.subtotal != null ? Number(r.subtotal) : Number(r.cantidad || 0) * Number(r.precio_unit || 0);
      return sum + (Number.isFinite(sub) ? sub : 0);
    }, 0);

    let returnLines = [];
    let returnTotal = 0;
    let returnServiceTotal = 0;
    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    if (await tableExists(null, returnsTable)) {
      const returnCols = await getColumns(null, returnsTable);
      const totalCol = returnCols.includes('total_return') ? 'total_return' : returnCols.includes('total') ? 'total' : null;
      const serviceCol = returnCols.includes('service_total') ? 'service_total' : null;
      const retRows = await query(
        `SELECT id ${totalCol ? `, ${totalCol} AS total_return` : ''} ${serviceCol ? `, ${serviceCol} AS service_total` : ''} FROM ${quoteIdent(
          returnsTable
        )} WHERE sale_id = $1`,
        [id]
      );
      const returnIds = retRows.rows.map((r) => Number(r.id)).filter(Boolean);
      if (returnIds.length) {
        if (totalCol) {
          returnTotal = retRows.rows.reduce((s, r) => s + Number(r.total_return || 0), 0);
        }
        if (serviceCol) {
          returnServiceTotal = retRows.rows.reduce((s, r) => s + Number(r.service_total || 0), 0);
        }
        const returnItemsTable = await pickTable(null, ['sale_return_items'], 'sale_return_items');
        if (await tableExists(null, returnItemsTable)) {
          const riRes = await query(
            `SELECT ri.product_id, SUM(ri.quantity) AS qty, SUM(ri.subtotal) AS subtotal, p.nombre_comercial AS producto
             FROM ${quoteIdent(returnItemsTable)} ri
             LEFT JOIN productos p ON p.id = ri.product_id
             WHERE ri.return_id = ANY($1)
             GROUP BY ri.product_id, p.nombre_comercial`,
            [returnIds]
          );
          returnLines = riRes.rows.map((r) => ({
            producto: r.producto || `Producto ${r.product_id}`,
            cantidad: Number(r.qty || 0),
            subtotal: Number(r.subtotal || 0)
          }));
          if (!totalCol) {
            returnTotal = returnLines.reduce((s, r) => s + Number(r.subtotal || 0), 0) + returnServiceTotal;
          }
        }
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    const doc = new PDFDocument({ size: [396, 612], margin: 12 });
    doc.pipe(res);

    const leftX = doc.page.margins.left;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rightColWidth = 58;
    const colGap = 6;
    const leftColWidth = Math.max(80, contentWidth - rightColWidth - colGap);
    const rightX = leftX + leftColWidth + colGap;

    doc.fontSize(12).text('HOSPITAL HILARIO GALINDO', { align: 'center' });
    doc.fontSize(8).text('Finca San Cayetano, San Felipe, Retalhuleu, Guatemala', { align: 'center' });
    doc.text('Tel: (502) 7772-5059', { align: 'center' });
    doc.text('informacion@hospitalhilariogalindo.org', { align: 'center' });
    doc.moveDown(0.5);
    doc.text('--------------------------------', leftX, doc.y, { width: contentWidth, align: 'center' });
    doc.fontSize(10).text(tReceipt(lang, 'sale_receipt'), { align: 'center' });
    doc.fontSize(8).text(`${tReceipt(lang, 'receipt')} #${id}`);
    const nameLine = extractReceiptName(data.pagos, data.sale.note);
    const customerIdentity = extractCustomerIdentity(data.sale, data.pagos);
    const customerLabel = formatCustomerIdentityLabel(customerIdentity.type, lang);
    const customerDocument = String(customerIdentity.document || '').trim();
    if (nameLine) {
      doc.text(`${tReceipt(lang, 'on_behalf_of')}: ${nameLine}`);
    }
    doc.text(`${tReceipt(lang, 'date')}: ${formatDateLocale(data.sale.fecha, lang) || ''}`);
    doc.text(`${tReceipt(lang, 'cashier')}: ${data.username || '--'}`);
    if (customerLabel || customerDocument) {
      const billingLine =
        customerLabel && customerDocument
          ? `${customerLabel}: ${customerDocument}`
          : customerLabel || customerDocument;
      doc.text(`${tReceipt(lang, 'billing_data')}: ${billingLine}`);
    }
    if (data.sale.note) {
      doc.moveDown(0.5);
      doc.fontSize(8).text(`${tReceipt(lang, 'note')}:`);
      doc.fontSize(8).text(String(data.sale.note));
    }
    doc.moveDown(0.5);
    if (isHospital) {
      const servicesAmount =
        data.sale.total != null
          ? Number(data.sale.total)
          : servicesTotal;
    
      doc.text(tReceipt(lang, 'detail'), { align: 'center' });
      doc.text('--------------------------------', leftX, doc.y, { width: contentWidth, align: 'center' });
      const headerY = doc.y;
      doc.text(tReceipt(lang, 'hospital_services'), leftX, headerY, { width: leftColWidth });
      doc.text(`Q${fmtMoney(servicesAmount)}`, rightX, headerY, { width: rightColWidth, align: 'right' });
      doc.y = headerY + doc.heightOfString(tReceipt(lang, 'hospital_services'), { width: leftColWidth });
      doc.text('--------------------------------', leftX, doc.y, { width: contentWidth, align: 'center' });
    } else {
      doc.text(tReceipt(lang, 'detail'), { align: 'center' });
      doc.text('--------------------------------', leftX, doc.y, { width: contentWidth, align: 'center' });
    }

    const drawDetailLine = (label, amount) => {
      const y = doc.y;
      doc.fontSize(8);
      const height = doc.heightOfString(label, { width: leftColWidth });
      doc.text(label, leftX, y, { width: leftColWidth });
      doc.text(`Q${fmtMoney(amount)}`, rightX, y, { width: rightColWidth, align: 'right' });
      doc.y = y + height;
      doc.moveDown(0.2);
    };

    let total = 0;
    if (!isHospital) {
      for (const r of rows) {
        const sub = r.subtotal != null ? Number(r.subtotal) : Number(r.cantidad || 0) * Number(r.precio_unit || 0);
        total += sub;
        const qty = Number(r.cantidad || 1);
        const name = String(r.producto || 'Servicio');
        const label =
          r.is_service || qty === 1
            ? name
            : `${name} x${fmtQty(qty)}`;
        const ratio = discountAmount && grossTotal > 0 ? Math.max(0, Math.min(1, totalValue / grossTotal)) : 1;
        const adj = ratio < 1 ? sub * ratio : sub;
        drawDetailLine(label, adj);
      }
    }

    if (isHospital) {
      const discountAmount = extractHospitalDiscount(data.pagos);
      doc.fontSize(8).text(`${tReceipt(lang, 'discount')}: Q${fmtMoney(discountAmount)}`, { align: 'right' });
      doc.fontSize(9).text(`${tReceipt(lang, 'total')}: Q${fmtMoney(totalValue)}`, { align: 'right' });
    } else if (discountAmount && discountAmount > 0) {
      const pctLabel =
        discountPercent != null && discountPercent > 0
          ? `${Number(discountPercent).toFixed(2).replace(/\\.00$/, '')}%`
          : '';
      doc.fontSize(8).text(`${tReceipt(lang, 'total')}: Q${fmtMoney(grossTotal)}`, { align: 'right' });
      doc.fontSize(8).text(
        `${tReceipt(lang, 'discount')}${pctLabel ? ' ' + pctLabel : ''}: Q${fmtMoney(discountAmount)}`,
        { align: 'right' }
      );
      doc.fontSize(9).text(`${tReceipt(lang, 'total_to_pay')}: Q${fmtMoney(totalValue)}`, { align: 'right' });
    } else {
      doc.fontSize(9).text(`${tReceipt(lang, 'total')}: Q${fmtMoney(totalValue)}`, { align: 'right' });
    }
    if (data.pagos.length) {
      doc.moveDown(0.5);
      doc.fontSize(8).text(tReceipt(lang, 'payments'), leftX);
      for (const p of data.pagos) {
        doc.text(`${translatePaymentType(lang, p.payment_type || tReceipt(lang, 'payments'))}: Q${fmtMoney(p.amount || 0)}`, leftX);
      }
    }
    let efectivoRecibido = null;
    let cambio = null;
    for (const p of data.pagos || []) {
      let det =
        p.payment_method_details ??
        p.det ??
        p.detalles ??
        p.meta ??
        null;
      if (!det) continue;
      try {
        if (typeof det === 'string') det = JSON.parse(det);
      } catch (_) {
        det = null;
      }
      if (!det || typeof det !== 'object') continue;
      if (det.efectivo_recibido != null) efectivoRecibido = Number(det.efectivo_recibido);
      if (det.cambio != null) cambio = Number(det.cambio);
    }
    if (efectivoRecibido != null || cambio != null) {
      doc.moveDown(0.2);
      if (efectivoRecibido != null) doc.text(`${tReceipt(lang, 'received')}: Q${fmtMoney(efectivoRecibido)}`, leftX);
      if (cambio != null) doc.text(`${tReceipt(lang, 'change')}: Q${fmtMoney(cambio)}`, leftX);
    }
    if (returnLines.length || returnServiceTotal > 0) {
      doc.moveDown(0.5);
      doc.fontSize(8).text(tReceipt(lang, 'cancellations'), leftX);
      for (const r of returnLines) {
        const label = r.cantidad && r.cantidad !== 1 ? `${r.producto} x${fmtQty(r.cantidad)}` : r.producto;
        doc.text(`${label}: Q${fmtMoney(r.subtotal || 0)}`, leftX);
      }
      if (returnServiceTotal > 0) {
        doc.text(`${tReceipt(lang, 'cancelled_services')}: Q${fmtMoney(returnServiceTotal)}`, leftX);
      }
      const totalDev = returnTotal > 0 ? returnTotal : returnLines.reduce((s, r) => s + Number(r.subtotal || 0), 0) + returnServiceTotal;
      doc.text(`${tReceipt(lang, 'total_cancelled')}: Q${fmtMoney(totalDev)}`, leftX);
    }
    doc.moveDown(0.5);
    doc.text(tReceipt(lang, 'thanks'), leftX, doc.y, { width: contentWidth, align: 'center' });
    doc.end();
  })
);

router.get(
  '/top_sold_medicines',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    await requireRole(['admin', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    const startDate = parseTopSoldDate(req.query.start || req.query.from);
    const endDate = parseTopSoldDate(req.query.end || req.query.to);
    const branchId = req.query.branch_id != null && req.query.branch_id !== '' ? Number(req.query.branch_id) : null;
    const limit = parseTopSoldLimit(req.query.limit);

    try {
      const rows = await buildTopSoldMedicinesRows(null, { startDate, endDate, branchId, limit });
      return safeJson(res, {
        ok: true,
        rows,
        filters: { start: startDate, end: endDate, branch_id: branchId, limit },
        summary: {
          total_products: rows.length,
          total_qty: Number(rows.reduce((sum, row) => sum + Number(row.total_qty || 0), 0).toFixed(2)),
          direct_qty: Number(rows.reduce((sum, row) => sum + Number(row.direct_qty || 0), 0).toFixed(2)),
          combo_qty: Number(rows.reduce((sum, row) => sum + Number(row.combo_qty || 0), 0).toFixed(2)),
          direct_total: Number(rows.reduce((sum, row) => sum + Number(row.direct_total || 0), 0).toFixed(2))
        }
      });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'Error generando ranking' }, 500);
    }
  })
);

router.get(
  '/top_sold_medicines_export',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    await requireRole(['admin', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    const startDate = parseTopSoldDate(req.query.start || req.query.from);
    const endDate = parseTopSoldDate(req.query.end || req.query.to);
    const branchId = req.query.branch_id != null && req.query.branch_id !== '' ? Number(req.query.branch_id) : null;
    const limit = parseTopSoldLimit(req.query.limit);
    const rows = await buildTopSoldMedicinesRows(null, { startDate, endDate, branchId, limit });
    const label = dateRangeLabel(startDate, endDate);
    const buffer = buildTopSoldMedicinesWorkbook(rows, label);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="medicamentos_mas_vendidos_${stamp}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.end(buffer);
  })
);

router.get(
  '/cash_cut_report',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    await requireRole(['admin', 'cashier', 'cajero', 'farmacia'])(req, res, async () => {});
    if (res.headersSent) return;

    const role = canonRole(req.session.user.rol || req.session.user.role || '');
    const startRaw = String(req.query.start || req.query.from || '').trim();
    const endRaw = String(req.query.end || req.query.to || '').trim();
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
    const branchId = req.query.branch_id != null ? Number(req.query.branch_id) : null;
    const cajaId = req.query.caja_id != null ? Number(req.query.caja_id) : null;

    try {
      const rows = await buildCashCutRows(null, { startDate, endDate, branchId, cajaId });
      return safeJson(res, { ok: true, rows });
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'Error generando reporte' }, 500);
    }
  })
);

router.get(
  '/cash_cut_export',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    await requireRole(['admin', 'cashier', 'cajero', 'farmacia'])(req, res, async () => {});
    if (res.headersSent) return;

    const role = canonRole(req.session.user.rol || req.session.user.role || '');
    const startRaw = String(req.query.start || req.query.from || '').trim();
    const endRaw = String(req.query.end || req.query.to || '').trim();
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
    const branchId = req.query.branch_id != null ? Number(req.query.branch_id) : null;
    const cajaId = req.query.caja_id != null ? Number(req.query.caja_id) : null;

    const rows = await buildCashCutRows(null, { startDate, endDate, branchId, cajaId });
    const label = dateRangeLabel(startDate, endDate);
    const buffer = buildCashCutWorkbook(rows, label);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="corte_caja_${stamp}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.end(buffer);
  })
);

module.exports = router;
