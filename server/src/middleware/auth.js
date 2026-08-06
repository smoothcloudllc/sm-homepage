const db = require('../db');
const { config } = require('../config');
const sessionService = require('../services/session.service');

// Resuelve la sesión a partir de la cookie. Aplica rotación deslizante (F5):
// si la sesión supera sessionRotateDays de antigüedad, emite una Set-Cookie
// con el token nuevo y lo deja en req.token.
async function resolveSession(req, res) {
  const token = req.cookies[sessionService.COOKIE_NAME];
  const session = await sessionService.validateSession(db, token, {
    rotateAfterMs: config.sessionRotateDays * 86400 * 1000,
  });
  if (!session) return null;

  if (session.rotated && session.newToken) {
    res.cookie(
      sessionService.COOKIE_NAME,
      session.newToken,
      sessionService.cookieOptions(config, Math.max(1, Math.floor(session.remainingMs / 1000)))
    );
    req.token = session.newToken;
  } else {
    req.token = token;
  }
  req.sessionId = session.sessionId;
  req.user = session.user;
  return session;
}

// Middleware de autenticación: lee cookie sid -> hash -> sesión válida ->
// usuario activo -> session_version coincide. Si falla -> redirect a /login
// (usado por las rutas /admin/*; el dashboard público ya no exige sesión).
async function requireAuth(req, res, next) {
  try {
    const session = await resolveSession(req, res);
    if (!session) {
      // req.originalUrl conserva la ruta completa aunque el router esté
      // montado bajo /admin (dentro del router req.path está "desmontado").
      if (req.originalUrl.startsWith('/admin')) {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'No autorizado' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware opcional: si hay sesión válida la adjunta a req.user.
// Se usa en /login para redirigir a usuarios ya autenticados.
async function attachUserIfAny(req, res, next) {
  try {
    await resolveSession(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, attachUserIfAny };
