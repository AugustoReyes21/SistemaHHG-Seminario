const express = require('express');
const {
  query,
  withTransaction,
  tableExists,
  columnExists,
  pickTable,
  pickColumn,
  getColumns
} = require('../db');
const { safeJson, readJson, safeNumber } = require('../helpers');
const { requireRole } = require('../auth');
const {
  adjustBranchStock,
  productStocksAvailable,
  branchNameCached,
  logAction
} = require('../functions');
const { autoEntryForPurchase } = require('../accounting');
const { validateBody, schemas: validationSchemas } = require('../middleware/validate');
const { logAuditEvent } = require('../utils/audit');
const {
  ensureProductTypeColumn,
  fetchProductTypeMap,
  productTypeUsesInventory
} = require('../utils/productCatalog');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function assertPurchasableProducts(db, items) {
  const productIds = Array.from(
    new Set(
      (items || [])
        .map((item) => Number(item?.product_id || 0))
        .filter((value) => value > 0)
    )
  );
  if (!productIds.length) return;
  await ensureProductTypeColumn(db);
  const typeMap = await fetchProductTypeMap(db, productIds);
  for (const productId of productIds) {
    if (!productTypeUsesInventory(typeMap.get(productId))) {
      throw new Error(`El producto ${productId} no admite compras ni control de stock`);
    }
  }
}

async function ensureLotSalePriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'sale_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN sale_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'sale_price');
}

