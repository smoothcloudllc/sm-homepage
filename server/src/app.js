const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { config } = require('./config');
const db = require('./db');
const { renderPage } = require('./views/render');
const { applySecurity, applyRateLimiters, csrfToken, csrfProtection } = require('./middleware/security');
const settingsService = require('./services/settings.service');
const logoService = require('./services/logo.service');
const visibility = require('./services/visibility.service');
const appIconService = require('./services/app-icon.service');
const { attachUserIfAny } = require('./middleware/auth');
const { getIcon } = require('./utils/app-icon');
const { getAssetVersion, assetUrl } = require('./utils/asset-version');

// Nombre de los iconos de apps subidos (U-4): app-icon-<id>.<png|jpg>.
// El nombre se fija por el servidor (app-icon.service) y se valida aquí por
// regex ANTES de tocar el filesystem -> path traversal imposible.
const APP_ICON_RE = /^app-icon-(\d+)\.(png|jpg)$/;

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // TRUST_PROXY: SOLO se activa cuando hay un reverse proxy de confianza
  // (Caddy/Nginx) delante. Entonces Express confía en X-Forwarded-For y req.ip
  // es la IP real del cliente, con lo que el rate limiting (brute-force OTP)
  // y la auditoría ven la IP correcta y NO la del proxy. Con 0 (default,
  // red interna directa / red privada (VPN)) req.ip es la IP de la red interna y un
  // X-Forwarded-For forjado no altera nada (comportamiento actual).
  if (config.trustProxy > 0) {
    app.set('trust proxy', config.trustProxy);
  }

  // Helper para renderizar páginas dentro del layout principal.
  // Registrado ANTES de los parsers de body para que el manejador de errores
  // disponga de renderPage incluso cuando el fallo ocurre en body-parser
  // (p. ej. JSON malformado) y no esté ya definido en res.
  app.use((req, res, next) => {
    res.renderPage = (view, locals) => renderPage(res, view, locals);
    next();
  });

  // Variables globales para las vistas. También ANTES de los parsers para
  // que el layout (main.ejs) pueda renderizarse en el manejador de errores
  // aunque el fallo ocurra antes (config se usa sin guard en <body>).
  app.use((req, res, next) => {
    res.locals.config = config;
    res.locals.currentPath = req.path;
    // Cache-busting por contenido: expone en las vistas el hash de cada asset
    // estático (getAssetVersion('/js/login.js') -> '1f0a4c2b') y el helper
    // assetUrl() que añade ?v=<hash>. Ver src/utils/asset-version.js.
    res.locals.assetVersion = getAssetVersion;
    res.locals.assetUrl = assetUrl;
    next();
  });

  // NOTA (P4): 'trust proxy' se configura ARRIBA, SOLO si config.trustProxy > 0
  // (ver TRUST_PROXY). Con 0 — el default para la red interna / VPN de la
  // empresa (overlay L3, sin proxy de confianza) — req.ip es la IP real de la
  // red interna y un X-Forwarded-For forjado NO puede cambiar la IP con la que
  // se aplica el rate limiting ni se audita.

  applySecurity(app);
  applyRateLimiters(app);

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser(config.sessionSecret));

  // Iconos de la biblioteca local (H-1, defensa en profundidad).
  // Se sirven SOLO desde el manifest (icons.json): el slug se valida contra el
  // catálogo (utils/app-icon.getIcon) ANTES de tocar el sistema de ficheros y
  // la ruta final se construye con entry.slug (nombre controlado por el
  // servidor), de modo que un slug con '../' (o codificado) jamás puede escapar
  // del directorio /icons. Slug inexistente o con formato raro -> 404.
  // Cache: immutable 1 año (los iconos no cambian; si se reemplazan se usa
  // otro slug/URL). Sustituye al antiguo express.static('/icons').
  app.get('/icons/:slug.png', (req, res) => {
    const raw = req.params.slug || '';
    // Belt & suspenders sobre el manifest: formato de slug razonable; cualquier
    // intento de traversal/URL rara -> 404 sin tocar el filesystem.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) {
      return res.status(404).renderPage('errors/404', { title: 'No encontrado', user: req.user || null });
    }
    const entry = getIcon(raw);
    if (!entry) {
      return res.status(404).renderPage('errors/404', { title: 'No encontrado', user: req.user || null });
    }
    return res.sendFile(
      path.join(__dirname, 'public', 'icons', `${entry.slug}.png`),
      { maxAge: '1y', immutable: true, headers: { 'Content-Type': 'image/png' } }
    );
  });

  // Uploads con CONTROL DE ACCESO (U-4). Sustituye al antiguo
  // express.static('/uploads') que exponía TODO el volumen sin control.
  //   - /uploads/logo.<png|jpg> -> PÚBLICO (marca del portal, cache inmutable).
  //     (El logo también se sirve vía /logo con cache-busting ?v=.)
  //   - /uploads/app-icons/<file> -> control de acceso: una app public sirve a
  //     cualquiera; una app restricted SOLO a sesión válida con acceso a esa
  //     app (grupo asignado; super_admin/admin siempre). Anónimo/ajeno -> 403.
  //     El nombre se fija por regex (app-icon-<id>.<png|jpg>); cualquier otro
  //     patrón (traversal, codificado, etc.) -> 404 sin tocar el filesystem.
  app.get('/uploads/logo.:ext', (req, res, next) => {
    const ext = req.params.ext;
    if (ext !== 'png' && ext !== 'jpg') return next();
    return res.sendFile(path.join(config.uploadsDir, `logo.${ext}`), {
      maxAge: '1y',
      immutable: true,
      headers: { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg' },
    });
  });

  app.get('/uploads/app-icons/:file', attachUserIfAny, async (req, res, next) => {
    try {
      const raw = req.params.file || '';
      const match = APP_ICON_RE.exec(raw);
      if (!match) {
        return res.status(404).send('No encontrado');
      }
      const appId = Number(match[1]);
      const ext = match[2];

      const result = await db.query('SELECT id, visibility FROM apps WHERE id = $1', [appId]);
      if (result.rows.length === 0) {
        return res.status(404).send('No encontrado');
      }

      if (result.rows[0].visibility === 'restricted') {
        const user = req.user;
        // Sin sesión válida o sin acceso a la app -> 403 (no se revela el fichero).
        if (!user) return res.status(403).send('Prohibido');
        if (user.role !== 'super_admin' && user.role !== 'admin') {
          const allowed = await visibility.canUserAccessApp(db, user.id, appId);
          if (!allowed) return res.status(403).send('Prohibido');
        }
      }

      return res.sendFile(path.join(appIconService.iconsDir(), raw), {
        maxAge: '1y',
        immutable: true,
        headers: { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg' },
      });
    } catch (err) {
      next(err);
    }
  });

  // Estáticos propios (/js, /css) con cache-busting por contenido en las
  // vistas (?v=<hash>): en producción se sirven con maxAge 1 día (la URL
  // cambia al cambiar el contenido, así que la caché nunca devuelve una
  // versión obsoleta); en desarrollo se sirven con Cache-Control: no-cache
  // para que los cambios se propaguen de inmediato sin hard reload.
  app.use(
    express.static(path.join(__dirname, 'public'), {
      maxAge: config.isProd ? '1d' : 0,
      setHeaders(res, filePath) {
        if (!config.isProd) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // Personalización efectiva en runtime (BD con precedencia sobre env).
  // El valor se resuelve desde settings.service con caché interna de 30 s.
  app.use(async (req, res, next) => {
    try {
      const all = await settingsService.getAll();
      res.locals.siteName = all.site_name || 'SM-HomePage';
      res.locals.defaultTheme = all.default_theme || 'system';
      res.locals.logoVersion = all.logo_version || '0';
      next();
    } catch (err) {
      next(err);
    }
  });

  // Logo público de la empresa con cache-busting (?v=). Si no hay logo subido,
  // sirve el logo por defecto (SVG embebido) para que la UI siempre renderice.
  app.get('/logo', (req, res) => {
    const result = logoService.resolveLogo();
    res.set('Content-Type', result.contentType);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
  });

  // CSRF: cookie + token expuesto para formularios; validado en métodos mutantes.
  app.use(csrfToken);
  app.use(csrfProtection);

  // Rutas.
  app.use('/', require('./routes/auth.routes'));
  app.use('/', require('./routes/dashboard.routes'));
  app.use('/admin/apps', require('./routes/admin.apps.routes'));
  app.use('/admin/categories', require('./routes/admin.categories.routes'));
  app.use('/admin/users', require('./routes/admin.users.routes'));
  app.use('/admin/groups', require('./routes/admin.groups.routes'));
  app.use('/admin/audit', require('./routes/admin.audit.routes'));
  app.use('/admin/settings', require('./routes/admin.settings.routes'));

  // 404.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'No encontrado' });
    }
    res.status(404).renderPage('errors/404', { title: 'No encontrado', user: req.user || null });
  });

  // Manejador de errores.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    const status = err.status || err.statusCode || 500;
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: 'Error interno del servidor' });
    }
    // Defensa en profundidad: si renderPage no está disponible (p. ej. error
    // antes de los parsers), responder texto plano en vez de lanzar un
    // TypeError dentro del propio manejador de errores.
    if (typeof res.renderPage !== 'function') {
      return res.status(status).send('Error interno del servidor');
    }
    res.status(status).renderPage('errors/500', {
      title: 'Error',
      user: req.user || null,
      message: config.isProd ? 'Error interno del servidor' : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
