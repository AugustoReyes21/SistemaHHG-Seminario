// Pruebas unitarias (sin base de datos) de las funciones puras de idempotencia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidKey, canonicalize, hashRequest } = require('../../server/utils/idempotency');

test('acepta UUID y llaves alfanuméricas de 8 a 100 caracteres', () => {
  assert.ok(isValidKey('3f2b8c1e-9a4d-4e7b-8f00-1c2d3e4f5a6b'));
  assert.ok(isValidKey('k-0123456789abcdef'));
  assert.ok(isValidKey('a'.repeat(8)));
  assert.ok(isValidKey('a'.repeat(100)));
});

test('rechaza llaves vacías, cortas, largas o con caracteres no permitidos', () => {
  for (const bad of [undefined, null, '', 'corta', 'a'.repeat(101), 'con espacio', 'ñandú-12345', 'a/b/c/d/e/f', 12345678]) {
    assert.equal(isValidKey(bad), false, `debería rechazar ${String(bad)}`);
  }
});

test('canonicalize ordena llaves en todos los niveles', () => {
  const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
  const b = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
});

test('canonicalize ignora propiedades undefined pero conserva null', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
  assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
});

test('hashRequest: mismo contenido -> mismo hash; cualquier cambio -> hash distinto', () => {
  const body = { items: [{ producto_id: 1, cantidad: 2 }], total: 20 };
  const same = { total: 20, items: [{ cantidad: 2, producto_id: 1 }] };
  const changed = { items: [{ producto_id: 1, cantidad: 3 }], total: 20 };
  assert.equal(hashRequest(body), hashRequest(same));
  assert.notEqual(hashRequest(body), hashRequest(changed));
  assert.match(hashRequest(body), /^[0-9a-f]{64}$/);
});

test('el orden de los ítems sí importa (es otra venta)', () => {
  const a = { items: [{ producto_id: 1 }, { producto_id: 2 }] };
  const b = { items: [{ producto_id: 2 }, { producto_id: 1 }] };
  assert.notEqual(hashRequest(a), hashRequest(b));
});
