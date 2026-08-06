// Regla de visibilidad con política deny-overrides:
//   - public  -> visible para cualquier usuario autenticado.
//   - restricted -> visible SOLO si al menos uno de los grupos del usuario
//                   está asignado a la app (app_group_assignments).
//
// Se implementa en dos capas:
//   1) resolveVisibleAppsId(ids de apps públicas) : capa pura y testeable.
//   2) resolveVisibleApps(db, userId) : consulta parametrizada contra BD.

// Función pura testeable.
// apps: [{ id, visibility, groupIds: [...] }]
// userGroupIds: [números]
// publicAppIds: array con los ids de las apps publicadas que se consideran visibles.
function resolveVisibleApps(apps, userGroupIds, publicAppIds = []) {
  const groups = new Set(userGroupIds);
  const publicSet = new Set(publicAppIds);

  return apps.filter((app) => {
    if (app.visibility === 'public') return publicSet.has(app.id) || publicSet.has(String(app.id));
    if (app.visibility === 'restricted') {
      const appGroupIds = Array.isArray(app.groupIds) ? app.groupIds : [];
      return appGroupIds.some((gid) => groups.has(Number(gid)) || groups.has(String(gid)));
    }
    return false;
  });
}

// Obtiene los ids de los grupos de un usuario (consulta parametrizada).
async function getUserGroupIds(db, userId) {
  const result = await db.query(
    `SELECT g.id
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = $1`,
    [userId]
  );
  return result.rows.map((r) => r.id);
}

// Obtiene los grupos de un usuario (con nombre) para mostrarlos en la UI.
async function getUserGroups(db, userId) {
  const result = await db.query(
    `SELECT g.id, g.name
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = $1
      ORDER BY g.name ASC`,
    [userId]
  );
  return result.rows;
}

// Consulta de visibilidad parametrizada.
// Devuelve las apps visibles para el usuario (con los datos para la UI).
// Trae categories.name como category_name (agrupado del dashboard).
async function resolveVisibleAppsDb(db, userId) {
  const groupIds = await getUserGroupIds(db, userId);
  const result = await db.query(
    `SELECT DISTINCT a.*, c.name AS category_name
       FROM apps a
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.visibility = 'public'
         OR (a.visibility = 'restricted'
             AND EXISTS (
               SELECT 1
                 FROM app_group_assignments aga
                WHERE aga.app_id = a.id
                  AND aga.group_id = ANY($1::int[])
             ))
      ORDER BY c.name ASC, a.name ASC`,
    [groupIds.length > 0 ? groupIds : [-1]]
  );
  return result.rows;
}

// Modo anónimo: SOLO apps públicas (sin filtrar por grupos).
// Nunca expone nombres/URLs de apps restricted.
async function resolvePublicAppsDb(db) {
  const result = await db.query(
    `SELECT a.*, c.name AS category_name
       FROM apps a
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.visibility = 'public'
      ORDER BY c.name ASC, a.name ASC`
  );
  return result.rows;
}

// Booleano: ¿existe al menos una app restricted en el portal?
// Se usa en el dashboard anónimo para mostrar (sin revelar nombres) el
// bloque "Inicia sesión para ver aplicaciones privadas" solo si tiene sentido.
async function hasRestrictedApps(db) {
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM apps WHERE visibility = 'restricted'
     ) AS has`
  );
  return result.rows[0] ? !!result.rows[0].has : false;
}

// ¿Tiene el usuario acceso al CONTENIDO de una app concreta (p. ej. su icono
// subido, U-4)? Misma política deny-overrides que el dashboard:
//   - public      -> true para cualquiera.
//   - restricted  -> true solo si al menos uno de los grupos del usuario está
//                    asignado a la app (app_group_assignments JOIN user_groups).
// Devuelve null si la app no existe.
async function canUserAccessApp(db, userId, appId) {
  const result = await db.query('SELECT id, visibility FROM apps WHERE id = $1', [appId]);
  const app = result.rows[0];
  if (!app) return null;
  if (app.visibility === 'public') return true;
  const groupIds = await getUserGroupIds(db, userId);
  if (groupIds.length === 0) return false;
  const assigned = await db.query(
    `SELECT 1 FROM app_group_assignments
      WHERE app_id = $1 AND group_id = ANY($2::int[])`,
    [appId, groupIds]
  );
  return assigned.rows.length > 0;
}

// Para la consola admin: catálogo completo de apps con sus grupos asignados.
// Trae categories.name como category_name (columna Categoría de la consola).
async function listAppsWithGroups(db) {
  const appsResult = await db.query(
    `SELECT a.*, c.name AS category_name
       FROM apps a
       LEFT JOIN categories c ON c.id = a.category_id
      ORDER BY a.name ASC`
  );
  const apps = appsResult.rows;

  const assignmentsResult = await db.query(
    `SELECT aga.app_id, g.id AS group_id, g.name AS group_name
       FROM app_group_assignments aga
       JOIN groups g ON g.id = aga.group_id
      ORDER BY g.name ASC`
  );
  const assignmentsByApp = new Map();
  for (const a of assignmentsResult.rows) {
    if (!assignmentsByApp.has(a.app_id)) assignmentsByApp.set(a.app_id, []);
    assignmentsByApp.get(a.app_id).push({ id: a.group_id, name: a.group_name });
  }
  for (const app of apps) {
    app.groups = assignmentsByApp.get(app.id) || [];
    app.groupIds = (app.groups || []).map((g) => g.id);
  }
  return apps;
}

module.exports = {
  resolveVisibleApps,
  getUserGroupIds,
  getUserGroups,
  resolveVisibleAppsDb,
  resolvePublicAppsDb,
  hasRestrictedApps,
  canUserAccessApp,
  listAppsWithGroups,
};
