function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

function validateEnv(isProd = false) {
  if (!isProd) return;
  requireEnv('DATABASE_URL');
  requireEnv('SESSION_SECRET');
  requireEnv('JWT_SECRET');
  requireEnv('SMTP_HOST');
  requireEnv('SMTP_PORT');
  requireEnv('SMTP_USER');
  requireEnv('SMTP_PASS');
  requireEnv('SMTP_FROM');
}

module.exports = { validateEnv };
