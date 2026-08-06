const express = require('express');
const db = require('../db');
const { attachUserIfAny } = require('../middleware/auth');
const visibility = require('../services/visibility.service');
const { config } = require('../config');
const { resolveAppIcon } = require('../utils/app-icon');

const router = express.Router();

// GET / — dashboard en dos modos:
//   - anónimo (SOLO si config.anonymousMode, default ON): SOLO apps públicas
//     (los nombres/URLs de apps restricted NO se revelan). Cacheable
//     ligeramente (public, max-age corto). Con ANONYMOUS_MODE=off el anónimo
//     recibe 302 a /login (despliegues solo-autenticados).
//   - autenticado: apps públicas + restricted de los grupos del usuario
//     (regla deny-overrides existente, inalterada). Siempre Cache-Control: no-store.
router.get('/', attachUserIfAny, async (req, res, next) => {
  try {
    const isAuthed = !!req.user;
    if (!isAuthed && !config.anonymousMode) {
      return res.redirect('/login');
    }
    const apps = isAuthed
      ? await visibility.resolveVisibleAppsDb(db, req.user.id)
      : await visibility.resolvePublicAppsDb(db);

    // Solo autenticado: mapa appId -> nombres de grupos para el filtro de
    // chips (deny-overrides inalterado; esto es solo metadatos de UI).
    if (isAuthed && apps.length > 0) {
      const appIds = apps.map((a) => a.id);
      const assignments = await db.query(
        `SELECT aga.app_id, g.name AS group_name
           FROM app_group_assignments aga
           JOIN groups g ON g.id = aga.group_id
          WHERE aga.app_id = ANY($1::int[])
          ORDER BY g.name ASC`,
        [appIds]
      );
      const groupsByApp = new Map();
      for (const row of assignments.rows) {
        if (!groupsByApp.has(row.app_id)) groupsByApp.set(row.app_id, []);
        groupsByApp.get(row.app_id).push(row.group_name);
      }
      for (const app of apps) {
        app.groupNames = groupsByApp.get(app.id) || [];
      }
    }

    // Cadena de iconos centralizada (utils/app-icon.js): icon_url > icon_key
    // (biblioteca local validada contra el manifest) > icon_class > favicon
    // del dominio PÚBLICO > glifo (inicial + color). El favicon solo se genera
    // como URL client-side (el navegador la carga; el servidor nunca hace
    // fetch a servicios externos -> cero SSRF).
    for (const app of apps) {
      app.icon = resolveAppIcon(app);
    }

    // Agrupar por categoría efectiva (category_name vía JOIN), preservando
    // orden alfabético. Solo se renderizan categorías con >=1 app visible.
    const categories = new Map();
    for (const app of apps) {
      const cat = app.category_name || app.category || 'General';
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat).push(app);
    }
    const grouped = Array.from(categories.entries()).map(([name, items]) => ({
      name,
      apps: items,
    }));

    const locals = {
      title: isAuthed ? 'Panel' : 'Aplicaciones',
      user: req.user || null,
      isAuthed,
      groups: isAuthed ? await visibility.getUserGroups(db, req.user.id) : [],
      grouped,
      portalBgImage: config.portal.bgImage,
      portalBgColor: config.portal.bgColor,
      appCount: apps.length,
      hasRestrictedApps: isAuthed ? false : await visibility.hasRestrictedApps(db),
    };

    if (isAuthed) {
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Cache-Control', 'public, max-age=60');
    }

    res.renderPage('dashboard/index', locals);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
