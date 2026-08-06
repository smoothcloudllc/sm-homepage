const { config } = require('./config');
const db = require('./db');
const { initSchema, ping, query } = db;
const bootstrapService = require('./services/bootstrap.service');
const settingsService = require('./services/settings.service');
const categoriesService = require('./services/categories.service');

// Purga diaria de datos obsoletos (F13): otp_codes expirados/consumidos,
// login_attempts viejos (>7 días) y sesiones revocadas/expiradas (>7 días).
const PURGE_RETENTION_DAYS = '7';
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function purgeExpiredData() {
  await query(
    `DELETE FROM otp_codes
      WHERE consumed_at IS NOT NULL
         OR expires_at < now() - ($1 || ' days')::interval`,
    [PURGE_RETENTION_DAYS]
  );
  await query(
    `DELETE FROM login_attempts
      WHERE last_attempt_at IS NOT NULL
        AND last_attempt_at < now() - ($1 || ' days')::interval`,
    [PURGE_RETENTION_DAYS]
  );
  await query(
    `DELETE FROM sessions
      WHERE (revoked_at IS NOT NULL
             AND revoked_at < now() - ($1 || ' days')::interval)
         OR expires_at < now() - ($1 || ' days')::interval`,
    [PURGE_RETENTION_DAYS]
  );
}

async function main() {
  // 1) Asegurar esquema.
  await initSchema();

  // 2) Verificar conectividad.
  await ping();
  console.log(`[db] Conexión a PostgreSQL correcta.`);

  // 3) Sembrar settings desde env (solo si la tabla está vacía) y el usuario
  //    inicial (idempotente, solo si la tabla users está vacía).
  await settingsService.seedDefaults();
  console.log('[settings] Defaults sembrados desde env (si la tabla estaba vacía).');
  await settingsService.seedInitialUser();
  console.log('[seed] Usuario inicial revisado (super_admin idempotente).');

  // Categorías: seed idempotente + migración/backfill de apps.category ->
  // category_id (idempotente y segura; SOLO actúa si hay apps con category_id
  // NULL). El inventario se reporta en los logs (dry-run).
  const seededCats = await categoriesService.seedCategories(db);
  console.log(`[categories] Seed revisado (${seededCats.length > 0 ? 'creadas: ' + seededCats.join(', ') : 'sin cambios, ya existían'}).`);
  await categoriesService.backfillCategories(db);
  console.log('[categories] Backfill de apps.category -> category_id completado (0 NULLs pendientes).');

  // F-R5-1 (fail-fast): si allowed_domains EFECTIVO (BD con precedencia) excluye
  // el dominio del SUPER_ADMIN_EMAIL, el primer login del admin fallaría siempre
  // de forma silenciosa (lockout). Mejor no arrancar y dar instrucciones claras.
  const superAdminDomain = config.superAdminEmail ? (config.superAdminEmail.split('@')[1] || '').toLowerCase() : '';
  if (superAdminDomain) {
    const effectiveDomains = await settingsService.getAllowedDomains();
    if (!effectiveDomains.includes(superAdminDomain)) {
      throw new Error(
        `F-R5-1: el dominio del SUPER_ADMIN_EMAIL (${config.superAdminEmail}) NO está en allowed_domains efectivo ` +
          `(${effectiveDomains.length > 0 ? effectiveDomains.join(', ') : '(vacío)'}). ` +
          'Corrige settings.allowed_domains en la BD (tabla settings) o ALLOWED_EMAIL_DOMAINS/ALLOWED_DOMAINS ' +
          'en el entorno para incluir ese dominio; en una BD vacía la app lo siembra automáticamente desde env. ' +
          'Sin esto, el administrador no podría iniciar sesión nunca (lockout).'
      );
    }
  }

  // 4) Sembrar token de bootstrap del super_admin (single-use) si aplica.
  if (config.bootstrapToken) {
    await bootstrapService.seedBootstrapToken(db, config.bootstrapToken);
    console.log(`[bootstrap] Token de bootstrap registrado (single-use) para ${config.superAdminEmail}.`);
  }
  // BOOTSTRAP_CODE (6 dígitos): misma siembra idempotente single-use. La
  // función es genérica (hash SHA-256 + INSERT ON CONFLICT DO NOTHING), así
  // que sirve igual para el token hex y para el código numérico.
  if (config.bootstrapCode) {
    await bootstrapService.seedBootstrapToken(db, config.bootstrapCode);
    console.log(`[bootstrap] Código de bootstrap registrado (single-use) para ${config.superAdminEmail}.`);
  }

  // 5) Arrancar servidor.
  const { createApp } = require('./app');
  const app = createApp();

  app.listen(config.port, () => {
    console.log(`[server] SM-HomePage escuchando en http://localhost:${config.port} (${config.nodeEnv})`);
  });

  // 6) Purga diaria de datos obsoletos (F13).
  const runPurge = () => purgeExpiredData().catch((err) => {
    console.error('[purge] error:', err.message);
  });
  runPurge();
  setInterval(runPurge, PURGE_INTERVAL_MS);
}

main().catch((err) => {
  console.error('[fatal] No se pudo iniciar la aplicación:', err.stack || err.message);
  process.exit(1);
});
