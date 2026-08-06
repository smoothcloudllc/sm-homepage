// Servicio de categorías (agrupación gestionable de aplicaciones).
//
// - Seed idempotente de categorías por defecto en el arranque.
// - Migración/backfill idempotente de apps.category (texto legacy) a
//   category_id (FK a categories). Apps con categoría vacía/desconocida se
//   asignan a 'General'.
// - CRUD con validación estricta del nombre (CITEXT único) y protección de
//   la categoría 'General'.

const audit = require('./audit.service');

const DEFAULT_CATEGORIES = ['General', 'Herramientas', 'Finanzas', 'DevOps', 'Comunicación', 'Productividad'];

const NAME_MAX_LENGTH = 80;

// Normaliza un nombre: trim + colapso de espacios internos.
function normalizeCategoryName(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/\s+/g, ' ');
}

// Validación de nombre para crear/renombrar. Los caracteres de control y los
// saltos de línea se rechazan SIEMPRE (XSS / inyección de formato).
function validateCategoryName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'El nombre es obligatorio.' };
  }
  if (!raw.trim()) {
    return { ok: false, error: 'El nombre es obligatorio.' };
  }
  if (/[\x00-\x1F\x7F]/.test(raw)) {
    return { ok: false, error: 'El nombre no puede contener caracteres de control ni saltos de línea.' };
  }
  const name = normalizeCategoryName(raw);
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `El nombre no puede superar los ${NAME_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, name };
}

// Crea una categoría si no existe (case-insensitive vía CITEXT) y devuelve su id.
async function ensureCategory(db, name, actorId) {
  const created = await db.query(
    `INSERT INTO categories (name, created_by) VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [name, actorId || null]
  );
  if (created.rows && created.rows[0]) return created.rows[0].id;
  const existing = await db.query('SELECT id FROM categories WHERE name = $1', [name]);
  return existing.rows[0].id;
}

