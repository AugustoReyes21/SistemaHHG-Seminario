const fs = require('fs');
const path = require('path');
const { pool } = require('../../server/db');
const { ensureDatabaseReady } = require('../../server/utils/dbMaintenance');
const { signToken, getJwtConfig } = require('../../server/utils/jwt');

const SCHEMA_FILE = path.join(__dirname, '..', '..', 'pos_retail.sql');

/**
 * Crea el esquema desde cero, igual que una instalación nueva:
 * pos_retail.sql (base existente) + el arranque del servidor (migraciones, índices, contabilidad).
 */
async function createSchema() {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const log = console.log;
  console.log = () => {};
  try {
    await ensureDatabaseReady();
  } finally {
    console.log = log;
  }
}

// Catálogos que el servidor guarda en caché en memoria: no se vacían entre pruebas.
const KEEP_TABLES = ['schema_migrations', 'accounts'];

/** Deja vacías las tablas de datos y reinicia los IDs. */
async function truncateAll() {
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1))",
    [KEEP_TABLES]
  );
  if (!rows.length) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Datos mínimos de una farmacia: sucursal Principal (id 1), dos usuarios y
 * una caja abierta por usuario. Devuelve los IDs para usarlos en las pruebas.
 */
async function seedBase() {
  await pool.query("INSERT INTO branches (name, address) VALUES ('Principal', 'Sucursal principal')");
  const users = await pool.query(
    `INSERT INTO users (username, email, password, role, activo)
     VALUES ('cajero1', 'cajero1@test.local', 'x', 'admin', TRUE),
            ('cajero2', 'cajero2@test.local', 'x', 'admin', TRUE)
     RETURNING id`
  );
  const [u1, u2] = users.rows.map((r) => Number(r.id));
  const cajas = await pool.query(
    `INSERT INTO cajas (fecha_apertura, monto_apertura, estado, user_id, branch_id)
     VALUES (NOW(), 100, 'ABIERTA', $1, 1), (NOW(), 100, 'ABIERTA', $2, 1)
     RETURNING id`,
    [u1, u2]
  );
  const [c1, c2] = cajas.rows.map((r) => Number(r.id));
  return {
    branchId: 1,
    users: [
      { id: u1, username: 'cajero1', cajaId: c1 },
      { id: u2, username: 'cajero2', cajaId: c2 }
    ]
  };
}

/**
 * Crea un medicamento con sus lotes en la sucursal 1.
 * lots: [{ lot: 'A', days: 30, qty: 5, price: 10 }]  (days = días hasta vencer, negativo = vencido)
 */
async function createProduct(name, lots, { price = 10 } = {}) {
  const prod = await pool.query(
    `INSERT INTO productos (nombre_comercial, tipo, stock, precio_costo, precio_publico)
     VALUES ($1, 'medicamento', 0, 5, $2) RETURNING id`,
    [name, price]
  );
  const productId = Number(prod.rows[0].id);
  let total = 0;
  const lotIds = {};
  for (const l of lots) {
    const res = await pool.query(
      `INSERT INTO lots (product_id, branch_id, lot_number, expiry_date, sale_price, cost_price, quantity, initial_quantity)
       VALUES ($1, 1, $2, CURRENT_DATE + $3::int, $4, 5, $5, $5) RETURNING id`,
      [productId, l.lot, l.days, l.price ?? price, l.qty]
    );
    lotIds[l.lot] = Number(res.rows[0].id);
    if (l.days >= 0) total += l.qty;
  }
  await pool.query('INSERT INTO product_stocks (product_id, branch_id, stock) VALUES ($1, 1, $2)', [productId, total]);
  await pool.query('UPDATE productos SET stock = $2 WHERE id = $1', [productId, total]);
  return { productId, lotIds };
}

async function lotQty(lotId) {
  const { rows } = await pool.query('SELECT quantity FROM lots WHERE id = $1', [lotId]);
  return Number(rows[0].quantity);
}

async function count(table, where = '', params = []) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} ${where}`, params);
  return rows[0].c;
}

/** Cookie de sesión JWT idéntica a la que emite /api/login. */
function authCookie(user, role = 'admin') {
  const token = signToken({ id: user.id, username: user.username, role, rol: role });
  return `${getJwtConfig().cookieName}=${token}`;
}

/** Cuerpo de venta tal como lo envía ventas.html. */
function saleBody(user, items, extra = {}) {
  return {
    items: items.map(([producto_id, cantidad]) => ({ producto_id, cantidad, precio_unit: 10, lot_number: null })),
    services: [],
    payment_method: 'efectivo',
    branch_id: 1,
    cliente_tipo: 'consumidor_final',
    cliente_documento: null,
    note: '',
    venta_sin_producto: 0,
    cantidad_cobro: null,
    caja_id: user.cajaId,
    efectivo_recibido: null,
    discount_percent: 0,
    payment_split: null,
    nombre_comprobante: 'Consumidor Final',
    ...extra
  };
}

module.exports = {
  pool,
  createSchema,
  truncateAll,
  seedBase,
  createProduct,
  lotQty,
  count,
  authCookie,
  saleBody
};
