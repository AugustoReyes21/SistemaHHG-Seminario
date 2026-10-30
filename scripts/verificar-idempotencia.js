require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('../server/db');

const BASE = (process.argv[2] || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PRODUCT = 'Amoxicilina 500mg';
let cookie = '';

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && setCookie.includes('hhg_auth=')) cookie = setCookie.split(';')[0];
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', data };
}

async function snapshot(productId) {
  const ventas = (await pool.query('SELECT COUNT(*)::int AS c FROM ventas')).rows[0].c;
  const stock = (await pool.query('SELECT COALESCE(SUM(quantity),0)::int AS q FROM lots WHERE product_id = $1', [productId])).rows[0].q;
  return { ventas, stock };
}

function line(label, r) {
  const extra = r.data?.venta_id ? `venta #${r.data.venta_id}` : r.data?.code || r.data?.error || '';
  console.log(`  ${label.padEnd(44)} HTTP ${r.status}${r.replayed ? ' (repetida)' : ''}  ${extra}`);
}

async function main() {
  const login = await api('POST', 'login', { username: 'demo', password: 'Demo2026!' });
  if (login.status !== 200) throw new Error(`Login falló (${login.status}): ${login.data?.error}`);
  const user = (await pool.query("SELECT id FROM users WHERE username = 'demo'")).rows[0];
  const branchId = Number((await pool.query("SELECT id FROM branches WHERE name = 'Principal'")).rows[0].id);
  let caja = (
    await pool.query("SELECT id FROM cajas WHERE user_id = $1 AND fecha_cierre IS NULL ORDER BY id DESC LIMIT 1", [user.id])
  ).rows[0];
  if (!caja) {
    const open = await api('POST', 'cash_open', { branch_id: branchId, monto_inicial: 100 });
    if (open.status !== 200) throw new Error(`No se pudo abrir caja: ${open.data?.error}`);
    caja = (await pool.query('SELECT id FROM cajas WHERE user_id = $1 AND fecha_cierre IS NULL ORDER BY id DESC LIMIT 1', [user.id])).rows[0];
  }
  const productId = Number((await pool.query('SELECT id FROM productos WHERE nombre_comercial = $1', [PRODUCT])).rows[0].id);

  const body = (qty) => ({
    items: [{ producto_id: productId, cantidad: qty, precio_unit: 6, lot_number: null }],
    services: [],
    payment_method: 'efectivo',
    branch_id: branchId,
    cliente_tipo: 'consumidor_final',
    venta_sin_producto: 0,
    caja_id: Number(caja.id),
    discount_percent: 0,
    nombre_comprobante: 'Consumidor Final'
  });

  const before = await snapshot(productId);
  console.log(`\nAntes: ${before.ventas} ventas, stock de ${PRODUCT} = ${before.stock}\n`);

  const key = crypto.randomUUID();
  console.log(`1) Misma venta enviada 3 veces con Idempotency-Key ${key.slice(0, 8)}...`);
  for (let i = 1; i <= 3; i++) line(`intento ${i}`, await api('POST', 'register_sale', body(2), { 'Idempotency-Key': key }));

  console.log('\n2) Cinco envíos simultáneos con una llave nueva (doble clic extremo)');
  const key2 = crypto.randomUUID();
  const burst = await Promise.all(Array.from({ length: 5 }, () => api('POST', 'register_sale', body(1), { 'Idempotency-Key': key2 })));
  burst.forEach((r, i) => line(`envío ${i + 1}`, r));

  console.log('\n3) Reglas del contrato');
  line('misma llave, otra cantidad', await api('POST', 'register_sale', body(9), { 'Idempotency-Key': key }));
  line('llave con formato inválido', await api('POST', 'register_sale', body(1), { 'Idempotency-Key': 'abc' }));
  line('stock insuficiente (9999 u.)', await api('POST', 'register_sale', body(9999), { 'Idempotency-Key': crypto.randomUUID() }));

  const after = await snapshot(productId);
  console.log(`\nDespués: ${after.ventas} ventas (+${after.ventas - before.ventas}), stock = ${after.stock} (-${before.stock - after.stock})`);
  console.log('Esperado: +2 ventas y -3 unidades (una venta de 2 y una de 1), sin duplicados.\n');
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
