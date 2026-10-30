const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx-js-style');
const {
  query,
  withTransaction,
  tableExists,
  columnExists,
  pickTable,
  pickColumn,
  getColumns,
  quoteIdent
} = require('../db');
const { safeJson, readJson, canonRole } = require('../helpers');
const { requireRole } = require('../auth');
const {
  productStocksAvailable,
  adjustBranchStock,
  getBranchStock,
  logAction,
  branchIdByHint
} = require('../functions');
const { autoEntryForSale } = require('../accounting');
const { logAuditEvent } = require('../utils/audit');
const {
  roundMoney,
  normalizePresentationType,
  resolvePresentationConfig,
  getPresentationFactor,
  getPresentationPrice,
  getPresentationLabel
} = require('../utils/productPresentation');
const {
  normalizeProductType,
  productTypeUsesInventory,
  productTypeIsCombo,
  ensureProductTypeColumn,
  ensureComboItemsTable,
  fetchComboComponents
} = require('../utils/productCatalog');
const { certifySaleIfEnabled } = require('../utils/fel');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function resolveAdmissionBranchId(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'emergencia') return await branchIdByHint(null, 'emergencia');
  if (t === 'hospitalizacion') {
    return (await branchIdByHint(null, 'hospitalizacion')) || (await branchIdByHint(null, 'hospital'));
  }
  return null;
}

let consultSchemaReady = false;
let ineSchemaReady = false;
let hospitalSchemaReady = false;
const ADMISSION_SESSION_TTL_SECONDS = 120;
const HOSPITAL_EVENT_HEARTBEAT_MS = 25000;
const hospitalEventSubscribers = new Set();

function buildHospitalEventPayload(event = {}) {
  const areaValues = Array.isArray(event.areas) ? event.areas : [event.area];
  const areas = Array.from(
    new Set(
      areaValues
        .map((value) => normalizeAdmissionArea(value))
        .filter(Boolean)
    )
  );
  return {
    type: String(event.type || 'refresh').trim().toLowerCase() || 'refresh',
    reason: String(event.reason || '').trim().toLowerCase() || null,
    areas: areas.length ? areas : ['all'],
    client_id: event.client_id != null ? Number(event.client_id || 0) || null : null,
    admission_id: event.admission_id != null ? Number(event.admission_id || 0) || null : null,
    ts: Date.now()
  };
}

function removeHospitalEventSubscriber(subscriber) {
  if (!subscriber) return;
  if (subscriber.heartbeat) {
    clearInterval(subscriber.heartbeat);
    subscriber.heartbeat = null;
  }
  hospitalEventSubscribers.delete(subscriber);
}

function writeHospitalEvent(subscriber, eventName, payload) {
  if (!subscriber?.res) return false;
  try {
    subscriber.res.write(`event: ${eventName}\n`);
    subscriber.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    removeHospitalEventSubscriber(subscriber);
    return false;
  }
}

function notifyHospitalRealtime(event = {}) {
  const payload = buildHospitalEventPayload(event);
  for (const subscriber of Array.from(hospitalEventSubscribers)) {
    const area = normalizeAdmissionArea(subscriber.area) || 'all';
    if (area !== 'all' && !payload.areas.includes('all') && !payload.areas.includes(area)) {
      continue;
    }
    writeHospitalEvent(subscriber, 'hospital', payload);
  }
}

async function ensureConsultSchema() {
  if (consultSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      sexo VARCHAR(20) NULL,
      fecha_nac DATE NULL,
      telefono VARCHAR(30) NULL,
      direccion VARCHAR(255) NULL,
      dpi VARCHAR(30) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS consultations (
      id SERIAL PRIMARY KEY,
      patient_id INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      motivo TEXT NULL,
      medico VARCHAR(50) NULL,
      consultorio VARCHAR(50) NULL,
      estado VARCHAR(30) DEFAULT 'pendiente',
      signos JSONB NULL,
      diagnostico TEXT NULL,
      receta JSONB NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL
    )
  `);
  await query('ALTER TABLE consultations ADD COLUMN IF NOT EXISTS consultorio VARCHAR(50) NULL');
  await query('ALTER TABLE consultations ADD COLUMN IF NOT EXISTS signos JSONB NULL');
  await query('ALTER TABLE consultations ADD COLUMN IF NOT EXISTS diagnostico TEXT NULL');
  await query('ALTER TABLE consultations ADD COLUMN IF NOT EXISTS receta JSONB NULL');
  await query('ALTER TABLE consultations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NULL');
  consultSchemaReady = true;
}

async function ensureIneSchema() {
  if (ineSchemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS ine_reports (
      id SERIAL PRIMARY KEY,
      client_id INT NULL,
      tipo VARCHAR(20) DEFAULT 'emergencia',
      fecha DATE NOT NULL,
      igss VARCHAR(5) NULL,
      dia_consulta VARCHAR(50) NULL,
      sexo VARCHAR(20) NULL,
      pueblo VARCHAR(50) NULL,
      edad_anios INT NULL,
      edad_meses INT NULL,
      direccion VARCHAR(255) NULL,
      municipio VARCHAR(100) NULL,
      consulta VARCHAR(50) NULL,
      control_materno VARCHAR(50) NULL,
      diagnostico TEXT NULL,
      cie VARCHAR(50) NULL,
      tratamiento VARCHAR(255) NULL,
      branch_id INT NULL,
      numero_orden INT NULL,
      fecha_ingreso DATE NULL,
      fecha_egreso DATE NULL,
      traslado VARCHAR(150) NULL,
      condicion_egreso VARCHAR(50) NULL,
      especialidad VARCHAR(100) NULL,
      procedimiento VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const adds = [
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS client_id INT NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS igss VARCHAR(5) NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS dia_consulta VARCHAR(50) NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS numero_orden INT NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS fecha_ingreso DATE NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS fecha_egreso DATE NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS traslado VARCHAR(150) NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS condicion_egreso VARCHAR(50) NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS especialidad VARCHAR(100) NULL',
    'ALTER TABLE ine_reports ADD COLUMN IF NOT EXISTS procedimiento VARCHAR(255) NULL'
  ];
  for (const sql of adds) {
    try {
      await query(sql);
    } catch (_) {}
  }
  ineSchemaReady = true;
}

async function ensureHospitalSchema() {
  if (hospitalSchemaReady) return;
  await ensureProductTypeColumn(null);
  await ensureComboItemsTable(null);
  if (await tableExists(null, 'productos')) {
    try {
      await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidades_por_tableta INTEGER DEFAULT 1');
    } catch (_) {}
    try {
      await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS tabletas_por_caja INTEGER DEFAULT 1');
    } catch (_) {}
    try {
      await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_unidad NUMERIC(12,2)');
    } catch (_) {}
    try {
      await query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_tableta NUMERIC(12,2)');
    } catch (_) {}
    try {
      await query(
        'UPDATE productos SET unidades_por_tableta = 1 WHERE unidades_por_tableta IS NULL OR unidades_por_tableta <= 0'
      );
    } catch (_) {}
    try {
      await query(
        'UPDATE productos SET tabletas_por_caja = 1 WHERE tabletas_por_caja IS NULL OR tabletas_por_caja <= 0'
      );
    } catch (_) {}
  }
  if (await tableExists(null, 'hospital_clients')) {
    await query('ALTER TABLE hospital_clients ADD COLUMN IF NOT EXISTS signos_vitales JSONB NULL');
    await query('ALTER TABLE hospital_clients ADD COLUMN IF NOT EXISTS pending_area VARCHAR(20) NULL');
    if ((await tableExists(null, 'ine_reports')) && (await columnExists(null, 'ine_reports', 'client_id'))) {
      try {
        await query(`
          UPDATE hospital_clients c
             SET pending_area = latest.tipo
            FROM (
              SELECT DISTINCT ON (client_id)
                     client_id,
                     LOWER(tipo) AS tipo
                FROM ine_reports
               WHERE LOWER(COALESCE(tipo, '')) IN ('emergencia', 'hospitalizacion')
               ORDER BY client_id, COALESCE(fecha_ingreso, fecha, DATE(created_at)) DESC, id DESC
            ) latest
           WHERE c.id = latest.client_id
             AND c.pending_area IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM hospital_admissions a0
                WHERE a0.client_id = c.id
                  AND LOWER(COALESCE(a0.status, '')) = 'open'
             )
        `);
      } catch (_) {}
    }
  }
  if (await tableExists(null, 'hospital_admissions')) {
    await query('ALTER TABLE hospital_admissions ADD COLUMN IF NOT EXISTS room_charge_id INT NULL');
    await query('ALTER TABLE hospital_admissions ADD COLUMN IF NOT EXISTS room_daily_price DECIMAL(12,2) NULL');
    await query('ALTER TABLE hospital_admissions ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(6,2) NULL');
    await query('ALTER TABLE hospital_admissions ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12,2) NULL');
    await query("ALTER TABLE hospital_admissions ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NULL");
    try {
      await query("UPDATE hospital_admissions SET tipo = 'hospitalizacion' WHERE tipo IS NULL");
    } catch (_) {}
  }
  if (await tableExists(null, 'hospital_admissions')) {
    await query(`
      CREATE TABLE IF NOT EXISTS hospital_billing_docs (
        id BIGSERIAL PRIMARY KEY,
        admission_id BIGINT NOT NULL REFERENCES hospital_admissions(id) ON DELETE CASCADE,
        tipo VARCHAR(20) DEFAULT 'hospitalizacion',
        customer_doc_type VARCHAR(20) NULL,
        customer_doc_value VARCHAR(60) NULL,
        total_charges DECIMAL(12,2) DEFAULT 0,
        discount_percent DECIMAL(6,2) DEFAULT 0,
        discount_amount DECIMAL(12,2) DEFAULT 0,
        net_total DECIMAL(12,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by BIGINT NULL,
        paid_at TIMESTAMP NULL,
        paid_by BIGINT NULL,
        sale_id BIGINT NULL
      )
    `);
    await query('ALTER TABLE hospital_billing_docs ADD COLUMN IF NOT EXISTS customer_doc_type VARCHAR(20) NULL');
    await query('ALTER TABLE hospital_billing_docs ADD COLUMN IF NOT EXISTS customer_doc_value VARCHAR(60) NULL');
  }
  await query(`
    CREATE TABLE IF NOT EXISTS hospital_history (
      id SERIAL PRIMARY KEY,
      client_id INT NOT NULL,
      admission_id INT NOT NULL,
      summary JSONB NULL,
      total_cargos DECIMAL(12,2) DEFAULT 0,
      discount_amount DECIMAL(12,2) DEFAULT 0,
      total_pagado DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  if (await tableExists(null, 'hospital_charges')) {
    await query('ALTER TABLE hospital_charges ADD COLUMN IF NOT EXISTS presentation_type VARCHAR(20) NULL');
    await query('ALTER TABLE hospital_charges ADD COLUMN IF NOT EXISTS stock_quantity NUMERIC(12,2) NULL');
    await query("ALTER TABLE hospital_charges ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) NULL");
    await query(
      'ALTER TABLE hospital_charges ADD COLUMN IF NOT EXISTS protected_after_transfer BOOLEAN DEFAULT FALSE'
    );
    try {
      await query(
        'UPDATE hospital_charges SET protected_after_transfer = FALSE WHERE protected_after_transfer IS NULL'
      );
    } catch (_) {}
    try {
      await query(
        `UPDATE hospital_charges hc
            SET product_type = COALESCE(p.tipo, CASE WHEN hc.product_id IS NOT NULL THEN 'medicamento' ELSE 'servicio' END)
           FROM productos p
          WHERE p.id = hc.product_id
            AND (hc.product_type IS NULL OR TRIM(COALESCE(hc.product_type,'')) = '')`
      );
    } catch (_) {}
    try {
      await query(
        "UPDATE hospital_charges SET product_type = 'servicio' WHERE (product_type IS NULL OR TRIM(COALESCE(product_type,'')) = '') AND product_id IS NULL"
      );
    } catch (_) {}
    if (await tableExists(null, 'hospital_admissions')) {
      try {
        await query(
          `UPDATE hospital_charges hc
              SET protected_after_transfer = TRUE
             FROM hospital_admissions a
             JOIN hospital_charges room_ch ON room_ch.id = a.room_charge_id
            WHERE a.id = hc.admission_id
              AND a.tipo = 'hospitalizacion'
              AND a.room_charge_id IS NOT NULL
              AND hc.id <> a.room_charge_id
              AND hc.created_at < room_ch.created_at
              AND COALESCE(hc.protected_after_transfer, FALSE) = FALSE`
        );
      } catch (_) {}
    }
  }
  await query(`
    CREATE TABLE IF NOT EXISTS hospital_charge_stock_moves (
      id BIGSERIAL PRIMARY KEY,
      charge_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      lot_id BIGINT NULL,
      quantity NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(
    'CREATE INDEX IF NOT EXISTS hospital_charge_stock_moves_charge_idx ON hospital_charge_stock_moves (charge_id)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS hospital_charge_stock_moves_product_idx ON hospital_charge_stock_moves (product_id)'
  );
  if (await tableExists(null, 'hospital_admissions')) {
    await query(`
      CREATE TABLE IF NOT EXISTS hospital_admission_sessions (
        admission_id BIGINT PRIMARY KEY REFERENCES hospital_admissions(id) ON DELETE CASCADE,
        user_id BIGINT NULL,
        username VARCHAR(120) NULL,
        role VARCHAR(40) NULL,
        session_key VARCHAR(140) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await query('ALTER TABLE hospital_admission_sessions ADD COLUMN IF NOT EXISTS session_key VARCHAR(140) NULL');
    await query(
      'CREATE INDEX IF NOT EXISTS hospital_admission_sessions_heartbeat_idx ON hospital_admission_sessions (heartbeat_at)'
    );
  }
  hospitalSchemaReady = true;
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

async function ensureLotCostPriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'cost_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN cost_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'cost_price');
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
function mapConsultorio(medico) {
  const m = String(medico || '').toLowerCase();
  if (m.includes('axel')) return 'direccionmedica';
  if (m.includes('yorentine')) return 'consultorio2';
  if (m.includes('arias')) return 'consultorio3';
  return '';
}

function normalizeDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = String(dt.getFullYear());
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

function billingDocMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function billingDocQty(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return Math.abs(n - Math.round(n)) < 0.0001 ? String(Math.round(n)) : n.toFixed(2);
}

function billingDocSectionLine(doc, leftX, contentWidth) {
  doc.text('--------------------------------', leftX, doc.y, { width: contentWidth, align: 'center' });
}

function billingDocAreaLabel(tipo) {
  return String(tipo || '').toLowerCase() === 'emergencia'
    ? 'Servicios de Emergencia'
    : 'Servicios de Hospitalización';
}

function normalizeBillingCustomerDocType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'nit') return 'nit';
  if (raw === 'cui') return 'cui';
  if (raw === 'consumidor_final' || raw === 'consumidor final' || raw === 'cf') return 'consumidor_final';
  return '';
}

function normalizeBillingCustomerDocValue(value) {
  return String(value || '').trim().toUpperCase();
}

function resolveBillingCustomerIdentity(options = {}) {
  const requestedType = normalizeBillingCustomerDocType(options.type);
  const requestedValue = normalizeBillingCustomerDocValue(options.value);
  const fallbackType = normalizeBillingCustomerDocType(options.fallbackType);
  const fallbackValue = normalizeBillingCustomerDocValue(options.fallbackValue);
  const clientDocument = normalizeBillingCustomerDocValue(options.clientDocument);

  let type = requestedType || fallbackType;
  let value = requestedValue || fallbackValue;

  if (!type && !value && clientDocument) {
    type = 'cui';
    value = clientDocument;
  }
  if (type === 'cui' && !value && clientDocument) {
    value = clientDocument;
  }

  return { type, value };
}

function billingCustomerIdentityLabel(type, value) {
  const normalizedType = normalizeBillingCustomerDocType(type);
  const document = normalizeBillingCustomerDocValue(value);
  if (normalizedType === 'nit') {
    return document ? `NIT: ${document}` : 'NIT';
  }
  if (normalizedType === 'cui') {
    return document ? `CUI: ${document}` : 'CUI';
  }
  return document || 'Consumidor final';
}

function billingDocEscapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBillingDocPageHtml(options = {}) {
  const {
    title = 'Documento de Cobro',
    subtitle = 'Documento de cobro emitido',
    docId = '',
    clientName = '--',
    clientDocumentType = '',
    clientDocument = '',
    createdAt = '',
    createdBy = '--',
    tipoLabel = '',
    admissionId = '',
    detailRows = [],
    totals = [],
    footerMessage = ''
  } = options;

  const escapedTitle = billingDocEscapeHtml(title);
  const escapedSubtitle = billingDocEscapeHtml(subtitle);
  const escapedDocId = billingDocEscapeHtml(docId);
  const escapedClientName = billingDocEscapeHtml(clientName || '--');
  const escapedDate = billingDocEscapeHtml(createdAt || '');
  const escapedCashier = billingDocEscapeHtml(createdBy || '--');
  const escapedTipo = billingDocEscapeHtml(tipoLabel || '--');
  const escapedAdmission = billingDocEscapeHtml(admissionId || '--');
  const billingSummary = billingDocEscapeHtml(
    billingCustomerIdentityLabel(clientDocumentType, clientDocument)
  );
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const summaryRows = Array.isArray(totals) ? totals : [];

  const itemLines = rows
    .map((row) => {
      const name = billingDocEscapeHtml(row.label || 'Servicio');
      const meta = billingDocEscapeHtml(row.meta || '');
      return `<div class="item-row">
        <div>
          <div class="item-title">${name}</div>
          ${meta ? `<div class="item-sub">${meta}</div>` : ''}
        </div>
        <div class="item-amt">Q${billingDocMoney(row.amount)}</div>
      </div>`;
    })
    .join('');

  const totalLines = summaryRows
    .map((row) => {
      const label = billingDocEscapeHtml(row.label || '');
      const cls = row.grand ? 'line grand' : 'line';
      return `<div class="${cls}"><span class="name">${label}</span><span class="amt">Q${billingDocMoney(
        row.amount
      )}</span></div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle} #${escapedDocId}</title>
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
    @page{
      size:5.5in 8.5in;
      margin:0.16in;
    }
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    body{
      margin:0;
      padding:24px;
      min-height:100vh;
      background:radial-gradient(circle at top,#f3fbff 0%,#e7f0f9 36%,#d9e4ef 100%);
      font-family:"Bahnschrift","Segoe UI Variable","Segoe UI",sans-serif;
      color:var(--ink);
    }
    .stage{display:flex;justify-content:center;}
    .receipt{
      width:min(5.06in, calc(100vw - 24px));
      min-height:calc(8.5in - 0.32in);
      background:var(--paper);
      border:1px solid rgba(18,32,51,.08);
      border-radius:28px;
      box-shadow:0 18px 48px rgba(18,32,51,.16);
      overflow:hidden;
      display:flex;
      flex-direction:column;
      break-inside:avoid-page;
      page-break-inside:avoid;
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
      gap:16px;
    }
    .brand{display:flex;gap:12px;align-items:flex-start;}
    .brand-mark{
      width:38px;height:38px;border-radius:12px;
      background:rgba(255,255,255,.18);
      display:grid;place-items:center;
      font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
    }
    .eyebrow{
      font-size:9px;
      text-transform:uppercase;
      letter-spacing:.24em;
      opacity:.75;
      margin-bottom:4px;
    }
    .brand-copy h1{margin:0;font-size:29px;line-height:1.05;letter-spacing:.02em;}
    .hero-pill{
      padding:8px 12px;
      border-radius:999px;
      background:rgba(255,255,255,.18);
      border:1px solid rgba(255,255,255,.22);
      font-size:11px;font-weight:700;white-space:nowrap;
    }
    .hero-sub{
      margin-top:14px;
      display:flex;justify-content:space-between;gap:12px;
      font-size:11px;opacity:.88;
    }
    .contact{
      padding:12px 24px;
      font-size:10px;
      color:var(--muted);
      border-bottom:1px solid var(--line);
      background:linear-gradient(180deg, rgba(236,246,253,.85) 0%, rgba(255,255,255,.98) 100%);
    }
    .billing-strip{
      margin:16px 24px 0;
      border:1px solid rgba(31,143,214,.18);
      background:var(--soft-accent);
      border-radius:16px;
      padding:10px 14px;
      display:flex;justify-content:space-between;gap:12px;align-items:center;
      font-size:12px;
    }
    .billing-label{
      color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
    }
    .billing-value{font-weight:700;color:var(--ink);}
    .meta{
      padding:16px 24px 0;
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:12px;
    }
    .meta-card{
      border:1px solid rgba(19,38,63,.14);
      border-radius:16px;
      padding:12px 14px;
      background:#fff;
      box-shadow:0 8px 22px rgba(19,38,63,.05);
    }
    .meta-card.full{grid-column:1 / -1;}
    .meta-label{
      color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;margin-bottom:6px;
    }
    .meta-value{font-size:16px;font-weight:700;line-height:1.2;}
    .section{padding:16px 24px 0;}
    .section-title{
      display:flex;justify-content:space-between;align-items:center;
      color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
      margin-bottom:8px;
    }
    .items{
      border:1px solid rgba(19,38,63,.08);
      border-radius:22px;
      overflow:hidden;
      background:linear-gradient(180deg,#fff 0%,#fbfdff 100%);
    }
    .items-head{
      display:grid;grid-template-columns:minmax(0,1fr) auto;
      padding:10px 14px 8px;
      font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
      color:var(--muted);
      background:linear-gradient(180deg,rgba(236,246,253,.9) 0%,rgba(255,255,255,.95) 100%);
      border-bottom:1px solid var(--line);
    }
    .item-row{
      display:grid;grid-template-columns:minmax(0,1fr) auto;
      gap:12px;align-items:start;
      padding:12px 14px;
      border-bottom:1px dashed var(--line);
    }
    .item-row:last-child{border-bottom:none;}
    .item-title{font-size:15px;font-weight:700;line-height:1.25;}
    .item-sub{margin-top:3px;font-size:11px;color:var(--muted);}
    .item-amt{font-size:15px;font-weight:700;white-space:nowrap;}
    .summary{
      margin:16px 24px 0;
      padding:12px 14px;
      border-radius:18px;
      border:1px solid rgba(31,143,214,.24);
      background:linear-gradient(180deg,#fbfdff 0%,var(--soft-accent) 100%);
    }
    .line{
      display:flex;justify-content:space-between;gap:12px;
      font-size:13px;padding:5px 0;
    }
    .line .name{color:var(--muted);}
    .line .amt{font-weight:700;}
    .line.grand{
      border-top:1px dashed rgba(31,143,214,.35);
      margin-top:6px;padding-top:10px;
      font-size:18px;font-weight:800;color:var(--ink);
    }
    .footer{
      margin-top:auto;
      padding:18px 24px 24px;
      text-align:center;
      color:var(--ink);
    }
    .footer strong{display:block;font-size:14px;margin-bottom:4px;}
    .footer span{display:block;font-size:11px;color:var(--muted);}
    @media (max-width: 640px){
      body{padding:10px;}
      .receipt{width:100%;border-radius:22px;}
      .hero{padding:18px 18px 16px;}
      .hero-top,.hero-sub,.billing-strip,.section-title{flex-direction:column;align-items:flex-start;}
      .meta{grid-template-columns:1fr;padding:14px 18px 0;}
      .section{padding:14px 18px 0;}
      .contact,.summary,.footer{margin-left:18px;margin-right:18px;padding-left:0;padding-right:0;}
      .billing-strip{margin-left:18px;margin-right:18px;}
      .summary{padding:12px;}
      .footer{padding-bottom:20px;}
    }
    @media print{
      html,body{
        width:5.5in;
        height:8.5in;
        overflow:hidden;
      }
      body{
        padding:0;
        min-height:auto;
        background:#fff;
      }
      .stage{
        display:block;
      }
      .receipt{
        width:calc(5.5in - 0.32in);
        height:calc(8.5in - 0.32in);
        min-height:calc(8.5in - 0.32in);
        max-height:calc(8.5in - 0.32in);
        border:none;
        border-radius:0;
        box-shadow:none;
        overflow:hidden;
      }
      .hero{
        padding:18px 18px 14px;
      }
      .brand-copy h1{
        font-size:24px;
      }
      .hero-sub{
        margin-top:10px;
        font-size:10px;
      }
      .contact{
        padding:9px 18px;
      }
      .billing-strip{
        margin:12px 18px 0;
        padding:8px 12px;
      }
      .meta{
        padding:12px 18px 0;
        gap:8px;
      }
      .meta-card{
        padding:10px 12px;
      }
      .meta-value{
        font-size:14px;
      }
      .section{
        padding:12px 18px 0;
      }
      .section-title{
        margin-bottom:6px;
      }
      .items-head{
        padding:8px 12px 7px;
      }
      .item-row{
        padding:9px 12px;
      }
      .item-title,
      .item-amt{
        font-size:14px;
      }
      .item-sub{
        font-size:10px;
      }
      .summary{
        margin:12px 18px 0;
        padding:10px 12px;
      }
      .line{
        font-size:12px;
        padding:4px 0;
      }
      .line.grand{
        margin-top:4px;
        padding-top:8px;
        font-size:16px;
      }
      .footer{
        padding:14px 18px 16px;
      }
      .footer strong{
        font-size:13px;
        margin-bottom:3px;
      }
      .footer span{
        font-size:10px;
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
              <h1>${escapedTitle}</h1>
            </div>
          </div>
          <div class="hero-pill">Comprobante #${escapedDocId}</div>
        </div>
        <div class="hero-sub">
          <span>${escapedSubtitle}</span>
          <span>${escapedDate}</span>
        </div>
      </header>

      <div class="contact">
        <div>Finca San Cayetano, San Felipe, Retalhuleu, Guatemala</div>
        <div>Tel: (502) 7772-5059 · informacion@hospitalhilariogalindo.org</div>
      </div>

      <div class="billing-strip">
        <span class="billing-label">Facturación</span>
        <span class="billing-value">${billingSummary}</span>
      </div>

      <section class="meta">
        <div class="meta-card">
          <div class="meta-label">Fecha</div>
          <div class="meta-value">${escapedDate}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Cajero</div>
          <div class="meta-value">${escapedCashier}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Área</div>
          <div class="meta-value">${escapedTipo}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Admisión</div>
          <div class="meta-value">#${escapedAdmission}</div>
        </div>
        <div class="meta-card full">
          <div class="meta-label">A nombre de</div>
          <div class="meta-value">${escapedClientName}</div>
        </div>
      </section>

      <section class="section">
        <div class="section-title">
          <span>Detalle</span>
          <span>${rows.length} linea${rows.length === 1 ? '' : 's'}</span>
        </div>
        <div class="items">
          <div class="items-head">
            <span>Producto</span>
            <span>Subtotal</span>
          </div>
          ${itemLines}
        </div>
      </section>

      <section class="summary">
        ${totalLines}
      </section>

      <footer class="footer">
        ${footerMessage ? `<span>${billingDocEscapeHtml(footerMessage)}</span>` : ''}
        <strong>Gracias por su preferencia.</strong>
        <span>Hospital Hilario Galindo.</span>
      </footer>
    </article>
  </main>
</body>
</html>`;
}

function renderBillingDocHeader(doc, layout, options = {}) {
  const { leftX, contentWidth } = layout;
  const {
    title = 'Documento de Cobro',
    docId = '',
    clientName = '--',
    clientDocumentType = '',
    clientDocument = '',
    createdAt = null,
    createdBy = '--',
    tipo = '',
    admissionId = null
  } = options;

  doc.fontSize(12).text('HOSPITAL HILARIO GALINDO', { align: 'center' });
  doc.fontSize(8).text('Finca San Cayetano, San Felipe, Retalhuleu, Guatemala', { align: 'center' });
  doc.text('Tel: (502) 7772-5059', { align: 'center' });
  doc.text('informacion@hospitalhilariogalindo.org', { align: 'center' });
  doc.moveDown(0.5);
  billingDocSectionLine(doc, leftX, contentWidth);
  doc.fontSize(10).text(title, { align: 'center' });
  doc.fontSize(8).text(`Comprobante #${docId}`);
  if (clientName) doc.text(`A nombre de: ${clientName}`);
  doc.text(`Fecha: ${formatDateES(createdAt) || ''}`);
  doc.text(`Cajero: ${createdBy || '--'}`);
  doc.text(`Facturación: ${billingCustomerIdentityLabel(clientDocumentType, clientDocument)}`);
  if (tipo) doc.text(`Área: ${tipo}`);
  if (admissionId) doc.text(`Admisión: #${admissionId}`);
  doc.moveDown(0.5);
}

function drawBillingDocDetailLine(doc, layout, label, amount) {
  const { leftX, leftColWidth, rightX, rightColWidth } = layout;
  const y = doc.y;
  doc.fontSize(8);
  const height = doc.heightOfString(label, { width: leftColWidth });
  doc.text(label, leftX, y, { width: leftColWidth });
  doc.text(`Q${billingDocMoney(amount)}`, rightX, y, { width: rightColWidth, align: 'right' });
  doc.y = y + height;
  doc.moveDown(0.2);
}

function renderBillingDocFooter(doc, layout, message = 'Presentar este documento en Caja.') {
  const { leftX, contentWidth } = layout;
  doc.moveDown(0.5);
  doc.fontSize(8).text(message, leftX, doc.y, { width: contentWidth, align: 'center' });
  doc.text('Gracias por su preferencia.', leftX, doc.y, { width: contentWidth, align: 'center' });
}

function weekdayES(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-GT', { weekday: 'long' }).format(date);
  } catch (_) {
    return date.toLocaleDateString('es-ES', { weekday: 'long' });
  }
}

function isMinor(dateStr) {
  const raw = normalizeDate(dateStr);
  if (!raw) return false;
  const [yy, mm, dd] = raw.split('-').map((v) => Number(v));
  if (!yy || !mm || !dd) return false;
  const dob = new Date(yy, mm - 1, dd);
  if (Number.isNaN(dob.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age < 18;
}

function docKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

function docExpr(column) {
  const raw = String(column || '').trim();
  let alias = '';
  let name = raw;
  if (raw.includes('.')) {
    const parts = raw.split('.');
    alias = parts[0];
    name = parts[1];
  }
  const qualified = alias ? `${alias}.${quoteIdent(name)}` : quoteIdent(name);
  return `UPPER(REGEXP_REPLACE(COALESCE(${qualified},''), '[^0-9A-Za-z]', '', 'g'))`;
}

async function findColumn(db, table, candidates) {
  for (const candidate of candidates) {
    if (await columnExists(db, table, candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseJsonMaybe(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeReceta(raw) {
  if (Array.isArray(raw)) return raw;
  const parsed = parseJsonMaybe(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  const items = [];
  const parts = String(raw || '').split(/[\r\n;]+/);
  for (const part of parts) {
    const clean = part.trim();
    if (!clean) continue;
    items.push({ medicamento: clean });
  }
  return items;
}

function normalizeRecetaItems(raw) {
  const base = normalizeReceta(raw);
  if (!Array.isArray(base)) return [];
  return base.map((item) => {
    if (typeof item === 'string') {
      return { medicamento: item };
    }
    if (item && typeof item === 'object') {
      return {
        medicamento: item.medicamento || item.med || item.nombre || item.name || '',
        dosis: item.dosis || item.dose || '',
        frecuencia: item.frecuencia || item.freq || item.frecuencia_horas || '',
        duracion: item.duracion || item.dur || item.dias || ''
      };
    }
    return { medicamento: String(item || '') };
  });
}

function normalizeDiagnostico(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    const parsed = parseJsonMaybe(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed.diagnostico || parsed.diag || parsed.diagnosis || raw;
    }
    return raw;
  }
  if (typeof raw === 'object') {
    return raw.diagnostico || raw.diag || raw.diagnosis || JSON.stringify(raw);
  }
  return String(raw);
}
function roomConfig() {
  return {
    cubiculo1: { label: 'Cubiculo 1', rooms: 1, beds: 12, price: 400.0 },
    cubiculo2: { label: 'Cubiculo 2', rooms: 1, beds: 8, price: 400.0 },
    cubiculo3: { label: 'Cubiculo 3', rooms: 1, beds: 8, price: 400.0 },
    semi_privado1: { label: 'Semi-Privado 1', rooms: 1, beds: 2, price: 600.0 },
    semi_privado2: { label: 'Semi-Privado 2', rooms: 1, beds: 2, price: 600.0 },
    privado1: { label: 'Privado 1', rooms: 1, beds: 1, price: 800.0 },
    privado2: { label: 'Privado 2', rooms: 1, beds: 1, price: 800.0 },
    privado3: { label: 'Privado 3', rooms: 1, beds: 1, price: 800.0 }
  };
}

async function roomStatus(db) {
  const config = roomConfig();
  const status = {};
  for (const [type, cfg] of Object.entries(config)) {
    const rooms = {};
    for (let i = 1; i <= cfg.rooms; i += 1) {
      rooms[i] = { room: i, available: cfg.beds };
    }
    const rows = await query(
      'SELECT room_number, bed_number FROM hospital_admissions WHERE status = $1 AND room_type = $2',
      ['open', type],
      db
    );
    for (const row of rows.rows) {
      const room = Number(row.room_number || 0);
      if (room && rooms[room]) {
        rooms[room].available = Math.max(0, rooms[room].available - 1);
      }
    }
    let total = 0;
    const roomsDetail = [];
    for (const info of Object.values(rooms)) {
      roomsDetail.push(info);
      total += info.available;
    }
    status[type] = {
      label: cfg.label,
      rooms: cfg.rooms,
      beds_per_room: cfg.beds,
      price: cfg.price,
      available: total,
      rooms_detail: roomsDetail
    };
  }
  return status;
}

async function findAvailableBed(db, type, forUpdate) {
  const config = roomConfig();
  const cfg = config[type];
  if (!cfg) return null;
  let sql = 'SELECT room_number, bed_number FROM hospital_admissions WHERE status = $1 AND room_type = $2';
  if (forUpdate) sql += ' FOR UPDATE';
  const rows = await query(sql, ['open', type], db);
  const occupied = new Map();
  for (const row of rows.rows) {
    const room = Number(row.room_number || 0);
    const bed = Number(row.bed_number || 0);
    if (!room || !bed) continue;
    if (!occupied.has(room)) occupied.set(room, new Set());
    occupied.get(room).add(bed);
  }
  for (let r = 1; r <= cfg.rooms; r += 1) {
    for (let b = 1; b <= cfg.beds; b += 1) {
      const set = occupied.get(r);
      if (!set || !set.has(b)) return { room: r, bed: b };
    }
  }
  return null;
}

async function fetchAdmission(db, admissionId) {
  const st = await query('SELECT * FROM hospital_admissions WHERE id = $1', [admissionId], db);
  const row = st.rows[0];
  if (!row) {
    const err = new Error('Admision no encontrada');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

function normalizeAdmissionSessionRow(row) {
  if (!row) return null;
  return {
    admission_id: Number(row.admission_id || 0),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    username: String(row.username || '').trim(),
    role: canonRole(row.role || ''),
    session_key: String(row.session_key || '').trim() || null,
    created_at: row.created_at || null,
    heartbeat_at: row.heartbeat_at || null
  };
}

function admissionSessionConflictPayload(row) {
  const session = normalizeAdmissionSessionRow(row);
  const ownerName = session?.username || '';
  return {
    ok: false,
    error: ownerName
      ? `Otro enfermero está cargando gastos a esta cuenta: ${ownerName}.`
      : 'Otro enfermero está cargando gastos a esta cuenta.',
    locked_by: ownerName || null,
    session
  };
}

async function purgeExpiredAdmissionSessions(db) {
  if (!(await tableExists(db, 'hospital_admission_sessions'))) return;
  await query(
    `DELETE FROM hospital_admission_sessions
      WHERE heartbeat_at < (NOW() - INTERVAL '${ADMISSION_SESSION_TTL_SECONDS} seconds')`,
    [],
    db
  );
}

async function claimAdmissionSession(admissionId, user) {
  const resolvedAdmissionId = Number(admissionId || 0);
  if (!resolvedAdmissionId) return { ok: false, session: null };
  const userId = user?.id != null ? Number(user.id) : null;
  const username = String(user?.username || user?.user || '').trim() || null;
  const role = canonRole(user?.rol || user?.role || '');
  const sessionKey = String(user?.session_id || user?.sessionId || '').trim() || null;
  return await withTransaction(async (db) => {
    await purgeExpiredAdmissionSessions(db);
    const currentRes = await query(
      `SELECT admission_id, user_id, username, role, session_key, created_at, heartbeat_at
         FROM hospital_admission_sessions
        WHERE admission_id = $1
        FOR UPDATE`,
      [resolvedAdmissionId],
      db
    );
    const current = currentRes.rows[0];
    if (!current) {
      const ins = await query(
        `INSERT INTO hospital_admission_sessions
          (admission_id, user_id, username, role, session_key, created_at, heartbeat_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
         RETURNING admission_id, user_id, username, role, session_key, created_at, heartbeat_at`,
        [resolvedAdmissionId, userId, username, role || null, sessionKey],
        db
      );
      return { ok: true, session: normalizeAdmissionSessionRow(ins.rows[0]) };
    }
    const currentUserId = current.user_id != null ? Number(current.user_id) : null;
    const currentSessionKey = String(current.session_key || '').trim() || null;
    const currentUsername = String(current.username || '').trim() || null;
    const sameSession = currentSessionKey && sessionKey && currentSessionKey === sessionKey;
    const sameLegacyUser = !currentSessionKey && currentUserId && userId && currentUserId === userId;
    const sameUser = currentUserId && userId && currentUserId === userId;
    const sameUsername =
      !sameUser &&
      currentUsername &&
      username &&
      currentUsername.toLowerCase() === username.toLowerCase();
    if (sameSession || sameLegacyUser || sameUser || sameUsername || (!currentSessionKey && !currentUserId && !sessionKey && !userId)) {
      const upd = await query(
        `UPDATE hospital_admission_sessions
            SET user_id = $1,
                username = $2,
                role = $3,
                session_key = $4,
                heartbeat_at = NOW()
          WHERE admission_id = $5
          RETURNING admission_id, user_id, username, role, session_key, created_at, heartbeat_at`,
        [userId, username, role || null, sessionKey, resolvedAdmissionId],
        db
      );
      return { ok: true, session: normalizeAdmissionSessionRow(upd.rows[0]) };
    }
    return { ok: false, session: normalizeAdmissionSessionRow(current) };
  });
}

async function releaseAdmissionSession(admissionId, user) {
  const resolvedAdmissionId = Number(admissionId || 0);
  if (!resolvedAdmissionId) return false;
  if (!(await tableExists(null, 'hospital_admission_sessions'))) return false;
  const userId = user?.id != null ? Number(user.id) : null;
  const sessionKey = String(user?.session_id || user?.sessionId || '').trim() || null;
  const username = String(user?.username || user?.user || '').trim() || null;
  if (sessionKey) {
    await query('DELETE FROM hospital_admission_sessions WHERE admission_id = $1 AND session_key = $2', [
      resolvedAdmissionId,
      sessionKey
    ]);
  }
  if (userId) {
    await query('DELETE FROM hospital_admission_sessions WHERE admission_id = $1 AND user_id = $2', [
      resolvedAdmissionId,
      userId
    ]);
  }
  if (username) {
    await query(
      'DELETE FROM hospital_admission_sessions WHERE admission_id = $1 AND LOWER(COALESCE(username, \'\')) = LOWER($2)',
      [resolvedAdmissionId, username]
    );
  }
  if (!sessionKey && !userId && !username) {
    await query('DELETE FROM hospital_admission_sessions WHERE admission_id = $1', [resolvedAdmissionId]);
  }
  return true;
}

async function admissionTotals(db, admissionId) {
  const sumCharges = await query(
    `SELECT
      COALESCE(SUM(quantity * unit_price),0) AS total,
      COALESCE(SUM(CASE
        WHEN product_id IS NOT NULL
         AND product_id > 0
         AND LOWER(COALESCE(product_type, 'medicamento')) <> 'servicio'
        THEN quantity * unit_price
        ELSE 0
      END),0) AS meds_total
     FROM hospital_charges WHERE admission_id = $1`,
    [admissionId],
    db
  );
  const sumPayments = await query(
    'SELECT COALESCE(SUM(amount),0) AS total FROM hospital_payments WHERE admission_id = $1',
    [admissionId],
    db
  );
  return {
    totalCharges: Number(sumCharges.rows[0]?.total || 0),
    medsCharges: Number(sumCharges.rows[0]?.meds_total || 0),
    totalPayments: Number(sumPayments.rows[0]?.total || 0)
  };
}

function computeDiscountAmount(baseTotal, percent) {
  const base = Number(baseTotal || 0);
  const pct = Number(percent || 0);
  if (base <= 0 || pct <= 0) return 0;
  let amount = Number((base * (pct / 100)).toFixed(2));
  if (amount > base) amount = base;
  return amount;
}

function clampDiscountAmount(amount, baseTotal) {
  const base = Number(baseTotal || 0);
  const raw = Number(amount || 0);
  if (base <= 0 || raw <= 0) return 0;
  return raw > base ? base : raw;
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

function resolveDiscountTotals(totalCharges, discountBase, discountPercent, storedDiscountAmount = 0) {
  const total = Number(totalCharges || 0);
  const base = Number(discountBase || 0);
  const pct = Number(discountPercent || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { discountAmount: 0, netCharges: 0 };
  }
  if (pct > 0) {
    const rawDiscount = computeDiscountAmount(base, pct);
    const rawNet = Math.max(0, total - rawDiscount);
    const netCharges = roundDiscountedPayable(rawNet, total);
    const discountAmount = Number(Math.max(0, total - netCharges).toFixed(2));
    return { discountAmount, netCharges };
  }
  const discountAmount = Number(clampDiscountAmount(storedDiscountAmount, base).toFixed(2));
  const netCharges = Number(Math.max(0, total - discountAmount).toFixed(2));
  return { discountAmount, netCharges };
}

async function syncOpenBillingDocsForAdmission(db, admission) {
  if (!admission?.id || !(await tableExists(db, 'hospital_billing_docs'))) return;
  const totals = await admissionTotals(db, admission.id);
  const discountPercent = admission.discount_percent != null ? Number(admission.discount_percent) : 0;
  const resolvedDiscount = resolveDiscountTotals(
    totals.totalCharges,
    totals.medsCharges,
    discountPercent,
    admission.discount_amount != null ? Number(admission.discount_amount) : 0
  );
  await query(
    `UPDATE hospital_billing_docs
        SET total_charges = $1,
            discount_percent = $2,
            discount_amount = $3,
            net_total = $4
      WHERE admission_id = $5 AND status = 'open'`,
    [
      totals.totalCharges,
      discountPercent,
      resolvedDiscount.discountAmount,
      resolvedDiscount.netCharges,
      admission.id
    ],
    db
  );
}

async function restoreHospitalChargeStock(db, productId, branchId, quantity, userId) {
  const qty = Number(quantity || 0);
  if (!productId || !branchId || !Number.isFinite(qty) || qty <= 0) return;

  if (await tableExists(db, 'lots')) {
    const lotRes = await query(
      `SELECT id
         FROM lots
        WHERE product_id = $1 AND branch_id = $2
        ORDER BY
          CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
          CASE WHEN expiry_date < CURRENT_DATE THEN 1 ELSE 0 END,
          expiry_date ASC NULLS LAST,
          created_at ASC,
          id ASC
        LIMIT 1
        FOR UPDATE`,
      [productId, branchId],
      db
    );
    const lotId = Number(lotRes.rows[0]?.id || 0);
    if (lotId) {
      await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [qty, lotId], db);
      logAuditEvent({
        action: 'lot_adjusted',
        branch_id: branchId || null,
        user_id: userId || null,
        product_id: productId || null,
        delta: qty
      });
    }
  }

  if (await productStocksAvailable(db)) {
    await adjustBranchStock(db, productId, branchId, qty);
  } else {
    await query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [qty, productId], db);
  }
  await updateProductCostFromLots(db, productId, branchId);
  await updateProductSalePriceFromLots(db, productId, branchId);
}

async function ensureHospitalChargeStockMovesTable(db) {
  await query(
    `CREATE TABLE IF NOT EXISTS hospital_charge_stock_moves (
      id BIGSERIAL PRIMARY KEY,
      charge_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      lot_id BIGINT NULL,
      quantity NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    [],
    db
  );
  await query(
    'CREATE INDEX IF NOT EXISTS hospital_charge_stock_moves_charge_idx ON hospital_charge_stock_moves (charge_id)',
    [],
    db
  );
  await query(
    'CREATE INDEX IF NOT EXISTS hospital_charge_stock_moves_product_idx ON hospital_charge_stock_moves (product_id)',
    [],
    db
  );
}

async function registerHospitalChargeStockMove(db, chargeId, productId, quantity, lotId = null) {
  const resolvedChargeId = Number(chargeId || 0);
  const resolvedProductId = Number(productId || 0);
  const resolvedQty = Number(quantity || 0);
  if (!resolvedChargeId || !resolvedProductId || !Number.isFinite(resolvedQty) || resolvedQty <= 0) return;
  await ensureHospitalChargeStockMovesTable(db);
  await query(
    'INSERT INTO hospital_charge_stock_moves (charge_id, product_id, lot_id, quantity) VALUES ($1,$2,$3,$4)',
    [resolvedChargeId, resolvedProductId, lotId ? Number(lotId) : null, resolvedQty],
    db
  );
}

async function consumeHospitalChargeInventory(db, options = {}) {
  const chargeId = Number(options.chargeId || 0);
  const productId = Number(options.productId || 0);
  const branchId = Number(options.branchId || 0);
  const qty = Number(options.quantity || 0);
  const userId = options.userId || null;
  const productLabel = String(options.productLabel || `Producto ${productId}`).trim();
  if (!chargeId || !productId || !branchId || !Number.isFinite(qty) || qty <= 0) return;

  const hasLots = await tableExists(db, 'lots');
  if (hasLots) {
    const missing = await query(
      'SELECT COUNT(*) AS c FROM lots WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date IS NULL',
      [productId, branchId],
      db
    );
    if (Number(missing.rows[0]?.c || 0) > 0) {
      throw new Error(options.missingExpiryMessage || `Hay lotes sin fecha de vencimiento para ${productLabel}`);
    }
    const lotsRes = await query(
      `SELECT id, quantity, created_at
         FROM lots
        WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date >= CURRENT_DATE
        ORDER BY expiry_date ASC, created_at ASC, id ASC
        FOR UPDATE`,
      [productId, branchId],
      db
    );
    const lots = lotsRes.rows || [];
    if (!lots.length) {
      throw new Error(options.noStockMessage || `No hay stock para ${productLabel}`);
    }
    let remaining = qty;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const available = Number(lot.quantity || 0);
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, lot.id], db);
      logAuditEvent({
        action: 'lot_adjusted',
        branch_id: branchId || null,
        user_id: userId || null,
        product_id: productId || null,
        delta: -1 * take
      });
      await registerHospitalChargeStockMove(db, chargeId, productId, take, lot.id);
      remaining -= take;
    }
    if (remaining > 0) {
      throw new Error(options.insufficientMessage || `No hay stock suficiente para ${productLabel}`);
    }
  } else if (await productStocksAvailable(db)) {
    const available = await getBranchStock(db, productId, branchId);
    if (available < qty) {
      throw new Error(options.insufficientMessage || `No hay stock suficiente para ${productLabel}`);
    }
    await registerHospitalChargeStockMove(db, chargeId, productId, qty, null);
  } else {
    const stockRes = await query('SELECT stock FROM productos WHERE id = $1', [productId], db);
    const available = Number(stockRes.rows[0]?.stock || 0);
    if (available < qty) {
      throw new Error(options.insufficientMessage || `No hay stock suficiente para ${productLabel}`);
    }
    await registerHospitalChargeStockMove(db, chargeId, productId, qty, null);
  }

  if (await productStocksAvailable(db)) {
    await adjustBranchStock(db, productId, branchId, -1 * qty);
  } else {
    await query(
      'UPDATE productos SET stock = GREATEST(0, stock - $1) WHERE id = $2',
      [qty, productId],
      db
    );
  }
  await updateProductCostFromLots(db, productId, branchId);
  await updateProductSalePriceFromLots(db, productId, branchId);
}

async function consumeHospitalChargeComboInventory(db, options = {}) {
  const chargeId = Number(options.chargeId || 0);
  const comboProductId = Number(options.comboProductId || 0);
  const branchId = Number(options.branchId || 0);
  const comboQty = Number(options.quantity || 0);
  const userId = options.userId || null;
  const comboLabel = String(options.comboLabel || `Combo ${comboProductId}`).trim();
  if (!chargeId || !comboProductId || !branchId || !Number.isFinite(comboQty) || comboQty <= 0) return;

  const componentsMap = await fetchComboComponents(db, [comboProductId]);
  const components = componentsMap.get(comboProductId) || [];
  if (!components.length) {
    throw new Error(`El combo ${comboLabel} no tiene componentes configurados`);
  }
  let hasTrackedComponent = false;
  for (const component of components) {
    const componentProductId = Number(component.component_product_id || 0);
    if (!componentProductId) continue;
    const componentLabel = String(component.nombre_comercial || `Producto ${componentProductId}`).trim();
    const componentType = normalizeProductType(component.tipo);
    if (productTypeIsCombo(componentType)) {
      throw new Error(`El combo ${comboLabel} no puede incluir el combo ${componentLabel}`);
    }
    if (!productTypeUsesInventory(componentType)) continue;
    hasTrackedComponent = true;
    await consumeHospitalChargeInventory(db, {
      chargeId,
      productId: componentProductId,
      branchId,
      quantity: Number(component.quantity || 0) * comboQty,
      userId,
      productLabel: componentLabel,
      noStockMessage: `El producto ${componentLabel} que pertenece al combo ${comboLabel} no tiene stock`,
      insufficientMessage: `El producto ${componentLabel} que pertenece al combo ${comboLabel} no tiene stock suficiente`,
      missingExpiryMessage: `El componente ${componentLabel} del combo ${comboLabel} tiene lotes sin fecha de vencimiento`
    });
  }
  if (!hasTrackedComponent) {
    throw new Error(`El combo ${comboLabel} no tiene medicamentos configurados para descontar stock`);
  }
}

async function restoreHospitalChargeStockMoves(db, chargeId, branchId, userId) {
  const resolvedChargeId = Number(chargeId || 0);
  const resolvedBranchId = Number(branchId || 0);
  if (!resolvedChargeId || !resolvedBranchId) return new Map();
  await ensureHospitalChargeStockMovesTable(db);
  const moveRes = await query(
    'SELECT id, product_id, lot_id, quantity FROM hospital_charge_stock_moves WHERE charge_id = $1 ORDER BY id ASC FOR UPDATE',
    [resolvedChargeId],
    db
  );
  const rows = moveRes.rows || [];
  if (!rows.length) return new Map();

  const restoredByProduct = new Map();
  const hasLots = await tableExists(db, 'lots');
  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    const qty = Number(row.quantity || 0);
    const lotId = Number(row.lot_id || 0);
    if (!productId || !Number.isFinite(qty) || qty <= 0) continue;
    if (lotId && hasLots) {
      await query('UPDATE lots SET quantity = quantity + $1 WHERE id = $2', [qty, lotId], db);
      logAuditEvent({
        action: 'lot_adjusted',
        branch_id: resolvedBranchId || null,
        user_id: userId || null,
        product_id: productId || null,
        delta: qty
      });
    }
    restoredByProduct.set(productId, Number((Number(restoredByProduct.get(productId) || 0) + qty).toFixed(2)));
  }
  await query('DELETE FROM hospital_charge_stock_moves WHERE charge_id = $1', [resolvedChargeId], db);

  if (await productStocksAvailable(db)) {
    for (const [productId, qty] of restoredByProduct.entries()) {
      await adjustBranchStock(db, productId, resolvedBranchId, qty);
      await updateProductCostFromLots(db, productId, resolvedBranchId);
      await updateProductSalePriceFromLots(db, productId, resolvedBranchId);
    }
  } else {
    for (const [productId, qty] of restoredByProduct.entries()) {
      await query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [qty, productId], db);
      await updateProductCostFromLots(db, productId, resolvedBranchId);
      await updateProductSalePriceFromLots(db, productId, resolvedBranchId);
    }
  }
  return restoredByProduct;
}

async function findOpenCajaId(db, userId, branchId) {
  if (!userId) return null;
  if (!(await tableExists(db, 'cajas'))) return null;
  const colsCaja = await getColumns(db, 'cajas');
  const userCol = colsCaja.includes('user_id') ? 'user_id' : null;
  const branchCol = colsCaja.includes('branch_id') ? 'branch_id' : null;
  if (!userCol) return null;
  let sql =
    "SELECT id FROM cajas WHERE (estado='ABIERTA' OR estado IS NULL) AND fecha_cierre IS NULL AND " +
    `${userCol} = $1`;
  const params = [userId];
  if (branchCol && branchId) {
    sql += ` AND ${branchCol} = $2`;
    params.push(branchId);
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const st = await query(sql, params, db);
  return st.rows[0]?.id ? Number(st.rows[0].id) : null;
}

async function bumpCajaTotal(db, cajaId, amount) {
  if (!cajaId || !Number.isFinite(amount)) return;
  if (!(await tableExists(db, 'cajas'))) return;
  await query('UPDATE cajas SET total_ventas = COALESCE(total_ventas,0) + $1 WHERE id = $2', [
    amount,
    cajaId
  ], db);
}

async function insertHospitalSale(db, payload) {
  const {
    admissionId,
    charges,
    branchId,
    userId,
    total,
    note,
    cajaId,
    paymentMethod,
    paymentDetails,
    customerDocType,
    customerDocValue,
    createdAt
  } = payload;

  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleItemsTable = await pickTable(db, ['venta_items', 'sale_items', 'detalle_venta', 'detalle_ventas'], 'venta_items');
  const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], null);
  const salesTotalCol = await pickColumn(db, salesTable, ['total', 'monto_total', 'importe_total'], 'total');
  const salesUserCol = await pickColumn(db, salesTable, ['usuario_id', 'user_id', 'cajero_id'], null);
  const salesBranchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);
  const salesNoteCol = await pickColumn(db, salesTable, ['note', 'nota', 'observacion'], null);
  const salesCajaCol = await pickColumn(db, salesTable, ['caja_id', 'cashbox_id'], null);
  const salesCustomerTypeCol = await pickColumn(db, salesTable, ['cliente_tipo', 'tipo_cliente', 'customer_type'], null);
  const salesCustomerDocCol = await pickColumn(
    db,
    salesTable,
    ['cliente_documento', 'documento_cliente', 'customer_document'],
    null
  );
  const salesNitCol = await pickColumn(db, salesTable, ['nit'], null);
  const salesCuiCol = await pickColumn(db, salesTable, ['cui'], null);

  const fields = [];
  const values = [];
  const usedCols = new Set();
  const addField = (col, value) => {
    if (!col || usedCols.has(col)) return;
    usedCols.add(col);
    fields.push(quoteIdent(col));
    values.push(value);
  };
  const stamp = createdAt || new Date();
  if (salesDateCol) {
    addField(salesDateCol, stamp);
  }
  if (salesUserCol && userId) {
    addField(salesUserCol, userId);
  }
  if (salesBranchCol && branchId) {
    addField(salesBranchCol, branchId);
  }
  if (salesTotalCol) {
    addField(salesTotalCol, total);
  }
  if (salesNoteCol) {
    addField(salesNoteCol, note || null);
  }
  if (salesCajaCol) {
    addField(salesCajaCol, cajaId || null);
  }
  const normalizedCustomerDocType = normalizeBillingCustomerDocType(customerDocType);
  const normalizedCustomerDocValue = normalizeBillingCustomerDocValue(customerDocValue);
  if (normalizedCustomerDocType && salesCustomerTypeCol) {
    addField(salesCustomerTypeCol, normalizedCustomerDocType);
  }
  if (normalizedCustomerDocValue && salesCustomerDocCol) {
    addField(salesCustomerDocCol, normalizedCustomerDocValue);
  }
  if (normalizedCustomerDocType === 'nit' && normalizedCustomerDocValue && salesNitCol) {
    addField(salesNitCol, normalizedCustomerDocValue);
  }
  if (normalizedCustomerDocType === 'cui' && normalizedCustomerDocValue && salesCuiCol) {
    addField(salesCuiCol, normalizedCustomerDocValue);
  }
  if (!fields.length) {
    const err = new Error('No se pudo registrar la venta (estructura desconocida)');
    err.statusCode = 500;
    throw err;
  }

  const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
  const saleIns = await query(
    `INSERT INTO ${quoteIdent(salesTable)} (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`,
    values,
    db
  );
  const saleId = Number(saleIns.rows[0].id);

  if (await tableExists(db, saleItemsTable)) {
    const siCols = await getColumns(db, saleItemsTable);
    const siSaleIdCol = siCols.includes('sale_id') ? 'sale_id' : siCols.includes('venta_id') ? 'venta_id' : null;
    const siProdIdCol = siCols.includes('producto_id') ? 'producto_id' : siCols.includes('product_id') ? 'product_id' : null;
    const siQtyCol = siCols.includes('cantidad') ? 'cantidad' : siCols.includes('qty') ? 'qty' : null;
    const siUnitCol = siCols.includes('precio_unit')
      ? 'precio_unit'
      : siCols.includes('unit_price')
      ? 'unit_price'
      : null;
    const siSubCol = siCols.includes('subtotal')
      ? 'subtotal'
      : siCols.includes('importe')
      ? 'importe'
      : siCols.includes('total_linea')
      ? 'total_linea'
      : null;

    if (siSaleIdCol && siProdIdCol && siQtyCol && siUnitCol) {
      const grouped = new Map();
      for (const ch of charges || []) {
        const pid = Number(ch.product_id || 0);
        if (!pid) continue;
        const chargeType = normalizeProductType(ch.product_type || ch.tipo || 'medicamento');
        if (chargeType === 'servicio') continue;
        const unit = Number(ch.unit_price || 0);
        const qty = Number(ch.quantity || 0);
        const key = `${pid}|${unit}`;
        if (!grouped.has(key)) {
          grouped.set(key, { product_id: pid, unit_price: unit, qty: 0 });
        }
        grouped.get(key).qty += qty;
      }
      for (const item of grouped.values()) {
        const cols = [siSaleIdCol, siProdIdCol, siQtyCol, siUnitCol].map(quoteIdent);
        const vals = [saleId, item.product_id, item.qty, item.unit_price];
        if (siSubCol) {
          cols.push(quoteIdent(siSubCol));
          vals.push(item.qty * item.unit_price);
        }
        const ph = vals.map((_, idx) => `$${idx + 1}`).join(',');
        await query(`INSERT INTO ${quoteIdent(saleItemsTable)} (${cols.join(',')}) VALUES (${ph})`, vals, db);
      }
    }
  }

  const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
  if (await tableExists(db, paymentsTable)) {
    const payCols = await getColumns(db, paymentsTable);
    const payHasCreated = payCols.includes('created_at');
    const cols = [
      'sale_id',
      'purchase_id',
      'branch_id',
      'user_id',
      'amount',
      'payment_type',
      'payment_method_details',
      'is_credit'
    ];
    const vals = [
      saleId,
      null,
      branchId,
      userId,
      total,
      paymentMethod || 'efectivo',
      JSON.stringify(paymentDetails || {}),
      0
    ];
    if (payHasCreated) {
      cols.push('created_at');
      vals.push(stamp);
    }
    const ph = vals.map((_, idx) => `$${idx + 1}`).join(',');
    await query(
      `INSERT INTO ${quoteIdent(paymentsTable)} (${cols.map(quoteIdent).join(',')}) VALUES (${ph})`,
      vals,
      db
    );
  }

  return saleId;
}

function serviceDetailsFromCharges(charges) {
  const services = [];
  for (const ch of charges || []) {
    const chargeType = normalizeProductType(ch.product_type || ch.tipo || (ch.product_id ? 'medicamento' : 'servicio'));
    if (chargeType !== 'servicio') continue;
    const qty = Number(ch.quantity || 0);
    const unit = Number(ch.unit_price || 0);
    const amount = Number((qty * unit).toFixed(2));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    services.push({
      descripcion: ch.description || 'Servicio hospitalario',
      monto: amount,
      producto_id: Number(ch.product_id || 0) || null
    });
  }
  return services;
}

function parseYmd(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return new Date();
  const [yy, mm, dd] = raw.slice(0, 10).split('-').map((v) => Number(v));
  return new Date(yy, mm - 1, dd);
}

function normalizeAdmissionArea(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'emergencia' || normalized === 'hospitalizacion') return normalized;
  return null;
}

function canManageAdmissionPatientData(role) {
  const normalized = canonRole(role || '');
  return [
    'admin',
    'cashiee',
    'cashierh',
    'hospital',
    'superadmin',
    'medico',
    'direccionmedica',
    'consultorio2',
    'consultorio3'
  ].includes(normalized);
}

function canEditAdmissionVitalSigns(role) {
  const normalized = canonRole(role || '');
  return ['admin', 'superadmin', 'medico', 'direccionmedica', 'consultorio2', 'consultorio3'].includes(
    normalized
  );
}

function canManageAdmissionBilling(role) {
  const normalized = canonRole(role || '');
  return ['admin', 'cashiee', 'cashierh', 'hospital', 'enfermeria', 'superadmin'].includes(normalized);
}

function normalizeVitalSigns(input) {
  const source =
    input && typeof input.signos_vitales === 'object' && input.signos_vitales != null ? input.signos_vitales : input || {};
  const keys = ['peso', 'talla', 'temp', 'presion', 'fc', 'fr', 'saturacion', 'otros'];
  const payload = {};
  let touched = false;
  let hasValue = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    touched = true;
    const raw = source[key];
    const value = raw != null ? String(raw).trim() : '';
    payload[key] = value || null;
    if (payload[key]) hasValue = true;
  }
  return { touched, hasValue, payload };
}

function buildIneWorkbook(rows, tipo) {
  const isHosp = tipo === 'hospitalizacion';
  const dataRows = [];
  const dateRef = rows[0]?.fecha || rows[0]?.fecha_ingreso || new Date().toISOString().slice(0, 10);
  const dt = parseYmd(dateRef);
  const monthNames = [
    '',
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre'
  ];
  const monthLabel = monthNames[dt.getMonth() + 1] || '';
  const yearLabel = String(dt.getFullYear());

  if (isHosp) {
    dataRows.push(['REGISTROS DIARIOS DE INGRESOS EN CENTROS HOSPITALARIOS PRIVADOS - REPUBLICA DE GUATEMALA']);
    dataRows.push(['NOMBRE DEL CENTRO HOSPITALARIO: HOSPITAL HILARIO GALINDO']);
    dataRows.push([]);
    dataRows.push(['DEPARTAMENTO', 'Retalhuleu', '11']);
    dataRows.push(['MUNICIPIO', 'SAN FELIPE', '5']);
    dataRows.push([]);
    const formRow = [];
    formRow[5] = 'FORMA INEEH-02';
    formRow[6] = monthLabel;
    formRow[8] = yearLabel;
    dataRows.push(formRow);
  } else {
    dataRows.push(['DEPARTAMENTO', 'Retalhuleu', '11']);
    dataRows.push(['MUNICIPIO', 'SAN FELIPE', '5']);
    dataRows.push([]);
    const mesRow = [];
    mesRow[9] = 'MES';
    mesRow[10] = monthLabel;
    mesRow[11] = 'ANIO';
    mesRow[12] = yearLabel;
    dataRows.push(mesRow);
  }

  const headers = isHosp
    ? [
        'NO. ORDEN',
        'FECHA DE INGRE',
        'FECHA DE EGRE',
        'TRASLADO',
        '2/ SEXO',
        '3/ PUEBLO DE PERTENENCIA',
        'EDAD Anios',
        'LUGAR DE RESIDENCIA HABITUAL - Direccion exacta',
        'LUGAR DE RESIDENCIA HABITUAL - Municipio/Departamento',
        'DIAGNOSTICO (s)',
        'TRATAMIENTO MEDICO',
        '6/ CONDICION DE EGRESO',
        '6/ ESPECIALIDAD O PROCEDIMIENTO RECIBIDO EN'
      ]
    : [
        'No. ORDEN',
        'Paciente tiene derecho a IGSS',
        'DIA DE CONSULTA',
        '2/ SEXO',
        '3/ PUEBLO DE PERTENENCIA',
        '4/ EDAD Meses',
        '4/ EDAD Anios',
        'LUGAR DE RESIDENCIA HABITUAL - Direccion exacta',
        'LUGAR DE RESIDENCIA HABITUAL - Municipio/Departamento',
        '5/ CONSULTA',
        '6/ CONTROL MATERNO-INFANTIL',
        'DIAGNOSTICO',
        'CODIGO (CIE-10) PARA USO EXCLUSIVO DEL',
        '7/ TRATAMIENTO RECIBIDO O EN',
        'TRASLADO'
      ];
  dataRows.push(headers);

  let order = 1;
  for (const row of rows) {
    if (isHosp) {
      dataRows.push([
        row.numero_orden || order,
        row.fecha_ingreso || '',
        row.fecha_egreso || '',
        row.traslado || '',
        row.sexo || '',
        row.pueblo || '',
        row.edad_anios || '',
        row.direccion || '',
        row.municipio || '',
        row.diagnostico || '',
        row.tratamiento || '',
        row.condicion_egreso || '',
        row.procedimiento || row.especialidad || ''
      ]);
    } else {
      dataRows.push([
        order,
        row.igss || '',
        row.dia_consulta || '',
        row.sexo || '',
        row.pueblo || '',
        row.edad_meses || '',
        row.edad_anios || '',
        row.direccion || '',
        row.municipio || '',
        row.consulta || '',
        row.control_materno || '',
        row.diagnostico || '',
        row.cie || '',
        row.tratamiento || '',
        row.traslado || ''
      ]);
    }
    order += 1;
  }

  dataRows.push([]);
  const signRow = [];
  signRow[1] = 'FIRMA DE DIRECTOR MEDICO';
  signRow[8] = 'FIRMA Y SELLO';
  dataRows.push(signRow);

  const ws = XLSX.utils.aoa_to_sheet(dataRows);
  const widths = isHosp
    ? [10, 16, 16, 12, 22, 10, 30, 22, 36, 40, 18, 20]
    : [10, 20, 18, 12, 22, 10, 10, 28, 18, 16, 16, 36, 16, 20];
  ws['!cols'] = widths.map((w) => ({ wch: w }));

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
  XLSX.utils.book_append_sheet(wb, ws, 'INE');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}
router.all(
  '/consultas',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'recepcion',
      'preconsulta',
      'direccionmedica',
      'consultorio2',
      'consultorio3',
      'medico'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureConsultSchema();

    const method = req.method;
    const data = readJson(req);
    let role = canonRole(req.session?.user?.rol || req.session?.user?.role || '');
    if (role === 'superadmin') role = 'admin';

    if (method === 'POST') {
      if (role !== 'admin' && role !== 'recepcion') {
        return safeJson(res, { ok: false, error: 'Solo recepcion puede registrar' }, 403);
      }
      const nombre = String(data.nombre || '').trim();
      const sexo = String(data.sexo || '').trim();
      const telefono = String(data.telefono || '').trim();
      const direccion = String(data.direccion || '').trim();
      const dpi = String(data.dpi || '').trim();
      const motivo = String(data.motivo || '').trim();
      const medicoRaw = String(data.medico || '').trim();
      let patientId = data.patient_id != null ? Number(data.patient_id) : 0;
      const autoIne =
        data.auto_ine === true ||
        data.auto_ine === 1 ||
        data.auto_ine === '1' ||
        String(data.auto_ine || '').toLowerCase() === 'true';
      if (!nombre && patientId <= 0) {
        return safeJson(res, { ok: false, error: 'Nombre requerido' }, 400);
      }
      if (!medicoRaw) {
        return safeJson(res, { ok: false, error: 'Asignar medico' }, 400);
      }
      const consultorio = mapConsultorio(medicoRaw);
      let medicoLabel = medicoRaw;
      if (medicoRaw.toLowerCase().includes('axel')) medicoLabel = 'Dr. Axel';
      if (medicoRaw.toLowerCase().includes('yorentine')) medicoLabel = 'Dr. Yorentine';
      if (medicoRaw.toLowerCase().includes('arias')) medicoLabel = 'Dr. Arias';

      if (autoIne) {
        await ensureIneSchema();
      }

      const result = await withTransaction(async (db) => {
        if (patientId <= 0) {
          const ins = await query(
            'INSERT INTO patients (nombre, sexo, telefono, direccion, dpi) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [nombre, sexo || null, telefono || null, direccion || null, dpi || null],
            db
          );
          patientId = Number(ins.rows[0].id);
        } else {
          const updName = nombre || data.nombre_old || '';
          await query(
            'UPDATE patients SET nombre = $1, sexo = $2, telefono = $3, direccion = $4, dpi = $5 WHERE id = $6',
            [updName, sexo || null, telefono || null, direccion || null, dpi || null, patientId],
            db
          );
        }
          const cins = await query(
            'INSERT INTO consultations (patient_id, motivo, medico, consultorio, estado) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [patientId, motivo || null, medicoLabel, consultorio || null, 'pendiente'],
            db
          );
          if (autoIne) {
            const clean = (v) => {
              const raw = v != null ? String(v).trim() : '';
              return raw ? raw : null;
            };
            const now = new Date();
            const fecha = now.toISOString().slice(0, 10);
            const diaConsulta = clean(weekdayES(now));
            const branchId = await branchIdByHint(db, 'principal');
            await query(
              `INSERT INTO ine_reports
              (tipo, fecha, igss, dia_consulta, sexo, pueblo, edad_anios, edad_meses, direccion, municipio, consulta,
               control_materno, diagnostico, cie, tratamiento, branch_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [
                'emergencia',
                fecha,
                null,
                diaConsulta,
                clean(sexo),
                null,
                null,
                null,
                clean(direccion),
                null,
                'Consulta externa',
                null,
                clean(motivo),
                'Vivo',
                null,
                branchId
              ],
              db
            );
          }
          return Number(cins.rows[0].id);
        });

      return safeJson(res, { ok: true, patient_id: patientId, consulta_id: result });
    }

    if (method === 'PUT') {
      const cid = data.id != null ? Number(data.id) : 0;
      if (!cid) return safeJson(res, { ok: false, error: 'ID de consulta requerido' }, 400);
      const st = await query('SELECT * FROM consultations WHERE id = $1 LIMIT 1', [cid]);
      const row = st.rows[0];
      if (!row) return safeJson(res, { ok: false, error: 'Consulta no encontrada' }, 404);

      if (role === 'preconsulta') {
        const signos = {
          peso: data.peso ?? null,
          talla: data.talla ?? null,
          temp: data.temp ?? null,
          presion: data.presion ?? null,
          fc: data.fc ?? null,
          fr: data.fr ?? null,
          saturacion: data.saturacion ?? null,
          otros: data.otros ?? null
        };
        await query(
          'UPDATE consultations SET signos = $1, estado = $2, updated_at = NOW() WHERE id = $3',
          [JSON.stringify(signos), 'preconsulta', cid]
        );
        return safeJson(res, { ok: true });
      }

      if (['direccionmedica', 'consultorio2', 'consultorio3', 'admin'].includes(role)) {
        const diag = String(data.diagnostico || '').trim();
        const receta = Array.isArray(data.receta) ? data.receta : [];
        await query(
          'UPDATE consultations SET diagnostico = $1, receta = $2, estado = $3, updated_at = NOW() WHERE id = $4',
          [diag || null, JSON.stringify(receta || []), 'cerrada', cid]
        );
        return safeJson(res, { ok: true });
      }

      return safeJson(res, { ok: false, error: 'No autorizado' }, 403);
    }

    if (method === 'GET') {
      const estado = req.query.estado ? String(req.query.estado).trim() : '';
      const medicoFilter = req.query.medico ? String(req.query.medico).trim() : '';
      const q = req.query.q ? String(req.query.q).trim() : '';

      const where = [];
      const params = [];

      let medicoFilterNorm = medicoFilter;
      if (role === 'direccionmedica') {
        medicoFilterNorm = '';
      }
      if (estado) {
        where.push(`c.estado = $${params.length + 1}`);
        params.push(estado);
      }
      if (medicoFilterNorm) {
        where.push(`LOWER(c.medico) = $${params.length + 1}`);
        params.push(medicoFilterNorm.toLowerCase());
      }

      if (role === 'preconsulta' && !estado && !q && !medicoFilter) {
        where.push("c.estado = 'pendiente'");
      }

      if (['direccionmedica', 'consultorio2', 'consultorio3'].includes(role)) {
        let label = '';
        if (role === 'direccionmedica') label = 'Dr. Axel';
        if (role === 'consultorio2') label = 'Dr. Yorentine';
        if (role === 'consultorio3') label = 'Dr. Arias';
        if (label) {
          const conds = ['LOWER(c.medico) = $' + (params.length + 1), 'LOWER(c.consultorio) = $' + (params.length + 2)];
          params.push(label.toLowerCase());
          params.push(mapConsultorio(label).toLowerCase());
          if (role === 'direccionmedica') {
            conds.push('LOWER(c.consultorio) = $' + (params.length + 1));
            params.push('direccionmedica');
            conds.push('LOWER(c.consultorio) = $' + (params.length + 1));
            params.push('consultorio1');
            conds.push('LOWER(c.consultorio) = $' + (params.length + 1));
            params.push('direccion medica');
          }
          where.push(`(${conds.join(' OR ')})`);
        }
        if (!estado) {
          where.push("c.estado IN ('preconsulta','pendiente')");
        }
      }

      if (q) {
        const like = `%${q}%`;
        where.push(`(p.nombre ILIKE $${params.length + 1} OR p.dpi ILIKE $${params.length + 2})`);
        params.push(like, like);
      }

      let sql =
        'SELECT c.*, p.nombre AS paciente, p.sexo, p.telefono, p.direccion, p.dpi FROM consultations c JOIN patients p ON p.id = c.patient_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY c.id ASC';
      const st = await query(sql, params);
      return safeJson(res, st.rows);
    }

    return safeJson(res, { ok: false, error: 'Metodo no permitido' }, 405);
  })
);
router.get(
  '/patients_search',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'recepcion',
      'preconsulta',
      'direccionmedica',
      'consultorio2',
      'consultorio3',
      'medico'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureConsultSchema();

    const id = req.query.id ? Number(req.query.id) : 0;
    if (id > 0) {
      const st = await query('SELECT id, nombre, sexo, telefono, direccion, dpi FROM patients WHERE id = $1 LIMIT 1', [
        id
      ]);
      return safeJson(res, st.rows || []);
    }
    const q = req.query.q ? String(req.query.q).trim() : '';
    if (!q) return safeJson(res, []);
    const like = `%${q}%`;
    const st = await query(
      'SELECT id, nombre, sexo, telefono, direccion, dpi FROM patients WHERE nombre ILIKE $1 OR dpi ILIKE $1 ORDER BY id DESC LIMIT 50',
      [like]
    );
    return safeJson(res, st.rows || []);
  })
);

router.get(
  '/ine_reports',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'cashiee',
      'cashierh',
      'hospital',
      'medico',
      'secretaria',
      'enfermeria',
      'superadmin',
      'direccionmedica',
      'consultorio2',
      'consultorio3'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureIneSchema();

    const roleRaw = req.session?.user?.rol || req.session?.user?.role || '';
    const isEmergRole = String(roleRaw || '').toLowerCase() === 'cashiee';
    const branchEmerg = isEmergRole ? 2 : null;

    let sql = 'SELECT * FROM ine_reports';
    const params = [];
    if (branchEmerg) {
      sql += ' WHERE branch_id = $1';
      params.push(branchEmerg);
    }
    sql += ' ORDER BY id DESC LIMIT 200';
    const st = await query(sql, params);
    return safeJson(res, st.rows || []);
  })
);

router.post(
  '/ine_reports',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'cashiee',
      'cashierh',
      'hospital',
      'medico',
      'secretaria',
      'enfermeria',
      'superadmin',
      'direccionmedica',
      'consultorio2',
      'consultorio3'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureIneSchema();

    const data = readJson(req);
    const clean = (v) => {
      const raw = v != null ? String(v).trim() : '';
      return raw ? raw : null;
    };
    const clientId = data.client_id != null && data.client_id !== '' ? Number(data.client_id) : null;
    const fecha = clean(data.fecha) || new Date().toISOString().slice(0, 10);
    const tipo = clean(data.tipo) || 'emergencia';
    const igss = clean(data.igss);
    const diaConsulta = clean(data.dia_consulta);
    const sexo = clean(data.sexo);
    const pueblo = clean(data.pueblo);
    const edadA = data.edad_anios !== '' && data.edad_anios != null ? Number(data.edad_anios) : null;
    const edadM = data.edad_meses !== '' && data.edad_meses != null ? Number(data.edad_meses) : null;
    const direccion = clean(data.direccion);
    const municipio = clean(data.municipio);
    const consulta = clean(data.consulta);
    const control = clean(data.control_materno);
    const diagnostico = clean(data.diagnostico);
    const cie = clean(data.cie);
    const tratamiento = clean(data.tratamiento);
    const numOrden = data.numero_orden !== '' && data.numero_orden != null ? Number(data.numero_orden) : null;
    const fechaIng = clean(data.fecha_ingreso);
    const fechaEgre = clean(data.fecha_egreso);
    const traslado = clean(data.traslado);
    const condicion = clean(data.condicion_egreso);
    const especialidad = clean(data.especialidad);
    const procedimiento = clean(data.procedimiento);
    let branchId = data.branch_id != null ? Number(data.branch_id) : null;

    const roleRaw = req.session?.user?.rol || req.session?.user?.role || '';
    const isEmergRole = String(roleRaw || '').toLowerCase() === 'cashiee';
    if (isEmergRole) branchId = 2;
    if (!fecha) return safeJson(res, { ok: false, error: 'fecha requerida' }, 400);

    const ins = await query(
      `INSERT INTO ine_reports
      (client_id, tipo, fecha, igss, dia_consulta, sexo, pueblo, edad_anios, edad_meses, direccion, municipio, consulta,
       control_materno, diagnostico, cie, tratamiento, branch_id, numero_orden, fecha_ingreso, fecha_egreso,
       traslado, condicion_egreso, especialidad, procedimiento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id`,
      [
        clientId,
        tipo,
        fecha,
        igss,
        diaConsulta,
        sexo,
        pueblo,
        edadA,
        edadM,
        direccion,
        municipio,
        consulta,
        control,
        diagnostico,
        cie,
        tratamiento,
        branchId,
        numOrden,
        fechaIng,
        fechaEgre,
        traslado,
        condicion,
        especialidad,
        procedimiento
      ]
    );
    return safeJson(res, { ok: true, id: Number(ins.rows[0].id) });
  })
);

router.get(
  '/ine_export',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'cashiee',
      'cashierh',
      'hospital',
      'medico',
      'secretaria',
      'enfermeria',
      'superadmin',
      'direccionmedica',
      'consultorio2',
      'consultorio3'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureIneSchema();

    const tipo = (req.query.tipo ? String(req.query.tipo) : 'emergencia').toLowerCase() || 'emergencia';
    const cols = [
      'id',
      'tipo',
      'fecha',
      'igss',
      'dia_consulta',
      'sexo',
      'pueblo',
      'edad_anios',
      'edad_meses',
      'direccion',
      'municipio',
      'consulta',
      'control_materno',
      'diagnostico',
      'cie',
      'tratamiento',
      'branch_id',
      'numero_orden',
      'fecha_ingreso',
      'fecha_egreso',
      'traslado',
      'condicion_egreso',
      'especialidad',
      'procedimiento'
    ];
    const params = [];
    const where = [];
    if (tipo === 'emergencia' || tipo === 'hospitalizacion') {
      where.push(`LOWER(tipo) = $${params.length + 1}`);
      params.push(tipo);
    }
    const from = req.query.from ? String(req.query.from).trim() : '';
    const to = req.query.to ? String(req.query.to).trim() : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push(`fecha >= $${params.length + 1}`);
      params.push(from);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push(`fecha <= $${params.length + 1}`);
      params.push(to);
    }
    let sql = `SELECT ${cols.join(',')} FROM ine_reports`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY id ASC';
    const rows = await query(sql, params);
    const buffer = buildIneWorkbook(rows.rows || [], tipo);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="ine_${tipo}_${stamp}.xlsx"`);
    res.end(buffer);
  })
);

router.all(
  '/receta_pdf',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'direccionmedica', 'consultorio2', 'consultorio3', 'preconsulta', 'recepcion'])(
      req,
      res,
      async () => {}
    );
    if (res.headersSent) return;
    await ensureConsultSchema();

    const cid = req.query.id ? Number(req.query.id) : 0;
    const isDraft = req.query.draft != null && Number(req.query.draft) === 1;
    const draftData = req.method === 'POST' ? readJson(req) : null;
    if (!cid) return res.type('text/plain').send('ID invalido');

    const st = await query(
      'SELECT c.*, p.nombre AS paciente, p.sexo, p.telefono, p.direccion FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE c.id = $1 LIMIT 1',
      [cid]
    );
    const row = st.rows[0];
    if (!row) return res.type('text/plain').send('Consulta no encontrada');

    if (isDraft && draftData && typeof draftData === 'object') {
      if (draftData.diagnostico) row.diagnostico = draftData.diagnostico;
      if (draftData.receta) row.receta = draftData.receta;
      if (draftData.paciente) row.paciente = draftData.paciente;
      if (draftData.medico) row.medico = draftData.medico;
    }

    const recetaItems = normalizeRecetaItems(row.receta || row.receta_json || '[]');
    const diagnostico = normalizeDiagnostico(row.diagnostico || row.diag || row.diagnosis || '');

    res.setHeader('Content-Type', 'application/pdf');
    const doc = new PDFDocument({ size: [396, 612], margin: 40 });
    doc.pipe(res);
    doc.fontSize(16).text('Receta Medica', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text(`Paciente: ${row.paciente || ''}`);
    doc.text(`Medico asignado: ${row.medico || ''}`);
    const fecha = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '';
    doc.text(`Fecha: ${fecha}`);
    doc.moveDown(0.5);
    doc.fontSize(11).text('Diagnostico', { underline: true });
    doc.fontSize(11).text(diagnostico || '');
    doc.moveDown(0.5);
    doc.fontSize(11).text('Receta', { underline: true });
    if (recetaItems.length) {
      recetaItems.forEach((item, idx) => {
        const line = `${idx + 1}. ${item.medicamento || 'Medicamento'}, dosis: ${item.dosis || ''}, frecuencia: ${
          item.frecuencia || ''
        }, duracion: ${item.duracion || ''}`;
        doc.text(line);
      });
    } else {
      doc.text('Sin receta');
    }
    doc.moveDown(1.5);
    doc.text('______________________');
    doc.text('Firma del medico');
    doc.end();
  })
);
router.all(
  '/hospital',
  asyncHandler(async (req, res) => {
    await requireRole([
      'admin',
      'administrador',
      'cashierh',
      'hospital',
      'cashiee',
      'medico',
      'enfermeria',
      'superadmin',
      'direccionmedica',
      'consultorio2',
      'consultorio3'
    ])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureHospitalSchema();

    const request = { ...req.query, ...readJson(req) };
    const action = String(request.action || '').trim().toLowerCase();
    const role = canonRole(req.session?.user?.rol || req.session?.user?.role || '');
    const userId = req.session?.user?.id || null;
    const sessionActor = { ...(req.session?.user || req.user || {}), session_id: req.sessionID };

    if (action === 'events') {
      const area = normalizeAdmissionArea(request.area || request.tipo) || 'all';
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      if (req.socket) {
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
      }
      const subscriber = {
        res,
        area,
        heartbeat: null
      };
      subscriber.heartbeat = setInterval(() => {
        writeHospitalEvent(subscriber, 'ping', { ts: Date.now() });
      }, HOSPITAL_EVENT_HEARTBEAT_MS);
      hospitalEventSubscribers.add(subscriber);
      writeHospitalEvent(subscriber, 'connected', buildHospitalEventPayload({ type: 'connected', area }));
      req.on('close', () => {
        removeHospitalEventSubscriber(subscriber);
      });
      return;
    }

    if (action === 'room_status') {
      return safeJson(res, { ok: true, rooms: await roomStatus(null) });
    }

    if (action === 'list_clients') {
      await ensureIneSchema();
      const area = normalizeAdmissionArea(request.pending_area || request.tipo || request.area || '');
      const pendingOnly =
        String(request.pending_only || request.queue_only || '').trim() === '1' ||
        String(request.pending_only || request.queue_only || '').trim().toLowerCase() === 'true';
      let sql =
        'SELECT id, nombre, documento, telefono, direccion, es_menor, fecha_nacimiento, encargado_nombre, encargado_dpi, signos_vitales, pending_area, created_at FROM hospital_clients';
      const params = [];
      const docFilter = request.documento || request.dpi || request.search || '';
      const key = docKey(docFilter);
      const where = [];
      if (pendingOnly) {
        where.push(
          `NOT EXISTS (
             SELECT 1 FROM hospital_admissions a0
             WHERE a0.client_id = hospital_clients.id AND LOWER(COALESCE(a0.status, '')) = 'open'
           )`
        );
        if (area) {
          where.push(`LOWER(COALESCE(hospital_clients.pending_area, '')) = $${params.length + 1}`);
          params.push(area);
        }
      }
      if (key) {
        const exprDoc = docExpr('documento');
        const exprEnc = docExpr('encargado_dpi');
        where.push(`(${exprDoc} LIKE $${params.length + 1} OR ${exprEnc} LIKE $${params.length + 2})`);
        const like = `%${key}%`;
        params.push(like, like);
      }
      if (where.length) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }
      sql += pendingOnly && !key ? ' ORDER BY created_at ASC, nombre ASC' : ' ORDER BY nombre ASC';
      const st = await query(sql, params);
      const clients = Array.isArray(st.rows) ? st.rows : [];
      if (key) {
        clients.forEach((client) => {
          const ownDoc = docKey(client.documento || '');
          const guardianDoc = docKey(client.encargado_dpi || '');
          const ownMatch = ownDoc.includes(key);
          const guardianMatch = guardianDoc.includes(key);
          client.match_field = ownMatch && guardianMatch ? 'both' : ownMatch ? 'documento' : guardianMatch ? 'encargado_dpi' : '';
          client.area_match = area && client.pending_area ? String(client.pending_area).toLowerCase() === area : false;
        });
        clients.sort((left, right) => {
          const areaDiff = Number(Boolean(right.area_match)) - Number(Boolean(left.area_match));
          if (areaDiff !== 0) return areaDiff;
          const rank = (value) => {
            if (value === 'documento') return 0;
            if (value === 'both') return 1;
            if (value === 'encargado_dpi') return 2;
            return 3;
          };
          const diff = rank(left.match_field) - rank(right.match_field);
          if (diff !== 0) return diff;
          return String(left.nombre || '').localeCompare(String(right.nombre || ''), 'es', { sensitivity: 'base' });
        });
      }
      if (
        clients.length &&
        (await tableExists(null, 'ine_reports')) &&
        (await columnExists(null, 'ine_reports', 'client_id'))
      ) {
        const clientIds = Array.from(new Set(clients.map((row) => Number(row.id || 0)).filter((id) => id > 0)));
        if (clientIds.length) {
          const latestIneRes = await query(
            `SELECT DISTINCT ON (client_id)
                client_id, id, tipo, fecha, igss, dia_consulta, sexo, pueblo, edad_anios, edad_meses,
                direccion, municipio, consulta, control_materno, diagnostico, cie, tratamiento,
                numero_orden, fecha_ingreso, fecha_egreso, traslado, condicion_egreso, especialidad,
                procedimiento, created_at
             FROM ine_reports
             WHERE client_id = ANY($1::int[])
             ORDER BY client_id, COALESCE(fecha_ingreso, fecha, DATE(created_at)) DESC, id DESC`,
            [clientIds]
          );
          const latestIneByClient = new Map();
          for (const row of latestIneRes.rows || []) {
            const clientId = Number(row.client_id || 0);
            if (clientId > 0) latestIneByClient.set(clientId, row);
          }
          clients.forEach((client) => {
            client.latest_ine = latestIneByClient.get(Number(client.id || 0)) || null;
          });
        }
      }
      return safeJson(res, { ok: true, clients });
    }

    if (action === 'history') {
      const clientId = request.client_id != null ? Number(request.client_id) : 0;
      if (!clientId) return safeJson(res, { ok: false, error: 'Paciente invalido' }, 400);
      if (!(await tableExists(null, 'hospital_history'))) {
        return safeJson(res, { ok: true, history: [] });
      }
      const sql = `
        SELECT h.id, h.admission_id, h.summary, h.total_cargos, h.discount_amount, h.total_pagado, h.created_at,
               a.room_type, a.room_number, a.created_at AS admission_created_at
        FROM hospital_history h
        LEFT JOIN hospital_admissions a ON a.id = h.admission_id
        WHERE h.client_id = $1
        ORDER BY h.created_at DESC
      `;
      const st = await query(sql, [clientId]);
      return safeJson(res, { ok: true, history: st.rows });
    }

    if (action === 'history_search') {
      await ensureIneSchema();
      const areaRaw = String(request.tipo || request.area || '').trim().toLowerCase();
      const area =
        areaRaw === 'hospitalizacion' || areaRaw === 'emergencia'
          ? areaRaw
          : null;
      const from = normalizeDate(request.from || request.fecha_desde || request.fecha_inicio || request.fecha || null);
      const to = normalizeDate(request.to || request.fecha_hasta || request.fecha_fin || request.fecha || null);
      if (!from && !to) return safeJson(res, { ok: true, history: [] });
      const rows = [];

      if (await tableExists(null, 'hospital_history')) {
        const where = [];
        const params = [];
        if (from) {
          where.push(`DATE(h.created_at) >= $${params.length + 1}`);
          params.push(from);
        }
        if (to) {
          where.push(`DATE(h.created_at) <= $${params.length + 1}`);
          params.push(to);
        }
        if (area) {
          where.push(`LOWER(COALESCE(a.tipo, 'hospitalizacion')) = $${params.length + 1}`);
          params.push(area);
        }
        const sql = `
          SELECT
            h.id AS history_id,
            h.admission_id,
            h.summary,
            h.total_cargos,
            h.discount_amount,
            h.total_pagado,
            h.created_at,
            LOWER(COALESCE(a.tipo, 'hospitalizacion')) AS tipo,
            c.*,
            'history'::text AS history_kind
          FROM hospital_history h
          JOIN hospital_clients c ON c.id = h.client_id
          LEFT JOIN hospital_admissions a ON a.id = h.admission_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY h.created_at DESC
          LIMIT 200
        `;
        const st = await query(sql, params);
        rows.push(...(Array.isArray(st.rows) ? st.rows : []));
      }

      if (await tableExists(null, 'hospital_clients')) {
        const hasAdmissionsTable = await tableExists(null, 'hospital_admissions');
        const hasIneTable =
          (await tableExists(null, 'ine_reports')) && (await columnExists(null, 'ine_reports', 'client_id'));
        const where = [];
        const params = [];
        if (from) {
          where.push(`DATE(c.created_at) >= $${params.length + 1}`);
          params.push(from);
        }
        if (to) {
          where.push(`DATE(c.created_at) <= $${params.length + 1}`);
          params.push(to);
        }
        if (hasAdmissionsTable) {
          where.push(`NOT EXISTS (SELECT 1 FROM hospital_admissions a0 WHERE a0.client_id = c.id)`);
        }
        if (area && hasIneTable) {
          where.push(`COALESCE(NULLIF(LOWER(li.tipo), ''), $${params.length + 1}) = $${params.length + 1}`);
          params.push(area);
        }
        const latestIneJoin = hasIneTable
          ? `LEFT JOIN LATERAL (
               SELECT ir.tipo
               FROM ine_reports ir
               WHERE ir.client_id = c.id
               ORDER BY COALESCE(ir.fecha_ingreso, ir.fecha, DATE(ir.created_at)) DESC, ir.id DESC
               LIMIT 1
             ) li ON TRUE`
          : '';
        const latestIneTipo = hasIneTable ? `LOWER(NULLIF(li.tipo, ''))` : `NULL::varchar`;
        const sql = `
          SELECT
            c.id AS history_id,
            NULL::int AS admission_id,
            NULL::text AS summary,
            0::numeric AS total_cargos,
            0::numeric AS discount_amount,
            0::numeric AS total_pagado,
            c.created_at,
            ${latestIneTipo} AS tipo,
            c.*,
            'client_only'::text AS history_kind
          FROM hospital_clients c
          ${latestIneJoin}
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY c.created_at DESC
          LIMIT 200
        `;
        const st = await query(sql, params);
        rows.push(...(Array.isArray(st.rows) ? st.rows : []));
      }

      rows.sort((a, b) => {
        const left = a?.created_at ? new Date(a.created_at).getTime() : 0;
        const right = b?.created_at ? new Date(b.created_at).getTime() : 0;
        return right - left;
      });
      if (rows.length > 200) rows.length = 200;

      if (rows.length && (await tableExists(null, 'hospital_billing_docs'))) {
        const admissionIds = Array.from(
          new Set(
            rows
              .map((row) => Number(row.admission_id || 0))
              .filter((id) => id > 0)
          )
        );
        if (admissionIds.length) {
          const docsRes = await query(
            `SELECT id, admission_id, status, created_at, sale_id, total_charges, discount_amount, net_total
             FROM hospital_billing_docs
             WHERE admission_id = ANY($1::int[])
             ORDER BY created_at DESC, id DESC`,
            [admissionIds]
          );
          const docsByAdmission = new Map();
          for (const row of docsRes.rows || []) {
            const admissionId = Number(row.admission_id || 0);
            if (!admissionId) continue;
            if (!docsByAdmission.has(admissionId)) {
              docsByAdmission.set(admissionId, { docs: [], saleIds: new Set() });
            }
            const bucket = docsByAdmission.get(admissionId);
            bucket.docs.push({
              kind: 'billing_doc',
              id: Number(row.id || 0),
              status: String(row.status || '').trim().toLowerCase() || 'open',
              created_at: row.created_at || null,
              total:
                row.net_total != null
                  ? Number(row.net_total)
                  : Math.max(0, Number(row.total_charges || 0) - Number(row.discount_amount || 0)),
              href: `api/billing_doc_pdf?doc_id=${encodeURIComponent(Number(row.id || 0))}`,
              label: `Documento de cobro #${Number(row.id || 0)}`
            });
            const saleId = Number(row.sale_id || 0);
            if (saleId > 0 && !bucket.saleIds.has(saleId)) {
              bucket.saleIds.add(saleId);
              bucket.docs.push({
                kind: 'invoice',
                id: saleId,
                status: 'paid',
                created_at: row.created_at || null,
                href: `api/invoice_print?venta_id=${encodeURIComponent(saleId)}`,
                label: `Comprobante de alta #${saleId}`
              });
            }
          }
          rows.forEach((row) => {
            const admissionId = Number(row.admission_id || 0);
            row.documents = docsByAdmission.get(admissionId)?.docs || [];
          });
        }
      }
      rows.forEach((row) => {
        if (!Array.isArray(row.documents)) row.documents = [];
        row.history_kind = row.history_kind || (Number(row.admission_id || 0) > 0 ? 'history' : 'client_only');
      });
      return safeJson(res, { ok: true, history: rows });
    }

    if (action === 'create_client') {
      if (!canManageAdmissionPatientData(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para registrar pacientes' }, 403);
      }
      const nombre = String(request.nombre || '').trim();
      if (!nombre) return safeJson(res, { ok: false, error: 'Nombre requerido' }, 400);
      let documento = String(request.documento || '').trim().toUpperCase();
      const telefono = String(request.telefono || '').trim();
      const direccion = String(request.direccion || '').trim();
      const dob = normalizeDate(request.fecha_nacimiento);
      let esMenor = request.es_menor != null && Number(request.es_menor) ? 1 : 0;
      if (dob && isMinor(dob)) esMenor = 1;
      const docNormalized = docKey(documento);
      let encargadoNombre = String(request.encargado_nombre || '').trim();
      let encargadoDpi = String(request.encargado_dpi || '').trim().toUpperCase();
      const encNormalized = docKey(encargadoDpi);
      if (!docNormalized && !encNormalized) {
        return safeJson(res, { ok: false, error: 'Debe ingresar DPI del paciente o del acompañante' }, 400);
      }
      if (docNormalized) {
        const expr = docExpr('documento');
        const dup = await query(`SELECT id FROM hospital_clients WHERE ${expr} = $1 LIMIT 1`, [docNormalized]);
        if (dup.rows[0]) {
          return safeJson(res, { ok: false, error: 'Este paciente ya esta registrado' }, 409);
        }
      } else {
        documento = null;
      }
      if (encargadoDpi && !encNormalized) {
        return safeJson(res, { ok: false, error: 'DPI del acompañante invalido' }, 400);
      }
      if (esMenor) {
        if (!encargadoNombre || !encargadoDpi) {
          return safeJson(res, { ok: false, error: 'Menor de edad: requiere datos del encargado' }, 400);
        }
      } else {
        if (!encargadoNombre) encargadoNombre = null;
        if (!encargadoDpi) encargadoDpi = null;
      }
      const ineInput = request.ine && typeof request.ine === 'object' ? request.ine : null;
      const pendingArea = normalizeAdmissionArea(request.pending_area || request.area || request.tipo || ineInput?.tipo);
      const vitalSigns = canEditAdmissionVitalSigns(role) ? normalizeVitalSigns(request) : { touched: false, hasValue: false, payload: {} };
      if (ineInput) {
        await ensureIneSchema();
      }
      const clientId = await withTransaction(async (db) => {
        const ins = await query(
          'INSERT INTO hospital_clients (nombre, documento, telefono, direccion, es_menor, fecha_nacimiento, encargado_nombre, encargado_dpi, signos_vitales, pending_area) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
          [
            nombre,
            documento,
            telefono || null,
            direccion || null,
            esMenor,
            dob,
            encargadoNombre,
            encargadoDpi,
            vitalSigns.hasValue ? JSON.stringify(vitalSigns.payload) : null,
            pendingArea
          ],
          db
        );
        const newId = Number(ins.rows[0].id);
        if (ineInput) {
          const clean = (v) => {
            const raw = v != null ? String(v).trim() : '';
            return raw ? raw : null;
          };
          const toNumber = (v) => {
            if (v === '' || v == null) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const tipo = clean(ineInput.tipo) || 'emergencia';
          const fechaRaw = clean(ineInput.fecha) || clean(ineInput.fecha_ingreso);
          const fecha = normalizeDate(fechaRaw) || new Date().toISOString().slice(0, 10);
          const dayDate = fecha ? new Date(`${fecha}T00:00:00`) : new Date();
          let diaConsulta = clean(ineInput.dia_consulta);
          if (!diaConsulta && tipo.toLowerCase() === 'emergencia') {
            diaConsulta = weekdayES(dayDate);
          }
          let cie = clean(ineInput.cie);
          if (!cie && tipo.toLowerCase() === 'emergencia') {
            cie = 'Vivo';
          }
          let branchId = ineInput.branch_id != null ? Number(ineInput.branch_id) : null;
          if (!branchId) {
            if (tipo.toLowerCase() === 'hospitalizacion') {
              branchId = await resolveAdmissionBranchId('hospitalizacion');
            } else if (tipo.toLowerCase() === 'emergencia') {
              branchId = await resolveAdmissionBranchId('emergencia');
            }
          }
          const direccionIne = clean(ineInput.direccion) || (direccion ? direccion : null);
          await query(
            `INSERT INTO ine_reports
            (client_id, tipo, fecha, igss, dia_consulta, sexo, pueblo, edad_anios, edad_meses, direccion, municipio, consulta,
             control_materno, diagnostico, cie, tratamiento, branch_id, numero_orden, fecha_ingreso, fecha_egreso,
             traslado, condicion_egreso, especialidad, procedimiento)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [
              newId,
              tipo,
              fecha,
              clean(ineInput.igss),
              diaConsulta,
              clean(ineInput.sexo),
              clean(ineInput.pueblo),
              toNumber(ineInput.edad_anios),
              toNumber(ineInput.edad_meses),
              direccionIne,
              clean(ineInput.municipio),
              clean(ineInput.consulta),
              clean(ineInput.control_materno),
              clean(ineInput.diagnostico),
              cie,
              clean(ineInput.tratamiento),
              branchId,
              toNumber(ineInput.numero_orden),
              normalizeDate(clean(ineInput.fecha_ingreso)),
              normalizeDate(clean(ineInput.fecha_egreso)),
              clean(ineInput.traslado),
              clean(ineInput.condicion_egreso),
              clean(ineInput.especialidad),
              clean(ineInput.procedimiento)
            ],
            db
          );
        }
        return newId;
      });
      await logAction(null, userId, 'hospital_client_create', {
        client_id: clientId,
        documento,
        es_menor: esMenor
      });
      notifyHospitalRealtime({
        type: 'queue_refresh',
        reason: 'create_client',
        areas: pendingArea ? [pendingArea] : ['emergencia', 'hospitalizacion'],
        client_id: clientId
      });
      return safeJson(res, { ok: true, id: clientId });
    }

    if (action === 'update_client') {
      if (!canManageAdmissionPatientData(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para actualizar pacientes' }, 403);
      }
      const id = request.id != null ? Number(request.id) : 0;
      if (!id) return safeJson(res, { ok: false, error: 'ID requerido' }, 400);
      const cur = await query('SELECT * FROM hospital_clients WHERE id = $1', [id]);
      const row = cur.rows[0];
      if (!row) return safeJson(res, { ok: false, error: 'Paciente no encontrado' }, 404);

      const fields = [];
      const values = [];
      if (Object.prototype.hasOwnProperty.call(request, 'nombre')) {
        fields.push(`nombre = $${values.length + 1}`);
        values.push(String(request.nombre || '').trim());
      }
      if (Object.prototype.hasOwnProperty.call(request, 'telefono')) {
        fields.push(`telefono = $${values.length + 1}`);
        values.push(String(request.telefono || '').trim());
      }
      if (Object.prototype.hasOwnProperty.call(request, 'direccion')) {
        fields.push(`direccion = $${values.length + 1}`);
        values.push(String(request.direccion || '').trim());
      }

      let pendingDocUpdate = false;
      let newDocumento = null;
      if (Object.prototype.hasOwnProperty.call(request, 'documento')) {
        pendingDocUpdate = true;
        newDocumento = String(request.documento || '').trim().toUpperCase();
      }

      let finalGuardianName = row.encargado_nombre != null ? String(row.encargado_nombre).trim() : null;
      if (finalGuardianName === '') finalGuardianName = null;
      if (Object.prototype.hasOwnProperty.call(request, 'encargado_nombre')) {
        finalGuardianName = String(request.encargado_nombre || '').trim();
        finalGuardianName = finalGuardianName === '' ? null : finalGuardianName;
        fields.push(`encargado_nombre = $${values.length + 1}`);
        values.push(finalGuardianName);
      }

      let finalGuardianDpi = row.encargado_dpi != null ? String(row.encargado_dpi).trim().toUpperCase() : null;
      if (finalGuardianDpi === '') finalGuardianDpi = null;
      if (Object.prototype.hasOwnProperty.call(request, 'encargado_dpi')) {
        finalGuardianDpi = String(request.encargado_dpi || '').trim().toUpperCase();
        finalGuardianDpi = finalGuardianDpi === '' ? null : finalGuardianDpi;
        fields.push(`encargado_dpi = $${values.length + 1}`);
        values.push(finalGuardianDpi);
      }
      if (finalGuardianDpi) {
        const encKey = docKey(finalGuardianDpi);
        if (!encKey) return safeJson(res, { ok: false, error: 'DPI del acompañante invalido' }, 400);
      }

      let finalMinor = Number(row.es_menor || 0);
      let minorTouched = false;
      if (Object.prototype.hasOwnProperty.call(request, 'es_menor')) {
        finalMinor = Number(request.es_menor) ? 1 : 0;
        minorTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(request, 'fecha_nacimiento')) {
        const dob = normalizeDate(request.fecha_nacimiento);
        fields.push(`fecha_nacimiento = $${values.length + 1}`);
        values.push(dob);
        if (dob && isMinor(dob)) {
          finalMinor = 1;
          minorTouched = true;
        }
      }
      if (finalMinor) {
        if (!finalGuardianName || !finalGuardianDpi) {
          return safeJson(res, { ok: false, error: 'Menor de edad: requiere datos del encargado' }, 400);
        }
      }
      let finalDocumento = row.documento != null ? String(row.documento).trim().toUpperCase() : null;
      if (pendingDocUpdate) {
        if (!newDocumento) {
          fields.push(`documento = NULL`);
          finalDocumento = null;
        } else {
          const key = docKey(newDocumento);
          if (!key) return safeJson(res, { ok: false, error: 'DPI invalido' }, 400);
          const expr = docExpr('documento');
          const dup = await query(`SELECT id FROM hospital_clients WHERE ${expr} = $1 AND id <> $2 LIMIT 1`, [
            key,
            id
          ]);
          if (dup.rows[0]) {
            return safeJson(res, { ok: false, error: 'Este paciente ya esta registrado' }, 409);
          }
          fields.push(`documento = $${values.length + 1}`);
          values.push(newDocumento);
          finalDocumento = newDocumento;
        }
      }
      const finalDocKey = docKey(finalDocumento);
      const finalEncKey = docKey(finalGuardianDpi);
      if (!finalDocKey && !finalEncKey) {
        return safeJson(res, { ok: false, error: 'Debe ingresar DPI del paciente o del acompañante' }, 400);
      }
      if (minorTouched || finalMinor !== Number(row.es_menor || 0)) {
        fields.push(`es_menor = $${values.length + 1}`);
        values.push(finalMinor);
      }
      const vitalSigns = canEditAdmissionVitalSigns(role) ? normalizeVitalSigns(request) : { touched: false, hasValue: false, payload: {} };
      if (vitalSigns.touched) {
        fields.push(`signos_vitales = $${values.length + 1}`);
        values.push(vitalSigns.hasValue ? JSON.stringify(vitalSigns.payload) : null);
      }
      if (
        Object.prototype.hasOwnProperty.call(request, 'pending_area') ||
        Object.prototype.hasOwnProperty.call(request, 'area') ||
        Object.prototype.hasOwnProperty.call(request, 'tipo')
      ) {
        const openAdmission = await query(
          "SELECT id FROM hospital_admissions WHERE client_id = $1 AND LOWER(COALESCE(status, '')) = 'open' LIMIT 1",
          [id]
        );
        if (!openAdmission.rows[0]) {
          const nextPendingArea = normalizeAdmissionArea(request.pending_area || request.area || request.tipo);
          fields.push(`pending_area = $${values.length + 1}`);
          values.push(nextPendingArea);
        }
      }
      if (!fields.length) return safeJson(res, { ok: true, updated: false });
      values.push(id);
      const sql = `UPDATE hospital_clients SET ${fields.join(',')} WHERE id = $${values.length}`;
      await query(sql, values);
      await logAction(null, userId, 'hospital_client_update', { client_id: id });
      const updatedClient = await query('SELECT pending_area FROM hospital_clients WHERE id = $1', [id]);
      const queueAreas = Array.from(
        new Set([normalizeAdmissionArea(row.pending_area), normalizeAdmissionArea(updatedClient.rows[0]?.pending_area)].filter(Boolean))
      );
      if (queueAreas.length) {
        notifyHospitalRealtime({
          type: 'queue_refresh',
          reason: 'update_client',
          areas: queueAreas,
          client_id: id
        });
      }
      return safeJson(res, { ok: true, updated: true });
    }
    if (action === 'list_admissions') {
      const status = request.status ? String(request.status).toLowerCase() : null;
      const branchId = request.branch_id != null ? Number(request.branch_id) : null;
      const tipo = request.tipo ? String(request.tipo).toLowerCase().trim() : null;
      const params = [];
      const where = [];
      if (status) {
        where.push(`a.status = $${params.length + 1}`);
        params.push(status);
      }
      if (branchId) {
        where.push(`a.branch_id = $${params.length + 1}`);
        params.push(branchId);
      }
      if (tipo) {
        if (tipo === 'hospitalizacion') {
          where.push(`(a.tipo = $${params.length + 1} OR a.tipo IS NULL)`);
        } else {
          where.push(`a.tipo = $${params.length + 1}`);
        }
        params.push(tipo);
      }
      let sql = `
        SELECT a.*, c.nombre AS cliente_nombre, c.documento,
          (SELECT COALESCE(SUM(quantity * unit_price),0) FROM hospital_charges WHERE admission_id = a.id) AS total_charges,
          (SELECT COALESCE(SUM(CASE WHEN product_id IS NOT NULL AND product_id > 0 THEN quantity * unit_price ELSE 0 END),0)
             FROM hospital_charges WHERE admission_id = a.id) AS meds_charges,
          (SELECT COALESCE(SUM(amount),0) FROM hospital_payments WHERE admission_id = a.id) AS total_payments,
          (SELECT d.paid_at
             FROM hospital_billing_docs d
            WHERE d.admission_id = a.id AND LOWER(COALESCE(d.status,'')) = 'paid'
            ORDER BY d.paid_at DESC NULLS LAST, d.id DESC
            LIMIT 1) AS latest_paid_at,
          (SELECT d.sale_id
             FROM hospital_billing_docs d
            WHERE d.admission_id = a.id AND LOWER(COALESCE(d.status,'')) = 'paid'
            ORDER BY d.paid_at DESC NULLS LAST, d.id DESC
            LIMIT 1) AS latest_paid_sale_id
        FROM hospital_admissions a
        JOIN hospital_clients c ON c.id = a.client_id
      `;
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY a.created_at DESC';
      const st = await query(sql, params);
      const admissions = (st.rows || []).map((row) => {
        const totalCharges = Number(row.total_charges || 0);
        const medsCharges = Number(row.meds_charges || 0);
        const totalPayments = Number(row.total_payments || 0);
        const discountPercent = row.discount_percent != null ? Number(row.discount_percent) : 0;
        const storedDiscountAmount = row.discount_amount != null ? Number(row.discount_amount) : 0;
        const resolvedDiscount = resolveDiscountTotals(
          totalCharges,
          medsCharges,
          discountPercent,
          storedDiscountAmount
        );
        const balance = Number((resolvedDiscount.netCharges - totalPayments).toFixed(2));
        return {
          ...row,
          total_charges: totalCharges,
          meds_charges: medsCharges,
          total_payments: totalPayments,
          discount_amount: resolvedDiscount.discountAmount,
          net_total: resolvedDiscount.netCharges,
          balance,
          latest_paid_sale_id: row.latest_paid_sale_id != null ? Number(row.latest_paid_sale_id || 0) || null : null,
          discharge_ready:
            String(row.status || '').toLowerCase() === 'open' &&
            !!row.latest_paid_at &&
            balance <= 0.009
        };
      });
      return safeJson(res, { ok: true, admissions });
    }

    if (action === 'history_emergency') {
      const branchId = request.branch_id != null ? Number(request.branch_id) : null;
      const docFilter = request.documento || request.dpi || request.search || '';
      const key = docKey(docFilter);
      let limit = request.limit != null ? Number(request.limit) : 120;
      if (!Number.isFinite(limit) || limit <= 0) limit = 120;
      if (limit > 500) limit = 500;

      const params = [];
      const where = ["LOWER(a.tipo) = 'emergencia'", "a.status = 'closed'"];
      if (branchId) {
        where.push(`a.branch_id = $${params.length + 1}`);
        params.push(branchId);
      }
      if (key) {
        const exprDoc = docExpr('c.documento');
        const exprEnc = docExpr('c.encargado_dpi');
        const like = `%${key}%`;
        where.push(`(${exprDoc} LIKE $${params.length + 1} OR ${exprEnc} LIKE $${params.length + 2})`);
        params.push(like, like);
      }
      let sql = `
        SELECT a.id, a.created_at, a.closed_at, a.branch_id, a.discount_amount, a.discount_percent,
               c.id AS client_id, c.nombre, c.documento, c.telefono
        FROM hospital_admissions a
        JOIN hospital_clients c ON c.id = a.client_id
      `;
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY a.created_at DESC';
      sql += ` LIMIT ${limit}`;
      const st = await query(sql, params);
      const admissions = st.rows || [];
      if (!admissions.length) return safeJson(res, { ok: true, admissions: [] });

      const admissionIds = admissions.map((row) => Number(row.id)).filter((id) => id > 0);
      const chargesMap = new Map();
      const paymentsMap = new Map();
      const totalsMap = new Map();

      if (admissionIds.length) {
        const chargesRes = await query(
          'SELECT admission_id, COALESCE(SUM(quantity * unit_price),0) AS total_charges FROM hospital_charges WHERE admission_id = ANY($1) GROUP BY admission_id',
          [admissionIds]
        );
        for (const row of chargesRes.rows || []) {
          chargesMap.set(Number(row.admission_id), Number(row.total_charges || 0));
        }

        const paymentsRes = await query(
          'SELECT admission_id, id, amount, method, note, created_at, sale_id FROM hospital_payments WHERE admission_id = ANY($1) ORDER BY created_at DESC',
          [admissionIds]
        );
        for (const row of paymentsRes.rows || []) {
          const aid = Number(row.admission_id || 0);
          if (!paymentsMap.has(aid)) paymentsMap.set(aid, []);
          paymentsMap.get(aid).push({
            id: Number(row.id || 0),
            amount: Number(row.amount || 0),
            method: row.method || '',
            note: row.note || '',
            created_at: row.created_at || null,
            sale_id: row.sale_id != null ? Number(row.sale_id) : null
          });
        }

        const totalsRes = await query(
          'SELECT admission_id, COALESCE(SUM(amount),0) AS total_payments FROM hospital_payments WHERE admission_id = ANY($1) GROUP BY admission_id',
          [admissionIds]
        );
        for (const row of totalsRes.rows || []) {
          totalsMap.set(Number(row.admission_id), Number(row.total_payments || 0));
        }
      }

      const payload = admissions.map((row) => {
        const aid = Number(row.id || 0);
        return {
          ...row,
          total_charges: chargesMap.get(aid) || 0,
          total_payments: totalsMap.get(aid) || 0,
          payments: paymentsMap.get(aid) || []
        };
      });
      return safeJson(res, { ok: true, admissions: payload });
    }

    if (action === 'create_admission') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para crear admisiones' }, 403);
      }
      const clientId = request.client_id != null ? Number(request.client_id) : 0;
      const tipo = String(request.tipo || 'hospitalizacion').trim().toLowerCase();
      let branchId = request.branch_id != null ? Number(request.branch_id) : 0;
      const forcedBranchId = await resolveAdmissionBranchId(tipo);
      if (forcedBranchId) branchId = forcedBranchId;
      const roomType = String(request.room_type || '').trim().toLowerCase();
      if (!['hospitalizacion', 'emergencia'].includes(tipo)) {
        return safeJson(res, { ok: false, error: 'Tipo de admision invalido' }, 400);
      }
      if (!clientId || !branchId || (tipo === 'hospitalizacion' && !roomType)) {
        return safeJson(res, { ok: false, error: 'client_id, branch_id y room_type requeridos' }, 400);
      }
      const exists = await query('SELECT id, pending_area FROM hospital_clients WHERE id = $1', [clientId]);
      const clientRow = exists.rows[0];
      if (!clientRow) return safeJson(res, { ok: false, error: 'Cliente no encontrado' }, 404);
      const pendingArea = normalizeAdmissionArea(clientRow.pending_area);
      if (pendingArea && pendingArea !== tipo) {
        return safeJson(
          res,
          { ok: false, error: `Este paciente fue registrado para ${pendingArea}. Debe admitirse en esa área.` },
          400
        );
      }
      const config = roomConfig();
      if (tipo === 'hospitalizacion' && !config[roomType]) {
        return safeJson(res, { ok: false, error: 'Tipo de habitacion invalido' }, 400);
      }
      {
        const dup = await query('SELECT id FROM hospital_admissions WHERE status = $1 AND client_id = $2 LIMIT 1', [
          'open',
          clientId
        ]);
        if (dup.rows[0]) {
          return safeJson(res, { ok: false, error: 'Este paciente ya tiene una admision abierta' }, 400);
        }
      }
      const notes = String(request.notes || '').trim();
      const admissionResult = await withTransaction(async (db) => {
        let roomNumber = null;
        let bedNumber = null;
        let roomChargeId = null;
        if (tipo === 'hospitalizacion') {
          const slot = await findAvailableBed(db, roomType, true);
          if (!slot) {
            const err = new Error('Ya no hay cupo en esta sala');
            err.statusCode = 400;
            throw err;
          }
          roomNumber = slot.room;
          bedNumber = slot.bed;
        }
        const ins = await query(
          'INSERT INTO hospital_admissions (client_id, branch_id, room_type, room_number, bed_number, notes, tipo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [clientId, branchId, tipo === 'hospitalizacion' ? roomType : null, roomNumber, bedNumber, notes || null, tipo],
          db
        );
        const admissionId = Number(ins.rows[0].id);
        await query('UPDATE hospital_clients SET pending_area = NULL WHERE id = $1', [clientId], db);
        if (tipo === 'hospitalizacion') {
          const desc = `Habitacion ${config[roomType].label} - Sala ${roomNumber} - Cama ${bedNumber}`;
          const ch = await query(
            'INSERT INTO hospital_charges (admission_id, product_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [admissionId, null, desc, 1, config[roomType].price],
            db
          );
          roomChargeId = Number(ch.rows[0].id);
          await query(
            'UPDATE hospital_admissions SET room_charge_id = $1, room_daily_price = $2 WHERE id = $3',
            [roomChargeId, config[roomType].price, admissionId],
            db
          );
        }
        return { admissionId, roomNumber, bedNumber };
      });

      await logAction(null, userId, 'hospital_admission_create', {
        admission_id: admissionResult.admissionId,
        client_id: clientId,
        branch_id: branchId,
        room_type: roomType,
        tipo
      });
      notifyHospitalRealtime({
        type: 'admission_refresh',
        reason: 'create_admission',
        areas: [tipo],
        client_id: clientId,
        admission_id: admissionResult.admissionId
      });
      return safeJson(res, {
        ok: true,
        id: admissionResult.admissionId,
        tipo,
        room_type: roomType,
        room_number: admissionResult.roomNumber,
        bed_number: admissionResult.bedNumber
      });
    }

    if (action === 'get_admission') {
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [
        admission.client_id
      ]);
      const client = clientRes.rows[0] || null;
      const chargesRes = await query(
        'SELECT id, product_id, product_type, description, quantity, unit_price, presentation_type, stock_quantity, protected_after_transfer, created_at FROM hospital_charges WHERE admission_id = $1 ORDER BY created_at DESC',
        [admissionId]
      );
      const paymentsRes = await query(
        'SELECT id, amount, method, note, created_at FROM hospital_payments WHERE admission_id = $1 ORDER BY created_at DESC',
        [admissionId]
      );
        const totals = await admissionTotals(null, admissionId);
        const totalCharges = totals.totalCharges;
        const totalPayments = totals.totalPayments;
        const medsCharges = totals.medsCharges;
        const discountPercent = admission.discount_percent != null ? Number(admission.discount_percent) : 0;
        const resolvedDiscount = resolveDiscountTotals(
          totalCharges,
          medsCharges,
          discountPercent,
          admission.discount_amount != null ? Number(admission.discount_amount) : 0
        );
        const discountAmount = resolvedDiscount.discountAmount;
        const netCharges = resolvedDiscount.netCharges;
        const balance = netCharges - totalPayments;
      return safeJson(res, {
        ok: true,
        admission,
        client,
        charges: chargesRes.rows,
        payments: paymentsRes.rows,
        totals: {
          charges: totalCharges,
          payments: totalPayments,
          discount: discountAmount,
          net: netCharges,
          balance
        }
      });
    }

    if (action === 'open_admission_session' || action === 'keep_admission_session') {
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const claim = await claimAdmissionSession(admissionId, sessionActor);
      if (!claim.ok) {
        return safeJson(res, admissionSessionConflictPayload(claim.session), 409);
      }
      return safeJson(res, { ok: true, session: claim.session });
    }

    if (action === 'close_admission_session') {
      const admissionId =
        request.admission_id != null
          ? Number(request.admission_id)
          : req.query.admission_id != null
          ? Number(req.query.admission_id)
          : 0;
      if (!admissionId) return safeJson(res, { ok: true });
      await releaseAdmissionSession(admissionId, sessionActor);
      return safeJson(res, { ok: true });
    }

    if (action === 'create_billing_doc') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para generar documentos de cobro' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const sessionClaim = await claimAdmissionSession(admissionId, sessionActor);
      if (!sessionClaim.ok) {
        return safeJson(res, admissionSessionConflictPayload(sessionClaim.session), 409);
      }
      const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [admission.client_id]);
      const client = clientRes.rows[0] || {};
      const customerIdentity = resolveBillingCustomerIdentity({
        type:
          request.customer_doc_type ??
          request.customer_type ??
          request.cliente_tipo ??
          request.tipo_cliente,
        value:
          request.customer_doc_value ??
          request.customer_document ??
          request.cliente_documento ??
          request.cliente_doc,
        clientDocument: client.documento || ''
      });
        const totals = await admissionTotals(null, admissionId);
        const discountPercent = admission.discount_percent != null ? Number(admission.discount_percent) : 0;
        const resolvedDiscount = resolveDiscountTotals(
          totals.totalCharges,
          totals.medsCharges,
          discountPercent,
          admission.discount_amount != null ? Number(admission.discount_amount) : 0
        );
        const discountAmount = resolvedDiscount.discountAmount;
        const netCharges = resolvedDiscount.netCharges;
      const balance = Number((netCharges - totals.totalPayments).toFixed(2));
      if (balance <= 0) {
        return safeJson(res, { ok: false, error: 'No hay saldo pendiente para generar documento' }, 400);
      }

      const existing = await query(
        "SELECT * FROM hospital_billing_docs WHERE admission_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1",
        [admissionId]
      );
      if (existing.rows[0]) {
        let currentDoc = existing.rows[0];
        const nextType = customerIdentity.type || normalizeBillingCustomerDocType(currentDoc.customer_doc_type);
        const nextValue =
          customerIdentity.value || normalizeBillingCustomerDocValue(currentDoc.customer_doc_value);
        if (
          normalizeBillingCustomerDocType(currentDoc.customer_doc_type) !== nextType ||
          normalizeBillingCustomerDocValue(currentDoc.customer_doc_value) !== nextValue
        ) {
          const upd = await query(
            `UPDATE hospital_billing_docs
             SET customer_doc_type = $1, customer_doc_value = $2
             WHERE id = $3
             RETURNING *`,
            [nextType || null, nextValue || null, currentDoc.id]
          );
          currentDoc = upd.rows[0] || { ...currentDoc, customer_doc_type: nextType, customer_doc_value: nextValue };
        }
        return safeJson(res, {
          ok: true,
          doc: currentDoc,
          totals: { charges: totals.totalCharges, discount: discountAmount, net: netCharges, balance }
        });
      }

      const tipo = String(admission.tipo || 'hospitalizacion').toLowerCase();
      const ins = await query(
        `INSERT INTO hospital_billing_docs
          (admission_id, tipo, customer_doc_type, customer_doc_value, total_charges, discount_percent, discount_amount, net_total, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)
         RETURNING id`,
        [
          admissionId,
          tipo,
          customerIdentity.type || null,
          customerIdentity.value || null,
          totals.totalCharges,
          discountPercent,
          discountAmount,
          netCharges,
          userId || null
        ]
      );
      return safeJson(res, {
        ok: true,
        doc_id: Number(ins.rows[0].id),
        totals: { charges: totals.totalCharges, discount: discountAmount, net: netCharges, balance }
      });
    }

    if (action === 'charge_account') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para cobrar la cuenta' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const method = String(request.method || 'efectivo').trim() || 'efectivo';
      const note = String(request.note || '').trim();
      const discountPercent = request.discount_percent != null ? Number(request.discount_percent) : 0;
      if (discountPercent < 0 || discountPercent > 100) {
        return safeJson(res, { ok: false, error: 'Porcentaje de descuento invalido' }, 400);
      }
        const totals = await admissionTotals(null, admissionId);
        const totalCharges = totals.totalCharges;
        if (totalCharges <= 0) {
          return safeJson(res, { ok: false, error: 'No existen cargos para esta admision' }, 400);
        }
        const resolvedDiscount = resolveDiscountTotals(totalCharges, totals.medsCharges, discountPercent, 0);
        const discountAmount = resolvedDiscount.discountAmount;
        const netCharges = resolvedDiscount.netCharges;

      await withTransaction(async (db) => {
        await query('DELETE FROM hospital_payments WHERE admission_id = $1', [admissionId], db);
        if (netCharges > 0) {
          await query(
            'INSERT INTO hospital_payments (admission_id, amount, method, note, user_id) VALUES ($1,$2,$3,$4,$5)',
            [admissionId, netCharges, method, note || null, userId],
            db
          );
        }
        await query(
          'UPDATE hospital_admissions SET discount_percent = $1, discount_amount = $2 WHERE id = $3',
          [discountPercent, discountAmount, admissionId],
          db
        );
      });
      await logAction(null, userId, 'hospital_charge_account', {
        admission_id: admissionId,
        method,
        discount_percent: discountPercent,
        net: netCharges
      });
      return safeJson(res, {
        ok: true,
        totals: {
          charges: totalCharges,
          discount: discountAmount,
          net: netCharges
        }
      });
    }

    if (action === 'add_charge') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para agregar cargos' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const sessionClaim = await claimAdmissionSession(admissionId, sessionActor);
      if (!sessionClaim.ok) {
        return safeJson(res, admissionSessionConflictPayload(sessionClaim.session), 409);
      }
      const qty = Number(request.quantity || 0);
      if (qty <= 0) return safeJson(res, { ok: false, error: 'Cantidad invalida' }, 400);
      const requestedPresentation = normalizePresentationType(request.presentation_type, 'unidad');
      const branchId = admission.branch_id != null ? Number(admission.branch_id) : null;
      let productId = request.product_id != null ? Number(request.product_id) : null;
      if (!Number.isFinite(productId) || productId <= 0) productId = null;
      let description = String(request.description || '').trim();
      let unitPrice = request.unit_price != null ? Number(request.unit_price) : null;
      let stockQuantity = null;
      let presentationType = productId ? requestedPresentation : null;
      let productType = normalizeProductType(request.charge_product_type || (productId ? 'medicamento' : 'servicio'));

      if (productId) {
        const prodRes = await query(
          "SELECT nombre_comercial, COALESCE(tipo, 'medicamento') AS tipo, precio_publico, unidades_por_tableta, tabletas_por_caja, precio_unidad, precio_tableta FROM productos WHERE id = $1",
          [productId]
        );
        const prod = prodRes.rows[0];
        if (!prod) return safeJson(res, { ok: false, error: 'Producto no encontrado' }, 404);
        productType = normalizeProductType(prod.tipo);
        if (!description) description = prod.nombre_comercial;
        if (productTypeUsesInventory(productType)) {
          let lotPrice = null;
          if (branchId && (await tableExists(null, 'lots')) && (await columnExists(null, 'lots', 'sale_price'))) {
            const lotPriceRes = await query(
              `SELECT COALESCE(sale_price, $3) AS price
               FROM lots
               WHERE product_id = $1 AND branch_id = $2 AND quantity > 0 AND expiry_date >= CURRENT_DATE
               ORDER BY expiry_date ASC, created_at ASC, id ASC
               LIMIT 1`,
              [productId, branchId, Number(prod.precio_publico || 0)]
            );
            lotPrice = lotPriceRes.rows[0] ? Number(lotPriceRes.rows[0].price || 0) : null;
          }
          const presentationConfig = resolvePresentationConfig(prod, { boxPriceOverride: lotPrice });
          stockQuantity = roundMoney(qty * getPresentationFactor(presentationConfig, presentationType));
          if (unitPrice == null || Number.isNaN(unitPrice)) {
            unitPrice = getPresentationPrice(prod, presentationType, { boxPriceOverride: lotPrice });
          }
        } else {
          presentationType = null;
          stockQuantity = null;
          if (unitPrice == null || Number.isNaN(unitPrice)) {
            unitPrice = Number(prod.precio_publico || 0);
          }
        }
      } else {
        productType = 'servicio';
        presentationType = null;
        stockQuantity = null;
      }
      if (!description) return safeJson(res, { ok: false, error: 'Descripcion requerida' }, 400);
      if (unitPrice == null || unitPrice < 0) {
        return safeJson(res, { ok: false, error: 'Precio invalido' }, 400);
      }

      await withTransaction(async (db) => {
        await ensureHospitalChargeStockMovesTable(db);
        const chargeInsertRes = await query(
          'INSERT INTO hospital_charges (admission_id, product_id, product_type, description, quantity, unit_price, presentation_type, stock_quantity, protected_after_transfer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
          [
            admissionId,
            productId,
            productType,
            description,
            qty,
            unitPrice,
            productTypeUsesInventory(productType) ? presentationType : null,
            productTypeUsesInventory(productType) ? stockQuantity : null,
            false
          ],
          db
        );
        const chargeId = Number(chargeInsertRes.rows[0]?.id || 0);
        if (productId && branchId) {
          if (productTypeUsesInventory(productType)) {
            await consumeHospitalChargeInventory(db, {
              chargeId,
              productId,
              branchId,
              quantity: stockQuantity,
              userId,
              productLabel: description
            });
          } else if (productTypeIsCombo(productType)) {
            await consumeHospitalChargeComboInventory(db, {
              chargeId,
              comboProductId: productId,
              branchId,
              quantity: qty,
              userId,
              comboLabel: description
            });
          }
        }
        await syncOpenBillingDocsForAdmission(db, admission);
      });
      await logAction(null, userId, 'hospital_charge_add', {
        admission_id: admissionId,
        product_id: productId,
        product_type: productType,
        description,
        quantity: qty,
        presentation_type: presentationType,
        stock_quantity: stockQuantity
      });
      return safeJson(res, { ok: true });
    }

    if (action === 'delete_charge') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para modificar cargos' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      const chargeId = request.charge_id != null ? Number(request.charge_id) : 0;
      if (!admissionId || !chargeId) {
        return safeJson(res, { ok: false, error: 'admission_id y charge_id requeridos' }, 400);
      }
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const sessionClaim = await claimAdmissionSession(admissionId, sessionActor);
      if (!sessionClaim.ok) {
        return safeJson(res, admissionSessionConflictPayload(sessionClaim.session), 409);
      }
      const branchId = admission.branch_id != null ? Number(admission.branch_id) : null;

      const removedCharge = await withTransaction(async (db) => {
        const currentAdmission = await fetchAdmission(db, admissionId);
        const chargeRes = await query(
          `SELECT id, admission_id, product_id, product_type, description, quantity, unit_price, presentation_type, stock_quantity, protected_after_transfer
             FROM hospital_charges
            WHERE id = $1 AND admission_id = $2
            FOR UPDATE`,
          [chargeId, admissionId],
          db
        );
        const chargeRow = chargeRes.rows[0];
        if (!chargeRow) {
          const err = new Error('Cargo no encontrado');
          err.statusCode = 404;
          throw err;
        }
        if (currentAdmission.room_charge_id != null && Number(currentAdmission.room_charge_id) === chargeId) {
          const err = new Error('El cargo de habitación no se puede eliminar manualmente');
          err.statusCode = 400;
          throw err;
        }
        if (currentAdmission.tipo === 'hospitalizacion' && Boolean(chargeRow.protected_after_transfer)) {
          const err = new Error(
            'Este cargo fue agregado en Emergencia antes del traslado y ya no se puede eliminar en Hospitalización'
          );
          err.statusCode = 400;
          throw err;
        }

        const productId = chargeRow.product_id != null ? Number(chargeRow.product_id) : null;
        const productType = normalizeProductType(chargeRow.product_type || (productId ? 'medicamento' : 'servicio'));
        const qty = Number(chargeRow.quantity || 0);
        const stockQty = Number(chargeRow.stock_quantity || chargeRow.quantity || 0);
        await query('DELETE FROM hospital_charges WHERE id = $1 AND admission_id = $2', [chargeId, admissionId], db);

        if (productId && branchId) {
          const restoredMoves = await restoreHospitalChargeStockMoves(db, chargeId, branchId, userId);
          if (!restoredMoves.size) {
            if (productTypeUsesInventory(productType) && stockQty > 0) {
              await restoreHospitalChargeStock(db, productId, branchId, stockQty, userId);
            } else if (productTypeIsCombo(productType) && qty > 0) {
              const comboComponentsMap = await fetchComboComponents(db, [productId]);
              const components = comboComponentsMap.get(productId) || [];
              for (const component of components) {
                const componentProductId = Number(component.component_product_id || 0);
                const componentType = normalizeProductType(component.tipo);
                if (!componentProductId || !productTypeUsesInventory(componentType)) continue;
                await restoreHospitalChargeStock(
                  db,
                  componentProductId,
                  branchId,
                  Number(component.quantity || 0) * qty,
                  userId
                );
              }
            }
          }
        }
        await syncOpenBillingDocsForAdmission(db, currentAdmission);

        return {
          chargeId,
          productId,
          productType,
          quantity: qty,
          stockQuantity: stockQty,
          presentationType: productId ? normalizePresentationType(chargeRow.presentation_type, 'unidad') : null,
          description: String(chargeRow.description || '').trim(),
          unitPrice: Number(chargeRow.unit_price || 0)
        };
      });

      await logAction(null, userId, 'hospital_charge_delete', {
        admission_id: admissionId,
        charge_id: chargeId,
        product_id: removedCharge.productId,
        product_type: removedCharge.productType,
        description: removedCharge.description,
        quantity: removedCharge.quantity,
        stock_quantity: removedCharge.stockQuantity,
        presentation_type: removedCharge.presentationType,
        unit_price: removedCharge.unitPrice
      });
      return safeJson(res, { ok: true });
    }

    if (action === 'add_payment') {
      return safeJson(res, { ok: false, error: 'Funcion no disponible' }, 400);
    }

    if (action === 'transfer_to_hospital') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para trasladar la cuenta' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      const roomType = String(request.room_type || '').trim().toLowerCase();
      let branchId = request.branch_id != null ? Number(request.branch_id) : 0;
      const forcedBranchId = await resolveAdmissionBranchId('hospitalizacion');
      if (forcedBranchId) branchId = forcedBranchId;
      const note = String(request.note || '').trim();
      if (!admissionId || !roomType || !branchId) {
        return safeJson(res, { ok: false, error: 'admission_id, room_type y branch_id requeridos' }, 400);
      }
      const admission = await fetchAdmission(null, admissionId);
      const tipo = String(admission.tipo || 'hospitalizacion').toLowerCase();
      if (tipo !== 'emergencia') {
        return safeJson(res, { ok: false, error: 'Solo se puede trasladar admisiones de emergencia' }, 400);
      }
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const sessionClaim = await claimAdmissionSession(admissionId, sessionActor);
      if (!sessionClaim.ok) {
        return safeJson(res, admissionSessionConflictPayload(sessionClaim.session), 409);
      }
      const config = roomConfig();
      if (!config[roomType]) {
        return safeJson(res, { ok: false, error: 'Tipo de habitacion invalido' }, 400);
      }

      const transfer = await withTransaction(async (db) => {
        const slot = await findAvailableBed(db, roomType, true);
        if (!slot) {
          const err = new Error('Ya no hay cupo en esta sala');
          err.statusCode = 400;
          throw err;
        }
        const currentAdmissionRes = await query('SELECT * FROM hospital_admissions WHERE id = $1 FOR UPDATE', [admissionId], db);
        const currentAdmission = currentAdmissionRes.rows[0];
        if (!currentAdmission) {
          const err = new Error('Admision no encontrada');
          err.statusCode = 404;
          throw err;
        }
        const existingNotes = String(currentAdmission.notes || '').trim();
        const transferNote = [`Traslado a Hospitalización`, note || null].filter(Boolean).join(' | ');
        const nextNotes = [existingNotes, transferNote].filter(Boolean).join(' | ');
        await query(
          'UPDATE hospital_charges SET protected_after_transfer = TRUE WHERE admission_id = $1 AND COALESCE(protected_after_transfer, FALSE) = FALSE',
          [admissionId],
          db
        );
        await query(
          `UPDATE hospital_admissions
              SET branch_id = $1,
                  room_type = $2,
                  room_number = $3,
                  bed_number = $4,
                  notes = $5,
                  tipo = 'hospitalizacion'
            WHERE id = $6`,
          [branchId, roomType, slot.room, slot.bed, nextNotes || null, admissionId],
          db
        );
        await query('UPDATE hospital_clients SET pending_area = NULL WHERE id = $1', [Number(currentAdmission.client_id || 0)], db);
        const desc = `Habitacion ${config[roomType].label} - Sala ${slot.room} - Cama ${slot.bed}`;
        const ch = await query(
          'INSERT INTO hospital_charges (admission_id, product_id, description, quantity, unit_price, protected_after_transfer) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [admissionId, null, desc, 1, config[roomType].price, false],
          db
        );
        const roomChargeId = Number(ch.rows[0].id);
        await query(
          'UPDATE hospital_admissions SET room_charge_id = $1, room_daily_price = $2 WHERE id = $3',
          [roomChargeId, config[roomType].price, admissionId],
          db
        );
        await query(
          "UPDATE hospital_billing_docs SET tipo = 'hospitalizacion' WHERE admission_id = $1 AND status = 'open'",
          [admissionId],
          db
        );
        const updatedAdmission = await fetchAdmission(db, admissionId);
        await syncOpenBillingDocsForAdmission(db, updatedAdmission);
        return { admissionId, roomNumber: slot.room, bedNumber: slot.bed };
      });

      await logAction(null, userId, 'hospital_transfer_from_emergency', {
        from_admission: admissionId,
        to_admission: transfer.admissionId,
        room_type: roomType,
        branch_id: branchId
      });
      notifyHospitalRealtime({
        type: 'admission_refresh',
        reason: 'transfer_to_hospital',
        areas: ['emergencia', 'hospitalizacion'],
        client_id: Number(admission.client_id || 0) || null,
        admission_id: transfer.admissionId
      });
      await releaseAdmissionSession(admissionId, sessionActor);
      return safeJson(res, {
        ok: true,
        admission_id: transfer.admissionId,
        room_type: roomType,
        room_number: transfer.roomNumber,
        bed_number: transfer.bedNumber
      });
    }

    if (action === 'discharge') {
      if (!canManageAdmissionBilling(role)) {
        return safeJson(res, { ok: false, error: 'Permiso denegado para dar de alta' }, 403);
      }
      const admissionId = request.admission_id != null ? Number(request.admission_id) : 0;
      if (!admissionId) return safeJson(res, { ok: false, error: 'admission_id requerido' }, 400);
      const admission = await fetchAdmission(null, admissionId);
      if (admission.status !== 'open') {
        return safeJson(res, { ok: false, error: 'La admision ya esta cerrada' }, 400);
      }
      const sessionClaim = await claimAdmissionSession(admissionId, sessionActor);
      if (!sessionClaim.ok) {
        return safeJson(res, admissionSessionConflictPayload(sessionClaim.session), 409);
      }
      const branchId = admission.branch_id != null ? Number(admission.branch_id) : null;

      const result = await withTransaction(async (db) => {
        const paidDocRes = await query(
          `SELECT id, sale_id, paid_at, net_total
             FROM hospital_billing_docs
            WHERE admission_id = $1 AND LOWER(COALESCE(status,'')) = 'paid'
            ORDER BY paid_at DESC NULLS LAST, id DESC
            LIMIT 1`,
          [admissionId],
          db
        );
        const paidDoc = paidDocRes.rows[0] || null;
        const roomChargeId = admission.room_charge_id != null ? Number(admission.room_charge_id) : 0;
        if (roomChargeId > 0 && !paidDoc) {
          let roomPrice = admission.room_daily_price != null ? Number(admission.room_daily_price) : null;
          if (roomPrice == null && admission.room_type) {
            const cfg = roomConfig();
            if (cfg[admission.room_type]?.price != null) {
              roomPrice = Number(cfg[admission.room_type].price);
            }
          }
          if (roomPrice == null) roomPrice = 0;
          const createdAt = admission.created_at ? new Date(admission.created_at) : new Date();
          const days = Math.max(1, Math.ceil((Date.now() - createdAt.getTime()) / 86400000));
          await query(
            'UPDATE hospital_charges SET quantity = $1, unit_price = $2 WHERE id = $3',
            [days, roomPrice, roomChargeId],
            db
          );
        }

          const totals = await admissionTotals(db, admissionId);
          const totalCharges = totals.totalCharges;
          let discountPercent = admission.discount_percent != null ? Number(admission.discount_percent) : 0;
          const resolvedDiscount = resolveDiscountTotals(
            totalCharges,
            totals.medsCharges,
            discountPercent,
            admission.discount_amount != null ? Number(admission.discount_amount) : 0
          );
          const discountAmount = resolvedDiscount.discountAmount;
          const netCharges = resolvedDiscount.netCharges;

        const paymentsRes = await query(
          'SELECT * FROM hospital_payments WHERE admission_id = $1 ORDER BY created_at ASC',
          [admissionId],
          db
        );
        const payments = paymentsRes.rows || [];
        const totalPayments = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
        const paidDocNetTotal = paidDoc?.net_total != null ? Number(paidDoc.net_total || 0) : 0;
        const effectivePayments = Math.max(totalPayments, paidDocNetTotal);
        const pendingBalance = Number((netCharges - effectivePayments).toFixed(2));

        if (pendingBalance > 0.01) {
          const err = new Error('Aun hay saldo pendiente. Use el boton Cobrar antes de dar de alta.');
          err.statusCode = 400;
          throw err;
        }

        const chargesRes = await query(
          'SELECT product_id, product_type, description, quantity, unit_price FROM hospital_charges WHERE admission_id = $1 ORDER BY created_at ASC',
          [admissionId],
          db
        );
        const charges = chargesRes.rows || [];
        const serviceDetails = serviceDetailsFromCharges(charges);

        const existingPaymentSale = payments.find((p) => p.sale_id);
        let saleId = existingPaymentSale ? Number(existingPaymentSale.sale_id) : null;
        if (!saleId && paidDoc?.sale_id != null) {
          saleId = Number(paidDoc.sale_id || 0) || null;
        }
        let processed = effectivePayments;
        let createdSale = false;
        let saleCajaId = null;

        if (!saleId && netCharges > 0) {
          const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
          const saleItemsTable = await pickTable(db, ['venta_items', 'sale_items', 'detalle_venta', 'detalle_ventas'], 'venta_items');
          const salesDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], null);
          const salesTotalCol = await pickColumn(db, salesTable, ['total', 'monto_total', 'importe_total'], 'total');
          const salesUserCol = await pickColumn(db, salesTable, ['usuario_id', 'user_id', 'cajero_id'], null);
          const salesBranchCol = await pickColumn(db, salesTable, ['branch_id', 'sucursal_id'], null);
          const salesNoteCol = await pickColumn(db, salesTable, ['note', 'nota', 'observacion'], null);
          const salesCajaCol = await pickColumn(db, salesTable, ['caja_id', 'cashbox_id'], null);

          const fields = [];
          const values = [];
          if (salesDateCol) {
            fields.push(quoteIdent(salesDateCol));
            values.push(new Date());
          }
          if (salesUserCol && userId) {
            fields.push(quoteIdent(salesUserCol));
            values.push(userId);
          }
          if (salesBranchCol && branchId) {
            fields.push(quoteIdent(salesBranchCol));
            values.push(branchId);
          }
          if (salesTotalCol) {
            fields.push(quoteIdent(salesTotalCol));
            values.push(netCharges);
          }
          if (salesNoteCol) {
            let note = `Hospitalizacion Adm #${admissionId}`;
            if (discountAmount > 0) {
              note += ` | Descuento ${discountPercent.toFixed(2)}% Q${discountAmount.toFixed(2)}`;
            }
            fields.push(quoteIdent(salesNoteCol));
            values.push(note);
          }
          if (salesCajaCol) {
            saleCajaId = await findOpenCajaId(db, userId, branchId);
            if (!saleCajaId) {
              saleCajaId = await findOpenCajaId(db, userId, null);
            }
            if (!saleCajaId) {
              const err = new Error('No hay caja abierta. Abra la caja antes de cerrar la admisión.');
              err.statusCode = 400;
              throw err;
            }
            fields.push(quoteIdent(salesCajaCol));
            values.push(saleCajaId);
          }
          if (!fields.length) {
            const err = new Error('No se pudo registrar la venta (estructura desconocida)');
            err.statusCode = 500;
            throw err;
          }

          const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
          const saleIns = await query(
            `INSERT INTO ${quoteIdent(salesTable)} (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`,
            values,
            db
          );
          saleId = Number(saleIns.rows[0].id);
          createdSale = true;
          if (saleCajaId) {
            await bumpCajaTotal(db, saleCajaId, netCharges);
          }

          if (await tableExists(db, saleItemsTable)) {
            const siCols = await getColumns(db, saleItemsTable);
            const siSaleIdCol = siCols.includes('sale_id') ? 'sale_id' : siCols.includes('venta_id') ? 'venta_id' : null;
            const siProdIdCol = siCols.includes('producto_id') ? 'producto_id' : siCols.includes('product_id') ? 'product_id' : null;
            const siQtyCol = siCols.includes('cantidad') ? 'cantidad' : siCols.includes('qty') ? 'qty' : null;
            const siUnitCol = siCols.includes('precio_unit')
              ? 'precio_unit'
              : siCols.includes('unit_price')
              ? 'unit_price'
              : null;
            const siSubCol = siCols.includes('subtotal')
              ? 'subtotal'
              : siCols.includes('importe')
              ? 'importe'
              : siCols.includes('total_linea')
              ? 'total_linea'
              : null;

            if (siSaleIdCol && siProdIdCol && siQtyCol && siUnitCol) {
              const grouped = new Map();
              for (const ch of charges) {
                const pid = Number(ch.product_id || 0);
                if (!pid) continue;
                const chargeType = normalizeProductType(ch.product_type || ch.tipo || 'medicamento');
                if (chargeType === 'servicio') continue;
                const unit = Number(ch.unit_price || 0);
                const qty = Number(ch.quantity || 0);
                const key = `${pid}|${unit}`;
                if (!grouped.has(key)) {
                  grouped.set(key, { product_id: pid, unit_price: unit, qty: 0 });
                }
                grouped.get(key).qty += qty;
              }
              for (const item of grouped.values()) {
                const cols = [siSaleIdCol, siProdIdCol, siQtyCol, siUnitCol].map(quoteIdent);
                const vals = [saleId, item.product_id, item.qty, item.unit_price];
                if (siSubCol) {
                  cols.push(quoteIdent(siSubCol));
                  vals.push(item.qty * item.unit_price);
                }
                const ph = vals.map((_, idx) => `$${idx + 1}`).join(',');
                await query(`INSERT INTO ${quoteIdent(saleItemsTable)} (${cols.join(',')}) VALUES (${ph})`, vals, db);
              }
            }
          }

          const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
          if (await tableExists(db, paymentsTable)) {
            const payCols = await getColumns(db, paymentsTable);
            const payHasCreated = payCols.includes('created_at');
            for (const hp of payments) {
              if (hp.sale_id) continue;
              const method = hp.method || 'efectivo';
              const originType = String(admission.tipo || 'hospitalizacion').toLowerCase();
              const detailPayload = {
                origen: originType === 'emergencia' ? 'emergencia' : 'hospital',
                admission_id: admissionId,
                nota: hp.note || '',
                discount_percent: discountPercent,
                discount_amount: discountAmount,
                tipo: originType,
                services: serviceDetails
              };
              const cols = [
                'sale_id',
                'purchase_id',
                'branch_id',
                'user_id',
                'amount',
                'payment_type',
                'payment_method_details',
                'is_credit'
              ];
              const vals = [
                saleId,
                null,
                branchId,
                userId,
                hp.amount,
                method,
                JSON.stringify(detailPayload),
                0
              ];
              if (payHasCreated) {
                cols.push('created_at');
                vals.push(hp.created_at || new Date());
              }
              const ph = vals.map((_, idx) => `$${idx + 1}`).join(',');
              await query(
                `INSERT INTO ${quoteIdent(paymentsTable)} (${cols.map(quoteIdent).join(',')}) VALUES (${ph})`,
                vals,
                db
              );
              await query('UPDATE hospital_payments SET sale_id = $1 WHERE id = $2', [saleId, hp.id], db);
            }
          }
        }

        if (Number((netCharges - processed).toFixed(2)) > 0.01) {
          throw new Error('Existen saldos pendientes, no se puede cerrar la admision');
        }

        await query('UPDATE hospital_admissions SET status = $1, closed_at = NOW() WHERE id = $2', [
          'closed',
          admissionId
        ], db);
        await query('UPDATE hospital_clients SET pending_area = NULL WHERE id = $1', [Number(admission.client_id || 0)], db);

        if (await tableExists(db, 'hospital_history')) {
          const payload = {
            room_type: admission.room_type,
            room_number: admission.room_number,
            notes: admission.notes,
            charges,
            payments: payments.map((hp) => ({
              amount: Number(hp.amount || 0),
              method: hp.method || '',
              note: hp.note || '',
              created_at: hp.created_at || null
            }))
          };
          await query(
            'INSERT INTO hospital_history (client_id, admission_id, summary, total_cargos, discount_amount, total_pagado) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              admission.client_id,
              admissionId,
              JSON.stringify(payload),
              totalCharges,
              discountAmount,
              processed
            ],
            db
          );
        }

        if (saleId && createdSale) {
          try {
            const method = payments[0]?.method || 'efectivo';
            await autoEntryForSale(
              db,
              saleId,
              netCharges,
              branchId,
              method,
              'contado',
              userId,
              new Date().toISOString().slice(0, 10)
            );
          } catch (_) {}
        }

        return {
          saleId,
          totalCharges,
          discountAmount,
          processed,
          pending: Math.max(0, netCharges - processed)
        };
      });

      await logAction(null, userId, 'hospital_admission_close', {
        admission_id: admissionId,
        sale_id: result.saleId,
        total: result.totalCharges,
        pagado: result.processed
      });
      notifyHospitalRealtime({
        type: 'admission_refresh',
        reason: 'discharge',
        areas: [normalizeAdmissionArea(admission.tipo) || 'hospitalizacion'],
        client_id: Number(admission.client_id || 0) || null,
        admission_id: admissionId
      });
      await releaseAdmissionSession(admissionId, sessionActor);
      const fel = result.saleId
        ? await certifySaleIfEnabled(null, result.saleId, {
            userId,
            source: 'hospital_admission_close'
          }).catch((err) => ({
            ok: false,
            status: 'failed',
            error: err?.message || 'Error FEL'
          }))
        : { ok: true, status: 'not_applicable' };
      return safeJson(res, {
        ok: true,
        sale_id: result.saleId,
        total_cargos: result.totalCharges,
        descuento: result.discountAmount,
        total_pagado: result.processed,
        pendiente: result.pending,
        fel
      });
    }

    return safeJson(res, { ok: false, error: 'Accion no soportada' }, 400);
  })
);

