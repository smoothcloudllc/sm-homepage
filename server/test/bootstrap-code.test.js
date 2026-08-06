import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Bootstrap del super_admin con BOOTSTRAP_CODE (6 dígitos): el primer login
// de SUPER_ADMIN_EMAIL exige el código (single-use, hash SHA-256). El token
// hex (BOOTSTRAP_TOKEN) queda cubierto por integration.test.js (retrocompat).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
delete process.env.BOOTSTRAP_TOKEN;
process.env.BOOTSTRAP_CODE = '483912';

const BOOTSTRAP_CODE = '483912';

let db;
let createApp;
let bootstrapService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: bootstrapService } = await import('../src/services/bootstrap.service.js'));
});

function getCsrf(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('_csrf='));
  expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
  return c.split(';')[0].slice('_csrf='.length);
}

describe('Bootstrap del super_admin con BOOTSTRAP_CODE (6 dígitos)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET /login?email=SUPER_ADMIN_EMAIL renderiza el input bootstrap_code (bootstrapMode=code)', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_CODE), true);
    const app = createApp();

    const visible = await request(app).get('/login?email=admin@testcorp.com');
    expect(visible.status).toBe(200);
    expect(visible.text).toContain('bootstrap-code-input');
    expect(visible.text).toContain('name="bootstrap_code"');
    // En modo 'code' NO se ofrece el input del token hex (retrocompat aparte).
    expect(visible.text).not.toContain('bootstrap-token-input');

    // Sin email de super_admin (o sin coincidencia) no se muestra nada.
    const hidden = await request(app).get('/login');
    expect(hidden.text).not.toContain('bootstrap-code-input');
    const other = await request(app).get('/login?email=emp@testcorp.com');
    expect(other.text).not.toContain('bootstrap-code-input');
  });

  it('exige BOOTSTRAP_CODE en el primer login y lo consume (single-use)', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_CODE), true);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login?email=admin@testcorp.com'));
    const jar = [`_csrf=${csrf}`];
    const email = 'admin@testcorp.com';

    const requestOtp = () =>
      request(app)
        .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
        .send({ email, _csrf: csrf });

    const r = await requestOtp();
    expect(r.body.dev_code).toMatch(/^\d{6}$/);
    // En dev la API expone el código de arranque para simplificar el flujo local.
    expect(r.body.bootstrap_code).toBe(BOOTSTRAP_CODE);

    // Código con formato inválido (no 6 dígitos) -> fallo genérico, NO se crea
    // el usuario y el código sembrado no se gasta.
    const bad = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf, bootstrap_code: '12345' });
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toContain('error=invalid');
    expect(fakeDb.users).toHaveLength(0);
    expect(fakeDb.bootstrapTokens.has(bootstrapService.hashToken(BOOTSTRAP_CODE))).toBe(true);

    // Sin bootstrap_code -> fallo genérico (el OTP anterior ya se consumió;
    // se solicita uno nuevo para aislar el caso).
    const r2 = await requestOtp();
    const noCode = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r2.body.dev_code, _csrf: csrf });
    expect(noCode.status).toBe(302);
    expect(noCode.headers.location).toContain('error=invalid');
    expect(fakeDb.users).toHaveLength(0);
    expect(fakeDb.bootstrapTokens.has(bootstrapService.hashToken(BOOTSTRAP_CODE))).toBe(true);

    // Con código correcto -> crea super_admin y consume el código (single-use).
    const r3 = await requestOtp();
    const ok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r3.body.dev_code, _csrf: csrf, bootstrap_code: BOOTSTRAP_CODE });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('super_admin');
    expect(fakeDb.bootstrapTokens.size).toBe(0);
  });

  it('código incorrecto -> audita bootstrap_code_missing_or_invalid y no crea usuario', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_CODE), true);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login?email=admin@testcorp.com'));
    const jar = [`_csrf=${csrf}`];
    const email = 'admin@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });

    const wrong = BOOTSTRAP_CODE === '999999' ? '000000' : '999999';
    const v = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf, bootstrap_code: wrong });
    expect(v.status).toBe(302);
    expect(v.headers.location).toContain('error=invalid');
    expect(fakeDb.users).toHaveLength(0);

    const failed = fakeDb.auditLog.find((a) => a.action === 'login.failed');
    expect(failed).toBeTruthy();
    expect(failed.details.reason).toBe('bootstrap_code_missing_or_invalid');
  });

  it('un email distinto a SUPER_ADMIN_EMAIL no exige código de arranque', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_CODE), true);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'emp@testcorp.com';

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
