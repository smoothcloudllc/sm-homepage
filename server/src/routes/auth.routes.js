const express = require('express');
const db = require('../db');
const { config } = require('../config');
const otpService = require('../services/otp.service');
const sessionService = require('../services/session.service');
const bootstrapService = require('../services/bootstrap.service');
const mailService = require('../services/mail.service');
const settingsService = require('../services/settings.service');
const audit = require('../services/audit.service');
const { requestLimiter, requestIpLimiter, verifyLimiter } = require('../middleware/security');
const { attachUserIfAny } = require('../middleware/auth');

const router = express.Router();

// --- Protección contra open redirect (F23) ------------------------------
// `next` solo puede ser una ruta LOCAL del portal:
//   - debe empezar por '/'
//   - se rechazan '//host' (protocol-relative) y '\\' (prefijos tipo
//     backslash que algunos navegadores tratan como URL externa)
//   - se rechazan saltos de línea (header/CRLF injection en Location)
// Cualquier otra cosa cae al fallback '/' (dashboard).
function isSafeLocalPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (/[\\\r\n]/.test(value)) return false;
  return true;
}

function safeNextPath(value) {
  return isSafeLocalPath(value) ? value : '/';
}

// Dominio permitido EFECTIVO: consulta settings.service (BD con precedencia
// sobre env), de modo que un cambio de allowed_domains en /admin/settings
// aplica en runtime sin reiniciar. Cache interno de 30 s.
async function isDomainAllowed(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const allowed = await settingsService.getAllowedDomains();
  return allowed.includes(domain);
}

// --- Regla de rol JIT al crear un usuario vía login --------------------
// La ÚNICA vía de bootstrap del super_admin es email == SUPER_ADMIN_EMAIL.
// Ya NO existe "primer usuario de la tabla" ni "ningún super_admin ->
// autopromoción": un usuario sin SUPER_ADMIN_EMAIL siempre nace employee.
async function resolveRoleForNewUser(email) {
  if (config.superAdminEmail && email === config.superAdminEmail) return 'super_admin';
  return 'employee';
}

