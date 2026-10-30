const { z } = require('zod');
const { safeJson } = require('../helpers');

const nullableString = z.union([z.string(), z.null()]).optional();
const nullableNumber = z.union([z.string(), z.number(), z.null()]).optional();

const comboComponentSchema = z
  .object({
    component_product_id: nullableNumber,
    product_id: nullableNumber,
    producto_id: nullableNumber,
    quantity: nullableNumber,
    cantidad: nullableNumber
  })
  .passthrough();

const productSchema = z.object({
  nombre_comercial: z.string().min(1, { message: 'Nombre comercial requerido' }),
  codigo_barra: z.string().max(100).optional(),
  tipo: z.string().optional(),
  presentacion: z.string().optional(),
  principio_activo: z.string().optional(),
  casa: z.string().optional(),
  expira: z.string().optional(),
  stock: z.string().optional(),
  precio_costo: z.string().optional(),
  precio_publico: z.string().optional(),
  unidades_por_tableta: z.string().optional(),
  tabletas_por_caja: z.string().optional(),
  precio_unidad: z.string().optional(),
  precio_tableta: z.string().optional(),
  lot_number: z.string().optional(),
  expiry_date: z.string().optional(),
  branch_id: z.union([z.string(), z.number()]).optional(),
  adjust_branch_stock: z.union([z.boolean(), z.string()]).optional(),
  combo_components: z.array(comboComponentSchema).optional()
});

const barcodeLookupSchema = z.object({
  code: z.string().min(1, { message: 'Código requerido' }),
  branch_id: z.union([z.string(), z.number()]).refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }, { message: 'Sucursal requerida' })
});

const saleItemSchema = z
  .object({
    producto_id: nullableNumber,
    product_id: nullableNumber,
    cantidad: nullableNumber,
    quantity: nullableNumber,
    precio_unit: nullableNumber,
    unit_price: nullableNumber
  })
  .passthrough();

const saleServiceSchema = z
  .object({
    monto: nullableNumber,
    descripcion: nullableString
  })
  .passthrough();

const saleCheckoutSchema = z
  .object({
    items: z.array(saleItemSchema).optional(),
    services: z.array(saleServiceSchema).optional(),
    payment_type: nullableString,
    payment_form: nullableString,
    customer_type: nullableString,
    customer_document: nullableString,
    note: nullableString,
    branch_id: nullableNumber
  })
  .passthrough();

const saleRegisterSchema = z
  .object({
    items: z.array(saleItemSchema).optional(),
    services: z.array(saleServiceSchema).optional(),
    venta_sin_producto: z.union([z.boolean(), z.string(), z.number(), z.null()]).optional(),
    cantidad_cobro: nullableNumber,
    payment_method: nullableString,
    payment_terms: nullableString,
    cliente_tipo: nullableString,
    cliente_documento: nullableString,
    note: nullableString,
    branch_id: nullableNumber,
    caja_id: nullableNumber
  })
  .passthrough();

const purchaseItemSchema = z
  .object({
    product_id: nullableNumber,
    quantity: nullableNumber,
    unit_price: nullableNumber,
    sale_price: nullableNumber,
    profit_margin: nullableNumber,
    lot_number: nullableNumber,
    lote: nullableNumber,
    expiry_date: nullableString,
    expira: nullableString,
    fecha_vencimiento: nullableString
  })
  .passthrough();

const purchaseRegisterSchema = z
  .object({
    branch_id: nullableNumber,
    supplier_id: nullableNumber,
    supplier_name: nullableString,
    invoice_number: z.union([z.string(), z.number(), z.null()]).optional(),
    notes: nullableString,
    payment_type: nullableString,
    items: z.array(purchaseItemSchema)
  })
  .passthrough();

const purchaseConfirmSchema = z
  .object({
    purchase_id: z.union([z.string(), z.number()]),
    payment_type: nullableString,
    payment_form: nullableString,
    cuotas: nullableNumber
  })
  .passthrough();

function parseZodError(error) {
  if (!error || !error.errors) return 'Datos inválidos';
  return error.errors.map((err) => err.message || 'Dato inválido').join(', ');
}

function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return safeJson(res, { ok: false, error: parseZodError(parsed.error) }, 400);
    }
    req.validatedBody = parsed.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query || {});
    if (!parsed.success) {
      return safeJson(res, { ok: false, error: parseZodError(parsed.error) }, 400);
    }
    req.validatedQuery = parsed.data;
    next();
  };
}

module.exports = {
  validateBody,
  validateQuery,
  schemas: {
    productSchema,
    barcodeLookupSchema,
    saleCheckoutSchema,
    saleRegisterSchema,
    purchaseRegisterSchema,
    purchaseConfirmSchema
  }
};
