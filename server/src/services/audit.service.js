// Servicio de auditoría append-only. No existe ningún endpoint de borrado;
// solo lectura para super_admin en /admin/audit con paginación simple.

async function logAudit(db, { actorId, actorEmail, action, entityType, entityId, details, ip }) {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
    [
      actorId || null,
      actorEmail || null,
      action,
      entityType || null,
      entityId != null ? String(entityId) : null,
      details && typeof details === 'object' ? JSON.stringify(details) : null,
      ip || null,
    ]
  );
}

async function listAudit(db, { page = 1, pageSize = 25 } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize;
  const countResult = await db.query('SELECT count(*)::int AS total FROM audit_log');
  const total = countResult.rows[0].total;
  const result = await db.query(
    `SELECT id, actor_id, actor_email, action, entity_type, entity_id, details, ip, created_at
       FROM audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  return {
    rows: result.rows,
    total,
    page: Math.max(1, page),
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

module.exports = { logAudit, listAudit };
