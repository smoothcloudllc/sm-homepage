const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole, requireRole, logAuditAction } = require('../middleware/rbac');
const visibility = require('../services/visibility.service');
const appIconService = require('../services/app-icon.service');
const { resolveAppIcon, isValidSlug, listIcons } = require('../utils/app-icon');
const categoriesService = require('../services/categories.service');

const router = express.Router();

// Todas las rutas requieren autenticación y rol admin/super_admin.
router.use(requireAuth, requireAnyRole(['super_admin', 'admin']));

// Upload del icono personalizado en memoria (límite 2 MB). La validación real
// (magic bytes, dimensiones) se hace en app-icon.service, nunca por extensión.
const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: appIconService.MAX_SIZE_BYTES },
});

function parseGroupIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  if (value && typeof value === 'string') return value.split(',').map(Number).filter(Number.isInteger);
  if (value != null) {
    const n = Number(value);
    if (Number.isInteger(n)) return [n];
  }
  return [];
}

// U-6: los IDs de ruta deben ser enteros positivos. Un id no numérico (p.ej.
// /admin/apps/abc/edit) responde 404 en vez de acabar en 500 por NaN.
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// ¿El valor es una URL de upload local del portal (/uploads/app-icons/app-icon-<id>.<ext>)?
function isLocalUploadUrl(value) {
  return typeof value === 'string' && /^\/uploads\/app-icons\/app-icon-\d+\.(png|jpg)$/.test(value.trim());
}

