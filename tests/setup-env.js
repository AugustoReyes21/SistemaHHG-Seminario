// Se carga con --require antes de cualquier módulo del servidor.
// Fija la configuración de pruebas para que server/config.js nunca lea la base real.
const env = process.env;

env.NODE_ENV = 'test';
env.DB_HOST = env.TEST_DB_HOST || '127.0.0.1';
env.DB_PORT = env.TEST_DB_PORT || '5433';
env.DB_USER = env.TEST_DB_USER || 'postgres';
env.DB_PASSWORD = env.TEST_DB_PASSWORD || 'postgres';
env.DB_NAME = env.TEST_DB_NAME || 'hhg_test';
env.DB_SSL = 'false';
env.JWT_SECRET = 'test-jwt-secret';
env.SESSION_SECRET = 'test-session-secret';
env.FEL_ENABLED = 'false';
env.TZ = 'America/Guatemala';

// Protección: las pruebas hacen DROP SCHEMA; se niegan a correr contra otra base.
if (!/test/i.test(env.DB_NAME)) {
  throw new Error(`La base de pruebas debe contener "test" en su nombre (recibido: ${env.DB_NAME})`);
}