async function ensureLotCostPriceColumn(db) {
  if (!(await tableExists(db, 'lots'))) return false;
  if (!(await columnExists(db, 'lots', 'cost_price'))) {
    try {
      await query('ALTER TABLE lots ADD COLUMN cost_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'lots', 'cost_price');
}

async function ensurePurchaseItemSalePriceColumn(db) {
  if (!(await tableExists(db, 'purchase_items'))) return false;
  if (!(await columnExists(db, 'purchase_items', 'sale_price'))) {
    try {
      await query('ALTER TABLE purchase_items ADD COLUMN sale_price NUMERIC(12,2)', [], db);
    } catch (_) {}
  }
  return await columnExists(db, 'purchase_items', 'sale_price');
}

router.post(
  '/register_purchase',
  validateBody(validationSchemas.purchaseRegisterSchema),
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'cashier', 'cajero', 'cashiee', 'cashierh'])(req, res, async () => {});
    if (res.headersSent) return;

    try {
      if (!(await columnExists(null, 'purchases', 'status'))) {
        await query("ALTER TABLE purchases ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
      }
    } catch (_) {}

    const input = req.validatedBody || readJson(req);
    if (!input || !Array.isArray(input.items) || !input.items.length) {
      return safeJson(res, { ok: false, error: 'Datos inválidos: se requieren items' }, 400);
    }

    const result = await withTransaction(async (db) => {
      await assertPurchasableProducts(db, input.items);
      const userId = req.session?.user?.id || null;
      const branchId = input.branch_id != null && input.branch_id !== '' ? Number(input.branch_id) : null;
      if (!branchId || branchId <= 0) {
        throw new Error('Seleccione la sucursal de destino');
      }
      req.session.branch_id = branchId;
      const invoice = input.invoice_number || null;
      const notes = input.notes || null;

      let supplierId = input.supplier_id || null;
      const supplierName = input.supplier_name ? String(input.supplier_name).trim() : '';

      let supplierTable = 'suppliers';
      let nameCol = 'name';
      try {
        const tblCheck = await query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('suppliers','proveedores')"
        );
        const rows = tblCheck.rows.map((r) => r.table_name);
        if (rows.includes('proveedores')) {
          supplierTable = 'proveedores';
          nameCol = 'nombre';
        }
      } catch (_) {}

      if (!supplierId && supplierName) {
        const check = await query(`SELECT id FROM ${supplierTable} WHERE ${nameCol} = $1`, [supplierName], db);
        if (check.rows[0]) {
          supplierId = Number(check.rows[0].id);
        } else {
          const insProv = await query(
            `INSERT INTO ${supplierTable} (${nameCol}) VALUES ($1) RETURNING id`,
            [supplierName],
            db
          );
          supplierId = Number(insProv.rows[0].id);
        }
      }

      let total = 0;
      for (const it of input.items) {
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || 0);
        if (qty > 0 && price >= 0) total += qty * price;
      }

      const purchaseIns = await query(
        'INSERT INTO purchases (supplier_id, branch_id, invoice_number, total, created_by, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [supplierId, branchId, invoice, total, userId, notes, 'pending'],
        db
      );
      const purchaseId = Number(purchaseIns.rows[0].id);

      const piCols = await getColumns(db, 'purchase_items');
      const hasLotNumber = piCols.includes('lot_number');
      const hasExpiry = piCols.includes('expiry_date');
      let hasPiSalePrice = piCols.includes('sale_price');
      const hasLotsTable = await tableExists(db, 'lots');
      const hasLotSalePrice = hasLotsTable ? await ensureLotSalePriceColumn(db) : false;
      const fields = ['purchase_id', 'product_id', 'quantity', 'unit_price', 'subtotal'];
      if (hasLotNumber) fields.push('lot_number');
      if (hasExpiry) fields.push('expiry_date');
      if (!hasPiSalePrice) {
        const needsSalePrice = input.items.some(
          (it) => it && it.profit_margin != null && it.profit_margin !== ''
        );
        if (needsSalePrice) {
          hasPiSalePrice = await ensurePurchaseItemSalePriceColumn(db);
        }
      }
      if (hasPiSalePrice) fields.push('sale_price');

      for (const it of input.items) {
        const productId = Number(it.product_id || 0);
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || 0);
        if (!productId || qty <= 0 || price < 0) continue;
        const subtotal = qty * price;
        let lotNumber = it.lot_number || it.lot || it.lote || null;
        if (lotNumber) lotNumber = String(lotNumber).trim();
        const expiryDate = it.expiry_date || it.expira || it.fecha_vencimiento || null;
        if (hasLotsTable && !expiryDate) {
          throw new Error('Fecha de vencimiento requerida para el lote');
        }
        let salePrice = null;
        if (it.sale_price != null && it.sale_price !== '') {
          const sp = Number(it.sale_price || 0);
          if (Number.isFinite(sp) && sp >= 0) salePrice = sp;
        } else if (it.profit_margin != null && it.profit_margin !== '') {
          const margin = Number(it.profit_margin || 0);
          if (Number.isFinite(margin)) {
            salePrice = Number((price * (1 + margin / 100)).toFixed(2));
          }
        }
        const params = [purchaseId, productId, qty, price, subtotal];
        if (hasLotNumber) params.push(lotNumber || null);
        if (hasExpiry) params.push(expiryDate || null);
        if (hasPiSalePrice) params.push(salePrice);
        const placeholders = params.map((_, idx) => `$${idx + 1}`).join(',');
        await query(
          `INSERT INTO purchase_items (${fields.join(',')}) VALUES (${placeholders})`,
          params,
          db
        );

        if (it.profit_margin != null && it.profit_margin !== '') {
          if (hasLotSalePrice) {
            const cur = await query('SELECT precio_publico FROM productos WHERE id = $1', [productId], db);
            const prevPrice = Number(cur.rows[0]?.precio_publico || 0);
            if (prevPrice > 0) {
              await query(
                'UPDATE lots SET sale_price = $1 WHERE product_id = $2 AND (sale_price IS NULL OR sale_price = 0)',
                [prevPrice, productId],
                db
              );
            }
          }
        }
      }

      await logAction(db, userId, 'compra_registrada', {
        purchase_id: purchaseId,
        total,
        items: input.items,
        supplier_id: supplierId,
        payment: input.payment_type || 'contado',
        branch_id: branchId
      });

      return purchaseId;
    });

    return safeJson(res, { ok: true, purchase_id: result });
  })
);

