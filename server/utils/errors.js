const { query, tableExists } = require('../db');

async function ensureErrorsTable() {
  if (await tableExists(null, 'errores')) return;
  await query(`
    CREATE TABLE IF NOT EXISTS errores (
      id SERIAL PRIMARY KEY,
      ruta TEXT NOT NULL,
      mensaje_error TEXT NOT NULL,
      fecha_error TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function logError(db, { ruta, mensaje }) {
  await ensureErrorsTable();
  await query(
    'INSERT INTO errores (ruta, mensaje_error, fecha_error) VALUES ($1,$2,NOW())',
    [String(ruta || ''), String(mensaje || '')],
    db
  );
}

module.exports = {
  ensureErrorsTable,
  logError
};
