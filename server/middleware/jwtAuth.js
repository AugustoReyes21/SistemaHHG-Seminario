const { verifyToken, getJwtConfig } = require('../utils/jwt');

function getTokenFromCookies(req) {
  const { cookieName } = getJwtConfig();
  if (!req || !req.cookies) return null;
  const raw = req.cookies[cookieName];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function clearAuthCookie(res, isProd) {
  const { cookieName } = getJwtConfig();
  const envSecure = process.env.COOKIE_SECURE;
  const envSameSite = process.env.COOKIE_SAMESITE;
  const secure =
    envSecure == null || envSecure === ''
      ? isProd
      : String(envSecure).toLowerCase() === 'true';
  let sameSite = isProd ? 'strict' : 'lax';
  if (envSameSite) {
    const normalized = String(envSameSite).toLowerCase();
    if (['lax', 'strict', 'none'].includes(normalized)) sameSite = normalized;
  }
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/'
  });
}

function jwtAuth() {
  return (req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    const token = getTokenFromCookies(req);
    if (!token) {
      req.user = null;
      return next();
    }
    try {
      const decoded = verifyToken(token);
      req.user = decoded || null;
      if (req.session && decoded) {
        req.session.user = {
          id: decoded.id,
          username: decoded.username,
          rol: decoded.rol || decoded.role,
          role: decoded.role || decoded.rol
        };
      }
    } catch (err) {
      console.log('JWT inválido:', err?.message || err);
      clearAuthCookie(res, isProd);
      req.user = null;
    }
    return next();
  };
}

module.exports = {
  jwtAuth,
  clearAuthCookie,
  getTokenFromCookies
};
