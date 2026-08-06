const crypto = require('crypto');

// Hash del token (SHA-256) para almacenamiento server-side.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Registra el token de bootstrap (single-use) si no existe aún.
// Se invoca al arrancar el servidor (idempotente).
async function seedBootstrapToken(db, token) {
  if (!token) return;
  await db.query(
    `INSERT INTO bootstrap_tokens (token_hash) VALUES ($1)
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashToken(token)]
  );
}

// Consume el token de bootstrap de forma atómica (DELETE condicional).
// Devuelve true solo si existía un token con ese hash sin usar.
async function consumeBootstrapToken(db, token) {
  if (!token) return false;
  const result = await db.query(
    `DELETE FROM bootstrap_tokens WHERE token_hash = $1 RETURNING token_hash`,
    [hashToken(token)]
  );
  return result.rowCount > 0;
}

module.exports = { hashToken, seedBootstrapToken, consumeBootstrapToken };
