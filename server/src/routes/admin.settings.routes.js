const express = require('express');
const multer = require('multer');
const db = require('../db');
const { config } = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole, logAuditAction } = require('../middleware/rbac');
const settingsService = require('../services/settings.service');
const logoService = require('../services/logo.service');

const router = express.Router();

// Solo super_admin puede gestionar la configuración del portal.
router.use(requireAuth, requireRole('super_admin'));

// Upload del logo en memoria (límite 2 MB) — la validación real de formato se
// hace por MAGIC BYTES y dimensiones en logo.service, nunca por extensión.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: logoService.MAX_SIZE_BYTES },
});

// Nº de usuarios activos por dominio (para la advertencia anti-lockout).
async function activeUsersByDomain(dbClient) {
  const result = await dbClient.query(
    `SELECT split_part(email, '@', 2) AS domain, count(*)::int AS n
       FROM users
      WHERE status = 'active'
      GROUP BY 1
      ORDER BY 1`
  );
  const map = {};
  for (const row of result.rows) {
    map[row.domain] = row.n;
  }
  return map;
}

// Formato de dominio: etiquetas separadas por punto con TLD >= 2 letras.
// En development se tolera "localhost" (mismo criterio que config.js).
function isValidDomain(domain) {
  if (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return true;
  if (config.nodeEnv === 'development' && domain === 'localhost') return true;
  return false;
}

// Carga el estado actual para re-renderizar el formulario (GET y errores).
async function loadFormState(req, extra = {}) {
  const all = await settingsService.getAll();
  const allowedDomains = await settingsService.getAllowedDomains();
  const activeDomains = await activeUsersByDomain(db);
  return {
    title: 'Configuración',
    user: req.user,
    settings: all,
    allowedDomains,
    activeDomains,
    saved: req.query.saved === '1',
    logoSaved: req.query.logo === '1',
    error: null,
    ...extra,
  };
}

// GET /admin/settings — formulario de configuración + bloque de logo.
router.get('/', async (req, res, next) => {
  try {
    res.renderPage('admin/settings', await loadFormState(req));
  } catch (err) {
    next(err);
  }
});

// POST /admin/settings — guarda la configuración (con validación y
// advertencia anti-lockout) y audita settings.update por clave.
router.post('/', async (req, res, next) => {
  try {
    const domains = settingsService.normalizeDomains(req.body.allowed_domains);
    if (domains.length === 0) {
      return res.status(400).renderPage('admin/settings', await loadFormState(req, { error: 'Debes indicar al menos un dominio permitido.' }));
    }
    for (const d of domains) {
      if (!isValidDomain(d)) {
        return res.status(400).renderPage('admin/settings', await loadFormState(req, { error: `Dominio inválido: "${d}".` }));
      }
    }

    const siteName = (req.body.site_name || '').trim();
    if (!siteName) {
      return res.status(400).renderPage('admin/settings', await loadFormState(req, { error: 'El nombre del sitio no puede estar vacío.' }));
    }

    const mailFrom = (req.body.mail_from || '').trim();
    if (mailFrom && !/^[^\s@]+@[^\s@]+$/.test(mailFrom)) {
      return res.status(400).renderPage('admin/settings', await loadFormState(req, { error: 'MAIL_FROM debe ser un email válido si se indica.' }));
    }

    const theme = ['light', 'dark', 'system'].includes(req.body.default_theme)
      ? req.body.default_theme
      : 'system';

    // Advertencia anti-lockout: si se eliminan dominios con usuarios activos
    // hay que confirmarlo expresamente con el checkbox.
    const currentAllowed = await settingsService.getAllowedDomains();
    const removed = currentAllowed.filter((d) => !domains.includes(d));
    const activeDomains = await activeUsersByDomain(db);
    const affected = removed.filter((d) => (activeDomains[d] || 0) > 0);
    if (affected.length > 0 && req.body.confirm_remove_domains !== '1') {
      const detail = affected
        .map((d) => `${d} (${activeDomains[d]} ${activeDomains[d] === 1 ? 'usuario activo' : 'usuarios activos'})`)
        .join(', ');
      return res.status(400).renderPage(
        'admin/settings',
        await loadFormState(req, {
          error: `Eliminarías dominios en uso por usuarios activos: ${detail}. Marca la casilla de confirmación para continuar.`,
        })
      );
    }

    await settingsService.setSetting('allowed_domains', domains.join(','), req.user.id);
    await settingsService.setSetting('site_name', siteName, req.user.id);
    await settingsService.setSetting('mail_from', mailFrom, req.user.id);
    await settingsService.setSetting('default_theme', theme, req.user.id);

    return res.redirect('/admin/settings?saved=1');
  } catch (err) {
    next(err);
  }
});

// POST /admin/settings/logo — sube un nuevo logo (PNG/JPEG, <=2 MB, <=2048 px).
router.post(
  '/logo',
  (req, res, next) => {
    upload.single('logo')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          try {
            const state = await loadFormState(req, { error: 'El archivo supera el tamaño máximo de 2 MB.' });
            return res.status(400).renderPage('admin/settings', state);
          } catch (loadErr) {
            return next(loadErr);
          }
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const buffer = req.file ? req.file.buffer : null;
      const validation = logoService.validateLogo(buffer);
      if (!validation.ok) {
        return res.status(400).renderPage('admin/settings', await loadFormState(req, { error: validation.error }));
      }

      await logoService.saveLogo(buffer, validation.type);

      // Cache-busting: incrementa logo_version para que las referencias
      // /logo?v=<n> se actualicen en los navegadores.
      const current = parseInt(await settingsService.getSetting('logo_version'), 10) || 0;
      await settingsService.setSetting('logo_version', String(current + 1), req.user.id);

      await logAuditAction(req, 'logo.upload', 'logo', null, {
        type: validation.type,
        width: validation.width,
        height: validation.height,
        size: buffer.length,
      });

      return res.redirect('/admin/settings?logo=1');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
