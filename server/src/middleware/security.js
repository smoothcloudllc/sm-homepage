const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { config } = require('../config');

const COOKIE_NAME = '_csrf';

// --- Helmet + CSP -------------------------------------------------------
// CSP: default-src 'self'; scripts y estilos solo desde archivos externos
// propios ('self'). Se permite 'unsafe-inline' en style-src ÚNICAMENTE para
// poder setear el color por app mediante style="--accent:..." en las tarjetas
// (requisito visual del dashboard); NO se permite ningún script inline.
// img-src permite https: y http: para que el navegador cargue icon_url de
// apps internas directamente (sin pasar por el servidor -> cero SSRF).
// Se incluye http: porque las apps internas tras el borde de la red interna /
// VPN se sirven por HTTP plano (entorno interno, no expuesto a Internet).
// NOTA: upgradeInsecureRequests desactivado por el mismo motivo (no forzar
// https a recursos internos http).
function applySecurity(app) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'http:'],
          fontSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.isProd ? { maxAge: 15552000 } : false,
    })
  );
}

// --- Rate limiters ------------------------------------------------------
function applyRateLimiters(app) {
  // Global: 100 req/min.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.' },
    })
  );

  // Específico para generación de OTP: 3 por email NORMALIZADO cada 5 min.
  // La clave une IP + email normalizado (trim + lowercase) para que rotar
  // mayúsculas/espacios NO cree buckets ilimitados (F-R1-2 anti email-bombing).
  const requestLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      `req:${req.ip}:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''}`,
    message: { error: 'Demasiadas solicitudes de código. Espera unos minutos.' },
  });

  // Límite adicional por IP pura para /auth/request (10 por 5 min) aunque el
  // email cambie: evita que un atacante rote muchos emails desde la misma IP.
  const requestIpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `reqip:${req.ip}`,
    message: { error: 'Demasiadas solicitudes desde tu dirección IP. Espera unos minutos.' },
  });

  // Específico para verificación de OTP: 5 por minuto por IP+email.
  // (El lockout de 5 fallos se gestiona también en otp.service).
  const verifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `verify:${req.ip}:${(req.body && req.body.email) || ''}`,
    message: { error: 'Demasiados intentos de verificación. Intenta de nuevo en un minuto.' },
  });

  app.set('otpRequestLimiter', requestLimiter);
  app.set('otpRequestIpLimiter', requestIpLimiter);
  app.set('otpVerifyLimiter', verifyLimiter);
}

function requestLimiter(req, res, next) {
  return req.app.get('otpRequestLimiter')(req, res, next);
}

function requestIpLimiter(req, res, next) {
  return req.app.get('otpRequestIpLimiter')(req, res, next);
}

function verifyLimiter(req, res, next) {
  return req.app.get('otpVerifyLimiter')(req, res, next);
}

// --- CSRF ---------------------------------------------------------------
// Token doble: cookie _csrf + campo oculto _csrf en cada formulario.
// Se valida en todos los POST/PUT/DELETE. Además del body se acepta el token
// en la query (?_csrf=) o en la cabecera X-CSRF-Token, necesario para las
// subidas multipart (/admin/settings/logo) donde multer parsea el body DESPUÉS
// de este middleware global.
function csrfProtection(req, res, next) {
  const method = req.method.toLowerCase();
  if (!['post', 'put', 'patch', 'delete'].includes(method)) return next();

  const cookieToken = req.cookies[COOKIE_NAME];
  const bodyToken = req.body && req.body._csrf;
  const queryToken = req.query && req.query._csrf;
  const headerToken = req.get('x-csrf-token');
  const submitted = bodyToken || queryToken || headerToken;

  const safeCompare = (a, b) => {
    if (!a || !b) return false;
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  };

  if (!safeCompare(cookieToken, submitted)) {
    return res.status(403).json({ error: 'Token CSRF inválido o ausente. Recarga la página e inténtalo de nuevo.' });
  }
  next();
}

// Firma el token CSRF en cookie y lo expone como res.locals.csrfToken
// para poder usarlo en las vistas EJS.
function csrfToken(req, res, next) {
  if (!req.cookies[COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
    });
    req.cookies[COOKIE_NAME] = token;
  }
  res.locals.csrfToken = req.cookies[COOKIE_NAME];
  next();
}

module.exports = { applySecurity, applyRateLimiters, csrfProtection, csrfToken, requestLimiter, requestIpLimiter, verifyLimiter };