router.get(
  '/billing_doc_pdf',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'cashierh', 'hospital', 'cashiee', 'cashier', 'farmacia', 'enfermeria', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureHospitalSchema();

    const docId = Number(req.query.doc_id || req.query.id || 0);
    if (!docId) return res.type('text/plain').send('ID invalido');
    const docRes = await query(
      `SELECT d.*, u.username AS created_by_name
       FROM hospital_billing_docs d
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.id = $1`,
      [docId]
    );
    const docRow = docRes.rows[0];
    if (!docRow) return res.type('text/plain').send('Documento no encontrado');

    const admission = await fetchAdmission(null, docRow.admission_id);
    const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [
      admission.client_id
    ]);
    const client = clientRes.rows[0] || {};
    const customerIdentity = resolveBillingCustomerIdentity({
      type: docRow.customer_doc_type,
      value: docRow.customer_doc_value,
      clientDocument: client.documento || ''
    });
    const tipo = String(docRow.tipo || admission.tipo || 'hospitalizacion').toLowerCase();
    const tipoLabel = tipo === 'emergencia' ? 'Emergencia' : 'Hospitalización';
    const totalCharges = docRow.total_charges != null ? Number(docRow.total_charges) : 0;
    const discountAmount = docRow.discount_amount != null ? Number(docRow.discount_amount) : 0;
    const netTotal =
      docRow.net_total != null ? Number(docRow.net_total) : Math.max(0, totalCharges - discountAmount);
    const createdAt = docRow.created_at || new Date();
    const createdBy = String(docRow.created_by_name || req.session?.user?.username || '--').trim() || '--';
      const serviceLabel = billingDocAreaLabel(tipo);
    const html = renderBillingDocPageHtml({
      title: 'Documento de Cobro',
      subtitle: 'Documento de cobro emitido',
      docId,
      clientName: client.nombre || '--',
      clientDocumentType: customerIdentity.type,
      clientDocument: customerIdentity.value,
      createdAt: formatDateES(createdAt),
      createdBy,
      tipoLabel,
      admissionId: admission.id,
      detailRows: [
        {
          label: serviceLabel,
          meta: 'Documento para caja',
          amount: totalCharges
        }
      ],
      totals: [
        { label: 'Total cargos', amount: totalCharges },
        ...(discountAmount > 0 ? [{ label: 'Descuento', amount: discountAmount }] : []),
        { label: 'Total a pagar', amount: netTotal, grand: true }
      ],
      footerMessage: 'Presentar este documento en Caja.'
    });
    res.type('text/html').send(html);
  })
);

