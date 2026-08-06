import { describe, it, expect, vi, beforeAll } from 'vitest';
import { loadConfig } from '../src/config.js';

// R1: SendGrid vía SMTP (sin dependencia nueva). El mapeo de transporte se
// testea como función pura (sin tocar la red de Nodemailer ni la API real).
let mailService;

beforeAll(async () => {
  ({ default: mailService } = await import('../src/services/mail.service.js'));
});

describe('config.js fail-fast con sendgrid', () => {
  function baseEnv() {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
    process.env.SESSION_SECRET = 'test-secret';
    process.env.ALLOWED_DOMAINS = 'corp.com';
    process.env.SUPER_ADMIN_EMAIL = 'admin@corp.com';
    process.env.MAIL_DRIVER = 'sendgrid';
    delete process.env.SENDGRID_API_KEY;
    delete process.env.MAIL_FROM;
    delete process.env.BOOTSTRAP_TOKEN;
  }

  it('MAIL_DRIVER=sendgrid sin SENDGRID_API_KEY no arranca (fail-fast)', () => {
    baseEnv();
    expect(() => loadConfig()).toThrow(/SENDGRID_API_KEY/);
  });

  it('MAIL_DRIVER=sendgrid con clave carga el driver y mailFrom por defecto', () => {
    baseEnv();
    process.env.SENDGRID_API_KEY = 'SG.secret-key';
    const config = loadConfig();
    expect(config.mailDriver).toBe('sendgrid');
    expect(config.sendgridApiKey).toBe('SG.secret-key');
    expect(config.mailFrom).toBe('no-reply@example.com');
  });

  it('MAIL_FROM define el remitente por defecto', () => {
    baseEnv();
    process.env.SENDGRID_API_KEY = 'SG.secret-key';
    process.env.MAIL_FROM = 'no-reply@otra.com';
    expect(loadConfig().mailFrom).toBe('no-reply@otra.com');
  });
});

describe('mail.service — mapeo de transporte (funciones puras)', () => {
  it('sendgridTransportOptions: host/port/auth correctos para SendGrid', () => {
    const options = mailService.sendgridTransportOptions({
      sendgridApiKey: 'SG.secret-key',
    });
    expect(options).toEqual({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: 'SG.secret-key' },
      rateLimit: 10,
      rateDelta: 1000,
    });
  });

  it('smtpTransportOptions: incluye throttling y secure según puerto', () => {
    const plain = mailService.smtpTransportOptions({
      smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
    });
    expect(plain).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      rateLimit: 10,
      rateDelta: 1000,
    });

    const tls = mailService.smtpTransportOptions({
      smtp: { host: 'smtp.example.com', port: 465, user: 'u', pass: 'p' },
    });
    expect(tls.secure).toBe(true);
  });

  it('smtpTransportOptions: sin credenciales, auth es undefined', () => {
    const options = mailService.smtpTransportOptions({
      smtp: { host: 'relay.example.com', port: 25, user: null, pass: null },
    });
    expect(options.auth).toBeUndefined();
  });

  it('sendOtpEmailWithRetry reintenta (1 inicial + 2 reintentos) y propaga el error final', async () => {
    const spy = vi
      .spyOn(mailService, 'sendOtpEmail')
      .mockRejectedValue(new Error('down'));
    const config = { mailDriver: 'sendgrid', sendgridApiKey: 'k', mailFrom: 'f@c.com', otpTtlMin: 10, isProd: true };
    await expect(
      mailService.sendOtpEmailWithRetry(config, { to: 'a@c.com', code: '123456' })
    ).rejects.toThrow('down');
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('sendOtpEmailWithRetry no reintenta si el envío es correcto', async () => {
    const spy = vi.spyOn(mailService, 'sendOtpEmail').mockResolvedValue();
    const config = { mailDriver: 'sendgrid', sendgridApiKey: 'k', mailFrom: 'f@c.com', otpTtlMin: 10, isProd: true };
    await expect(
      mailService.sendOtpEmailWithRetry(config, { to: 'a@c.com', code: '123456' })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
