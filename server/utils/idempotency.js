const crypto = require('crypto');

// Llave aceptada: 8 a 100 caracteres alfanuméricos, guion o guion bajo (UUID cabe).
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

function isValidKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * Serializa un valor JSON con las llaves ordenadas, para que
 * {a:1,b:2} y {b:2,a:1} produzcan el mismo hash.
 */
function canonicalize(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(canonicalize(body ?? {})).digest('hex');
}

module.exports = { KEY_PATTERN, isValidKey, canonicalize, hashRequest };
