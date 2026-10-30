require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres', database: process.env.DB_NAME || 'pos_retail' });
const BASE = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000') + '/api/';
let cookie = '';
async function post(path, body, h = {}) {
  const t = process.hrtime.bigint();
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...h }, body: JSON.stringify(body) });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const sc = r.headers.get('set-cookie'); if (sc && sc.includes('hhg_auth=')) cookie = sc.split(';')[0];
  await r.text(); return { s: r.status, ms };
}
const med = (a) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const p95 = (a) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length * 0.95) - 1]; };
(async () => {
  await post('login', { username: 'demo', password: 'Demo2026!' });
  const uid = (await pool.query("select id from users where username='demo'")).rows[0].id;
  const caja = (await pool.query('select id from cajas where user_id=$1 and fecha_cierre is null order by id desc limit 1', [uid])).rows[0].id;
  const pid = (await pool.query("select id from productos where nombre_comercial='Paracetamol 500mg'")).rows[0].id;
  await pool.query('update lots set quantity = 100000 where product_id=$1 and expiry_date > current_date + 100', [pid]);
  const body = { items: [{ producto_id: pid, cantidad: 1, precio_unit: 2.5 }], services: [], payment_method: 'efectivo', branch_id: 1, caja_id: Number(caja), nombre_comprobante: 'Consumidor Final' };
  const N = 60, a = [], b = [], c = [];
  for (let i = 0; i < 5; i++) await post('register_sale', body);
  for (let i = 0; i < N; i++) {
    a.push((await post('register_sale', body)).ms);
    b.push((await post('register_sale', body, { 'Idempotency-Key': crypto.randomUUID() })).ms);
  }
  const k = crypto.randomUUID(); await post('register_sale', body, { 'Idempotency-Key': k });
  for (let i = 0; i < N; i++) c.push((await post('register_sale', body, { 'Idempotency-Key': k })).ms);
  console.log(`Muestras por escenario: ${N} (secuenciales, tras 5 de calentamiento)`);
  console.log('Escenario                      mediana (ms)   p95 (ms)');
  for (const [name, arr] of [['Sin Idempotency-Key', a], ['Con llave nueva', b], ['Repetición (misma llave)', c]]) {
    console.log(`${name.padEnd(30)} ${med(arr).toFixed(1).padStart(12)} ${p95(arr).toFixed(1).padStart(10)}`);
  }
  await pool.end();
})();
