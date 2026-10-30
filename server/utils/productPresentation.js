function toNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toPositiveInt(value, fallback = 1) {
  const num = toNumberOrNull(value);
  if (num == null || num <= 0) return fallback;
  return Math.max(1, Math.round(num));
}

function roundMoney(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
}

function markupPrice(basePrice) {
  const base = roundMoney(basePrice);
  if (base <= 0) return 0;
  return roundMoney(Math.max(base * 1.05, base + 0.01));
}

function coalesceNumber(...values) {
  for (const value of values) {
    const num = toNumberOrNull(value);
    if (num != null) return num;
  }
  return null;
}

function normalizePresentationType(value, fallback = 'unidad') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'caja' || normalized === 'unidad') {
    return normalized;
  }
  if (normalized === 'tableta' || normalized === 'blister') {
    return 'blister';
  }
  return fallback;
}

function resolvePresentationConfig(source = {}, options = {}) {
  const unidadesPorTableta = toPositiveInt(source.unidades_por_tableta, 1);
  const tabletasPorCaja = toPositiveInt(source.tabletas_por_caja, 1);
  const precioCajaBase = coalesceNumber(options.boxPriceOverride, source.precio_caja, source.precio_publico, 0) || 0;
  const precioCaja = roundMoney(Math.max(precioCajaBase, 0));

  const baseTableta = tabletasPorCaja > 0 ? precioCaja / tabletasPorCaja : precioCaja;
  const candidateTableta = toNumberOrNull(source.precio_tableta);
  let precioTableta =
    candidateTableta != null ? roundMoney(Math.max(candidateTableta, 0)) : tabletasPorCaja > 1 ? markupPrice(baseTableta) : roundMoney(baseTableta);
  if (tabletasPorCaja > 1 && precioCaja > 0) {
    precioTableta = Math.max(precioTableta, roundMoney(baseTableta + 0.01));
  }
  precioTableta = roundMoney(precioTableta);

  const baseUnidad = unidadesPorTableta > 0 ? precioTableta / unidadesPorTableta : precioTableta;
  const candidateUnidad = toNumberOrNull(source.precio_unidad);
  let precioUnidad =
    candidateUnidad != null ? roundMoney(Math.max(candidateUnidad, 0)) : unidadesPorTableta > 1 ? markupPrice(baseUnidad) : roundMoney(baseUnidad);
  if (unidadesPorTableta > 1 && precioTableta > 0) {
    precioUnidad = Math.max(precioUnidad, roundMoney(baseUnidad + 0.01));
  }
  precioUnidad = roundMoney(precioUnidad);

  return {
    unidades_por_tableta: unidadesPorTableta,
    tabletas_por_caja: tabletasPorCaja,
    unidades_por_caja: unidadesPorTableta * tabletasPorCaja,
    precio_caja: precioCaja,
    precio_tableta: precioTableta,
    precio_unidad: precioUnidad,
    precio_publico: precioCaja
  };
}

function getPresentationFactor(source = {}, presentationType = 'unidad') {
  const config = resolvePresentationConfig(source);
  const type = normalizePresentationType(presentationType);
  if (type === 'caja') return Number(config.unidades_por_caja || 1);
  if (type === 'blister') return Number(config.unidades_por_tableta || 1);
  return 1;
}

function getPresentationPrice(source = {}, presentationType = 'unidad', options = {}) {
  const config = resolvePresentationConfig(source, options);
  const type = normalizePresentationType(presentationType);
  if (type === 'caja') return Number(config.precio_caja || 0);
  if (type === 'blister') return Number(config.precio_tableta || 0);
  return Number(config.precio_unidad || 0);
}

function getPresentationLabel(presentationType = 'unidad', quantity = null) {
  const type = normalizePresentationType(presentationType);
  const singular = type === 'caja' ? 'caja' : type === 'blister' ? 'blister' : 'unidad';
  const plural = type === 'caja' ? 'cajas' : type === 'blister' ? 'blisteres' : 'unidades';
  if (quantity == null) return singular;
  const qty = Number(quantity || 0);
  return Math.abs(qty - 1) < 0.0001 ? singular : plural;
}

module.exports = {
  roundMoney,
  toNumberOrNull,
  normalizePresentationType,
  resolvePresentationConfig,
  getPresentationFactor,
  getPresentationPrice,
  getPresentationLabel
};
