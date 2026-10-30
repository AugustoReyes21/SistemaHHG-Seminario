const { canonRole } = require('./helpers');
const { logAction } = require('./functions');

function getUserRole(req) {
  const roleRaw =
    req.user?.rol ||
    req.user?.role ||
    req.session?.user?.rol ||
    req.session?.user?.role ||
    'user';
  return canonRole(roleRaw);
}

function requireAuth(req, res, next) {
  if (!req.user && !req.session?.user) {
    return res.status(401).json({ ok: false, error: 'No autenticado' });
  }
  next();
}

function requireRole(required) {
  return async (req, res, next) => {
    if (req.query && req.query.debug === '1') {
      return res.json({
        ok: !!(req.user || req.session?.user),
        jwt_user: req.user || null,
        session_user: req.session?.user || null
      });
    }

    if (!req.user && !req.session?.user) {
      return res.status(401).json({ ok: false, error: 'No autenticado' });
    }

    const auditOnce = async () => {
      try {
        const action = `api_${(req.path || '').split('/').pop() || 'request'}`;
        await logAction(null, req.user?.id || req.session?.user?.id || null, action, {
          uri: req.originalUrl || '',
          method: req.method,
          query: req.query || {},
          role: userRole,
          ip: req.ip || null,
          ua: req.get('user-agent') ? String(req.get('user-agent')).slice(0, 180) : null
        });
      } catch (_) {}
    };

    const userRole = getUserRole(req);
    if (userRole === 'superadmin') {
      await auditOnce();
      return next();
    }

    if (Array.isArray(required)) {
      const allow = required.map((r) => canonRole(r));
      if (allow.includes(userRole)) {
        await auditOnce();
        return next();
      }
      return res.status(403).json({ ok: false, error: 'Permiso denegado' });
    }

    const levels = { user: 1, secretaria: 1, cashier: 2, farmacia: 2, contabilidad: 2, admin: 3, superadmin: 4 };
    const need = levels[canonRole(required)] || 1;
    const have = levels[userRole] || 1;
    if (have < need) {
      return res.status(403).json({ ok: false, error: 'Permiso denegado' });
    }
    await auditOnce();
    return next();
  };
}

module.exports = {
  getUserRole,
  requireAuth,
  requireRole
};
