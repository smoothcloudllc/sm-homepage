const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole, logAuditAction, isLastActiveSuperAdmin } = require('../middleware/rbac');
const sessionService = require('../services/session.service');
const settingsService = require('../services/settings.service');
const audit = require('../services/audit.service');

const router = express.Router();

router.use(requireAuth, requireAnyRole(['super_admin', 'admin']));

function parseGroupIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  if (value && typeof value === 'string') return value.split(',').map(Number).filter(Number.isInteger);
  return [];
}

// Carga usuarios con sus grupos (para la tabla y formularios).
async function loadUsersWithGroups(dbClient) {
  const usersResult = await dbClient.query(
    `SELECT id, email, display_name, role, status, last_login_at, created_at
       FROM users
      ORDER BY email ASC`
  );
  const users = usersResult.rows;

  const ugResult = await dbClient.query(
    `SELECT ug.user_id, g.id AS group_id, g.name AS group_name
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
      ORDER BY g.name ASC`
  );
  const groupsByUser = new Map();
  for (const ug of ugResult.rows) {
    if (!groupsByUser.has(ug.user_id)) groupsByUser.set(ug.user_id, []);
    groupsByUser.get(ug.user_id).push({ id: ug.group_id, name: ug.group_name });
  }
  for (const u of users) {
    u.groups = groupsByUser.get(u.id) || [];
    u.groupIds = u.groups.map((g) => g.id);
  }
  return users;
}

// RBAC sobre edición de usuarios:
//  - admin no puede tocar super_admins.
//  - admin NO puede cambiar roles de nadie (ni crear ni promover admins):
//    la asignación del rol 'admin' es EXCLUSIVA de super_admin.
//  - admin puede editar datos y grupos de employees/admins.
//  - nadie puede desactivar/cambiar rol del último super_admin activo.
async function assertCanModify(dbClient, actor, target, { changingRole }) {
  if (actor.role !== 'super_admin') {
    if (target.role === 'super_admin') {
      return { allowed: false, reason: 'No puedes modificar a un super_admin.' };
    }
    if (changingRole) {
      return { allowed: false, reason: 'Solo un super_admin puede cambiar roles.' };
    }
  }
  return { allowed: true };
}

