const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

// Función auxiliar para inyectar un cliente DB mock en los tests.
// Se guarda en globalThis porque vitest puede crear instancias duplicadas
// del módulo (import ESM vs require CJS); así el override es compartido.
const OVERRIDE_KEY = '__corpHomepage_db_client_override__';

function setDbClient(client) {
  globalThis[OVERRIDE_KEY] = client;
  // Los tests cambian de FakeDb en cada caso; invalidamos la caché de settings
  // para que un test nunca lea el estado de otro.
  try {
    require('./services/settings.service').clearCache();
  } catch (err) {
    // settings.service aún no cargado: no pasa nada.
  }
}

function getClient() {
  if (globalThis[OVERRIDE_KEY]) return globalThis[OVERRIDE_KEY];
  return pool;
}

async function query(text, params) {
  const db = await getClient();
  return db.query(text, params);
}

// Al arrancar, ejecuta el esquema (CREATE TABLE IF NOT EXISTS) para
// garantizar que la base de datos quede lista.
async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const db = await getClient();
  await db.query(schema);
}

async function ping() {
  await query('SELECT 1');
}

// Ejecuta fn dentro de una transacción real (BEGIN/COMMIT/ROLLBACK) usando el
// pool. En tests (cliente DB mock, sin transacciones reales) invoca fn
// directamente sobre el cliente simulado para que el flujo sea equivalente.
async function withTransaction(fn) {
  const client = await getClient();
  if (client === pool) {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn(conn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackErr) {
        // Si el rollback también falla, el error original es el relevante.
      }
      throw err;
    } finally {
      conn.release();
    }
  }
  return fn(client);
}

module.exports = { pool, query, initSchema, setDbClient, getClient, ping, withTransaction };
