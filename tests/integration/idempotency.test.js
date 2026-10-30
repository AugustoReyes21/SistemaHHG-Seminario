/**
 * Pruebas de integración de la idempotencia en POST /api/register_sale
 * (Aporte 1) contra PostgreSQL real.
 */
const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('../helpers/db');
const { createApp } = require('../../server/app');

let app;
let base;
let cajero;
let product;

function postSale(user, body, key) {
  const req = request(app).post('/api/register_sale').set('Cookie', h.authCookie(user));
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
}

async function keyRow(key) {
  const { rows } = await h.pool.query('SELECT * FROM idempotency_keys WHERE idem_key = $1', [key]);
  return rows[0] || null;
}

before(async () => {
  await h.createSchema();
  app = createApp();
});

beforeEach(async () => {
  await h.truncateAll();
  base = await h.seedBase();
  cajero = base.users[0];
  product = await h.createProduct('Paracetamol 500mg', [{ lot: 'P1', days: 200, qty: 20, price: 10 }]);
});

after(() => h.pool.end());

describe('Reintentos de la misma venta', () => {
  test('reenviar la misma llave devuelve la venta original y no descuenta stock dos veces', async () => {
    const body = h.saleBody(cajero, [[product.productId, 3]]);
    const key = 'venta-0001-reintento';

    const first = await postSale(cajero, body, key);
    const retry = await postSale(cajero, body, key);

    assert.equal(first.status, 200);
    assert.equal(first.headers['idempotent-replayed'], undefined);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(retry.body.venta_id, first.body.venta_id);
    assert.equal(retry.body.total, first.body.total);

    assert.equal(await h.count('ventas'), 1);
    assert.equal(await h.count('payments'), 1);
    assert.equal(await h.lotQty(product.lotIds.P1), 17);

    const row = await keyRow(key);
    assert.equal(row.status, 'completed');
    assert.equal(Number(row.resource_id), first.body.venta_id);
    assert.equal(row.response_status, 200);
  });

  test('cinco envíos simultáneos con la misma llave crean una sola venta', async () => {
    const body = h.saleBody(cajero, [[product.productId, 2]]);
    const key = 'venta-0002-dobleclic';

    const results = await Promise.all(Array.from({ length: 5 }, () => postSale(cajero, body, key)));

    const created = results.filter((r) => r.status === 200 && !r.headers['idempotent-replayed']);
    assert.equal(created.length, 1, 'exactamente una solicitud debe crear la venta');
    for (const r of results) {
      assert.ok([200, 409].includes(r.status), `estado inesperado ${r.status}`);
      if (r.status === 409) assert.equal(r.body.code, 'IDEMPOTENCY_IN_PROGRESS');
      if (r.status === 200) assert.equal(r.body.venta_id, created[0].body.venta_id);
    }
    assert.equal(await h.count('ventas'), 1);
    assert.equal(await h.lotQty(product.lotIds.P1), 18);
  });

  test('sin llave, dos envíos idénticos crean dos ventas (el riesgo que se corrige)', async () => {
    const body = h.saleBody(cajero, [[product.productId, 1]]);
    await postSale(cajero, body);
    await postSale(cajero, body);
    assert.equal(await h.count('ventas'), 2);
    assert.equal(await h.lotQty(product.lotIds.P1), 18);
  });
});

