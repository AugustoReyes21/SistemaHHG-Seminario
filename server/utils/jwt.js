const jwt = require('jsonwebtoken');
const config = require('../config');

function getJwtConfig() {
  return {
    secret: config.app.jwtSecret,
    issuer: config.app.jwtIssuer,
    audience: config.app.jwtAudience,
    expiresMinutes: config.app.jwtExpiresMinutes,
    cookieName: config.app.jwtCookieName
  };
}

function signToken(payload) {
  const { secret, issuer, audience, expiresMinutes } = getJwtConfig();
  const options = {
    issuer,
    audience,
    expiresIn: Math.max(5, Number(expiresMinutes || 0) || 480) * 60
  };
  return jwt.sign(payload, secret, options);
}

function verifyToken(token) {
  const { secret, issuer, audience } = getJwtConfig();
  return jwt.verify(token, secret, { issuer, audience });
}

function buildAuthCookieOptions(isProd) {
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
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/'
  };
}

module.exports = {
  getJwtConfig,
  signToken,
  verifyToken,
  buildAuthCookieOptions
};