router.post(
  '/confirm_purchase',
  validateBody(validationSchemas.purchaseConfirmSchema),
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;

    try {
      if (!(await columnExists(null, 'purchases', 'status'))) {
        await query("ALTER TABLE purchases ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
      }
    } catch (_) {}

    const input = req.validatedBody || readJson(req);
    const purchaseId = Number(input.purchase_id || 0);
    if (!purchaseId) return safeJson(res, { ok: false, error: 'purchase_id inválido' }, 400);

    const paymentType = String(input.payment_type || 'contado').toLowerCase();
    const paymentForm = String(input.payment_form || 'efectivo').toLowerCase();
    const cuotas = Number(input.cuotas || 0);
    const isCredit = paymentType.startsWith('cred') ? 1 : 0;
    const details = { forma: paymentForm, cuotas };

    try {
      const result = await withTransaction(async (db) => {
        const pStmt = await query('SELECT * FROM purchases WHERE id = $1 LIMIT 1', [purchaseId], db);
        const purchase = pStmt.rows[0];
        if (!purchase) throw new Error('Compra no encontrada');

        const statusRaw = purchase.status != null ? String(purchase.status) : '';
        const statusNorm = statusRaw.trim().toLowerCase();
        const isPending = !statusNorm || statusNorm === 'pending' || statusNorm === 'pendiente';
        if (!isPending) {
          throw new Error('La compra ya está confirmada');
        }

        let branchId = purchase.branch_id ? Number(purchase.branch_id) : null;
        if (!branchId && req.session?.branch_id) {
          const sessionBranch = Number(req.session.branch_id);
          if (Number.isFinite(sessionBranch) && sessionBranch > 0) branchId = sessionBranch;
        }
        if (!branchId) branchId = 1;
        if (!purchase.branch_id && branchId) {
          try {
            await query('UPDATE purchases SET branch_id = $1 WHERE id = $2', [branchId, purchaseId], db);
          } catch (_) {}
        }
        const piCols = await getColumns(db, 'purchase_items');
        const hasPiSalePrice = piCols.includes('sale_price');
        const piFields = ['product_id', 'quantity', 'unit_price', 'lot_number', 'expiry_date'];
        if (hasPiSalePrice) piFields.push('sale_price');
        const itemsStmt = await query(
          `SELECT ${piFields.join(', ')} FROM purchase_items WHERE purchase_id = $1`,
          [purchaseId],
          db
        );
        const items = itemsStmt.rows || [];
        if (!items.length) throw new Error('La compra no tiene items asociados');
        await assertPurchasableProducts(db, items);
        const hasLotsTable = await tableExists(db, 'lots');
        const hasLotSalePrice = hasLotsTable ? await ensureLotSalePriceColumn(db) : false;
        if (hasLotsTable) {
          await ensureLotCostPriceColumn(db);
        }
        if (hasLotsTable) {
          const missing = items.filter((it) => !it.expiry_date);
          if (missing.length) {
            throw new Error('Faltan fechas de vencimiento en los lotes de esta compra');
          }
        }
        const productIds = items.map((it) => Number(it.product_id || 0)).filter((id) => id > 0);
        const priceMap = new Map();
        if (productIds.length) {
          const prodRes = await query(
            'SELECT id, precio_publico FROM productos WHERE id = ANY($1)',
            [productIds],
            db
          );
          for (const row of prodRes.rows || []) {
            priceMap.set(Number(row.id), Number(row.precio_publico || 0));
          }
        }
        const existingLots = new Set();
        if (hasLotsTable && branchId && productIds.length) {
          const existingRes = await query(
            `SELECT product_id
             FROM lots
             WHERE branch_id = $1 AND product_id = ANY($2)
               AND quantity > 0 AND expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE
             GROUP BY product_id`,
            [branchId, productIds],
            db
          );
          for (const row of existingRes.rows || []) {
            existingLots.add(Number(row.product_id || 0));
          }
        }
        const nextCostMap = new Map();
        const normDate = (value) => {
          if (!value) return null;
          const d = value instanceof Date ? value : new Date(value);
          return Number.isNaN(d.getTime()) ? null : d;
        };
        for (const it of items) {
          const pid = Number(it.product_id || 0);
          const qty = Number(it.quantity || 0);
          const price = Number(it.unit_price || 0);
          if (!pid || qty <= 0 || !Number.isFinite(price) || price < 0) continue;
          const exp = normDate(it.expiry_date || it.expira || it.fecha_vencimiento || null);
          const current = nextCostMap.get(pid);
          if (
            !current ||
            (exp && (!current.exp || exp.getTime() < current.exp.getTime()))
          ) {
            nextCostMap.set(pid, { cost: price, exp });
          }
        }
        for (const [pid, info] of nextCostMap.entries()) {
          if (!Number.isFinite(info.cost) || info.cost <= 0) continue;
          if (existingLots.has(pid)) continue;
          await query('UPDATE productos SET precio_costo = $1 WHERE id = $2', [info.cost, pid], db);
        }

        const nextSalePriceMap = new Map();
        for (const it of items) {
          const pid = Number(it.product_id || 0);
          if (!pid) continue;
          const exp = normDate(it.expiry_date || it.expira || it.fecha_vencimiento || null);
          let salePrice = hasPiSalePrice ? Number(it.sale_price || 0) : 0;
          if (!Number.isFinite(salePrice) || salePrice <= 0) {
            salePrice = Number(priceMap.get(pid) || 0);
          }
          if (!Number.isFinite(salePrice) || salePrice <= 0) continue;
          const current = nextSalePriceMap.get(pid);
          if (
            !current ||
            (exp && (!current.exp || exp.getTime() < current.exp.getTime()))
          ) {
            nextSalePriceMap.set(pid, { price: salePrice, exp });
          }
        }

        let hasLots = false;
        if (await tableExists(db, 'lots')) {
          const lotChk = await query('SELECT COUNT(*) AS c FROM lots WHERE purchase_id = $1', [purchaseId], db);
          hasLots = Number(lotChk.rows[0]?.c || 0) > 0;
        }

        let stockAdjusted = 0;
        if (!hasLots) {
          for (const it of items) {
            const pid = Number(it.product_id || 0);
            const qty = Number(it.quantity || 0);
            if (!pid || qty <= 0) continue;
            if (await productStocksAvailable(db)) {
              await adjustBranchStock(db, pid, branchId, qty);
            } else {
              await query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [qty, pid], db);
            }
            stockAdjusted += qty;
          }
        }

        let lotError = null;
        if (!hasLots && (await tableExists(db, 'lots'))) {
          try {
            const lotCols = new Set(await getColumns(db, 'lots'));
            const needed = ['product_id', 'purchase_id', 'branch_id', 'lot_number', 'quantity', 'initial_quantity'];
            const hasRequired = needed.every((col) => lotCols.has(col));
            if (hasRequired) {
              let autoIndex = 0;
              const hasExpiry = lotCols.has('expiry_date');
              const hasSalePrice = lotCols.has('sale_price');
              const hasCostPrice = lotCols.has('cost_price');
              for (const it of items) {
                const pid = Number(it.product_id || 0);
                const qty = Number(it.quantity || 0);
                if (!pid || qty <= 0) continue;
                let lotNumber = it.lot_number || null;
                if (!lotNumber) {
                  autoIndex += 1;
                  lotNumber = `LOTE-${purchaseId}-${pid}-${autoIndex}`;
                }
                const expiry = it.expiry_date || null;
                const fields = [
                  'product_id',
                  'purchase_id',
                  'branch_id',
                  'lot_number',
                  'quantity',
                  'initial_quantity'
                ];
                const params = [pid, purchaseId, branchId, lotNumber, qty, qty];
                if (hasExpiry) {
                  fields.splice(4, 0, 'expiry_date');
                  params.splice(4, 0, expiry);
                }
                if (hasSalePrice) {
                  let salePrice = hasPiSalePrice ? Number(it.sale_price || 0) : 0;
                  if (!Number.isFinite(salePrice) || salePrice <= 0) {
                    salePrice = Number(priceMap.get(pid) || 0);
                  }
                  fields.push('sale_price');
                  params.push(salePrice || null);
                }
                if (hasCostPrice) {
                  fields.push('cost_price');
                  params.push(Number(it.unit_price || 0) || null);
                }
                const placeholders = params.map((_, idx) => `$${idx + 1}`).join(',');
                await query(`INSERT INTO lots (${fields.join(',')}) VALUES (${placeholders})`, params, db);
                logAuditEvent({
                  action: 'lot_created',
                  branch_id: branchId || null,
                  user_id: req.session?.user?.id || null,
                  product_id: pid
                });
              }
            }
          } catch (e) {
            lotError = e.message;
          }
        }

        for (const [pid, info] of nextSalePriceMap.entries()) {
          if (existingLots.has(pid)) continue;
          if (!Number.isFinite(info.price) || info.price <= 0) continue;
          await query('UPDATE productos SET precio_publico = $1 WHERE id = $2', [info.price, pid], db);
        }

        let statusError = null;
        try {
          await query('UPDATE purchases SET status = $1 WHERE id = $2', ['confirmed', purchaseId], db);
        } catch (e) {
          statusError = e.message;
        }

        let paymentError = null;
        try {
          const payCols = new Set(await getColumns(db, 'payments'));
          if (payCols.has('purchase_id')) {
            const chkPay = await query('SELECT COUNT(*) AS c FROM payments WHERE purchase_id = $1', [purchaseId], db);
            const hasPayment = Number(chkPay.rows[0]?.c || 0) > 0;
            if (!hasPayment) {
              const branch = purchase.branch_id || null;
              const userId = req.session?.user?.id || null;
              const total = purchase.total != null ? Number(purchase.total) : 0;
              const fields = [];
              const values = [];
              const pushField = (col, val) => {
                if (payCols.has(col)) {
                  fields.push(col);
                  values.push(val);
                }
              };
              pushField('sale_id', null);
              pushField('purchase_id', purchaseId);
              pushField('branch_id', branch);
              pushField('user_id', userId);
              pushField('amount', total);
              pushField('payment_type', paymentType);
              pushField('payment_method_details', JSON.stringify(details));
              pushField('is_credit', isCredit);
              if (fields.length && fields.includes('purchase_id')) {
                const placeholders = values.map((_, idx) => `$${idx + 1}`).join(',');
                await query(
                  `INSERT INTO payments (${fields.join(',')}) VALUES (${placeholders})`,
                  values,
                  db
                );
              }
            }
          }
        } catch (e) {
          paymentError = e.message;
        }

        const userId = req.session?.user?.id || null;
        await logAction(db, userId, 'compra_confirmada', {
          purchase_id: purchaseId,
          status: statusNorm || statusRaw || null,
          items,
          payment_type: paymentType
        });
        try {
          if (await tableExists(db, 'inventario_movimientos')) {
            for (const it of items) {
              const pid = Number(it.product_id || 0);
              const qty = Number(it.quantity || 0);
              if (!pid || qty <= 0) continue;
              await query(
                'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
                [pid, qty, 'compra', String(purchaseId), null],
                db
              );
            }
          }
        } catch (_) {}

        let journalEntryId = null;
        let journalError = null;
        try {
          const toLocalISODate = (value) => {
            if (!value) return null;
            const d = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(d.getTime())) return null;
            const yy = String(d.getFullYear()).padStart(4, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yy}-${mm}-${dd}`;
          };
          const fechaPartida = toLocalISODate(purchase.created_at) || toLocalISODate(new Date());
          journalEntryId = await autoEntryForPurchase(
            db,
            purchaseId,
            purchase.total != null ? Number(purchase.total) : 0,
            purchase.branch_id || null,
            paymentType,
            paymentForm,
            userId,
            fechaPartida
          );
        } catch (e) {
          journalError = e.message;
        }

        return { journalEntryId, journalError, lotError, paymentError, stockAdjusted, statusError, branchId };
      });

      return safeJson(res, {
        ok: true,
        journal_entry_id: result.journalEntryId,
        journal_error: result.journalError,
        lot_error: result.lotError,
        payment_error: result.paymentError,
        stock_adjusted: result.stockAdjusted || 0,
        status_error: result.statusError || null,
        branch_id: result.branchId || null
      });
    } catch (e) {
      return safeJson(res, { ok: false, error: `Error confirmando compra: ${e.message}` }, 500);
    }
  })
);

router.all(
  '/delete_purchase',
  asyncHandler(async (req, res) => {
    await requireRole('admin')(req, res, async () => {});
    if (res.headersSent) return;
    let purchaseId = req.query.purchase_id ? Number(req.query.purchase_id) : null;
    if (!purchaseId && req.method === 'POST') {
      const body = readJson(req);
      purchaseId = body.purchase_id ? Number(body.purchase_id) : null;
    }
    if (!purchaseId) return safeJson(res, { error: 'purchase_id requerido' }, 400);

    try {
      await withTransaction(async (db) => {
        const purchaseRow = await query('SELECT branch_id FROM purchases WHERE id = $1', [purchaseId], db);
        let branchId = purchaseRow.rows[0]?.branch_id ? Number(purchaseRow.rows[0].branch_id) : 1;

        if (await tableExists(db, 'lots')) {
          const lotsRes = await query('SELECT id, product_id, quantity, initial_quantity FROM lots WHERE purchase_id = $1', [purchaseId], db);
          for (const lot of lotsRes.rows) {
            if (Number(lot.quantity) < Number(lot.initial_quantity)) {
              throw new Error('No se puede eliminar la compra: ya existen ventas asociadas a sus lotes');
            }
          }
          for (const lot of lotsRes.rows) {
            const productId = Number(lot.product_id);
            const qty = Number(lot.quantity);
            if (await productStocksAvailable(db)) {
              await adjustBranchStock(db, productId, branchId, -1 * qty);
            } else {
              await query('UPDATE productos SET stock = GREATEST(stock - $1, 0) WHERE id = $2', [qty, productId], db);
            }
            await query('DELETE FROM lots WHERE id = $1', [lot.id], db);
            logAuditEvent({
              action: 'lot_deleted',
              branch_id: branchId || null,
              user_id: req.session?.user?.id || null,
              product_id: productId
            });
          }
        }

        await query('DELETE FROM purchase_items WHERE purchase_id = $1', [purchaseId], db);
        await query('DELETE FROM payments WHERE purchase_id = $1', [purchaseId], db);
        await query('DELETE FROM purchases WHERE id = $1', [purchaseId], db);

        const userId = req.session?.user?.id || null;
        await logAction(db, userId, 'compra_eliminada', { purchase_id: purchaseId });
      });
      return safeJson(res, { ok: true });
    } catch (e) {
      return safeJson(res, { error: `Error eliminando compra: ${e.message}` }, 500);
    }
  })
);

router.get(
  '/purchase_lookup',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const id = req.query.id ? Number(req.query.id) : 0;
    if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);

    try {
      const supplierTable = await pickTable(null, ['suppliers', 'proveedores'], 'suppliers');
      const supplierNameCol = await pickColumn(null, supplierTable, ['name', 'nombre'], 'name');
      const rowRes = await query(
        `SELECT p.*, pay.payment_type, pay.payment_method_details, pay.is_credit
         FROM purchases p
         LEFT JOIN payments pay ON pay.purchase_id = p.id
         WHERE p.id = $1
         LIMIT 1`,
        [id]
      );
      const row = rowRes.rows[0];
      if (!row) return safeJson(res, { ok: false, error: 'Compra no encontrada' }, 404);
      let supplier = null;
      if (row.supplier_id) {
        const sup = await query(
          `SELECT ${supplierNameCol} AS nombre FROM ${supplierTable} WHERE id = $1 LIMIT 1`,
          [row.supplier_id]
        );
        supplier = sup.rows[0]?.nombre || null;
      }
      let paymentDetails = {};
      if (row.payment_method_details) {
        try {
          paymentDetails =
            typeof row.payment_method_details === 'string'
              ? JSON.parse(row.payment_method_details)
              : row.payment_method_details;
        } catch (_) {}
      }
      const branchId = row.branch_id != null ? Number(row.branch_id) : null;
      return safeJson(res, {
        ok: true,
        id: Number(row.id),
        total: Number(row.total || 0),
        branch_id: branchId,
        branch: branchId ? await branchNameCached(null, branchId) : null,
        supplier,
        status: row.status || null,
        payment_type: row.payment_type || null,
        payment_details: paymentDetails,
        created_at: row.created_at || null
      });
    } catch (e) {
      return safeJson(res, { ok: false, error: e.message }, 500);
    }
  })
);

router.get(
  '/purchase_details',
  asyncHandler(async (req, res) => {
    const purchaseId = req.query.purchase_id ? Number(req.query.purchase_id) : 0;
    if (!purchaseId) return safeJson(res, { ok: false, error: 'purchase_id inválido' }, 400);

    let supplierTable = 'suppliers';
    let nameCol = 'name';
    try {
      const chk = await query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('suppliers','proveedores')"
      );
      const names = chk.rows.map((r) => r.table_name);
      if (names.includes('proveedores')) {
        supplierTable = 'proveedores';
        nameCol = 'nombre';
      }
    } catch (_) {}

    const purchaseRes = await query(
      `SELECT p.id, p.supplier_id, s.${nameCol} AS supplier_name
       FROM purchases p
       LEFT JOIN ${supplierTable} s ON s.id = p.supplier_id
       WHERE p.id = $1`,
      [purchaseId]
    );
    const purchase = purchaseRes.rows[0];
    if (!purchase) return safeJson(res, { ok: false, error: 'Compra no encontrada' }, 404);

    const itemsRes = await query(
      `SELECT pi.product_id, pi.quantity AS qty, pi.unit_price,
              pr.nombre_comercial AS product_name, pr.casa AS casa_nombre
       FROM purchase_items pi
       JOIN productos pr ON pr.id = pi.product_id
       WHERE pi.purchase_id = $1`,
      [purchaseId]
    );

    return safeJson(res, { ok: true, purchase, items: itemsRes.rows });
  })
);

router.get(
  '/history_purchases',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    try {
      const invoiceFilter = String(req.query.invoice_number || req.query.factura || '').trim();
      const supplierFilter = String(req.query.supplier || req.query.proveedor || '').trim();
      const productFilter = String(req.query.product || req.query.producto || '').trim();
      const dateFilter = String(req.query.date || req.query.fecha || '').trim();

      const supplierTable = await pickTable(null, ['suppliers', 'proveedores'], 'suppliers');
      const supplierNameCol = await pickColumn(null, supplierTable, ['name', 'nombre'], 'name');
      const where = [];
      const params = [];
      if (invoiceFilter) {
        where.push(`COALESCE(p.invoice_number,'') = $${params.length + 1}`);
        params.push(invoiceFilter);
      }
      if (supplierFilter && supplierNameCol) {
        where.push(`LOWER(s.${supplierNameCol}) LIKE $${params.length + 1}`);
        params.push(`%${supplierFilter.toLowerCase()}%`);
      }
      if (dateFilter && /^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
        where.push(`DATE(p.created_at) = $${params.length + 1}::date`);
        params.push(dateFilter);
      }
      if (productFilter) {
        const productsTable = await pickTable(null, ['productos', 'products'], 'productos');
        const prodNameCol = await pickColumn(
          null,
          productsTable,
          ['nombre_comercial', 'nombre', 'name', 'descripcion'],
          'nombre_comercial'
        );
        const purchaseItemsTable = await pickTable(null, ['purchase_items'], 'purchase_items');
        if (await tableExists(null, purchaseItemsTable)) {
          where.push(
            `EXISTS (SELECT 1 FROM ${purchaseItemsTable} pi JOIN ${productsTable} pr ON pr.id = pi.product_id ` +
              `WHERE pi.purchase_id = p.id AND LOWER(pr.${prodNameCol}) LIKE $${params.length + 1})`
          );
          params.push(`%${productFilter.toLowerCase()}%`);
        }
      }

      let sql =
        `SELECT p.id,
                p.created_at AS fecha,
                p.status AS status,
                p.invoice_number AS invoice_number,
                s.${supplierNameCol} AS proveedor,
                pay.payment_type,
                pay.payment_method_details,
                pay.is_credit,
                p.total
         FROM purchases p
         LEFT JOIN ${supplierTable} s ON p.supplier_id = s.id
         LEFT JOIN payments pay ON pay.purchase_id = p.id`;
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY p.created_at DESC';

      const purchaseRows = await query(sql, params);

      const purchaseIds = purchaseRows.rows.map((row) => Number(row.id));
      const returnsByPurchase = {};
      if (purchaseIds.length && (await tableExists(null, 'devoluciones'))) {
        const detailTable = await pickTable(null, ['detalle_devolucion', 'detalle_devoluciones'], 'detalle_devolucion');
        const detailProductCol = await pickColumn(null, detailTable, ['producto_id', 'product_id', 'id_producto'], 'producto_id');
        const detailQtyCol = await pickColumn(null, detailTable, ['cantidad', 'qty', 'quantity'], 'cantidad');
        if (await columnExists(null, 'devoluciones', 'purchase_id')) {
          const retSql = `SELECT d.purchase_id, dd.${detailProductCol} AS product_id, dd.${detailQtyCol} AS cantidad,
                                 pr.nombre_comercial, d.motivo
                          FROM devoluciones d
                          INNER JOIN ${detailTable} dd ON dd.devolucion_id = d.id
                          LEFT JOIN productos pr ON pr.id = dd.producto_id
                          WHERE d.purchase_id = ANY($1)`;
          const retStmt = await query(retSql, [purchaseIds]);
          for (const rr of retStmt.rows) {
            const pid = Number(rr.purchase_id || 0);
            if (!pid) continue;
            if (!returnsByPurchase[pid]) returnsByPurchase[pid] = [];
            returnsByPurchase[pid].push({
              product_id: Number(rr.product_id),
              nombre: rr.nombre_comercial || null,
              cantidad: Number(rr.cantidad || 0),
              motivo: rr.motivo || null
            });
          }
        }
      }

      const rows = [];
      for (const r of purchaseRows.rows) {
        let details = {};
        if (r.payment_method_details) {
          try {
            details = typeof r.payment_method_details === 'string' ? JSON.parse(r.payment_method_details) : r.payment_method_details;
          } catch (_) {}
        }
        const returns = returnsByPurchase[r.id] || [];
        const returnsText = returns
          .map((ret) => {
            const label = ret.nombre || `Producto #${ret.product_id}`;
            const qty = Number(ret.cantidad || 0);
            const itemText = `${label} x${qty}`;
            return ret.motivo ? `${itemText} (${ret.motivo})` : itemText;
          })
          .join('; ');
        rows.push({
          id: r.id,
          fecha: r.fecha,
          invoice_number: r.invoice_number || null,
          proveedor: r.proveedor || null,
          tipo: r.payment_type || null,
          forma: details.forma || null,
          cuotas: details.cuotas || null,
          is_credit: Boolean(r.is_credit),
          total: r.total,
          status: r.status || 'pending',
          devoluciones: returns,
          devoluciones_text: returnsText
        });
      }
      return safeJson(res, rows);
    } catch (e) {
      return safeJson(res, { error: `Error listando compras: ${e.message}` }, 500);
    }
  })
);

