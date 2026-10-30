const crypto = require('crypto');
const {
  query,
  tableExists,
  columnExists,
  getColumns,
  insertRow,
  quoteIdent
} = require('./db');
const { canonRole } = require('./helpers');
const { getAuditContext } = require('./utils/auditContext');

let bitacoraColumnsCache = null;
let bitacoraSchemaEnsured = false;
let userAuditColumnInfoCache = null;
const auditUserCache = new Map();

function moneyLabel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `Q${num.toFixed(2)}`;
}

function capitalize(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function safeAuditMeta(meta) {
  if (meta == null) return {};
  if (typeof meta === 'object' && !Array.isArray(meta)) return { ...meta };
  if (Array.isArray(meta)) return { items: meta };
  return { value: meta };
}

function firstDefined(source, keys = []) {
  for (const key of keys) {
    if (source && source[key] != null && source[key] !== '') return source[key];
  }
  return null;
}

function inferAuditEntity(action, meta = {}) {
  if (meta.entity_type || meta.entity_id) {
    return {
      entity_type: meta.entity_type ? String(meta.entity_type) : null,
      entity_id: meta.entity_id != null ? String(meta.entity_id) : null
    };
  }
  const candidates = [
    ['product_id', 'producto'],
    ['component_product_id', 'producto'],
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
  for (const [key, entityType] of candidates) {
    const value = firstDefined(meta, [key]);
    if (value != null) {
      return {
        entity_type: entityType,
        entity_id: String(value)
      };
    }
  }
  const raw = String(action || '').toLowerCase();
  if (raw.startsWith('api_')) {
    return { entity_type: 'api', entity_id: raw.replace(/^api_/, '') || null };
  }
  return { entity_type: null, entity_id: null };
}

function inferAuditModule(action, uri, meta = {}) {
  if (meta.source_module) return String(meta.source_module).trim().toLowerCase();
  const raw = String(action || '').trim().toLowerCase();
  const route = String(uri || '').trim().toLowerCase();
  if (
    raw.startsWith('producto_') ||
    raw.startsWith('transferencia_') ||
    raw.startsWith('merma_') ||
    raw.startsWith('lot_') ||
    raw.startsWith('product_')
  ) {
    return 'inventario';
  }
  if (raw.startsWith('venta_')) return 'ventas';
  if (raw.startsWith('compra_')) return 'compras';
  if (raw.startsWith('caja_')) return 'caja';
  if (raw.startsWith('hospital_')) return 'hospitalizacion';
  if (
    raw === 'login' ||
    raw === 'logout' ||
    raw.includes('contrasena') ||
    raw.includes('password') ||
    raw.includes('usuario')
  ) {
    return 'seguridad';
  }
  if (route.includes('/bitacora') || route.includes('/users') || route.includes('/auth')) {
    return 'seguridad';
  }
  if (raw.startsWith('api_')) return 'api';
  return 'general';
}

function inferAuditSeverity(action, method, meta = {}) {
  if (meta.severity) return String(meta.severity).trim().toLowerCase();
  const raw = String(action || '').trim().toLowerCase();
  const httpMethod = String(method || '').trim().toUpperCase();
  if (
    raw.includes('failed') ||
    raw.includes('error') ||
    raw.includes('bloque') ||
    raw.includes('block') ||
    raw.includes('anulad') ||
    raw.includes('delete') ||
    raw.includes('devuelt') ||
    raw.includes('merma') ||
    raw.includes('cierre') ||
    raw.includes('password') ||
    raw.includes('contrasena')
  ) {
    return 'high';
  }
  if (
    httpMethod === 'DELETE' ||
    httpMethod === 'PATCH' ||
    raw.includes('create') ||
    raw.includes('registr') ||
    raw.includes('confirm') ||
    raw.includes('update') ||
    raw.includes('adjust') ||
    raw.includes('charge') ||
    raw.includes('transfer')
  ) {
    return 'medium';
  }
  return 'low';
}

function humanizeAction(action) {
  const raw = String(action || '').trim().toLowerCase();
  const labels = {
    login: 'Inicio de sesión',
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
    product_created: 'Producto creado',
    product_updated: 'Producto actualizado',
    product_deleted: 'Producto desactivado',
    product_adjusted: 'Ajuste de stock',
    lot_created: 'Lote creado',
    lot_adjusted: 'Lote ajustado',
    lot_deleted: 'Lote eliminado',
    hospital_client_create: 'Paciente creado',
    hospital_client_update: 'Paciente actualizado',
    hospital_admission_create: 'Admisión creada',
    hospital_charge_account: 'Cobro de cuenta hospitalaria',
    hospital_charge_add: 'Cargo hospitalario agregado',
    hospital_charge_delete: 'Cargo hospitalario eliminado',
    hospital_transfer_from_emergency: 'Traslado desde emergencia',
    hospital_admission_close: 'Admisión cerrada',
    user_created: 'Usuario creado',
    user_updated: 'Usuario actualizado',
    user_deactivated: 'Usuario desactivado',
    user_block_changed: 'Bloqueo de usuario actualizado'
  };
  if (labels[raw]) return labels[raw];
  return capitalize(raw.replace(/_/g, ' '));
}

function inferAuditSummary(action, meta = {}, entity = {}) {
  if (meta.summary) return String(meta.summary);
  const parts = [humanizeAction(action)];
  if (entity.entity_type && entity.entity_id) {
    parts.push(`${capitalize(entity.entity_type)} #${entity.entity_id}`);
  }
  const name = firstDefined(meta, ['nombre_comercial', 'nombre', 'username', 'description']);
  if (name) parts.push(String(name));
  const total = firstDefined(meta, ['total', 'amount', 'monto', 'total_return']);
  const totalLabel = moneyLabel(total);
  if (totalLabel) parts.push(totalLabel);
  return parts.filter(Boolean).join(' · ');
}

async function ensureBitacoraSchema(db) {
  if (bitacoraSchemaEnsured) return true;
  if (!(await tableExists(db, 'bitacora'))) return false;
  const alterStatements = [
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS user_id BIGINT NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS user_role VARCHAR(60) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS request_id VARCHAR(80) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS event_source VARCHAR(30) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS source_module VARCHAR(80) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS entity_type VARCHAR(80) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS entity_id VARCHAR(80) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS branch_id BIGINT NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS branch_name VARCHAR(150) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS status VARCHAR(40) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS ip_address VARCHAR(80) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS http_method VARCHAR(12) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS uri TEXT NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS user_agent VARCHAR(255) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS session_id VARCHAR(150) NULL',
    'ALTER TABLE bitacora ADD COLUMN IF NOT EXISTS summary TEXT NULL'
  ];
  for (const statement of alterStatements) {
    try {
      await query(statement, [], db);
    } catch (_) {}
  }
  const indexStatements = [
    'CREATE INDEX IF NOT EXISTS idx_bitacora_user_id ON bitacora(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_request_id ON bitacora(request_id)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_source_module ON bitacora(source_module)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_entity_type ON bitacora(entity_type)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_entity_id ON bitacora(entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_branch_id ON bitacora(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_bitacora_severity ON bitacora(severity)'
  ];
  for (const statement of indexStatements) {
    try {
      await query(statement, [], db);
    } catch (_) {}
  }
  bitacoraColumnsCache = null;
  bitacoraSchemaEnsured = true;
  return true;
}

async function getBitacoraColumns(db) {
  if (bitacoraColumnsCache) return bitacoraColumnsCache;
  if (!(await ensureBitacoraSchema(db))) return null;
  const cols = await getColumns(db, 'bitacora');
  bitacoraColumnsCache = new Set(cols);
  return bitacoraColumnsCache;
}

async function getUserAuditColumnInfo(db) {
  if (userAuditColumnInfoCache) return userAuditColumnInfoCache;
  if (!(await tableExists(db, 'users'))) return null;
  const cols = await getColumns(db, 'users');
  userAuditColumnInfoCache = {
    usernameCol: cols.includes('username') ? 'username' : cols.includes('usuario') ? 'usuario' : null,
    roleCol: cols.includes('rol') ? 'rol' : cols.includes('role') ? 'role' : null
  };
  return userAuditColumnInfoCache;
}

async function resolveAuditUser(db, userId) {
  const normalizedId = Number(userId || 0);
  if (!normalizedId) return null;
  if (auditUserCache.has(normalizedId)) return auditUserCache.get(normalizedId);
  const info = await getUserAuditColumnInfo(db);
  if (!info || !info.usernameCol) return null;
  const select = [`${quoteIdent(info.usernameCol)} AS username`];
  if (info.roleCol) select.push(`${quoteIdent(info.roleCol)} AS user_role`);
  const st = await query(
    `SELECT ${select.join(', ')} FROM users WHERE id = $1 LIMIT 1`,
    [normalizedId],
    db
  );
  const row = st.rows[0];
  const resolved = row
    ? {
        username: row.username ? String(row.username).trim() : null,
        user_role: canonRole(row.user_role || '')
      }
    : null;
  auditUserCache.set(normalizedId, resolved);
  return resolved;
}

async function logAction(db, userId, action, meta = {}) {
  try {
    const cols = await getBitacoraColumns(db);
    if (!cols) return;
    const context = getAuditContext() || {};
    const metaPayload = safeAuditMeta(meta);
    const resolvedUser = await resolveAuditUser(db, userId);
    const username =
      firstDefined(metaPayload, ['username']) ||
      context.username ||
      resolvedUser?.username ||
      (userId != null ? `user:${userId}` : 'sistema');
    const userRole = canonRole(
      firstDefined(metaPayload, ['role', 'user_role']) ||
        context.user_role ||
        resolvedUser?.user_role ||
        ''
    );
    const branchId = firstDefined(metaPayload, ['branch_id', 'sucursal_id', 'branch']);
    const branchName = firstDefined(metaPayload, ['branch_name', 'sucursal', 'branch_label']);
    const entity = inferAuditEntity(action, metaPayload);
    const httpMethod =
      firstDefined(metaPayload, ['method', 'http_method']) ||
      context.method ||
      null;
    const uri = firstDefined(metaPayload, ['uri']) || context.uri || null;
    const ipAddress =
      firstDefined(metaPayload, ['ip', 'ip_address']) ||
      context.ip_address ||
      null;
    const requestId =
      firstDefined(metaPayload, ['request_id']) ||
      context.request_id ||
      null;
    const sourceModule = inferAuditModule(action, uri, metaPayload);
    const severity = inferAuditSeverity(action, httpMethod, metaPayload);
    const status =
      firstDefined(metaPayload, ['status', 'result']) ||
      'ok';
    const summary = inferAuditSummary(action, metaPayload, entity);

    const data = {};

    if (cols.has('user_id')) data.user_id = userId;
    if (cols.has('usuario')) data.usuario = username || 'sistema';
    if (cols.has('user_role')) data.user_role = userRole || null;

    if (cols.has('accion')) {
      data.accion = action;
    } else if (cols.has('action')) {
      data.action = action;
    }

    const detailPayload = {
      ...metaPayload,
      request_id: requestId,
      ip_address: ipAddress,
      http_method: httpMethod,
      uri,
      source_module: sourceModule,
      entity_type: entity.entity_type,
      entity_id: entity.entity_id,
      branch_id: branchId != null ? Number(branchId) || branchId : null,
      branch_name: branchName || null,
      severity,
      status,
      username: username || null,
      user_role: userRole || null
    };
    const metaStr = JSON.stringify(detailPayload);
    if (cols.has('meta')) {
      data.meta = metaStr;
    } else if (cols.has('detalles')) {
      data.detalles = metaStr;
    } else if (cols.has('details')) {
      data.details = metaStr;
    }

    if (cols.has('fecha')) {
      data.fecha = new Date();
    } else if (cols.has('created_at')) {
      data.created_at = new Date();
    }

    if (cols.has('request_id')) data.request_id = requestId;
    if (cols.has('event_source')) data.event_source = 'app';
    if (cols.has('source_module')) data.source_module = sourceModule;
    if (cols.has('entity_type')) data.entity_type = entity.entity_type;
    if (cols.has('entity_id')) data.entity_id = entity.entity_id;
    if (cols.has('branch_id')) data.branch_id = branchId != null ? Number(branchId) || null : null;
    if (cols.has('branch_name')) data.branch_name = branchName || null;
    if (cols.has('status')) data.status = status;
    if (cols.has('severity')) data.severity = severity;
    if (cols.has('ip_address')) data.ip_address = ipAddress;
    if (cols.has('http_method')) data.http_method = httpMethod;
    if (cols.has('uri')) data.uri = uri;
    if (cols.has('user_agent')) data.user_agent = context.user_agent || null;
    if (cols.has('session_id')) data.session_id = context.session_id || null;
    if (cols.has('summary')) data.summary = summary;

    await insertRow(db, 'bitacora', data);
  } catch (_) {}
}

let productStocksCache = null;

async function productStocksAvailable(db) {
  if (productStocksCache !== null) {
    return productStocksCache;
  }
  productStocksCache = await tableExists(db, 'product_stocks');
  return productStocksCache;
}

async function ensureBranchStockRow(db, productId, branchId) {
  if (!(await productStocksAvailable(db))) return;
  await query(
    'INSERT INTO product_stocks (product_id, branch_id, stock) VALUES ($1,$2,0) ON CONFLICT (product_id, branch_id) DO NOTHING',
    [productId, branchId],
    db
  );
}

async function adjustBranchStock(db, productId, branchId, delta) {
  if (!(await productStocksAvailable(db))) {
    await query(
      'UPDATE productos SET stock = GREATEST(0, stock + $1) WHERE id = $2',
      [delta, productId],
      db
    );
    return;
  }
  await ensureBranchStockRow(db, productId, branchId);
  await query(
    'UPDATE product_stocks SET stock = CASE WHEN stock + $1 < 0 THEN 0 ELSE stock + $1 END, updated_at = NOW() WHERE product_id = $2 AND branch_id = $3',
    [delta, productId, branchId],
    db
  );
  try {
    await query(
      'UPDATE productos SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_stocks WHERE product_id = $1) WHERE id = $1',
      [productId],
      db
    );
  } catch (_) {}
}

async function getBranchStock(db, productId, branchId) {
  if (!(await productStocksAvailable(db))) {
    const res = await query('SELECT stock FROM productos WHERE id = $1', [productId], db);
    return res.rows[0] ? Number(res.rows[0].stock) : 0;
  }
  const res = await query(
    'SELECT stock FROM product_stocks WHERE product_id = $1 AND branch_id = $2',
    [productId, branchId],
    db
  );
  return res.rows[0] ? Number(res.rows[0].stock) : 0;
}

const branchCache = new Map();
let branchesCache = null;

async function branchNameCached(db, branchId) {
  if (!branchId || branchId <= 0) return null;
  if (branchCache.has(branchId)) return branchCache.get(branchId);
  const res = await query('SELECT name FROM branches WHERE id = $1', [branchId], db);
  const name = res.rows[0] ? String(res.rows[0].name) : null;
  branchCache.set(branchId, name);
  return name;
}

function normalizeBranchLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function branchesCached(db) {
  if (branchesCache) return branchesCache;
  const res = await query('SELECT id, name FROM branches ORDER BY id', [], db);
  branchesCache = (res.rows || []).map((row) => ({
    id: row.id != null ? Number(row.id) : null,
    name: row.name != null ? String(row.name) : ''
  }));
  return branchesCache;
}

async function branchIdByHint(db, hint) {
  const needle = normalizeBranchLabel(hint);
  if (!needle) return null;
  try {
    const branches = await branchesCached(db);
    const match = branches.find((row) => normalizeBranchLabel(row.name).includes(needle));
    return match && match.id ? Number(match.id) : null;
  } catch (_) {
    return null;
  }
}

function branchLabelContains(name, needle) {
  if (!name) return false;
  return String(name).toLowerCase().includes(String(needle).toLowerCase());
}

async function branchIsHospital(db, branchId) {
  if (!branchId) return false;
  const name = await branchNameCached(db, branchId);
  return branchLabelContains(name, 'hospital');
}

async function branchAllowedForRole(db, branchId, role) {
  if (!branchId) return true;
  const name = await branchNameCached(db, branchId);
  if (!name) return true;
  const r = String(role || '').toLowerCase();
  const isHospital = branchLabelContains(name, 'hospital');
  const isPrincipal = branchLabelContains(name, 'principal');
  const isEmergencia = branchLabelContains(name, 'emergencia');
  if (r === 'cashierh') return isHospital || isPrincipal || isEmergencia;
  if (r === 'cashier' || r === 'farmacia') return (isPrincipal || isEmergencia) && !isHospital;
  return true;
}

async function ensureResetToken(db, userId, ttlHours = 24) {
  const res = await query(
    'SELECT token_recuperacion, token_expiry FROM users WHERE id = $1',
    [userId],
    db
  );
  const row = res.rows[0] || {};
  const now = new Date();
  if (row.token_recuperacion && row.token_expiry) {
    const exp = new Date(row.token_expiry);
    if (exp > now) {
      return [row.token_recuperacion, exp.toISOString().slice(0, 19).replace('T', ' ')];
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(now.getTime() + Math.max(ttlHours, 1) * 3600 * 1000);
  await query(
    'UPDATE users SET token_recuperacion = $1, token_expiry = $2 WHERE id = $3',
    [token, expiry, userId],
    db
  );
  return [token, expiry.toISOString().slice(0, 19).replace('T', ' ')];
}

module.exports = {
  logAction,
  productStocksAvailable,
  ensureBranchStockRow,
  adjustBranchStock,
  getBranchStock,
  branchNameCached,
  branchIdByHint,
  branchLabelContains,
  branchIsHospital,
  branchAllowedForRole,
  ensureResetToken,
  columnExists
};