// Busca al usuario por email; si no existe lo crea (JIT) con la regla de rol.
// Devuelve { user, created }.
async function findOrCreateUser(dbClient, email) {
  const existing = await dbClient.query(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  );
  if (existing.rows.length > 0) {
    return { user: existing.rows[0], created: false };
  }

  const role = await resolveRoleForNewUser(email);
  const created = await dbClient.query(
    `INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email, email.split('@')[0], role]
  );
  return { user: created.rows[0], created: true };
}

// GET /login
router.get('/login', attachUserIfAny, (req, res) => {
  const next = safeNextPath(req.query.next);
  if (req.user) return res.redirect(next);
  const errorMap = {
    invalid: 'Credenciales inválidas. Intenta de nuevo.',
    locked: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo.',
    inactive: 'No puedes iniciar sesión. Contacta con el administrador.',
  };
  const error = req.query.error ? (errorMap[req.query.error] || 'No se pudo iniciar sesión.') : null;
  const info = req.query.sent === '1' ? 'Si el correo existe, se envió un código.' : null;
  // F-R5-3: si hay una credencial de arranque configurada (BOOTSTRAP_TOKEN hex
  // o BOOTSTRAP_CODE de 6 dígitos) y el email del query coincide con
  // SUPER_ADMIN_EMAIL, la vista muestra UN INPUT VISIBLE (bootstrap_token o
  // bootstrap_code) para que el primer login del admin funcione también en
  // producción (sin depender del dev_code de la API).
  const submittedEmail = (req.query.email || '').trim().toLowerCase();
  const isSuperAdminEmail = submittedEmail === (config.superAdminEmail || '').toLowerCase();
  const bootstrapActive = !!(config.bootstrapToken || config.bootstrapCode);
  const needsBootstrap = bootstrapActive && isSuperAdminEmail;
  // bootstrapMode para la vista: 'code' (BOOTSTRAP_CODE de 6 dígitos, prioridad)
  // si está definido, 'token' (BOOTSTRAP_TOKEN hex, retrocompat) en caso
  // contrario, y null si no hay ninguna credencial de arranque configurada.
  const bootstrapMode = config.bootstrapCode ? 'code' : config.bootstrapToken ? 'token' : null;
  // La página de login contiene el token CSRF y campos de sesión: no cachear.
  res.set('Cache-Control', 'no-store');
  res.renderPage('auth/login', {
    title: 'Iniciar sesión',
    user: null,
    error,
    info,
    next,
    needsBootstrap,
    bootstrapMode,
    submittedEmail: req.query.email || '',
  });
});

// POST /auth/request — solicita un código OTP por email.
// Doble rate limit: por email normalizado (3/5min) + por IP pura (10/5min).
router.post('/auth/request', requestLimiter, requestIpLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body.email;
    if (typeof rawEmail !== 'string') {
      // Entrada malformada (p. ej. email=a&email=b con extended:true) -> 400,
      // nunca un TypeError/500 (F-R1-3).
      return res.status(400).json({ error: 'Formato de email inválido.' });
    }
    const email = rawEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Formato de email inválido.' });
    }
    if (!(await isDomainAllowed(email))) {
      // Anti-enumeración TOTAL: misma respuesta 200 genérica que un dominio
      // permitido. El código SOLO se genera server-side para dominios
      // permitidos (validación de fondo inalterada).
      await audit.logAudit(db, {
        action: 'otp.denied',
        entityType: 'user',
        entityId: email,
        details: { email, reason: 'domain_not_allowed' },
        ip: req.ip,
      });
      return res.json({ message: 'Si el correo existe, se envió un código.' });
    }

    // Remitente efectivo: settings.mail_from tiene precedencia sobre MAIL_FROM.
    const mailFrom = (await settingsService.getSetting('mail_from')) || config.mailFrom;
    // Nombre del sitio efectivo: settings.site_name tiene precedencia sobre
    // SITE_NAME/env; el correo OTP usa la misma marca que el portal.
    const siteName = (await settingsService.getSetting('site_name')) || config.siteName || 'SM-HomePage';

    const code = await otpService.createOtp(db, email, { otpTtlMin: config.otpTtlMin });
    try {
      const sendOtp = mailService.getSendOtpEmailWithRetry();
      await sendOtp(config, { to: email, code, from: mailFrom, siteName });
    } catch (err) {
      // Fall-soft en runtime: si el envío falla tras los reintentos, se
      // INVALIDA el código generado (single-active) y se responde genérico
      // SIN revelar nada (anti-enumeración). La causa técnica va SOLO al
      // audit_log. La app no se cae.
      await otpService.invalidatePreviousCodes(db, email);
      await audit.logAudit(db, {
        action: 'mail.send_failed',
        entityType: 'user',
        entityId: email,
        details: { email, error: err.message },
        ip: req.ip,
      });
      return res.json({ message: 'Si el correo existe, se envió un código.' });
    }

    await audit.logAudit(db, {
      action: 'otp.requested',
      entityType: 'user',
      entityId: email,
      details: { email },
      ip: req.ip,
    });

    const payload = { message: 'Si el correo existe, se envió un código.' };
    // En modo dev (NODE_ENV=development + ENABLE_DEV_CODE != false) se
    // devuelve el código para facilitar las pruebas. NUNCA en producción.
    if (config.nodeEnv === 'development' && process.env.ENABLE_DEV_CODE !== 'false') {
      payload.dev_code = code;
      // Simplificación dev del bootstrap: si el email es el del super_admin y
      // hay una credencial de arranque, se incluye aquí para completar el
      // flujo local (login.js la usa como respaldo cuando no hay input visible).
      if (config.bootstrapToken && email === config.superAdminEmail) {
        payload.bootstrap_token = config.bootstrapToken;
      }
      if (config.bootstrapCode && email === config.superAdminEmail) {
        payload.bootstrap_code = config.bootstrapCode;
      }
    }
    return res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /auth/verify — valida el código, crea sesión.
router.post('/auth/verify', verifyLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body.email;
    const rawCode = req.body.code;
    // Entrada malformada (arrays por email=a&email=b, etc.) -> 400 genérico,
    // nunca un TypeError/500 (F-R1-3).
    if (typeof rawEmail !== 'string' || typeof rawCode !== 'string') {
      return res.status(400).json({ error: 'Email o código inválido.' });
    }
    const email = rawEmail.trim().toLowerCase();
    const code = rawCode.trim();

    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Email o código inválido.' });
    }

    const locked = await otpService.isLockedOut(db, email);
    if (locked) {
      await audit.logAudit(db, {
        action: 'login.failed',
        entityType: 'user',
        entityId: email,
        details: { reason: 'locked_out' },
        ip: req.ip,
      });
      return res.redirect('/login?error=locked&email=' + encodeURIComponent(email));
    }

    const otp = await otpService.findActiveOtp(db, email);
    if (!otp) {
      await otpService.registerFailedAttempt(db, email);
      await audit.logAudit(db, {
        action: 'login.failed',
        entityType: 'user',
        entityId: email,
        details: { reason: 'no_active_otp' },
        ip: req.ip,
      });
      return res.redirect('/login?error=invalid&email=' + encodeURIComponent(email));
    }

    const codeOk = await otpService.verifyCode(code, otp.code_hash);
    if (!codeOk) {
      await otpService.registerFailedAttempt(db, email);
      await audit.logAudit(db, {
        action: 'login.failed',
        entityType: 'user',
        entityId: email,
        details: { reason: 'wrong_code' },
        ip: req.ip,
      });
      return res.redirect('/login?error=invalid&email=' + encodeURIComponent(email));
    }

    // Single-use atómico: UPDATE condicional marca consumed_at SOLO si el
    // código sigue activo (concurrencia segura sin transacción explícita).
    const consumed = await otpService.consumeOtp(db, otp.id);
    if (!consumed) {
      await audit.logAudit(db, {
        action: 'login.failed',
        entityType: 'user',
        entityId: email,
        details: { reason: 'already_consumed' },
        ip: req.ip,
      });
      return res.redirect('/login?error=invalid&email=' + encodeURIComponent(email));
    }

    // Bootstrap seguro del super_admin: la ÚNICA vía es email ==
    // SUPER_ADMIN_EMAIL. Si hay una credencial de arranque configurada
    // (BOOTSTRAP_TOKEN hex o BOOTSTRAP_CODE de 6 dígitos), el primer login de
    // ese email la exige (single-use). Si es inválida/ausente, falla con
    // respuesta genérica y NO se crea el usuario.
    if (config.superAdminEmail && email === config.superAdminEmail) {
      const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
      const bootstrapMode = config.bootstrapCode ? 'code' : config.bootstrapToken ? 'token' : null;
      if (existing.rows.length === 0 && bootstrapMode) {
        // Estrategia robusta: se consume la credencial recibida en
        // bootstrap_code si existe (modo 'code'), si no la de bootstrap_token
        // (retrocompat 'token'). El consume es atómico y por hash SHA-256, así
        // que cualquiera de las dos credenciales sembradas funciona.
        const submittedCode =
          typeof req.body.bootstrap_code === 'string' ? req.body.bootstrap_code.trim() : '';
        const submittedToken =
          typeof req.body.bootstrap_token === 'string' ? req.body.bootstrap_token.trim() : '';
        const credential = submittedCode || submittedToken;
        // Formato estricto para el código de 6 dígitos (modo 'code'); el token
        // hex no exige formato (el hash decide si existe o no).
        const validFormat =
          bootstrapMode === 'code' ? /^\d{6}$/.test(credential) : credential.length > 0;
        let credentialOk = false;
        if (validFormat) {
          credentialOk = await bootstrapService.consumeBootstrapToken(db, credential);
        }
        if (!credentialOk) {
          await otpService.registerFailedAttempt(db, email);
          await audit.logAudit(db, {
            action: 'login.failed',
            entityType: 'user',
            entityId: email,
            details: {
              reason:
                bootstrapMode === 'code'
                  ? 'bootstrap_code_missing_or_invalid'
                  : 'bootstrap_token_missing_or_invalid',
            },
            ip: req.ip,
          });
          return res.redirect('/login?error=invalid&email=' + encodeURIComponent(email));
        }
      }
    }

    const { user, created } = await findOrCreateUser(db, email);
    if (user.status !== 'active') {
      // Email conocido pero usuario desactivado -> respuesta genérica.
      await audit.logAudit(db, {
        action: 'login.failed',
        entityType: 'user',
        entityId: email,
        details: { reason: 'inactive_user' },
        ip: req.ip,
      });
      return res.redirect('/login?error=inactive&email=' + encodeURIComponent(email));
    }

    await otpService.resetLoginAttempts(db, email);

    // Opcional (F6): REVOKE_ALL_ON_LOGIN=true revoca las sesiones previas del
    // usuario (multi-dispositivo). Por defecto desactivado.
    if (config.revokeAllOnLogin) {
      await sessionService.revokeAllUserSessions(db, user.id);
    }

    const token = await sessionService.createSession(db, user.id, user.session_version, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      sessionDays: config.sessionDays,
    });

    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    await audit.logAudit(db, {
      actorId: user.id,
      actorEmail: user.email,
      action: 'login.success',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    if (created) {
      await audit.logAudit(db, {
        actorId: user.id,
        actorEmail: user.email,
        action: user.role === 'super_admin' ? 'super_admin.bootstrap' : 'user.create',
        entityType: 'user',
        entityId: user.id,
        details: { role: user.role, jit: true },
        ip: req.ip,
      });
    }

    res.cookie(
      sessionService.COOKIE_NAME,
      token,
      sessionService.cookieOptions(config, config.sessionDays * 86400)
    );
    // Redirigir a la ruta local solicitada (?next=) o al dashboard.
    // safeNextPath descarta cualquier URL externa (protección open redirect).
    return res.redirect(safeNextPath(req.body.next));
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout — revoca la sesión actual (F16: logout por POST + CSRF).
router.post('/auth/logout', async (req, res, next) => {
  try {
    const token = req.cookies[sessionService.COOKIE_NAME];
    if (token) {
      // Capturar el actor antes de revocar para atribuir la auditoría.
      const session = await sessionService.validateSession(db, token);
      await sessionService.revokeSession(db, token);
      await audit.logAudit(db, {
        actorId: session ? session.userId : null,
        actorEmail: session ? session.user.email : null,
        action: 'session.revoked',
        entityType: 'session',
        ip: req.ip,
      });
    }
    res.clearCookie(sessionService.COOKIE_NAME, { path: '/' });
    // Vuelta al dashboard público (GET / en modo anónimo).
    return res.redirect('/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.findOrCreateUser = findOrCreateUser;
module.exports.safeNextPath = safeNextPath;
module.exports.isSafeLocalPath = isSafeLocalPath;
