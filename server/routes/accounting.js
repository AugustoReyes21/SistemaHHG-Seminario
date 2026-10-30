const express = require('express');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const {
  query,
  withTransaction,
  tableExists,
  pickTable,
  pickColumn,
  getColumns,
  quoteIdent
} = require('../db');
const { safeJson, readJson } = require('../helpers');
const { requireRole } = require('../auth');
const { ensureAccountingSchema, ensureDefaultAccounts } = require('../accounting');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.use(
  asyncHandler(async (req, res, next) => {
    await ensureAccountingSchema();
    return next();
  })
);

function roundMoney(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
}

function toDayKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function makeRecordDay(day) {
  return {
    fecha: day || '',
    tickets: 0,
    ventas_brutas: 0,
    devoluciones: 0,
    devoluciones_manuales: 0,
    ventas_netas: 0,
    compras_confirmadas: 0,
    costo_ventas: 0,
    mermas_vencimiento: 0,
    ganancia: 0,
    perdida: 0
  };
}

function ensureRecordDay(map, day) {
  const key = toDayKey(day);
  if (!map.has(key)) map.set(key, makeRecordDay(key));
  return map.get(key);
}

function sqlDateFilters(alias, column, from, to, params) {
  if (!column) return '';
  const ref = `${alias}.${quoteIdent(column)}`;
  const clauses = [];
  if (from) {
    clauses.push(`DATE(${ref}) >= $${params.length + 1}`);
    params.push(from);
  }
  if (to) {
    clauses.push(`DATE(${ref}) <= $${params.length + 1}`);
    params.push(to);
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

function readAmount(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

function normalizeSummaryText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseSummaryDetails(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function collectSummaryServices(payments) {
  const services = [];
  for (const payment of payments || []) {
    const det = parseSummaryDetails(
      payment?.payment_method_details ?? payment?.det ?? payment?.detalles ?? payment?.meta ?? null
    );
    if (!det) continue;
    let list = [];
    if (Array.isArray(det.services)) list = det.services;
    else if (Array.isArray(det.servicios)) list = det.servicios;
    else if (Array.isArray(det.items)) list = det.items;
    else if (Array.isArray(det.detalle)) list = det.detalle;
    else if (det.descripcion && det.monto != null) list = [det];
    for (const service of list) {
      const descripcion = String(service?.descripcion || service?.detalle || service?.servicio || 'Servicio').trim();
      const monto = readAmount(
        service?.monto,
        service?.valor,
        service?.amount,
        service?.precio,
        service?.total
      );
      if (!Number.isFinite(monto) || monto <= 0) continue;
      services.push({
        producto: descripcion || 'Servicio',
        producto_id: Number(service?.producto_id ?? service?.product_id ?? service?.id_producto ?? 0) || null,
        cantidad: 1,
        precio_unit: monto,
        subtotal: monto,
        is_service: true
      });
    }
  }
  return services;
}

function getSummaryServiceProductId(service) {
  const productId = Number(service?.producto_id ?? service?.product_id ?? service?.id_producto ?? 0);
  return Number.isFinite(productId) && productId > 0 ? productId : 0;
}

function isSummaryRayosXProductMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const code = normalizeSummaryText(meta.code || meta.codigo_barra || '');
  const fingerprint = normalizeSummaryText(
    [meta.name, meta.house, meta.category, meta.type]
      .filter(Boolean)
      .join(' ')
  );
  return code.startsWith('rx') || fingerprint.includes('rayos x') || fingerprint.includes('rayosx');
}

function detectSummaryContextOverride(label) {
  const text = normalizeSummaryText(label);
  if (!text) return null;
  if (text.includes('emergencia')) return 'emergencia';
  if (text.includes('hospitalizacion') || text.includes('hospital') || text.includes('hospitalario')) {
    return 'hospital';
  }
  if (text.includes('consulta externa') || text.includes('consultaexterna') || text.includes('consulta ext')) {
    return 'consulta';
  }
  return null;
}

function classifySummaryBucket(label, isProduct, context, productMeta = null) {
  if (!isProduct && isSummaryRayosXProductMeta(productMeta)) {
    return 'rxusg';
  }
  const text = normalizeSummaryText(label);
  if (!text) return isProduct ? 'medicina' : 'otros';
  if (text.includes('preop') || text.includes('preoperator') || text.includes('grupo')) return 'preop';
  if (text.includes('donacion')) return 'donacion';
  if (
    text.includes('medicina') ||
    text.includes('medicamento') ||
    text.includes('farmacia') ||
    text.includes('farmaco')
  ) {
    return 'medicina';
  }
  if (text.includes('laborat') || text.includes('lab')) return 'laborat';
  if (text.includes('rx') || text.includes('rayos') || text.includes('usg') || text.includes('ultrason')) {
    return 'rxusg';
  }
  if (context === 'hospital') {
    if (
      text.includes('habitacion') ||
      text.includes('hospitalizacion') ||
      text.includes('hospital') ||
      text.includes('cama') ||
      text.includes('sala') ||
      text.includes('hosp')
    ) {
      return 'hospi';
    }
  }
  if (text.includes('consulta')) return context === 'hospital' ? 'hospi' : 'consulta';
  if (isProduct) return 'medicina';
  return 'otros';
}

function makeBreakdownRow(id, label) {
  return {
    id,
    label,
    ventas_brutas: 0,
    devoluciones: 0,
    ventas_netas: 0,
    costo_ventas: 0,
    mermas_vencimiento: 0,
    ganancia: 0,
    perdida: 0
  };
}

function createBreakdownMaps() {
  return {
    byArea: new Map([
      ['consulta_externa', makeBreakdownRow('consulta_externa', 'Consulta Externa')],
      ['emergencia', makeBreakdownRow('emergencia', 'Emergencia')],
      ['hospitalizacion', makeBreakdownRow('hospitalizacion', 'Hospitalización')],
      ['preop', makeBreakdownRow('preop', 'Preops')],
      ['mermas_inventario', makeBreakdownRow('mermas_inventario', 'Mermas de inventario')],
      ['ajustes_manuales', makeBreakdownRow('ajustes_manuales', 'Ajustes manuales')]
    ]),
    byService: new Map([
      ['consultas_medicas', makeBreakdownRow('consultas_medicas', 'Consultas Médicas')],
      ['medicina_farmacia', makeBreakdownRow('medicina_farmacia', 'Medicina / Farmacia')],
      ['laboratorio', makeBreakdownRow('laboratorio', 'Laboratorio')],
      ['rayos_x_usg', makeBreakdownRow('rayos_x_usg', 'Rayos X / USG')],
      ['preop', makeBreakdownRow('preop', 'Preops')],
      ['donaciones', makeBreakdownRow('donaciones', 'Donaciones')],
      ['otros', makeBreakdownRow('otros', 'Otros')],
      ['ajustes_manuales', makeBreakdownRow('ajustes_manuales', 'Ajustes manuales')]
    ])
  };
}

function addBreakdownField(row, field, amount) {
  if (!row || !amount) return;
  row[field] = roundMoney(Number(row[field] || 0) + Number(amount || 0));
}

function resolveAreaBreakdownKey(context, bucket) {
  if (bucket === 'preop') return 'preop';
  if (context === 'emergencia') return 'emergencia';
  if (context === 'hospital') return 'hospitalizacion';
  return 'consulta_externa';
}

function resolveServiceBreakdownKey(bucket) {
  if (bucket === 'consulta') return 'consultas_medicas';
  if (bucket === 'medicina') return 'medicina_farmacia';
  if (bucket === 'laborat') return 'laboratorio';
  if (bucket === 'rxusg') return 'rayos_x_usg';
  if (bucket === 'preop') return 'preop';
  if (bucket === 'donacion') return 'donaciones';
  return 'otros';
}

function addBreakdownRevenue(breakdown, context, bucket, amount) {
  if (!amount) return;
  addBreakdownField(breakdown.byArea.get(resolveAreaBreakdownKey(context, bucket)), 'ventas_brutas', amount);
  addBreakdownField(breakdown.byService.get(resolveServiceBreakdownKey(bucket)), 'ventas_brutas', amount);
}

function addBreakdownReturn(breakdown, context, bucket, amount) {
  if (!amount) return;
  addBreakdownField(breakdown.byArea.get(resolveAreaBreakdownKey(context, bucket)), 'devoluciones', amount);
  addBreakdownField(breakdown.byService.get(resolveServiceBreakdownKey(bucket)), 'devoluciones', amount);
}

function addBreakdownCost(breakdown, context, bucket, amount) {
  if (!amount) return;
  addBreakdownField(breakdown.byArea.get(resolveAreaBreakdownKey(context, bucket)), 'costo_ventas', amount);
  addBreakdownField(breakdown.byService.get(resolveServiceBreakdownKey(bucket)), 'costo_ventas', amount);
}

function addBreakdownExpiryLoss(breakdown, bucket, amount) {
  if (!amount) return;
  addBreakdownField(breakdown.byArea.get('mermas_inventario'), 'mermas_vencimiento', amount);
  addBreakdownField(breakdown.byService.get(resolveServiceBreakdownKey(bucket)), 'mermas_vencimiento', amount);
}

function finalizeBreakdown(map) {
  return Array.from(map.values()).map((row) => {
    const ventasNetas = roundMoney(Number(row.ventas_brutas || 0) - Number(row.devoluciones || 0));
    const utilidad = roundMoney(ventasNetas - Number(row.costo_ventas || 0) - Number(row.mermas_vencimiento || 0));
    return {
      ...row,
      ventas_netas: ventasNetas,
      costo_ventas: roundMoney(row.costo_ventas),
      mermas_vencimiento: roundMoney(row.mermas_vencimiento),
      ganancia: utilidad > 0 ? utilidad : 0,
      perdida: utilidad < 0 ? roundMoney(Math.abs(utilidad)) : 0
    };
  });
}

async function buildRecordsSummary(db, opts = {}) {
  const from = opts.from ? String(opts.from).slice(0, 10) : null;
  const to = opts.to ? String(opts.to).slice(0, 10) : null;
  const dayMap = new Map();

  const totals = {
    tickets: 0,
    ventas_brutas: 0,
    devoluciones: 0,
    devoluciones_manuales: 0,
    ventas_netas: 0,
    compras_confirmadas: 0,
    costo_ventas: 0,
    mermas_vencimiento: 0,
    ganancia: 0,
    perdida: 0,
    ticket_promedio: 0
  };

  const salesTable = await pickTable(db, ['ventas', 'sales'], 'ventas');
  const saleItemsTable = await pickTable(db, ['venta_items', 'sale_items', 'detalle_venta', 'detalle_ventas'], 'venta_items');
  const productsTable = await pickTable(db, ['productos', 'products'], 'productos');
  const returnsTable = await pickTable(db, ['sale_returns', 'devoluciones_ventas'], 'sale_returns');
  const returnItemsTable = await pickTable(db, ['sale_return_items'], 'sale_return_items');
  const manualReturnsTable = await pickTable(db, ['sale_returns_manual'], 'sale_returns_manual');
  const purchasesTable = await pickTable(db, ['purchases', 'compras'], 'purchases');

  const saleRows = [];
  const saleIds = [];
  const salesById = new Map();
  const saleItemsDetailedBySale = new Map();
  const saleProductQtyMap = new Map();
  const saleProductCostMap = new Map();
  const productCostMap = new Map();
  const productNameMap = new Map();
  const productMetaMap = new Map();
  const paymentsBySale = new Map();
  const hospitalBySale = new Map();
  const returnItemsDetailedBySale = new Map();
  const returnServiceTotalsBySale = new Map();
  const manualReturnEntries = [];
  const productIds = new Set();
  const breakdown = createBreakdownMaps();

  if (await tableExists(db, salesTable)) {
    const saleIdCol = await pickColumn(db, salesTable, ['id', 'venta_id', 'sale_id'], 'id');
    const saleDateCol = await pickColumn(db, salesTable, ['fecha', 'created_at', 'fecha_venta'], 'fecha');
    const saleTotalCol = await pickColumn(db, salesTable, ['total', 'monto_total', 'importe_total', 'amount_total'], 'total');
    if (saleIdCol && saleDateCol) {
      const params = [];
      const where = sqlDateFilters('v', saleDateCol, from, to, params);
      const salesRes = await query(
        `SELECT v.${quoteIdent(saleIdCol)} AS id,
                DATE(v.${quoteIdent(saleDateCol)}) AS fecha,
                COALESCE(v.${quoteIdent(saleTotalCol)}, 0) AS total
         FROM ${quoteIdent(salesTable)} v
         ${where}
         ORDER BY DATE(v.${quoteIdent(saleDateCol)}) ASC, v.${quoteIdent(saleIdCol)} ASC`,
        params,
        db
      );
      for (const row of salesRes.rows || []) {
        const saleId = Number(row.id || 0);
        if (!saleId) continue;
        const day = toDayKey(row.fecha);
        const total = roundMoney(row.total);
        const dayRow = ensureRecordDay(dayMap, day);
        dayRow.tickets += 1;
        dayRow.ventas_brutas = roundMoney(dayRow.ventas_brutas + total);
        totals.tickets += 1;
        totals.ventas_brutas = roundMoney(totals.ventas_brutas + total);
        saleRows.push({ id: saleId, fecha: day, total });
        saleIds.push(saleId);
        salesById.set(saleId, { fecha: day, total });
      }
    }
  }

  if (saleIds.length && (await tableExists(db, saleItemsTable))) {
    const siSaleIdCol = await pickColumn(db, saleItemsTable, ['venta_id', 'sale_id', 'id_venta'], null);
    const siProdIdCol = await pickColumn(db, saleItemsTable, ['producto_id', 'product_id', 'id_producto'], null);
    const siQtyCol = await pickColumn(db, saleItemsTable, ['cantidad', 'quantity', 'qty'], null);
    const siUnitCol = await pickColumn(db, saleItemsTable, ['precio_unit', 'precio_unitario', 'unit_price'], null);
    const siSubCol = await pickColumn(db, saleItemsTable, ['subtotal', 'importe', 'total_linea'], null);
    if (siSaleIdCol && siProdIdCol && siQtyCol) {
      const itemRes = await query(
        `SELECT ${quoteIdent(siSaleIdCol)} AS sale_id,
                ${quoteIdent(siProdIdCol)} AS product_id,
                ${quoteIdent(siQtyCol)} AS quantity
                ${siUnitCol ? `, ${quoteIdent(siUnitCol)} AS unit_price` : ', NULL AS unit_price'}
                ${siSubCol ? `, ${quoteIdent(siSubCol)} AS subtotal` : ', NULL AS subtotal'}
         FROM ${quoteIdent(saleItemsTable)}
         WHERE ${quoteIdent(siSaleIdCol)} = ANY($1)`,
        [saleIds],
        db
      );
      for (const row of itemRes.rows || []) {
        const saleId = Number(row.sale_id || 0);
        const productId = Number(row.product_id || 0);
        if (!saleId || !productId) continue;
        const quantity = Number(row.quantity || 0);
        if (!saleItemsDetailedBySale.has(saleId)) saleItemsDetailedBySale.set(saleId, []);
        saleItemsDetailedBySale.get(saleId).push(row);
        const key = `${saleId}:${productId}`;
        saleProductQtyMap.set(key, Number((saleProductQtyMap.get(key) || 0) + quantity));
        productIds.add(productId);
      }
    }
  }

  if (await tableExists(db, productsTable)) {
    if (productIds.size) {
      const prodCols = await getColumns(db, productsTable);
      const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
      const prodCostCol = await pickColumn(db, productsTable, ['precio_costo', 'cost_price', 'unit_cost'], 'precio_costo');
      const prodNameCol = await pickColumn(
        db,
        productsTable,
        ['nombre_comercial', 'nombre', 'name', 'descripcion'],
        'nombre_comercial'
      );
      const prodCodeCol = prodCols.includes('codigo_barra') ? 'codigo_barra' : null;
      const prodHouseCol = prodCols.includes('casa') ? 'casa' : null;
      const prodTypeCol = prodCols.includes('tipo') ? 'tipo' : null;
      const prodRes = await query(
        `SELECT ${quoteIdent(prodIdCol)} AS id,
                COALESCE(${quoteIdent(prodCostCol)}, 0) AS cost,
                ${quoteIdent(prodNameCol)} AS name
                ${prodCodeCol ? `, ${quoteIdent(prodCodeCol)} AS code` : ", '' AS code"}
                ${prodHouseCol ? `, ${quoteIdent(prodHouseCol)} AS house` : ", '' AS house"}
                ${prodTypeCol ? `, ${quoteIdent(prodTypeCol)} AS type` : ", 'medicamento' AS type"}
         FROM ${quoteIdent(productsTable)}
         WHERE ${quoteIdent(prodIdCol)} = ANY($1)`,
        [Array.from(productIds)],
        db
      );
      for (const row of prodRes.rows || []) {
        const productId = Number(row.id || 0);
        const name = String(row.name || '').trim();
        productCostMap.set(productId, roundMoney(row.cost));
        productNameMap.set(productId, name);
        productMetaMap.set(productId, {
          id: productId,
          name,
          code: String(row.code || '').trim(),
          house: String(row.house || '').trim(),
          type: String(row.type || '').trim()
        });
      }
    }

    if (saleIds.length && (await tableExists(db, 'lot_sales')) && (await tableExists(db, 'lots'))) {
      const lotCols = await getColumns(db, 'lots');
      const hasLotCost = lotCols.includes('cost_price');
      const hasPurchaseId = lotCols.includes('purchase_id');
      let purchaseJoin = '';
      let costExpr = hasLotCost ? 'COALESCE(NULLIF(l.cost_price, 0), 0)' : '0';
      if (hasPurchaseId && (await tableExists(db, 'purchase_items'))) {
        purchaseJoin = `LEFT JOIN LATERAL (
          SELECT unit_price
          FROM purchase_items pi
          WHERE pi.purchase_id = l.purchase_id AND pi.product_id = l.product_id
          ORDER BY pi.id ASC
          LIMIT 1
        ) pi ON TRUE`;
        costExpr = hasLotCost
          ? 'COALESCE(NULLIF(l.cost_price, 0), pi.unit_price, 0)'
          : 'COALESCE(pi.unit_price, 0)';
      }
      const costRes = await query(
        `SELECT ls.sale_id,
                l.product_id,
                SUM(ls.quantity) AS quantity,
                SUM(ls.quantity * ${costExpr}) AS cost
         FROM lot_sales ls
         JOIN lots l ON l.id = ls.lot_id
         ${purchaseJoin}
         WHERE ls.sale_id = ANY($1)
         GROUP BY ls.sale_id, l.product_id`,
        [saleIds],
        db
      );
      for (const row of costRes.rows || []) {
        const saleId = Number(row.sale_id || 0);
        const productId = Number(row.product_id || 0);
        if (!saleId || !productId) continue;
        const key = `${saleId}:${productId}`;
        saleProductCostMap.set(key, {
          quantity: Number(row.quantity || 0),
          cost: roundMoney(row.cost)
        });
      }
    }

    for (const [key, quantity] of saleProductQtyMap.entries()) {
      const [saleIdRaw, productIdRaw] = key.split(':');
      const saleId = Number(saleIdRaw || 0);
      const productId = Number(productIdRaw || 0);
      const sale = salesById.get(saleId);
      if (!sale) continue;
      const dayRow = ensureRecordDay(dayMap, sale.fecha);
      let cost = 0;
      if (saleProductCostMap.has(key)) {
        cost = roundMoney(saleProductCostMap.get(key).cost);
      } else {
        cost = roundMoney(Number(quantity || 0) * Number(productCostMap.get(productId) || 0));
      }
      dayRow.costo_ventas = roundMoney(dayRow.costo_ventas + cost);
      totals.costo_ventas = roundMoney(totals.costo_ventas + cost);
    }

    if (saleIds.length && (await tableExists(db, 'payments'))) {
      const paymentsTable = await pickTable(db, ['payments', 'pagos'], 'payments');
      const paySaleIdCol = await pickColumn(db, paymentsTable, ['sale_id', 'venta_id', 'id_venta'], null);
      const payDetCol = await pickColumn(
        db,
        paymentsTable,
        ['payment_method_details', 'detalles', 'det', 'meta', 'method_details'],
        null
      );
      if (paySaleIdCol) {
        const cols = [
          `${quoteIdent(paySaleIdCol)} AS sale_id`,
          payDetCol ? `${quoteIdent(payDetCol)} AS payment_method_details` : 'NULL AS payment_method_details'
        ];
        const payRes = await query(
          `SELECT ${cols.join(',')} FROM ${quoteIdent(paymentsTable)} WHERE ${quoteIdent(paySaleIdCol)} = ANY($1)`,
          [saleIds],
          db
        );
        for (const row of payRes.rows || []) {
          const saleId = Number(row.sale_id || 0);
          if (!saleId) continue;
          if (!paymentsBySale.has(saleId)) paymentsBySale.set(saleId, []);
          paymentsBySale.get(saleId).push(row);
        }
      }

      if (paymentsBySale.size) {
        const prodCols = await getColumns(db, productsTable);
        const prodIdCol = await pickColumn(db, productsTable, ['id', 'producto_id', 'product_id'], 'id');
        const prodNameCol = await pickColumn(
          db,
          productsTable,
          ['nombre_comercial', 'nombre', 'name', 'descripcion'],
          'nombre_comercial'
        );
        const prodCodeCol = prodCols.includes('codigo_barra') ? 'codigo_barra' : null;
        const prodHouseCol = prodCols.includes('casa') ? 'casa' : null;
        const prodTypeCol = prodCols.includes('tipo') ? 'tipo' : null;
        const serviceProductIds = new Set();
        for (const payments of paymentsBySale.values()) {
          const services = collectSummaryServices(payments);
          for (const service of services) {
            const productId = getSummaryServiceProductId(service);
            if (productId && !productMetaMap.has(productId)) serviceProductIds.add(productId);
          }
        }
        if (serviceProductIds.size && prodIdCol && prodNameCol) {
          const prodRes = await query(
            `SELECT ${quoteIdent(prodIdCol)} AS id,
                    ${quoteIdent(prodNameCol)} AS name
                    ${prodCodeCol ? `, ${quoteIdent(prodCodeCol)} AS code` : ", '' AS code"}
                    ${prodHouseCol ? `, ${quoteIdent(prodHouseCol)} AS house` : ", '' AS house"}
                    ${prodTypeCol ? `, ${quoteIdent(prodTypeCol)} AS type` : ", 'medicamento' AS type"}
               FROM ${quoteIdent(productsTable)}
              WHERE ${quoteIdent(prodIdCol)} = ANY($1)`,
            [Array.from(serviceProductIds)],
            db
          );
          for (const row of prodRes.rows || []) {
            const productId = Number(row.id || 0);
            if (!productId) continue;
            const name = String(row.name || '').trim();
            if (!productNameMap.has(productId)) productNameMap.set(productId, name);
            productMetaMap.set(productId, {
              id: productId,
              name,
              code: String(row.code || '').trim(),
              house: String(row.house || '').trim(),
              type: String(row.type || '').trim()
            });
          }
        }
      }
    }

    if (saleIds.length && (await tableExists(db, 'hospital_payments')) && (await tableExists(db, 'hospital_admissions'))) {
      const hospRes = await query(
        `SELECT hp.sale_id, hp.admission_id, a.tipo
         FROM hospital_payments hp
         JOIN hospital_admissions a ON a.id = hp.admission_id
         WHERE hp.sale_id = ANY($1)`,
        [saleIds],
        db
      );
      for (const row of hospRes.rows || []) {
        const saleId = Number(row.sale_id || 0);
        if (!saleId || hospitalBySale.has(saleId)) continue;
        hospitalBySale.set(saleId, {
          admission_id: Number(row.admission_id || 0),
          tipo: String(row.tipo || '').toLowerCase()
        });
      }
    }

    if (await tableExists(db, returnsTable)) {
      const returnIdCol = await pickColumn(db, returnsTable, ['id', 'return_id'], 'id');
      const returnSaleIdCol = await pickColumn(db, returnsTable, ['sale_id', 'venta_id', 'id_venta'], 'sale_id');
      const returnDateCol = await pickColumn(db, returnsTable, ['created_at', 'fecha', 'return_date'], 'created_at');
      const returnTotalCol = await pickColumn(db, returnsTable, ['total_return', 'total', 'amount'], null);
      const serviceTotalCol = await pickColumn(db, returnsTable, ['service_total'], null);

      if (returnIdCol && returnDateCol) {
        const returnParams = [];
        const whereReturns = sqlDateFilters('r', returnDateCol, from, to, returnParams);
        const returnRowsRes = await query(
          `SELECT r.${quoteIdent(returnIdCol)} AS id,
                  ${returnSaleIdCol ? `r.${quoteIdent(returnSaleIdCol)} AS sale_id,` : 'NULL AS sale_id,'}
                  DATE(r.${quoteIdent(returnDateCol)}) AS fecha
                  ${returnTotalCol ? `, COALESCE(r.${quoteIdent(returnTotalCol)}, 0) AS total_return` : ', NULL AS total_return'}
                  ${serviceTotalCol ? `, COALESCE(r.${quoteIdent(serviceTotalCol)}, 0) AS service_total` : ', 0 AS service_total'}
           FROM ${quoteIdent(returnsTable)} r
           ${whereReturns}
           ORDER BY DATE(r.${quoteIdent(returnDateCol)}) ASC, r.${quoteIdent(returnIdCol)} ASC`,
          returnParams,
          db
        );

        const returnRows = returnRowsRes.rows || [];
        const returnIds = returnRows.map((row) => Number(row.id || 0)).filter((id) => id > 0);
        const returnTotalsById = new Map();
        for (const row of returnRows) {
          const saleId = Number(row.sale_id || 0);
          if (!saleId) continue;
          returnServiceTotalsBySale.set(
            saleId,
            roundMoney(Number(returnServiceTotalsBySale.get(saleId) || 0) + Number(row.service_total || 0))
          );
        }

        if (returnIds.length && (await tableExists(db, returnItemsTable))) {
          const riReturnIdCol = await pickColumn(db, returnItemsTable, ['return_id'], 'return_id');
          const riQtyCol = await pickColumn(db, returnItemsTable, ['quantity', 'cantidad', 'qty'], null);
          const riUnitCol = await pickColumn(db, returnItemsTable, ['unit_price', 'precio_unit', 'precio_unitario'], null);
          const riSubCol = await pickColumn(db, returnItemsTable, ['subtotal', 'importe', 'total_linea'], null);
          if (riReturnIdCol && (riSubCol || (riQtyCol && riUnitCol))) {
            const amountExpr = riSubCol
              ? `COALESCE(${quoteIdent(riSubCol)}, 0)`
              : `(COALESCE(${quoteIdent(riQtyCol)}, 0) * COALESCE(${quoteIdent(riUnitCol)}, 0))`;
            const retTotRes = await query(
              `SELECT ${quoteIdent(riReturnIdCol)} AS return_id,
                      SUM(${amountExpr}) AS total
               FROM ${quoteIdent(returnItemsTable)}
               WHERE ${quoteIdent(riReturnIdCol)} = ANY($1)
               GROUP BY ${quoteIdent(riReturnIdCol)}`,
              [returnIds],
              db
            );
            for (const row of retTotRes.rows || []) {
              returnTotalsById.set(Number(row.return_id), roundMoney(row.total));
            }
          }
        }

        for (const row of returnRows) {
          const day = toDayKey(row.fecha);
          const id = Number(row.id || 0);
          const itemTotal = roundMoney(returnTotalsById.get(id) || 0);
          const headerTotal = roundMoney(row.total_return);
          const serviceTotal = roundMoney(row.service_total);
          const totalReturn = roundMoney(headerTotal > 0 ? headerTotal : itemTotal + serviceTotal);
          const dayRow = ensureRecordDay(dayMap, day);
          dayRow.devoluciones = roundMoney(dayRow.devoluciones + totalReturn);
          totals.devoluciones = roundMoney(totals.devoluciones + totalReturn);
        }

        if (returnIds.length && (await tableExists(db, returnItemsTable))) {
          const riReturnIdCol = await pickColumn(db, returnItemsTable, ['return_id'], 'return_id');
          const riProdCol = await pickColumn(db, returnItemsTable, ['product_id', 'producto_id', 'id_producto'], null);
          const riQtyCol = await pickColumn(db, returnItemsTable, ['quantity', 'cantidad', 'qty'], null);
          const riUnitCol = await pickColumn(db, returnItemsTable, ['unit_price', 'precio_unit', 'precio_unitario'], null);
          const riSubCol = await pickColumn(db, returnItemsTable, ['subtotal', 'importe', 'total_linea'], null);
          const riDescCol = await pickColumn(db, returnItemsTable, ['descripcion', 'description', 'detalle'], null);
          if (riReturnIdCol && riQtyCol && returnSaleIdCol) {
            const detailRes = await query(
              `SELECT r.${quoteIdent(returnSaleIdCol)} AS sale_id,
                      DATE(r.${quoteIdent(returnDateCol)}) AS fecha,
                      ${riProdCol ? `ri.${quoteIdent(riProdCol)}` : 'NULL'} AS product_id,
                      ri.${quoteIdent(riQtyCol)} AS quantity
                      ${riUnitCol ? `, ri.${quoteIdent(riUnitCol)} AS unit_price` : ', NULL AS unit_price'}
                      ${riSubCol ? `, ri.${quoteIdent(riSubCol)} AS subtotal` : ', NULL AS subtotal'}
                      ${riDescCol ? `, ri.${quoteIdent(riDescCol)} AS descripcion` : ', NULL AS descripcion'}
               FROM ${quoteIdent(returnsTable)} r
               JOIN ${quoteIdent(returnItemsTable)} ri
                 ON ri.${quoteIdent(riReturnIdCol)} = r.${quoteIdent(returnIdCol)}
               ${whereReturns}`,
              returnParams,
              db
            );
            for (const row of detailRes.rows || []) {
              const saleId = Number(row.sale_id || 0);
              if (!saleId) continue;
              if (!returnItemsDetailedBySale.has(saleId)) returnItemsDetailedBySale.set(saleId, []);
              returnItemsDetailedBySale.get(saleId).push(row);
            }
          }
        }

        if (returnIds.length && (await tableExists(db, returnItemsTable))) {
          const riReturnIdCol = await pickColumn(db, returnItemsTable, ['return_id'], 'return_id');
          const riProdCol = await pickColumn(db, returnItemsTable, ['product_id', 'producto_id', 'id_producto'], null);
          const riQtyCol = await pickColumn(db, returnItemsTable, ['quantity', 'cantidad', 'qty'], null);
          if (riReturnIdCol && riProdCol && riQtyCol && returnSaleIdCol) {
            const retItemsRes = await query(
              `SELECT r.${quoteIdent(returnSaleIdCol)} AS sale_id,
                      DATE(r.${quoteIdent(returnDateCol)}) AS fecha,
                      ri.${quoteIdent(riProdCol)} AS product_id,
                      SUM(ri.${quoteIdent(riQtyCol)}) AS quantity
               FROM ${quoteIdent(returnsTable)} r
               JOIN ${quoteIdent(returnItemsTable)} ri
                 ON ri.${quoteIdent(riReturnIdCol)} = r.${quoteIdent(returnIdCol)}
               ${whereReturns}
               GROUP BY r.${quoteIdent(returnSaleIdCol)}, DATE(r.${quoteIdent(returnDateCol)}), ri.${quoteIdent(riProdCol)}`,
              returnParams,
              db
            );
            for (const row of retItemsRes.rows || []) {
              const saleId = Number(row.sale_id || 0);
              const productId = Number(row.product_id || 0);
              if (!saleId || !productId) continue;
              const qty = Number(row.quantity || 0);
              const key = `${saleId}:${productId}`;
              let unitCost = 0;
              const soldCost = saleProductCostMap.get(key);
              if (soldCost && Number(soldCost.quantity || 0) > 0) {
                unitCost = Number(soldCost.cost || 0) / Number(soldCost.quantity || 1);
              } else {
                unitCost = Number(productCostMap.get(productId) || 0);
              }
              const restoredCost = roundMoney(qty * unitCost);
              const dayRow = ensureRecordDay(dayMap, row.fecha);
              dayRow.costo_ventas = roundMoney(dayRow.costo_ventas - restoredCost);
              totals.costo_ventas = roundMoney(totals.costo_ventas - restoredCost);
            }
          }
        }
      }
    }
  }

  if (await tableExists(db, manualReturnsTable)) {
    const mrDateCol = await pickColumn(db, manualReturnsTable, ['created_at', 'fecha'], 'created_at');
    const mrAmountCol = await pickColumn(db, manualReturnsTable, ['amount', 'monto'], 'amount');
    if (mrDateCol && mrAmountCol) {
      const params = [];
      const where = sqlDateFilters('m', mrDateCol, from, to, params);
      const manualRes = await query(
        `SELECT DATE(m.${quoteIdent(mrDateCol)}) AS fecha,
                SUM(COALESCE(m.${quoteIdent(mrAmountCol)}, 0)) AS total
         FROM ${quoteIdent(manualReturnsTable)} m
         ${where}
         GROUP BY DATE(m.${quoteIdent(mrDateCol)})
         ORDER BY DATE(m.${quoteIdent(mrDateCol)}) ASC`,
        params,
        db
      );
      for (const row of manualRes.rows || []) {
        const day = toDayKey(row.fecha);
        const amount = roundMoney(row.total);
        manualReturnEntries.push({ fecha: day, amount });
        const dayRow = ensureRecordDay(dayMap, day);
        dayRow.devoluciones = roundMoney(dayRow.devoluciones + amount);
        dayRow.devoluciones_manuales = roundMoney(dayRow.devoluciones_manuales + amount);
        totals.devoluciones = roundMoney(totals.devoluciones + amount);
        totals.devoluciones_manuales = roundMoney(totals.devoluciones_manuales + amount);
      }
    }
  }

  if (await tableExists(db, purchasesTable)) {
    const purchaseDateCol = await pickColumn(db, purchasesTable, ['created_at', 'fecha', 'purchase_date'], 'created_at');
    const purchaseTotalCol = await pickColumn(db, purchasesTable, ['total', 'monto_total', 'importe_total'], 'total');
    const purchaseStatusCol = await pickColumn(db, purchasesTable, ['status', 'estado'], null);
    if (purchaseDateCol && purchaseTotalCol) {
      const params = [];
      const clauses = [];
      if (from) {
        clauses.push(`DATE(p.${quoteIdent(purchaseDateCol)}) >= $${params.length + 1}`);
        params.push(from);
      }
      if (to) {
        clauses.push(`DATE(p.${quoteIdent(purchaseDateCol)}) <= $${params.length + 1}`);
        params.push(to);
      }
      if (purchaseStatusCol) {
        clauses.push(`LOWER(COALESCE(p.${quoteIdent(purchaseStatusCol)}, '')) IN ('confirmed', 'confirmado')`);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const purchaseRes = await query(
        `SELECT DATE(p.${quoteIdent(purchaseDateCol)}) AS fecha,
                SUM(COALESCE(p.${quoteIdent(purchaseTotalCol)}, 0)) AS total
         FROM ${quoteIdent(purchasesTable)} p
         ${where}
         GROUP BY DATE(p.${quoteIdent(purchaseDateCol)})
         ORDER BY DATE(p.${quoteIdent(purchaseDateCol)}) ASC`,
        params,
        db
      );
      for (const row of purchaseRes.rows || []) {
        const day = toDayKey(row.fecha);
        const total = roundMoney(row.total);
        const dayRow = ensureRecordDay(dayMap, day);
        dayRow.compras_confirmadas = roundMoney(dayRow.compras_confirmadas + total);
        totals.compras_confirmadas = roundMoney(totals.compras_confirmadas + total);
      }
    }
  }

  for (const sale of saleRows) {
    const saleId = Number(sale.id || 0);
    if (!saleId) continue;
    const saleTotal = Number(sale.total || 0);
    const items = saleItemsDetailedBySale.get(saleId) || [];
    const payments = paymentsBySale.get(saleId) || [];
    const services = collectSummaryServices(payments);
    const admissionInfo = hospitalBySale.get(saleId) || null;

    let context = 'consulta';
    if (admissionInfo) {
      context = admissionInfo.tipo === 'emergencia' ? 'emergencia' : 'hospital';
    } else {
      for (const payment of payments) {
        const details = parseSummaryDetails(payment.payment_method_details);
        const origin = String(details?.origen || details?.origin || details?.tipo || details?.type || '').toLowerCase();
        if (origin === 'emergencia') {
          context = 'emergencia';
          break;
        }
        if (origin === 'hospital' || origin === 'hospitalizacion' || origin === 'hospitalización') {
          context = 'hospital';
          break;
        }
      }
    }

    const saleGross =
      items.reduce((sum, item) => {
        const qty = Number(item.quantity || 0);
        const unit = Number(item.unit_price || 0);
        const subtotal =
          item.subtotal != null
            ? Number(item.subtotal || 0)
            : Number.isFinite(qty) && Number.isFinite(unit)
            ? qty * unit
            : 0;
        return sum + (Number.isFinite(subtotal) ? subtotal : 0);
      }, 0) +
      services.reduce((sum, service) => {
        const subtotal =
          service.subtotal != null
            ? Number(service.subtotal || 0)
            : Number(service.cantidad || 1) * Number(service.precio_unit || 0);
        return sum + (Number.isFinite(subtotal) ? subtotal : 0);
      }, 0);

    const saleRatio = saleGross > 0 && saleTotal > 0 ? saleTotal / saleGross : 1;
    let allocatedGross = 0;

    for (const item of items) {
      const qty = Number(item.quantity || 0);
      const unit = Number(item.unit_price || 0);
      const subtotal =
        item.subtotal != null
          ? Number(item.subtotal || 0)
          : Number.isFinite(qty) && Number.isFinite(unit)
          ? qty * unit
          : 0;
      if (!Number.isFinite(subtotal) || subtotal <= 0) continue;
      const productId = Number(item.product_id || 0);
      const label = productNameMap.get(productId) || (productId ? `Producto ${productId}` : 'Producto');
      const bucket = classifySummaryBucket(label, true, context);
      const adjusted = roundMoney(saleRatio !== 1 ? subtotal * saleRatio : subtotal);
      addBreakdownRevenue(breakdown, context, bucket, adjusted);
      allocatedGross += adjusted;

      const soldCost = saleProductCostMap.get(`${saleId}:${productId}`);
      const unitCost =
        soldCost && Number(soldCost.quantity || 0) > 0
          ? Number(soldCost.cost || 0) / Number(soldCost.quantity || 1)
          : Number(productCostMap.get(productId) || 0);
      const costAmount = roundMoney(qty * unitCost);
      addBreakdownCost(breakdown, context, bucket, costAmount);
    }

    for (const service of services) {
      const label = service.producto || service.descripcion || 'Servicio';
      const serviceMeta = productMetaMap.get(getSummaryServiceProductId(service)) || null;
      const amount =
        service.subtotal != null
          ? Number(service.subtotal || 0)
          : Number(service.cantidad || 1) * Number(service.precio_unit || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      let serviceContext = context;
      if (context === 'consulta') {
        const override = detectSummaryContextOverride(label);
        if (override) serviceContext = override;
      }
      const bucket = classifySummaryBucket(label, false, serviceContext, serviceMeta);
      const adjusted = roundMoney(saleRatio !== 1 ? amount * saleRatio : amount);
      addBreakdownRevenue(breakdown, serviceContext, bucket, adjusted);
      allocatedGross += adjusted;
    }

    const returnItems = returnItemsDetailedBySale.get(saleId) || [];
    let serviceReturnItemsTotal = 0;

    for (const row of returnItems) {
      const qty = Number(row.quantity || 0);
      const unit = Number(row.unit_price || 0);
      const subtotal =
        row.subtotal != null
          ? Number(row.subtotal || 0)
          : Number.isFinite(qty) && Number.isFinite(unit)
          ? qty * unit
          : 0;
      if (!Number.isFinite(subtotal) || subtotal <= 0) continue;

      const productId = Number(row.product_id || 0);
      if (productId) {
        const label = productNameMap.get(productId) || `Producto ${productId}`;
        const bucket = classifySummaryBucket(label, true, context);
        const adjusted = roundMoney(saleRatio !== 1 ? subtotal * saleRatio : subtotal);
        addBreakdownReturn(breakdown, context, bucket, adjusted);

        const soldCost = saleProductCostMap.get(`${saleId}:${productId}`);
        const unitCost =
          soldCost && Number(soldCost.quantity || 0) > 0
            ? Number(soldCost.cost || 0) / Number(soldCost.quantity || 1)
            : Number(productCostMap.get(productId) || 0);
        const restoredCost = roundMoney(qty * unitCost);
        addBreakdownCost(breakdown, context, bucket, -1 * restoredCost);
      } else {
        const label = row.descripcion ? String(row.descripcion) : 'Servicio';
        let serviceContext = context;
        if (context === 'consulta') {
          const override = detectSummaryContextOverride(label);
          if (override) serviceContext = override;
        }
        const bucket = classifySummaryBucket(label, false, serviceContext, null);
        const adjusted = roundMoney(saleRatio !== 1 ? subtotal * saleRatio : subtotal);
        addBreakdownReturn(breakdown, serviceContext, bucket, adjusted);
        serviceReturnItemsTotal += subtotal;
      }
    }

    const serviceRefundTotal = Number(returnServiceTotalsBySale.get(saleId) || 0);
    const remainingServiceRefund = Math.max(0, serviceRefundTotal - serviceReturnItemsTotal);
    if (remainingServiceRefund > 0.0001) {
      let pending = remainingServiceRefund;
      for (const service of services) {
        if (pending <= 0.0001) break;
        const label = service.producto || service.descripcion || 'Servicio';
        const serviceMeta = productMetaMap.get(getSummaryServiceProductId(service)) || null;
        const amount =
          service.subtotal != null
            ? Number(service.subtotal || 0)
            : Number(service.cantidad || 1) * Number(service.precio_unit || 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        let serviceContext = context;
        if (context === 'consulta') {
          const override = detectSummaryContextOverride(label);
          if (override) serviceContext = override;
        }
        const bucket = classifySummaryBucket(label, false, serviceContext, serviceMeta);
        const refundPortion = Math.min(amount, pending);
        const adjusted = roundMoney(saleRatio !== 1 ? refundPortion * saleRatio : refundPortion);
        addBreakdownReturn(breakdown, serviceContext, bucket, adjusted);
        pending -= refundPortion;
      }
      if (pending > 0.0001) {
        const adjusted = roundMoney(saleRatio !== 1 ? pending * saleRatio : pending);
        addBreakdownReturn(breakdown, context, 'otros', adjusted);
      }
    }

    if (allocatedGross <= 0.0001 && saleTotal > 0) {
      addBreakdownRevenue(breakdown, context, 'otros', saleTotal);
    }
  }

  for (const entry of manualReturnEntries) {
    addBreakdownField(breakdown.byArea.get('ajustes_manuales'), 'devoluciones', Number(entry.amount || 0));
    addBreakdownField(breakdown.byService.get('ajustes_manuales'), 'devoluciones', Number(entry.amount || 0));
  }

  if (await tableExists(db, 'inventory_writeoffs')) {
    const iwDateCol = await pickColumn(db, 'inventory_writeoffs', ['created_at', 'fecha'], 'created_at');
    const iwAmountCol = await pickColumn(db, 'inventory_writeoffs', ['total_cost', 'amount', 'subtotal'], 'total_cost');
    const iwProdCol = await pickColumn(db, 'inventory_writeoffs', ['product_id', 'producto_id'], null);
    const iwLabelCol = await pickColumn(db, 'inventory_writeoffs', ['product_label', 'descripcion', 'detalle'], null);
    const iwReasonCol = await pickColumn(db, 'inventory_writeoffs', ['reason', 'motivo', 'tipo'], null);
    if (iwDateCol && iwAmountCol) {
      const params = [];
      const clauses = [];
      if (from) {
        clauses.push(`DATE(i.${quoteIdent(iwDateCol)}) >= $${params.length + 1}`);
        params.push(from);
      }
      if (to) {
        clauses.push(`DATE(i.${quoteIdent(iwDateCol)}) <= $${params.length + 1}`);
        params.push(to);
      }
      if (iwReasonCol) {
        clauses.push(
          `LOWER(COALESCE(i.${quoteIdent(iwReasonCol)}, '')) IN ('expired', 'vencimiento', 'merma_vencimiento')`
        );
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const writeoffRes = await query(
        `SELECT
           DATE(i.${quoteIdent(iwDateCol)}) AS fecha,
           COALESCE(i.${quoteIdent(iwAmountCol)}, 0) AS total_cost,
           ${iwProdCol ? `i.${quoteIdent(iwProdCol)} AS product_id,` : 'NULL AS product_id,'}
           ${iwLabelCol ? `i.${quoteIdent(iwLabelCol)} AS product_label` : 'NULL AS product_label'}
         FROM inventory_writeoffs i
         ${where}
         ORDER BY DATE(i.${quoteIdent(iwDateCol)}) ASC, i.id ASC`,
        params,
        db
      );
      for (const row of writeoffRes.rows || []) {
        const amount = roundMoney(row.total_cost);
        if (!amount) continue;
        const day = toDayKey(row.fecha);
        const dayRow = ensureRecordDay(dayMap, day);
        dayRow.mermas_vencimiento = roundMoney(dayRow.mermas_vencimiento + amount);
        totals.mermas_vencimiento = roundMoney(totals.mermas_vencimiento + amount);

        const productId = Number(row.product_id || 0);
        const label =
          String(row.product_label || '').trim() ||
          productNameMap.get(productId) ||
          (productId ? `Producto ${productId}` : 'Inventario');
        const bucket = classifySummaryBucket(label, true, 'consulta');
        addBreakdownExpiryLoss(breakdown, bucket, amount);
      }
    }
  }

  const daily = Array.from(dayMap.values())
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
    .map((row) => {
      const ventasNetas = roundMoney(row.ventas_brutas - row.devoluciones);
      const utilidad = roundMoney(ventasNetas - row.costo_ventas - row.mermas_vencimiento);
      row.ventas_netas = ventasNetas;
      row.ganancia = utilidad > 0 ? utilidad : 0;
      row.perdida = utilidad < 0 ? roundMoney(Math.abs(utilidad)) : 0;
      row.costo_ventas = roundMoney(row.costo_ventas);
      row.mermas_vencimiento = roundMoney(row.mermas_vencimiento);
      return row;
    });

  totals.ventas_netas = roundMoney(totals.ventas_brutas - totals.devoluciones);
  const utilidadTotal = roundMoney(totals.ventas_netas - totals.costo_ventas - totals.mermas_vencimiento);
  totals.ganancia = utilidadTotal > 0 ? utilidadTotal : 0;
  totals.perdida = utilidadTotal < 0 ? roundMoney(Math.abs(utilidadTotal)) : 0;
  totals.ticket_promedio = totals.tickets ? roundMoney(totals.ventas_netas / totals.tickets) : 0;
  totals.costo_ventas = roundMoney(totals.costo_ventas);
  totals.mermas_vencimiento = roundMoney(totals.mermas_vencimiento);

  return {
    ok: true,
    from,
    to,
    totals,
    breakdown: {
      by_area: finalizeBreakdown(breakdown.byArea),
      by_service: finalizeBreakdown(breakdown.byService)
    },
    daily
  };
}

async function buildRecordsWorkbook(summary) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SistemaHHG';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const totals = summary?.totals || {};
  const daily = Array.isArray(summary?.daily) ? summary.daily : [];
  const byArea = Array.isArray(summary?.breakdown?.by_area) ? summary.breakdown.by_area : [];
  const byService = Array.isArray(summary?.breakdown?.by_service) ? summary.breakdown.by_service : [];
  const generatedAt = new Date().toLocaleString('es-GT');
  const rangeLabel =
    summary?.from && summary?.to
      ? `${summary.from} a ${summary.to}`
      : summary?.from
      ? `Desde ${summary.from}`
      : summary?.to
      ? `Hasta ${summary.to}`
      : 'Sin filtro';

  const theme = {
    navy: '10233B',
    blue: '0F5E9C',
    teal: '18A4A6',
    green: '157347',
    red: 'B02A37',
    amber: 'C27A08',
    pale: 'EEF6FF',
    pale2: 'F7FBFF',
    line: 'D7E1EE',
    inkSoft: '5A6A7F',
    white: 'FFFFFF',
    grayBar: 'E8EEF6'
  };

  const moneyFormat = '"Q"#,##0.00;[Red]-"Q"#,##0.00';
  const integerFormat = '#,##0';

  const baseBorder = {
    top: { style: 'thin', color: { argb: theme.line } },
    left: { style: 'thin', color: { argb: theme.line } },
    bottom: { style: 'thin', color: { argb: theme.line } },
    right: { style: 'thin', color: { argb: theme.line } }
  };

  function setCell(cell, options = {}) {
    if (options.value !== undefined) cell.value = options.value;
    cell.font = options.font || cell.font || {};
    cell.fill = options.fill || cell.fill;
    cell.alignment = options.alignment || cell.alignment || { vertical: 'middle', horizontal: 'left' };
    cell.border = options.border || cell.border || baseBorder;
    if (options.numFmt) cell.numFmt = options.numFmt;
  }

  function styleRange(ws, rowStart, colStart, rowEnd, colEnd, options = {}) {
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        setCell(ws.getCell(row, col), options);
      }
    }
  }

  function titleCaseText(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function addKpiCard(ws, row, col, title, value, subtitle, accent) {
    ws.mergeCells(row, col, row, col + 3);
    ws.mergeCells(row + 1, col, row + 2, col + 3);
    ws.mergeCells(row + 3, col, row + 3, col + 3);
    styleRange(ws, row, col, row + 3, col + 3, {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
      border: baseBorder
    });
    setCell(ws.getCell(row, col), {
      value: title,
      font: { bold: true, color: { argb: theme.inkSoft }, size: 10 },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    setCell(ws.getCell(row + 1, col), {
      value,
      font: { bold: true, color: { argb: accent || theme.blue }, size: 18 },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    setCell(ws.getCell(row + 3, col), {
      value: subtitle,
      font: { color: { argb: theme.inkSoft }, size: 9 },
      alignment: { vertical: 'middle', horizontal: 'left', wrapText: true }
    });
  }

  function addNarrativeBlock(ws, row, col, width, title, lines) {
    ws.mergeCells(row, col, row, col + width - 1);
    setCell(ws.getCell(row, col), {
      value: title,
      font: { bold: true, size: 14, color: { argb: theme.navy } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.pale } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    lines.forEach((line, index) => {
      ws.mergeCells(row + 1 + index, col, row + 1 + index, col + width - 1);
      setCell(ws.getCell(row + 1 + index, col), {
        value: line,
        font: { size: 11, color: { argb: theme.navy } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
        alignment: { vertical: 'top', horizontal: 'left', wrapText: true }
      });
    });
  }

  function addBarSection(ws, row, col, title, subtitle, rows, key, accent, options = {}) {
    const data = Array.isArray(rows) ? rows.filter((item) => Math.abs(Number(item?.[key] || 0)) > 0.0001) : [];
    const visible = data.slice(0, options.limit || 8);
    const chartWidth = options.chartWidth || 12;
    ws.mergeCells(row, col, row, col + chartWidth + 5);
    setCell(ws.getCell(row, col), {
      value: title,
      font: { bold: true, size: 13, color: { argb: theme.navy } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.pale } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    ws.mergeCells(row + 1, col, row + 1, col + chartWidth + 5);
    setCell(ws.getCell(row + 1, col), {
      value: subtitle,
      font: { size: 10, color: { argb: theme.inkSoft } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    const headerRow = row + 2;
    ['Categoría', 'Valor'].forEach((label, index) => {
      ws.mergeCells(headerRow, col + index * 3, headerRow, col + index * 3 + 2);
      setCell(ws.getCell(headerRow, col + index * 3), {
        value: label,
        font: { bold: true, size: 10, color: { argb: theme.white } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } },
        alignment: { vertical: 'middle', horizontal: 'left' }
      });
    });
    ws.mergeCells(headerRow, col + 6, headerRow, col + 6 + chartWidth - 1);
    setCell(ws.getCell(headerRow, col + 6), {
      value: 'Gráfica',
      font: { bold: true, size: 10, color: { argb: theme.white } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } },
      alignment: { vertical: 'middle', horizontal: 'center' }
    });

    if (!visible.length) {
      ws.mergeCells(headerRow + 1, col, headerRow + 2, col + chartWidth + 5);
      setCell(ws.getCell(headerRow + 1, col), {
        value: 'Sin datos para este rango.',
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
        font: { italic: true, color: { argb: theme.inkSoft } },
        alignment: { vertical: 'middle', horizontal: 'center' }
      });
      return headerRow + 3;
    }

    const maxAbs = visible.reduce((max, item) => Math.max(max, Math.abs(Number(item[key] || 0))), 0) || 1;
    visible.forEach((item, idx) => {
      const currentRow = headerRow + 1 + idx;
      ws.mergeCells(currentRow, col, currentRow, col + 2);
      setCell(ws.getCell(currentRow, col), {
        value: item.label || titleCaseText(item.id),
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
        font: { size: 10, color: { argb: theme.navy } },
        alignment: { vertical: 'middle', horizontal: 'left' }
      });
      ws.mergeCells(currentRow, col + 3, currentRow, col + 5);
      setCell(ws.getCell(currentRow, col + 3), {
        value: Number(item[key] || 0),
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
        font: { size: 10, color: { argb: theme.navy } },
        numFmt: moneyFormat,
        alignment: { vertical: 'middle', horizontal: 'right' }
      });
      const raw = Number(item[key] || 0);
      const filled = Math.max(0, Math.round((Math.abs(raw) / maxAbs) * chartWidth));
      for (let offset = 0; offset < chartWidth; offset += 1) {
        const barCell = ws.getCell(currentRow, col + 6 + offset);
        setCell(barCell, {
          value: '',
          fill: {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {
              argb:
                offset < filled
                  ? raw >= 0
                    ? accent
                    : theme.red
                  : theme.grayBar
            }
          },
          border: baseBorder
        });
      }
    });
    return headerRow + 1 + visible.length + 1;
  }

  function addDataTable(ws, title, headers, rows, config = {}) {
    ws.properties.defaultRowHeight = 20;
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    ws.columns = (config.widths || headers.map(() => 16)).map((width) => ({ width }));
    ws.mergeCells(1, 1, 1, headers.length);
    setCell(ws.getCell(1, 1), {
      value: title,
      font: { bold: true, size: 16, color: { argb: theme.white } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.navy } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    ws.mergeCells(2, 1, 2, headers.length);
    setCell(ws.getCell(2, 1), {
      value: `Generado: ${generatedAt} | Rango: ${rangeLabel}`,
      font: { size: 10, color: { argb: theme.inkSoft } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.pale2 } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    headers.forEach((header, index) => {
      setCell(ws.getCell(3, index + 1), {
        value: header,
        font: { bold: true, color: { argb: theme.white }, size: 10 },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.blue } },
        alignment: { vertical: 'middle', horizontal: 'center' }
      });
    });
    rows.forEach((rowValues, rowIndex) => {
      rowValues.forEach((value, colIndex) => {
        setCell(ws.getCell(4 + rowIndex, colIndex + 1), {
          value,
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.white } },
          font: { size: 10, color: { argb: theme.navy } },
          alignment: {
            vertical: 'middle',
            horizontal: colIndex === 0 ? 'left' : 'right'
          },
          numFmt:
            typeof value === 'number'
              ? colIndex === 1 && title === 'Detalle diario'
                ? integerFormat
                : moneyFormat
              : undefined
        });
      });
    });
  }

  const topArea = [...byArea].sort((a, b) => Number(b.ventas_netas || 0) - Number(a.ventas_netas || 0))[0];
  const topService = [...byService].sort((a, b) => Number(b.ganancia || 0) - Number(a.ganancia || 0))[0];
  const topReturns = [...byService].sort((a, b) => Number(b.devoluciones || 0) - Number(a.devoluciones || 0))[0];
  const topExpiryLoss = [...byService].sort((a, b) => Number(b.mermas_vencimiento || 0) - Number(a.mermas_vencimiento || 0))[0];
  const latestDays = [...daily].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || ''))).slice(0, 10);

  const dashboard = workbook.addWorksheet('Dashboard', { views: [{ showGridLines: false }] });
  dashboard.properties.defaultRowHeight = 21;
  dashboard.columns = Array.from({ length: 24 }, (_, idx) => ({ width: idx === 0 ? 14 : 12 }));
  dashboard.mergeCells(1, 1, 2, 24);
  setCell(dashboard.getCell(1, 1), {
    value: 'REGISTROS FINANCIEROS',
    font: { bold: true, size: 24, color: { argb: theme.white } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.navy } },
    alignment: { vertical: 'middle', horizontal: 'left' }
  });
  dashboard.mergeCells(3, 1, 3, 24);
  setCell(dashboard.getCell(3, 1), {
    value: `Rango: ${rangeLabel} | Generado: ${generatedAt}`,
    font: { size: 11, color: { argb: theme.inkSoft } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.pale2 } },
    alignment: { vertical: 'middle', horizontal: 'left' }
  });

  addKpiCard(
    dashboard,
    5,
    1,
    'Ventas netas',
    Number(totals.ventas_netas || 0),
    `${Number(totals.tickets || 0)} ticket(s) procesado(s)`,
    theme.blue
  );
  dashboard.getCell(6, 1).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    5,
    6,
    'Costo de ventas',
    Number(totals.costo_ventas || 0),
    'Costo total del periodo',
    theme.amber
  );
  dashboard.getCell(6, 6).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    5,
    11,
    'Ganancia',
    Number(totals.ganancia || 0),
    'Resultado positivo del periodo',
    theme.green
  );
  dashboard.getCell(6, 11).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    5,
    16,
    'Devoluciones',
    Number(totals.devoluciones || 0),
    `Manual: Q${Number(totals.devoluciones_manuales || 0).toFixed(2)}`,
    theme.red
  );
  dashboard.getCell(6, 16).numFmt = moneyFormat;

  addKpiCard(
    dashboard,
    10,
    1,
    'Compras confirmadas',
    Number(totals.compras_confirmadas || 0),
    'Compras aplicadas al rango',
    theme.teal
  );
  dashboard.getCell(11, 1).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    10,
    6,
    'Pérdida',
    Number(totals.perdida || 0),
    'Se refleja sólo si el periodo cae en negativo',
    theme.red
  );
  dashboard.getCell(11, 6).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    10,
    11,
    'Ticket promedio',
    Number(totals.ticket_promedio || 0),
    'Promedio por venta neta',
    theme.blue
  );
  dashboard.getCell(11, 11).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    10,
    16,
    'Ventas brutas',
    Number(totals.ventas_brutas || 0),
    'Antes de devoluciones',
    theme.navy
  );
  dashboard.getCell(11, 16).numFmt = moneyFormat;

  addKpiCard(
    dashboard,
    15,
    1,
    'Merma vencimiento',
    Number(totals.mermas_vencimiento || 0),
    'Castigos de inventario por lotes vencidos',
    theme.red
  );
  dashboard.getCell(16, 1).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    15,
    6,
    'Tickets',
    Number(totals.tickets || 0),
    'Ventas registradas en el rango',
    theme.blue
  );
  dashboard.getCell(16, 6).numFmt = integerFormat;
  addKpiCard(
    dashboard,
    15,
    11,
    'Devoluciones manuales',
    Number(totals.devoluciones_manuales || 0),
    'Ajustes manuales incluidos en devoluciones',
    theme.amber
  );
  dashboard.getCell(16, 11).numFmt = moneyFormat;
  addKpiCard(
    dashboard,
    15,
    16,
    'Resultado neto',
    Number((totals.ganancia || 0) - (totals.perdida || 0)),
    'Ganancia o pérdida final del periodo',
    Number(totals.perdida || 0) > 0 ? theme.red : theme.green
  );
  dashboard.getCell(16, 16).numFmt = moneyFormat;

  const narrativeLines = [
    `Resultado neto del periodo: Q${Number(totals.ventas_netas || 0).toFixed(2)} en ventas netas frente a Q${Number(
      totals.costo_ventas || 0
    ).toFixed(2)} de costo de ventas y Q${Number(totals.mermas_vencimiento || 0).toFixed(2)} de merma por vencimiento.`,
    `Área con mayor venta neta: ${topArea ? topArea.label : 'Sin datos'}${topArea ? ` (Q${Number(topArea.ventas_netas || 0).toFixed(2)})` : ''}.`,
    `Rubro con mayor ganancia: ${topService ? topService.label : 'Sin datos'}${topService ? ` (Q${Number(topService.ganancia || 0).toFixed(2)})` : ''}.`,
    `Mayor presión por devoluciones: ${topReturns ? topReturns.label : 'Sin datos'}${topReturns ? ` (Q${Number(topReturns.devoluciones || 0).toFixed(2)})` : ''}.`,
    `Mayor merma por vencimiento: ${topExpiryLoss ? topExpiryLoss.label : 'Sin datos'}${topExpiryLoss ? ` (Q${Number(topExpiryLoss.mermas_vencimiento || 0).toFixed(2)})` : ''}.`,
    'Las tablas completas y el detalle diario quedaron exportados en hojas separadas para revisión y auditoría.'
  ];
  addNarrativeBlock(dashboard, 20, 1, 24, 'Mayor movimiento', narrativeLines);

  let nextRow = 27;
  nextRow = addBarSection(
    dashboard,
    nextRow,
    1,
    'Gráfica: ventas netas por área',
    'Comparativo principal de la dashboard por módulo.',
    byArea,
    'ventas_netas',
    theme.blue,
    { limit: 6, chartWidth: 14 }
  );
  nextRow = addBarSection(
    dashboard,
    nextRow,
    1,
    'Gráfica: ganancia por rubro',
    'Rubro con mejor resultado económico dentro del periodo.',
    byService,
    'ganancia',
    theme.green,
    { limit: 8, chartWidth: 14 }
  );
  nextRow = addBarSection(
    dashboard,
    nextRow,
    1,
    'Gráfica: devoluciones por rubro',
    'Ayuda a identificar fricción operativa o ajustes recurrentes.',
    byService,
    'devoluciones',
    theme.red,
    { limit: 8, chartWidth: 14 }
  );
  nextRow = addBarSection(
    dashboard,
    nextRow,
    1,
    'Gráfica: merma por vencimiento por rubro',
    'Productos castigados por lote vencido dentro del periodo.',
    byService,
    'mermas_vencimiento',
    theme.amber,
    { limit: 8, chartWidth: 14 }
  );
  addBarSection(
    dashboard,
    nextRow,
    1,
    'Gráfica: tendencia diaria de ventas netas',
    'Últimos días con movimiento del rango exportado.',
    latestDays.map((row) => ({ label: row.fecha || '', ventas_netas: row.ventas_netas || 0 })),
    'ventas_netas',
    theme.teal,
    { limit: 10, chartWidth: 14 }
  );

  const areaSheet = workbook.addWorksheet('Por area');
  addDataTable(
    areaSheet,
    'Por área',
    ['Categoría', 'Ventas brutas', 'Devoluciones', 'Ventas netas', 'Costo de ventas', 'Merma vencimiento', 'Ganancia', 'Pérdida'],
    byArea.map((row) => [
      row.label || row.id || '',
      Number(row.ventas_brutas || 0),
      Number(row.devoluciones || 0),
      Number(row.ventas_netas || 0),
      Number(row.costo_ventas || 0),
      Number(row.mermas_vencimiento || 0),
      Number(row.ganancia || 0),
      Number(row.perdida || 0)
    ]),
    { widths: [24, 16, 16, 16, 16, 18, 16, 16] }
  );

  const serviceSheet = workbook.addWorksheet('Por rubro');
  addDataTable(
    serviceSheet,
    'Por rubro',
    ['Categoría', 'Ventas brutas', 'Devoluciones', 'Ventas netas', 'Costo de ventas', 'Merma vencimiento', 'Ganancia', 'Pérdida'],
    byService.map((row) => [
      row.label || row.id || '',
      Number(row.ventas_brutas || 0),
      Number(row.devoluciones || 0),
      Number(row.ventas_netas || 0),
      Number(row.costo_ventas || 0),
      Number(row.mermas_vencimiento || 0),
      Number(row.ganancia || 0),
      Number(row.perdida || 0)
    ]),
    { widths: [24, 16, 16, 16, 16, 18, 16, 16] }
  );

  const dailySheet = workbook.addWorksheet('Detalle diario');
  addDataTable(
    dailySheet,
    'Detalle diario',
    [
      'Fecha',
      'Tickets',
      'Ventas brutas',
      'Devoluciones',
      'Devoluciones manuales',
      'Ventas netas',
      'Compras confirmadas',
      'Costo de ventas',
      'Merma vencimiento',
      'Ganancia',
      'Pérdida'
    ],
    daily.map((row) => [
      row.fecha || '',
      Number(row.tickets || 0),
      Number(row.ventas_brutas || 0),
      Number(row.devoluciones || 0),
      Number(row.devoluciones_manuales || 0),
      Number(row.ventas_netas || 0),
      Number(row.compras_confirmadas || 0),
      Number(row.costo_ventas || 0),
      Number(row.mermas_vencimiento || 0),
      Number(row.ganancia || 0),
      Number(row.perdida || 0)
    ]),
    { widths: [14, 10, 16, 16, 20, 16, 20, 16, 18, 16, 16] }
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

router.all(
  '/accounts',
  asyncHandler(async (req, res) => {
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const q = req.query.q ? String(req.query.q).trim() : '';
      const id = req.query.id ? Number(req.query.id) : 0;
      if (id) {
        const st = await query('SELECT * FROM accounts WHERE id = $1', [id]);
        if (!st.rows[0]) return safeJson(res, { ok: false, error: 'No encontrado' }, 404);
        return safeJson(res, st.rows[0]);
      }
      if (q) {
        const like = `%${q}%`;
        const st = await query('SELECT * FROM accounts WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY code ASC', [
          like
        ]);
        return safeJson(res, st.rows);
      }
      const st = await query('SELECT * FROM accounts ORDER BY code ASC');
      return safeJson(res, st.rows);
    }

    if (method === 'POST') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const code = String(data.code || '').trim();
      const name = String(data.name || '').trim();
      const type = String(data.type || '').trim().toLowerCase();
      const parentId = data.parent_id != null ? Number(data.parent_id) : null;
      const level = data.level != null ? Number(data.level) : 1;
      const currency = String(data.currency || 'GTQ').trim().toUpperCase();
      if (!code || !name || !type) return safeJson(res, { ok: false, error: 'code, name y type son obligatorios' }, 400);
      const allowed = [
        'activo',
        'pasivo',
        'patrimonio',
        'ingreso',
        'gasto',
        'costo_produccion',
        'costo_ventas',
        'gastos_no_deducibles',
        'perdidas_ganancias'
      ];
      if (!allowed.includes(type)) return safeJson(res, { ok: false, error: 'type inválido' }, 400);
      const exists = await query('SELECT 1 FROM accounts WHERE code = $1', [code]);
      if (exists.rows[0]) return safeJson(res, { ok: false, error: 'Ya existe ese código de cuenta' }, 400);
      const ins = await query(
        'INSERT INTO accounts (code,name,type,level,parent_id,currency,active) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id',
        [code, name, type, level, parentId, currency]
      );
      return safeJson(res, { ok: true, id: Number(ins.rows[0].id) });
    }

    if (method === 'PUT') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const fields = [];
      const params = [];
      for (const f of ['code', 'name', 'type', 'currency']) {
        if (data[f] != null) {
          fields.push(`${f} = $${params.length + 1}`);
          params.push(String(data[f]).trim());
        }
      }
      if (data.level != null) {
        fields.push(`level = $${params.length + 1}`);
        params.push(Number(data.level));
      }
      if (Object.prototype.hasOwnProperty.call(data, 'parent_id')) {
        fields.push(`parent_id = $${params.length + 1}`);
        params.push(data.parent_id != null ? Number(data.parent_id) : null);
      }
      if (data.active != null) {
        fields.push(`active = $${params.length + 1}`);
        params.push(
          data.active === true ||
            data.active === '1' ||
            data.active === 1 ||
            data.active === 'true' ||
            Number(data.active) === 1
        );
      }
      if (!fields.length) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      params.push(id);
      await query(`UPDATE accounts SET ${fields.join(',')} WHERE id = $${params.length}`, params);
      return safeJson(res, { ok: true });
    }

    if (method === 'DELETE') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM accounts WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.all(
  '/journal_entries',
  asyncHandler(async (req, res) => {
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const params = [];
      const where = [];
      if (req.query.id) {
        where.push(`je.id = $${params.length + 1}`);
        params.push(Number(req.query.id));
      }
      if (req.query.from) {
        where.push(`fecha >= $${params.length + 1}`);
        params.push(req.query.from);
      }
      if (req.query.to) {
        where.push(`fecha <= $${params.length + 1}`);
        params.push(req.query.to);
      }
      if (req.query.origen) {
        where.push(`origen = $${params.length + 1}`);
        params.push(req.query.origen);
      }
      if (req.query.origen_id) {
        where.push(`origen_id = $${params.length + 1}`);
        params.push(Number(req.query.origen_id));
      }
      let sql =
        'SELECT je.*, u.username AS usuario FROM journal_entries je LEFT JOIN users u ON u.id = je.usuario_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY je.fecha DESC, je.id DESC LIMIT 500';
      const entries = await query(sql, params);
      for (const row of entries.rows) {
        const lines = await query(
          'SELECT jl.*, a.code, a.name, a.type FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = $1',
          [row.id]
        );
        row.lines = lines.rows;
      }
      return safeJson(res, entries.rows);
    }

    if (method === 'POST') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const fecha = data.fecha || null;
      const descripcion = String(data.descripcion || '').trim();
      const origen = String(data.origen || '').trim();
      const origenId = data.origen_id != null ? Number(data.origen_id) : null;
      const lines = Array.isArray(data.lines) ? data.lines : [];
      if (!fecha || !lines.length) return safeJson(res, { ok: false, error: 'fecha y lines son obligatorios' }, 400);
      let totalDebe = 0;
      let totalHaber = 0;
      for (const ln of lines) {
        totalDebe += Number(ln.debe || 0);
        totalHaber += Number(ln.haber || 0);
      }
      if (Number(totalDebe.toFixed(2)) !== Number(totalHaber.toFixed(2))) {
        return safeJson(res, { ok: false, error: 'La partida no cuadra (debe y haber difieren)' }, 400);
      }
      const entryId = await withTransaction(async (db) => {
        const uid = req.session?.user?.id || null;
        const ins = await query(
          'INSERT INTO journal_entries (fecha, descripcion, usuario_id, origen, origen_id, total_debe, total_haber) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [fecha, descripcion, uid, origen, origenId, totalDebe, totalHaber],
          db
        );
        const entryId = Number(ins.rows[0].id);
        for (const ln of lines) {
          const accId = Number(ln.account_id || 0);
          if (!accId) throw new Error('account_id inválido');
          await query(
            'INSERT INTO journal_lines (entry_id, account_id, descripcion, debe, haber, branch_id, producto_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              entryId,
              accId,
              ln.descripcion || null,
              Number(ln.debe || 0),
              Number(ln.haber || 0),
              ln.branch_id != null ? Number(ln.branch_id) : null,
              ln.producto_id != null ? Number(ln.producto_id) : null
            ],
            db
          );
        }
        return entryId;
      });
      return safeJson(res, { ok: true, id: entryId });
    }

    if (method === 'PUT') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const lines = Array.isArray(data.lines) ? data.lines : null;
      const fields = [];
      const params = [];
      if (data.descripcion != null) {
        fields.push(`descripcion = $${params.length + 1}`);
        params.push(String(data.descripcion).trim());
      }
      if (data.estado != null) {
        fields.push(`estado = $${params.length + 1}`);
        params.push(String(data.estado).trim());
      }
      if (data.fecha != null) {
        fields.push(`fecha = $${params.length + 1}`);
        params.push(data.fecha);
      }
      if (lines) {
        let totalDebe = 0;
        let totalHaber = 0;
        for (const ln of lines) {
          totalDebe += Number(ln.debe || 0);
          totalHaber += Number(ln.haber || 0);
        }
        if (Number(totalDebe.toFixed(2)) !== Number(totalHaber.toFixed(2))) {
          return safeJson(res, { ok: false, error: 'La partida no cuadra (debe y haber difieren)' }, 400);
        }
        fields.push(`total_debe = $${params.length + 1}`);
        params.push(totalDebe);
        fields.push(`total_haber = $${params.length + 1}`);
        params.push(totalHaber);
      }
      if (!fields.length && !lines) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      await withTransaction(async (db) => {
        if (fields.length) {
          params.push(id);
          await query(`UPDATE journal_entries SET ${fields.join(',')} WHERE id = $${params.length}`, params, db);
        }
        if (lines) {
          await query('DELETE FROM journal_lines WHERE entry_id = $1', [id], db);
          for (const ln of lines) {
            const accId = Number(ln.account_id || 0);
            if (!accId) throw new Error('account_id inválido');
            await query(
              'INSERT INTO journal_lines (entry_id, account_id, descripcion, debe, haber, branch_id, producto_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [
                id,
                accId,
                ln.descripcion || null,
                Number(ln.debe || 0),
                Number(ln.haber || 0),
                ln.branch_id != null ? Number(ln.branch_id) : null,
                ln.producto_id != null ? Number(ln.producto_id) : null
              ],
              db
            );
          }
        }
      });
      return safeJson(res, { ok: true, id });
    }

    if (method === 'DELETE') {
      await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
      if (res.headersSent) return;
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM journal_entries WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.all(
  '/financial_reports',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const type = req.query.type || req.body?.type || 'trial_balance';
    const from = req.query.from || req.body?.from || null;
    const to = req.query.to || req.body?.to || null;

    const loadLines = async () => {
      const params = [];
      const where = [];
      if (from) {
        where.push(`je.fecha >= $${params.length + 1}`);
        params.push(from);
      }
      if (to) {
        where.push(`je.fecha <= $${params.length + 1}`);
        params.push(to);
      }
      const sql = `SELECT a.id, a.code, a.name, a.type, jl.debe, jl.haber
                   FROM journal_lines jl
                   JOIN journal_entries je ON je.id = jl.entry_id
                   JOIN accounts a ON a.id = jl.account_id
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
      const st = await query(sql, params);
      return st.rows;
    };

    const accountNet = (ln) => {
      const t = String(ln.type || '').toLowerCase();
      const debe = Number(ln.debe || 0);
      const haber = Number(ln.haber || 0);
      if (['activo', 'gasto', 'costo_produccion', 'costo_ventas', 'gastos_no_deducibles', 'perdidas_ganancias'].includes(t)) {
        return debe - haber;
      }
      return haber - debe;
    };

    const aggregate = (lines) => {
      const agg = new Map();
      for (const ln of lines) {
        const id = ln.id;
        if (!agg.has(id)) {
          agg.set(id, {
            account_id: id,
            code: ln.code,
            name: ln.name,
            type: ln.type,
            debe: 0,
            haber: 0,
            neto: 0
          });
        }
        const row = agg.get(id);
        row.debe += Number(ln.debe || 0);
        row.haber += Number(ln.haber || 0);
      }
      for (const row of agg.values()) {
        row.neto = accountNet(row);
      }
      return Array.from(agg.values());
    };

    try {
      const lines = await loadLines();
      const agg = aggregate(lines);

      if (type === 'trial_balance') {
        return safeJson(res, agg);
      }
      if (type === 'balance_general') {
        const assets = [];
        const liabilities = [];
        const equity = [];
        for (const row of agg) {
          const t = String(row.type || '').toLowerCase();
          const net = Number(row.neto || 0);
          if (Math.abs(net) < 0.0001) continue;
          if (t === 'activo') assets.push(row);
          else if (t === 'pasivo') liabilities.push(row);
          else if (t === 'patrimonio') equity.push(row);
        }
        const totAct = assets.reduce((s, r) => s + Number(r.neto || 0), 0);
        const totPas = liabilities.reduce((s, r) => s + Number(r.neto || 0), 0);
        const totPat = equity.reduce((s, r) => s + Number(r.neto || 0), 0);
        return safeJson(res, {
          assets: { total: totAct, lines: assets },
          liabilities: { total: totPas, lines: liabilities },
          equity: { total: totPat, lines: equity },
          diferencia: totAct - (totPas + totPat)
        });
      }
      if (type === 'estado_resultados') {
        const incomes = [];
        const expenses = [];
        for (const row of agg) {
          const t = String(row.type || '').toLowerCase();
          const net = Number(row.neto || 0);
          if (Math.abs(net) < 0.0001) continue;
          if (t === 'ingreso') incomes.push(row);
          else if (
            ['gasto', 'costo_ventas', 'costo_produccion', 'gastos_no_deducibles', 'perdidas_ganancias'].includes(t)
          )
            expenses.push(row);
        }
        const totIng = incomes.reduce((s, r) => s + Number(r.neto || 0), 0);
        const totGto = expenses.reduce((s, r) => s + Number(r.neto || 0), 0);
        return safeJson(res, {
          ingresos: { total: totIng, lines: incomes },
          gastos: { total: totGto, lines: expenses },
          utilidad: totIng - totGto
        });
      }
      if (type === 'flujo_efectivo') {
        const params = [];
        const where = [];
        if (from) {
          where.push(`je.fecha >= $${params.length + 1}`);
          params.push(from);
        }
        if (to) {
          where.push(`je.fecha <= $${params.length + 1}`);
          params.push(to);
        }
        const sql = `SELECT tipo, SUM(monto) AS total FROM cash_movements cm
                     LEFT JOIN journal_entries je ON je.id = cm.journal_entry_id
                     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     GROUP BY tipo`;
        const rows = await query(sql, params);
        return safeJson(res, { movimientos: rows.rows });
      }
      return safeJson(res, { ok: false, error: 'type inválido' }, 400);
    } catch (e) {
      return safeJson(res, { ok: false, error: e.message }, 500);
    }
  })
);

router.get(
  '/records_summary',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'administrador', 'contabilidad', 'superadmin'])(req, res, async () => {});
    if (res.headersSent) return;

    try {
      const from = req.query.from ? String(req.query.from).slice(0, 10) : null;
      const to = req.query.to ? String(req.query.to).slice(0, 10) : null;
      const format = String(req.query.format || '').trim().toLowerCase();
      const summary = await buildRecordsSummary(null, { from, to });

      if (format === 'xlsx') {
        const buffer = await buildRecordsWorkbook(summary);
        const stampParts = [];
        if (from) stampParts.push(from);
        if (to) stampParts.push(to);
        const stamp = stampParts.length ? stampParts.join('_') : new Date().toISOString().slice(0, 10);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="registros_${stamp.replace(/[^0-9_-]/g, '')}.xlsx"`
        );
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        return res.send(buffer);
      }

      return safeJson(res, summary);
    } catch (err) {
      return safeJson(res, { ok: false, error: err.message || 'Error generando registros' }, 500);
    }
  })
);

