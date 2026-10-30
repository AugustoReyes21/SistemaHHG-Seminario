const isProd = process.env.NODE_ENV === 'production';

function envOrDefault(name, def) {
  const raw = process.env[name];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (isProd) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return def;
}

function intEnv(name, def) {
  const raw = process.env[name];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const num = parseInt(raw, 10);
    if (!Number.isNaN(num)) return num;
  }
  if (isProd) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return def;
}

const config = {
  app: {
    port: intEnv('PORT', 3000),
    sessionSecret: envOrDefault('SESSION_SECRET', 'dev-session-secret'),
    jwtSecret: envOrDefault('JWT_SECRET', 'dev-jwt-secret'),
    jwtIssuer: envOrDefault('JWT_ISSUER', 'sistemahhg'),
    jwtAudience: envOrDefault('JWT_AUDIENCE', 'sistemahhg-users'),
    jwtExpiresMinutes: intEnv('JWT_EXPIRES_MINUTES', 480),
    jwtCookieName: envOrDefault('JWT_COOKIE_NAME', 'hhg_auth')
  },
  db: {
    host: envOrDefault('DB_HOST', '127.0.0.1'),
    port: intEnv('DB_PORT', 5432),
    user: envOrDefault('DB_USER', 'postgres'),
    password: envOrDefault('DB_PASSWORD', ''),
    database: envOrDefault('DB_NAME', 'pos_retail'),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  },
  smtp: {
    host: envOrDefault('SMTP_HOST', 'smtp.gmail.com'),
    port: intEnv('SMTP_PORT', 465),
    user: process.env.SMTP_USER ? String(process.env.SMTP_USER).trim() : '',
    pass: process.env.SMTP_PASS ? String(process.env.SMTP_PASS).trim() : '',
    from: process.env.SMTP_FROM ? String(process.env.SMTP_FROM).trim() : ''
  },
  appUrl: process.env.APP_URL ? String(process.env.APP_URL).trim() : ''
};

module.exports = config;