// F9: valida que una URL (app o icono) use esquema http/https.
// Rechaza javascript:, data:, etc. (solo el navegador cargará estos valores).
// Se permiten ADEMÁS las rutas locales de uploads del portal
// (/uploads/app-icons/app-icon-<id>.<ext>) porque son nombres fijados por el
// servidor (app-icon.service) y el form de edición las envía tal cual: sin
// esto, una app con icono subido NO se podría guardar al editar otros campos
// (400).
function isHttpUrl(value) {
  if (value === undefined || value === null || value === '') return true;
  if (isLocalUploadUrl(value)) return true;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// Normaliza la petición de icono del form. Devuelve { ok, iconUrl, iconKey,
// iconClass } o { ok:false, error }.
// Regla: icon_url e icon_key son MUTUAMENTE EXCLUYENTES (400 si ambos llegan).
function normalizeIconFields(iconUrlRaw, iconKeyRaw, iconClassRaw) {
  const iconUrl = (iconUrlRaw || '').trim();
  const iconKey = (iconKeyRaw || '').trim();
  const iconClass = (iconClassRaw || '').trim();

  if (iconUrl && iconKey) {
    return { ok: false, error: 'Elige una sola fuente de icono: externa (URL) o biblioteca.' };
  }
  if (iconKey && !isValidSlug(iconKey)) {
    return { ok: false, error: 'El icono de la biblioteca no existe en el catálogo.' };
  }
  if (iconUrl && !isHttpUrl(iconUrl)) {
    return { ok: false, error: 'La URL del icono debe usar http:// o https://.' };
  }
  return { ok: true, iconUrl: iconUrl || null, iconKey: iconKey || null, iconClass: iconClass || null };
}

// Devuelve un mensaje de error o null si los campos de app son válidos.
function validateAppInput(name, urlRaw, iconUrlRaw, colorRaw) {
  if (!name || !urlRaw) return 'Nombre y URL son obligatorios.';
  if (!isHttpUrl(urlRaw)) return 'La URL debe usar http:// o https://.';
  if (iconUrlRaw && !isHttpUrl(iconUrlRaw)) return 'La URL del icono debe usar http:// o https://.';
  // G-2: color server-side. Vacío -> default '#4f8cff'; cualquier otro valor
  // debe ser un hex #rrggbb (el <input type=color> solo envía hex, pero un
  // request forjado podría enviar otra cosa).
  const color = colorRaw == null ? '' : String(colorRaw).trim();
  if (color !== '' && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return 'El color debe ser un código hexadecimal válido (#rrggbb).';
  }
  return null;
}

// Valida el category_id del form: debe existir (400 si es desconocido).
async function resolveCategoryId(categoryIdRaw) {
  const raw = String(categoryIdRaw || '').trim();
  if (!raw) return { ok: false, error: 'Debes seleccionar una categoría.' };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Categoría inválida.' };
  const result = await db.query('SELECT id FROM categories WHERE id = $1', [id]);
  if (result.rows.length === 0) return { ok: false, error: 'La categoría seleccionada no existe.' };
  return { ok: true, id };
}

async function loadFormOptions() {
  const [groupsResult, categoriesResult] = await Promise.all([
    db.query('SELECT id, name FROM groups ORDER BY name ASC'),
    categoriesService.listCategories(db),
  ]);
  return { groups: groupsResult.rows, categories: categoriesResult, iconLibrary: listIcons() };
}

// GET /admin/apps — catálogo (super_admin y admin).
router.get('/', async (req, res, next) => {
  try {
    const apps = await visibility.listAppsWithGroups(db);
    // Misma cadena de iconos que el dashboard (centralizada en app-icon.js).
    for (const app of apps) {
      app.icon = resolveAppIcon(app);
    }
    const groupsResult = await db.query('SELECT id, name FROM groups ORDER BY name ASC');
    res.renderPage('admin/apps', {
      title: 'Aplicaciones',
      user: req.user,
      apps,
      groups: groupsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/apps/new — formulario (solo super_admin).
router.get('/new', requireRole('super_admin'), async (req, res, next) => {
  try {
    const options = await loadFormOptions();
    res.renderPage('admin/apps-form', {
      title: 'Nueva aplicación',
      user: req.user,
      app: null,
      ...options,
      selectedGroupIds: [],
      isEdit: false,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/apps/:id/edit — formulario (solo super_admin).
router.get('/:id/edit', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Aplicación no encontrada');
    const result = await db.query('SELECT * FROM apps WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Aplicación no encontrada');
    const app = result.rows[0];
    // Vista previa del icono efectivo (misma cadena que el dashboard).
    app.icon = resolveAppIcon(app);
    const options = await loadFormOptions();
    const assignments = await db.query(
      `SELECT group_id FROM app_group_assignments WHERE app_id = $1`,
      [id]
    );
    const selectedGroupIds = assignments.rows.map((r) => r.group_id);
    res.renderPage('admin/apps-form', {
      title: 'Editar aplicación',
      user: req.user,
      app,
      ...options,
      selectedGroupIds,
      isEdit: true,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/apps — crear (solo super_admin).
router.post('/', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis, category_id } = req.body;
    const urlRaw = (url || '').trim();
    const iconUrlRaw = (icon_url || '').trim();
    const error = validateAppInput(name, urlRaw, iconUrlRaw, color);
    if (error) {
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Nueva aplicación',
        user: req.user,
        app: { name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: parseGroupIds(req.body.groups),
        isEdit: false,
        error,
      });
    }
    const icons = normalizeIconFields(iconUrlRaw, icon_key, icon_class);
    if (!icons.ok) {
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Nueva aplicación',
        user: req.user,
        app: { name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: parseGroupIds(req.body.groups),
        isEdit: false,
        error: icons.error,
      });
    }
    const cat = await resolveCategoryId(category_id);
    if (!cat.ok) {
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Nueva aplicación',
        user: req.user,
        app: { name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: parseGroupIds(req.body.groups),
        isEdit: false,
        error: cat.error,
      });
    }
    const visibilityValue = vis === 'restricted' ? 'restricted' : 'public';
    const created = await db.query(
      `INSERT INTO apps (name, url, icon_url, icon_key, icon_class, description, category, color, visibility, created_by, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [name.trim(), urlRaw, icons.iconUrl, icons.iconKey, icons.iconClass, description || null,
       category || 'General', color || '#4f8cff', visibilityValue, req.user.id, cat.id]
    );
    const appId = created.rows[0].id;

    const groupIds = visibilityValue === 'restricted' ? parseGroupIds(req.body.groups) : [];
    for (const gid of groupIds) {
      await db.query(
        `INSERT INTO app_group_assignments (app_id, group_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id, group_id) DO NOTHING`,
        [appId, gid, req.user.id]
      );
    }

    await logAuditAction(req, 'app.create', 'app', appId, {
      name: name.trim(),
      url: urlRaw,
      visibility: visibilityValue,
      groups: groupIds,
      categoryId: cat.id,
      iconKey: icons.iconKey,
    });

    return res.redirect('/admin/apps');
  } catch (err) {
    next(err);
  }
});

// POST /admin/apps/:id — actualizar (solo super_admin).
router.post('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Aplicación no encontrada');
    const { name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis, category_id } = req.body;
    const urlRaw = (url || '').trim();
    const iconUrlRaw = (icon_url || '').trim();
    const appResult = await db.query('SELECT * FROM apps WHERE id = $1', [id]);
    if (appResult.rows.length === 0) return res.status(404).send('Aplicación no encontrada');

    const error = validateAppInput(name, urlRaw, iconUrlRaw, color);
    if (error) {
      const assignments = await db.query(
        `SELECT group_id FROM app_group_assignments WHERE app_id = $1`,
        [id]
      );
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Editar aplicación',
        user: req.user,
        app: { ...appResult.rows[0], name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: assignments.rows.map((r) => r.group_id),
        isEdit: true,
        error,
      });
    }
    const icons = normalizeIconFields(iconUrlRaw, icon_key, icon_class);
    if (!icons.ok) {
      const assignments = await db.query(
        `SELECT group_id FROM app_group_assignments WHERE app_id = $1`,
        [id]
      );
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Editar aplicación',
        user: req.user,
        app: { ...appResult.rows[0], name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: assignments.rows.map((r) => r.group_id),
        isEdit: true,
        error: icons.error,
      });
    }
    const cat = await resolveCategoryId(category_id);
    if (!cat.ok) {
      const assignments = await db.query(
        `SELECT group_id FROM app_group_assignments WHERE app_id = $1`,
        [id]
      );
      return res.status(400).renderPage('admin/apps-form', {
        title: 'Editar aplicación',
        user: req.user,
        app: { ...appResult.rows[0], name, url, icon_url, icon_key, icon_class, description, category, color, visibility: vis },
        ...(await loadFormOptions()),
        selectedGroupIds: assignments.rows.map((r) => r.group_id),
        isEdit: true,
        error: cat.error,
      });
    }
    const visibilityValue = vis === 'restricted' ? 'restricted' : 'public';
    // U-2: capturamos el icon_url previo ANTES del UPDATE (si la app tenía un
    // icono subido — icon_url local /uploads/app-icons/app-icon-<id>.<ext> — y
    // el nuevo icon_url ya no apunta a esa ruta, se borra el fichero tras
    // guardar para no dejar huérfanos en el volumen). deleteAppIcon() limpia
    // sin lanzar.
    const oldIconUrl = appResult.rows[0].icon_url || '';
    const shouldCleanupUpload = isLocalUploadUrl(oldIconUrl) && icons.iconUrl !== oldIconUrl;

    await db.query(
      `UPDATE apps
          SET name = $1, url = $2, icon_url = $3, icon_key = $4, icon_class = $5,
              description = $6, category = $7, color = $8, visibility = $9,
              category_id = $10, updated_at = now()
        WHERE id = $11`,
      [name.trim(), urlRaw, icons.iconUrl, icons.iconKey, icons.iconClass, description || null,
       category || 'General', color || '#4f8cff', visibilityValue, cat.id, id]
    );

    if (shouldCleanupUpload) {
      appIconService.deleteAppIcon(id);
    }

    // Reescribir asignaciones de grupos para apps restricted.
    const groupIds = visibilityValue === 'restricted' ? parseGroupIds(req.body.groups) : [];
    await db.query(
      `DELETE FROM app_group_assignments WHERE app_id = $1`,
      [id]
    );
    for (const gid of groupIds) {
      await db.query(
        `INSERT INTO app_group_assignments (app_id, group_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id, group_id) DO NOTHING`,
        [id, gid, req.user.id]
      );
    }

    await logAuditAction(req, 'app.update', 'app', id, {
      name: name.trim(),
      visibility: visibilityValue,
      groups: groupIds,
      categoryId: cat.id,
      iconKey: icons.iconKey,
    });

    return res.redirect('/admin/apps');
  } catch (err) {
    next(err);
  }
});

// POST /admin/apps/:id/delete — borrar (solo super_admin).
// Limpia el fichero de icono personalizado subido (si existe).
router.post('/:id/delete', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Aplicación no encontrada');
    await db.query('DELETE FROM apps WHERE id = $1', [id]);
    appIconService.deleteAppIcon(id);
    await logAuditAction(req, 'app.delete', 'app', id, { iconCleaned: true });
    return res.redirect('/admin/apps');
  } catch (err) {
    next(err);
  }
});

// POST /admin/apps/:id/icon — subir icono personalizado (solo super_admin).
// multipart (multer memoryStorage, 2 MB); el token CSRF se acepta en query
// (mismo patrón que /admin/settings/logo). Validación por MAGIC BYTES
// (PNG/JPEG reales, NUNCA por extensión), <=2MB, dimensiones <=1024 px.
// Guarda app-icon-<appId>.<png|jpg> en el volumen de uploads (subcarpeta
// app-icons, U-4) y registra icon_url =
// '/uploads/app-icons/app-icon-<appId>.<ext>' (precedencia a). Al guardar
// un nuevo icono se limpia el formato anterior y se borra icon_key (fuente
// única de icono).
router.post(
  '/:id/icon',
  requireRole('super_admin'),
  (req, res, next) => {
    iconUpload.single('icon')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).send('El archivo supera el tamaño máximo de 2 MB.');
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(404).send('Aplicación no encontrada');
      const appResult = await db.query('SELECT id FROM apps WHERE id = $1', [id]);
      if (appResult.rows.length === 0) return res.status(404).send('Aplicación no encontrada');

      const buffer = req.file ? req.file.buffer : null;
      const validation = appIconService.validateIconUpload(buffer);
      if (!validation.ok) {
        return res.status(400).send(validation.error);
      }

      appIconService.saveAppIcon(id, buffer, validation.type);

      // Fuente única: el upload gana como icon_url local; se limpia icon_key.
      await db.query(
        `UPDATE apps
            SET icon_url = $1, icon_key = NULL, updated_at = now()
          WHERE id = $2`,
        [appIconService.iconUrlFor(id, validation.type), id]
      );

      await logAuditAction(req, 'icon.upload', 'app', id, {
        type: validation.type,
        width: validation.width,
        height: validation.height,
        size: buffer.length,
      });

      return res.redirect('/admin/apps');
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/apps/:id/groups — asignar/desasignar grupos (super_admin y admin).
router.post('/:id/groups', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Aplicación no encontrada');
    const groupIds = parseGroupIds(req.body.groups);

    const appResult = await db.query('SELECT id, visibility FROM apps WHERE id = $1', [id]);
    if (appResult.rows.length === 0) return res.status(404).send('Aplicación no encontrada');

    const existing = await db.query(
      `SELECT group_id FROM app_group_assignments WHERE app_id = $1`,
      [id]
    );
    const existingIds = new Set(existing.rows.map((r) => r.group_id));
    const newIds = new Set(groupIds);

    // Registrar auditoría de cambios (mapping.assign / mapping.remove).
    for (const gid of groupIds) {
      if (!existingIds.has(gid)) {
        await db.query(
          `INSERT INTO app_group_assignments (app_id, group_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, gid, req.user.id]
        );
        await logAuditAction(req, 'mapping.assign', 'app', id, { groupId: gid });
      }
    }
    for (const gid of existingIds) {
      if (!newIds.has(gid)) {
        await db.query(
          `DELETE FROM app_group_assignments WHERE app_id = $1 AND group_id = $2`,
          [id, gid]
        );
        await logAuditAction(req, 'mapping.remove', 'app', id, { groupId: gid });
      }
    }

    // Si la app es restricted y se quedó sin grupos, la dejamos visible
    // únicamente mediante asignaciones nuevas (deny-overrides por defecto).
    return res.redirect('/admin/apps');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
