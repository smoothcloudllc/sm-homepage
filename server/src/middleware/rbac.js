const db = require('../db');
const audit = require('../services/audit.service');

// requireRole('super_admin') -> solo super_admin.
// requireAnyRole(['super_admin', 'admin']) -> cualquiera de los roles.
function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.user.role)) {
      // 403 con mensaje genérico (no revela qué rol hace falta).
      if (req.path.startsWith('/admin')) {
        return res.status(403).renderPage('errors/403', {
          title: 'Acceso denegado',
          message: 'No tienes permiso para acceder a esta sección.',
          user: req.user,
        });
      }
      return res.status(403).json({ error: 'Prohibido' });
    }
    next();
  };
}

function requireRole(role) {
  return requireAnyRole([role]);
}

// Helper para obtener actor desde la sesión.
function getActor(req) {
  return req.user ? { actorId: req.user.id, actorEmail: req.user.email } : {};
}

// Registra un evento de auditoría con el actor actual y la IP del request.
async function logAuditAction(req, action, entityType, entityId, details) {
  const actor = getActor(req);
  await audit.logAudit(db, {
    ...actor,
    action,
    entityType,
    entityId,
    details,
    ip: req.ip,
  });
}

// Validación: no permitir desactivar/cambiar rol del último super_admin activo.
async function isLastActiveSuperAdmin(db, targetUserId) {
  const result = await db.query(
    `SELECT count(*)::int AS total
       FROM users
      WHERE role = 'super_admin' AND status = 'active'`
  );
  const total = result.rows[0].total;
  if (total > 1) return false;

  // total === 1: comprobar si el único super_admin activo es targetUserId.
  const target = await db.query(
    `SELECT role, status FROM users WHERE id = $1`,
    [targetUserId]
  );
  const targetRow = target.rows[0];
  return !!(targetRow && targetRow.role === 'super_admin' && targetRow.status === 'active');
}

module.exports = { requireAnyRole, requireRole, logAuditAction, getActor, isLastActiveSuperAdmin };
