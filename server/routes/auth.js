const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { query, tableExists, getColumns, quoteIdent, columnExists } = require('../db');
const { safeJson, readJson, canonRole } = require('../helpers');
const { requireRole, requireAuth } = require('../auth');
const { logAction, ensureResetToken } = require('../functions');
const { sendMail } = require('../email');
const { getJwtConfig, signToken, buildAuthCookieOptions } = require('../utils/jwt');
const { clearAuthCookie } = require('../middleware/jwtAuth');
const { updateAuditContext } = require('../utils/auditContext');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function normalizeHash(hash) {
  if (!hash) return '';
  if (hash.startsWith('$2y$')) return `$2b$${hash.slice(4)}`;
  return hash;
}

async function verifyPassword(plain, hash) {
  const normalized = normalizeHash(hash);
  try {
    if (normalized.startsWith('$2')) {
      return await bcrypt.compare(plain, normalized);
    }
  } catch (_) {}
  return plain === hash;
}

function needsRehash(hash) {
  const normalized = normalizeHash(hash);
  if (!normalized.startsWith('$2')) return true;
  try {
    const rounds = bcrypt.getRounds(normalized);
    return rounds < 10;
  } catch (_) {
    return true;
  }
}

let userColumnsCache = null;

async function ensureUserPhotoColumn() {
  if (!(await tableExists(null, 'users'))) return null;
  if (!(await columnExists(null, 'users', 'photo_url'))) {
    try {
      await query('ALTER TABLE users ADD COLUMN photo_url VARCHAR(300) NULL');
    } catch (_) {}
  }
  return (await columnExists(null, 'users', 'photo_url')) ? 'photo_url' : null;
}

