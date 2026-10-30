/**
 * Pruebas de integración del flujo de venta (POST /api/register_sale)
 * contra PostgreSQL real: esquema de producción, transacciones y bloqueos reales.
 */
const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('../helpers/db');
const { createApp } = require('../../server/app');

let app;
let base;
let cajero;

function postSale(user, body, key) {
  const req = request(app).post('/api/register_sale').set('Cookie', h.authCookie(user));
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
}

before(async () => {
  await h.createSchema();
  app = createApp();
});

beforeEach(async () => {
  await h.truncateAll();
  base = await h.seedBase();
  cajero = base.users[0];
});

after(() => h.pool.end());

describe('Registro de venta con lotes (FEFO)', () => {
  test('descuenta primero el lote que vence antes y deja todo consistente', async () => {
    const { productId, lotIds } = await h.createProduct('Amoxicilina 500mg', [
      { lot: 'LEJANO', days: 300, qty: 10, price: 12 },
      { lot: 'PROXIMO', days: 20, qty: 4, price: 12 }
    ]);

    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 6]]));

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.total, 72); // 6 x Q12
    const ventaId = res.body.venta_id;

    // FEFO: el lote PROXIMO (4) se agota y los 2 restantes salen del LEJANO.
    assert.equal(await h.lotQty(lotIds.PROXIMO), 0);
    assert.equal(await h.lotQty(lotIds.LEJANO), 8);

    const lotSales = await h.pool.query('SELECT lot_id, quantity FROM lot_sales WHERE sale_id = $1 ORDER BY quantity DESC', [ventaId]);
    assert.deepEqual(
      lotSales.rows.map((r) => [Number(r.lot_id), r.quantity]),
      [
        [lotIds.PROXIMO, 4],
        [lotIds.LEJANO, 2]
      ]
    );

    // Stock por sucursal, kardex, pago y bitácora coinciden con la venta.
    const stock = await h.pool.query('SELECT stock FROM product_stocks WHERE product_id = $1 AND branch_id = 1', [productId]);
    assert.equal(Number(stock.rows[0].stock), 8);
    const mov = await h.pool.query("SELECT SUM(cantidad)::int AS q FROM inventario_movimientos WHERE referencia = $1 AND tipo = 'venta'", [String(ventaId)]);
    assert.equal(mov.rows[0].q, -6);
    const pay = await h.pool.query('SELECT amount, payment_type FROM payments WHERE sale_id = $1', [ventaId]);
    assert.equal(pay.rowCount, 1);
    assert.equal(Number(pay.rows[0].amount), 72);
    assert.equal(pay.rows[0].payment_type, 'efectivo');
    assert.equal(await h.count('bitacora', "WHERE accion = 'venta_registrada'"), 1);
  });

  test('avisa cuando el lote vendido vence pronto', async () => {
    const { productId } = await h.createProduct('Ibuprofeno', [{ lot: 'L1', days: 10, qty: 5 }]);
    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 1]]));
    assert.equal(res.status, 200);
    assert.equal(res.body.expiring_alerts.length, 1);
    assert.equal(res.body.expiring_alerts[0].lot_number, 'L1');
  });

  test('no vende lotes vencidos aunque tengan existencia', async () => {
    const { productId, lotIds } = await h.createProduct('Jarabe vencido', [{ lot: 'VENCIDO', days: -1, qty: 50 }]);

    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 1]]));

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OUT_OF_STOCK');
    assert.match(res.body.error, /No hay lotes disponibles/);
    assert.equal(await h.lotQty(lotIds.VENCIDO), 50);
    assert.equal(await h.count('ventas'), 0);
  });
});

describe('Atomicidad y reglas de negocio', () => {
  test('si un ítem no tiene stock suficiente se revierte toda la venta', async () => {
    const a = await h.createProduct('Producto con stock', [{ lot: 'A', days: 100, qty: 10 }]);
    const b = await h.createProduct('Producto escaso', [{ lot: 'B', days: 100, qty: 2 }]);

    const res = await postSale(cajero, h.saleBody(cajero, [[a.productId, 3], [b.productId, 5]]));

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'INSUFFICIENT_STOCK');
    // Nada quedó a medias: ni venta, ni detalle, ni pago, ni movimiento de lote.
    assert.equal(await h.lotQty(a.lotIds.A), 10);
    assert.equal(await h.lotQty(b.lotIds.B), 2);
    for (const table of ['ventas', 'venta_items', 'payments', 'lot_sales', 'inventario_movimientos']) {
      assert.equal(await h.count(table), 0, `${table} debería estar vacía`);
    }
  });

  test('rechaza efectivo recibido menor al total (422) sin tocar inventario', async () => {
    const { productId, lotIds } = await h.createProduct('Suero', [{ lot: 'S', days: 100, qty: 10, price: 25 }]);

    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 2]], { efectivo_recibido: 20 }));

    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'CASH_INSUFFICIENT');
    assert.equal(await h.lotQty(lotIds.S), 10);
    assert.equal(await h.count('ventas'), 0);
  });

  test('exige caja abierta', async () => {
    const { productId } = await h.createProduct('Gasas', [{ lot: 'G', days: 100, qty: 10 }]);
    await h.pool.query("UPDATE cajas SET fecha_cierre = NOW(), estado = 'CERRADA' WHERE id = $1", [cajero.cajaId]);

    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 1]]));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /cerrada/);
    assert.equal(await h.count('ventas'), 0);
  });

  test('exige el nombre del comprobante', async () => {
    const { productId } = await h.createProduct('Alcohol', [{ lot: 'AL', days: 100, qty: 10 }]);
    const res = await postSale(cajero, h.saleBody(cajero, [[productId, 1]], { nombre_comprobante: '' }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /comprobante/);
  });

  test('rechaza solicitudes sin sesión (401)', async () => {
    const res = await request(app).post('/api/register_sale').send(h.saleBody(cajero, [[1, 1]]));
    assert.equal(res.status, 401);
  });
});

describe('Concurrencia', () => {
  test('dos cajeros venden la última unidad a la vez: solo uno lo logra y el stock nunca queda negativo', async () => {
    const { productId, lotIds } = await h.createProduct('Insulina', [{ lot: 'UNICO', days: 60, qty: 1 }]);
    const [c1, c2] = base.users;

    const results = await Promise.all([
      postSale(c1, h.saleBody(c1, [[productId, 1]])),
      postSale(c2, h.saleBody(c2, [[productId, 1]]))
    ]);

    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await h.lotQty(lotIds.UNICO), 0);
    assert.equal(await h.count('ventas'), 1);
    assert.equal(await h.count('lot_sales'), 1);
  });
});