router.get(
  '/banks',
  asyncHandler(async (req, res) => {
    try {
      const st = await query(
        "SELECT DISTINCT LOWER(payment_type) AS payment_type FROM payments WHERE payment_type IS NOT NULL AND payment_type <> '' LIMIT 100"
      );
      const rows = st.rows || [];
      if (!rows.length) {
        return safeJson(res, [
          { payment_type: 'efectivo' },
          { payment_type: 'tarjeta' },
          { payment_type: 'transferencia' }
        ]);
      }
      return safeJson(res, rows);
    } catch (_) {
      return safeJson(res, [
        { payment_type: 'efectivo' },
        { payment_type: 'tarjeta' },
        { payment_type: 'transferencia' }
      ]);
    }
  })
);

router.all(
  '/bank_accounts',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      const st = await query('SELECT * FROM bank_accounts ORDER BY name ASC');
      return safeJson(res, st.rows);
    }
    if (method === 'POST') {
      const name = String(data.name || '').trim();
      if (!name) return safeJson(res, { ok: false, error: 'name requerido' }, 400);
      const bank = String(data.bank || '').trim();
      const number = String(data.number || '').trim();
      const currency = String(data.currency || 'GTQ').trim().toUpperCase();
      const saldo = data.saldo_inicial != null ? Number(data.saldo_inicial) : 0;
      const branch = data.branch_id != null ? Number(data.branch_id) : null;
      const accountId = data.account_id != null ? Number(data.account_id) : null;
      const count = await query('SELECT COUNT(*) AS c FROM bank_accounts');
      if (Number(count.rows[0]?.c || 0) >= 3) {
        return safeJson(res, { ok: false, error: 'Límite de 3 cuentas bancarias alcanzado' }, 400);
      }
      const ins = await query(
        'INSERT INTO bank_accounts (name, bank, number, currency, saldo_inicial, branch_id, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [name, bank, number, currency, saldo, branch, accountId]
      );
      return safeJson(res, { ok: true, id: Number(ins.rows[0].id) });
    }
    if (method === 'PUT') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const fields = [];
      const params = [];
      for (const f of ['name', 'bank', 'number', 'currency']) {
        if (data[f] != null) {
          fields.push(`${f} = $${params.length + 1}`);
          params.push(data[f]);
        }
      }
      if (data.saldo_inicial != null) {
        fields.push(`saldo_inicial = $${params.length + 1}`);
        params.push(Number(data.saldo_inicial));
      }
      if (Object.prototype.hasOwnProperty.call(data, 'branch_id')) {
        fields.push(`branch_id = $${params.length + 1}`);
        params.push(data.branch_id != null ? Number(data.branch_id) : null);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'account_id')) {
        fields.push(`account_id = $${params.length + 1}`);
        params.push(data.account_id != null ? Number(data.account_id) : null);
      }
      if (!fields.length) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      params.push(id);
      await query(`UPDATE bank_accounts SET ${fields.join(',')} WHERE id = $${params.length}`, params);
      return safeJson(res, { ok: true });
    }
    if (method === 'DELETE') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM bank_accounts WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }
    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.all(
  '/bank_movements',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      const params = [];
      const where = [];
      if (req.query.bank_account_id) {
        where.push(`bm.bank_account_id = $${params.length + 1}`);
        params.push(Number(req.query.bank_account_id));
      }
      if (req.query.from) {
        where.push(`bm.fecha >= $${params.length + 1}`);
        params.push(req.query.from);
      }
      if (req.query.to) {
        where.push(`bm.fecha <= $${params.length + 1}`);
        params.push(req.query.to);
      }
      let sql =
        'SELECT bm.*, ba.name AS cuenta, a.code AS contracuenta_code FROM bank_movements bm JOIN bank_accounts ba ON ba.id = bm.bank_account_id LEFT JOIN accounts a ON a.id = bm.contracuenta_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY bm.fecha DESC, bm.id DESC LIMIT 500';
      const st = await query(sql, params);
      return safeJson(res, st.rows);
    }
    if (method === 'POST') {
      const acc = Number(data.bank_account_id || 0);
      const fecha = data.fecha || null;
      const tipo = String(data.tipo || '').trim();
      const monto = Number(data.monto || 0);
      if (!acc || !fecha || !tipo || !monto) {
        return safeJson(res, { ok: false, error: 'bank_account_id, fecha, tipo y monto requeridos' }, 400);
      }
      const ref = String(data.referencia || '').trim();
      const contra = data.contracuenta_id != null ? Number(data.contracuenta_id) : null;
      const je = data.journal_entry_id != null ? Number(data.journal_entry_id) : null;
      const conc =
        data.conciliado != null
          ? data.conciliado === true ||
            data.conciliado === '1' ||
            data.conciliado === 1 ||
            data.conciliado === 'true' ||
            Number(data.conciliado) === 1
          : false;
      const ins = await query(
        'INSERT INTO bank_movements (bank_account_id, fecha, tipo, monto, referencia, contracuenta_id, journal_entry_id, conciliado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [acc, fecha, tipo, monto, ref, contra, je, conc]
      );
      return safeJson(res, { ok: true, id: Number(ins.rows[0].id) });
    }
    if (method === 'PUT') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const fields = [];
      const params = [];
      for (const f of ['fecha', 'tipo', 'referencia']) {
        if (data[f] != null) {
          fields.push(`${f} = $${params.length + 1}`);
          params.push(data[f]);
        }
      }
      if (data.monto != null) {
        fields.push(`monto = $${params.length + 1}`);
        params.push(Number(data.monto));
      }
      if (Object.prototype.hasOwnProperty.call(data, 'contracuenta_id')) {
        fields.push(`contracuenta_id = $${params.length + 1}`);
        params.push(data.contracuenta_id != null ? Number(data.contracuenta_id) : null);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'conciliado')) {
        fields.push(`conciliado = $${params.length + 1}`);
        params.push(
          data.conciliado === true ||
            data.conciliado === '1' ||
            data.conciliado === 1 ||
            data.conciliado === 'true' ||
            Number(data.conciliado) === 1
        );
      }
      if (!fields.length) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      params.push(id);
      await query(`UPDATE bank_movements SET ${fields.join(',')} WHERE id = $${params.length}`, params);
      return safeJson(res, { ok: true });
    }
    if (method === 'DELETE') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM bank_movements WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }
    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.all(
  '/bank_reconciliation',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      const params = [];
      const where = [];
      if (req.query.bank_account_id) {
        where.push(`br.bank_account_id = $${params.length + 1}`);
        params.push(Number(req.query.bank_account_id));
      }
      let sql =
        'SELECT br.*, ba.name AS cuenta FROM bank_reconciliations br JOIN bank_accounts ba ON ba.id = br.bank_account_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY br.periodo_fin DESC LIMIT 200';
      const rows = await query(sql, params);
      for (const r of rows.rows) {
        const items = await query(
          'SELECT bri.*, bm.tipo, bm.monto, bm.fecha FROM bank_reconciliation_items bri JOIN bank_movements bm ON bm.id = bri.bank_movement_id WHERE bri.reconciliation_id = $1',
          [r.id]
        );
        r.items = items.rows;
      }
      return safeJson(res, rows.rows);
    }

    if (method === 'POST') {
      const acc = Number(data.bank_account_id || 0);
      const ini = data.periodo_inicio || null;
      const fin = data.periodo_fin || null;
      if (!acc || !ini || !fin) {
        return safeJson(res, { ok: false, error: 'bank_account_id, periodo_inicio y periodo_fin requeridos' }, 400);
      }
      const saldoExt = data.saldo_extracto != null ? Number(data.saldo_extracto) : 0;
      const saldoLib = data.saldo_libros != null ? Number(data.saldo_libros) : 0;
      const dif = saldoLib - saldoExt;
      const ins = await query(
        'INSERT INTO bank_reconciliations (bank_account_id, periodo_inicio, periodo_fin, saldo_extracto, saldo_libros, diferencia) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [acc, ini, fin, saldoExt, saldoLib, dif]
      );
      const id = Number(ins.rows[0].id);
      if (Array.isArray(data.items)) {
        for (const it of data.items) {
          const mid = Number(it.bank_movement_id || 0);
          if (!mid) continue;
          await query(
            'INSERT INTO bank_reconciliation_items (reconciliation_id, bank_movement_id, estado, nota) VALUES ($1,$2,$3,$4)',
            [id, mid, it.estado || 'conciliado', it.nota || null]
          );
          if (it.marcar_conciliado) {
            await query('UPDATE bank_movements SET conciliado = TRUE WHERE id = $1', [mid]);
          }
        }
      }
      return safeJson(res, { ok: true, id, diferencia: dif });
    }

    if (method === 'PUT') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      if (Array.isArray(data.items)) {
        await query('DELETE FROM bank_reconciliation_items WHERE reconciliation_id = $1', [id]);
        for (const it of data.items) {
          const mid = Number(it.bank_movement_id || 0);
          if (!mid) continue;
          await query(
            'INSERT INTO bank_reconciliation_items (reconciliation_id, bank_movement_id, estado, nota) VALUES ($1,$2,$3,$4)',
            [id, mid, it.estado || 'conciliado', it.nota || null]
          );
          if (it.marcar_conciliado) {
            await query('UPDATE bank_movements SET conciliado = TRUE WHERE id = $1', [mid]);
          }
        }
      }
      if (data.saldo_extracto != null || data.saldo_libros != null) {
        const fields = [];
        const params = [];
        if (data.saldo_extracto != null) {
          fields.push(`saldo_extracto = $${params.length + 1}`);
          params.push(Number(data.saldo_extracto));
        }
        if (data.saldo_libros != null) {
          fields.push(`saldo_libros = $${params.length + 1}`);
          params.push(Number(data.saldo_libros));
        }
        if (fields.length) {
          params.push(id);
          await query(`UPDATE bank_reconciliations SET ${fields.join(',')} WHERE id = $${params.length}`, params);
        }
      }
      return safeJson(res, { ok: true });
    }

    if (method === 'DELETE') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      await query('DELETE FROM bank_reconciliation_items WHERE reconciliation_id = $1', [id]);
      await query('DELETE FROM bank_reconciliations WHERE id = $1', [id]);
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.all(
  '/checks',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const method = req.method;
    const data = readJson(req);

    if (method === 'GET') {
      const params = [];
      const where = [];
      if (req.query.journal_entry_id) {
        where.push(`c.journal_entry_id = $${params.length + 1}`);
        params.push(Number(req.query.journal_entry_id));
      }
      if (req.query.status) {
        where.push(`c.status = $${params.length + 1}`);
        params.push(String(req.query.status));
      }
      let sql =
        'SELECT c.*, ba.name AS bank_name, ba.number AS bank_number, a.code AS account_code, a.name AS account_name FROM checks c LEFT JOIN bank_accounts ba ON ba.id = c.bank_account_id LEFT JOIN accounts a ON a.id = c.account_id';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY c.issue_date DESC, c.id DESC LIMIT 500';
      const st = await query(sql, params);
      return safeJson(res, st.rows);
    }

    if (method === 'POST') {
      const entryId = Number(data.journal_entry_id || 0);
      const bankAccountId = Number(data.bank_account_id || 0);
      const accountId = Number(data.account_id || 0);
      let amount = data.amount != null ? Number(data.amount) : 0;
      const issueDate = data.issue_date ? String(data.issue_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
      let payTo = String(data.pay_to || '').trim();
      const note = String(data.note || '').trim();
      const userId = req.session?.user?.id || null;

      if (!entryId || !bankAccountId || !accountId) {
        return safeJson(res, { ok: false, error: 'journal_entry_id, bank_account_id y account_id son obligatorios' }, 400);
      }

      const entryRes = await query('SELECT id, fecha, descripcion, total_debe, total_haber FROM journal_entries WHERE id = $1', [
        entryId
      ]);
      const entry = entryRes.rows[0];
      if (!entry) return safeJson(res, { ok: false, error: 'Partida no encontrada' }, 404);
      if (amount <= 0) amount = Number(entry.total_debe || entry.total_haber || 0);
      if (amount <= 0) return safeJson(res, { ok: false, error: 'El monto del cheque debe ser mayor a 0' }, 400);

      const bankRes = await query('SELECT * FROM bank_accounts WHERE id = $1', [bankAccountId]);
      if (!bankRes.rows[0]) return safeJson(res, { ok: false, error: 'Cuenta bancaria no existe' }, 404);
      if (!payTo) payTo = entry.descripcion ? String(entry.descripcion) : `Partida #${entryId}`;

      const checkId = await withTransaction(async (db) => {
        const numRes = await query('SELECT COALESCE(MAX(check_number),0) + 1 AS n FROM checks WHERE bank_account_id = $1', [
          bankAccountId
        ], db);
        let checkNumber = Number(numRes.rows[0]?.n || 1);
        if (checkNumber <= 0) checkNumber = 1;
        const ins = await query(
          "INSERT INTO checks (purchase_id, bank_account_id, account_id, branch_id, amount, issue_date, check_number, pay_to, note, status, created_by, journal_entry_id) VALUES (NULL,$1,$2,NULL,$3,$4,$5,$6,$7,'emitido',$8,$9) RETURNING id",
          [bankAccountId, accountId, amount, entry.fecha || issueDate, checkNumber, payTo, note, userId, entryId],
          db
        );
        return Number(ins.rows[0].id);
      });
      return safeJson(res, { ok: true, id: checkId, journal_entry_id: entryId });
    }

    if (method === 'PUT') {
      const id = req.query.id ? Number(req.query.id) : Number(data.id || 0);
      if (!id) return safeJson(res, { ok: false, error: 'id requerido' }, 400);
      const fields = [];
      const params = [];
      if (data.status != null) {
        fields.push(`status = $${params.length + 1}`);
        params.push(String(data.status).trim());
      }
      if (data.note != null) {
        fields.push(`note = $${params.length + 1}`);
        params.push(String(data.note).trim());
      }
      if (data.issue_date != null) {
        fields.push(`issue_date = $${params.length + 1}`);
        params.push(String(data.issue_date).slice(0, 10));
      }
      if (!fields.length) return safeJson(res, { ok: false, error: 'Nada que actualizar' }, 400);
      params.push(id);
      await query(`UPDATE checks SET ${fields.join(',')} WHERE id = $${params.length}`, params);
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { ok: false, error: 'Método no permitido' }, 405);
  })
);

