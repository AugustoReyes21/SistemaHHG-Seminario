const { query, tableExists, columnExists, quoteIdent } = require('../db');
const { ensureErrorsTable } = require('./errors');
const { runMigrations } = require('./migrations');
const { ensureAccountingSchema } = require('../accounting');
const {
  ensureProductTypeColumn,
  ensureComboItemsTable,
  ensureLotSaleProductColumn
} = require('./productCatalog');

async function ensureIndex(table, name, columns) {
  if (!(await tableExists(null, table))) return;
  for (const column of columns) {
    if (!(await columnExists(null, table, column))) {
      return;
    }
  }
  const cols = columns.map((col) => quoteIdent(col)).join(', ');
  const idxName = quoteIdent(name);
  await query(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${quoteIdent(table)} (${cols})`);
}

async function ensureIndexes() {
  const targets = [
    { table: 'users', name: 'idx_users_username', columns: ['username'] },
    { table: 'users', name: 'idx_users_email', columns: ['email'] },
    { table: 'login_attempts', name: 'idx_login_attempts_user_ip', columns: ['username', 'ip'] },
    { table: 'login_attempts', name: 'idx_login_attempts_last', columns: ['last_attempt'] },
    { table: 'ventas', name: 'idx_ventas_fecha', columns: ['fecha'] },
    { table: 'ventas', name: 'idx_ventas_created', columns: ['created_at'] },
    { table: 'ventas', name: 'idx_ventas_branch', columns: ['branch_id'] },
    { table: 'purchases', name: 'idx_purchases_branch', columns: ['branch_id'] },
    { table: 'purchases', name: 'idx_purchases_supplier', columns: ['supplier_id'] },
    { table: 'payments', name: 'idx_payments_sale', columns: ['sale_id'] },
    { table: 'payments', name: 'idx_payments_purchase', columns: ['purchase_id'] },
    { table: 'lots', name: 'idx_lots_product_branch', columns: ['product_id', 'branch_id'] },
    { table: 'product_stocks', name: 'idx_product_stocks_product_branch', columns: ['product_id', 'branch_id'] },
    { table: 'cash_movements', name: 'idx_cash_movements_caja', columns: ['caja_id'] },
    { table: 'cash_movements', name: 'idx_cash_movements_branch', columns: ['branch_id'] },
    { table: 'errores', name: 'idx_errores_fecha', columns: ['fecha_error'] },
    { table: 'errores', name: 'idx_errores_ruta', columns: ['ruta'] }
  ];
  for (const target of targets) {
    try {
      await ensureIndex(target.table, target.name, target.columns);
    } catch (err) {
      console.log('No se pudo crear índice:', target.name, err?.message || err);
    }
  }
}

async function ensureDatabaseReady() {
  await ensureErrorsTable();
  await ensureIndexes();
  await runMigrations();
  // Se crea aquí y no durante la primera venta: dentro de la transacción de venta,
  // el CREATE TABLE (en otra conexión) esperaba un bloqueo de la propia venta y se colgaba.
  await ensureAccountingSchema();
  // Igual con las columnas e índices que la venta verifica en cada cobro: si dos primeras
  // ventas los creaban a la vez, una abortaba su transacción y respondía 500.
  await ensureProductTypeColumn(null);
  await ensureComboItemsTable(null);
  await ensureLotSaleProductColumn(null);
}

module.exports = {
  ensureDatabaseReady
};
