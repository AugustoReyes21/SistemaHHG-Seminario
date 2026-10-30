const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config.db);

pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Guatemala'").catch(() => {});
});

function getDb(db) {
  return db && typeof db.query === 'function' ? db : pool;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function query(text, params, db) {
  const target = getDb(db);
  return target.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function tableExists(db, name) {
  const res = await query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1',
    [name],
    db
  );
  return res.rowCount > 0;
}

async function columnExists(db, table, column) {
  const res = await query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1',
    [table, column],
    db
  );
  return res.rowCount > 0;
}

async function pickTable(db, candidates, fallback) {
  for (const name of candidates) {
    if (await tableExists(db, name)) {
      return name;
    }
  }
  return fallback;
}

async function pickColumn(db, table, candidates, fallback = null) {
  if (!candidates || candidates.length === 0) {
    return fallback;
  }
  if (!(await tableExists(db, table))) {
    return fallback;
  }
  const res = await query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2) LIMIT 1',
    [table, candidates],
    db
  );
  return res.rows[0]?.column_name || fallback;
}

async function getColumns(db, table) {
  const res = await query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    [table],
    db
  );
  return res.rows.map((row) => row.column_name);
}

async function insertRow(db, table, data) {
  const columns = Object.keys(data || {});
  if (columns.length === 0) {
    throw new Error('No data to insert');
  }
  const values = columns.map((key) => data[key]);
  const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(',');
  const sql =
    `INSERT INTO ${quoteIdent(table)} (` +
    columns.map(quoteIdent).join(',') +
    `) VALUES (${placeholders}) RETURNING id`;
  const res = await query(sql, values, db);
  const row = res.rows[0];
  return row ? Number(row.id) : null;
}

module.exports = {
  pool,
  query,
  withTransaction,
  tableExists,
  columnExists,
  pickTable,
  pickColumn,
  getColumns,
  insertRow,
  quoteIdent
};