const uploadRoot = path.join(__dirname, '..', '..', 'uploads', 'avatars');
try {
  fs.mkdirSync(uploadRoot, { recursive: true });
} catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      cb(null, `user_${req.session?.user?.id || 'anon'}_${stamp}_${rand}${safeExt}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Tipo de imagen no permitido'), ok);
  }
});

function pickColumns(set, candidates) {
  return candidates.filter((c) => set.has(c));
}

function pickColumn(set, candidates) {
  const list = pickColumns(set, candidates);
  return list.length ? list[0] : null;
}

async function getUserColumnInfo() {
  if (userColumnsCache) return userColumnsCache;
  let cols = [];
  try {
    cols = await getColumns(null, 'users');
  } catch (_) {
    cols = [];
  }
  const set = new Set(cols);
  userColumnsCache = {
    roleCol: pickColumn(set, ['role', 'rol']),
    activeCol: pickColumn(set, ['activo', 'active']),
    cambioCol: pickColumn(set, ['cambio_obligatorio', 'cambio_password']),
    failedAttemptCols: pickColumns(set, ['failed_attempts', 'intentos', 'attempts']),
    blockedCols: pickColumns(set, ['blocked', 'bloqueado']),
    tempPasswordCol: pickColumn(set, ['temp_password']),
    tempPasswordExpirationCol: pickColumn(set, ['temp_password_expiration', 'temp_password_expiry']),
    tempPasswordUsedCol: pickColumn(set, ['temp_password_used']),
    tokenCol: pickColumn(set, ['token_recuperacion']),
    tokenExpiryCol: pickColumn(set, ['token_expiry']),
    photoCol: pickColumn(set, ['photo_url', 'foto_url', 'photo', 'foto'])
  };
  return userColumnsCache;
}

async function ensureLoginAttemptsTable() {
  if (await tableExists(null, 'login_attempts')) return;
  await query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      ip VARCHAR(45) NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_attempt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function isUserBlocked(user, cols) {
  return cols.blockedCols.some((col) => Number(user?.[col] || 0) === 1);
}

async function incrementUserAttempts(userId, cols) {
  if (!cols.failedAttemptCols.length) return null;
  for (const col of cols.failedAttemptCols) {
    const colRef = quoteIdent(col);
    await query(
      `UPDATE users SET ${colRef} = COALESCE(${colRef}, 0) + 1 WHERE id = $1`,
      [userId]
    );
  }
  const baseCol = cols.failedAttemptCols[0];
  const res = await query(
    `SELECT ${quoteIdent(baseCol)} AS attempts FROM users WHERE id = $1`,
    [userId]
  );
  return Number(res.rows[0]?.attempts || 0);
}

async function resetUserAttempts(userId, cols) {
  for (const col of cols.failedAttemptCols) {
    await query(`UPDATE users SET ${quoteIdent(col)} = 0 WHERE id = $1`, [userId]);
  }
}

async function setUserBlocked(userId, cols, blocked) {
  const value = !!blocked;
  for (const col of cols.blockedCols) {
    await query(`UPDATE users SET ${quoteIdent(col)} = $1 WHERE id = $2`, [
      value,
      userId
    ]);
  }
}

router.post(
  '/upload_photo',
  requireAuth,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) return safeJson(res, { ok: false, error: 'Archivo requerido' }, 400);
    const url = `/uploads/avatars/${req.file.filename}`;
    return safeJson(res, { ok: true, url });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = readJson(req);
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!username || !password) {
      return safeJson(res, { error: 'Usuario y contraseña requeridos' }, 400);
    }

    const MAX_ATTEMPTS = 3;
    const LOCK_MINUTES = 15;
    const ip = req.ip || '0.0.0.0';

    await ensureLoginAttemptsTable();
    const colInfo = await getUserColumnInfo();

    const attemptRes = await query(
      'SELECT id, attempts, last_attempt FROM login_attempts WHERE username = $1 AND ip = $2',
      [username, ip]
    );
    const attempt = attemptRes.rows[0] || null;

    if (attempt && Number(attempt.attempts) >= MAX_ATTEMPTS) {
      const last = attempt.last_attempt ? new Date(attempt.last_attempt) : null;
      if (last && Date.now() - last.getTime() < LOCK_MINUTES * 60000) {
        return safeJson(
          res,
          { error: 'Cuenta bloqueada temporalmente. Intenta de nuevo más tarde.' },
          429
        );
      }
      await query('UPDATE login_attempts SET attempts = 0 WHERE id = $1', [attempt.id]);
    }

    const userRes = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = userRes.rows[0];

    const bumpLoginAttempt = async () => {
      if (attempt) {
        await query(
          'UPDATE login_attempts SET attempts = attempts + 1, last_attempt = NOW() WHERE id = $1',
          [attempt.id]
        );
      } else {
        await query(
          'INSERT INTO login_attempts (username, ip, attempts, last_attempt) VALUES ($1,$2,1,NOW())',
          [username, ip]
        );
      }
    };

    if (!user) {
      await logAction(null, null, 'login_failed', {
        username,
        ip,
        status: 'failed',
        severity: 'high',
        source_module: 'seguridad'
      });
      await bumpLoginAttempt();
      return safeJson(res, { error: 'Credenciales inválidas' }, 401);
    }

    if (colInfo.activeCol && Number(user[colInfo.activeCol]) !== 1) {
      await logAction(null, Number(user.id || 0) || null, 'login_failed', {
        username: user.username || username,
        ip,
        status: 'inactive',
        severity: 'high',
        source_module: 'seguridad'
      });
      return safeJson(res, { error: 'Cuenta inactiva. Contacte al administrador.' }, 403);
    }
    if (colInfo.blockedCols.length && isUserBlocked(user, colInfo)) {
      await logAction(null, Number(user.id || 0) || null, 'login_failed', {
        username: user.username || username,
        ip,
        status: 'blocked',
        severity: 'high',
        source_module: 'seguridad'
      });
      return safeJson(res, { error: 'Usuario bloqueado. Contacte al administrador.' }, 403);
    }

    const tempPassword = colInfo.tempPasswordCol ? user[colInfo.tempPasswordCol] : null;
    const tempExpRaw = colInfo.tempPasswordExpirationCol
      ? user[colInfo.tempPasswordExpirationCol]
      : null;
    const tempUsed = colInfo.tempPasswordUsedCol ? Number(user[colInfo.tempPasswordUsedCol] || 0) : 0;
    const tempExp = tempExpRaw ? new Date(tempExpRaw) : null;
    const hasTemp =
      tempPassword &&
      tempUsed === 0 &&
      tempExp &&
      tempExp >= new Date();

    if (hasTemp) {
      const ok = await verifyPassword(password, tempPassword);
      if (!ok) {
        const fa = await incrementUserAttempts(user.id, colInfo);
        if (fa != null && fa >= MAX_ATTEMPTS) {
          await setUserBlocked(user.id, colInfo, true);
        }
        await logAction(null, Number(user.id || 0) || null, 'login_failed', {
          username: user.username || username,
          ip,
          status: 'temp_password_invalid',
          severity: 'high',
          source_module: 'seguridad'
        });
        await bumpLoginAttempt();
        return safeJson(res, { error: 'Contraseña temporal inválida' }, 401);
      }
      const updates = [];
      if (colInfo.tempPasswordUsedCol) updates.push([colInfo.tempPasswordUsedCol, true]);
      if (colInfo.cambioCol) updates.push([colInfo.cambioCol, true]);
      for (const [col, value] of updates) {
        await query(`UPDATE users SET ${quoteIdent(col)} = $1 WHERE id = $2`, [value, user.id]);
      }
      const [token] = await ensureResetToken(null, user.id);
      return safeJson(
        res,
        {
          error: 'Debe cambiar la contraseña temporal.',
          cambio: true,
          username: user.username,
          token
        },
        403
      );
    }

    if (colInfo.cambioCol && Number(user[colInfo.cambioCol]) === 1) {
      const [token] = await ensureResetToken(null, user.id);
      return safeJson(
        res,
        {
          error: 'Debe cambiar la contraseña.',
          cambio: true,
          username: user.username,
          token
        },
        403
      );
    }

    const ok = await verifyPassword(password, user.password);
    if (!ok) {
      const fa = await incrementUserAttempts(user.id, colInfo);
      if (fa != null && fa >= MAX_ATTEMPTS) {
        await setUserBlocked(user.id, colInfo, true);
      }
      await logAction(null, Number(user.id || 0) || null, 'login_failed', {
        username: user.username || username,
        ip,
        status: 'invalid_credentials',
        severity: 'high',
        source_module: 'seguridad'
      });
      await bumpLoginAttempt();
      return safeJson(res, { error: 'Credenciales inválidas' }, 401);
    }

    await query('DELETE FROM login_attempts WHERE username = $1 AND ip = $2', [username, ip]);

    if (needsRehash(user.password)) {
      const hash = await bcrypt.hash(password, 10);
      await query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
    }

    const roleRaw = colInfo.roleCol ? user[colInfo.roleCol] : user.role;
    const role = canonRole(roleRaw || 'user');
    const authPayload = {
      id: user.id,
      username: user.username,
      rol: role,
      role
    };
    const token = signToken(authPayload);
    const { cookieName, expiresMinutes } = getJwtConfig();
    const isProd = process.env.NODE_ENV === 'production';
    const cookieOptions = {
      ...buildAuthCookieOptions(isProd),
      maxAge: Math.max(5, Number(expiresMinutes || 0) || 480) * 60 * 1000
    };
    res.cookie(cookieName, token, cookieOptions);
    req.user = authPayload;
    if (req.session) {
      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) return reject(err);
          return resolve();
        });
      });
      req.session.user = authPayload;
    }
    updateAuditContext({
      user_id: Number(user.id || 0) || null,
      username: user.username || null,
      user_role: role || null
    });

    await resetUserAttempts(user.id, colInfo);
    if (attempt) {
      await query('UPDATE login_attempts SET attempts = 0 WHERE id = $1', [attempt.id]);
    }

    await logAction(null, user.id, 'login', {
      ip,
      username: user.username,
      status: 'ok',
      source_module: 'seguridad'
    });
    return safeJson(res, { ok: true, user: authPayload });
  })
);

router.all(
  '/logout',
  asyncHandler(async (req, res) => {
    const currentUserId = req.user?.id || req.session?.user?.id || null;
    const currentUsername = req.user?.username || req.session?.user?.username || null;
    if (currentUserId) {
      updateAuditContext({
        user_id: Number(currentUserId || 0) || null,
        username: currentUsername || null
      });
      await logAction(null, currentUserId, 'logout', {
        username: currentUsername,
        ip: req.ip || '0.0.0.0',
        status: 'ok',
        source_module: 'seguridad'
      });
    }
    const isProd = process.env.NODE_ENV === 'production';
    clearAuthCookie(res, isProd);
    if (req.session) {
      await new Promise((resolve) => {
        req.session.destroy(() => resolve());
      });
    }
    req.user = null;
    return safeJson(res, { ok: true });
  })
);

router.get(
  '/auth_check',
  asyncHandler(async (req, res) => {
    const user = req.user || req.session?.user;
    if (user) {
      await ensureUserPhotoColumn();
      const cols = await getUserColumnInfo();
      let photoUrl = null;
      if (cols.photoCol && user.id) {
        try {
          const st = await query(
            `SELECT ${quoteIdent(cols.photoCol)} AS photo_url FROM users WHERE id = $1`,
            [Number(user.id)]
          );
          photoUrl = st.rows[0]?.photo_url || null;
        } catch (_) {}
      }
      return safeJson(res, {
        ok: true,
        user: {
          id: user.id || null,
          rol: user.rol || user.role || 'usuario',
          name: user.name || user.usuario || 'Usuario',
          username: user.username || null,
          nombre_medico: user.nombre_medico || null,
          photo_url: photoUrl
        }
      });
    }
    if (process.env.NODE_ENV !== 'production') {
      const { cookieName } = getJwtConfig();
      const hasCookie = !!(req.cookies && req.cookies[cookieName]);
      const hasSession = !!(req.session && req.session.user);
      return safeJson(res, { ok: false, debug: { cookieName, hasCookie, hasSession } });
    }
    return safeJson(res, { ok: false });
  })
);

router.post(
  '/change_password',
  asyncHandler(async (req, res) => {
    const data = readJson(req);
    const username = String(data.username || '');
    const token = String(data.token || '');
    const newPwd = String(data.new_password || '');
    if (!username || !token || !newPwd) {
      return safeJson(res, { error: 'Datos incompletos' }, 400);
    }

    const cols = await getUserColumnInfo();
    const selectCols = ['id', 'token_expiry'];
    if (cols.tempPasswordUsedCol) selectCols.push(quoteIdent(cols.tempPasswordUsedCol) + ' AS temp_used');
    if (cols.tempPasswordCol) selectCols.push(quoteIdent(cols.tempPasswordCol) + ' AS temp_password');
    if (cols.tempPasswordExpirationCol) {
      selectCols.push(quoteIdent(cols.tempPasswordExpirationCol) + ' AS temp_expiry');
    }
    const st = await query(
      `SELECT ${selectCols.join(', ')} FROM users WHERE username = $1 AND token_recuperacion = $2`,
      [username, token]
    );
    const user = st.rows[0];
    if (!user) {
      return safeJson(res, { error: 'Token inválido' }, 400);
    }
    if (cols.tempPasswordUsedCol) {
      const tempUsed = Number(user.temp_used || 0) === 1;
      const tempExp = user.temp_expiry ? new Date(user.temp_expiry) : null;
      const hasTemp = !!user.temp_password;
      if (hasTemp && !tempUsed && (!tempExp || tempExp >= new Date())) {
        return safeJson(
          res,
          { error: 'Debe iniciar sesión con la contraseña temporal antes de cambiarla.' },
          403
        );
      }
    }
    if (user.token_expiry && new Date(user.token_expiry) < new Date()) {
      return safeJson(res, { error: 'Token expirado' }, 400);
    }
    const hash = await bcrypt.hash(newPwd, 10);
    await query(
      'UPDATE users SET password = $1, cambio_obligatorio = FALSE, token_recuperacion = NULL, token_expiry = NULL WHERE id = $2',
      [hash, user.id]
    );
    await logAction(null, req.user?.id || req.session?.user?.id || null, 'cambio_contrasena', {
      username,
      user_id: user.id
    });
    return safeJson(res, { ok: true });
  })
);

router.post(
  '/forgot_password',
  asyncHandler(async (req, res) => {
    const input = readJson(req);
    const username = String(input.username || '').trim();
    const email = String(input.email || '').trim();
    if (!username && !email) {
      return safeJson(res, { error: 'Debe proporcionar nombre de usuario o correo electrónico' }, 400);
    }

    const cols = await getUserColumnInfo();
    const selectCols = ['id', 'username', 'email'];
    if (cols.tempPasswordUsedCol) selectCols.push(quoteIdent(cols.tempPasswordUsedCol) + ' AS temp_used');
    if (cols.tempPasswordCol) selectCols.push(quoteIdent(cols.tempPasswordCol) + ' AS temp_password');
    if (cols.tempPasswordExpirationCol) {
      selectCols.push(quoteIdent(cols.tempPasswordExpirationCol) + ' AS temp_expiry');
    }
    const st = username
      ? await query(`SELECT ${selectCols.join(', ')} FROM users WHERE username = $1`, [username])
      : await query(`SELECT ${selectCols.join(', ')} FROM users WHERE email = $1`, [email]);
    const user = st.rows[0];
    if (!user) {
      return safeJson(res, { error: 'Usuario no encontrado' }, 404);
    }
    if (cols.tempPasswordUsedCol) {
      const tempUsed = Number(user.temp_used || 0) === 1;
      const tempExp = user.temp_expiry ? new Date(user.temp_expiry) : null;
      const hasTemp = !!user.temp_password;
      if (hasTemp && !tempUsed && (!tempExp || tempExp >= new Date())) {
        return safeJson(
          res,
          { error: 'Debe iniciar sesión con su contraseña temporal antes de usar "Olvidé mi contraseña".' },
          403
        );
      }
    }
    const userEmail = String(user.email || '').trim();
    if (!userEmail) {
      return safeJson(res, { error: 'El usuario no tiene correo registrado.' }, 400);
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000);
    await query(
      'UPDATE users SET token_recuperacion = $1, token_expiry = $2, cambio_obligatorio = TRUE WHERE id = $3',
      [token, expiry, user.id]
    );

    const link = `change_password.html?username=${encodeURIComponent(user.username)}&token=${encodeURIComponent(
      token
    )}`;
    let appUrl = (config.appUrl || '').replace(/\/+$/, '');
    if (!appUrl) {
      const proto = req.secure ? 'https' : 'http';
      const host = req.get('host') || '';
      const basePath = (req.baseUrl || '').replace(/\/api\/?$/, '');
      appUrl = host ? `${proto}://${host}${basePath}` : '';
    }
    const absoluteLink = appUrl ? `${appUrl}/${link}` : link;

    const subject = 'Solicitud de restablecimiento de contraseña';
    const body =
      `Hola ${user.username},\n\n` +
      'Recibimos una solicitud para restablecer tu contraseña.\n' +
      `Haz clic en el siguiente enlace (vigente por 24 horas) para continuar:\n${absoluteLink}\n\n` +
      `Token: ${token}\nExpira: ${expiry.toISOString().slice(0, 19).replace('T', ' ')}\n\n` +
      'Si no solicitaste este cambio, ignora este correo.';

    const sent = await sendMail({
      to: userEmail,
      subject,
      text: body
    });

    if (!sent) {
      return safeJson(res, { error: 'No se pudo enviar el correo. Verifica el SMTP.' }, 500);
    }

    return safeJson(res, {
      ok: true,
      message: 'Se envió un enlace para restablecer la contraseña a tu correo.',
      username: user.username,
      token,
      link,
      expiry: expiry.toISOString().slice(0, 19).replace('T', ' ')
    });
  })
);