router.get(
  '/check_pdf',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const id = req.query.id ? Number(req.query.id) : 0;
    if (!id) return res.type('text/plain').send('ID requerido');
    const st = await query(
      `SELECT c.*, p.total AS purchase_total, p.branch_id, ba.name AS bank_name, ba.number AS bank_number, a.code AS account_code, a.name AS account_name
       FROM checks c
       LEFT JOIN purchases p ON p.id = c.purchase_id
       LEFT JOIN bank_accounts ba ON ba.id = c.bank_account_id
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.id = $1`,
      [id]
    );
    const check = st.rows[0];
    if (!check) return res.type('text/plain').send('Cheque no encontrado');

    res.setHeader('Content-Type', 'application/pdf');
    const doc = new PDFDocument({ size: [396, 612], margin: 40 });
    doc.pipe(res);
    doc.fontSize(14).text('Cheque', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Banco: ${check.bank_name || ''}`);
    doc.text(`Cuenta: ${check.bank_number || ''}`);
    doc.text(`Fecha: ${check.issue_date || ''}`);
    doc.text(`A nombre de: ${check.pay_to || ''}`);
    doc.text(`Monto: Q${Number(check.amount || 0).toFixed(2)}`);
    doc.text(`Nota: ${check.note || ''}`);
    doc.end();
  })
);

router.get(
  '/journal_pdf',
  asyncHandler(async (req, res) => {
    await requireRole(['admin', 'contabilidad'])(req, res, async () => {});
    if (res.headersSent) return;
    const id = req.query.id ? Number(req.query.id) : 0;
    if (!id) return res.type('text/plain').send('ID requerido');
    const entryRes = await query(
      'SELECT je.*, u.username AS usuario FROM journal_entries je LEFT JOIN users u ON u.id = je.usuario_id WHERE je.id = $1',
      [id]
    );
    const entry = entryRes.rows[0];
    if (!entry) return res.type('text/plain').send('Partida no encontrada');
    const linesRes = await query(
      'SELECT jl.*, a.code, a.name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = $1 ORDER BY a.code ASC, jl.id ASC',
      [id]
    );
    const lines = linesRes.rows || [];

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Libro Diario - Partida ${entry.id}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#000}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #000;padding:6px}
th{background:#f2f2f2}
.num{text-align:right}
</style></head>
<body>
<h2 style="text-align:center">LIBRO DIARIO</h2>
<p>Partida No. ${entry.id} - ${entry.fecha || ''}</p>
<p>${entry.descripcion || ''}</p>
<table>
<thead><tr><th>Codigo</th><th>Cuenta</th><th class="num">Debe</th><th class="num">Haber</th></tr></thead>
<tbody>
${lines
  .map(
    (ln) =>
      `<tr><td>${ln.code || ''}</td><td>${ln.name || ''}${
        ln.descripcion ? `<br><small>${ln.descripcion}</small>` : ''
      }</td><td class="num">${Number(ln.debe || 0).toFixed(2)}</td><td class="num">${Number(
        ln.haber || 0
      ).toFixed(2)}</td></tr>`
  )
  .join('')}
</tbody>
</table>
<p>Generado por: ${entry.usuario || 'Sistema'} • Fecha: ${new Date().toLocaleString()}</p>
</body></html>`;
    res.type('text/html').send(html);
  })
);

