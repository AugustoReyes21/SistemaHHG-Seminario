const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const config = require('./config');
const { pool } = require('./db');
const registerRoutes = require('./routes');
const disableCache = require('./middleware/noCache');
const { jwtAuth } = require('./middleware/jwtAuth');
const { logError } = require('./utils/errors');
const { validateEnv } = require('./utils/validateEnv');
const { auditContextMiddleware } = require('./utils/auditContext');

/**
 * Construye la aplicación Express sin abrir un puerto.
 * index.js la usa para levantar el servidor y las pruebas de integración
 * la usan directamente con supertest.
 */
function createApp() {
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
    // Errores de negocio (HttpError) traen su propio estado 4xx; el resto es 500.
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) {
      console.log('Error:', mensaje);
      try {
        await logError(null, { ruta, mensaje });
      } catch (logErr) {
        console.log('Error al registrar en BD:', logErr?.message || logErr);
      }
    }
    const body = { ok: false, error: mensaje };
    if (err?.code && typeof err.code === 'string' && status < 500) body.code = err.code;
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp };
