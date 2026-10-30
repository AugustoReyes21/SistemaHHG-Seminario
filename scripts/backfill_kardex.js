const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}
const { query, tableExists, getColumns, pickTable, pickColumn } = require('../server/db');

async function main() {
  if (!(await tableExists(null, 'inventario_movimientos'))) {
    console.error('inventario_movimientos no existe.');
    process.exit(1);
  }

  const cols = new Set(await getColumns(null, 'inventario_movimientos'));
  const hasFecha = cols.has('fecha');
  const hasNotas = cols.has('notas');
  const baseCols = ['producto_id', 'cantidad', 'tipo', 'referencia'];
  if (hasFecha) baseCols.push('fecha');
  if (hasNotas) baseCols.push('notas');

  const purchaseTable = await pickTable(null, ['purchases'], 'purchases');
  const purchaseItemsTable = await pickTable(null, ['purchase_items'], 'purchase_items');
  const transfersTable = await pickTable(null, ['transfers'], 'transfers');
  const transferItemsTable = await pickTable(null, ['transfer_items'], 'transfer_items');

  let inserted = 0;

  if (await tableExists(null, purchaseTable) && await tableExists(null, purchaseItemsTable)) {
    const statusCol = (await getColumns(null, purchaseTable)).includes('status') ? 'status' : null;
    const dateCol = await pickColumn(null, purchaseTable, ['created_at', 'fecha'], 'created_at');
    const purchasesRes = statusCol
      ? await query(`SELECT id, ${dateCol} AS fecha FROM ${purchaseTable} WHERE LOWER(${statusCol}) IN ('confirmed','confirmado')`)
      : await query(`SELECT id, ${dateCol} AS fecha FROM ${purchaseTable}`);

    for (const p of purchasesRes.rows || []) {
      const purchaseId = Number(p.id || 0);
      if (!purchaseId) continue;
      const itemsRes = await query(
        `SELECT product_id, quantity FROM ${purchaseItemsTable} WHERE purchase_id = $1`,
        [purchaseId]
      );
      for (const it of itemsRes.rows || []) {
        const pid = Number(it.product_id || 0);
        const qty = Number(it.quantity || 0);
        if (!pid || qty <= 0) continue;
        const exists = await query(
          'SELECT 1 FROM inventario_movimientos WHERE producto_id = $1 AND tipo = $2 AND referencia = $3 LIMIT 1',
          [pid, 'compra', String(purchaseId)]
        );
        if (exists.rowCount > 0) continue;
        const values = [pid, qty, 'compra', String(purchaseId)];
        if (hasFecha) values.push(p.fecha || new Date());
        if (hasNotas) values.push(null);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
        await query(
          `INSERT INTO inventario_movimientos (${baseCols.join(',')}) VALUES (${placeholders})`,
          values
        );
        inserted += 1;
      }
    }
  }

  if (await tableExists(null, transfersTable) && await tableExists(null, transferItemsTable)) {
    const tDateCol = await pickColumn(null, transfersTable, ['created_at', 'fecha'], 'created_at');
    const tRes = await query(`SELECT id, source_branch_id, target_branch_id, ${tDateCol} AS fecha FROM ${transfersTable}`);
    for (const t of tRes.rows || []) {
      const transferId = Number(t.id || 0);
      if (!transferId) continue;
      const itemsRes = await query(
        `SELECT product_id, quantity FROM ${transferItemsTable} WHERE transfer_id = $1`,
        [transferId]
      );
      const note = `De sucursal ${t.source_branch_id} a ${t.target_branch_id}`;
      for (const it of itemsRes.rows || []) {
        const pid = Number(it.product_id || 0);
        const qty = Number(it.quantity || 0);
        if (!pid || qty <= 0) continue;
        const ref = String(transferId);
        const check = await query(
          'SELECT 1 FROM inventario_movimientos WHERE producto_id = $1 AND tipo = $2 AND referencia = $3 LIMIT 1',
          [pid, 'traslado_salida', ref]
        );
        if (check.rowCount === 0) {
          const values = [pid, -1 * qty, 'traslado_salida', ref];
          if (hasFecha) values.push(t.fecha || new Date());
          if (hasNotas) values.push(note);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
          await query(
            `INSERT INTO inventario_movimientos (${baseCols.join(',')}) VALUES (${placeholders})`,
            values
          );
          inserted += 1;
        }
        const checkIn = await query(
          'SELECT 1 FROM inventario_movimientos WHERE producto_id = $1 AND tipo = $2 AND referencia = $3 LIMIT 1',
          [pid, 'traslado_entrada', ref]
        );
        if (checkIn.rowCount === 0) {
          const valuesIn = [pid, qty, 'traslado_entrada', ref];
          if (hasFecha) valuesIn.push(t.fecha || new Date());
          if (hasNotas) valuesIn.push(note);
          const placeholdersIn = valuesIn.map((_, i) => `$${i + 1}`).join(',');
          await query(
            `INSERT INTO inventario_movimientos (${baseCols.join(',')}) VALUES (${placeholdersIn})`,
            valuesIn
          );
          inserted += 1;
        }
      }
    }
  }

  console.log(`Backfill completado. Movimientos insertados: ${inserted}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error en backfill:', err?.message || err);
  process.exit(1);
});
