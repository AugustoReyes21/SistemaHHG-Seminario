const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx-js-style');
const config = require('../config');
const {
  query,
  tableExists,
  columnExists,
  pickTable,
  pickColumn,
  getColumns,
  quoteIdent
} = require('../db');
const { safeJson } = require('../helpers');
const { requireRole } = require('../auth');
const { readAuditEvents } = require('../utils/audit');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/health',
  asyncHandler(async (req, res) => {
    let dbOk = false;
    try {
      await query('SELECT 1');
      dbOk = true;
    } catch (_) {
      dbOk = false;
    }
    return safeJson(res, {
      ok: dbOk,
      time: new Date().toISOString()
    });
  })
);

function formatDateES(value) {
  if (!value) return '-';
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
  if (!value) return '-';
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

function tClose(lang, key) {
  const map = {
    es: {
      close_title: 'Cierre de Caja',
      close_id: 'ID de Cierre',
      opening: 'Apertura',
      close: 'Cierre',
      opening_amount: 'Monto Inicial',
      total_sales: 'Total Ventas',
      returns: 'Anulaciones de ventas',
      net_total: 'Total Neto',
      expected: 'Monto Esperado',
      final_count: 'Monto Final (conteo)',
      status: 'Estado',
      responsible_user: 'Responsable de caja ',
      no_sales: 'No se generaron ingresos de ventas',
      hospital_name: 'HOPITAL HILARIO GALINDO',
      summary: 'Resumen del cierre',
      generated: 'Generado',
      balanced: 'CUADRADA',
      short: 'FALTANTE',
      over: 'SOBRANTE'
    },
    en: {
      close_title: 'Cash Close',
      close_id: 'Close ID',
      opening: 'Opening',
      close: 'Close',
      opening_amount: 'Opening Amount',
      total_sales: 'Total Sales',
      returns: 'Sales Cancellations',
      net_total: 'Net Total',
      expected: 'Expected Amount',
      final_count: 'Final Count',
      status: 'Status',
      responsible_user: 'Cashier in charge',
      no_sales: 'No sales income generated',
      hospital_name: 'HOSPITAL HILARIO GALINDO',
      summary: 'Close Summary',
      generated: 'Generated',
      balanced: 'BALANCED',
      short: 'SHORT',
      over: 'OVER'
    }
  };
  const langMap = map[lang] || map.es;
  return langMap[key] || map.es[key] || key;
}

function closeStatusMeta(status, lang) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'SOBRANTE') {
    return { color: '#1d4ed8', bg: '#dbeafe', label: tClose(lang, 'over') };
  }
  if (normalized === 'FALTANTE') {
    return { color: '#b45309', bg: '#ffedd5', label: tClose(lang, 'short') };
  }
  return { color: '#166534', bg: '#dcfce7', label: tClose(lang, 'balanced') };
}

