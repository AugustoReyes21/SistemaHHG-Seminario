const express = require('express');
const XLSX = require('xlsx-js-style');
const bcrypt = require('bcryptjs');
const { query, withTransaction, tableExists, columnExists, pickTable, pickColumn, getColumns, quoteIdent } = require('../db');
const { safeJson, readJson } = require('../helpers');
const { canonRole } = require('../helpers');
const { requireRole } = require('../auth');
const { branchAllowedForRole, logAction } = require('../functions');
const { autoEntryForCashClose } = require('../accounting');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

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

function normalizeHash(hash) {
  if (!hash) return '';
  if (String(hash).startsWith('$2y$')) return `$2b$${String(hash).slice(4)}`;
  return String(hash);
}

async function verifyPassword(plain, hash) {
  const normalized = normalizeHash(hash);
  try {
    if (normalized.startsWith('$2')) {
      return await bcrypt.compare(plain, normalized);
    }
  } catch (_) {}
  return String(plain || '') === String(hash || '');
}

async function validateCashCloseAdmin(db, username, password) {
  const userTable = await pickTable(db, ['users', 'usuarios'], 'users');
  if (!(await tableExists(db, userTable))) {
    return { ok: false, error: 'No se encontró la tabla de usuarios para validar el cierre.' };
  }
  const cols = await getColumns(db, userTable);
  const usernameCol = cols.includes('username') ? 'username' : cols.includes('usuario') ? 'usuario' : null;
  const passwordCol = cols.includes('password') ? 'password' : cols.includes('clave') ? 'clave' : null;
  const roleCol = cols.includes('rol') ? 'rol' : cols.includes('role') ? 'role' : null;
  const activeCol = cols.includes('activo') ? 'activo' : cols.includes('active') ? 'active' : null;
  const blockedCol = cols.includes('blocked') ? 'blocked' : cols.includes('bloqueado') ? 'bloqueado' : null;
  if (!usernameCol || !passwordCol || !roleCol) {
    return { ok: false, error: 'No se pudieron validar las credenciales del administrador.' };
  }
  const adminRes = await query(
    `SELECT id, ${quoteIdent(usernameCol)} AS username, ${quoteIdent(passwordCol)} AS password, ${quoteIdent(roleCol)} AS role` +
      (activeCol ? `, ${quoteIdent(activeCol)} AS active` : ', NULL AS active') +
      (blockedCol ? `, ${quoteIdent(blockedCol)} AS blocked` : ', NULL AS blocked') +
      ` FROM ${quoteIdent(userTable)} WHERE LOWER(${quoteIdent(usernameCol)}) = LOWER($1) LIMIT 1`,
    [String(username || '').trim()],
    db
  );
  const admin = adminRes.rows[0];
  if (!admin) return { ok: false, error: 'Credenciales de administrador inválidas' };
  const role = canonRole(admin.role || 'user');
  if (!['admin', 'administrador', 'superadmin'].includes(role)) {
    return { ok: false, error: 'El usuario ingresado no tiene permisos de administrador' };
  }
  if (activeCol && Number(admin.active) !== 1) {
    return { ok: false, error: 'La cuenta del administrador está inactiva' };
  }
  if (blockedCol && Number(admin.blocked || 0) === 1) {
    return { ok: false, error: 'La cuenta del administrador está bloqueada' };
  }
  const ok = await verifyPassword(String(password || ''), admin.password);
  if (!ok) return { ok: false, error: 'Credenciales de administrador inválidas' };
  return { ok: true, adminId: Number(admin.id), username: admin.username || '' };
}

function getCashCloseAuthFromSession(req) {
  const auth = req.session?.cash_close_auth || null;
  if (!auth || !auth.adminId || !auth.username || !auth.authorizedAt) return null;
  const ageMs = Date.now() - Number(auth.authorizedAt || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60 * 1000) return null;
  return {
    adminId: Number(auth.adminId),
    username: String(auth.username || '')
  };
}

async function saveCashCloseAuth(req, auth) {
  if (!req.session) return;
  req.session.cash_close_auth = {
    adminId: Number(auth.adminId || 0),
    username: String(auth.username || ''),
    authorizedAt: Date.now()
  };
  await new Promise((resolve) => req.session.save(() => resolve()));
}

async function clearCashCloseAuth(req) {
  if (!req.session) return;
  delete req.session.cash_close_auth;
  await new Promise((resolve) => req.session.save(() => resolve()));
}

function buildCashShiftWorkbook(shifts, totals, label) {
  const wb = XLSX.utils.book_new();
  const shiftRows = [
    [
      'ID',
      'Apertura',
      'Cierre',
      'Cajero',
      'Sucursal',
      'Monto inicial',
      'Total ventas',
      'Monto final',
      'Diferencia',
      'Estado'
    ]
  ];
  for (const r of shifts || []) {
    const total = Number(r.total_ventas || 0);
    const mf = r.monto_final != null ? Number(r.monto_final) : null;
    const diff = r.diferencia != null ? Number(r.diferencia) : (mf != null ? mf - total : 0);
    shiftRows.push([
      r.id || '',
      r.fecha_apertura || '',
      r.fecha_cierre || '',
      r.cajero || r.user_id || '',
      r.sucursal || r.branch_id || '',
      Number(r.monto_inicial || 0),
      total,
      mf != null ? mf : '',
      diff,
      r.estado || ''
    ]);
  }
  const wsShifts = XLSX.utils.aoa_to_sheet(shiftRows);
  XLSX.utils.book_append_sheet(wb, wsShifts, 'Turnos');

  const totalRows = [['Cajero', 'Ventas', 'Total']];
  for (const r of totals || []) {
    totalRows.push([r.cajero || r.user_id || '', Number(r.ventas || 0), Number(r.total || 0)]);
  }
  const wsTotals = XLSX.utils.aoa_to_sheet(totalRows);
  XLSX.utils.book_append_sheet(wb, wsTotals, 'Ventas por Cajero');

  const wsInfo = XLSX.utils.aoa_to_sheet([['Reporte'], [label || '']]);
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Info');
  return wb;
}