router.all(
  '/users',
  asyncHandler(async (req, res) => {
    const method = req.method;
    const input = readJson(req);

    if (method === 'GET') {
      await requireRole('admin')(req, res, async () => {});
      if (res.headersSent) return;
      await ensureUserPhotoColumn();
      const cols = await getUserColumnInfo();
      const select = ['id', 'username'];
      if (cols.roleCol) {
        select.push(`${quoteIdent(cols.roleCol)} AS rol`);
      } else {
        select.push(`'user' AS rol`);
      }
      if (cols.activeCol) {
        select.push(`${quoteIdent(cols.activeCol)} AS activo`);
      } else {
        select.push('1 AS activo');
      }
      if (cols.failedAttemptCols.length) {
        select.push(`${quoteIdent(cols.failedAttemptCols[0])} AS failed_attempts`);
      } else {
        select.push('0 AS failed_attempts');
      }
      if (cols.blockedCols.length) {
        select.push(`${quoteIdent(cols.blockedCols[0])} AS blocked`);
      } else {
        select.push('0 AS blocked');
      }
      if (cols.photoCol) {
        select.push(`${quoteIdent(cols.photoCol)} AS photo_url`);
      }
      const st = await query(`SELECT ${select.join(', ')} FROM users ORDER BY id ASC`);
      return safeJson(res, st.rows);
    }

    if (method === 'POST') {
      await requireRole('admin')(req, res, async () => {});
      if (res.headersSent) return;
      await ensureUserPhotoColumn();
      const cols = await getUserColumnInfo();
      const action = String(req.query.action || input.action || '').trim().toLowerCase();
      if (action === 'set_active') {
        if (!cols.activeCol) {
          return safeJson(res, { error: 'Columna activo no disponible' }, 400);
        }
        const id = Number(input.id || req.query.id || 0);
        const rawActive = input.activo ?? input.active ?? input.estado;
        if (!id || rawActive === undefined || rawActive === null) {
          return safeJson(res, { error: 'id y activo requeridos' }, 400);
        }
        const activeValue =
          rawActive === true ||
          rawActive === '1' ||
          rawActive === 1 ||
          rawActive === 'true' ||
          Number(rawActive) === 1;
        await query(`UPDATE users SET ${quoteIdent(cols.activeCol)} = $1 WHERE id = $2`, [
          activeValue,
          id
        ]);
        return safeJson(res, { ok: true });
      }
      const username = String(input.username || '').trim();
      const email = String(input.email || '').trim();
      const roleRaw = String(input.rol || 'user').trim().toLowerCase();
      const role = canonRole(roleRaw);
      const photoUrl = input.photo_url || input.foto_url || input.photo || input.foto || null;
      if (!username || !email) {
        return safeJson(res, { error: 'username y email son obligatorios' }, 400);
      }
      const exists = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [
        username,
        email
      ]);
      if (exists.rows[0]) {
        return safeJson(res, { error: 'Ya existe un usuario con ese nombre o email' }, 400);
      }

      const plainPwd = crypto.randomBytes(8).toString('hex').slice(0, 10);
      const hash = await bcrypt.hash(plainPwd, 10);
      const tempHash = await bcrypt.hash(plainPwd, 10);
      const token = crypto.randomBytes(16).toString('hex');
      const expiry = new Date(Date.now() + 24 * 3600 * 1000);

      const columns = [];
      const values = [];
      const used = new Set();
      const addColumn = (col, value) => {
        if (!col || used.has(col)) return;
        used.add(col);
        columns.push(col);
        values.push(value);
      };
      addColumn('username', username);
      addColumn('email', email);
      addColumn('password', hash);
      addColumn(cols.roleCol, role);
      addColumn(cols.cambioCol, true);
      addColumn(cols.tokenCol, token);
      addColumn(cols.tokenExpiryCol, expiry);
      addColumn(cols.activeCol, true);
      addColumn(cols.tempPasswordCol, tempHash);
      addColumn(cols.tempPasswordExpirationCol, expiry);
      addColumn(cols.tempPasswordUsedCol, false);
      cols.failedAttemptCols.forEach((col) => addColumn(col, 0));
      cols.blockedCols.forEach((col) => addColumn(col, false));
      if (cols.photoCol && photoUrl) addColumn(cols.photoCol, String(photoUrl).trim());

      const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(',');
      const sql =
        `INSERT INTO users (` +
        columns.map(quoteIdent).join(', ') +
        `) VALUES (${placeholders}) RETURNING id`;
      const ins = await query(sql, values);
      const userId = Number(ins.rows[0].id);
      const actorId = req.user?.id || req.session?.user?.id || null;

      await logAction(null, actorId, 'user_created', {
        entity_type: 'usuario',
        entity_id: userId,
        username,
        role,
        email,
        status: 'ok',
        source_module: 'seguridad'
      });

      const appUrl = (config.appUrl || '').replace(/\/+$/, '');
      const resetLink = appUrl ? `${appUrl}/reset_password.html?token=${encodeURIComponent(token)}` : '';
      const subject = 'Credenciales de acceso temporales';
      let body =
        `Hola ${username},\n\n` +
        'Se creó una cuenta para ti en el sistema POS.\n' +
        `Contraseña temporal: ${plainPwd}\n` +
        `Token de recuperación (vigencia 24h): ${token}\n` +
        `Expira el: ${expiry.toISOString().slice(0, 19).replace('T', ' ')}.\n`;
      if (resetLink) {
        body += `Puedes cambiar tu contraseña usando el siguiente enlace:\n${resetLink}\n`;
      }
      body += '\nSi no solicitaste esta cuenta, contacta al administrador.\n';

      const sent = await sendMail({ to: email, subject, text: body });

      return safeJson(res, {
        ok: true,
        id: userId,
        password: plainPwd,
        token,
        expires_at: expiry.toISOString().slice(0, 19).replace('T', ' '),
        email_sent: sent
      });
    }

    if (method === 'PUT') {
      await requireRole('admin')(req, res, async () => {});
      if (res.headersSent) return;
      const id = input.id || req.query.id;
      if (!id) return safeJson(res, { error: 'id requerido' }, 400);
      await ensureUserPhotoColumn();
      const cols = await getUserColumnInfo();
      const sets = [];
      const params = [];
      if (input.username != null) {
        sets.push(`username = $${params.length + 1}`);
        params.push(String(input.username).trim());
      }
      if (input.rol != null) {
        if (!cols.roleCol) {
          return safeJson(res, { error: 'Columna de rol no disponible' }, 400);
        }
        sets.push(`${quoteIdent(cols.roleCol)} = $${params.length + 1}`);
        params.push(canonRole(String(input.rol).trim().toLowerCase()));
      }
      if (input.password != null) {
        sets.push(`password = $${params.length + 1}`);
        params.push(await bcrypt.hash(String(input.password), 10));
      }
      if (input.photo_url != null || input.foto_url != null || input.photo != null || input.foto != null) {
        if (!cols.photoCol) {
          return safeJson(res, { error: 'Columna de foto no disponible' }, 400);
        }
        const value = input.photo_url ?? input.foto_url ?? input.photo ?? input.foto ?? null;
        sets.push(`${quoteIdent(cols.photoCol)} = $${params.length + 1}`);
        params.push(value ? String(value).trim() : null);
      }
      if (input.activo != null) {
        if (!cols.activeCol) {
          return safeJson(res, { error: 'Columna activo no disponible' }, 400);
        }
        sets.push(`${quoteIdent(cols.activeCol)} = $${params.length + 1}`);
        const activeValue =
          input.activo === true ||
          input.activo === '1' ||
          input.activo === 1 ||
          input.activo === 'true' ||
          Number(input.activo) === 1;
        params.push(activeValue);
      }
      if (!sets.length) return safeJson(res, { mensaje: 'Nada que actualizar' });
      const actorId = req.user?.id || req.session?.user?.id || null;
      const auditChanges = {};
      if (input.username != null) auditChanges.username = String(input.username).trim();
      if (input.rol != null) auditChanges.role = canonRole(String(input.rol).trim().toLowerCase());
      if (input.activo != null) auditChanges.activo = !!(
        input.activo === true ||
        input.activo === '1' ||
        input.activo === 1 ||
        input.activo === 'true' ||
        Number(input.activo) === 1
      );
      if (input.password != null) auditChanges.password_changed = true;
      params.push(Number(id));
      const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`;
      await query(sql, params);
      await logAction(null, actorId, 'user_updated', {
        entity_type: 'usuario',
        entity_id: Number(id),
        changes: auditChanges,
        status: 'ok',
        source_module: 'seguridad'
      });
      return safeJson(res, { ok: true });
    }

    if (method === 'DELETE') {
      await requireRole('admin')(req, res, async () => {});
      if (res.headersSent) return;
      const id = input.id || req.query.id;
      if (!id) return safeJson(res, { error: 'id requerido' }, 400);
      const actorId = req.user?.id || req.session?.user?.id || null;
      const cols = await getUserColumnInfo();
      if (!cols.activeCol) {
        return safeJson(res, { error: 'Columna activo no disponible' }, 400);
      }
      await query(`UPDATE users SET ${quoteIdent(cols.activeCol)} = FALSE WHERE id = $1`, [
        Number(id)
      ]);
      await logAction(null, actorId, 'user_deactivated', {
        entity_type: 'usuario',
        entity_id: Number(id),
        status: 'ok',
        source_module: 'seguridad'
      });
      return safeJson(res, { ok: true });
    }

    return safeJson(res, { error: 'Método no permitido' }, 405);
  })
);

router.post(
  '/user_block',
  asyncHandler(async (req, res) => {
    await requireRole('admin')(req, res, async () => {});
    if (res.headersSent) return;
    const input = readJson(req);
    const id = Number(input.id || 0);
    const bloquear = input.bloquear ?? input.blocked ?? input.block;
    const val = bloquear === true || bloquear === false ? bloquear : null;
    if (!id || val === null) {
      return safeJson(res, { error: 'Parámetros requeridos: id y bloquear(true/false)' }, 400);
    }
    const cols = await getUserColumnInfo();
    if (!cols.blockedCols.length && !cols.failedAttemptCols.length) {
      return safeJson(res, { error: 'Columnas de bloqueo no disponibles' }, 400);
    }
    const blockValue = !!val;
    const actorId = req.user?.id || req.session?.user?.id || null;
    const params = [];
    const sets = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const blockParam = addParam(blockValue);
    cols.blockedCols.forEach((col) => {
      sets.push(`${quoteIdent(col)} = ${blockParam}`);
    });
    cols.failedAttemptCols.forEach((col) => {
      const colRef = quoteIdent(col);
      sets.push(`${colRef} = CASE WHEN ${blockParam} THEN ${colRef} ELSE 0 END`);
    });
    params.push(id);
    const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`;
    await query(sql, params);
    if (!blockValue) {
      const userRes = await query('SELECT username FROM users WHERE id = $1', [id]);
      const username = userRes.rows[0]?.username;
      if (username) {
        await query('DELETE FROM login_attempts WHERE username = $1', [username]);
      }
    }
    await logAction(null, actorId, 'user_block_changed', {
      entity_type: 'usuario',
      entity_id: id,
      blocked: blockValue,
      status: 'ok',
      source_module: 'seguridad'
    });
    return safeJson(res, { ok: true });
  })
);

router.get(
  '/migrate_passwords',
  asyncHandler(async (req, res) => {
    if (!(await tableExists(null, 'usuarios'))) {
      res.type('text/plain').send('Tabla usuarios no encontrada\n');
      return;
    }
    const st = await query('SELECT id, password FROM usuarios');
    let updated = 0;
    for (const row of st.rows) {
      const pw = String(row.password || '');
      if (pw.length < 60 || (!pw.startsWith('$2y$') && !pw.startsWith('$2a$') && !pw.startsWith('$2b$'))) {
        const hash = await bcrypt.hash(pw, 10);
        await query('UPDATE usuarios SET password = $1 WHERE id = $2', [hash, row.id]);
        updated += 1;
      }
    }
    res.type('text/plain').send(`Migración completada. Registros actualizados: ${updated}\n`);
  })
);

module.exports = router;
