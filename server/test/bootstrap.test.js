import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// P2: sin SUPER_ADMIN_EMAIL el primer login NO debe crear super_admin.
// Cargamos src/ dinámicamente después de eliminar la variable.
process.env.NODE_ENV = 'development';
delete process.env.SUPER_ADMIN_EMAIL;
delete process.env.BOOTSTRAP_TOKEN;

let db;
let createApp;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
});

function getCsrf(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('_csrf='));
  return c.split(';')[0].slice('_csrf='.length);
}

describe('Bootstrap sin SUPER_ADMIN_EMAIL', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('el primer login de un email permitido crea un employee (no super_admin)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'user@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    expect(r.status).toBe(200);
    expect(r.body.dev_code).toMatch(/^\d{6}$/);

    const v = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf });
    expect(v.status).toBe(302);

    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('employee');
  });
});