async function fetchCashShiftData(req) {
  const role = canonRole(req.session.user.rol || req.session.user.role || '');
  const startRaw = String(req.query.start || req.query.from || '').trim();
  const endRaw = String(req.query.end || req.query.to || '').trim();
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : null;
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
  const branchId = req.query.branch_id != null ? Number(req.query.branch_id) : null;
  const requestedUserId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const sessionUserId = req.session.user.id || null;

  if (branchId && !(await branchAllowedForRole(null, branchId, role))) {
    return { error: 'Sucursal no permitida', status: 403 };
  }

  const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
  if (!(await tableExists(null, cajaTable))) {
    return { ok: true, shifts: [], cashier_totals: [], startDate, endDate };
  }

  const cajaCols = await getColumns(null, cajaTable);
  const fechaAperturaCol = cajaCols.includes('fecha_apertura')
    ? 'fecha_apertura'
    : cajaCols.includes('fecha')
    ? 'fecha'
    : cajaCols.includes('created_at')
    ? 'created_at'
    : null;
  const fechaCierreCol = cajaCols.includes('fecha_cierre') ? 'fecha_cierre' : null;
  const montoInicialCol = cajaCols.includes('monto_inicial')
    ? 'monto_inicial'
    : cajaCols.includes('monto_apertura')
    ? 'monto_apertura'
    : null;
  const montoFinalCol = cajaCols.includes('monto_final')
    ? 'monto_final'
    : cajaCols.includes('monto_cierre')
    ? 'monto_cierre'
    : null;
  const totalVentasCol = cajaCols.includes('total_ventas') ? 'total_ventas' : null;
  const diferenciaCol = cajaCols.includes('diferencia') ? 'diferencia' : null;
  const estadoCol = cajaCols.includes('estado') ? 'estado' : null;
  const userCol = cajaCols.includes('user_id') ? 'user_id' : null;
  const branchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;

  const ventasTable = await pickTable(null, ['ventas', 'sales'], 'ventas');
  const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);
  const salesIdCol = await pickColumn(null, ventasTable, ['id', 'venta_id', 'sale_id'], 'id');
  const salesTotalCol = await pickColumn(
    null,
    ventasTable,
    ['total', 'monto_total', 'importe_total', 'amount_total', 'monto', 'importe'],
    'total'
  );
  const salesDateCol = await pickColumn(null, ventasTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
  const salesUserCol = await pickColumn(null, ventasTable, ['usuario_id', 'user_id', 'cajero_id'], null);
  const salesBranchCol = await pickColumn(null, ventasTable, ['branch_id', 'sucursal_id'], null);

  let filterUserId = requestedUserId || null;
  if (!['admin', 'administrador', 'contabilidad', 'superadmin'].includes(role)) {
    filterUserId = sessionUserId;
  }

  const params = [];
  const where = [];
  if (fechaAperturaCol && startDate) {
    where.push(`c.${fechaAperturaCol} >= $${params.length + 1}::date`);
    params.push(startDate);
  }
  if (fechaAperturaCol && endDate) {
    where.push(`c.${fechaAperturaCol} < ($${params.length + 1}::date + interval '1 day')`);
    params.push(endDate);
  }
  if (userCol && filterUserId) {
    where.push(`c.${userCol} = $${params.length + 1}`);
    params.push(filterUserId);
  }
  if (branchCol && branchId) {
    where.push(`c.${branchCol} = $${params.length + 1}`);
    params.push(branchId);
  }

  const select = [
    'c.id',
    fechaAperturaCol ? `c.${fechaAperturaCol} AS fecha_apertura` : 'NULL AS fecha_apertura',
    fechaCierreCol ? `c.${fechaCierreCol} AS fecha_cierre` : 'NULL AS fecha_cierre',
    montoInicialCol ? `c.${montoInicialCol} AS monto_inicial` : '0 AS monto_inicial',
    montoFinalCol ? `c.${montoFinalCol} AS monto_final` : 'NULL AS monto_final',
    diferenciaCol ? `c.${diferenciaCol} AS diferencia` : 'NULL AS diferencia',
    estadoCol ? `c.${estadoCol} AS estado` : "'' AS estado",
    userCol ? `c.${userCol} AS user_id` : 'NULL AS user_id',
    branchCol ? `c.${branchCol} AS branch_id` : 'NULL AS branch_id'
  ];

  if (salesBoxCol && salesTotalCol) {
    select.push(
      `(SELECT COALESCE(SUM(v.${salesTotalCol}),0) FROM ${ventasTable} v WHERE v.${salesBoxCol} = c.id) AS total_ventas`
    );
  } else if (totalVentasCol) {
    select.push(`c.${totalVentasCol} AS total_ventas`);
  } else {
    select.push('0 AS total_ventas');
  }

  let sql =
    `SELECT ${select.join(', ')}, u.username AS cajero, b.name AS sucursal ` +
    `FROM ${cajaTable} c ` +
    (userCol ? 'LEFT JOIN users u ON u.id = c.user_id ' : 'LEFT JOIN users u ON 1=0 ') +
    (branchCol ? 'LEFT JOIN branches b ON b.id = c.branch_id ' : 'LEFT JOIN branches b ON 1=0 ');
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY c.id DESC LIMIT 500';
  const shiftsRes = await query(sql, params);

  // Ajuste de devoluciones por cierre (para diferencia neta)
  const returnsByCaja = new Map();
  const cajaIds = (shiftsRes.rows || []).map((r) => Number(r.id || 0)).filter((id) => id > 0);
  if (cajaIds.length) {
    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    const returnsExists = await tableExists(null, returnsTable);
    if (returnsExists && salesBoxCol) {
      const returnCols = await getColumns(null, returnsTable);
      const returnTotalCol = returnCols.includes('total_return')
        ? 'total_return'
        : returnCols.includes('total')
        ? 'total'
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
      if (totalExpr !== '0') {
        const rs = await query(
          `SELECT v.${quoteIdent(salesBoxCol)} AS caja_id, COALESCE(SUM(${totalExpr}),0) AS total
           FROM ${quoteIdent(returnsTable)} r
           ${itemsJoin}
           JOIN ${quoteIdent(ventasTable)} v ON v.${quoteIdent(salesIdCol)} = r.sale_id
           WHERE v.${quoteIdent(salesBoxCol)} = ANY($1)
           GROUP BY v.${quoteIdent(salesBoxCol)}`,
          [cajaIds]
        );
        for (const row of rs.rows || []) {
          returnsByCaja.set(Number(row.caja_id), Number(row.total || 0));
        }
      }
    }

    const manualTable = await pickTable(null, ['sale_returns_manual'], 'sale_returns_manual');
    const manualExists = await tableExists(null, manualTable);
    if (manualExists && fechaAperturaCol && fechaCierreCol) {
      const mCols = await getColumns(null, manualTable);
      const amountCol = mCols.includes('amount') ? 'amount' : mCols.includes('monto') ? 'monto' : null;
      const dateCol = mCols.includes('created_at') ? 'created_at' : mCols.includes('fecha') ? 'fecha' : null;
      const branchCol = mCols.includes('branch_id') ? 'branch_id' : null;
      if (amountCol && dateCol) {
        const ms = await query(
          `SELECT c.id AS caja_id, COALESCE(SUM(m.${quoteIdent(amountCol)}),0) AS total
           FROM ${quoteIdent(cajaTable)} c
           JOIN ${quoteIdent(manualTable)} m
             ON m.${quoteIdent(dateCol)} >= c.${quoteIdent(fechaAperturaCol)}
            AND m.${quoteIdent(dateCol)} <= COALESCE(c.${quoteIdent(fechaCierreCol)}, NOW())
            ${branchCol ? `AND (m.${quoteIdent(branchCol)} = c.${quoteIdent(branchCol)} OR m.${quoteIdent(branchCol)} IS NULL)` : ''}
           WHERE c.id = ANY($1)
           GROUP BY c.id`,
          [cajaIds]
        );
        for (const row of ms.rows || []) {
          const prev = returnsByCaja.get(Number(row.caja_id)) || 0;
          returnsByCaja.set(Number(row.caja_id), prev + Number(row.total || 0));
        }
      }
    }
  }

  const totals = [];
  if (await tableExists(null, ventasTable)) {
    const w2 = [];
    const p2 = [];
    if (salesDateCol && startDate) {
      w2.push(`v.${salesDateCol} >= $${p2.length + 1}::date`);
      p2.push(startDate);
    }
    if (salesDateCol && endDate) {
      w2.push(`v.${salesDateCol} < ($${p2.length + 1}::date + interval '1 day')`);
      p2.push(endDate);
    }
    if (salesUserCol && filterUserId) {
      w2.push(`v.${salesUserCol} = $${p2.length + 1}`);
      p2.push(filterUserId);
    }
    if (salesBranchCol && branchId) {
      w2.push(`v.${salesBranchCol} = $${p2.length + 1}`);
      p2.push(branchId);
    }
    if (salesUserCol && salesTotalCol) {
      let tSql =
        `SELECT v.${salesUserCol} AS user_id, u.username AS cajero, COUNT(*) AS ventas, ` +
        `COALESCE(SUM(v.${salesTotalCol}),0) AS total ` +
        `FROM ${ventasTable} v ` +
        `LEFT JOIN users u ON u.id = v.${salesUserCol} `;
      if (w2.length) tSql += `WHERE ${w2.join(' AND ')} `;
      tSql += `GROUP BY v.${salesUserCol}, u.username ORDER BY total DESC`;
      const tRes = await query(tSql, p2);
      for (const r of tRes.rows || []) totals.push(r);
    }
  }

  const shifts = (shiftsRes.rows || []).map((row) => {
    const total = Number(row.total_ventas || 0);
    const devol = returnsByCaja.get(Number(row.id)) || 0;
    const neto = total - devol;
    const mf = row.monto_final != null ? Number(row.monto_final) : null;
    const diff = mf != null ? mf - neto : (row.diferencia != null ? Number(row.diferencia) : null);
    const tol = 0.005;
    let estado = row.estado || '';
    if (diff != null && Number.isFinite(diff)) {
      if (Math.abs(diff) <= tol) estado = 'CUADRADA';
      else if (diff < 0) estado = 'FALTANTE';
      else estado = 'SOBRANTE';
    }
    return {
      ...row,
      total_ventas: neto,
      devoluciones_ventas: devol,
      diferencia: diff,
      estado
    };
  });

  return { ok: true, shifts, cashier_totals: totals, startDate, endDate };
}