router.get(
  '/billing_doc_detail_pdf',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'cashierh', 'hospital', 'cashiee', 'cashier', 'farmacia', 'enfermeria', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureHospitalSchema();

    const docId = Number(req.query.doc_id || req.query.id || 0);
    if (!docId) return res.type('text/plain').send('ID invalido');
    const docRes = await query(
      `SELECT d.*, u.username AS created_by_name
       FROM hospital_billing_docs d
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.id = $1`,
      [docId]
    );
    const docRow = docRes.rows[0];
    if (!docRow) return res.type('text/plain').send('Documento no encontrado');

    const admission = await fetchAdmission(null, docRow.admission_id);
    const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [
      admission.client_id
    ]);
    const client = clientRes.rows[0] || {};
    const customerIdentity = resolveBillingCustomerIdentity({
      type: docRow.customer_doc_type,
      value: docRow.customer_doc_value,
      clientDocument: client.documento || ''
    });
    const tipo = String(docRow.tipo || admission.tipo || 'hospitalizacion').toLowerCase();
    const tipoLabel = tipo === 'emergencia' ? 'Emergencia' : 'Hospitalización';

    const productsTable = await pickTable(null, ['productos', 'products'], 'productos');
    const prodNameCol = await pickColumn(
      null,
      productsTable,
      ['nombre_comercial', 'nombre', 'name', 'descripcion'],
      null
    );
    const joinProd = prodNameCol ? `LEFT JOIN ${quoteIdent(productsTable)} p ON p.id = hc.product_id` : '';
    const prodSelect = prodNameCol ? `, p.${quoteIdent(prodNameCol)} AS product_name` : '';

    const chargesRes = await query(
      `SELECT hc.product_id, hc.product_type, hc.description, hc.quantity, hc.unit_price, hc.presentation_type${prodSelect}
       FROM hospital_charges hc ${joinProd}
       WHERE hc.admission_id = $1
       ORDER BY hc.created_at ASC`,
      [admission.id]
    );
    const charges = chargesRes.rows || [];

    let totalCharges = docRow.total_charges != null ? Number(docRow.total_charges) : 0;
    if (!totalCharges && charges.length) {
      totalCharges = charges.reduce((sum, row) => {
        const qty = Number(row.quantity || 0);
        const unit = Number(row.unit_price || 0);
        return sum + qty * unit;
      }, 0);
    }
    const discountAmount = docRow.discount_amount != null ? Number(docRow.discount_amount) : 0;
    const netTotal =
      docRow.net_total != null ? Number(docRow.net_total) : Math.max(0, totalCharges - discountAmount);
    const createdAt = docRow.created_at || new Date();
    const createdBy = String(docRow.created_by_name || req.session?.user?.username || '--').trim() || '--';
    const detailRows = charges.length
      ? charges.map((ch) => {
          const qty = Number(ch.quantity || 0);
          const unit = Number(ch.unit_price || 0);
        const amount = Number((qty * unit).toFixed(2));
        let desc = String(ch.description || '').trim();
        if (!desc && ch.product_name) desc = String(ch.product_name).trim();
        if (!desc) desc = 'Servicio';
        const chargeType = normalizeProductType(ch.product_type || (ch.product_id ? 'medicamento' : 'servicio'));
        const presentationType = chargeType === 'medicamento' ? normalizePresentationType(ch.presentation_type, 'unidad') : null;
        const quantityMeta =
          chargeType === 'combo'
            ? `${billingDocQty(qty)} combo${Math.abs(qty - 1) < 0.0001 ? '' : 's'}`
            : chargeType === 'servicio'
            ? `${billingDocQty(qty)} servicio${Math.abs(qty - 1) < 0.0001 ? '' : 's'}`
            : `${billingDocQty(qty)} ${presentationType ? getPresentationLabel(presentationType, qty) : `unidad${Math.abs(qty - 1) < 0.0001 ? '' : 'es'}`}`;
        const meta =
          qty && unit
            ? `${quantityMeta} · Q${billingDocMoney(unit)}`
            : '';
        return { label: desc, meta, amount };
      })
      : [
          {
            label: billingDocAreaLabel(tipo),
            meta: 'Sin cargos desglosados',
            amount: netTotal
          }
        ];

    const html = renderBillingDocPageHtml({
      title: 'Detalle de Cobro',
      subtitle: 'Detalle de cobro emitido',
      docId,
      clientName: client.nombre || '--',
      clientDocumentType: customerIdentity.type,
      clientDocument: customerIdentity.value,
      createdAt: formatDateES(createdAt),
      createdBy,
      tipoLabel,
      admissionId: admission.id,
      detailRows,
      totals: [
        { label: 'Total cargos', amount: totalCharges },
        ...(discountAmount > 0 ? [{ label: 'Descuento', amount: discountAmount }] : []),
        { label: 'Total a pagar', amount: netTotal, grand: true }
      ],
      footerMessage: 'Presentar este documento en Caja.'
    });
    res.type('text/html').send(html);
  })
);

