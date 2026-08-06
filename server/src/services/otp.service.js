const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 10;

// Genera un código OTP de 6 dígitos usando una fuente criptográficamente segura.
function generateCode() {
  // randomInt(0, 1000000) -> [0, 999999]; se rellena con ceros a 6 dígitos.
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

async function hashCode(code) {
  return bcrypt.hash(code, BCRYPT_COST);
}

// Comparación en TIEMPO CONSTANTE sobre los hashes bcrypt.
// bcryptjs.compare ya es de tiempo constante sobre el hash; además
// normalizamos los códigos y comparamos longitud para evitar abusos.
async function verifyCode(rawCode, storedHash) {
  if (typeof rawCode !== 'string' || typeof storedHash !== 'string') return false;
  const code = rawCode.trim();
  if (!/^\d{6}$/.test(code)) return false;
  return bcrypt.compare(code, storedHash);
}

// Invalida (marca como consumidos) todos los códigos activos previos del
// mismo email + propósito, garantizando single-active-code.
async function invalidatePreviousCodes(db, email, purpose = 'login') {
  await db.query(
    `UPDATE otp_codes
        SET consumed_at = now()
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
    [email, purpose]
  );
}

// Crea un OTP nuevo: invalida los anteriores y guarda el actual.
// Devuelve el código en claro SOLO para el driver de correo "log"/dev.
async function createOtp(db, email, { otpTtlMin = 10 } = {}) {
  await invalidatePreviousCodes(db, email);
  const code = generateCode();
  const codeHash = await hashCode(code);
  await db.query(
    `INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [email, codeHash, 'login', otpTtlMin]
  );
  return code;
}

// Busca el OTP activo más reciente (no consumido, no expirado) para un email.
async function findActiveOtp(db, email, purpose = 'login') {
  const result = await db.query(
    `SELECT id, code_hash, expires_at
       FROM otp_codes
      WHERE email = $1 AND purpose = $2
        AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [email, purpose]
  );
  return result.rows[0] || null;
}

// Consume el OTP de forma atómica: lo marca como consumido SOLO si sigue
// activo. Devuelve true si la operación fue exitosa (concurrencia segura).
async function consumeOtp(db, otpId) {
  const result = await db.query(
    `UPDATE otp_codes
        SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [otpId]
  );
  return result.rowCount > 0;
}

// --- login_attempts / lockout ------------------------------------------
const MAX_FAILED_ATTEMPTS = 5;
// Backoff exponencial por nivel de lockout (derivado de failed_count):
//   nivel 1 (>=5 fallos)  -> 5 min
//   nivel 2 (>=10 fallos) -> 15 min
//   nivel 3+ (>=15 fallos)-> 30 min (techo)
const LOCKOUT_MINUTES_BY_LEVEL = [5, 15, 30];

function lockoutMinutesFor(failedCount) {
  const level = Math.floor(failedCount / MAX_FAILED_ATTEMPTS);
  if (level <= 0) return 0;
  const idx = Math.min(level, LOCKOUT_MINUTES_BY_LEVEL.length) - 1;
  return LOCKOUT_MINUTES_BY_LEVEL[idx];
}

async function getLoginAttempts(db, email) {
  const result = await db.query(
    `SELECT failed_count, locked_until FROM login_attempts WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

async function resetLoginAttempts(db, email) {
  await db.query(
    `INSERT INTO login_attempts (email, failed_count)
     VALUES ($1, 0)
     ON CONFLICT (email) DO UPDATE SET failed_count = 0, locked_until = NULL`,
    [email]
  );
}

// Registra un fallo. Si supera MAX_FAILED_ATTEMPTS, activa lockout con
// duración de backoff exponencial según el número de fallos acumulados.
async function registerFailedAttempt(db, email) {
  const current = await getLoginAttempts(db, email);
  const nextCount = (current ? current.failed_count : 0) + 1;
  const lockoutMin = lockoutMinutesFor(nextCount);

  const result = await db.query(
    `INSERT INTO login_attempts (email, failed_count, last_attempt_at)
     VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE SET
       failed_count = login_attempts.failed_count + 1,
       last_attempt_at = now(),
       locked_until = CASE
         WHEN $2 >= $3 THEN now() + make_interval(mins => $4)
         ELSE login_attempts.locked_until
       END
     RETURNING failed_count, locked_until`,
    [email, nextCount, MAX_FAILED_ATTEMPTS, lockoutMin]
  );
  return result.rows[0];
}

// ¿El email está bloqueado por lockout activo?
async function isLockedOut(db, email) {
  const row = await getLoginAttempts(db, email);
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until) > new Date()) return true;
  return false;
}

// ¿El email puede intentar verificación en este momento?
// Devuelve true si no está lockeado por intentos o lockout.
async function canAttemptLogin(db, email) {
  const locked = await isLockedOut(db, email);
  return !locked;
}

module.exports = {
  generateCode,
  hashCode,
  verifyCode,
  createOtp,
  findActiveOtp,
  consumeOtp,
  invalidatePreviousCodes,
  getLoginAttempts,
  resetLoginAttempts,
  registerFailedAttempt,
  isLockedOut,
  canAttemptLogin,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES_BY_LEVEL,
  lockoutMinutesFor,
  BCRYPT_COST,
};
