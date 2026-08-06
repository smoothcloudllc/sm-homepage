import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';
import db from '../src/db.js';
import { createApp } from '../src/app.js';
import sessionService from '../src/services/session.service.js';
import { requireAnyRole, requireRole, isLastActiveSuperAdmin } from '../src/middleware/rbac.js';

// --- Pruebas unitarias de middleware RBAC -------------------------------

function mockRes() {
  const res = {};
  res.status = function (code) {
    res.statusCode = code;
    // Resolver cuando el middleware responde con un código (403, etc.).
    if (res.__resolve) res.__resolve({ statusCode: code });
    return res;
  };
  res.renderPage = function () {
    if (res.__resolve) res.__resolve({ statusCode: res.statusCode });
  };
  res.json = function () {
    return res;
  };
  res.redirect = function () {
    return res;
  };
  return res;
}

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = mockRes();
    res.__resolve = resolve;
    const next = () => resolve({ nextCalled: true });
    try {
      mw(req, res, next);
    } catch (err) {
      resolve({ error: err });
    }
  });
}

describe('RBAC (middleware)', () => {
  it('employee no puede acceder a /admin/*', async () => {
    const result = await runMiddleware(
      requireAnyRole(['super_admin', 'admin']),
      { user: { role: 'employee' }, path: '/admin/users' }
    );
    expect(result.nextCalled).toBeUndefined();
  });

  it('admin sí puede acceder a rutas admin', async () => {
    const result = await runMiddleware(
      requireAnyRole(['super_admin', 'admin']),
      { user: { role: 'admin' }, path: '/admin/users' }
    );
    expect(result.nextCalled).toBe(true);
  });

  it('admin NO puede crear aplicaciones (requireRole super_admin)', async () => {
    const result = await runMiddleware(
      requireRole('super_admin'),
      { user: { role: 'admin' }, path: '/admin/apps' }
    );
    expect(result.nextCalled).toBeUndefined();
  });

  it('admin NO puede ver auditoría (requireRole super_admin)', async () => {
    const result = await runMiddleware(
      requireRole('super_admin'),
      { user: { role: 'admin' }, path: '/admin/audit' }
    );
    expect(result.nextCalled).toBeUndefined();
  });

  it('super_admin sí puede hacer todo', async () => {
    const okAdmin = await runMiddleware(
      requireAnyRole(['super_admin', 'admin']),
      { user: { role: 'super_admin' }, path: '/admin/users' }
    );
    const okApps = await runMiddleware(
      requireRole('super_admin'),
      { user: { role: 'super_admin' }, path: '/admin/apps' }
    );
    const okAudit = await runMiddleware(
      requireRole('super_admin'),
      { user: { role: 'super_admin' }, path: '/admin/audit' }
    );
    expect(okAdmin.nextCalled).toBe(true);
    expect(okApps.nextCalled).toBe(true);
    expect(okAudit.nextCalled).toBe(true);
  });
});

// --- Protección del último super_admin ---------------------------------

describe('isLastActiveSuperAdmin', () => {
  it('devuelve true si el único super_admin activo es el objetivo', async () => {
    const fakeDb = new FakeDb();
    fakeDb.users.push({
      id: 1, email: 'a@testcorp.com', role: 'super_admin', status: 'active', session_version: 0,
    });
    expect(await isLastActiveSuperAdmin(fakeDb, 1)).toBe(true);
  });

  it('devuelve false si hay más de un super_admin activo', async () => {
    const fakeDb = new FakeDb();
    fakeDb.users.push(
      { id: 1, email: 'a@testcorp.com', role: 'super_admin', status: 'active', session_version: 0 },
      { id: 2, email: 'b@testcorp.com', role: 'super_admin', status: 'active', session_version: 0 }
    );
    expect(await isLastActiveSuperAdmin(fakeDb, 1)).toBe(false);
  });

  it('devuelve false si el objetivo no es super_admin', async () => {
    const fakeDb = new FakeDb();
    fakeDb.users.push({ id: 1, email: 'a@testcorp.com', role: 'admin', status: 'active', session_version: 0 });
    expect(await isLastActiveSuperAdmin(fakeDb, 1)).toBe(false);
  });
});