router.all(
  '/hospital_billing',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'cashier', 'farmacia', 'cashiee', 'cashierh', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    await ensureHospitalSchema();

    const input = { ...req.query, ...readJson(req) };
    const action = String(input.action || '').trim().toLowerCase();
    const resolved = action || (req.method === 'GET' && input.doc_id ? 'get_doc' : '');

    if (resolved === 'get_doc') {
      const docId = Number(input.doc_id || input.id || 0);
      if (!docId) return safeJson(res, { ok: false, error: 'doc_id requerido' }, 400);
      const docRes = await query('SELECT * FROM hospital_billing_docs WHERE id = $1', [docId]);
      const docRow = docRes.rows[0];
      if (!docRow) return safeJson(res, { ok: false, error: 'Documento no encontrado' }, 404);
      const admission = await fetchAdmission(null, docRow.admission_id);
      const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [
        admission.client_id
      ]);
      const client = clientRes.rows[0] || null;
      const totals = await admissionTotals(null, admission.id);
      const discountAmountStored =
        docRow.discount_amount != null ? Number(docRow.discount_amount) : Number(admission.discount_amount || 0);
      const discountPercent =
        docRow.discount_percent != null ? Number(docRow.discount_percent) : Number(admission.discount_percent || 0);
      const resolvedDiscount = resolveDiscountTotals(
        totals.totalCharges,
        totals.medsCharges,
        discountPercent,
        discountAmountStored
      );
      const discountAmount = resolvedDiscount.discountAmount;
      const netCharges = resolvedDiscount.netCharges;
      const balance = Number((netCharges - totals.totalPayments).toFixed(2));
      return safeJson(res, {
        ok: true,
        doc: docRow,
        admission,
        client,
        totals: {
          charges: totals.totalCharges,
          payments: totals.totalPayments,
          discount: discountAmount,
          discount_percent: discountPercent,
          net: netCharges,
          balance
        }
      });
    }

    if (resolved === 'pay_doc') {
      const docId = Number(input.doc_id || input.id || 0);
      if (!docId) return safeJson(res, { ok: false, error: 'doc_id requerido' }, 400);
      const method = String(input.method || 'efectivo').trim() || 'efectivo';
      const note = String(input.note || '').trim();
      const discountPercentRaw = input.discount_percent != null ? Number(input.discount_percent) : 0;
      if (discountPercentRaw < 0 || discountPercentRaw > 100) {
        return safeJson(res, { ok: false, error: 'Porcentaje de descuento invalido' }, 400);
      }

      const userId = req.session?.user?.id || null;
      const result = await withTransaction(async (db) => {
        const docRes = await query('SELECT * FROM hospital_billing_docs WHERE id = $1', [docId], db);
        const docRow = docRes.rows[0];
        if (!docRow) {
          const err = new Error('Documento no encontrado');
          err.statusCode = 404;
          throw err;
        }
        if (String(docRow.status || '').toLowerCase() === 'paid') {
          const err = new Error('Documento ya pagado');
          err.statusCode = 400;
          throw err;
        }
        const admission = await fetchAdmission(db, docRow.admission_id);
        if (admission.status !== 'open') {
          const err = new Error('La admision ya esta cerrada');
          err.statusCode = 400;
          throw err;
        }
        const clientRes = await query('SELECT nombre, documento FROM hospital_clients WHERE id = $1', [
          admission.client_id
        ]);
        const client = clientRes.rows[0] || {};
        const customerIdentity = resolveBillingCustomerIdentity({
          type:
            input.customer_doc_type ??
            input.customer_type ??
            input.cliente_tipo ??
            input.tipo_cliente,
          value:
            input.customer_doc_value ??
            input.customer_document ??
            input.cliente_documento ??
            input.cliente_doc,
          fallbackType: docRow.customer_doc_type,
          fallbackValue: docRow.customer_doc_value,
          clientDocument: client.documento || ''
        });
        const totals = await admissionTotals(db, admission.id);
        if (totals.totalCharges <= 0) {
          const err = new Error('No existen cargos para esta admision');
          err.statusCode = 400;
          throw err;
        }
        const resolvedDiscount = resolveDiscountTotals(totals.totalCharges, totals.medsCharges, discountPercentRaw, 0);
        const discountAmount = resolvedDiscount.discountAmount;
        const netCharges = resolvedDiscount.netCharges;
        const balance = Number((netCharges - totals.totalPayments).toFixed(2));
        if (balance <= 0) {
          const err = new Error('No hay saldo pendiente para cobrar');
          err.statusCode = 400;
          throw err;
        }

        const chargesRes = await query(
          'SELECT product_id, product_type, description, quantity, unit_price FROM hospital_charges WHERE admission_id = $1 ORDER BY created_at ASC',
          [admission.id],
          db
        );
        const charges = chargesRes.rows || [];
        const services = serviceDetailsFromCharges(charges);

        const tipo = String(admission.tipo || docRow.tipo || 'hospitalizacion').toLowerCase();
        const tipoLabel = tipo === 'emergencia' ? 'Emergencia' : 'Hospitalizacion';
        const inputBranch = input.branch_id != null ? Number(input.branch_id) : null;
        let cajaId = await findOpenCajaId(
          db,
          userId,
          inputBranch || (admission.branch_id != null ? Number(admission.branch_id) : null)
        );
        if (!cajaId) {
          cajaId = await findOpenCajaId(db, userId, null);
        }
        if (!cajaId) {
          const err = new Error('No hay caja abierta. Abra la caja antes de cobrar.');
          err.statusCode = 400;
          throw err;
        }

        const paymentDetails = {
          origen: tipo === 'emergencia' ? 'emergencia' : 'hospital',
          admission_id: admission.id,
          doc_id: docId,
          nota: note || '',
          discount_percent: discountPercentRaw,
          discount_amount: discountAmount,
          tipo,
          cliente_tipo: customerIdentity.type || '',
          tipo_cliente: customerIdentity.type || '',
          customer_type: customerIdentity.type || '',
          cliente_documento: customerIdentity.value || '',
          cliente_doc: customerIdentity.value || '',
          customer_document: customerIdentity.value || '',
          services
        };
        const noteLabel = `${tipoLabel} Adm #${admission.id} Doc #${docId}`;
        const saleId = await insertHospitalSale(db, {
          admissionId: admission.id,
          charges,
          branchId: admission.branch_id != null ? Number(admission.branch_id) : null,
          userId,
          total: balance,
          note: noteLabel,
          cajaId,
          paymentMethod: method,
          paymentDetails,
          customerDocType: customerIdentity.type,
          customerDocValue: customerIdentity.value,
          createdAt: new Date()
        });
        await bumpCajaTotal(db, cajaId, balance);

        await query(
          'INSERT INTO hospital_payments (admission_id, amount, method, note, user_id, sale_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [admission.id, balance, method, note || null, userId, saleId],
          db
        );
        await query(
          'UPDATE hospital_admissions SET discount_percent = $1, discount_amount = $2 WHERE id = $3',
          [discountPercentRaw, discountAmount, admission.id],
          db
        );
        await query(
          `UPDATE hospital_billing_docs
           SET status = 'paid', paid_at = NOW(), paid_by = $1, sale_id = $2, total_charges = $3,
               discount_percent = $4, discount_amount = $5, net_total = $6,
               customer_doc_type = $7, customer_doc_value = $8
           WHERE id = $9`,
          [
            userId,
            saleId,
            totals.totalCharges,
            discountPercentRaw,
            discountAmount,
            netCharges,
            customerIdentity.type || null,
            customerIdentity.value || null,
            docId
          ],
          db
        );

        try {
          await autoEntryForSale(
            db,
            saleId,
            balance,
            admission.branch_id != null ? Number(admission.branch_id) : null,
            method,
            'contado',
            userId,
            new Date().toISOString().slice(0, 10)
          );
        } catch (_) {}

        return {
          saleId,
          totalCharges: totals.totalCharges,
          discountAmount,
          netCharges,
          paid: balance
        };
      });

      const fel = result.saleId
        ? await certifySaleIfEnabled(null, result.saleId, {
            userId,
            source: 'hospital_billing_doc'
          }).catch((err) => ({
            ok: false,
            status: 'failed',
            error: err?.message || 'Error FEL'
          }))
        : { ok: true, status: 'not_applicable' };

      return safeJson(res, {
        ok: true,
        sale_id: result.saleId,
        total_cargos: result.totalCharges,
        descuento: result.discountAmount,
        total_pagado: result.paid,
        neto: result.netCharges,
        fel
      });
    }

    return safeJson(res, { ok: false, error: 'Accion no soportada' }, 400);
  })
);

module.exports = router;
