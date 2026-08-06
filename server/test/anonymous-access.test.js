import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// H-XX: Modo anónimo + flujo ?next= con protección anti open-redirect.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let sessionService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
});

function getCsrf(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('_csrf='));
  expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
  return c.split(';')[0].slice('_csrf='.length);
}

function seedApp(fakeDb, { id, name, url, visibility, category = 'General', groupIds = [] }) {
  fakeDb.apps.push({
    id,
    name,
    url,
    icon_url: null,
    icon_class: null,
    description: `${name} desc`,
    category,
    color: '#4f8cff',
    visibility,
    groupIds,
  });
}

function seedAuthedUser(fakeDb, { role = 'employee', groupIds = [] } = {}) {
  const user = {
    id: fakeDb.sequence.users++,
    email: `${role}-${fakeDb.users.length}@testcorp.com`,
    display_name: role,
    role,
    status: 'active',
    session_version: 0,
    last_login_at: null,
    created_at: new Date(),
    groupIds,
  };
  fakeDb.users.push(user);
  // La consulta getUserGroupIds usa `SELECT g.id ... FROM user_groups ug`,
  // así que el mock devuelve filas cuya propiedad `id` es el group_id.
  groupIds.forEach((gid) => fakeDb.userGroups.push({ user_id: user.id, id: gid }));
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

describe('Modo anónimo vs autenticado (GET /)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET / sin cookie: 200 con SOLO apps públicas y sin revelar privadas', async () => {
    seedApp(fakeDb, { id: 1, name: 'Portal Público', url: 'https://public.example.com', visibility: 'public' });
    seedApp(fakeDb, { id: 2, name: 'Finanzas Secretas', url: 'https://fin.secret.example.com', visibility: 'restricted', groupIds: [10] });
    const app = createApp();

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Portal Público');
    expect(res.text).not.toContain('Finanzas Secretas');
    expect(res.text).not.toContain('fin.secret.example.com');
    // CTA de login visible y bloque discreto para apps privadas.
    expect(res.text).toContain('Iniciar sesión');
    expect(res.text).toContain('aplicaciones privadas');
  });

  it('GET / anónimo es cacheable (public, max-age corto)', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control'] || '').toMatch(/^public/);
  });

  it('GET / anónimo sin apps restricted no muestra el bloque privado', async () => {
    seedApp(fakeDb, { id: 1, name: 'Solo Pública', url: 'https://a.example.com', visibility: 'public' });
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.text).toContain('Solo Pública');
    expect(res.text).not.toContain('aplicaciones privadas');
  });

  it('GET / autenticado: públicas + restricted de sus grupos (deny-overrides), no las ajenas', async () => {
    seedApp(fakeDb, { id: 1, name: 'Pública', url: 'https://pub.example.com', visibility: 'public' });
    seedApp(fakeDb, { id: 2, name: 'Mía', url: 'https://mine.example.com', visibility: 'restricted', groupIds: [10] });
    seedApp(fakeDb, { id: 3, name: 'Ajena', url: 'https://theirs.example.com', visibility: 'restricted', groupIds: [20] });
    const user = seedAuthedUser(fakeDb, { role: 'employee', groupIds: [10] });
    const token = seedSession(fakeDb, user);
    const app = createApp();

    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pública');
    expect(res.text).toContain('Mía');
    expect(res.text).not.toContain('Ajena');
    expect(res.text).not.toContain('theirs.example.com');
  });

  it('GET / autenticado envía Cache-Control: no-store', async () => {
    const user = seedAuthedUser(fakeDb);
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('Protección de rutas privadas y admin', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET /admin/apps sin sesión: 302 a /login', async () => {
    const app = createApp();
    const res = await request(app).get('/admin/apps').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('Flujo ?next= con protección anti open-redirect', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  async function doLogin(app, jar, csrf, email, next) {
    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, next, _csrf: csrf });
    expect(r.status).toBe(200);
    return request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, next, _csrf: csrf });
  }

  it('verify redirige a la ruta interna solicitada (?next=/admin/apps)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login?next=/admin/apps'));
    const jar = [`_csrf=${csrf}`];
    const v = await doLogin(app, jar, csrf, 'next@testcorp.com', '/admin/apps');
    expect(v.status).toBe(302);
    expect(v.headers.location).toBe('/admin/apps');
  });

  it('verify rechaza ?next=https://evil.com (redirige a /)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const v = await doLogin(app, jar, csrf, 'evil@testcorp.com', 'https://evil.com');
    expect(v.status).toBe(302);
    expect(v.headers.location).toBe('/');
  });

  it('verify rechaza ?next=//evil.com y ?next=/\\evil.com', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    for (const evil of ['//evil.com', '/\\evil.com']) {
      const v = await doLogin(app, jar, csrf, `e-${evil.length}@testcorp.com`, evil);
      expect(v.status).toBe(302);
      expect(v.headers.location).toBe('/');
    }
  });

  it('GET /login?next=externo ya autenticado no hace open redirect', async () => {
    const user = seedAuthedUser(fakeDb);
    const token = seedSession(fakeDb, user);
    const app = createApp();

    const evil = await request(app).get('/login?next=https://evil.com').set('Cookie', [`sid=${token}`]).redirects(0);
    expect(evil.status).toBe(302);
    expect(evil.headers.location).toBe('/');

    const local = await request(app).get('/login?next=/admin/apps').set('Cookie', [`sid=${token}`]).redirects(0);
    expect(local.status).toBe(302);
    expect(local.headers.location).toBe('/admin/apps');
  });

  it('login redirige a / cuando next es ausente o inválido', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const v = await doLogin(app, jar, csrf, 'plain@testcorp.com', undefined);
    expect(v.status).toBe(302);
    expect(v.headers.location).toBe('/');
  });

  it('la página de login no se cachea (no-store)', async () => {
    const app = createApp();
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('Logout', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('POST /auth/logout revoca la sesión y redirige al dashboard público', async () => {
    const user = seedAuthedUser(fakeDb);
    const token = seedSession(fakeDb, user);
    const app = createApp();

    const csrfRes = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    const csrf = getCsrf(csrfRes);

    const res = await request(app)
      .post('/auth/logout').redirects(0).set('Cookie', [`sid=${token}`, `_csrf=${csrf}`]).type('form')
      .send({ _csrf: csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    // La sesión quedó revocada.
    expect(await sessionService.validateSession(fakeDb, token)).toBeNull();
  });
});