function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/\s/g, '').replace(/[^0-9,.\-]/g, '');
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    raw = raw.replace(',', '.');
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function runPgDump(args, env) {
  return new Promise((resolve, reject) => {
    const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
    const child = spawn(pgDump, args, {
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `pg_dump exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function parseJsonSafe(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  const raw = String(value || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { raw };
  }
}

function normalizeAuditActionLabel(action) {
  const labels = {
    login: 'Inicio de sesión',
    login_failed: 'Intento de inicio de sesión fallido',
    logout: 'Cierre de sesión',
    cambio_contrasena: 'Cambio de contraseña',
    venta_registrada: 'Venta registrada',
    venta_devuelta: 'Devolución de venta',
    venta_devuelta_servicio: 'Devolución de servicio',
    venta_devuelta_sin_producto: 'Devolución manual de venta',
    venta_devuelta_manual: 'Devolución manual sin referencia',
    compra_registrada: 'Compra registrada',
    compra_confirmada: 'Compra confirmada',
    compra_eliminada: 'Compra eliminada',
    devolucion_proveedor: 'Devolución a proveedor',
    caja_apertura: 'Apertura de caja',
    caja_cierre: 'Cierre de caja',
    transferencia_creada: 'Traslado creado',
    transferencia_anulada: 'Traslado anulado',
    merma_vencimiento_registrada: 'Merma por vencimiento',
    producto_creado: 'Producto creado',
    producto_actualizado: 'Producto actualizado',
    producto_desactivado: 'Producto desactivado',
    product_created: 'Producto creado',
    product_updated: 'Producto actualizado',
    product_deleted: 'Producto desactivado',
    product_adjusted: 'Ajuste de stock',
    lot_created: 'Lote creado',
    lot_adjusted: 'Lote ajustado',
    lot_deleted: 'Lote eliminado',
    user_created: 'Usuario creado',
    user_updated: 'Usuario actualizado',
    user_deactivated: 'Usuario desactivado',
    user_block_changed: 'Bloqueo de usuario actualizado',
    hospital_client_create: 'Paciente creado',
    hospital_client_update: 'Paciente actualizado',
    hospital_admission_create: 'Admisión creada',
    hospital_charge_account: 'Cobro de cuenta hospitalaria',
    hospital_charge_add: 'Cargo hospitalario agregado',
    hospital_charge_delete: 'Cargo hospitalario eliminado',
    hospital_transfer_from_emergency: 'Traslado desde emergencia',
    hospital_admission_close: 'Admisión cerrada'
  };
  const raw = String(action || '').trim().toLowerCase();
  return labels[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function inferAuditModule(action, uri, details = {}) {
  if (details.source_module) return String(details.source_module).toLowerCase();
  const raw = String(action || '').toLowerCase();
  const route = String(uri || '').toLowerCase();
  if (raw.startsWith('venta_')) return 'ventas';
  if (raw.startsWith('compra_')) return 'compras';
  if (
    raw.startsWith('producto_') ||
    raw.startsWith('product_') ||
    raw.startsWith('transferencia_') ||
    raw.startsWith('lot_') ||
    raw.startsWith('merma_')
  ) {
    return 'inventario';
  }
  if (raw.startsWith('caja_')) return 'caja';
  if (raw.startsWith('hospital_')) return 'hospitalizacion';
  if (raw.includes('password') || raw.includes('contrasena') || raw.includes('user_') || raw === 'login' || raw === 'logout') {
    return 'seguridad';
  }
  if (route.includes('/auth') || route.includes('/users') || route.includes('/bitacora')) {
    return 'seguridad';
  }
  if (raw.startsWith('api_')) return 'api';
  return 'general';
}

function inferAuditSeverity(action, method, details = {}) {
  if (details.severity) return String(details.severity).toLowerCase();
  const raw = String(action || '').toLowerCase();
  const httpMethod = String(method || '').toUpperCase();
  if (
    raw.includes('failed') ||
    raw.includes('error') ||
    raw.includes('block') ||
    raw.includes('anulad') ||
    raw.includes('delete') ||
    raw.includes('devuelt') ||
    raw.includes('merma') ||
    raw.includes('cierre') ||
    raw.includes('password')
  ) {
    return 'high';
  }
  if (
    httpMethod === 'DELETE' ||
    raw.includes('create') ||
    raw.includes('registr') ||
    raw.includes('confirm') ||
    raw.includes('update') ||
    raw.includes('adjust') ||
    raw.includes('transfer')
  ) {
    return 'medium';
  }
  return 'low';
}

function inferAuditEntity(action, details = {}, fallback = {}) {
  if (details.entity_type || details.entity_id) {
    return {
      entity_type: details.entity_type ? String(details.entity_type) : null,
      entity_id: details.entity_id != null ? String(details.entity_id) : null
    };
  }
  const keys = [
    ['product_id', 'producto'],
    ['venta_id', 'venta'],
    ['sale_id', 'venta'],
    ['purchase_id', 'compra'],
    ['devolucion_id', 'devolucion'],
    ['transfer_id', 'traslado'],
    ['admission_id', 'admision'],
    ['client_id', 'paciente'],
    ['charge_id', 'cargo'],
    ['caja_id', 'caja'],
    ['branch_id', 'sucursal'],
    ['user_id', 'usuario']
  ];
  for (const [key, entityType] of keys) {
    if (details[key] != null && details[key] !== '') {
      return { entity_type: entityType, entity_id: String(details[key]) };
    }
  }
  if (fallback.entity_type || fallback.entity_id) {
    return {
      entity_type: fallback.entity_type ? String(fallback.entity_type) : null,
      entity_id: fallback.entity_id != null ? String(fallback.entity_id) : null
    };
  }
  const raw = String(action || '').toLowerCase();
  if (raw.startsWith('api_')) return { entity_type: 'api', entity_id: raw.replace(/^api_/, '') || null };
  return { entity_type: null, entity_id: null };
}

function auditSummary(row) {
  if (row.summary) return String(row.summary);
  const parts = [normalizeAuditActionLabel(row.action)];
  if (row.entity_type && row.entity_id) {
    parts.push(`${row.entity_type} #${row.entity_id}`);
  }
  if (row.entity_label) {
    parts.push(String(row.entity_label));
  }
  if (row.details && typeof row.details === 'object') {
    if (row.details.total != null) {
      const total = Number(row.details.total || 0);
      if (Number.isFinite(total)) parts.push(`Q${total.toFixed(2)}`);
    }
    if (row.details.delta != null) {
      const delta = Number(row.details.delta || 0);
      if (Number.isFinite(delta)) parts.push(`delta ${delta > 0 ? '+' : ''}${delta}`);
    }
  }
  return parts.filter(Boolean).join(' · ');
}

function parseDayBoundary(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
}

function rowTimestampValue(row) {
  const value = row.timestamp || row.fecha || null;
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function filterAuditRows(rows, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const action = String(filters.action || '').trim().toLowerCase();
  const moduleFilter = String(filters.module || '').trim().toLowerCase();
  const entityType = String(filters.entity_type || '').trim().toLowerCase();
  const status = String(filters.status || '').trim().toLowerCase();
  const severity = String(filters.severity || '').trim().toLowerCase();
  const source = String(filters.source || '').trim().toLowerCase();
  const branchId = filters.branch_id != null && filters.branch_id !== '' ? String(filters.branch_id) : '';
  const userId = filters.user_id != null && filters.user_id !== '' ? String(filters.user_id) : '';
  const start = parseDayBoundary(filters.start || filters.inicio || '', false);
  const end = parseDayBoundary(filters.end || filters.fin || '', true);

  return (rows || []).filter((row) => {
    if (action && String(row.action || '').toLowerCase() !== action) return false;
    if (moduleFilter && String(row.source_module || '').toLowerCase() !== moduleFilter) return false;
    if (entityType && String(row.entity_type || '').toLowerCase() !== entityType) return false;
    if (status && String(row.status || '').toLowerCase() !== status) return false;
    if (severity && String(row.severity || '').toLowerCase() !== severity) return false;
    if (source && String(row.source || '').toLowerCase() !== source) return false;
    if (branchId && String(row.branch_id || '') !== branchId) return false;
    if (userId && String(row.user_id || '') !== userId) return false;

    const ts = rowTimestampValue(row);
    if (start && (!ts || ts < start.getTime())) return false;
    if (end && (!ts || ts > end.getTime())) return false;

    if (!q) return true;
    const haystack = [
      row.id,
      row.source,
      row.action,
      row.action_label,
      row.user_id,
      row.usuario,
      row.user_role,
      row.source_module,
      row.branch_name,
      row.entity_type,
      row.entity_id,
      row.entity_label,
      row.summary,
      row.request_id,
      row.ip_address,
      row.http_method,
      row.uri,
      JSON.stringify(row.details || {})
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

async function enrichAuditRows(rows) {
  const userIds = [...new Set(rows.map((row) => Number(row.user_id || 0)).filter((value) => value > 0))];
  const branchIds = [...new Set(rows.map((row) => Number(row.branch_id || 0)).filter((value) => value > 0))];
  const productIds = [...new Set(
    rows
      .filter((row) => String(row.entity_type || '').toLowerCase() === 'producto')
      .map((row) => Number(row.entity_id || 0))
      .filter((value) => value > 0)
  )];

  const users = new Map();
  const branches = new Map();
  const products = new Map();

  if (userIds.length && (await tableExists(null, 'users'))) {
    const st = await query('SELECT id, username FROM users WHERE id = ANY($1)', [userIds]);
    for (const row of st.rows || []) {
      users.set(Number(row.id || 0), String(row.username || ''));
    }
  }
  if (branchIds.length && (await tableExists(null, 'branches'))) {
    const st = await query('SELECT id, name FROM branches WHERE id = ANY($1)', [branchIds]);
    for (const row of st.rows || []) {
      branches.set(Number(row.id || 0), String(row.name || ''));
    }
  }
  if (productIds.length && (await tableExists(null, 'productos'))) {
    const st = await query('SELECT id, nombre_comercial FROM productos WHERE id = ANY($1)', [productIds]);
    for (const row of st.rows || []) {
      products.set(Number(row.id || 0), String(row.nombre_comercial || ''));
    }
  }

  return rows.map((row) => {
    const next = { ...row };
    if (!next.usuario && next.user_id) {
      next.usuario = users.get(Number(next.user_id || 0)) || `user:${next.user_id}`;
    }
    if (!next.branch_name && next.branch_id) {
      next.branch_name = branches.get(Number(next.branch_id || 0)) || `Sucursal #${next.branch_id}`;
    }
    if (!next.entity_label && String(next.entity_type || '').toLowerCase() === 'producto' && next.entity_id) {
      next.entity_label = products.get(Number(next.entity_id || 0)) || null;
    }
    next.action_label = normalizeAuditActionLabel(next.action);
    next.summary = auditSummary(next);
    return next;
  });
}

async function loadDbAuditRows(limit) {
  const table = (await tableExists(null, 'bitacora'))
    ? 'bitacora'
    : (await tableExists(null, 'logs'))
    ? 'logs'
    : null;
  if (!table) return [];
  const cols = await getColumns(null, table);
  const pick = (name) => (cols.includes(name) ? name : null);
  const actionCol = pick('accion') || pick('action');
  const dateCol = pick('fecha') || pick('created_at');
  if (!actionCol || !dateCol) return [];
  const detailCols = ['meta', 'detalles', 'details'].filter((name) => cols.includes(name));
  const select = [
    'b.id',
    `b.${quoteIdent(actionCol)} AS action`,
    `b.${quoteIdent(dateCol)} AS timestamp`
  ];
  if (pick('usuario')) select.push('b.usuario');
  if (pick('user_id')) select.push('b.user_id');
  if (pick('user_role')) select.push('b.user_role');
  if (pick('request_id')) select.push('b.request_id');
  if (pick('event_source')) select.push('b.event_source');
  if (pick('source_module')) select.push('b.source_module');
  if (pick('entity_type')) select.push('b.entity_type');
  if (pick('entity_id')) select.push('b.entity_id');
  if (pick('branch_id')) select.push('b.branch_id');
  if (pick('branch_name')) select.push('b.branch_name');
  if (pick('status')) select.push('b.status');
  if (pick('severity')) select.push('b.severity');
  if (pick('ip_address')) select.push('b.ip_address');
  if (pick('http_method')) select.push('b.http_method');
  if (pick('uri')) select.push('b.uri');
  if (pick('summary')) select.push('b.summary');
  if (pick('user_agent')) select.push('b.user_agent');
  if (pick('session_id')) select.push('b.session_id');
  if (detailCols.length === 1) {
    select.push(`b.${quoteIdent(detailCols[0])} AS details_raw`);
  } else if (detailCols.length > 1) {
    select.push(`COALESCE(${detailCols.map((col) => `b.${quoteIdent(col)}`).join(', ')}) AS details_raw`);
  } else {
    select.push('NULL AS details_raw');
  }
  const st = await query(
    `SELECT ${select.join(', ')}
       FROM ${quoteIdent(table)} b
      ORDER BY b.${quoteIdent(dateCol)} DESC
      LIMIT $1`,
    [Math.max(200, Math.min(Number(limit || 1000) * 4, 5000))]
  );
  return (st.rows || []).map((row) => {
    const details = parseJsonSafe(row.details_raw);
    const entity = inferAuditEntity(row.action, details, row);
    return {
      id: `db-${row.id}`,
      source: 'bitacora',
      timestamp: row.timestamp,
      action: row.action,
      usuario: row.usuario || details.username || null,
      user_id: row.user_id != null ? Number(row.user_id || 0) || null : details.user_id != null ? Number(details.user_id || 0) || null : null,
      user_role: row.user_role || details.user_role || null,
      request_id: row.request_id || details.request_id || null,
      source_module: row.source_module || inferAuditModule(row.action, row.uri || details.uri, details),
      entity_type: row.entity_type || entity.entity_type,
      entity_id: row.entity_id || entity.entity_id,
      branch_id: row.branch_id != null ? Number(row.branch_id || 0) || null : details.branch_id != null ? Number(details.branch_id || 0) || null : null,
      branch_name: row.branch_name || details.branch_name || null,
      status: row.status || details.status || 'ok',
      severity: row.severity || inferAuditSeverity(row.action, row.http_method || details.http_method, details),
      ip_address: row.ip_address || details.ip_address || null,
      http_method: row.http_method || details.http_method || null,
      uri: row.uri || details.uri || null,
      summary: row.summary || details.summary || null,
      user_agent: row.user_agent || details.user_agent || null,
      session_id: row.session_id || details.session_id || null,
      details
    };
  });
}

async function loadFileAuditRows(limit) {
  const rawEvents = readAuditEvents();
  if (!rawEvents.length) return [];
  const maxItems = Math.max(200, Math.min(Number(limit || 1000) * 4, 5000));
  return rawEvents.slice(-maxItems).map((event, index) => {
    const entity = inferAuditEntity(event.action, event, {
      entity_type: event.product_id != null ? 'producto' : null,
      entity_id: event.product_id != null ? String(event.product_id) : null
    });
    return {
      id: `file-${index + 1}`,
      source: 'movimiento',
      timestamp: event.ts || null,
      action: event.action || 'audit_event',
      usuario: event.username || null,
      user_id: event.user_id != null ? Number(event.user_id || 0) || null : null,
      user_role: event.user_role || null,
      request_id: event.request_id || null,
      source_module: inferAuditModule(event.action, event.uri || null, event),
      entity_type: entity.entity_type,
      entity_id: entity.entity_id,
      branch_id: event.branch_id != null ? Number(event.branch_id || 0) || null : null,
      branch_name: null,
      status: event.status || 'ok',
      severity: inferAuditSeverity(event.action, event.method || null, event),
      ip_address: event.ip_address || null,
      http_method: event.method || null,
      uri: event.uri || null,
      summary: null,
      user_agent: event.user_agent || null,
      session_id: event.session_id || null,
      details: event
    };
  });
}

async function loadUnifiedAuditData(filters = {}) {
  const limit = Math.max(50, Math.min(Number(filters.limit || 300) || 300, 2000));
  const dbRows = await loadDbAuditRows(limit);
  const fileRows = await loadFileAuditRows(limit);
  let rows = [...dbRows, ...fileRows];
  rows = await enrichAuditRows(rows);
  rows = filterAuditRows(rows, filters || {});
  rows.sort((a, b) => rowTimestampValue(b) - rowTimestampValue(a));
  rows = rows.slice(0, limit);

  const summary = {
    total: rows.length,
    high: rows.filter((row) => row.severity === 'high').length,
    medium: rows.filter((row) => row.severity === 'medium').length,
    low: rows.filter((row) => row.severity === 'low').length,
    movimientos: rows.filter((row) => row.source === 'movimiento').length,
    bitacora: rows.filter((row) => row.source === 'bitacora').length
  };

  return { rows, summary, limit };
}

router.get(
  '/backup',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    const db = config.db;
    const dbName = db.database || 'pos_retail';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const filename = `backup_${dbName}_${stamp}.sql`;
    const filepath = path.join(os.tmpdir(), filename);

    const args = ['-h', db.host, '-p', String(db.port || 5432), '-U', db.user, '-F', 'p', '-f', filepath, dbName];
    try {
      await runPgDump(args, { PGPASSWORD: db.password || '' });
    } catch (err) {
      return safeJson(res, {
        error: 'No se pudo ejecutar pg_dump. Compruebe que este instalado y en PATH.'
      }, 500);
    }

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(filepath);
    stream.on('error', () => {
      if (!res.headersSent) {
        safeJson(res, { error: 'No se pudo leer el archivo de respaldo' }, 500);
      } else {
        res.end();
      }
      try { fs.unlinkSync(filepath); } catch (_) {}
    });
    stream.on('close', () => {
      try { fs.unlinkSync(filepath); } catch (_) {}
    });
    stream.pipe(res);
  })
);

router.get(
  '/bitacora_list',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;
    const { rows, summary } = await loadUnifiedAuditData(req.query || {});
    return safeJson(res, { ok: true, items: rows, summary });
  })
);

router.get(
  '/bitacora_export',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    const { rows, summary } = await loadUnifiedAuditData(req.query || {});
    const dataRows = [
      [
        'Fecha',
        'Fuente',
        'Modulo',
        'Accion',
        'Etiqueta',
        'Usuario',
        'User ID',
        'Rol',
        'Entidad',
        'Entidad ID',
        'Etiqueta entidad',
        'Sucursal',
        'Branch ID',
        'Severidad',
        'Estado',
        'Resumen',
        'Request ID',
        'Metodo',
        'URI',
        'IP',
        'Sesion',
        'Detalle JSON'
      ]
    ];

    for (const row of rows) {
      dataRows.push([
        formatDateES(row.timestamp || row.fecha || ''),
        row.source || '',
        row.source_module || '',
        row.action || '',
        row.action_label || '',
        row.usuario || '',
        row.user_id != null ? Number(row.user_id || 0) || row.user_id : '',
        row.user_role || '',
        row.entity_type || '',
        row.entity_id || '',
        row.entity_label || '',
        row.branch_name || '',
        row.branch_id != null ? Number(row.branch_id || 0) || row.branch_id : '',
        row.severity || '',
        row.status || '',
        row.summary || '',
        row.request_id || '',
        row.http_method || '',
        row.uri || '',
        row.ip_address || '',
        row.session_id || '',
        JSON.stringify(row.details || {})
      ]);
    }

    const summaryRows = [
      ['Resumen', 'Valor'],
      ['Total visible', Number(summary.total || 0)],
      ['Bitacora app', Number(summary.bitacora || 0)],
      ['Movimientos tecnicos', Number(summary.movimientos || 0)],
      ['Severidad alta', Number(summary.high || 0)],
      ['Severidad media', Number(summary.medium || 0)],
      ['Severidad baja', Number(summary.low || 0)]
    ];

    const filters = req.query || {};
    const filterRows = [
      ['Filtro', 'Valor'],
      ['Buscar', filters.q || ''],
      ['Modulo', filters.module || ''],
      ['Accion', filters.action || ''],
      ['Entidad', filters.entity_type || ''],
      ['Origen', filters.source || ''],
      ['Severidad', filters.severity || ''],
      ['Estado', filters.status || ''],
      ['Desde', filters.start || filters.inicio || ''],
      ['Hasta', filters.end || filters.fin || ''],
      ['Limite', filters.limit || '300']
    ];

    const wsAudit = XLSX.utils.aoa_to_sheet(dataRows);
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    const wsFilters = XLSX.utils.aoa_to_sheet(filterRows);

    wsAudit['!cols'] = [
      { wch: 22 },
      { wch: 16 },
      { wch: 18 },
      { wch: 24 },
      { wch: 28 },
      { wch: 22 },
      { wch: 12 },
      { wch: 16 },
      { wch: 18 },
      { wch: 12 },
      { wch: 28 },
      { wch: 20 },
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
      { wch: 42 },
      { wch: 40 },
      { wch: 12 },
      { wch: 42 },
      { wch: 18 },
      { wch: 22 },
      { wch: 70 }
    ];
    wsSummary['!cols'] = [{ wch: 24 }, { wch: 14 }];
    wsFilters['!cols'] = [{ wch: 18 }, { wch: 30 }];

    const applyHeaderStyle = (sheet) => {
      const ref = sheet['!ref'];
      if (!ref) return;
      const range = XLSX.utils.decode_range(ref);
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r: 0, c });
        if (!sheet[addr]) continue;
        sheet[addr].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '0F4C81' } },
          alignment: { vertical: 'center', horizontal: 'center' }
        };
      }
    };

    applyHeaderStyle(wsAudit);
    applyHeaderStyle(wsSummary);
    applyHeaderStyle(wsFilters);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsAudit, 'Auditoria');
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');
    XLSX.utils.book_append_sheet(wb, wsFilters, 'Filtros');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="auditoria_${stamp}.xlsx"`);
    return res.end(buffer);
  })
);

router.get(
  '/history_returns',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    const out = [];

    const branches = {};
    if (await tableExists(null, 'branches')) {
      const bq = await query('SELECT id, name FROM branches');
      for (const b of bq.rows) branches[Number(b.id)] = b.name;
    }

    const loadCajaLabels = async (ids) => {
      const uniqueIds = [...new Set((ids || []).map((id) => Number(id || 0)).filter((id) => id > 0))];
      const labels = {};
      if (!uniqueIds.length) return labels;
      const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
      if (!(await tableExists(null, cajaTable))) {
        for (const id of uniqueIds) labels[id] = `Caja #${id}`;
        return labels;
      }
      const cajaCols = await getColumns(null, cajaTable);
      const branchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;
      const rows = await query(
        `SELECT c.id ${branchCol ? `, c.${quoteIdent(branchCol)} AS branch_id` : ''}
         FROM ${quoteIdent(cajaTable)} c
         WHERE c.id = ANY($1)`,
        [uniqueIds]
      );
      for (const row of rows.rows || []) {
        const id = Number(row.id || 0);
        if (!id) continue;
        const branchName =
          row.branch_id && branches[Number(row.branch_id)] ? branches[Number(row.branch_id)] : null;
        labels[id] = branchName ? `Caja #${id} - ${branchName}` : `Caja #${id}`;
      }
      for (const id of uniqueIds) {
        if (!labels[id]) labels[id] = `Caja #${id}`;
      }
      return labels;
    };

    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    if (await tableExists(null, returnsTable)) {
      const returnCols = await getColumns(null, returnsTable);
      const branchCol = returnCols.includes('branch_id') ? 'branch_id' : null;
      const userCol = returnCols.includes('user_id') ? 'user_id' : null;
      const motiveCol = returnCols.includes('motive') ? 'motive' : returnCols.includes('motivo') ? 'motivo' : null;
      const totalCol = returnCols.includes('total_return') ? 'total_return' : returnCols.includes('total') ? 'total' : null;
      const refundCajaCol = returnCols.includes('caja_id') ? 'caja_id' : null;
      const saleCajaAuditCol = returnCols.includes('sale_caja_id') ? 'sale_caja_id' : null;
      const saleDateAuditCol = returnCols.includes('sale_date') ? 'sale_date' : null;
      const authorizedByCol = returnCols.includes('authorized_by_id') ? 'authorized_by_id' : null;

      const rows = await query(
        `SELECT id, sale_id, created_at ${branchCol ? `, ${branchCol} AS branch_id` : ''} ${
          userCol ? `, ${userCol} AS user_id` : ''
        } ${motiveCol ? `, ${motiveCol} AS motive` : ''} ${
          totalCol ? `, ${totalCol} AS total_return` : ''
        } ${refundCajaCol ? `, ${refundCajaCol} AS refund_caja_id` : ''} ${
          saleCajaAuditCol ? `, ${saleCajaAuditCol} AS sale_caja_id` : ''
        } ${saleDateAuditCol ? `, ${saleDateAuditCol} AS sale_date` : ''} ${
          authorizedByCol ? `, ${authorizedByCol} AS authorized_by_id` : ''
        } FROM ${quoteIdent(returnsTable)} ORDER BY created_at DESC`
      );

      const userIds = new Set();
      const saleIds = new Set();
      for (const r of rows.rows) {
        if (r.user_id) userIds.add(Number(r.user_id));
        if (r.authorized_by_id) userIds.add(Number(r.authorized_by_id));
        if (r.sale_id) saleIds.add(Number(r.sale_id));
      }
      const usernames = {};
      if (userIds.size) {
        const us = await query('SELECT id, username FROM users WHERE id = ANY($1)', [[...userIds]]);
        for (const u of us.rows) usernames[Number(u.id)] = u.username;
      }

      const salesTable = await pickTable(null, ['ventas', 'sales'], 'ventas');
      const saleIdCol = await pickColumn(null, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
      const saleTotalCol = await pickColumn(null, salesTable, ['total', 'monto_total', 'importe_total'], 'total');
      const saleBranchCol = await pickColumn(null, salesTable, ['branch_id', 'sucursal_id'], null);
      const saleFechaCol = await pickColumn(null, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
      const saleCajaCol = await pickColumn(null, salesTable, ['caja_id', 'cashbox_id', 'id_caja'], null);

      const salesMap = {};
      if (saleIds.size && (await tableExists(null, salesTable))) {
        const salesRes = await query(
          `SELECT ${quoteIdent(saleIdCol)} AS id ${saleTotalCol ? `, ${quoteIdent(saleTotalCol)} AS total` : ''} ${
            saleBranchCol ? `, ${quoteIdent(saleBranchCol)} AS branch_id` : ''
          } ${saleFechaCol ? `, ${quoteIdent(saleFechaCol)} AS fecha` : ''} ${
            saleCajaCol ? `, ${quoteIdent(saleCajaCol)} AS caja_id` : ''
          } FROM ${quoteIdent(salesTable)} WHERE ${
            quoteIdent(saleIdCol)
          } = ANY($1)`,
          [[...saleIds]]
        );
        for (const s of salesRes.rows) salesMap[Number(s.id)] = s;
      }

      const totalsByReturn = {};
      const returnItemsTable = await pickTable(null, ['sale_return_items'], 'sale_return_items');
      if (await tableExists(null, returnItemsTable)) {
        const subCol = await pickColumn(null, returnItemsTable, ['subtotal', 'total', 'importe'], 'subtotal');
        if (subCol) {
          const sumRes = await query(
            `SELECT return_id, COALESCE(SUM(${quoteIdent(subCol)}),0) AS total
             FROM ${quoteIdent(returnItemsTable)}
             GROUP BY return_id`
          );
          for (const s of sumRes.rows) totalsByReturn[Number(s.return_id)] = Number(s.total || 0);
        }
      }

      const cajaIds = [];
      for (const r of rows.rows) {
        if (r.refund_caja_id) cajaIds.push(Number(r.refund_caja_id));
        if (r.sale_caja_id) cajaIds.push(Number(r.sale_caja_id));
      }
      for (const sale of Object.values(salesMap)) {
        if (sale && sale.caja_id) cajaIds.push(Number(sale.caja_id));
      }
      const cajaLabels = await loadCajaLabels(cajaIds);

      for (const r of rows.rows) {
        const sale = salesMap[Number(r.sale_id)] || {};
        const branchId = r.branch_id || sale.branch_id || null;
        const sourceCajaId = r.sale_caja_id != null ? Number(r.sale_caja_id) : sale.caja_id != null ? Number(sale.caja_id) : null;
        const refundCajaId = r.refund_caja_id != null ? Number(r.refund_caja_id) : null;
        const totalValue =
          r.total_return != null
            ? Number(r.total_return)
            : totalsByReturn[Number(r.id)] != null
            ? totalsByReturn[Number(r.id)]
            : null;
        out.push({
          id: Number(r.id),
          tipo: 'venta',
          referencia: r.sale_id != null ? Number(r.sale_id) : null,
          fecha: r.created_at,
          venta_fecha: r.sale_date || sale.fecha || null,
          sucursal: branchId && branches[Number(branchId)] ? branches[Number(branchId)] : branchId || null,
          usuario: r.user_id && usernames[Number(r.user_id)] ? usernames[Number(r.user_id)] : null,
          autorizado_por:
            r.authorized_by_id && usernames[Number(r.authorized_by_id)]
              ? usernames[Number(r.authorized_by_id)]
              : null,
          caja_origen: sourceCajaId ? cajaLabels[sourceCajaId] || `Caja #${sourceCajaId}` : null,
          caja_devolucion: refundCajaId ? cajaLabels[refundCajaId] || `Caja #${refundCajaId}` : null,
          total: totalValue,
          motivo: r.motive || null
        });
      }
    }

    const manualTable = await pickTable(null, ['sale_returns_manual'], 'sale_returns_manual');
    if (await tableExists(null, manualTable)) {
      const mCols = await getColumns(null, manualTable);
      const amountCol = mCols.includes('amount') ? 'amount' : mCols.includes('monto') ? 'monto' : null;
      const motiveCol = mCols.includes('motive') ? 'motive' : mCols.includes('motivo') ? 'motivo' : null;
      const branchCol = mCols.includes('branch_id') ? 'branch_id' : null;
      const adminCol = mCols.includes('admin_id') ? 'admin_id' : null;
      const userCol = mCols.includes('user_id') ? 'user_id' : null;
      const cajaCol = mCols.includes('caja_id') ? 'caja_id' : null;
      const dateCol = mCols.includes('created_at') ? 'created_at' : mCols.includes('fecha') ? 'fecha' : null;

      let select = 'id';
      if (amountCol) select += `, ${quoteIdent(amountCol)} AS amount`;
      if (motiveCol) select += `, ${quoteIdent(motiveCol)} AS motive`;
      if (branchCol) select += `, ${quoteIdent(branchCol)} AS branch_id`;
      if (adminCol) select += `, ${quoteIdent(adminCol)} AS admin_id`;
      if (userCol) select += `, ${quoteIdent(userCol)} AS user_id`;
      if (cajaCol) select += `, ${quoteIdent(cajaCol)} AS caja_id`;
      if (dateCol) select += `, ${quoteIdent(dateCol)} AS created_at`;

      const rows = await query(`SELECT ${select} FROM ${quoteIdent(manualTable)} ORDER BY ${dateCol ? quoteIdent(dateCol) : 'id'} DESC`);

      const adminIds = new Set();
      const userIds = new Set();
      for (const r of rows.rows) {
        if (r.admin_id) adminIds.add(Number(r.admin_id));
        if (r.user_id) userIds.add(Number(r.user_id));
      }
      const usernames = {};
      const ids = [...adminIds, ...userIds];
      if (ids.length) {
        const us = await query('SELECT id, username FROM users WHERE id = ANY($1)', [ids]);
        for (const u of us.rows) usernames[Number(u.id)] = u.username;
      }
      const cajaLabels = await loadCajaLabels(rows.rows.map((row) => row.caja_id));

      for (const r of rows.rows) {
        const branchId = r.branch_id || null;
        out.push({
          id: Number(r.id),
          tipo: 'venta_sin_id',
          referencia: null,
          fecha: r.created_at || null,
          venta_fecha: null,
          sucursal: branchId && branches[Number(branchId)] ? branches[Number(branchId)] : branchId || null,
          usuario: r.user_id && usernames[Number(r.user_id)] ? usernames[Number(r.user_id)] : null,
          autorizado_por: r.admin_id && usernames[Number(r.admin_id)] ? usernames[Number(r.admin_id)] : null,
          caja_origen: null,
          caja_devolucion: r.caja_id ? cajaLabels[Number(r.caja_id)] || `Caja #${Number(r.caja_id)}` : null,
          total: r.amount != null ? Number(r.amount) : null,
          motivo: r.motive || null
        });
      }
    }

    const devolTable = await pickTable(null, ['devoluciones'], 'devoluciones');
    if (await tableExists(null, devolTable)) {
      const devolCols = await getColumns(null, devolTable);
      const fechaCol = devolCols.includes('fecha_devolucion')
        ? 'fecha_devolucion'
        : devolCols.includes('created_at')
        ? 'created_at'
        : null;
      const motiveCol = devolCols.includes('motivo') ? 'motivo' : devolCols.includes('motive') ? 'motive' : null;
      const provCol = devolCols.includes('proveedor_id')
        ? 'proveedor_id'
        : devolCols.includes('supplier_id')
        ? 'supplier_id'
        : null;
      const purchaseCol = devolCols.includes('purchase_id') ? 'purchase_id' : null;

      const supplierTable = await pickTable(null, ['proveedores', 'suppliers'], 'proveedores');
      const supplierExists = await tableExists(null, supplierTable);
      const supplierNameCol = supplierExists
        ? await pickColumn(null, supplierTable, ['nombre', 'name'], 'nombre')
        : null;
      const canJoinSupplier = Boolean(provCol && supplierExists && supplierNameCol);

      const detailTable = await pickTable(null, ['detalle_devolucion', 'detalle_devoluciones'], 'detalle_devolucion');
      const detailProductCol = await pickColumn(null, detailTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
      const detailQtyCol = await pickColumn(null, detailTable, ['cantidad', 'qty', 'quantity'], 'cantidad');
      const purchaseItemsTable = await pickTable(null, ['purchase_items'], 'purchase_items');
      const purchaseUnitCol = await pickColumn(null, purchaseItemsTable, ['unit_price', 'precio_unit', 'costo_unitario'], 'unit_price');

      const totalsByDev = {};
      if (purchaseCol && (await tableExists(null, detailTable)) && (await tableExists(null, purchaseItemsTable)) && detailProductCol && detailQtyCol && purchaseUnitCol) {
        const sumRes = await query(
          `SELECT d.id AS devolucion_id, COALESCE(SUM(dd.${quoteIdent(detailQtyCol)} * pi.${quoteIdent(purchaseUnitCol)}),0) AS total
           FROM ${quoteIdent(devolTable)} d
           JOIN ${quoteIdent(detailTable)} dd ON dd.devolucion_id = d.id
           JOIN ${quoteIdent(purchaseItemsTable)} pi ON pi.purchase_id = d.${quoteIdent(purchaseCol)} AND pi.product_id = dd.${quoteIdent(detailProductCol)}
           GROUP BY d.id`
        );
        for (const s of sumRes.rows) totalsByDev[Number(s.devolucion_id)] = Number(s.total || 0);
      }

      let select = `d.id`;
      if (fechaCol) select += `, d.${quoteIdent(fechaCol)} AS fecha`;
      if (motiveCol) select += `, d.${quoteIdent(motiveCol)} AS motive`;
      if (purchaseCol) select += `, d.${quoteIdent(purchaseCol)} AS purchase_id`;
      if (provCol) select += `, d.${quoteIdent(provCol)} AS proveedor_id`;
      if (canJoinSupplier) select += `, s.${quoteIdent(supplierNameCol)} AS proveedor`;

      const joinSql = canJoinSupplier
        ? ` LEFT JOIN ${quoteIdent(supplierTable)} s ON s.id = d.${quoteIdent(provCol)}`
        : '';
      const rows = await query(
        `SELECT ${select}
         FROM ${quoteIdent(devolTable)} d${joinSql}
         ORDER BY ${fechaCol ? `d.${quoteIdent(fechaCol)}` : 'd.id'} DESC`
      );

      for (const r of rows.rows) {
        out.push({
          id: Number(r.id),
          tipo: 'proveedor',
          referencia: r.purchase_id != null ? Number(r.purchase_id) : null,
          fecha: r.fecha || null,
          proveedor: r.proveedor || null,
          total: totalsByDev[Number(r.id)] != null ? totalsByDev[Number(r.id)] : null,
          motivo: r.motive || null
        });
      }
    }

    out.sort((a, b) => {
      const da = a.fecha ? new Date(a.fecha).getTime() : 0;
      const dbt = b.fecha ? new Date(b.fecha).getTime() : 0;
      return dbt - da;
    });

    return safeJson(res, out);
  })
);