// GET /admin/users
router.get('/', async (req, res, next) => {
  try {
    const users = await loadUsersWithGroups(db);
    const groupsResult = await db.query('SELECT id, name FROM groups ORDER BY name ASC');
    res.renderPage('admin/users', {
      title: 'Usuarios',
      user: req.user,
      users,
      groups: groupsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/new
router.get('/new', async (req, res, next) => {
  try {
    const groupsResult = await db.query('SELECT id, name FROM groups ORDER BY name ASC');
    res.renderPage('admin/users-form', {
      title: 'Nuevo usuario',
      user: req.user,
      target: null,
      groups: groupsResult.rows,
      selectedGroupIds: [],
      isEdit: false,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users — crear usuario (rol employee/admin; solo super_admin crea admins extra opcionalmente).
router.post('/', async (req, res, next) => {
  try {
    const { email, display_name, role } = req.body;
    const emailNorm = (email || '').trim().toLowerCase();
    // Misma sintaxis que el flujo de login (sin exigir punto en el dominio):
    // permite dominios sin TLD (p. ej. "localhost" en desarrollo).
    if (!emailNorm || !/^[^\s@]+@[^\s@]+$/.test(emailNorm)) {
      return res.status(400).send('Email inválido.');
    }
    let roleValue = 'employee';
    if (role === 'admin') {
      if (req.user.role !== 'super_admin') {
        // P7: solo super_admin puede crear admins.
        return res.status(403).send('Solo un super_admin puede crear admins.');
      }
      roleValue = 'admin';
    }
    // No se puede crear un super_admin desde la consola; el rol se asigna
    // solo por bootstrap (email == SUPER_ADMIN_EMAIL).
    if (role === 'super_admin') {
      return res.status(403).send('No se puede crear un super_admin desde la consola.');
    }

    const exists = await db.query('SELECT id FROM users WHERE email = $1', [emailNorm]);
    if (exists.rows.length > 0) {
      return res.status(400).send('Ya existe un usuario con ese email.');
    }

    // El email debe pertenecer a los dominios de confianza EFECTIVOS
    // (settings.allowed_domains con precedencia sobre env).
    const allowedDomains = await settingsService.getAllowedDomains();
    const domain = (emailNorm.split('@')[1] || '').toLowerCase();
    if (!allowedDomains.includes(domain)) {
      await audit.logAudit(db, {
        actorId: req.user.id,
        actorEmail: req.user.email,
        action: 'user.create.rejected',
        entityType: 'user',
        entityId: emailNorm,
        details: { email: emailNorm, domain, reason: 'domain_not_allowed' },
        ip: req.ip,
      });
      return res.status(400).send('El dominio del email no está en los dominios de confianza.');
    }

    const created = await db.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3) RETURNING id`,
      [emailNorm, display_name || emailNorm.split('@')[0], roleValue]
    );
    const newUserId = created.rows[0].id;

    const groupIds = parseGroupIds(req.body.groups);
    for (const gid of groupIds) {
      await db.query(
        `INSERT INTO user_groups (user_id, group_id, assigned_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, group_id) DO NOTHING`,
        [newUserId, gid, req.user.id]
      );
    }

    await logAuditAction(req, 'user.create', 'user', newUserId, {
      email: emailNorm,
      role: roleValue,
      groups: groupIds,
    });
    return res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id/edit
router.get('/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Usuario no encontrado');
    const target = result.rows[0];
    const groupsResult = await db.query('SELECT id, name FROM groups ORDER BY name ASC');
    const ug = await db.query('SELECT group_id FROM user_groups WHERE user_id = $1', [id]);
    res.renderPage('admin/users-form', {
      title: 'Editar usuario',
      user: req.user,
      target,
      groups: groupsResult.rows,
      selectedGroupIds: ug.rows.map((r) => r.group_id),
      isEdit: true,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id — actualizar datos, rol y grupos.
router.post('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Usuario no encontrado');
    const target = result.rows[0];

    const newRole = req.body.role;
    const changingRole = !!newRole && newRole !== target.role;

    if (changingRole) {
      const check = await assertCanModify(db, req.user, target, { changingRole: true });
      if (!check.allowed) return res.status(403).send(check.reason);

      if (newRole === 'super_admin') {
        return res.status(403).send('No se puede asignar el rol super_admin desde la consola.');
      }
      if (await isLastActiveSuperAdmin(db, id)) {
        return res.status(403).send('No se puede cambiar el rol del último super_admin activo.');
      }
    }

    const displayName = (req.body.display_name || '').trim() || target.display_name;
    await db.query(
      `UPDATE users SET display_name = $1 WHERE id = $2`,
      [displayName, id]
    );

    if (changingRole) {
      const roleValue = newRole === 'admin' ? 'admin' : 'employee';
      await db.query(`UPDATE users SET role = $1 WHERE id = $2`, [roleValue, id]);
      // Cambiar el rol invalida TODAS las sesiones del usuario.
      await sessionService.bumpSessionVersion(db, id);
      await sessionService.revokeAllUserSessions(db, id);
      await logAuditAction(req, 'user.update', 'user', id, { role: roleValue, displayName });
    }

    // Actualizar grupos.
    const groupIds = parseGroupIds(req.body.groups);
    const existingUg = await db.query('SELECT group_id FROM user_groups WHERE user_id = $1', [id]);
    const existingIds = new Set(existingUg.rows.map((r) => r.group_id));
    const newIds = new Set(groupIds);
    for (const gid of groupIds) {
      if (!existingIds.has(gid)) {
        await db.query(
          `INSERT INTO user_groups (user_id, group_id, assigned_by) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, gid, req.user.id]
        );
      }
    }
    for (const gid of existingIds) {
      if (!newIds.has(gid)) {
        await db.query('DELETE FROM user_groups WHERE user_id = $1 AND group_id = $2', [id, gid]);
      }
    }

    return res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/status — activar/desactivar (revoca sesiones).
router.post('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Usuario no encontrado');
    const target = result.rows[0];

    if (req.user.role !== 'super_admin' && target.role === 'super_admin') {
      return res.status(403).send('No puedes modificar a un super_admin.');
    }
    if (await isLastActiveSuperAdmin(db, id)) {
      return res.status(403).send('No se puede desactivar al último super_admin activo.');
    }

    const newStatus = req.body.status === 'inactive' ? 'inactive' : 'active';
    if (newStatus === 'inactive') {
      await db.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [id]);
      // Desactivar invalida TODAS las sesiones del usuario.
      await sessionService.bumpSessionVersion(db, id);
      await sessionService.revokeAllUserSessions(db, id);
      await logAuditAction(req, 'user.deactivate', 'user', id, { email: target.email });
    } else {
      await db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [id]);
      await logAuditAction(req, 'user.update', 'user', id, { status: 'active' });
    }

    return res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