router.post(
  '/cash_open',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);
    if (!['admin', 'cashier', 'cashierh', 'cashiee', 'farmacia', 'superadmin'].includes(userRole)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }
    const userId = req.session.user.id || null;
    if (!userId) return safeJson(res, { ok: false, error: 'Usuario inválido' }, 403);

    const input = readJson(req);
    const monto = input.monto_inicial != null ? Number(input.monto_inicial) : Number(input.monto_apertura || 0);
    const branchId = input.branch_id != null ? Number(input.branch_id) : null;
    if (!branchId) return safeJson(res, { ok: false, error: 'Seleccione sucursal para abrir caja' }, 400);

    if (!(await branchAllowedForRole(null, branchId, userRole))) {
      const msg =
        userRole === 'cashierh'
          ? 'Su rol sólo permite cajas de Hospitalización'
          : 'Su rol sólo permite cajas en Principal o Emergencia';
      return safeJson(res, { ok: false, error: msg }, 403);
    }

    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    if (!(await tableExists(null, cajaTable))) {
      await query(
        `CREATE TABLE IF NOT EXISTS ${cajaTable} (
          id SERIAL PRIMARY KEY,
          fecha_apertura TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_cierre TIMESTAMP NULL,
          monto_inicial DECIMAL(12,2) DEFAULT 0,
          monto_final DECIMAL(12,2) NULL,
          estado VARCHAR(20) DEFAULT 'ABIERTA',
          total_ventas DECIMAL(12,2) DEFAULT 0
        )`
      );
    }

    const cols = await getColumns(null, cajaTable);
    const estadoCol = cols.includes('estado') ? 'estado' : null;
    const fechaAperturaCol = cols.includes('fecha_apertura') ? 'fecha_apertura' : cols.includes('fecha') ? 'fecha' : null;
    const fechaCierreCol = cols.includes('fecha_cierre') ? 'fecha_cierre' : null;
    const montoInicialCol = cols.includes('monto_inicial')
      ? 'monto_inicial'
      : cols.includes('monto_apertura')
      ? 'monto_apertura'
      : null;
    const totalVentasCol = cols.includes('total_ventas') ? 'total_ventas' : null;
    const userCol = cols.includes('user_id') ? 'user_id' : null;
    const branchCol = cols.includes('branch_id') ? 'branch_id' : null;

    const where = [];
    const params = [];
    if (fechaCierreCol) where.push(`(${fechaCierreCol} IS NULL)`);
    if (estadoCol) where.push(`(${estadoCol} IS NULL OR ${estadoCol} <> 'CERRADA')`);
    if (userCol) {
      where.push(`${userCol} = $${params.length + 1}`);
      params.push(userId);
    }
    if (branchCol) {
      where.push(`${branchCol} = $${params.length + 1}`);
      params.push(branchId);
    }
    const sqlOpen = `SELECT id FROM ${cajaTable} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`;
    const st = await query(sqlOpen, params);
    if (st.rows[0]) {
      return safeJson(res, { ok: false, error: 'Ya existe una caja abierta' }, 400);
    }

    const dataCols = [];
    const dataVals = [];
    if (fechaAperturaCol) {
      dataCols.push(fechaAperturaCol);
      dataVals.push(new Date());
    }
    if (montoInicialCol) {
      dataCols.push(montoInicialCol);
      dataVals.push(monto);
    }
    if (estadoCol) {
      dataCols.push(estadoCol);
      dataVals.push('ABIERTA');
    }
    if (totalVentasCol) {
      dataCols.push(totalVentasCol);
      dataVals.push(0);
    }
    if (userCol) {
      dataCols.push(userCol);
      dataVals.push(userId);
    }
    if (branchCol) {
      dataCols.push(branchCol);
      dataVals.push(branchId);
    }

    const placeholders = dataCols.map((_, idx) => `$${idx + 1}`).join(',');
    const ins = await query(
      `INSERT INTO ${cajaTable} (${dataCols.join(',')}) VALUES (${placeholders}) RETURNING id`,
      dataVals
    );
    const idCaja = Number(ins.rows[0].id);

    await logAction(null, userId, 'caja_apertura', {
      caja_id: idCaja,
      branch_id: branchId,
      monto_inicial: monto,
      ip: req.ip || null
    });

    return safeJson(res, {
      ok: true,
      caja: {
        id: idCaja,
        fecha_apertura: fechaAperturaCol ? dataVals[dataCols.indexOf(fechaAperturaCol)] : new Date(),
        monto_inicial: monto,
        total_ventas: 0,
        monto_final: null,
        branch_id: branchId
      }
    });
  })
);

router.get(
  '/current_caja',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    const currentUserId = req.session.user.id || null;
    const branchFilter = req.query.branch_id ? Number(req.query.branch_id) : null;
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);

    if (branchFilter && !(await branchAllowedForRole(null, branchFilter, userRole))) {
      return safeJson(res, { ok: true, caja: null });
    }

    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    const ventasTable = await pickTable(null, ['ventas', 'sales'], 'ventas');

    if (!(await tableExists(null, cajaTable))) {
      return safeJson(res, { ok: true, caja: null });
    }

    const cols = await getColumns(null, cajaTable);
    const fechaAperCol = cols.includes('fecha_apertura') ? 'fecha_apertura' : cols.includes('fecha') ? 'fecha' : null;
    const fechaCierreCol = cols.includes('fecha_cierre') ? 'fecha_cierre' : null;
    const userCol = cols.includes('user_id') ? 'user_id' : null;
    const branchCol = cols.includes('branch_id') ? 'branch_id' : null;

    const where = [];
    const params = [];
    if (fechaCierreCol) where.push(`(${fechaCierreCol} IS NULL)`);
    if (cols.includes('estado')) where.push("(estado='ABIERTA' OR estado IS NULL)");
    if (userCol && currentUserId) {
      where.push(`${userCol} = $${params.length + 1}`);
      params.push(currentUserId);
    }
    if (branchCol && branchFilter) {
      where.push(`${branchCol} = $${params.length + 1}`);
      params.push(branchFilter);
    }
    const sql = `SELECT * FROM ${cajaTable} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`;
    const st = await query(sql, params);
    const caja = st.rows[0];
    if (!caja) return safeJson(res, { ok: true, caja: null });

    let totalVentas = null;
    const salesTotalCol = await pickColumn(
      null,
      ventasTable,
      ['total', 'monto_total', 'importe_total', 'amount_total'],
      'total'
    );
    const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);
    if (salesBoxCol && caja.id && salesTotalCol) {
      const st2 = await query(
        `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE ${salesBoxCol} = $1`,
        [caja.id]
      );
      totalVentas = Number(st2.rows[0]?.tot || 0);
    }
    if (totalVentas == null && caja.total_ventas != null) {
      totalVentas = Number(caja.total_ventas);
    }
    if (totalVentas == null) {
      const salesDateCol = await pickColumn(null, ventasTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
      const salesUserCol = await pickColumn(null, ventasTable, ['usuario_id', 'user_id', 'cajero_id'], null);
      if (fechaAperCol && salesDateCol && salesTotalCol) {
        let sqlVentas = `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE ${salesDateCol} >= $1`;
        const paramsVentas = [caja[fechaAperCol]];
        if (salesUserCol && currentUserId) {
          sqlVentas += ` AND ${salesUserCol} = $2`;
          paramsVentas.push(currentUserId);
        }
        const st2 = await query(sqlVentas, paramsVentas);
        totalVentas = Number(st2.rows[0]?.tot || 0);
      } else {
        totalVentas = 0;
      }
    }

    const resp = {
      id: Number(caja.id),
      fecha_apertura: fechaAperCol ? caja[fechaAperCol] : null,
      monto_inicial:
        caja.monto_apertura != null
          ? Number(caja.monto_apertura)
          : caja.monto_inicial != null
          ? Number(caja.monto_inicial)
          : 0,
      total_ventas: totalVentas,
      monto_final:
        caja.monto_final != null
          ? Number(caja.monto_final)
          : caja.monto_cierre != null
          ? Number(caja.monto_cierre)
          : null,
      branch_id: branchCol && caja[branchCol] != null ? Number(caja[branchCol]) : null
    };

    if (resp.branch_id && !(await branchAllowedForRole(null, resp.branch_id, userRole))) {
      return safeJson(res, { ok: true, caja: null });
    }

    return safeJson(res, { ok: true, caja: resp });
  })
);

router.post(
  '/cash_close_authorize',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);
    if (!['user', 'cashier', 'cashierh', 'cashiee', 'admin', 'farmacia', 'superadmin'].includes(userRole)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }

    const input = readJson(req);
    const adminUsername = String(
      input.admin_username != null ? input.admin_username : input.admin_user != null ? input.admin_user : ''
    ).trim();
    const adminPassword = String(
      input.admin_password != null ? input.admin_password : input.admin_pass != null ? input.admin_pass : ''
    );

    if (!adminUsername || !adminPassword) {
      return safeJson(
        res,
        { ok: false, error: 'Se requiere usuario y contraseña de un administrador para continuar' },
        400
      );
    }

    const adminCheck = await validateCashCloseAdmin(null, adminUsername, adminPassword);
    if (!adminCheck.ok) {
      return safeJson(res, { ok: false, error: adminCheck.error }, 403);
    }

    await saveCashCloseAuth(req, adminCheck);
    return safeJson(res, { ok: true, authorized_by: adminCheck.username, admin_id: adminCheck.adminId });
  })
);

