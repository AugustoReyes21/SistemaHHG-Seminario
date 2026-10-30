const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Aplica en orden los archivos migrations/NNN_*.sql que aún no estén
 * registrados en schema_migrations. Cada archivo corre en su propia transacción.
 */
async function runMigrations(db = pool, { log = console.log } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(200) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`Migración aplicada: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Falló la migración ${file}: ${err.message}`);
    } finally {
      if (client !== db && typeof client.release === 'function') client.release();
    }
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS_DIR };

if (require.main === module) {
  require('dotenv').config();
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `${applied.length} migración(es) aplicada(s).` : 'Sin migraciones pendientes.');
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
