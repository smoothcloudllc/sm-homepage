import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { FakeDb } from './helpers/mockDb.js';

// R1: los correos OTP usan el NOMBRE DE LA EMPRESA configurable
// (settings.site_name, precedencia BD > env) en asunto y cuerpo, en lugar
// del "SM-HomePage" hardcodeado. Sin site_name configurado, el fallback
// 'SM-HomePage' mantiene el contrato anterior.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let mailService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: mailService } = await import('../src/services/mail.service.js'));
});

describe('buildOtpHtml: marca del sitio en el cuerpo HTML', () => {
  it('con siteName: el <h2> usa el nombre configurado', () => {
    const html = mailService.buildOtpHtml('123456', 10, 'Portal Ejemplo');
    expect(html).toContain('<h2>Portal Ejemplo</h2>');
    expect(html).toContain('123456');
    expect(html).toContain('Válido durante 10 minutos');
    expect(html).not.toContain('<h2>SM-HomePage</h2>');
  });

  it('sin siteName: cae al fallback "SM-HomePage"', () => {
    expect(mailService.buildOtpHtml('123456', 10)).toContain('<h2>SM-HomePage</h2>');
    expect(mailService.buildOtpHtml('123456', 10, '')).toContain('<h2>SM-HomePage</h2>');
    expect(mailService.buildOtpHtml('123456', 10, '   ')).toContain('<h2>SM-HomePage</h2>');
  });

  it('escapa un siteName malicioso (sin inyección de HTML)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = mailService.buildOtpHtml('123456', 10, evil);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('drivers smtp/sendgrid: subject y body usan el siteName', () => {
  let createTransportSpy;

  beforeEach(() => {
    createTransportSpy = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-msg' }),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capturedMail() {
    const transporter = createTransportSpy.mock.results[0].value;
    return transporter.sendMail.mock.calls[0][0];
  }

  it('sendViaSmtp: subject/text/html usan el siteName proporcionado', async () => {
    const config = { smtp: { host: 'h', port: 587, from: 'f@c.com' }, otpTtlMin: 10 };
    await mailService.sendViaSmtp(config, {
      to: 'a@c.com',
      code: '123456',
      from: 'f@c.com',
      siteName: 'Portal Ejemplo',
    });
    const mail = capturedMail();
    expect(mail.subject).toBe('Tu código de acceso a Portal Ejemplo');
    expect(mail.text).toContain('Tu código de acceso a Portal Ejemplo es: 123456');
    expect(mail.html).toContain('<h2>Portal Ejemplo</h2>');
  });

  it('sendViaSmtp: sin siteName cae a "SM-HomePage"', async () => {
    const config = { smtp: { host: 'h', port: 587, from: 'f@c.com' }, otpTtlMin: 10 };
    await mailService.sendViaSmtp(config, { to: 'a@c.com', code: '123456' });
    const mail = capturedMail();
    expect(mail.subject).toBe('Tu código de acceso a SM-HomePage');
    expect(mail.text).toContain('Tu código de acceso a SM-HomePage es: 123456');
    expect(mail.html).toContain('<h2>SM-HomePage</h2>');
  });

  it('sendViaSendgrid: subject/text/html usan el siteName proporcionado', async () => {
    const config = { mailFrom: 'no-reply@example.com', otpTtlMin: 10 };
    await mailService.sendViaSendgrid(config, {
      to: 'a@c.com',
      code: '123456',
      from: 'no-reply@example.com',
      siteName: 'Portal Ejemplo',
    });
    const mail = capturedMail();
    expect(mail.subject).toBe('Tu código de acceso a Portal Ejemplo');
    expect(mail.text).toContain('Tu código de acceso a Portal Ejemplo es: 123456');
    expect(mail.html).toContain('<h2>Portal Ejemplo</h2>');
  });

  it('sendViaSendgrid: sin siteName cae a "SM-HomePage"', async () => {
    const config = { mailFrom: 'no-reply@example.com', otpTtlMin: 10 };
    await mailService.sendViaSendgrid(config, { to: 'a@c.com', code: '123456' });
    const mail = capturedMail();
    expect(mail.subject).toBe('Tu código de acceso a SM-HomePage');
    expect(mail.html).toContain('<h2>SM-HomePage</h2>');
  });

  it('sendViaLog: muestra el siteName en la consola (cosmético)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mailService.sendViaLog(
      { isProd: false },
      { to: 'a@c.com', code: '123456', siteName: 'Portal Ejemplo' }
    );
    const line = logSpy.mock.calls.find((c) => String(c[0]).includes('Código OTP'));
    expect(String(line[0])).toContain('Portal Ejemplo');
    logSpy.mockRestore();
  });

  it('sendOtpEmail (driver smtp): un siteName malicioso se escapa en el HTML', async () => {
    const config = { mailDriver: 'smtp', smtp: { host: 'h', port: 587, from: 'f@c.com' }, otpTtlMin: 10 };
    await mailService.sendOtpEmail(config, {
      to: 'a@c.com',
      code: '123456',
      from: 'f@c.com',
      siteName: '<img src=x onerror=alert(1)>',
    });
    const mail = capturedMail();
    expect(mail.subject).toBe('Tu código de acceso a <img src=x onerror=alert(1)>');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail.html).not.toContain('<img');
  });
});

describe('POST /auth/request: pasa siteName al envío (BD > env)', () => {
  let fakeDb;
  let captured;

  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    captured = [];
    mailService.setSendOtpEmailWithRetryOverride(async (cfg, payload) => {
      captured.push(payload);
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

  async function requestOtp(app, email, csrf) {
    return request(app)
      .post('/auth/request').redirects(0).set('Cookie', [`_csrf=${csrf}`]).type('form')
      .send({ email, _csrf: csrf });
  }

  it('con site_name en BD: el payload del envío lleva el nombre efectivo', async () => {
    fakeDb.settings.set('site_name', 'Portal Ejemplo');
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));

    const r = await requestOtp(app, 'emp@testcorp.com', csrf);
    expect(r.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].siteName).toBe('Portal Ejemplo');
    expect(captured[0].to).toBe('emp@testcorp.com');
    expect(captured[0].code).toMatch(/^\d{6}$/);
  });

  it('sin site_name en BD: fallback "SM-HomePage"', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));

    const r = await requestOtp(app, 'emp@testcorp.com', csrf);
    expect(r.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].siteName).toBe('SM-HomePage');
  });

  it('un site_name en BD malicioso se pasa sin romper el flujo (escapa en buildOtpHtml)', async () => {
    fakeDb.settings.set('site_name', '<img src=x onerror=alert(1)>');
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));

    const r = await requestOtp(app, 'emp@testcorp.com', csrf);
    expect(r.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].siteName).toBe('<img src=x onerror=alert(1)>');
    // El escape ocurre en buildOtpHtml (cubierto arriba); aquí solo se valida
    // que la ruta resuelve y reenvía el valor de settings sin alterarlo.
  });
});
