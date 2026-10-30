function safeJson(res, data, code = 200) {
  res.status(code).json(data);
}

function readJson(req) {
  if (!req || req.body == null) {
    return {};
  }
  if (typeof req.body === 'object') {
    return req.body;
  }
  try {
    const parsed = JSON.parse(req.body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function slugRole(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return raw.replace(/[\s_-]+/g, '');
}

function canonRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  const map = {
    admin: 'admin',
    administrador: 'admin',
    cashier: 'cashier',
    cajero: 'cashier',
    caja: 'cashier',
    cajera: 'cashier',
    cahier: 'cashier',
    cashierh: 'cashierh',
    hospital: 'cashierh',
    cashiee: 'cashiee',
    cashiere: 'cashiee',
    emergencia: 'cashiee',
    'emergencia (cashiee)': 'cashiee',
    contabilidad: 'contabilidad',
    accounting: 'contabilidad',
    farmacia: 'farmacia',
    recepcion: 'recepcion',
    'recepcion': 'recepcion',
    'recepcion': 'recepcion',
    preconsulta: 'preconsulta',
    'pre-consulta': 'preconsulta',
    direccionmedica: 'direccionmedica',
    'direccion medica': 'direccionmedica',
    'direccion_medica': 'direccionmedica',
    consultorio2: 'consultorio2',
    'consultorio 2': 'consultorio2',
    consultorio3: 'consultorio3',
    'consultorio 3': 'consultorio3',
    enfermeria: 'enfermeria',
    'enfermería': 'enfermeria',
    medico: 'medico',
    medicos: 'medico',
    'médicos': 'medico',
    secretaria: 'secretaria',
    superadmin: 'superadmin',
    'super admin': 'superadmin',
    superusuario: 'superadmin',
    user: 'user',
    usuario: 'user'
  };
  if (map[raw]) {
    return map[raw];
  }
  const slug = slugRole(raw);
  const slugMap = {
    admin: 'admin',
    administrador: 'admin',
    cashier: 'cashier',
    cajero: 'cashier',
    caja: 'cashier',
    cajera: 'cashier',
    cahier: 'cashier',
    cashierh: 'cashierh',
    hospital: 'cashierh',
    cashiee: 'cashiee',
    cashiere: 'cashiee',
    emergencia: 'cashiee',
    contabilidad: 'contabilidad',
    accounting: 'contabilidad',
    recepcion: 'recepcion',
    preconsulta: 'preconsulta',
    direccionmedica: 'direccionmedica',
    consultorio2: 'consultorio2',
    consultorio3: 'consultorio3',
    farmacia: 'farmacia',
    enfermeria: 'enfermeria',
    medico: 'medico',
    medicos: 'medico',
    secretaria: 'secretaria',
    superadmin: 'superadmin',
    superusuario: 'superadmin',
    user: 'user',
    usuario: 'user'
  };
  return slugMap[slug] || (raw || 'user');
}

function safeNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,Q\s]/g, '');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBoolean(value) {
  if (value === true || value === false) return value;
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  return null;
}

function buildUpdate(fields, data, allow) {
  const keys = allow || Object.keys(data || {});
  const set = [];
  const values = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      set.push(`${key} = $${values.length + 1}`);
      values.push(data[key]);
    }
  }
  return { set, values };
}

module.exports = {
  safeJson,
  readJson,
  slugRole,
  canonRole,
  safeNumber,
  parseBoolean,
  buildUpdate
};
