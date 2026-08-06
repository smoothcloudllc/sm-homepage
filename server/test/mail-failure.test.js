import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R1: fall-soft en runtime del envío. Se inyecta un override del sender
// (mismo patrón que db.setDbClient) para que falle SIEMPRE; el flujo de
// /auth/request debe invalidar el código, auditar mail.send_failed y
// responder genérico sin revelar nada.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let otpService;
let mailService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: otpService } = await import('../src/services/otp.service.js'));
  ({ default: mailService } = await import('../src/services/mail.service.js'));
});

describe('fallo de envío de OTP (mail.send_failed)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    mailService.setSendOtpEmailWithRetryOverride(async () => {
      throw new Error('SMTP caído (relay no responde)');
    });
  });
  afterEach(() => {
    mailService.setSendOtpEmailWithRetryOverride(null);
    db.setDbClient(null);
  });

  function getCsrf(res) {
    const sc = res.headers['set-cookie'] || [];
    const c = sc.find((x) => x.startsWith('_csrf='));
    expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('si el envío falla: 200 genérico, sin dev_code, código invalidado y audit', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const email = 'emp@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeTruthy();
    expect(r.body.dev_code).toBeUndefined();

    // No queda ningún OTP activo (el generado se invalidó, single-active).
    expect(await otpService.findActiveOtp(fakeDb, email)).toBeNull();

    const failure = fakeDb.auditLog.find((a) => a.action === 'mail.send_failed');
    expect(failure).toBeTruthy();
    expect(failure.details.email).toBe(email);
    expect(failure.details.error).toContain('SMTP caído');
  });

  it('un email de dominio NO permitido sigue sin generar OTP (anti-enumeración intacta)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email: 'x@evil.com', _csrf: csrf });
    expect(r.status).toBe(200);
    expect(r.body.dev_code).toBeUndefined();
    expect(fakeDb.otpCodes).toHaveLength(0);
    expect(fakeDb.auditLog.some((a) => a.action === 'mail.send_failed')).toBe(false);
  });
});