router.post(
  '/cash_close',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    const roleRaw = req.session.user.rol || req.session.user.role || 'user';
    const userRole = canonRole(roleRaw);
    if (!['user', 'cashier', 'cashierh', 'cashiee', 'admin', 'farmacia', 'superadmin'].includes(userRole)) {
      return safeJson(res, { ok: false, error: 'Permiso denegado' }, 403);
    }

    const input = readJson(req);
    const montoFinalRaw =
      input.monto_final != null
        ? input.monto_final
        : input.monto_cierre != null
        ? input.monto_cierre
        : input.montoFinal != null
        ? input.montoFinal
        : input.montoCierre != null
        ? input.montoCierre
        : null;
    let montoFinal = montoFinalRaw != null ? parseNumber(montoFinalRaw) : null;
    const totalVentasRaw =
      input.total_ventas != null
        ? input.total_ventas
        : input.totalVentas != null
        ? input.totalVentas
        : null;
    let totalVentas = totalVentasRaw != null ? parseNumber(totalVentasRaw) : null;
    const diferenciaRaw =
      input.diferencia != null
        ? input.diferencia
        : input.dif != null
        ? input.dif
        : null;
    let diferencia = diferenciaRaw != null ? parseNumber(diferenciaRaw) : null;
    const cajaSolicitada = input.caja_id != null ? Number(input.caja_id) : null;
    const branchFilter = input.branch_id != null ? Number(input.branch_id) : null;
    const userId = req.session.user.id || null;
    let adminCheck = getCashCloseAuthFromSession(req);
    if (!adminCheck) {
      const adminUsername = String(
        input.admin_username != null ? input.admin_username : input.admin_user != null ? input.admin_user : ''
      ).trim();
      const adminPassword = String(
        input.admin_password != null ? input.admin_password : input.admin_pass != null ? input.admin_pass : ''
      );
      if (!adminUsername || !adminPassword) {
        return safeJson(
          res,
          { ok: false, error: 'Debe autorizar el cierre con un administrador antes de continuar' },
          403
        );
      }
      adminCheck = await validateCashCloseAdmin(null, adminUsername, adminPassword);
      if (!adminCheck.ok) {
        return safeJson(res, { ok: false, error: adminCheck.error }, 403);
      }
      await saveCashCloseAuth(req, adminCheck);
    }

    if (branchFilter && !(await branchAllowedForRole(null, branchFilter, userRole))) {
      const msg =
        userRole === 'cashierh'
          ? 'Solo puede cerrar cajas de Hospitalización'
          : 'Solo puede cerrar cajas de Principal o Emergencia';
      return safeJson(res, { ok: false, error: msg }, 403);
    }

    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    const ventasTable = await pickTable(null, ['ventas', 'sales'], 'ventas');
    const salesTotalCol = await pickColumn(null, ventasTable, ['total', 'monto_total', 'importe_total', 'amount_total'], 'total');
    const salesDateCol = await pickColumn(null, ventasTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
    const salesUserCol = await pickColumn(null, ventasTable, ['usuario_id', 'user_id', 'cajero_id'], null);
    const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);

    let openCaja = null;
    let cajaCols = [];
    let cajaUserCol = null;
    let cajaBranchCol = null;
    let fechaAperturaCol = null;
    let fechaCierreCol = null;

    if (await tableExists(null, cajaTable)) {
      cajaCols = await getColumns(null, cajaTable);
      cajaUserCol = cajaCols.includes('user_id') ? 'user_id' : null;
      cajaBranchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;
      fechaAperturaCol = cajaCols.includes('fecha_apertura') ? 'fecha_apertura' : cajaCols.includes('fecha') ? 'fecha' : null;
      fechaCierreCol = cajaCols.includes('fecha_cierre') ? 'fecha_cierre' : null;

      const where = [];
      const params = [];
      if (fechaCierreCol) where.push(`${fechaCierreCol} IS NULL`);
      if (cajaCols.includes('estado')) where.push("(estado='ABIERTA' OR estado IS NULL)");
      if (cajaSolicitada) {
        where.push(`id = $${params.length + 1}`);
        params.push(cajaSolicitada);
      } else {
        if (cajaUserCol && userId) {
          where.push(`${cajaUserCol} = $${params.length + 1}`);
          params.push(userId);
        }
        if (cajaBranchCol && branchFilter) {
          where.push(`${cajaBranchCol} = $${params.length + 1}`);
          params.push(branchFilter);
        }
      }
      const sqlOpen = `SELECT * FROM ${cajaTable} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`;
      const st = await query(sqlOpen, params);
      openCaja = st.rows[0] || null;
    }

    if (!openCaja && cajaSolicitada) {
      const stById = await query(`SELECT * FROM ${cajaTable} WHERE id = $1 LIMIT 1`, [cajaSolicitada]);
      openCaja = stById.rows[0] || null;
    }

    if (!openCaja) {
      return safeJson(res, { ok: false, error: 'No se encontró caja abierta' }, 400);
    }

    if (input.monto_final != null && montoFinal == null) {
      return safeJson(res, { ok: false, error: 'Monto final inválido' }, 400);
    }
    if (input.total_ventas != null && totalVentas == null) {
      return safeJson(res, { ok: false, error: 'Total de ventas inválido' }, 400);
    }

    if (totalVentas == null && salesBoxCol && openCaja.id && salesTotalCol) {
      const st = await query(
        `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE ${salesBoxCol} = $1`,
        [openCaja.id]
      );
      totalVentas = Number(st.rows[0]?.tot || 0);
    }

    if (totalVentas == null && openCaja.total_ventas != null) {
      totalVentas = Number(openCaja.total_ventas);
    }

    if (totalVentas == null && fechaAperturaCol && salesDateCol && salesTotalCol) {
      const desde = openCaja[fechaAperturaCol];
      if (desde) {
        let sql = `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE ${salesDateCol} >= $1 AND ${salesDateCol} <= NOW()`;
        const params = [desde];
        if (salesUserCol && userId) {
          sql += ` AND ${salesUserCol} = $2`;
          params.push(userId);
        }
        if (branchFilter && (await columnExists(null, ventasTable, 'branch_id'))) {
          sql += ` AND branch_id = $${params.length + 1}`;
          params.push(branchFilter);
        }
        const st = await query(sql, params);
        totalVentas = Number(st.rows[0]?.tot || 0);
      }
    }

    if (totalVentas == null && salesTotalCol && salesDateCol) {
      let sql = `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE DATE(${salesDateCol}) = CURRENT_DATE`;
      const params = [];
      if (salesUserCol && userId) {
        sql += ` AND ${salesUserCol} = $1`;
        params.push(userId);
      }
      if (branchFilter && (await columnExists(null, ventasTable, 'branch_id'))) {
        sql += ` AND branch_id = $${params.length + 1}`;
        params.push(branchFilter);
      }
      const st = await query(sql, params);
      totalVentas = Number(st.rows[0]?.tot || 0);
    }
    if (totalVentas == null) totalVentas = 0;

    if (diferencia == null && montoFinal != null && totalVentas != null) {
      diferencia = montoFinal - totalVentas;
    }
    let estadoCuadre = 'CERRADA';
    if (montoFinal != null && totalVentas != null) {
      const tol = 0.005;
      if (Math.abs(diferencia) <= tol) {
        estadoCuadre = 'CUADRADA';
        diferencia = 0;
      } else if (diferencia < 0) {
        estadoCuadre = 'FALTANTE';
      } else {
        estadoCuadre = 'SOBRANTE';
      }
    }

    const cierreId = await withTransaction(async (db) => {
      const sets = [];
      const vals = [];
      if (cajaCols.includes('fecha_cierre')) {
        sets.push('fecha_cierre = $' + (vals.length + 1));
        vals.push(new Date());
      }
      if (cajaCols.includes('estado')) {
        sets.push('estado = $' + (vals.length + 1));
        vals.push(estadoCuadre);
      }
      if (cajaCols.includes('monto_final')) {
        sets.push('monto_final = $' + (vals.length + 1));
        vals.push(montoFinal);
      } else if (cajaCols.includes('monto_cierre')) {
        sets.push('monto_cierre = $' + (vals.length + 1));
        vals.push(montoFinal);
      }
      if (cajaCols.includes('total_ventas')) {
        sets.push('total_ventas = $' + (vals.length + 1));
        vals.push(totalVentas);
      }
      if (cajaCols.includes('diferencia')) {
        sets.push('diferencia = $' + (vals.length + 1));
        vals.push(diferencia);
      }
      if (cajaCols.includes('user_id')) {
        sets.push('user_id = $' + (vals.length + 1));
        vals.push(userId);
      }
      let updated = 0;
      if (sets.length) {
        vals.push(openCaja.id);
        const up = await query(`UPDATE ${cajaTable} SET ${sets.join(',')} WHERE id = $${vals.length}`, vals, db);
        updated = up.rowCount || 0;
      }

      if (openCaja.id && (updated === 0 || fechaCierreCol || cajaCols.includes('estado'))) {
        const checkCols = [];
        if (fechaCierreCol) checkCols.push(fechaCierreCol + ' AS fecha_cierre');
        if (cajaCols.includes('estado')) checkCols.push('estado');
        if (cajaCols.includes('monto_final')) checkCols.push('monto_final');
        if (cajaCols.includes('monto_cierre')) checkCols.push('monto_cierre');
        const checkSql =
          checkCols.length > 0
            ? `SELECT ${checkCols.join(', ')} FROM ${cajaTable} WHERE id = $1 LIMIT 1`
            : null;
        let stillOpen = false;
        if (checkSql) {
          const chk = await query(checkSql, [openCaja.id], db);
          const row = chk.rows[0] || {};
          if (fechaCierreCol && !row.fecha_cierre) stillOpen = true;
          if (cajaCols.includes('estado') && (!row.estado || row.estado === 'ABIERTA')) stillOpen = true;
          if (montoFinal != null) {
            const mfNow = row.monto_final != null ? Number(row.monto_final) : row.monto_cierre != null ? Number(row.monto_cierre) : null;
            if (mfNow == null || !Number.isFinite(mfNow)) stillOpen = true;
          }
        } else {
          stillOpen = true;
        }

        if (stillOpen) {
          const forceSets = [];
          const forceVals = [];
          if (fechaCierreCol) {
            forceSets.push(`${fechaCierreCol} = $${forceVals.length + 1}`);
            forceVals.push(new Date());
          }
          if (cajaCols.includes('estado')) {
            forceSets.push(`estado = $${forceVals.length + 1}`);
            forceVals.push(estadoCuadre);
          }
          if (montoFinal != null) {
            if (cajaCols.includes('monto_final')) {
              forceSets.push(`monto_final = $${forceVals.length + 1}`);
              forceVals.push(montoFinal);
            } else if (cajaCols.includes('monto_cierre')) {
              forceSets.push(`monto_cierre = $${forceVals.length + 1}`);
              forceVals.push(montoFinal);
            }
          }
          if (totalVentas != null && cajaCols.includes('total_ventas')) {
            forceSets.push(`total_ventas = $${forceVals.length + 1}`);
            forceVals.push(totalVentas);
          }
          if (diferencia != null && cajaCols.includes('diferencia')) {
            forceSets.push(`diferencia = $${forceVals.length + 1}`);
            forceVals.push(diferencia);
          }
          if (forceSets.length) {
            forceVals.push(openCaja.id);
            await query(`UPDATE ${cajaTable} SET ${forceSets.join(', ')} WHERE id = $${forceVals.length}`, forceVals, db);
          }
        }
      }

      const branchForEntry = branchFilter || openCaja.branch_id || null;
      const montoEntrada = montoFinal != null ? montoFinal : totalVentas;
      try {
        const jeId = await autoEntryForCashClose(db, Number(montoEntrada || 0), branchForEntry, openCaja.id, userId);
        if (jeId) {
          await query(
            'INSERT INTO cash_movements (caja_id, branch_id, tipo, monto, referencia, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [openCaja.id, branchForEntry, 'ingreso_caja', montoEntrada, `Cierre caja ${openCaja.id}`, jeId],
            db
          );
        }
      } catch (_) {}

      return openCaja.id;
    });

    try {
      const forceCols = await getColumns(null, cajaTable);
      const forceSets = [];
      const forceVals = [];
      if (forceCols.includes('fecha_cierre')) {
        forceSets.push(`fecha_cierre = $${forceVals.length + 1}`);
        forceVals.push(new Date());
      }
      if (forceCols.includes('estado')) {
        forceSets.push(`estado = $${forceVals.length + 1}`);
        forceVals.push(estadoCuadre);
      }
      if (montoFinal != null) {
        if (forceCols.includes('monto_final')) {
          forceSets.push(`monto_final = $${forceVals.length + 1}`);
          forceVals.push(montoFinal);
        } else if (forceCols.includes('monto_cierre')) {
          forceSets.push(`monto_cierre = $${forceVals.length + 1}`);
          forceVals.push(montoFinal);
        }
      }
      if (totalVentas != null && forceCols.includes('total_ventas')) {
        forceSets.push(`total_ventas = $${forceVals.length + 1}`);
        forceVals.push(totalVentas);
      }
      if (diferencia != null && forceCols.includes('diferencia')) {
        forceSets.push(`diferencia = $${forceVals.length + 1}`);
        forceVals.push(diferencia);
      }
      if (forceSets.length) {
        forceVals.push(openCaja.id);
        await query(`UPDATE ${cajaTable} SET ${forceSets.join(', ')} WHERE id = $${forceVals.length}`, forceVals);
      }
    } catch (_) {}

    await logAction(null, userId, 'caja_cierre', {
      caja_id: openCaja.id,
      branch_id: branchFilter || openCaja.branch_id || null,
      monto_cierre: montoFinal,
      total_ventas: totalVentas,
      diferencia: diferencia,
      autorizado_por: adminCheck.username || null,
      autorizado_por_id: adminCheck.adminId || null,
      ip: req.ip || null
    });

    await clearCashCloseAuth(req);

    return safeJson(res, { ok: true, cierre_id: cierreId, estado: estadoCuadre });
  })
);