// --- Integración HTTP (supertest + FakeDb) ------------------------------

describe('Acceso HTTP a /admin/*', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  function seedUser(role) {
    const user = {
      id: fakeDb.sequence.users++,
      email: `${role}@testcorp.com`,
      display_name: role,
      role,
      status: 'active',
      session_version: 0,
      last_login_at: null,
      created_at: new Date(),
    };
    fakeDb.users.push(user);
    return user;
  }

  function seedSession(user) {
    const token = sessionService.generateToken();
    fakeDb.sessions.push({
      id: `s-${fakeDb.sessions.length + 1}`,
      token_hash: sessionService.hashToken(token),
      user_id: user.id,
      session_version_enrolled: user.session_version,
      expires_at: new Date(Date.now() + 86400 * 1000),
      revoked_at: null,
    });
    return token;
  }

  it('employee recibe 403 en GET /admin/users', async () => {
    const user = seedUser('employee');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('admin recibe 403 en GET /admin/audit', async () => {
    const user = seedUser('admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/audit').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('super_admin recibe 200 en GET /admin/audit', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/audit').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Auditoría');
  });

  it('super_admin recibe 200 en GET /admin/users', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
  });
});

// --- P7: solo super_admin puede crear/promover admins -------------------

describe('Asignación del rol admin (P7)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  function seedUser(role) {
    const user = {
      id: fakeDb.sequence.users++,
      email: `${role}${fakeDb.users.length}@testcorp.com`,
      display_name: role,
      role,
      status: 'active',
      session_version: 0,
      last_login_at: null,
      created_at: new Date(),
    };
    fakeDb.users.push(user);
    return user;
  }

  function seedSession(user) {
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

  function getCsrf(res) {
    const sc = res.headers['set-cookie'] || [];
    const c = sc.find((x) => x.startsWith('_csrf='));
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('admin NO puede crear un usuario con rol admin (403)', async () => {
    const admin = seedUser('admin');
    const token = seedSession(admin);
    const app = createApp();
    const csrfRes = await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]);
    const csrf = getCsrf(csrfRes);

    const res = await request(app)
      .post('/admin/users').redirects(0).set('Cookie', [`sid=${token}`, `_csrf=${csrf}`]).type('form')
      .send({ email: 'new@testcorp.com', role: 'admin', _csrf: csrf });
    expect(res.status).toBe(403);
    expect(fakeDb.users).toHaveLength(1); // no se creó
  });

  it('admin NO puede promover a un empleado a admin (403)', async () => {
    const admin = seedUser('admin');
    const emp = seedUser('employee');
    const token = seedSession(admin);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]));

    const res = await request(app)
      .post(`/admin/users/${emp.id}`).redirects(0).set('Cookie', [`sid=${token}`, `_csrf=${csrf}`]).type('form')
      .send({ display_name: 'emp', role: 'admin', _csrf: csrf });
    expect(res.status).toBe(403);
    expect(fakeDb.users.find((u) => u.id === emp.id).role).toBe('employee');
  });

  it('super_admin SÍ puede crear un admin', async () => {
    const superAdmin = seedUser('super_admin');
    const token = seedSession(superAdmin);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]));

    const res = await request(app)
      .post('/admin/users').redirects(0).set('Cookie', [`sid=${token}`, `_csrf=${csrf}`]).type('form')
      .send({ email: 'newadmin@testcorp.com', role: 'admin', _csrf: csrf });
    expect(res.status).toBe(302);
    const created = fakeDb.users.find((u) => u.email === 'newadmin@testcorp.com');
    expect(created.role).toBe('admin');
  });
});