router.get(
  '/bancos_report',
  asyncHandler(async (req, res) => {
    await requireRole('admin')(req, res, async () => {});
    if (res.headersSent) return;
    const inicio = req.query.inicio || null;
    const fin = req.query.fin || null;
    const conds = [];
    const params = [];
    if (inicio) {
      conds.push(`DATE(v.fecha) >= $${params.length + 1}`);
      params.push(inicio);
    }
    if (fin) {
      conds.push(`DATE(v.fecha) <= $${params.length + 1}`);
      params.push(fin);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const sql = `
      SELECT
        DATE(v.fecha) AS fecha,
        SUM(COALESCE(p.amount, 0)) AS total_ventas,
        SUM(CASE WHEN LOWER(p.payment_type) LIKE '%efectivo%' THEN p.amount ELSE 0 END) AS efectivo,
        SUM(CASE WHEN LOWER(p.payment_type) LIKE '%tarj%' THEN p.amount ELSE 0 END) AS tarjeta,
        SUM(CASE WHEN LOWER(p.payment_type) LIKE '%transfer%' THEN p.amount ELSE 0 END) AS transferencia
      FROM ventas v
      LEFT JOIN payments p ON p.sale_id = v.id
      ${where}
      GROUP BY DATE(v.fecha)
      ORDER BY DATE(v.fecha) ASC
    `;
    const st = await query(sql, params);
    return safeJson(res, st.rows);
  })
);



module.exports = router;
