const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole, logAuditAction } = require('../middleware/rbac');
const categoriesService = require('../services/categories.service');

const router = express.Router();

// U-6: los IDs de ruta deben ser enteros positivos; si no, 404 (nunca 500 por NaN).
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// Solo super_admin gestiona las categorías (CRUD completo).
router.use(requireAuth, requireRole('super_admin'));

// Carga el estado para re-renderizar la vista (GET y errores).
async function loadState(req, extra = {}) {
  const categories = await categoriesService.listCategoriesWithCounts(db);
  return { title: 'Categorías', user: req.user, categories, error: null, ...extra };
}

// GET /admin/categories — tabla (nombre, nº de apps, fecha) + formulario crear.
router.get('/', async (req, res, next) => {
  try {
    res.renderPage('admin/categories', await loadState(req));
  } catch (err) {
    next(err);
  }
});

// POST /admin/categories — crear categoría (super_admin).
// Con ?inline=1 responde JSON para el atajo "+ Nueva categoría" del formulario
// de apps (el JS recarga el <select> al instante). Sin inline -> redirect.
router.post('/', async (req, res, next) => {
  try {
    const inline = req.query.inline === '1';
    const created = await categoriesService.createCategory(db, req.body.name, req.user.id);
    if (!created.ok) {
      if (inline) return res.status(400).json({ error: created.error });
      return res.status(400).renderPage('admin/categories', await loadState(req, { error: created.error }));
    }
    await logAuditAction(req, 'categories.create', 'category', created.id, { name: created.name });
    if (inline) return res.status(200).json({ ok: true, id: created.id, name: created.name });
    return res.redirect('/admin/categories');
  } catch (err) {
    if (err.code === '23505') {
      const message = 'Ya existe una categoría con ese nombre.';
      if (req.query.inline === '1') return res.status(400).json({ error: message });
      return res.status(400).renderPage('admin/categories', await loadState(req, { error: message }));
    }
    next(err);
  }
});

// POST /admin/categories/:id/rename — renombrar (super_admin).
router.post('/:id/rename', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Categoría no encontrada');
    const result = await categoriesService.renameCategory(db, id, req.body.name, req.user.id);
    if (!result.ok) {
      const status = result.status || 400;
      return res.status(status).renderPage('admin/categories', await loadState(req, { error: result.error }));
    }
    await logAuditAction(req, 'categories.update', 'category', id, { name: result.name });
    return res.redirect('/admin/categories');
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).renderPage('admin/categories', await loadState(req, { error: 'Ya existe una categoría con ese nombre.' }));
    }
    next(err);
  }
});

// POST /admin/categories/:id/delete — borrar (super_admin).
// Si la categoría tiene apps -> 400 con opción ?reassign=true (reasigna a
// 'General' en una transacción y borra). 'General' nunca se borra.
router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).send('Categoría no encontrada');
    const reassign = req.query.reassign === 'true';
    const result = await categoriesService.deleteCategory(db, id, {
      reassign,
      withTransaction,
      getClient: () => db.getClient(),
    });
    if (!result.ok) {
      return res.status(result.status || 400).renderPage('admin/categories', await loadState(req, { error: result.error }));
    }
    await logAuditAction(req, 'categories.delete', 'category', id, {
      name: result.name,
      reassigned: result.reassigned,
      reassignedTo: result.reassigned ? 'General' : null,
    });
    return res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