// Seed idempotente de las categorías por defecto. Audita SOLO cuando crea
// alguna categoría nueva (no inunda audit_log en cada arranque).
async function seedCategories(db) {
  const inserted = [];
  for (const name of DEFAULT_CATEGORIES) {
    const res = await db.query(
      `INSERT INTO categories (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [name]
    );
    if (res.rows && res.rows[0]) inserted.push(name);
  }
  if (inserted.length > 0) {
    await audit.logAudit(db, {
      action: 'categories.seed',
      entityType: 'category',
      details: { names: inserted },
    });
  }
  return inserted;
}

// Migración de datos existentes (idempotente): apps.category (texto) ->
// category_id. Solo actúa si existe algún app con category_id IS NULL.
//
//  1) Inventario (dry-run en logs): SELECT category, count(*) GROUP BY.
//  2) Normalización NO ambigua: trim + colapso de espacios + búsqueda
//     case-insensitive en categories. Variaciones léxicas (p.ej. 'DevOps'
//     vs 'Dev-Ops') NO se fusionan: se crean como categorías distintas.
//  3) Backfill: UPDATE apps SET category_id WHERE category_id IS NULL AND
//     category coincide con la forma normalizada (case-insensitive).
//  4) Apps sin categoría / vacía / desconocida -> General.
//  5) Assert: 0 apps con category_id NULL (si alguna quedara, se reasigna
//     a General) y SET NOT NULL (DO block, solo si no hay NULLs).
async function backfillCategories(db) {
  const inventory = await db.query(
    `SELECT category, count(*)::int AS n
       FROM apps
      GROUP BY category
      ORDER BY category ASC`
  );
  const rows = inventory.rows || [];
  console.log('[categories] Inventario de apps.category (dry-run antes de backfill):');
  for (const r of rows) {
    console.log(`  - ${r.category === null || r.category === undefined ? '(NULL)' : r.category}: ${r.n}`);
  }

  const generalId = await ensureCategory(db, 'General', null);

  // Valores normalizados distintos (sin vacíos: esos van a General).
  // C-1: cada nombre legacy se filtra con la MISMA validación del CRUD
  // (validateCategoryName: trim, no vacío, <=80 chars, sin caracteres de
  // control/saltos — evaluado sobre el valor legacy crudo, antes de
  // normalizar, para que un '\n' o '\u0000' se rechace). Los inválidos NO se
  // crean como categoría: la app cae a 'General' (los UPDATE de abajo se
  // ocupan de las apps que quedan con category_id NULL).
  const distinct = [];
  const invalidToGeneral = [];
  for (const r of rows) {
    if (r.category == null || r.category === '') continue;
    const v = validateCategoryName(r.category);
    if (!v.ok) {
      const raw = String(r.category);
      if (!invalidToGeneral.includes(raw)) invalidToGeneral.push(raw);
      continue;
    }
    const normalized = v.name;
    if (!distinct.includes(normalized)) distinct.push(normalized);
  }
  if (invalidToGeneral.length > 0) {
    console.log(`[categories] Nombres legacy inválidos reasignados a General: ${invalidToGeneral.length}`);
  }

  const matched = [];
  for (const normalized of distinct) {
    const catId = await ensureCategory(db, normalized, null);
    const up = await db.query(
      `UPDATE apps
          SET category_id = $1
        WHERE category_id IS NULL
          AND lower(btrim(regexp_replace(category, '\\s+', ' ', 'g'))) = lower($2)`,
      [catId, normalized]
    );
    if ((up.rowCount || 0) > 0) {
      matched.push({ categoryId: catId, categoryName: normalized, apps: up.rowCount });
      await audit.logAudit(db, {
        action: 'apps.category_assign',
        entityType: 'app',
        entityId: null,
        details: { categoryId: catId, categoryName: normalized, apps: up.rowCount },
      });
    }
  }

  // Apps con categoría vacía/NULL/desconocida -> General.
  const nulls = await db.query('UPDATE apps SET category_id = $1 WHERE category_id IS NULL', [generalId]);
  if ((nulls.rowCount || 0) > 0) {
    await audit.logAudit(db, {
      action: 'apps.category_assign',
      entityType: 'app',
      entityId: null,
      details: { categoryId: generalId, categoryName: 'General', apps: nulls.rowCount },
    });
  }

  // Assert: 0 apps con category_id NULL tras el backfill.
  const left = await db.query('SELECT count(*)::int AS n FROM apps WHERE category_id IS NULL');
  if ((left.rows[0] && left.rows[0].n) > 0) {
    await db.query('UPDATE apps SET category_id = $1 WHERE category_id IS NULL', [generalId]);
  }

  // SET NOT NULL solo si no quedan NULLs (DO block idempotente).
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM apps WHERE category_id IS NULL) THEN
        ALTER TABLE apps ALTER COLUMN category_id SET NOT NULL;
      END IF;
    END $$;`);

  return { inventory: rows, matched, invalidToGeneral, generalId };
}

// Lista simple (id, name) para formularios, ordenada alfabéticamente.
async function listCategories(db) {
  const result = await db.query('SELECT id, name FROM categories ORDER BY name ASC');
  return result.rows;
}

// Lista con nº de apps por categoría (para la vista de administración).
async function listCategoriesWithCounts(db) {
  const result = await db.query(
    `SELECT c.id, c.name, c.created_at,
            count(a.id)::int AS app_count
       FROM categories c
       LEFT JOIN apps a ON a.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC`
  );
  return result.rows;
}

// Id de una categoría por nombre (case-insensitive, CITEXT).
async function getCategoryIdByName(db, name) {
  const result = await db.query('SELECT id FROM categories WHERE name = $1', [name]);
  return result.rows[0] ? result.rows[0].id : null;
}

// Crea una categoría. Devuelve { ok: true, id, name } o { ok: false, error }.
async function createCategory(db, rawName, actorId) {
  const v = validateCategoryName(rawName);
  if (!v.ok) return v;
  try {
    const created = await db.query(
      `INSERT INTO categories (name, created_by) VALUES ($1, $2) RETURNING id`,
      [v.name, actorId || null]
    );
    return { ok: true, id: created.rows[0].id, name: v.name };
  } catch (err) {
    if (err.code === '23505') return { ok: false, error: 'Ya existe una categoría con ese nombre.' };
    throw err;
  }
}

// Renombra una categoría. Devuelve { ok } o { ok:false, error }.
async function renameCategory(db, id, rawName, actorId) {
  const v = validateCategoryName(rawName);
  if (!v.ok) return v;
  const existing = await db.query('SELECT id, name FROM categories WHERE id = $1', [id]);
  if (existing.rows.length === 0) return { ok: false, status: 404, error: 'Categoría no encontrada.' };
  if (String(existing.rows[0].name).toLowerCase() === 'general' && v.name.toLowerCase() !== 'general') {
    return { ok: false, error: 'La categoría General no se puede renombrar.' };
  }
  try {
    await db.query('UPDATE categories SET name = $1 WHERE id = $2', [v.name, id]);
    return { ok: true, id, name: v.name };
  } catch (err) {
    if (err.code === '23505') return { ok: false, error: 'Ya existe una categoría con ese nombre.' };
    throw err;
  }
}

// Borra una categoría. Si tiene apps y no se pide reassign -> 400.
// Con reassign=true reasigna TODAS sus apps a 'General' y la borra, en UNA
// transacción (conWithTransaction). 'General' nunca se puede borrar.
async function deleteCategory(db, id, { reassign = false, withTransaction, getClient } = {}) {
  const cat = await db.query('SELECT id, name FROM categories WHERE id = $1', [id]);
  if (cat.rows.length === 0) return { ok: false, status: 404, error: 'Categoría no encontrada.' };
  const name = String(cat.rows[0].name);
  if (name.toLowerCase() === 'general') {
    return { ok: false, status: 400, error: 'La categoría General está protegida y no se puede borrar.' };
  }
  const inUse = await db.query('SELECT count(*)::int AS n FROM apps WHERE category_id = $1', [id]);
  const used = inUse.rows[0] ? inUse.rows[0].n : 0;
  if (used > 0 && !reassign) {
    return {
      ok: false,
      status: 400,
      error: `La categoría tiene ${used} ${used === 1 ? 'aplicación' : 'aplicaciones'}. Usa la opción "reasignar a General" para borrarla.`,
    };
  }

  if (reassign) {
    const generalId = await getCategoryIdByName(db, 'General');
    if (!generalId) return { ok: false, error: 'Falta la categoría General (seed).' };
    const tx = withTransaction || (async (fn) => fn(db));
    await tx(async (client) => {
      await client.query('UPDATE apps SET category_id = $1 WHERE category_id = $2', [generalId, id]);
      await client.query('DELETE FROM categories WHERE id = $1', [id]);
    });
  } else {
    await db.query('DELETE FROM categories WHERE id = $1', [id]);
  }
  return { ok: true, name, reassigned: reassign };
}

module.exports = {
  DEFAULT_CATEGORIES,
  NAME_MAX_LENGTH,
  normalizeCategoryName,
  validateCategoryName,
  ensureCategory,
  seedCategories,
  backfillCategories,
  listCategories,
  listCategoriesWithCounts,
  getCategoryIdByName,
  createCategory,
  renameCategory,
  deleteCategory,
};