router.get(
  '/open_cajas',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    await requireRole('user')(req, res, async () => {});
    if (res.headersSent) return;
    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    if (!(await tableExists(null, cajaTable))) return safeJson(res, { ok: true, items: [] });
    const cols = await getColumns(null, cajaTable);
    const fechaAperCol = cols.includes('fecha_apertura') ? 'fecha_apertura' : cols.includes('fecha') ? 'fecha' : null;
    const fechaCierreCol = cols.includes('fecha_cierre') ? 'fecha_cierre' : null;
    const estadoCol = cols.includes('estado') ? 'estado' : null;
    const userCol = cols.includes('user_id') ? 'user_id' : null;
    const branchCol = cols.includes('branch_id') ? 'branch_id' : null;
    const where = [];
    if (fechaCierreCol) where.push(`${fechaCierreCol} IS NULL`);
    if (estadoCol) where.push(`(${estadoCol} IS NULL OR ${estadoCol} <> 'CERRADA')`);
    let sql =
      `SELECT c.id` +
      (fechaAperCol ? `, c.${fechaAperCol} AS fecha_apertura` : '') +
      (userCol ? `, c.${userCol} AS user_id` : '') +
      (branchCol ? `, c.${branchCol} AS branch_id` : '') +
      `, u.username AS cajero, b.name AS sucursal ` +
      `FROM ${cajaTable} c ` +
      (userCol ? 'LEFT JOIN users u ON u.id = c.user_id ' : 'LEFT JOIN users u ON 1=0 ') +
      (branchCol ? 'LEFT JOIN branches b ON b.id = c.branch_id ' : 'LEFT JOIN branches b ON 1=0 ');
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY c.id DESC';
    const st = await query(sql);
    return safeJson(res, { ok: true, items: st.rows || [] });
  })
);