router.get(
  '/cierre_pdf',
  asyncHandler(async (req, res) => {
    const cierreId = req.query.cierre_id ? Number(req.query.cierre_id) : 0;
    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    const ventasTable = await pickTable(null, ['ventas', 'sales'], 'ventas');

    if (!(await tableExists(null, cajaTable))) {
      return res.type('text/plain').send('No se encontro el cierre de caja');
    }

    const cajaCols = await getColumns(null, cajaTable);
    const fa = cajaCols.includes('fecha_apertura') ? 'fecha_apertura' : cajaCols.includes('fecha') ? 'fecha' : null;
    const fc = cajaCols.includes('fecha_cierre') ? 'fecha_cierre' : null;
    const miApertura = cajaCols.includes('monto_apertura') ? 'monto_apertura' : null;
    const miInicial = cajaCols.includes('monto_inicial') ? 'monto_inicial' : null;
    const mfFinal = cajaCols.includes('monto_final') ? 'monto_final' : null;
    const mfCierre = cajaCols.includes('monto_cierre') ? 'monto_cierre' : null;
    const branchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;

    let caja = null;
    if (cierreId > 0) {
      const st = await query(`SELECT * FROM ${quoteIdent(cajaTable)} WHERE id = $1 LIMIT 1`, [cierreId]);
      caja = st.rows[0];
    } else {
      let sql = `SELECT * FROM ${quoteIdent(cajaTable)}`;
      if (fc) {
        sql += ` WHERE ${quoteIdent(fc)} IS NOT NULL`;
      }
      sql += ' ORDER BY id DESC LIMIT 1';
      const st = await query(sql);
      caja = st.rows[0];
    }

    if (!caja) {
      return res.type('text/plain').send('No se encontro el cierre de caja');
    }

    const cajaId = Number(caja.id || 0);
    const branchId = branchCol && caja[branchCol] != null ? Number(caja[branchCol]) : null;
    const cajaUserIdCol =
      cajaCols.includes('user_id') ? 'user_id' :
      cajaCols.includes('usuario_id') ? 'usuario_id' :
      cajaCols.includes('cajero_id') ? 'cajero_id' :
      null;
    const cajaUsernameCol =
      cajaCols.includes('usuario') ? 'usuario' :
      cajaCols.includes('cajero') ? 'cajero' :
      cajaCols.includes('username') ? 'username' :
      null;
    const fechaApertura = fa ? caja[fa] : null;
    let fechaCierre = fc ? caja[fc] : null;
    if (!fechaCierre) fechaCierre = new Date();
    const rawMontoInicial =
      (miApertura && caja[miApertura] != null ? caja[miApertura] : null) ??
      (miInicial && caja[miInicial] != null ? caja[miInicial] : null);
    let montoInicial = rawMontoInicial != null ? Number(rawMontoInicial) : 0;
    if (!Number.isFinite(montoInicial)) montoInicial = 0;
    let responsibleUser = cajaUsernameCol && caja[cajaUsernameCol] != null ? String(caja[cajaUsernameCol]).trim() : '';
    if (!responsibleUser && cajaUserIdCol && caja[cajaUserIdCol] != null) {
      const usersTable = await pickTable(null, ['users', 'usuarios'], 'users');
      if (await tableExists(null, usersTable)) {
        const userNameCol = await pickColumn(null, usersTable, ['username', 'usuario', 'nombre', 'name'], null);
        if (userNameCol) {
          const userRes = await query(
            `SELECT ${quoteIdent(userNameCol)} AS username FROM ${quoteIdent(usersTable)} WHERE id = $1 LIMIT 1`,
            [Number(caja[cajaUserIdCol])]
          );
          responsibleUser = userRes.rows[0]?.username ? String(userRes.rows[0].username).trim() : '';
        }
      }
    }
    if (!responsibleUser) responsibleUser = '-';

    const finalValue = mfFinal && caja[mfFinal] != null ? Number(caja[mfFinal]) : null;
    const cierreValue = mfCierre && caja[mfCierre] != null ? Number(caja[mfCierre]) : null;
    const finalOk = Number.isFinite(finalValue);
    const cierreOk = Number.isFinite(cierreValue);
    let montoFinal = 0;
    if (finalOk && (finalValue !== 0 || !cierreOk || cierreValue === 0)) {
      montoFinal = finalValue;
    } else if (cierreOk) {
      montoFinal = cierreValue;
    }
    if ((!montoFinal || montoFinal === 0) && (req.query.monto_final != null || req.query.monto_cierre != null || req.query.monto != null)) {
      const qv =
        req.query.monto_final != null
          ? req.query.monto_final
          : req.query.monto_cierre != null
          ? req.query.monto_cierre
          : req.query.monto;
      const parsed = parseNumber(qv);
      if (parsed != null) montoFinal = parsed;
    }

    let totalVentas = 0;
    const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);
    const salesIdCol = await pickColumn(null, ventasTable, ['id', 'venta_id', 'sale_id'], 'id');
    const salesTotalCol = await pickColumn(
      null,
      ventasTable,
      ['total', 'monto_total', 'importe_total', 'amount_total', 'monto', 'importe'],
      'total'
    );
    if (cajaId && salesBoxCol && salesTotalCol && (await tableExists(null, ventasTable))) {
      const st = await query(
        `SELECT COALESCE(SUM(${quoteIdent(salesTotalCol)}),0) AS tot FROM ${quoteIdent(ventasTable)} WHERE ${quoteIdent(salesBoxCol)} = $1`,
        [cajaId]
      );
      totalVentas = Number(st.rows[0]?.tot || 0);
    }

    let totalDevoluciones = 0;
    let totalDevolucionesManual = 0;
    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    if (await tableExists(null, returnsTable)) {
      const returnCols = await getColumns(null, returnsTable);
      const returnTotalCol = returnCols.includes('total_return')
        ? 'total_return'
        : returnCols.includes('total')
        ? 'total'
        : null;
      const returnDateCol = returnCols.includes('created_at')
        ? 'created_at'
        : returnCols.includes('fecha')
        ? 'fecha'
        : null;
      const returnItemsTable = await pickTable(null, ['sale_return_items'], 'sale_return_items');
      const returnItemsExists = await tableExists(null, returnItemsTable);
      const returnItemSubCol = returnItemsExists
        ? await pickColumn(null, returnItemsTable, ['subtotal', 'total', 'importe'], 'subtotal')
        : null;
      const itemsJoin = returnItemSubCol
        ? `LEFT JOIN (SELECT return_id, COALESCE(SUM(${quoteIdent(returnItemSubCol)}),0) AS total_items
                      FROM ${quoteIdent(returnItemsTable)}
                      GROUP BY return_id) rit ON rit.return_id = r.id`
        : '';
      const totalExpr = returnTotalCol
        ? `COALESCE(r.${quoteIdent(returnTotalCol)}, ${returnItemSubCol ? 'rit.total_items' : '0'})`
        : returnItemSubCol
        ? 'rit.total_items'
        : '0';

      const where = [];
      const params = [];
      const ventasExists = await tableExists(null, ventasTable);
      if (cajaId && salesBoxCol && ventasExists) {
        where.push(`v.${quoteIdent(salesBoxCol)} = $${params.length + 1}`);
        params.push(cajaId);
      } else if (returnDateCol && fechaApertura && fechaCierre) {
        where.push(`r.${quoteIdent(returnDateCol)} >= $${params.length + 1}`);
        params.push(fechaApertura);
        where.push(`r.${quoteIdent(returnDateCol)} <= $${params.length + 1}`);
        params.push(fechaCierre);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const joinSales = (salesBoxCol && ventasExists && salesIdCol)
        ? `JOIN ${quoteIdent(ventasTable)} v ON v.${quoteIdent(salesIdCol)} = r.sale_id`
        : '';
      const sql =
        `SELECT COALESCE(SUM(${totalExpr}),0) AS total
         FROM ${quoteIdent(returnsTable)} r
         ${itemsJoin}
         ${joinSales}
         ${whereSql}`;
      const st = await query(sql, params);
      totalDevoluciones = Number(st.rows[0]?.total || 0);
    }
    const manualTable = await pickTable(null, ['sale_returns_manual'], 'sale_returns_manual');
    if (await tableExists(null, manualTable)) {
      const mCols = await getColumns(null, manualTable);
      const amountCol = mCols.includes('amount') ? 'amount' : mCols.includes('monto') ? 'monto' : null;
      const dateCol = mCols.includes('created_at') ? 'created_at' : mCols.includes('fecha') ? 'fecha' : null;
      const branchColManual = mCols.includes('branch_id') ? 'branch_id' : null;
      const cajaColManual = mCols.includes('caja_id') ? 'caja_id' : null;
      if (amountCol) {
        const where = [];
        const params = [];
        if (cajaColManual && cajaId) {
          where.push(`${quoteIdent(cajaColManual)} = $${params.length + 1}`);
          params.push(cajaId);
        } else if (dateCol && fechaApertura && fechaCierre) {
          where.push(`${quoteIdent(dateCol)} >= $${params.length + 1}`);
          params.push(fechaApertura);
          where.push(`${quoteIdent(dateCol)} <= $${params.length + 1}`);
          params.push(fechaCierre);
        }
        if (branchColManual && branchId && !(cajaColManual && cajaId)) {
          where.push(`(${quoteIdent(branchColManual)} = $${params.length + 1} OR ${quoteIdent(branchColManual)} IS NULL)`);
          params.push(branchId);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const st = await query(
          `SELECT COALESCE(SUM(${quoteIdent(amountCol)}),0) AS total FROM ${quoteIdent(manualTable)} ${whereSql}`,
          params
        );
        totalDevolucionesManual = Number(st.rows[0]?.total || 0);
      }
    }
    totalDevoluciones += totalDevolucionesManual;

    const esperado = totalVentas - totalDevoluciones;
    const tol = 0.005;
    let estado = 'CUADRADA';
    if (esperado < 0) {
      estado = 'FALTANTE';
    } else if (Math.abs(montoFinal - esperado) <= tol) {
      estado = 'CUADRADA';
    } else if (montoFinal + tol < esperado) {
      estado = 'FALTANTE';
    } else {
      estado = 'SOBRANTE';
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cierre_caja_${cajaId}.pdf"`);

    const lang = getLang(req);
    const statusMeta = closeStatusMeta(estado, lang);
    const money = (value) => `Q${Number(value || 0).toFixed(2)}`;
    const pageWidth = 396;
    const pageHeight = 612;
    const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0 });
    doc.pipe(res);

    const colors = {
      ink: '#102033',
      muted: '#5b6b81',
      accent: '#1f4b73',
      accentSoft: '#e6eef6',
      border: '#d9e4ee',
      card: '#f8fbff'
    };

    const drawMetricCard = (x, y, w, h, label, value, tone = 'default') => {
      const toneMap = {
        default: { bg: '#f8fbff', value: colors.ink },
        accent: { bg: '#edf4fb', value: colors.accent },
        status: { bg: statusMeta.bg, value: statusMeta.color }
      };
      const palette = toneMap[tone] || toneMap.default;
      doc.save();
      doc.roundedRect(x, y, w, h, 10).fillAndStroke(palette.bg, colors.border);
      doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text(label, x + 12, y + 10, {
        width: w - 24,
        align: 'left'
      });
      doc.fillColor(palette.value).font('Helvetica-Bold').fontSize(13).text(value, x + 12, y + 24, {
        width: w - 24,
        align: 'left'
      });
      doc.restore();
    };

    doc.rect(0, 0, pageWidth, pageHeight).fill('#ffffff');
    doc.rect(0, 0, pageWidth, 92).fill(colors.accent);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(tClose(lang, 'hospital_name'), 28, 22, {
      width: pageWidth - 56,
      align: 'center'
    });
    doc.font('Helvetica').fontSize(9).fillColor('#d8e6f3').text(tClose(lang, 'close_title'), 28, 46, {
      width: pageWidth - 56,
      align: 'center'
    });
    doc.fillColor('#bfd5e6').fontSize(8).text(`${tClose(lang, 'generated')}: ${formatDateLocale(new Date(), lang)}`, 28, 62, {
      width: pageWidth - 56,
      align: 'center'
    });

    doc.roundedRect(20, 102, pageWidth - 40, 86, 14).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text(tClose(lang, 'summary'), 38, 118);
    doc.fillColor(colors.ink).font('Helvetica-Bold').fontSize(15).text(`#${cajaId}`, 38, 132);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8)
      .text(`${tClose(lang, 'opening')}: ${formatDateLocale(fechaApertura, lang)}`, 38, 155, { width: 150 })
      .text(`${tClose(lang, 'close')}: ${formatDateLocale(fechaCierre, lang)}`, 38, 172, { width: 150 });

    doc.roundedRect(248, 120, 108, 44, 12).fill(statusMeta.bg);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text(tClose(lang, 'status'), 248, 128, {
      width: 108,
      align: 'center'
    });
    doc.fillColor(statusMeta.color).font('Helvetica-Bold').fontSize(12).text(statusMeta.label, 248, 141, {
      width: 108,
      align: 'center'
    });

    const startY = 214;
    const leftX = 20;
    const gap = 12;
    const cardW = (pageWidth - 40 - gap) / 2;
    const cardH = 58;
    drawMetricCard(leftX, startY, cardW, cardH, tClose(lang, 'opening_amount'), money(montoInicial));
    drawMetricCard(leftX + cardW + gap, startY, cardW, cardH, tClose(lang, 'total_sales'), money(totalVentas), 'accent');
    drawMetricCard(leftX, startY + cardH + 12, cardW, cardH, tClose(lang, 'returns'), money(totalDevoluciones));
    drawMetricCard(leftX + cardW + gap, startY + cardH + 12, cardW, cardH, tClose(lang, 'net_total'), money(esperado), 'accent');
    drawMetricCard(leftX, startY + (cardH + 12) * 2, cardW, cardH, tClose(lang, 'expected'), money(esperado));
    drawMetricCard(leftX + cardW + gap, startY + (cardH + 12) * 2, cardW, cardH, tClose(lang, 'final_count'), money(montoFinal), 'status');

    const notesY = startY + (cardH + 12) * 3 + 8;
    doc.roundedRect(20, notesY, pageWidth - 40, 110, 12).fillAndStroke(colors.card, colors.border);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(9).text(tClose(lang, 'close_id'), 36, notesY + 14);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(9).text(`#${cajaId}`, 126, notesY + 14);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(9).text(tClose(lang, 'status'), 36, notesY + 34);
    doc.fillColor(statusMeta.color).font('Helvetica-Bold').fontSize(9).text(statusMeta.label, 126, notesY + 34);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(9).text(tClose(lang, 'responsible_user'), 36, notesY + 54);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(9).text(responsibleUser, 126, notesY + 54, {
      width: 150
    });
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(9).text(tClose(lang, 'expected'), 210, notesY + 14);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(9).text(money(esperado), 292, notesY + 14, { width: 68, align: 'right' });
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(9).text(tClose(lang, 'final_count'), 210, notesY + 34);
    doc.fillColor(colors.ink).font('Helvetica').fontSize(9).text(money(montoFinal), 292, notesY + 34, { width: 68, align: 'right' });
    if (Math.abs(totalVentas) <= tol) {
      doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text(tClose(lang, 'no_sales'), 36, notesY + 84, {
        width: pageWidth - 72
      });
    }

    doc.end();
  })
);

module.exports = router;