router.post(
  '/return_supplier',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador'])(req, res, async () => {});
    if (res.headersSent) return;
    const input = readJson(req);
    if (!input || !Array.isArray(input.items) || !input.items.length) {
      return safeJson(res, { ok: false, error: 'Se requieren items' }, 400);
    }

    const purchaseId = Number(input.purchase_id || 0);
    const items = input.items;
    const motive = input.motive ? String(input.motive).trim() : null;

    if (!purchaseId) {
      return safeJson(res, { ok: false, error: 'Debe ingresar ID de compra' }, 400);
    }

    const purchaseRow = await query('SELECT supplier_id, branch_id FROM purchases WHERE id = $1', [purchaseId]);
    const row = purchaseRow.rows[0];
    if (!row) {
      return safeJson(res, { ok: false, error: 'Compra no encontrada' }, 404);
    }
    const supplierId = Number(row.supplier_id || 0);
    if (!supplierId) {
      return safeJson(res, { ok: false, error: 'No se pudo resolver el proveedor desde la compra' }, 400);
    }
    let targetBranchId = row.branch_id ? Number(row.branch_id) : null;
    if (!targetBranchId || targetBranchId <= 0) {
      targetBranchId = 1;
    }

    try {
      const devolucionId = await withTransaction(async (db) => {
        const hasPurchaseIdColumn = await columnExists(db, 'devoluciones', 'purchase_id');
        const hasLotsTable = await tableExists(db, 'lots');
        let devRes;
        if (hasPurchaseIdColumn) {
          devRes = await query(
            'INSERT INTO devoluciones (proveedor_id, purchase_id, fecha_devolucion, motivo) VALUES ($1,$2,CURRENT_DATE,$3) RETURNING id',
            [supplierId, purchaseId || null, motive],
            db
          );
        } else {
          devRes = await query(
            'INSERT INTO devoluciones (proveedor_id, fecha_devolucion, motivo) VALUES ($1,CURRENT_DATE,$2) RETURNING id',
            [supplierId, motive],
            db
          );
        }
        const devolucionId = Number(devRes.rows[0].id);
        for (const it of items) {
          const pid = Number(it.product_id || 0);
          const qty = Number(it.quantity || 0);
          if (!pid || qty <= 0) continue;
          if (hasLotsTable) {
            const lotsRes = await query(
            `SELECT id, quantity, expiry_date, created_at
               FROM lots
               WHERE product_id = $1 AND branch_id = $2 AND quantity > 0
               ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
               FOR UPDATE`,
              [pid, targetBranchId],
              db
            );
            let remaining = qty;
            for (const lot of lotsRes.rows || []) {
              if (remaining <= 0) break;
              const available = Number(lot.quantity || 0);
              if (available <= 0) continue;
              const take = Math.min(available, remaining);
              await query('UPDATE lots SET quantity = quantity - $1 WHERE id = $2', [take, lot.id], db);
              logAuditEvent({
                action: 'lot_adjusted',
                branch_id: targetBranchId || null,
                user_id: req.session?.user?.id || null,
                product_id: pid,
                delta: -1 * take
              });
              remaining -= take;
            }
            if (remaining > 0) {
              throw new Error(`Stock por lote insuficiente para producto ${pid}`);
            }
          }
          await query(
            'INSERT INTO detalle_devolucion (devolucion_id, producto_id, cantidad) VALUES ($1,$2,$3)',
            [devolucionId, pid, qty],
            db
          );
          if (await productStocksAvailable(db)) {
            await adjustBranchStock(db, pid, targetBranchId, -1 * qty);
          } else {
            await query('UPDATE productos SET stock = GREATEST(0, stock - $1) WHERE id = $2', [qty, pid], db);
          }
          await query(
            'INSERT INTO inventario_movimientos (producto_id, cantidad, tipo, referencia, notas) VALUES ($1,$2,$3,$4,$5)',
            [pid, -qty, 'devolucion', 'compra', motive],
            db
          );
        }
        return devolucionId;
      });

      const currentUser = req.session?.user?.id || null;
      await logAction(null, currentUser, 'devolucion_proveedor', {
        devolucion_id: devolucionId,
        purchase_id: purchaseId || null,
        supplier_id: supplierId,
        items,
        motivo: motive
      });
      return safeJson(res, { ok: true, devolucion_id: devolucionId });
    } catch (e) {
      return safeJson(res, { ok: false, error: e.message }, 500);
    }
  })
);


module.exports = router;
