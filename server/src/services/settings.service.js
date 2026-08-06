// Servicio de configuración en runtime (tabla settings key/value).
//
// Precedencia: BD > env. getSetting/getAllowedDomains resuelven el valor
// EFECTIVO: si la BD no tiene la clave, se usa el fallback de env.
// Los cambios se aplican en runtime sin reiniciar (caché de lectura 30 s).
// NUNCA se guardan secretos aquí (solo personalización).

const db = require('../db');
const { config } = require('../config');
const audit = require('./audit.service');

const CACHE_TTL_MS = 30 * 1000;

let cache = null;
let cacheAt = 0;

// Valores por defecto procedentes de env. La BD, si tiene la clave, gana.
function envDefaults() {
  return {
    allowed_domains: process.env.ALLOWED_EMAIL_DOMAINS || process.env.ALLOWED_DOMAINS || '',
    site_name: process.env.SITE_NAME || 'SM-HomePage',
    mail_from: process.env.MAIL_FROM || '',
    default_theme: process.env.DEFAULT_THEME || 'system',
    logo_version: '0',
  };
}

// Normaliza una lista de dominios (textarea: un dominio por línea o comas;
// también se toleran comas). Minúsculas, sin espacios, sin @.
function normalizeDomains(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/[\n,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@+/, ''))
    .filter(Boolean);
}

function clearCache() {
  cache = null;
  cacheAt = 0;
}

// Devuelve el mapa completo de settings (BD fusionada sobre env) con caché.
// En tests (cliente DB mock) se salta la caché para que cada caso lea su
// propio estado; en producción se cachea 30 s para no golpear la BD.
async function getAll() {
  const now = Date.now();
  const isRealPool = db.getClient() === db.pool;
  if (isRealPool && cache && now - cacheAt < CACHE_TTL_MS) return cache;
  let rows = [];
  try {
    const result = await db.query('SELECT key, value FROM settings');
    rows = result.rows || [];
  } catch (err) {
    // Fallback anti-lockout: si la tabla/consulta falla, seguimos con env.
    rows = [];
  }
  const merged = { ...envDefaults() };
  for (const row of rows) {
    if (row && row.key != null) merged[row.key] = row.value;
  }
  if (isRealPool) {
    cache = merged;
    cacheAt = now;
  }
  return merged;
}

// Lee una clave concreta. Si la BD no la tiene, devuelve el fallback de env
// (o '' si no hay fallback definido).
async function getSetting(key) {
  const all = await getAll();
  return all[key] !== undefined && all[key] !== null ? String(all[key]) : '';
}

// Dominios permitidos EFECTIVOS: BD (settings.allowed_domains) si no está
// vacío; si no, env ALLOWED_EMAIL_DOMAINS || ALLOWED_DOMAINS. Normalizado.
// En development, si el resultado queda vacío se permite 'localhost'
// (mismo comportamiento que config.js para no romper las pruebas locales).
async function getAllowedDomains() {
  const all = await getAll();
  let domains = normalizeDomains(all.allowed_domains);
  if (domains.length === 0 && config.nodeEnv === 'development') {
    domains.push('localhost');
  }
  return domains;
}

// Upsert + invalidación de caché + auditoría (settings.update con before/after).
async function setSetting(key, value, actorId) {
  const before = await getSetting(key);
  const safeValue = typeof value === 'string' ? value.trim() : String(value == null ? '' : value);
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [key, safeValue, actorId || null]
  );
  clearCache();
  await audit.logAudit(db, {
    actorId: actorId || null,
    action: 'settings.update',
    entityType: 'setting',
    entityId: key,
    details: { key, before: before || null, after: safeValue },
  });
  return safeValue;
}

// Siembra los defaults desde env SOLO si la tabla está vacía. Nunca
// sobrescribe valores existentes. Asegura que el dominio del SUPER_ADMIN_EMAIL
// quede en allowed_domains si no hay ningún dominio configurado.
async function seedDefaults() {
  const countResult = await db.query('SELECT count(*)::int AS total FROM settings');
  if (countResult.rows[0].total > 0) return;

  const envAllowed = process.env.ALLOWED_EMAIL_DOMAINS || process.env.ALLOWED_DOMAINS || '';
  let allowed = String(envAllowed).trim();
  if (!allowed && config.superAdminEmail) {
    allowed = (config.superAdminEmail.split('@')[1] || '').toLowerCase();
  }

  const defaults = [
    ['allowed_domains', allowed],
    ['site_name', process.env.SITE_NAME || 'SM-HomePage'],
    ['mail_from', process.env.MAIL_FROM || ''],
    ['default_theme', process.env.DEFAULT_THEME || 'system'],
  ];
  for (const [key, value] of defaults) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
  clearCache();

  await audit.logAudit(db, {
    action: 'settings.seed',
    entityType: 'setting',
    details: { keys: defaults.map(([k]) => k) },
  });
}

// Usuario inicial idempotente. SOLO si la tabla users está VACÍA y
// SUPER_ADMIN_EMAIL está definido se crea ese usuario con rol super_admin.
// Si la BD ya tiene usuarios, NUNCA se auto-crea un super_admin.
// ON CONFLICT DO NOTHING: nunca modifica roles existentes.
async function seedInitialUser() {
  if (!config.superAdminEmail) return;

  const countResult = await db.query('SELECT count(*)::int AS total FROM users');
  if (countResult.rows[0].total > 0) return;

  const email = config.superAdminEmail;
  const created = await db.query(
    `INSERT INTO users (email, display_name, role, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, email.split('@')[0], 'super_admin']
  );
  if (created.rows[0]) {
    await audit.logAudit(db, {
      action: 'user.create',
      entityType: 'user',
      entityId: created.rows[0].id,
      details: { email, role: 'super_admin', origin: 'seed' },
    });
  }
}

module.exports = {
  getAll,
  getSetting,
  getAllowedDomains,
  normalizeDomains,
  setSetting,
  seedDefaults,
  seedInitialUser,
  clearCache,
};