describe('Reglas del contrato', () => {
  test('la misma llave con otro contenido se rechaza con 422', async () => {
    const key = 'venta-0003-alterada';
    await postSale(cajero, h.saleBody(cajero, [[product.productId, 1]]), key);

    const res = await postSale(cajero, h.saleBody(cajero, [[product.productId, 5]]), key);

    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await h.count('ventas'), 1);
    assert.equal(await h.lotQty(product.lotIds.P1), 19);
  });

  test('el orden de los campos no cambia la identidad de la solicitud', async () => {
    const key = 'venta-0004-orden';
    const body = h.saleBody(cajero, [[product.productId, 1]]);
    const reordered = Object.fromEntries(Object.entries(body).reverse());

    await postSale(cajero, body, key);
    const res = await postSale(cajero, reordered, key);

    assert.equal(res.status, 200);
    assert.equal(res.headers['idempotent-replayed'], 'true');
    assert.equal(await h.count('ventas'), 1);
  });

  for (const bad of ['corta', 'tiene espacios no', 'x'.repeat(101), 'acentuación-ñ-123']) {
    test(`rechaza una llave con formato inválido (${bad.slice(0, 12)}...) con 400`, async () => {
      const res = await postSale(cajero, h.saleBody(cajero, [[product.productId, 1]]), bad);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'IDEMPOTENCY_KEY_INVALID');
      assert.equal(await h.count('ventas'), 0);
    });
  }

  test('las llaves son por usuario: dos cajeros con la misma llave no se bloquean', async () => {
    const [c1, c2] = base.users;
    const key = 'llave-compartida-01';

    const r1 = await postSale(c1, h.saleBody(c1, [[product.productId, 1]]), key);
    const r2 = await postSale(c2, h.saleBody(c2, [[product.productId, 1]]), key);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.body.venta_id, r2.body.venta_id);
    assert.equal(await h.count('ventas'), 2);
  });
});

describe('Errores, expiración y recuperación', () => {
  test('un rechazo de negocio libera la llave: tras reponer stock el reintento sí registra', async () => {
    const key = 'venta-0005-sin-stock';
    const body = h.saleBody(cajero, [[product.productId, 25]]);

    const rejected = await postSale(cajero, body, key);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'INSUFFICIENT_STOCK');
    assert.equal(await keyRow(key), null, 'la llave no debe quedar reservada');

    await h.pool.query('UPDATE lots SET quantity = 30 WHERE id = $1', [product.lotIds.P1]);
    const retry = await postSale(cajero, body, key);

    assert.equal(retry.status, 200);
    assert.equal(retry.headers['idempotent-replayed'], undefined);
    assert.equal(await h.count('ventas'), 1);
    assert.equal(await h.lotQty(product.lotIds.P1), 5);
  });

  test('si el proceso cae tras confirmar la venta, el reintento recupera la venta sin duplicarla', async () => {
    const key = 'venta-0006-caida';
    const body = h.saleBody(cajero, [[product.productId, 2]]);
    const first = await postSale(cajero, body, key);
    // Simula una caída entre el COMMIT de la venta y el guardado de la respuesta.
    await h.pool.query(
      "UPDATE idempotency_keys SET status = 'committed', response_body = NULL, response_status = NULL WHERE idem_key = $1",
      [key]
    );

    const retry = await postSale(cajero, body, key);

    assert.equal(retry.status, 200);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(retry.body.venta_id, first.body.venta_id);
    assert.equal(await h.count('ventas'), 1);
  });

  test('una reserva abandonada en "processing" se retoma después del tiempo límite', async () => {
    const key = 'venta-0007-huerfana';
    const body = h.saleBody(cajero, [[product.productId, 1]]);
    const { hashRequest } = require('../../server/utils/idempotency');
    // Reserva que quedó colgada hace 10 minutos (el proceso murió antes de vender).
    await h.pool.query(
      `INSERT INTO idempotency_keys (scope, user_id, idem_key, request_hash, status, updated_at, expires_at)
       VALUES ('POST /api/register_sale', $1, $2, $3, 'processing', NOW() - interval '10 minutes', NOW() + interval '1 day')`,
      [cajero.id, key, hashRequest(body)]
    );

    const res = await postSale(cajero, body, key);

    assert.equal(res.status, 200);
    assert.equal(await h.count('ventas'), 1);
    assert.equal((await keyRow(key)).status, 'completed');
  });

  test('una llave vencida (más de 24 h) puede reutilizarse para una venta nueva', async () => {
    const key = 'venta-0008-vencida';
    await postSale(cajero, h.saleBody(cajero, [[product.productId, 1]]), key);
    await h.pool.query("UPDATE idempotency_keys SET expires_at = NOW() - interval '1 minute' WHERE idem_key = $1", [key]);

    const res = await postSale(cajero, h.saleBody(cajero, [[product.productId, 4]]), key);

    assert.equal(res.status, 200);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    assert.equal(await h.count('ventas'), 2);
  });
});
