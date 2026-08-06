const crypto = require('crypto');

const COOKIE_NAME = 'sid';

// Genera un token opaco de sesión (32 bytes -> hex de 64 caracteres).
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash del token (SHA-256) para almacenamiento server-side.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Crea una sesión en la tabla "sessions".
// "sessionVersion" es la copia de user.session_version al momento del login;
// si el usuario cambia su session_version (revocación global) esta sesión se
// invalida al comparar con el valor actual del usuario.
async function createSession(db, userId, sessionVersion, { ip, userAgent, sessionDays }) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, session_version_enrolled, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5::inet, $6)`,
    [userId, tokenHash, sessionVersion, sessionDays, ip || null, userAgent || null]
  );
  return token;
}

// Valida un token opaco: debe existir, no estar revocado, no estar expirado,
// y su session_version_enrolled debe coincidir con la del usuario actual.
// Devuelve la fila de sesión unida al usuario (o null si no es válida).
//
// Rotación deslizante (F5): si se pasa rotateAfterMs y la sesión tiene más
// antigüedad que ese umbral, se genera un token nuevo (misma expiración),
// se revoca el anterior y se devuelve en session.newToken para que el
// middleware emita una Set-Cookie nueva.
async function validateSession(db, token, { rotateAfterMs = 0 } = {}) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await db.query(
    `SELECT s.id AS session_id,
            s.user_id,
            s.session_version_enrolled,
            s.expires_at,
            s.created_at,
            s.revoked_at,
            u.email,
            u.display_name,
            u.role,
            u.status,
            u.session_version
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;

  const now = new Date();
  if (new Date(row.expires_at) <= now) return null;
  if (row.status !== 'active') return null;
  if (row.session_version !== row.session_version_enrolled) return null;

  const session = {
    sessionId: row.session_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    rotated: false,
    newToken: null,
    remainingMs: Math.max(0, new Date(row.expires_at).getTime() - now.getTime()),
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      sessionVersion: row.session_version,
    },
  };

  if (rotateAfterMs > 0 && row.created_at) {
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    if (ageMs > rotateAfterMs) {
      const rotated = await rotateSession(db, row.session_id, row.user_id, row.session_version_enrolled, row.expires_at);
      if (rotated) {
        session.rotated = true;
        session.newToken = rotated.token;
        session.sessionId = rotated.sessionId;
        session.expiresAt = rotated.expiresAt;
        session.remainingMs = Math.max(0, new Date(rotated.expiresAt).getTime() - now.getTime());
      }
    }
  }

  return session;
}

// Rota una sesión antigua: inserta una nueva fila (misma expiración y datos
// de origen, created_at = now() para reiniciar la ventana deslizante) y
// revoca la anterior. Devuelve el token nuevo o null.
async function rotateSession(db, oldSessionId, userId, sessionVersion, expiresAt) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const inserted = await db.query(
    `INSERT INTO sessions (user_id, token_hash, session_version_enrolled, expires_at, created_at, ip, user_agent)
     SELECT user_id, $2, session_version_enrolled, expires_at, now(), ip, user_agent
       FROM sessions
      WHERE id = $1
      RETURNING id`,
    [oldSessionId, tokenHash]
  );
  if (inserted.rowCount === 0) return null;
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [oldSessionId]
  );
  return { token, sessionId: inserted.rows[0].id, expiresAt };
}

// Revoca una sesión concreta (logout) marcando revoked_at.
async function revokeSession(db, token) {
  const tokenHash = hashToken(token);
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

// Revoca TODAS las sesiones de un usuario (al desactivar / cambiar rol).
async function revokeAllUserSessions(db, userId) {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

// Incrementa session_version del usuario (invalida todas sus sesiones activas).
async function bumpSessionVersion(db, userId) {
  const result = await db.query(
    `UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version`,
    [userId]
  );
  return result.rows[0] ? result.rows[0].session_version : null;
}

function cookieOptions(config, maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: maxAgeSeconds * 1000,
    path: '/',
  };
}

module.exports = {
  COOKIE_NAME,
  generateToken,
  hashToken,
  createSession,
  validateSession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
  bumpSessionVersion,
  cookieOptions,
};
