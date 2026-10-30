const { query } = require('../db');
const { isValidKey, hashRequest } = require('../utils/idempotency');

/**
 * Middleware de idempotencia para operaciones POST que crean recursos.
 *
 * Flujo (encabezado Idempotency-Key):
 *  1. Primera vez: se reserva la llave (status 'processing') y se ejecuta la ruta.
 *  2. La ruta llama req.idempotency.markCommitted(db, id) DENTRO de su transacción,
 *     así la llave y la venta se confirman juntas o no se confirman.
 *  3. Al responder 2xx se guarda la respuesta ('completed'); si falla, se libera la llave.
 *  4. Reintento con la misma llave y el mismo cuerpo -> se devuelve la respuesta guardada.
 *     Mismo cuerpo pero aún en proceso -> 409. Cuerpo distinto -> 422.
 */
function idempotency({ scope, ttlHours = 24, staleSeconds = 120, required = false } = {}) {
  if (!scope) throw new Error('idempotency: scope requerido');

  return async (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key');
      if (!key) {
        if (required) {
          return res.status(428).json({
            ok: false,
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            error: 'Falta el encabezado Idempotency-Key'
          });
        }
        return next();
      }
      if (!isValidKey(key)) {
        return res.status(400).json({
          ok: false,
          code: 'IDEMPOTENCY_KEY_INVALID',
          error: 'Idempotency-Key inválida: use de 8 a 100 caracteres [A-Za-z0-9_-]'
        });
      }
      const userId = Number(req.session?.user?.id || 0);
      if (!userId) return next(); // la ruta responde 401

      const requestHash = hashRequest(req.body);
      const params = [scope, userId, key];

      // Una llave vencida se puede volver a usar.
      await query(
        'DELETE FROM idempotency_keys WHERE scope = $1 AND user_id = $2 AND idem_key = $3 AND expires_at < NOW()',
        params
      );

      // Reserva atómica: si dos solicitudes llegan a la vez, solo una inserta.
      const inserted = await query(
        `INSERT INTO idempotency_keys (scope, user_id, idem_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval)
         ON CONFLICT (scope, user_id, idem_key) DO NOTHING
         RETURNING id`,
        [...params, requestHash, String(ttlHours)]
      );

      let recordId = inserted.rows[0]?.id;

      if (!recordId) {
        const found = await query(
          `SELECT id, request_hash, status, resource_id, response_status, response_body,
                  updated_at < NOW() - ($4 || ' seconds')::interval AS stale
             FROM idempotency_keys
            WHERE scope = $1 AND user_id = $2 AND idem_key = $3`,
          [...params, String(staleSeconds)]
        );
        const row = found.rows[0];
        if (!row) {
          return res.status(409).json({
            ok: false,
            code: 'IDEMPOTENCY_RETRY',
            error: 'La solicitud cambió de estado; intente de nuevo'
          });
        }
        if (row.request_hash !== requestHash) {
          return res.status(422).json({
            ok: false,
            code: 'IDEMPOTENCY_KEY_REUSED',
            error: 'Esta Idempotency-Key ya se usó con datos diferentes'
          });
        }
        if (row.status === 'completed') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(row.response_status || 200).json(row.response_body);
        }
        if (row.status === 'committed') {
          // La venta se confirmó pero no se alcanzó a guardar la respuesta (p. ej. caída del proceso).
          res.set('Idempotent-Replayed', 'true');
          return res.status(200).json({ ok: true, venta_id: Number(row.resource_id), replayed: true });
        }
        if (!row.stale) {
          res.set('Retry-After', '2');
          return res.status(409).json({
            ok: false,
            code: 'IDEMPOTENCY_IN_PROGRESS',
            error: 'Esta venta ya se está procesando; espere un momento'
          });
        }
        // 'processing' abandonado (el proceso murió sin confirmar nada): se retoma.
        const takeover = await query(
          `UPDATE idempotency_keys SET updated_at = NOW()
            WHERE id = $1 AND status = 'processing'
              AND updated_at < NOW() - ($2 || ' seconds')::interval
            RETURNING id`,
          [row.id, String(staleSeconds)]
        );
        recordId = takeover.rows[0]?.id;
        if (!recordId) {
          return res.status(409).json({
            ok: false,
            code: 'IDEMPOTENCY_IN_PROGRESS',
            error: 'Esta venta ya se está procesando; espere un momento'
          });
        }
      }

      req.idempotency = {
        id: recordId,
        key,
        // Se llama dentro de la transacción de la venta (mismo cliente db).
        markCommitted: (db, resourceId) =>
          query(
            `UPDATE idempotency_keys SET status = 'committed', resource_id = $2, updated_at = NOW() WHERE id = $1`,
            [recordId, resourceId],
            db
          )
      };

      // Antes de enviar la respuesta se guarda (éxito) o se libera la llave (error).
      const originalJson = res.json.bind(res);
      let finalized = false;
      res.json = (body) => {
        if (finalized) return originalJson(body);
        finalized = true;
        const status = res.statusCode;
        const persist =
          status >= 200 && status < 300
            ? query(
                `UPDATE idempotency_keys
                    SET status = 'completed', response_status = $2, response_body = $3, updated_at = NOW()
                  WHERE id = $1`,
                [recordId, status, JSON.stringify(body)]
              )
            : query(`DELETE FROM idempotency_keys WHERE id = $1 AND status = 'processing'`, [recordId]);
        persist
          .catch((err) => console.log('idempotency: no se pudo guardar el resultado:', err?.message || err))
          .finally(() => originalJson(body));
        return res;
      };

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { idempotency };
