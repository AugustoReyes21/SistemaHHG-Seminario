const express = require('express');
const { query } = require('../db');
const { safeJson, readJson } = require('../helpers');
const { requireRole } = require('../auth');
const {
  felPublicStatus,
  ensureFelSchema,
  buildFelPayload,
  certifySaleIfEnabled,
  getFelDocument
} = require('../utils/fel');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const FEL_ROLES = ['admin', 'administrador', 'contabilidad', 'superadmin'];

async function requireFelRole(req, res) {
  await requireRole(FEL_ROLES)(req, res, async () => {});
  return !res.headersSent;
}

router.get(
  '/fel_status',
  asyncHandler(async (req, res) => {
    if (!(await requireFelRole(req, res))) return;
    await ensureFelSchema(null);
    const summaryRes = await query(
      `SELECT status, COUNT(*)::INT AS total
         FROM fel_documents
        GROUP BY status
        ORDER BY status`
    );
    return safeJson(res, {
      ok: true,
      config: felPublicStatus(),
      summary: summaryRes.rows || []
    });
  })
);

router.get(
  '/fel_document',
  asyncHandler(async (req, res) => {
    if (!(await requireFelRole(req, res))) return;
    const saleId = Number(req.query.sale_id || req.query.venta_id || req.query.id || 0);
    if (!saleId) return safeJson(res, { ok: false, error: 'sale_id requerido' }, 400);
    const document = await getFelDocument(null, saleId);
    return safeJson(res, { ok: true, document });
  })
);

router.get(
  '/fel_payload_preview',
  asyncHandler(async (req, res) => {
    if (!(await requireFelRole(req, res))) return;
    const saleId = Number(req.query.sale_id || req.query.venta_id || req.query.id || 0);
    if (!saleId) return safeJson(res, { ok: false, error: 'sale_id requerido' }, 400);
    const payload = await buildFelPayload(null, saleId);
    return safeJson(res, { ok: true, payload });
  })
);

router.post(
  '/fel_retry',
  asyncHandler(async (req, res) => {
    if (!(await requireFelRole(req, res))) return;
    const body = readJson(req);
    const saleId = Number(body.sale_id || body.venta_id || body.id || req.query.sale_id || 0);
    if (!saleId) return safeJson(res, { ok: false, error: 'sale_id requerido' }, 400);
    const result = await certifySaleIfEnabled(null, saleId, {
      force: true,
      userId: req.session?.user?.id || req.user?.id || null,
      source: 'fel_retry'
    });
    return safeJson(res, { ok: true, result });
  })
);

module.exports = router;
