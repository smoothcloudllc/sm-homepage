import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R4: filtro de grupos (chips) combinado AND con el texto del buscador.
// La función pura se exporta desde spotlight.js para testearla sin DOM.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let sessionService;
let matchesAppFilter;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  const spotlight = await import('../src/public/js/spotlight.js');
  matchesAppFilter = spotlight.matchesAppFilter || spotlight.default.matchesAppFilter;
});

const app = { name: 'CRM Ventas', description: 'Gestión comercial', category: 'Ventas', groups: ['Ventas', 'TI'] };
const otra = { name: 'Bugs', description: 'Seguimiento de incidencias', category: 'Desarrollo', groups: ['TI'] };

describe('matchesAppFilter (función pura)', () => {
  it('grupo "all" muestra cualquier app', () => {
    expect(matchesAppFilter(app, { group: 'all' })).toBe(true);
    expect(matchesAppFilter(otra, { group: 'all' })).toBe(true);
  });

  it('filtra por grupo (AND)', () => {
    expect(matchesAppFilter(app, { group: 'Ventas' })).toBe(true);
    expect(matchesAppFilter(otra, { group: 'Ventas' })).toBe(false);
    expect(matchesAppFilter(otra, { group: 'TI' })).toBe(true);
  });

  it('combinación AND de grupo + texto', () => {
    expect(matchesAppFilter(app, { group: 'Ventas', query: 'CRM' })).toBe(true);
    expect(matchesAppFilter(app, { group: 'Ventas', query: 'Bugs' })).toBe(false);
    expect(matchesAppFilter(otra, { group: 'TI', query: 'incidencias' })).toBe(true);
  });

  it('el texto matchea nombre, descripción o categoría (sin distinción de mayúsculas)', () => {
    expect(matchesAppFilter(app, { query: 'crm' })).toBe(true);
    expect(matchesAppFilter(app, { query: 'comercial' })).toBe(true);
    expect(matchesAppFilter(app, { query: 'ventas' })).toBe(true);
  });

  it('app sin grupos solo aparece con "all"', () => {
    const sinGrupo = { name: 'Pública', groups: [] };
    expect(matchesAppFilter(sinGrupo, { group: 'all' })).toBe(true);
    expect(matchesAppFilter(sinGrupo, { group: 'TI' })).toBe(false);
  });
});

describe('render de chips en el dashboard', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  function seedApp(fakeDb, { id, name, url, visibility, category = 'General', groupNames = [] }) {
    fakeDb.apps.push({
      id, name, url, icon_url: null, icon_class: null,
      description: `${name} desc`, category, color: '#4f8cff',
      visibility,
      groupIds: [],
    });
    groupNames.forEach((groupName) => {
      fakeDb.appGroupAssignments.push({ app_id: id, group_name: groupName });
    });
  }

  function seedAuthedUser(fakeDb, { role = 'employee', groups = [] } = {}) {
    const user = {
      id: fakeDb.sequence.users++,
      email: `${role}-${fakeDb.users.length}@testcorp.com`,
      display_name: role,
      role,
      status: 'active',
      session_version: 0,
      last_login_at: null,
      created_at: new Date(),
    };
    fakeDb.users.push(user);
    // getUserGroups usa el JOIN user_groups ug -> filas { id, name }.
    groups.forEach((g) => {
      fakeDb.groups.push({ id: g.id, name: g.name });
      fakeDb.userGroups.push({ user_id: user.id, id: g.id, name: g.name });
    });
    return user;
  }

  function seedSession(fakeDb, user) {
    const token = sessionService.generateToken();
    fakeDb.sessions.push({
      id: `s-${fakeDb.sessions.length + 1}`,
      token_hash: sessionService.hashToken(token),
      user_id: user.id,
      session_version_enrolled: user.session_version,
      expires_at: new Date(Date.now() + 86400 * 1000),
      created_at: new Date(),
      revoked_at: null,
    });
    return token;
  }

  it('anónimo NO recibe chips ni data-app-groups', async () => {
    seedApp(fakeDb, { id: 1, name: 'Pública', url: 'https://a.com', visibility: 'public', groupNames: ['Ventas'] });
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.text).not.toContain('data-app-groups');
    expect(res.text).not.toContain('class="chip');
  });

  it('autenticado con grupos: los chips y data-app-groups salen en el HTML', async () => {
    seedApp(fakeDb, { id: 1, name: 'CRM', url: 'https://crm.com', visibility: 'public', groupNames: ['Ventas'] });
    const user = seedAuthedUser(fakeDb, {
      role: 'employee',
      groups: [{ id: 10, name: 'Ventas' }, { id: 20, name: 'TI' }],
    });
    const token = seedSession(fakeDb, user);
    const app = createApp();

    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.text).toContain('data-app-groups');
    // Chips con aria-pressed y data-group.
    expect(res.text).toContain('data-group="all"');
    expect(res.text).toContain('data-group="Ventas"');
    expect(res.text).toContain('data-group="TI"');
    expect(res.text).toContain('aria-pressed="true"');
    // El chip "Todos" está activo por defecto.
    expect(res.text).toContain('chip-active');
    // El grupo de la app aparece como data-attribute JSON escapado (EJS usa &#34;).
    expect(res.text).toContain('data-app-groups=');
    expect(res.text).toMatch(/data-app-groups='\[&#34;Ventas&#34;\]'/);
  });

  it('autenticado sin grupos: no hay chips', async () => {
    const user = seedAuthedUser(fakeDb, { role: 'employee', groups: [] });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('class="chip');
    expect(res.text).toContain('aún no tienes grupos asignados');
  });
});
