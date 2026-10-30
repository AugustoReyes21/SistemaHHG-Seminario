require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../server/db');
const { ensureDatabaseReady } = require('../server/utils/dbMaintenance');

const CAJERO_PASSWORD = 'Demo2026!';

const PRODUCTS = [
  { name: 'Paracetamol 500mg', price: 2.5, lots: [['PAR-2601', 25, 40], ['PAR-2602', 300, 100]] },
  { name: 'Amoxicilina 500mg', price: 6, lots: [['AMX-2601', 180, 60]] },
  { name: 'Insulina NPH', price: 95, lots: [['INS-2601', 90, 1]] }
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('cargar-datos no se ejecuta con NODE_ENV=production');
  }
  await ensureDatabaseReady();

  await pool.query(
    "INSERT INTO branches (name, address) VALUES ('Principal', 'Sucursal principal') ON CONFLICT (name) DO NOTHING"
  );
  const branchId = Number((await pool.query("SELECT id FROM branches WHERE name = 'Principal'")).rows[0].id);

  const hash = await bcrypt.hash(CAJERO_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (username, email, password, role, cambio_obligatorio, activo)
     VALUES ('demo', 'demo@example.com', $1, 'cashier', FALSE, TRUE)
     ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role, cambio_obligatorio = FALSE,
       activo = TRUE, bloqueado = FALSE, intentos = 0`,
    [hash]
  );

  for (const p of PRODUCTS) {
    const existing = await pool.query('SELECT id FROM productos WHERE nombre_comercial = $1', [p.name]);
    let productId = existing.rows[0]?.id;
    if (!productId) {
      productId = (
        await pool.query(
          `INSERT INTO productos (nombre_comercial, tipo, stock, precio_costo, precio_publico)
           VALUES ($1, 'medicamento', 0, $2, $3) RETURNING id`,
          [p.name, p.price / 2, p.price]
        )
      ).rows[0].id;
    }
    await pool.query('DELETE FROM lots WHERE product_id = $1 AND id NOT IN (SELECT lot_id FROM lot_sales)', [productId]);
    await pool.query('UPDATE lots SET quantity = 0 WHERE product_id = $1', [productId]);
    let total = 0;
    for (const [lot, days, qty] of p.lots) {
      await pool.query(
        `INSERT INTO lots (product_id, branch_id, lot_number, expiry_date, sale_price, cost_price, quantity, initial_quantity)
         VALUES ($1, $2, $3, CURRENT_DATE + $4::int, $5, $6, $7, $7)`,
        [productId, branchId, lot, days, p.price, p.price / 2, qty]
      );
      total += qty;
    }
    await pool.query(
      `INSERT INTO product_stocks (product_id, branch_id, stock) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, branch_id) DO UPDATE SET stock = EXCLUDED.stock`,
      [productId, branchId, total]
    );
    await pool.query('UPDATE productos SET stock = $2 WHERE id = $1', [productId, total]);
    console.log(`  ${p.name}: id ${productId}, stock ${total}`);
  }
  console.log(`Listo. Usuario: demo / ${CAJERO_PASSWORD}  (sucursal Principal id ${branchId})`);
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
