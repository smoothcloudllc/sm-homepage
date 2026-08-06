// Base de datos falsa en memoria para los tests. Imita la API de pg
// (query(text, params) -> { rows, rowCount }) enrutando por subcadenas SQL.
class FakeDb {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.otpCodes = [];
    this.loginAttempts = new Map();
    this.auditLog = [];
    this.groups = [];
    this.userGroups = [];
    this.apps = [];
    this.appGroupAssignments = [];
    this.settings = new Map();
    this.bootstrapTokens = new Map();
    this.categories = [];
    this.sequence = { users: 1, sessions: 1, otp: 1, audit: 1 };
  }

  async query(text, params = []) {
    // -------- usuarios --------
    if (text.includes('count(*)::int AS total') && text.includes('FROM users')) {
      let rows = this.users;
      if (text.includes("role = 'super_admin'")) {
        rows = rows.filter((u) => u.role === 'super_admin');
        if (text.includes("status = 'active'")) {
          rows = rows.filter((u) => u.status === 'active');
        }
      }
      return { rows: [{ total: rows.length }], rowCount: 1 };
    }

    if (text.includes('SELECT id, email, display_name, role, status, last_login_at, created_at')) {
      const rows = [...this.users].sort((a, b) => a.email.localeCompare(b.email));
      return { rows, rowCount: rows.length };
    }

    if (/^SELECT \* FROM users WHERE email = \$1/.test(text.trim())) {
      const rows = this.users.filter((u) => u.email === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (/^SELECT \* FROM users WHERE id = \$1/.test(text.trim())) {
      const rows = this.users.filter((u) => u.id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (/^SELECT id FROM users WHERE email = \$1/.test(text.trim())) {
      const rows = this.users.filter((u) => u.email === params[0]).map((u) => ({ id: u.id }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT role, status FROM users WHERE id = $1')) {
      const row = this.users.find((u) => u.id === params[0]);
      return { rows: row ? [{ role: row.role, status: row.status }] : [], rowCount: row ? 1 : 0 };
    }

    if (text.startsWith('INSERT INTO users')) {
      const id = this.sequence.users++;
      const email = params[0];
      const row = {
        id,
        email,
        display_name: params[1],
        role: params[2],
        status: 'active',
        session_version: 0,
        last_login_at: null,
        created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes('UPDATE users SET last_login_at = now()')) {
      const row = this.users.find((u) => u.id === params[0]);
      if (row) row.last_login_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE users SET display_name = $1')) {
      const row = this.users.find((u) => u.id === params[1]);
      if (row) row.display_name = params[0];
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE users SET role = $1')) {
      const row = this.users.find((u) => u.id === params[1]);
      if (row) row.role = params[0];
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("UPDATE users SET status = 'inactive'")) {
      const row = this.users.find((u) => u.id === params[0]);
      if (row) row.status = 'inactive';
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("UPDATE users SET status = 'active'")) {
      const row = this.users.find((u) => u.id === params[0]);
      if (row) row.status = 'active';
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE users SET session_version = session_version + 1')) {
      const row = this.users.find((u) => u.id === params[0]);
      if (row) {
        row.session_version += 1;
        return { rows: [{ session_version: row.session_version }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // -------- sesiones --------
    if (text.startsWith('INSERT INTO sessions') && text.includes('SELECT user_id, $2')) {
      // Rotación deslizante: copia la sesión antigua con token nuevo.
      const oldId = params[0];
      const newHash = params[1];
      const old = this.sessions.find((x) => x.id === oldId);
      if (!old) return { rows: [], rowCount: 0 };
      const row = {
        id: `sess-${this.sequence.sessions++}`,
        token_hash: newHash,
        user_id: old.user_id,
        session_version_enrolled: old.session_version_enrolled,
        expires_at: old.expires_at,
        created_at: new Date(),
        revoked_at: null,
        ip: old.ip,
        user_agent: old.user_agent,
      };
      this.sessions.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (text.startsWith('INSERT INTO sessions')) {
      const tokenHash = params[1];
      const row = {
        id: `sess-${this.sequence.sessions++}`,
        token_hash: tokenHash,
        user_id: params[0],
        session_version_enrolled: params[2],
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
        created_at: new Date(),
        revoked_at: null,
        ip: params[4] || null,
        user_agent: params[5] || null,
      };
      this.sessions.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes('SELECT s.id AS session_id')) {
      const tokenHash = params[0];
      const s = this.sessions.find((x) => x.token_hash === tokenHash);
      if (!s) return { rows: [], rowCount: 0 };
      const u = this.users.find((x) => x.id === s.user_id);
      if (!u) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            session_id: s.id,
            user_id: u.id,
            session_version_enrolled: s.session_version_enrolled,
            expires_at: s.expires_at,
            created_at: s.created_at,
            revoked_at: s.revoked_at,
            email: u.email,
            display_name: u.display_name,
            role: u.role,
            status: u.status,
            session_version: u.session_version,
          },
        ],
        rowCount: 1,
      };
    }

    if (text.includes('UPDATE sessions SET revoked_at = now() WHERE id = $1')) {
      const s = this.sessions.find((x) => x.id === params[0]);
      if (s && !s.revoked_at) s.revoked_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE sessions SET revoked_at = now() WHERE token_hash')) {
      const s = this.sessions.find((x) => x.token_hash === params[0]);
      if (s && !s.revoked_at) s.revoked_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE sessions SET revoked_at = now() WHERE user_id')) {
      this.sessions.forEach((s) => {
        if (s.user_id === params[0] && !s.revoked_at) s.revoked_at = new Date();
      });
      return { rows: [], rowCount: 1 };
    }

    // -------- OTP --------
    if (text.includes('UPDATE otp_codes') && text.includes('consumed_at = now()') && text.includes('WHERE id = $1')) {
      const row = this.otpCodes.find((x) => x.id === params[0]);
      if (row && !row.consumed_at && new Date(row.expires_at) > new Date()) {
        row.consumed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('UPDATE otp_codes') && text.includes('consumed_at = now()') && text.includes('WHERE email = $1')) {
      const [email, purpose] = params;
      let n = 0;
      this.otpCodes.forEach((x) => {
        if (x.email === email && x.purpose === purpose && !x.consumed_at && new Date(x.expires_at) > new Date()) {
          x.consumed_at = new Date();
          n += 1;
        }
      });
      return { rows: [], rowCount: n };
    }

    if (text.startsWith('INSERT INTO otp_codes')) {
      const [email, codeHash, purpose, mins] = params;
      const row = {
        id: this.sequence.otp++,
        email,
        code_hash: codeHash,
        purpose,
        expires_at: new Date(Date.now() + mins * 60000),
        consumed_at: null,
        created_at: new Date(),
      };
      this.otpCodes.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes('SELECT id, code_hash, expires_at') && text.includes('ORDER BY created_at DESC, id DESC')) {
      const [email, purpose] = params;
      const candidates = this.otpCodes
        .filter((x) => x.email === email && x.purpose === purpose && !x.consumed_at && new Date(x.expires_at) > new Date())
        .sort((a, b) => b.id - a.id);
      return { rows: candidates.slice(0, 1), rowCount: candidates.length };
    }

    // -------- login_attempts --------
    if (text.startsWith('SELECT failed_count, locked_until FROM login_attempts')) {
      const row = this.loginAttempts.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('INSERT INTO login_attempts (email, failed_count)')) {
      this.loginAttempts.set(params[0], { failed_count: 0, locked_until: null });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('INSERT INTO login_attempts (email, failed_count, last_attempt_at)')) {
      const [email, nextCount, threshold, lockoutMin] = params;
      const prev = this.loginAttempts.get(email) || { failed_count: 0, locked_until: null };
      const failedCount = prev.failed_count + 1;
      const next = {
        failed_count: failedCount,
        locked_until: lockoutMin > 0 ? new Date(Date.now() + lockoutMin * 60000) : prev.locked_until,
      };
      this.loginAttempts.set(email, next);
      return { rows: [next], rowCount: 1 };
    }

    // -------- auditoría --------
    if (text.startsWith('INSERT INTO audit_log')) {
      const id = this.sequence.audit++;
      this.auditLog.push({
        id,
        actor_id: params[0],
        actor_email: params[1],
        action: params[2],
        entity_type: params[3],
        entity_id: params[4],
        details: params[5] ? JSON.parse(params[5]) : null,
        ip: params[6],
        created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('SELECT count(*)::int AS total FROM audit_log')) {
      return { rows: [{ total: this.auditLog.length }], rowCount: 1 };
    }

    if (text.includes('SELECT id, actor_id, actor_email, action, entity_type, entity_id, details, ip, created_at')) {
      const pageSize = params[0];
      const offset = params[1];
      const rows = [...this.auditLog].reverse().slice(offset, offset + pageSize);
      return { rows, rowCount: rows.length };
    }

    // -------- grupos --------
    if (text.includes('SELECT id, name FROM groups')) {
      return { rows: [...this.groups], rowCount: this.groups.length };
    }

    if (text.includes('SELECT g.id, g.name')) {
      return { rows: [...this.groups], rowCount: this.groups.length };
    }

    if (text.includes('FROM user_groups ug')) {
      return { rows: [...this.userGroups], rowCount: this.userGroups.length };
    }

    // -------- apps (dashboard / admin) --------
    // resolveVisibleAppsDb: deny-overrides. Filtra por visibilidad y por los
    // groupIds del usuario (params[0]) para apps restricted. Ordena por
    // category_name y nombre (espejo del ORDER BY real).
    if (text.includes('SELECT DISTINCT a.*')) {
      const groupIds = Array.isArray(params[0]) ? params[0].map(Number) : [-1];
      const rows = this.apps.filter((a) => {
        if (a.visibility === 'public') return true;
        if (a.visibility === 'restricted') {
          const appGroups = Array.isArray(a.groupIds) ? a.groupIds.map(Number) : [];
          return appGroups.some((g) => groupIds.includes(g));
        }
        return false;
      });
      rows.sort((x, y) => {
        const cx = String(x.category_name || x.category || '').localeCompare(String(y.category_name || y.category || ''));
        if (cx !== 0) return cx;
        return String(x.name || '').localeCompare(String(y.name || ''));
      });
      return { rows, rowCount: rows.length };
    }

    // resolvePublicAppsDb: SOLO apps públicas (modo anónimo). Ordena como el SQL.
    if (text.includes('WHERE a.visibility')) {
      const rows = this.apps.filter((a) => a.visibility === 'public');
      rows.sort((x, y) => {
        const cx = String(x.category_name || x.category || '').localeCompare(String(y.category_name || y.category || ''));
        if (cx !== 0) return cx;
        return String(x.name || '').localeCompare(String(y.name || ''));
      });
      return { rows, rowCount: rows.length };
    }

    // hasRestrictedApps: ¿existe alguna app restricted?
    if (text.includes('SELECT EXISTS')) {
      const has = this.apps.some((a) => a.visibility === 'restricted');
      return { rows: [{ has }], rowCount: 1 };
    }

    // listAppsWithGroups (consola admin): JOIN con categories (category_name).
    if (text.includes('SELECT a.*, c.name AS category_name') && text.includes('ORDER BY a.name ASC')) {
      return { rows: [...this.apps], rowCount: this.apps.length };
    }

    if (text.includes('SELECT id FROM apps WHERE id = $1')) {
      const rows = this.apps.filter((a) => a.id === params[0]).map((a) => ({ id: a.id }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT * FROM apps WHERE id = $1')) {
      const rows = this.apps.filter((a) => a.id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT id, visibility FROM apps WHERE id = $1')) {
      const app = this.apps.find((a) => a.id === params[0]);
      return { rows: app ? [{ id: app.id, visibility: app.visibility }] : [], rowCount: app ? 1 : 0 };
    }

    if (text.includes('SELECT group_id FROM app_group_assignments WHERE app_id = $1')) {
      const rows = this.appGroupAssignments.filter((a) => a.app_id === params[0]).map((a) => ({ group_id: a.group_id }));
      return { rows, rowCount: rows.length };
    }

    // canUserAccessApp (U-4): ¿el grupo del usuario está asignado a la app?
    if (text.includes('SELECT 1 FROM app_group_assignments')) {
      const [appId, groupIds] = params;
      const ids = Array.isArray(groupIds) ? groupIds.map(Number) : [];
      const rows = this.appGroupAssignments.filter(
        (a) => Number(a.app_id) === Number(appId) && ids.includes(Number(a.group_id))
      );
      return { rows, rowCount: rows.length };
    }

    if (text.includes('DELETE FROM app_group_assignments')) {
      const before = this.appGroupAssignments.length;
      this.appGroupAssignments = this.appGroupAssignments.filter((a) => a.app_id !== params[0]);
      return { rows: [], rowCount: before - this.appGroupAssignments.length };
    }

    if (text.startsWith('INSERT INTO apps')) {
      const id = this.sequence.apps !== undefined ? ++this.sequence.apps : (this.sequence.apps = 1);
      const app = {
        id,
        name: params[0],
        url: params[1],
        icon_url: params[2],
        icon_key: params[3],
        icon_class: params[4],
        description: params[5],
        category: params[6],
        color: params[7],
        visibility: params[8],
        created_by: params[9],
        category_id: params[10],
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.apps.push(app);
      return { rows: [app], rowCount: 1 };
    }

    if (text.includes('UPDATE apps') && text.includes('icon_url = $1, icon_key = NULL')) {
      const app = this.apps.find((a) => a.id === params[1]);
      if (app) {
        app.icon_url = params[0];
        app.icon_key = null;
        app.updated_at = new Date();
      }
      return { rows: [], rowCount: app ? 1 : 0 };
    }

    if (text.includes('UPDATE apps') && text.includes('SET name = $1, url = $2')) {
      const app = this.apps.find((a) => a.id === params[10]);
      if (app) {
        app.name = params[0];
        app.url = params[1];
        app.icon_url = params[2];
        app.icon_key = params[3];
        app.icon_class = params[4];
        app.description = params[5];
        app.category = params[6];
        app.color = params[7];
        app.visibility = params[8];
        app.category_id = params[9];
        app.updated_at = new Date();
      }
      return { rows: [], rowCount: app ? 1 : 0 };
    }

    if (text.startsWith('DELETE FROM apps')) {
      const before = this.apps.length;
      this.apps = this.apps.filter((a) => a.id !== params[0]);
      return { rows: [], rowCount: before - this.apps.length };
    }

    // -------- categorías --------
    if (text.includes('SELECT c.id, c.name, c.created_at') && text.includes('count(a.id)::int AS app_count')) {
      const rows = [...this.categories]
        .sort((x, y) => String(x.name).localeCompare(String(y.name)))
        .map((c) => ({
          id: c.id,
          name: c.name,
          created_at: c.created_at,
          app_count: this.apps.filter((a) => a.category_id === c.id).length,
        }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT id, name FROM categories ORDER BY name ASC')) {
      const rows = [...this.categories].sort((x, y) => String(x.name).localeCompare(String(y.name)));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT id, name FROM categories WHERE id = $1')) {
      const rows = this.categories.filter((c) => c.id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT id FROM categories WHERE id = $1')) {
      const rows = this.categories.filter((c) => c.id === params[0]).map((c) => ({ id: c.id }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('SELECT id FROM categories WHERE name = $1')) {
      const rows = this.categories
        .filter((c) => String(c.name).toLowerCase() === String(params[0]).toLowerCase())
        .map((c) => ({ id: c.id }));
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith('INSERT INTO categories')) {
      const dup = this.categories.some((c) => String(c.name).toLowerCase() === String(params[0]).toLowerCase());
      if (dup) {
        // ON CONFLICT DO NOTHING: RETURNING vacío. Sin RETURNING -> no-op.
        if (text.includes('ON CONFLICT') && text.includes('DO NOTHING')) {
          return { rows: [], rowCount: 0 };
        }
        const err = new Error('duplicate key value violates unique constraint "categories_name_key"');
        err.code = '23505';
        throw err;
      }
      const id = this.sequence.categories !== undefined ? ++this.sequence.categories : (this.sequence.categories = 1);
      const row = {
        id,
        name: params[0],
        created_by: params[1] || null,
        created_at: new Date(),
      };
      this.categories.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes('UPDATE categories SET name = $1')) {
      const cat = this.categories.find((c) => c.id === params[1]);
      if (cat) {
        const dup = this.categories.some(
          (c) => c.id !== params[1] && String(c.name).toLowerCase() === String(params[0]).toLowerCase()
        );
        if (dup) {
          const err = new Error('duplicate key value violates unique constraint "categories_name_key"');
          err.code = '23505';
          throw err;
        }
        cat.name = params[0];
      }
      return { rows: [], rowCount: cat ? 1 : 0 };
    }

    if (text.startsWith('DELETE FROM categories')) {
      const before = this.categories.length;
      this.categories = this.categories.filter((c) => c.id !== params[0]);
      return { rows: [], rowCount: before - this.categories.length };
    }

    if (text.includes('SELECT count(*)::int AS n FROM apps WHERE category_id = $1')) {
      const n = this.apps.filter((a) => a.category_id === params[0]).length;
      return { rows: [{ n }], rowCount: 1 };
    }

    if (text.includes('UPDATE apps SET category_id = $1 WHERE category_id = $2')) {
      const affected = this.apps.filter((a) => a.category_id === params[1]);
      affected.forEach((a) => { a.category_id = params[0]; });
      return { rows: [], rowCount: affected.length };
    }

    // -------- migración de categorías (backfill) --------
    if (text.includes('SELECT category, count(*)::int AS n') && text.includes('GROUP BY category')) {
      const counts = {};
      this.apps.forEach((a) => {
        const key = a.category == null ? '(NULL)' : a.category;
        counts[key] = (counts[key] || 0) + 1;
      });
      const rows = Object.entries(counts).map(([category, n]) => ({ category: category === '(NULL)' ? null : category, n }));
      rows.sort((x, y) => String(x.category).localeCompare(String(y.category)));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('UPDATE apps') && text.includes('category_id IS NULL') && text.includes('btrim(regexp_replace')) {
      const catId = params[0];
      const normalized = String(params[1]).toLowerCase();
      const affected = this.apps.filter((a) => {
        if (a.category_id != null) return false;
        const value = String(a.category == null ? '' : a.category).trim().replace(/\s+/g, ' ').toLowerCase();
        return value === normalized;
      });
      affected.forEach((a) => { a.category_id = catId; });
      return { rows: [], rowCount: affected.length };
    }

    if (text.includes('UPDATE apps') && text.includes('category_id IS NULL') && !text.includes('btrim(regexp_replace')) {
      const catId = params[0];
      const affected = this.apps.filter((a) => a.category_id == null);
      affected.forEach((a) => { a.category_id = catId; });
      return { rows: [], rowCount: affected.length };
    }

    if (text.includes('SELECT count(*)::int AS n FROM apps WHERE category_id IS NULL')) {
      const n = this.apps.filter((a) => a.category_id == null).length;
      return { rows: [{ n }], rowCount: 1 };
    }

    // Transacciones y DO blocks (FakeDb no tiene transacciones reales).
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) {
      return { rows: [], rowCount: 1 };
    }
    if (text.trim().startsWith('DO $$')) {
      return { rows: [], rowCount: 1 };
    }

    // -------- settings --------
    if (text.includes('count(*)::int AS total') && text.includes('FROM settings')) {
      return { rows: [{ total: this.settings.size }], rowCount: 1 };
    }

    if (text.includes('SELECT key, value FROM settings')) {
      const rows = Array.from(this.settings.entries()).map(([key, value]) => ({ key, value }));
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith('INSERT INTO settings')) {
      this.settings.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }

    // -------- app_group_assignments (grupos por app, filtro de chips) --------
    if (text.includes('SELECT aga.app_id, g.name AS group_name')) {
      const appIds = Array.isArray(params[0]) ? params[0].map(Number) : [];
      const rows = this.appGroupAssignments
        .filter((a) => appIds.includes(Number(a.app_id)))
        .map((a) => ({ app_id: a.app_id, group_name: a.group_name }));
      return { rows, rowCount: rows.length };
    }

    // listAppsWithGroups (consola admin): JOIN app_group_assignments con groups.
    if (text.includes('aga.app_id, g.id AS group_id')) {
      const rows = this.appGroupAssignments.map((a) => ({
        app_id: a.app_id,
        group_id: a.group_id != null ? a.group_id : null,
        group_name: a.group_name,
      }));
      return { rows, rowCount: rows.length };
    }

    // -------- usuarios activos por dominio (anti-lockout settings) --------
    if (text.includes('split_part(email, \'@\', 2) AS domain')) {
      const counts = {};
      this.users.forEach((u) => {
        if (u.status === 'active') {
          const domain = String(u.email || '').split('@')[1] || '';
          counts[domain] = (counts[domain] || 0) + 1;
        }
      });
      const rows = Object.entries(counts)
        .map(([domain, n]) => ({ domain, n }))
        .sort((a, b) => a.domain.localeCompare(b.domain));
      return { rows, rowCount: rows.length };
    }

    // -------- bootstrap_tokens --------
    if (text.includes('INSERT INTO bootstrap_tokens')) {
      this.bootstrapTokens.set(params[0], true);
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('DELETE FROM bootstrap_tokens')) {
      const removed = this.bootstrapTokens.delete(params[0]);
      return { rows: [], rowCount: removed ? 1 : 0 };
    }

    throw new Error(`FakeDb: sin manejador para SQL: ${text}`);
  }
}

module.exports = { FakeDb };
