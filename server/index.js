require('dotenv').config();

const detectedTimezone = (() => {
  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (_) {
      return null;
    }
  }
  return null;
})();
process.env.TZ = process.env.TZ || detectedTimezone || 'UTC';

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config');
const { pool } = require('./db');
const registerRoutes = require('./routes');
const disableCache = require('./middleware/noCache');
const { jwtAuth } = require('./middleware/jwtAuth');
const { ensureDatabaseReady } = require('./utils/dbMaintenance');
const { logError } = require('./utils/errors');
const { validateEnv } = require('./utils/validateEnv');
const { auditContextMiddleware } = require('./utils/auditContext');

const app = express();
app.disable('x-powered-by');

const isProd = process.env.NODE_ENV === 'production';
validateEnv(isProd);
if (isProd) {
  app.set('trust proxy', 1);
}

if (isProd) {
  if (config.app.sessionSecret === 'pos-session-secret') {
    throw new Error('SESSION_SECRET inseguro: define un secreto fuerte en producción.');
  }
  if (config.app.jwtSecret === 'pos-jwt-secret') {
    throw new Error('JWT_SECRET inseguro: define un secreto fuerte en producción.');
  }
}

const helmetOptions = { contentSecurityPolicy: false };
if (!isProd) {
  helmetOptions.crossOriginOpenerPolicy = false;
  helmetOptions.originAgentCluster = false;
}
app.use(helmet(helmetOptions));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (isProd && process.env.HTTPS_REDIRECT !== 'false') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (req.secure || proto === 'https') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const host = req.headers.host || '';
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
    return res.status(400).json({ ok: false, error: 'Se requiere HTTPS' });
  });
}

let sessionStore;
if (isProd) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  });
}

app.use(
  session({
    store: sessionStore,
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? 'strict' : 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(auditContextMiddleware);

app.disable('etag');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
const barcodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', loginLimiter);
app.use('/api/barcode_lookup', barcodeLimiter);

app.use((req, res, next) => {
  if (req.path && req.path.endsWith('.php')) {
    return res.status(404).json({ ok: false, error: 'Ruta no disponible' });
  }
  return next();
});

app.use('/api', disableCache);
app.use(jwtAuth());
registerRoutes(app);

const staticRoot = path.join(__dirname, '..');
const uploadsRoot = path.join(staticRoot, 'uploads');
try {
  fs.mkdirSync(uploadsRoot, { recursive: true });
} catch (_) {}
const legacyBases = ['/Pos/merged', '/POS/merged', '/pos/merged', '/SistemaHHG/merged'];

const legacyRouter = express.Router();
legacyRouter.use(jwtAuth());
registerRoutes(legacyRouter);
for (const base of legacyBases) {
  app.use(base, legacyRouter);
}

app.use(express.static(staticRoot));
app.use('/uploads', express.static(uploadsRoot));
for (const base of legacyBases) {
  app.use(base, express.static(staticRoot));
}

app.use(async (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const ruta = req.originalUrl || req.url || 'unknown';
  const mensaje = err?.message || 'Error en servidor';
  console.log('Error:', mensaje);
  try {
    await logError(null, { ruta, mensaje });
  } catch (logErr) {
    console.log('Error al registrar en BD:', logErr?.message || logErr);
  }
  res.status(500).json({ ok: false, error: mensaje });
});

async function start() {
  await ensureDatabaseReady();
  const host = process.env.HOST || '0.0.0.0';
  const pfxPath = process.env.SSL_PFX_PATH ? String(process.env.SSL_PFX_PATH).trim() : '';
  const pfxPassphrase = process.env.SSL_PFX_PASSPHRASE
    ? String(process.env.SSL_PFX_PASSPHRASE)
    : '';
  const keyPath = process.env.SSL_KEY_PATH ? String(process.env.SSL_KEY_PATH).trim() : '';
  const certPath = process.env.SSL_CERT_PATH ? String(process.env.SSL_CERT_PATH).trim() : '';
  const caPath = process.env.SSL_CA_PATH ? String(process.env.SSL_CA_PATH).trim() : '';
  const hasPfx = pfxPath && fs.existsSync(pfxPath);
  const hasTls = keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath);

  if (hasPfx || hasTls) {
    const tlsOpts = hasPfx
      ? {
          pfx: fs.readFileSync(pfxPath)
        }
      : {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath)
        };
    if (hasPfx && pfxPassphrase) {
      tlsOpts.passphrase = pfxPassphrase;
    } else if (caPath && fs.existsSync(caPath)) {
      tlsOpts.ca = fs.readFileSync(caPath);
    }
    https.createServer(tlsOpts, app).listen(config.app.port, host, () => {
      console.log(`POS server running on https://${host}:${config.app.port}`);
    });
    if (process.env.HTTP_REDIRECT !== 'false') {
      const httpPort = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : 80;
      http
        .createServer((req, res) => {
          const hostHeader = req.headers.host || '';
          const hostOnly = hostHeader.split(':')[0];
          const target = `https://${hostOnly}:${config.app.port}${req.url}`;
          res.writeHead(301, { Location: target });
          res.end();
        })
        .listen(httpPort, host, () => {
          console.log(`HTTP redirect server on http://${host}:${httpPort}`);
        });
    }
  } else {
    app.listen(config.app.port, host, () => {
      console.log(`POS server running on http://${host}:${config.app.port}`);
    });
  }
}

start().catch((err) => {
  console.log('No se pudo iniciar el servidor:', err?.message || err);
  process.exit(1);
});
