const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole, requireRole, logAuditAction } = require('../middleware/rbac');

const router = express.Router();

router.use(requireAuth, requireAnyRole(['super_admin', 'admin']));

// GET /admin/groups — super_admin: CRUD completo; admin: solo lectura.
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT g.id, g.name, g.created_at,
              count(DISTINCT ug.user_id) AS user_count,
              count(DISTINCT aga.app_id) AS app_count
         FROM groups g
         LEFT JOIN user_groups ug ON ug.group_id = g.id
         LEFT JOIN app_group_assignments aga ON aga.group_id = g.id
        GROUP BY g.id
        ORDER BY g.name ASC`
    );
    res.renderPage('admin/groups', {
      title: 'Grupos',
      user: req.user,
      groups: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/groups — crear grupo (solo super_admin).
router.post('/', requireRole('super_admin'), async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).send('El nombre es obligatorio.');
    const exists = await db.query('SELECT id FROM groups WHERE name = $1', [name]);
    if (exists.rows.length > 0) {
      return res.status(400).send('Ya existe un grupo con ese nombre.');
    }
    const created = await db.query(
      `INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id`,
      [name, req.user.id]
    );
    await logAuditAction(req, 'group.create', 'group', created.rows[0].id, { name });
    return res.redirect('/admin/groups');
  } catch (err) {
    next(err);
  }
});

// POST /admin/groups/:id/rename — renombrar (solo super_admin).
router.post('/:id/rename', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).send('El nombre es obligatorio.');
    await db.query(`UPDATE groups SET name = $1 WHERE id = $2`, [name, id]);
    await logAuditAction(req, 'group.update', 'group', id, { name });
    return res.redirect('/admin/groups');
  } catch (err) {
    next(err);
  }
});

// POST /admin/groups/:id/delete — borrar (solo super_admin).
router.post('/:id/delete', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // ON DELETE CASCADE limpia user_groups y app_group_assignments.
    await db.query('DELETE FROM groups WHERE id = $1', [id]);
    await logAuditAction(req, 'group.delete', 'group', id, {});
    return res.redirect('/admin/groups');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
