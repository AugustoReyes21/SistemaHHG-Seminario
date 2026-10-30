/**
 * Centraliza el cálculo de stock/stock_total por sucursal/lotes.
 * Devuelve los valores que necesita enviar el API para ventas/inventario.
 */
function deriveStockInfo(row, options = {}) {
  const { branchId, hasLots, hasBranchStock, hasStock } = options;
  const out = {};
  const readNumber = (value) => {
    if (value == null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const stockBranch = readNumber(row.stock_branch);
  const stockTotal = readNumber(row.stock_total);
  const lotBranch = readNumber(row.lot_stock_branch);
  const lotTotal = readNumber(row.lot_stock_total);

  if (hasLots) {
    if (branchId) {
      out.stock = stockBranch != null ? stockBranch : lotBranch != null ? lotBranch : 0;
      out.stock_total = stockTotal != null ? stockTotal : lotTotal != null ? lotTotal : out.stock;
      out.branch_id = branchId;
    } else {
      const total = stockTotal != null ? stockTotal : lotTotal != null ? lotTotal : readNumber(row.stock) || 0;
      out.stock = total;
      out.stock_total = total;
    }
  } else if (hasBranchStock) {
    const branchStock = stockBranch != null ? stockBranch : 0;
    const totalStock = stockTotal != null ? stockTotal : branchStock;
    out.stock = branchStock;
    out.stock_total = totalStock;
    out.branch_id = branchId;
  } else if (hasStock) {
    const totalStock = stockTotal != null ? stockTotal : readNumber(row.stock) || 0;
    out.stock = totalStock;
    out.stock_total = totalStock;
  } else {
    const fallbackStock = readNumber(row.stock) || 0;
    out.stock = fallbackStock;
    out.stock_total = fallbackStock;
  }
  return out;
}

module.exports = {
  deriveStockInfo
};
