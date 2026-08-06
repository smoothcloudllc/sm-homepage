import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Integración HTTP (H-09 del QA) sobre createApp + FakeDb.
// Entorno dev para poder leer dev_code y bootstrap_token en las respuestas.
// NOTA: los módulos de src/ se cargan de forma dinámica en beforeAll porque
// en ESM los imports estáticos se evalúan antes del cuerpo del módulo.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.BOOTSTRAP_TOKEN = 'bootstrap-secret-token-123';

const BOOTSTRAP_TOKEN = 'bootstrap-secret-token-123';

let db;
let createApp;
let sessionService;
let otpService;
let bootstrapService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  ({ default: otpService } = await import('../src/services/otp.service.js'));
  ({ default: bootstrapService } = await import('../src/services/bootstrap.service.js'));
});

function getCsrf(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('_csrf='));
  expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
  return c.split(';')[0].slice('_csrf='.length);
}

describe('Integración HTTP (flujo completo)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('request → verify → cookie → dashboard (empleado)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'emp@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    expect(r.status).toBe(200);
    expect(r.body.dev_code).toMatch(/^\d{6}$/);

    const v = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf });
    expect(v.status).toBe(302);
    expect(v.headers.location).toBe('/');
    const sid = (v.headers['set-cookie'] || []).find((x) => x.startsWith('sid='));
    expect(sid).toBeTruthy();
    const sidValue = sid.split(';')[0].slice('sid='.length);

    const d = await request(app).get('/').set('Cookie', [...jar, `sid=${sidValue}`]);
    expect(d.status).toBe(200);
    expect(d.text).toContain('Hola,');

    const user = fakeDb.users.find((u) => u.email === email);
    expect(user).toBeTruthy();
    // El primer usuario del sistema NO se autopromociona: solo employee.
    expect(user.role).toBe('employee');
  });

  it('dominio no permitido responde 200 genérico sin generar OTP (F15)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email: 'x@evil.com', _csrf: csrf });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeTruthy();
    expect(r.body.dev_code).toBeUndefined();
    // El código solo se genera server-side para dominios permitidos.
    expect(fakeDb.otpCodes.length).toBe(0);
  });

  it('5 fallos de verificación bloquean la cuenta (lockout por ruta)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'lock@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    const good = r.body.dev_code;
    const wrong = good === '000000' ? '000001' : '000000';

    for (let i = 0; i < otpService.MAX_FAILED_ATTEMPTS; i++) {
      const res = await request(app)
        .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
        .send({ email, code: wrong, _csrf: csrf });
      expect(res.status).toBe(302);
    }
    expect(await otpService.isLockedOut(fakeDb, email)).toBe(true);

    // Siguiente intento: rate-limit (429) o lockout (redirect error=locked).
    const res = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: wrong, _csrf: csrf });
    expect([429, 302]).toContain(res.status);
    if (res.status === 302) expect(res.headers.location).toContain('error=locked');
  });

  it('employee recibe 403 en /admin/* (RBAC por ruta)', async () => {
    const app = createApp();
    const user = {
      id: 1, email: 'emp@testcorp.com', display_name: 'emp', role: 'employee',
      status: 'active', session_version: 0, last_login_at: null, created_at: new Date(),
    };
    fakeDb.users.push(user);
    const token = sessionService.generateToken();
    fakeDb.sessions.push({
      id: 's-1', token_hash: sessionService.hashToken(token), user_id: user.id,
      session_version_enrolled: 0, expires_at: new Date(Date.now() + 86400000),
      created_at: new Date(), revoked_at: null,
    });

    const res = await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('POST sin token CSRF responde 403', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/auth/request').redirects(0).type('form')
      .send({ email: 'a@testcorp.com' });
    expect(res.status).toBe(403);
  });

  it('los formularios incluyen token CSRF', async () => {
    const app = createApp();
    const login = await request(app).get('/login');
    expect(login.text).toContain('name="_csrf"');
  });
});

describe('Bootstrap del super_admin (P2)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('exige BOOTSTRAP_TOKEN en el primer login y lo consume (single-use)', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_TOKEN), true);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'admin@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    expect(r.body.dev_code).toMatch(/^\d{6}$/);
    // En dev la API expone el token de bootstrap para simplificar la prueba.
    expect(r.body.bootstrap_token).toBe(BOOTSTRAP_TOKEN);

    // Sin token -> fallo genérico, NO se crea el usuario y el token no se gasta.
    const noTok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf });
    expect(noTok.status).toBe(302);
    expect(noTok.headers.location).toContain('error=invalid');
    expect(fakeDb.users).toHaveLength(0);
    expect(fakeDb.bootstrapTokens.has(bootstrapService.hashToken(BOOTSTRAP_TOKEN))).toBe(true);

    // Con token -> crea super_admin y consume el token (single-use).
    const r2 = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    const ok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r2.body.dev_code, _csrf: csrf, bootstrap_token: BOOTSTRAP_TOKEN });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('super_admin');
    expect(fakeDb.bootstrapTokens.size).toBe(0);
  });

  it('un email distinto a SUPER_ADMIN_EMAIL nunca obtiene super_admin', async () => {
    // Se siembra un super_admin para que "no hay ninguno" no sea el detonante.
    fakeDb.users.push({
      id: 1, email: 'admin@testcorp.com', display_name: 'admin', role: 'super_admin',
      status: 'active', session_version: 0, last_login_at: null, created_at: new Date(),
    });
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'manager@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    const ok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf });
    expect(ok.status).toBe(302);
    expect(fakeDb.users.find((u) => u.email === email).role).toBe('employee');
  });
});
