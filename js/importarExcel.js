const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const xlsx = require('xlsx-js-style');
const { Pool } = require('pg');
const config = require('../server/config');

const pool = new Pool({
  ...config.db,
  password:
    config?.db?.password == null
      ? ''
      : typeof config.db.password === 'string'
        ? config.db.password
        : String(config.db.password)
});

const MONTHS = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  set: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  jan: 1,
  apr: 4,
  aug: 8,
  sept: 9,
  dec: 12
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function cleanString(value) {
  return String(value == null ? '' : value).trim();
}

function parseMoney(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value) : 0;
  const cleaned = String(value)
    .replace(/q/gi, '')
    .replace(/,/g, '')
    .trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function toIsoDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.toISOString().slice(0, 10);
}

function parseExpiry(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') {
    const excelEpoch = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return excelEpoch.toISOString().slice(0, 10);
  }
  if (typeof raw !== 'string') return null;

  const cleaned = raw.replace(' 00:00:00', '').trim().toLowerCase();

  let match = cleaned.match(/^([a-záéíóúñ]+)[\s\-\/]+(\d{2}|\d{4})$/i);
  if (match) {
    const monthKey = match[1].slice(0, 4);
    const month = MONTHS[monthKey.slice(0, 3)] || MONTHS[monthKey];
    if (month) {
      let year = Number(match[2]);
      if (year < 100) year += 2000;
      return toIsoDate(year, month, 1);
    }
  }

  match = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return toIsoDate(year, month, day);
    }
  }

  const date = new Date(cleaned);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function resolveExcelPath() {
  const provided = cleanString(process.argv[2] || '');
  if (provided) {
    return path.isAbsolute(provided) ? provided : path.resolve(process.cwd(), provided);
  }
  return path.join(__dirname, 'ARANCEL FARMACIA.xlsx');
}

function detectWorkbookType(data) {
  const headerIndex = data.findIndex((row) =>
    Array.isArray(row) &&
    row.some((cell) => normalizeText(cell).includes('nombre comercial'))
  );
  if (headerIndex >= 0) return { type: 'farmacia', headerIndex };

  const firstRows = data.slice(0, 5);
  const hasRayosTitle = firstRows.some((row) => normalizeText(row?.[1]).includes('rayos x'));
  const hasHilarioColumn = firstRows.some((row) => normalizeText(row?.[4]).includes('20% hilario galindo'));
  if (hasRayosTitle || hasHilarioColumn) return { type: 'rayos_x' };

  throw new Error('No se reconoció el formato del Excel');
}

function extractFarmaciaRows(data, headerIndex) {
  const headers = data[headerIndex] || [];
  const rows = data.slice(headerIndex + 1);
  const idx = {
    nombre: headers.findIndex((h) => normalizeText(h).includes('nombre comercial')),
    presentacion: headers.findIndex((h) => normalizeText(h).includes('present')),
    principio: headers.findIndex((h) => normalizeText(h).includes('principio')),
    casa: headers.findIndex((h) => normalizeText(h).includes('casa')),
    expira: headers.findIndex((h) => normalizeText(h).includes('expira')),
    costo: headers.findIndex((h) => normalizeText(h).includes('costo')),
    aprox: headers.findIndex((h) => normalizeText(h).includes('aprox')),
    publico: headers.findIndex(
      (h) => normalizeText(h).includes('publico') || normalizeText(h).includes('publico')
    )
  };

  console.log('Columnas detectadas para farmacia:', idx);

  return rows
    .map((row) => {
      const nombreComercial = cleanString(row[idx.nombre]);
      if (!nombreComercial) return null;
      return {
        nombre_comercial: nombreComercial,
        presentacion: cleanString(row[idx.presentacion]),
        principio_activo: cleanString(row[idx.principio]),
        casa: cleanString(row[idx.casa]),
        expira: parseExpiry(row[idx.expira]),
        precio_costo: parseMoney(row[idx.costo]),
        precio_aprox: parseMoney(row[idx.aprox]),
        precio_publico: parseMoney(row[idx.publico]),
        stock: 0
      };
    })
    .filter(Boolean);
}

function extractRayosXRows(data) {
  const category =
    cleanString(data.find((row) => normalizeText(row?.[1]).includes('rayos x'))?.[1]) || 'Rayos X';
  const rows = [];
  for (const row of data) {
    const code = cleanString(row?.[0]).toUpperCase();
    const name = cleanString(row?.[1]);
    const publicPrice = parseMoney(row?.[4]);
    if (!code || !name || publicPrice <= 0) continue;
    if (!/[A-Z]/i.test(code) || !/\d/.test(code)) continue;
    rows.push({
      codigo_barra: code,
      nombre_comercial: name,
      categoria_servicio: category,
      precio_publico: publicPrice
    });
  }
  if (!rows.length) {
    throw new Error('No se encontraron servicios válidos en el Excel de Rayos X');
  }
  return rows;
}

async function ensureImportColumns(client) {
  await client.query("ALTER TABLE productos ADD COLUMN IF NOT EXISTS codigo_barra VARCHAR(100)");
  await client.query("ALTER TABLE productos ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'medicamento'");
  await client.query("ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE");
  await client.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidades_por_tableta INTEGER DEFAULT 1');
  await client.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS tabletas_por_caja INTEGER DEFAULT 1');
  await client.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_unidad NUMERIC(12,2)');
  await client.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_tableta NUMERIC(12,2)');
  await client.query(
    "UPDATE productos SET tipo = 'medicamento' WHERE tipo IS NULL OR TRIM(COALESCE(tipo, '')) = ''"
  );
  await client.query('UPDATE productos SET activo = TRUE WHERE activo IS NULL');
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_productos_codigo_barra ON productos(codigo_barra)'
  );
}