router.get(
  '/resumen_caja',
  asyncHandler(async (req, res) => {
    await requireRole('user')(req, res, async () => {});
    if (res.headersSent) return;
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    const branchFilter = req.query.branch_id ? Number(req.query.branch_id) : null;
    const userId = req.session?.user?.id || null;

    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    let ventasTable = await pickTable(null, ['ventas', 'sales', 'venta', 'tbl_ventas', 't_ventas'], 'ventas');
    let paymentsTable = await pickTable(null, ['payments', 'pagos', 'payment', 'tbl_pagos', 't_pagos'], 'payments');

    if (ventasTable === 'ventas' && (await tableExists(null, 'ventas')) && (await tableExists(null, 'sales'))) {
      const vHas = await query('SELECT 1 FROM ventas LIMIT 1');
      const sHas = await query('SELECT 1 FROM sales LIMIT 1');
      if (!vHas.rows[0] && sHas.rows[0]) ventasTable = 'sales';
    }
    if (paymentsTable === 'payments' && (await tableExists(null, 'payments')) && (await tableExists(null, 'pagos'))) {
      const pHas = await query('SELECT 1 FROM payments LIMIT 1');
      const pgHas = await query('SELECT 1 FROM pagos LIMIT 1');
      if (!pHas.rows[0] && pgHas.rows[0]) paymentsTable = 'pagos';
    }

    const summary = {
      total_ventas: 0,
      monto_inicial: 0,
      ventas_pendientes: 0,
      efectivo_en_caja: 0,
      devoluciones_ventas_total: 0,
      devoluciones_ventas_count: 0,
      total_ventas_neto: 0,
      ventas: { n: 0, total: 0 },
      pagos: []
    };

    let openCaja = null;
    let cajaCols = [];
    if (await tableExists(null, cajaTable)) {
      cajaCols = await getColumns(null, cajaTable);
      const fechaCierreCol = cajaCols.includes('fecha_cierre') ? 'fecha_cierre' : null;
      const estadoCol = cajaCols.includes('estado') ? 'estado' : null;
      const userCol = cajaCols.includes('user_id') ? 'user_id' : null;
      const branchCol = cajaCols.includes('branch_id') ? 'branch_id' : null;

      const where = [];
      const params = [];
      if (fechaCierreCol) where.push(`${fechaCierreCol} IS NULL`);
      if (estadoCol) where.push("(estado='ABIERTA' OR estado IS NULL)");
      if (userCol && userId) {
        where.push(`${userCol} = $${params.length + 1}`);
        params.push(userId);
      }
      if (branchCol && branchFilter) {
        where.push(`${branchCol} = $${params.length + 1}`);
        params.push(branchFilter);
      }
      const sqlOpen = `SELECT * FROM ${cajaTable} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`;
      const stCaja = await query(sqlOpen, params);
      openCaja = stCaja.rows[0] || null;
      if (!openCaja && userCol && userId) {
        const where2 = [];
        const params2 = [];
        if (fechaCierreCol) where2.push(`${fechaCierreCol} IS NULL`);
        if (estadoCol) where2.push("(estado='ABIERTA' OR estado IS NULL)");
        if (branchCol && branchFilter) {
          where2.push(`${branchCol} = $${params2.length + 1}`);
          params2.push(branchFilter);
        }
        const sqlOpen2 = `SELECT * FROM ${cajaTable} ${where2.length ? `WHERE ${where2.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`;
        const stCaja2 = await query(sqlOpen2, params2);
        openCaja = stCaja2.rows[0] || null;
      }
    }

    const ventasExists = await tableExists(null, ventasTable);
    const returnsTable = await pickTable(null, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
    const returnsExists = await tableExists(null, returnsTable);
    const manualReturnsTable = await pickTable(null, ['sale_returns_manual'], 'sale_returns_manual');
    const manualReturnsExists = await tableExists(null, manualReturnsTable);
    const returnItemsTable = await pickTable(null, ['sale_return_items'], 'sale_return_items');
    const returnItemsExists = await tableExists(null, returnItemsTable);
    const returnItemSubCol = returnItemsExists
      ? await pickColumn(null, returnItemsTable, ['subtotal', 'total', 'importe'], 'subtotal')
      : null;
    const returnCols = returnsExists ? await getColumns(null, returnsTable) : [];
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
    const returnBranchCol = returnCols.includes('branch_id') ? 'branch_id' : null;
    const returnUserCol = returnCols.includes('user_id') ? 'user_id' : null;
    const manualCols = manualReturnsExists ? await getColumns(null, manualReturnsTable) : [];
    const manualAmountCol = manualCols.includes('amount') ? 'amount' : manualCols.includes('monto') ? 'monto' : null;
    const manualDateCol = manualCols.includes('created_at') ? 'created_at' : manualCols.includes('fecha') ? 'fecha' : null;
    const manualBranchCol = manualCols.includes('branch_id') ? 'branch_id' : null;
    const manualUserCol = manualCols.includes('user_id') ? 'user_id' : null;
    if (!openCaja || !ventasExists) {
      if (ventasExists) {
        const salesIdCol = await pickColumn(null, ventasTable, ['id', 'venta_id', 'sale_id'], 'id');
        const salesTotalCol = await pickColumn(
          null,
          ventasTable,
          ['total', 'monto_total', 'importe_total', 'amount_total', 'monto', 'importe'],
          'total'
        );
        const salesDateCol = await pickColumn(null, ventasTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
        const salesUserCol = await pickColumn(null, ventasTable, ['usuario_id', 'user_id', 'cajero_id'], null);
        const salesBranchCol = await pickColumn(null, ventasTable, ['branch_id', 'sucursal_id'], null);

        const where = [];
        const params = [];
        if (salesDateCol) {
          where.push(`DATE(v.${quoteIdent(salesDateCol)}) = $${params.length + 1}`);
          params.push(fecha);
        }
        if (salesUserCol && userId) {
          where.push(`v.${quoteIdent(salesUserCol)} = $${params.length + 1}`);
          params.push(userId);
        }
        if (salesBranchCol && branchFilter) {
          where.push(`v.${quoteIdent(salesBranchCol)} = $${params.length + 1}`);
          params.push(branchFilter);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const ventasRes = salesTotalCol
          ? await query(
              `SELECT COUNT(*) as n, COALESCE(SUM(v.${quoteIdent(salesTotalCol)}),0) as total FROM ${quoteIdent(
                ventasTable
              )} v ${whereSql}`,
              params
            )
          : { rows: [summary.ventas] };

        let pagosRes = { rows: [] };
        if (await tableExists(null, paymentsTable)) {
          const payTypeCol = await pickColumn(null, paymentsTable, ['payment_type', 'tipo_pago', 'forma', 'metodo'], 'payment_type');
          const payAmountCol = await pickColumn(null, paymentsTable, ['amount', 'monto', 'importe', 'total'], 'amount');
          const paySaleIdCol = await pickColumn(null, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
          if (payTypeCol && payAmountCol && paySaleIdCol && salesIdCol) {
            pagosRes = await query(
              `SELECT LOWER(p.${quoteIdent(payTypeCol)}) as tipo, COALESCE(SUM(p.${quoteIdent(payAmountCol)}),0) as total
               FROM ${quoteIdent(paymentsTable)} p
               JOIN ${quoteIdent(ventasTable)} v ON v.${quoteIdent(salesIdCol)} = p.${quoteIdent(paySaleIdCol)}
               ${whereSql}
               GROUP BY LOWER(p.${quoteIdent(payTypeCol)})`,
              params
            );
          }
        }

        summary.ventas = ventasRes.rows[0] || summary.ventas;
        summary.pagos = pagosRes.rows || summary.pagos;
        summary.total_ventas = Number(summary.ventas.total || 0);
        let efectivoVentas = 0;
        if (summary.pagos.length) {
          for (const p of summary.pagos) {
            const tipo = String(p.tipo || '').toLowerCase();
            const amt = Number(p.total || 0);
            if (tipo === 'efectivo' || tipo === 'cash') efectivoVentas += amt;
            if (tipo.includes('credit') || tipo.includes('credito') || tipo.includes('cuenta')) {
              summary.ventas_pendientes += amt;
            }
          }
        } else {
          efectivoVentas = summary.total_ventas;
        }
        summary.efectivo_en_caja = efectivoVentas;
      }
      if (returnsExists) {
        const params = [];
        const where = [];
        if (returnDateCol) {
          where.push(`DATE(r.${quoteIdent(returnDateCol)}) = $${params.length + 1}`);
          params.push(fecha);
        }
        if (returnBranchCol && branchFilter) {
          where.push(`r.${quoteIdent(returnBranchCol)} = $${params.length + 1}`);
          params.push(branchFilter);
        }
        if (returnUserCol && userId) {
          where.push(`r.${quoteIdent(returnUserCol)} = $${params.length + 1}`);
          params.push(userId);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        if (returnTotalCol || returnItemSubCol) {
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
          const rsum = await query(
            `SELECT COUNT(DISTINCT r.id) as n, COALESCE(SUM(${totalExpr}),0) as total
             FROM ${quoteIdent(returnsTable)} r
             ${itemsJoin}
             ${whereSql}`,
            params
          );
          const row = rsum.rows[0] || {};
          summary.devoluciones_ventas_total = Number(row.total || 0);
          summary.devoluciones_ventas_count = Number(row.n || 0);
        }
      }
      if (manualReturnsExists && manualAmountCol) {
        const params = [];
        const where = [];
        if (manualDateCol) {
          where.push(`DATE(r.${quoteIdent(manualDateCol)}) = $${params.length + 1}`);
          params.push(fecha);
        }
        if (manualBranchCol && branchFilter) {
          where.push(`(r.${quoteIdent(manualBranchCol)} = $${params.length + 1} OR r.${quoteIdent(manualBranchCol)} IS NULL)`);
          params.push(branchFilter);
        }
        if (manualUserCol && userId) {
          where.push(`r.${quoteIdent(manualUserCol)} = $${params.length + 1}`);
          params.push(userId);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rsum = await query(
          `SELECT COUNT(*) as n, COALESCE(SUM(r.${quoteIdent(manualAmountCol)}),0) as total
           FROM ${quoteIdent(manualReturnsTable)} r
           ${whereSql}`,
          params
        );
        const row = rsum.rows[0] || {};
        summary.devoluciones_ventas_total += Number(row.total || 0);
        summary.devoluciones_ventas_count += Number(row.n || 0);
      }
      summary.total_ventas_neto = Number(summary.total_ventas || 0) - Number(summary.devoluciones_ventas_total || 0);
      if (summary.efectivo_en_caja != null) {
        summary.efectivo_en_caja = Number(summary.efectivo_en_caja || 0) - Number(summary.devoluciones_ventas_total || 0);
      }
      return safeJson(res, summary);
    }

    const fechaAperCol = cajaCols.includes('fecha_apertura') ? 'fecha_apertura' : cajaCols.includes('fecha') ? 'fecha' : null;
    const montoInicial =
      openCaja.monto_apertura != null
        ? Number(openCaja.monto_apertura)
        : openCaja.monto_inicial != null
        ? Number(openCaja.monto_inicial)
        : 0;
    summary.monto_inicial = montoInicial;

    const salesIdCol = await pickColumn(null, ventasTable, ['id', 'venta_id', 'sale_id'], 'id');
    const salesTotalCol = await pickColumn(
      null,
      ventasTable,
      ['total', 'monto_total', 'importe_total', 'amount_total'],
      'total'
    );
    const salesDateCol = await pickColumn(null, ventasTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
    const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);
    const salesUserCol = await pickColumn(null, ventasTable, ['usuario_id', 'user_id', 'cajero_id'], null);
    const salesBranchCol = await pickColumn(null, ventasTable, ['branch_id', 'sucursal_id'], null);

    const scope = { where: [], params: [] };
    if (salesBoxCol && openCaja.id) {
      scope.where.push(`v.${salesBoxCol} = $${scope.params.length + 1}`);
      scope.params.push(openCaja.id);
    } else if (salesDateCol && fechaAperCol && openCaja[fechaAperCol]) {
      scope.where.push(`v.${salesDateCol} >= $${scope.params.length + 1} AND v.${salesDateCol} <= NOW()`);
      scope.params.push(openCaja[fechaAperCol]);
    } else if (salesDateCol) {
      scope.where.push(`DATE(v.${salesDateCol}) = $${scope.params.length + 1}`);
      scope.params.push(fecha);
    }
    if (!salesBoxCol && salesUserCol && userId) {
      scope.where.push(`v.${salesUserCol} = $${scope.params.length + 1}`);
      scope.params.push(userId);
    }
    if (!salesBoxCol && salesBranchCol && branchFilter) {
      scope.where.push(`v.${salesBranchCol} = $${scope.params.length + 1}`);
      scope.params.push(branchFilter);
    }
    const whereSql = scope.where.length ? `WHERE ${scope.where.join(' AND ')}` : '';

    const ventasRes = await query(
      `SELECT COUNT(*) as n, COALESCE(SUM(v.${salesTotalCol}),0) as total FROM ${ventasTable} v ${whereSql}`,
      scope.params
    );
    const ventasRow = ventasRes.rows[0] || { n: 0, total: 0 };
    ventasRow.n = Number(ventasRow.n || 0);
    ventasRow.total = Number(ventasRow.total || 0);
    if (
      ventasRow.n === 0 &&
      salesBoxCol &&
      salesDateCol &&
      fechaAperCol &&
      openCaja &&
      openCaja[fechaAperCol]
    ) {
      const altWhere = [];
      const altParams = [];
      altWhere.push(`v.${salesDateCol} >= $${altParams.length + 1} AND v.${salesDateCol} <= NOW()`);
      altParams.push(openCaja[fechaAperCol]);
      if (salesUserCol && userId) {
        altWhere.push(`v.${salesUserCol} = $${altParams.length + 1}`);
        altParams.push(userId);
      }
      if (salesBranchCol && branchFilter) {
        altWhere.push(`v.${salesBranchCol} = $${altParams.length + 1}`);
        altParams.push(branchFilter);
      }
      const altRes = await query(
        `SELECT COUNT(*) as n, COALESCE(SUM(v.${salesTotalCol}),0) as total FROM ${ventasTable} v WHERE ${altWhere.join(
          ' AND '
        )}`,
        altParams
      );
      const altRow = altRes.rows[0] || { n: 0, total: 0 };
      const altTotal = Number(altRow.total || 0);
      if (altTotal > ventasRow.total) {
        ventasRow.n = Number(altRow.n || 0);
        ventasRow.total = altTotal;
      }
    }
    summary.ventas = ventasRow;
    summary.total_ventas = ventasRow.total;
    if (summary.total_ventas === 0 && openCaja && openCaja.total_ventas != null) {
      const tv = Number(openCaja.total_ventas || 0);
      if (tv > 0) {
        summary.total_ventas = tv;
        summary.ventas.total = tv;
      }
    }

    if (returnsExists && (returnTotalCol || returnItemSubCol)) {
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
      let totalSum = 0;
      let countSum = 0;
      if (returnCols.includes('caja_id') && openCaja?.id) {
        const rsum = await query(
          `SELECT COUNT(DISTINCT r.id) as n, COALESCE(SUM(${totalExpr}),0) as total
           FROM ${quoteIdent(returnsTable)} r
           ${itemsJoin}
           WHERE r.caja_id = $1`,
          [openCaja.id]
        );
        const row = rsum.rows[0] || {};
        totalSum += Number(row.total || 0);
        countSum += Number(row.n || 0);
      }
      const rsumLegacy = await query(
        `SELECT COUNT(DISTINCT r.id) as n, COALESCE(SUM(${totalExpr}),0) as total
         FROM ${quoteIdent(returnsTable)} r
         ${itemsJoin}
         JOIN ${quoteIdent(ventasTable)} v ON v.${quoteIdent(salesIdCol)} = r.sale_id
         ${whereSql} ${returnCols.includes('caja_id') ? ' AND r.caja_id IS NULL' : ''}`,
        scope.params
      );
      const rowLegacy = rsumLegacy.rows[0] || {};
      totalSum += Number(rowLegacy.total || 0);
      countSum += Number(rowLegacy.n || 0);
      summary.devoluciones_ventas_total = totalSum;
      summary.devoluciones_ventas_count = countSum;
      if (
        summary.devoluciones_ventas_total === 0 &&
        salesBoxCol &&
        returnDateCol &&
        fechaAperCol &&
        openCaja &&
        openCaja[fechaAperCol]
      ) {
        const altWhere = [];
        const altParams = [];
        altWhere.push(`r.${quoteIdent(returnDateCol)} >= $${altParams.length + 1}`);
        altParams.push(openCaja[fechaAperCol]);
        altWhere.push(`r.${quoteIdent(returnDateCol)} <= NOW()`);
        if (salesUserCol && userId) {
          altWhere.push(`v.${quoteIdent(salesUserCol)} = $${altParams.length + 1}`);
          altParams.push(userId);
        }
        if (salesBranchCol && branchFilter) {
          altWhere.push(`v.${quoteIdent(salesBranchCol)} = $${altParams.length + 1}`);
          altParams.push(branchFilter);
        }
        const altSql = `SELECT COUNT(DISTINCT r.id) as n, COALESCE(SUM(${totalExpr}),0) as total
                        FROM ${quoteIdent(returnsTable)} r
                        ${itemsJoin}
                        JOIN ${quoteIdent(ventasTable)} v ON v.${quoteIdent(salesIdCol)} = r.sale_id
                        WHERE ${altWhere.join(' AND ')}`;
        const altRes = await query(altSql, altParams);
        const altRow = altRes.rows[0] || {};
        const altTotal = Number(altRow.total || 0);
        if (altTotal > summary.devoluciones_ventas_total) {
          summary.devoluciones_ventas_total = altTotal;
          summary.devoluciones_ventas_count = Number(altRow.n || 0);
        }
      }
    }
    if (manualReturnsExists && manualAmountCol) {
      const params = [];
      const where = [];
      if (manualDateCol && fechaAperCol && openCaja && openCaja[fechaAperCol]) {
        where.push(`r.${quoteIdent(manualDateCol)} >= $${params.length + 1}`);
        params.push(openCaja[fechaAperCol]);
        where.push(`r.${quoteIdent(manualDateCol)} <= NOW()`);
      } else if (manualDateCol) {
        where.push(`DATE(r.${quoteIdent(manualDateCol)}) = $${params.length + 1}`);
        params.push(fecha);
      }
      if (manualBranchCol && branchFilter) {
        where.push(`(r.${quoteIdent(manualBranchCol)} = $${params.length + 1} OR r.${quoteIdent(manualBranchCol)} IS NULL)`);
        params.push(branchFilter);
      }
      if (manualCols.includes('caja_id') && openCaja?.id) {
        where.push(`(r.caja_id = $${params.length + 1} OR r.caja_id IS NULL)`);
        params.push(openCaja.id);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rsum = await query(
        `SELECT COUNT(*) as n, COALESCE(SUM(r.${quoteIdent(manualAmountCol)}),0) as total
         FROM ${quoteIdent(manualReturnsTable)} r
         ${whereSql}`,
        params
      );
      const row = rsum.rows[0] || {};
      summary.devoluciones_ventas_total += Number(row.total || 0);
      summary.devoluciones_ventas_count += Number(row.n || 0);
    }

    let pagos = [];
    if (await tableExists(null, paymentsTable)) {
      const payTypeCol = await pickColumn(null, paymentsTable, ['payment_type', 'tipo_pago', 'forma', 'metodo'], 'payment_type');
      const payAmountCol = await pickColumn(null, paymentsTable, ['amount', 'monto', 'importe', 'total'], 'amount');
      const paySaleIdCol = await pickColumn(null, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
      if (payTypeCol && payAmountCol && paySaleIdCol && salesIdCol) {
        let pagosRes = await query(
          `SELECT LOWER(p.${payTypeCol}) as tipo, COALESCE(SUM(p.${payAmountCol}),0) as total
           FROM ${paymentsTable} p
           JOIN ${ventasTable} v ON v.${salesIdCol} = p.${paySaleIdCol}
           ${whereSql}
           GROUP BY LOWER(p.${payTypeCol})`,
          scope.params
        );
        pagos = pagosRes.rows || [];
        const pagosTotal = pagos.reduce((s, r) => s + Number(r.total || 0), 0);
        if (
          pagosTotal === 0 &&
          salesBoxCol &&
          salesDateCol &&
          fechaAperCol &&
          openCaja &&
          openCaja[fechaAperCol]
        ) {
          const altWhere = [];
          const altParams = [];
          altWhere.push(`v.${salesDateCol} >= $${altParams.length + 1} AND v.${salesDateCol} <= NOW()`);
          altParams.push(openCaja[fechaAperCol]);
          if (salesUserCol && userId) {
            altWhere.push(`v.${salesUserCol} = $${altParams.length + 1}`);
            altParams.push(userId);
          }
          if (salesBranchCol && branchFilter) {
            altWhere.push(`v.${salesBranchCol} = $${altParams.length + 1}`);
            altParams.push(branchFilter);
          }
          pagosRes = await query(
            `SELECT LOWER(p.${payTypeCol}) as tipo, COALESCE(SUM(p.${payAmountCol}),0) as total
             FROM ${paymentsTable} p
             JOIN ${ventasTable} v ON v.${salesIdCol} = p.${paySaleIdCol}
             WHERE ${altWhere.join(' AND ')}
             GROUP BY LOWER(p.${payTypeCol})`,
            altParams
          );
          pagos = pagosRes.rows || pagos;
        }
      }
    }
    summary.pagos = pagos;
    if (summary.total_ventas === 0 && pagos.length) {
      const pagosTotal = pagos.reduce((s, p) => s + Number(p.total || 0), 0);
      if (pagosTotal > 0) {
        summary.total_ventas = pagosTotal;
        summary.ventas.total = pagosTotal;
      }
    }

    let efectivoVentas = 0;
    for (const p of pagos) {
      const tipo = String(p.tipo || '').toLowerCase();
      const amt = Number(p.total || 0);
      if (tipo === 'efectivo' || tipo === 'cash') efectivoVentas += amt;
      if (tipo.includes('credit') || tipo.includes('credito') || tipo.includes('cuenta')) {
        summary.ventas_pendientes += amt;
      }
    }
    if (!pagos.length) efectivoVentas = summary.total_ventas;
    summary.efectivo_en_caja = montoInicial + efectivoVentas - Number(summary.devoluciones_ventas_total || 0);
    summary.total_ventas_neto = Number(summary.total_ventas || 0) - Number(summary.devoluciones_ventas_total || 0);

    return safeJson(res, summary);
  })
);

router.get(
  '/cash_shifts_report',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    await requireRole(['admin', 'administrador', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const data = await fetchCashShiftData(req);
    if (data && data.error) {
      return safeJson(res, { ok: false, error: data.error }, data.status || 400);
    }
    return safeJson(res, data);
  })
);

router.get(
  '/cash_shifts_export',
  asyncHandler(async (req, res) => {
    if (!req.session?.user) {
      return safeJson(res, { ok: false, error: 'No autenticado' }, 401);
    }
    await requireRole(['admin', 'administrador', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;

    const data = await fetchCashShiftData(req);
    if (data && data.error) {
      return safeJson(res, { ok: false, error: data.error }, data.status || 400);
    }
    const label = data.startDate || data.endDate
      ? `Del ${data.startDate || ''} al ${data.endDate || ''}`.trim()
      : 'Reporte de turnos';
    const wb = buildCashShiftWorkbook(data.shifts || [], data.cashier_totals || [], label);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="turnos_caja_${stamp}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.end(buffer);
  })
);

router.all(
  '/cash_deposit',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;

    const cajaTable = await pickTable(null, ['cajas', 'caja', 'cashbox'], 'cajas');
    let cajaCols = (await tableExists(null, cajaTable)) ? await getColumns(null, cajaTable) : [];

    const addCols = [
      ['depositado', 'ALTER TABLE ' + cajaTable + ' ADD COLUMN depositado BOOLEAN NOT NULL DEFAULT FALSE'],
      ['deposito_numero', 'ALTER TABLE ' + cajaTable + ' ADD COLUMN deposito_numero VARCHAR(100) NULL'],
      ['deposito_fecha', 'ALTER TABLE ' + cajaTable + ' ADD COLUMN deposito_fecha DATE NULL'],
      ['deposito_monto', 'ALTER TABLE ' + cajaTable + ' ADD COLUMN deposito_monto DECIMAL(14,4) NULL'],
      ['bank_account_id', 'ALTER TABLE ' + cajaTable + ' ADD COLUMN bank_account_id INT NULL']
    ];
    for (const [col, sql] of addCols) {
      if (cajaCols.length && !cajaCols.includes(col)) {
        try {
          await query(sql);
        } catch (_) {}
      }
    }
    cajaCols = await getColumns(null, cajaTable);

    const method = req.method;
    const input = readJson(req);

    if (method === 'GET') {
      const cols = [
        'id',
        'fecha_cierre',
        'monto_final',
        'monto_cierre',
        'monto_apertura',
        'monto_inicial',
        'total_ventas',
        'diferencia',
        'estado',
        'depositado',
        'deposito_numero',
        'deposito_fecha',
        'deposito_monto',
        'branch_id',
        'bank_account_id'
      ].filter((c) => cajaCols.includes(c));
      const select = cols.length ? cols.join(',') : '*';
      const rows = await query(`SELECT ${select} FROM ${cajaTable} ORDER BY id DESC LIMIT 50`);

      const ventasTable = await pickTable(null, ['ventas', 'sales'], 'ventas');
      const salesTotalCol = await pickColumn(
        null,
        ventasTable,
        ['total', 'monto_total', 'importe_total', 'amount_total', 'monto', 'importe'],
        'total'
      );
      const salesBoxCol = await pickColumn(null, ventasTable, ['caja_id', 'cashbox_id', 'id_caja'], null);

      const tol = 0.005;
      for (const r of rows.rows) {
        let estado = '';
        const mf = r.monto_final != null ? Number(r.monto_final) : r.monto_cierre != null ? Number(r.monto_cierre) : null;
        let ventas = r.total_ventas != null ? Number(r.total_ventas) : null;
        if ((ventas == null || ventas === 0) && salesBoxCol && (await tableExists(null, ventasTable))) {
          if (r.id) {
            const q = await query(
              `SELECT COALESCE(SUM(${salesTotalCol}),0) AS tot FROM ${ventasTable} WHERE ${salesBoxCol} = $1`,
              [r.id]
            );
            ventas = Number(q.rows[0]?.tot || 0);
            r.total_ventas = ventas;
          }
        }
        const dif = r.diferencia != null ? Number(r.diferencia) : null;
        const delta = mf != null ? mf - (ventas || 0) : dif;
        if (delta != null) {
          if (Math.abs(delta) <= tol) estado = 'CUADRADA';
          else if (delta < 0) estado = 'FALTANTE';
          else estado = 'SOBRANTE';
        } else {
          estado = String(r.estado || '');
        }
        r.estado = estado;
      }
      return safeJson(res, rows.rows);
    }

    if (method !== 'POST') {
      return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
    }

    const cierreId = Number(input.cierre_id || 0);
    const bankAccountId = Number(input.bank_account_id || 0);
    const depositNumber = String(input.deposit_number || '').trim();
    const amount = Number(input.amount || 0);
    const fecha = input.fecha || new Date().toISOString().slice(0, 10);
    const referencia = String(input.referencia || depositNumber || '').trim();
    let contra = input.contracuenta_id != null ? Number(input.contracuenta_id) : null;
    if (contra != null && contra <= 0) contra = null;

    if (cierreId <= 0) return safeJson(res, { ok: false, error: 'cierre_id requerido' }, 400);
    if (bankAccountId <= 0) return safeJson(res, { ok: false, error: 'bank_account_id requerido' }, 400);
    if (amount <= 0) return safeJson(res, { ok: false, error: 'monto inválido' }, 400);

    const cierreRes = await query(`SELECT * FROM ${cajaTable} WHERE id = $1 LIMIT 1`, [cierreId]);
    const cierre = cierreRes.rows[0];
    if (!cierre) return safeJson(res, { ok: false, error: 'Cierre no encontrado' }, 404);
    if (cajaCols.includes('depositado') && Number(cierre.depositado) === 1) {
      return safeJson(res, { ok: false, error: 'Este cierre ya fue marcado como depositado' }, 400);
    }

    const bm = await query(
      'INSERT INTO bank_movements (bank_account_id, fecha, tipo, monto, referencia, contracuenta_id, journal_entry_id, conciliado) VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING id',
      [bankAccountId, fecha, 'deposito', amount, referencia, contra, null]
    );
    const bmId = Number(bm.rows[0].id);

    await query(
      `UPDATE ${cajaTable} SET depositado = TRUE, deposito_numero = $1, deposito_fecha = $2, deposito_monto = $3, bank_account_id = $4 WHERE id = $5`,
      [depositNumber || null, fecha, amount, bankAccountId, cierreId]
    );

    return safeJson(res, { ok: true, bank_movement_id: bmId, message: 'Deposito realizado' });
  })
);

router.all(
  '/cash_movements',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      const params = [];
      const where = [];
      if (req.query.branch_id) {
        where.push(`cm.branch_id = $${params.length + 1}`);
        params.push(Number(req.query.branch_id));
      }
      if (req.query.from) {
        where.push(`cm.created_at >= $${params.length + 1}`);
        params.push(req.query.from);
      }
      if (req.query.to) {
        where.push(`cm.created_at <= $${params.length + 1}`);
        params.push(req.query.to);
      }
      let sql =
        'SELECT cm.*, b.name AS branch FROM cash_movements cm LEFT JOIN branches b ON b.id = cm.branch_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY cm.created_at DESC LIMIT 500';
      const st = await query(sql, params);
      return safeJson(res, st.rows);
    }

    if (method === 'POST') {
      const tipo = String(data.tipo || '').trim();
      const monto = Number(data.monto || 0);
      if (!tipo || !monto) return safeJson(res, { ok: false, error: 'tipo y monto requeridos' }, 400);
      const caja = data.caja_id != null ? Number(data.caja_id) : null;
      const branch = data.branch_id != null ? Number(data.branch_id) : null;
      const ref = String(data.referencia || '').trim();
      const je = data.journal_entry_id != null ? Number(data.journal_entry_id) : null;
      const ins = await query(
        'INSERT INTO cash_movements (caja_id, branch_id, tipo, monto, referencia, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [caja, branch, tipo, monto, ref, je]
      );
      return safeJson(res, { ok: true, id: Number(ins.rows[0].id) });
    }

    if (method === 'PUT') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const fields = [];
      const params = [];
      for (const f of ['tipo', 'referencia']) {
        if (data[f] != null) {
          fields.push(`${f} = $${params.length + 1}`);
          params.push(data[f]);
        }
      }
      if (data.monto != null) {
        fields.push(`monto = $${params.length + 1}`);
        params.push(Number(data.monto));
      }
      if (Object.prototype.hasOwnProperty.call(data, 'branch_id')) {
        fields.push(`branch_id = $${params.length + 1}`);
        params.push(data.branch_id != null ? Number(data.branch_id) : null);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'journal_entry_id')) {
        fields.push(`journal_entry_id = $${params.length + 1}`);
        params.push(data.journal_entry_id != null ? Number(data.journal_entry_id) : null);
      }
      if (!fields.length) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      params.push(id);
      await query(`UPDATE cash_movements SET ${fields.join(',')} WHERE id = $${params.length}`, params);
      return safeJson(res, { ok: true });
    }

    if (method === 'DELETE') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM cash_movements WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.post(
  '/record_payment',
  asyncHandler(async (req, res) => {
    await requireRole(['cashier', 'farmacia'])(req, res, async () => {});
    if (res.headersSent) return;
    const input = readJson(req);
    const saleId = Number(input.sale_id || 0);
    const amount = Number(input.amount || 0);
    const type = String(input.type || 'efectivo').trim().toLowerCase();
    const details = input.details || null;
    const userId = req.session?.user?.id || null;
    if (!saleId || amount <= 0) return safeJson(res, { error: 'Datos inválidos' }, 400);
    await query(
      'INSERT INTO payments (sale_id, user_id, amount, payment_type, payment_method_details, is_credit) VALUES ($1,$2,$3,$4,$5,0)',
      [saleId, userId, amount, type, typeof details === 'object' ? JSON.stringify(details) : details]
    );
    return safeJson(res, { ok: true });
  })
);

module.exports = router;
