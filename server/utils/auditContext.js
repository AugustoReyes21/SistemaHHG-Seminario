const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { canonRole } = require('../helpers');

const storage = new AsyncLocalStorage();

function normalizeIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded)
      .split(',')
      .map((item) => item.trim())
      .find(Boolean);
    if (first) return first;
  }
  const candidate =
    req?.ip ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    null;
  return candidate ? String(candidate).trim() : null;
}

function resolveActor(req) {
  const actor = req?.user || req?.session?.user || null;
  return {
    user_id: actor?.id != null ? Number(actor.id) || null : null,
    username: actor?.username ? String(actor.username).trim() : null,
    user_role: canonRole(actor?.rol || actor?.role || '')
  };
}

function buildAuditContext(req) {
  const actor = resolveActor(req);
  return {
    request_id:
      (req?.headers?.['x-request-id'] && String(req.headers['x-request-id']).trim()) ||
      crypto.randomUUID(),
    method: req?.method ? String(req.method).toUpperCase() : null,
    uri: req?.originalUrl || req?.url || null,
    ip_address: normalizeIp(req),
    user_agent: req?.get ? String(req.get('user-agent') || '').slice(0, 255) || null : null,
    session_id: req?.sessionID ? String(req.sessionID) : null,
    user_id: actor.user_id,
    username: actor.username,
    user_role: actor.user_role || null
  };
}

function auditContextMiddleware(req, res, next) {
  const context = buildAuditContext(req);
  if (res?.setHeader && context.request_id) {
    try {
      res.setHeader('X-Request-ID', context.request_id);
    } catch (_) {}
  }
  storage.run(context, next);
}

function getAuditContext() {
  return storage.getStore() || null;
}

function updateAuditContext(patch = {}) {
  const store = storage.getStore();
  if (!store || !patch || typeof patch !== 'object') return store;
  Object.assign(store, patch);
  return store;
}

module.exports = {
  auditContextMiddleware,
  getAuditContext,
  updateAuditContext
};