async function upsertFarmaciaRow(client, row) {
  const existing = await client.query(
    'SELECT id FROM productos WHERE nombre_comercial = $1 LIMIT 1',
    [row.nombre_comercial]
  );

  if (existing.rows[0]) {
    await client.query(
      `UPDATE productos
         SET tipo = 'medicamento',
             presentacion = $1,
             principio_activo = $2,
             casa = $3,
             expira = $4,
             stock = $5,
             precio_costo = $6,
             precio_aprox = $7,
             precio_publico = $8,
             unidades_por_tableta = 1,
             tabletas_por_caja = 1,
             precio_unidad = COALESCE(NULLIF(precio_unidad, 0), $8),
             precio_tableta = COALESCE(NULLIF(precio_tableta, 0), $8),
             activo = TRUE
       WHERE id = $9`,
      [
        row.presentacion || '',
        row.principio_activo || '',
        row.casa || '',
        row.expira,
        row.stock || 0,
        row.precio_costo || 0,
        row.precio_aprox || 0,
        row.precio_publico || 0,
        existing.rows[0].id
      ]
    );
    return 'updated';
  }

  await client.query(
    `INSERT INTO productos (
      nombre_comercial,
      tipo,
      presentacion,
      principio_activo,
      casa,
      expira,
      stock,
      precio_costo,
      precio_aprox,
      precio_publico,
      unidades_por_tableta,
      tabletas_por_caja,
      precio_unidad,
      precio_tableta,
      activo
    ) VALUES ($1,'medicamento',$2,$3,$4,$5,$6,$7,$8,$9,1,1,$9,$9,TRUE)`,
    [
      row.nombre_comercial,
      row.presentacion || '',
      row.principio_activo || '',
      row.casa || '',
      row.expira,
      row.stock || 0,
      row.precio_costo || 0,
      row.precio_aprox || 0,
      row.precio_publico || 0
    ]
  );
  return 'inserted';
}

async function upsertRayosXRow(client, row) {
  const existing = await client.query(
    `SELECT id
       FROM productos
      WHERE LOWER(TRIM(COALESCE(codigo_barra, ''))) = LOWER(TRIM($1))
         OR (tipo = 'servicio' AND LOWER(TRIM(nombre_comercial)) = LOWER(TRIM($2)))
      ORDER BY CASE WHEN LOWER(TRIM(COALESCE(codigo_barra, ''))) = LOWER(TRIM($1)) THEN 0 ELSE 1 END
      LIMIT 1`,
    [row.codigo_barra, row.nombre_comercial]
  );

  const values = [
    row.nombre_comercial,
    row.codigo_barra,
    row.categoria_servicio || 'Rayos X',
    row.precio_publico || 0
  ];

  if (existing.rows[0]) {
    await client.query(
      `UPDATE productos
         SET nombre_comercial = $1,
             codigo_barra = $2,
             tipo = 'servicio',
             presentacion = 'Servicio',
             principio_activo = '',
             casa = $3,
             expira = NULL,
             stock = 0,
             precio_costo = 0,
             precio_aprox = 0,
             precio_publico = $4,
             unidades_por_tableta = 1,
             tabletas_por_caja = 1,
             precio_unidad = $4,
             precio_tableta = $4,
             activo = TRUE
       WHERE id = $5`,
      [...values, existing.rows[0].id]
    );
    return 'updated';
  }

  await client.query(
    `INSERT INTO productos (
      nombre_comercial,
      codigo_barra,
      tipo,
      presentacion,
      principio_activo,
      casa,
      expira,
      stock,
      precio_costo,
      precio_aprox,
      precio_publico,
      unidades_por_tableta,
      tabletas_por_caja,
      precio_unidad,
      precio_tableta,
      activo
    ) VALUES ($1,$2,'servicio','Servicio','',$3,NULL,0,0,0,$4,1,1,$4,$4,TRUE)`,
    values
  );
  return 'inserted';
}

(async () => {
  let client;
  try {
    const excelPath = resolveExcelPath();
    if (!fs.existsSync(excelPath)) {
      throw new Error(`No se encontró el archivo Excel: ${excelPath}`);
    }

    console.log(`Leyendo archivo: ${excelPath}`);
    const workbook = xlsx.readFile(excelPath, { cellDates: true, cellNF: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

    const detected = detectWorkbookType(data);
    const rows =
      detected.type === 'farmacia'
        ? extractFarmaciaRows(data, detected.headerIndex)
        : extractRayosXRows(data);
    if (!rows.length) {
      throw new Error('No hay filas válidas para importar');
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await ensureImportColumns(client);

    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      const action =
        detected.type === 'farmacia'
          ? await upsertFarmaciaRow(client, row)
          : await upsertRayosXRow(client, row);
      if (action === 'inserted') inserted += 1;
      else updated += 1;
    }

    await client.query('COMMIT');
    console.log(
      `Importación completada (${detected.type}). Insertados: ${inserted}. Actualizados: ${updated}. Total procesados: ${rows.length}`
    );
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error al importar Excel:', err.message || err);
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        client.release();
      } catch (_) {}
    }
    try {
      await pool.end();
    } catch (_) {}
  }
})();
