import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

// Validaciones fail-fast de config.js (P1, P2, P3, P6).
// loadConfig() relee process.env en cada llamada; el módulo ya se cargó con
// NODE_ENV=test (setupFiles), así que aquí solo se muta el entorno y se llama.

function baseEnv() {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.ALLOWED_DOMAINS = 'corp.com';
  process.env.SUPER_ADMIN_EMAIL = 'admin@corp.com';
  process.env.MAIL_DRIVER = 'smtp';
  process.env.SMTP_HOST = 'smtp.example.com';
  delete process.env.BOOTSTRAP_TOKEN;
  delete process.env.BOOTSTRAP_CODE;
  delete process.env.COOKIE_SECURE;
  delete process.env.ENABLE_DEV_CODE;
  delete process.env.SESSION_ROTATE_DAYS;
  delete process.env.REVOKE_ALL_ON_LOGIN;
}

describe('config.js (fail-fast)', () => {
  it('prohíbe MAIL_DRIVER=log en producción (P1)', () => {
    baseEnv();
    process.env.MAIL_DRIVER = 'log';
    expect(() => loadConfig()).toThrow(/MAIL_DRIVER=log está prohibido/);
  });

  it('exige SUPER_ADMIN_EMAIL en producción (P2)', () => {
    baseEnv();
    delete process.env.SUPER_ADMIN_EMAIL;
    expect(() => loadConfig()).toThrow(/SUPER_ADMIN_EMAIL/);
  });

  it('exige SUPER_ADMIN_EMAIL cuando hay BOOTSTRAP_TOKEN (P2)', () => {
    baseEnv();
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    delete process.env.SUPER_ADMIN_EMAIL;
    process.env.BOOTSTRAP_TOKEN = 'tok';
    expect(() => loadConfig()).toThrow(/BOOTSTRAP_TOKEN/);
  });

  it('acepta BOOTSTRAP_CODE válido (6 dígitos) y lo expone en config', () => {
    baseEnv();
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    process.env.BOOTSTRAP_CODE = '483912';
    expect(loadConfig().bootstrapCode).toBe('483912');
    // Ceros iniciales: la regex ^\d{6}$ los admite y el valor se conserva.
    process.env.BOOTSTRAP_CODE = '000001';
    expect(loadConfig().bootstrapCode).toBe('000001');
  });

  it('rechaza BOOTSTRAP_CODE que no sea de 6 dígitos (fail-fast)', () => {
    baseEnv();
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    const invalid = ['12345', '1234567', '12a456', 'abcdef', '12 456', '12345\n'];
    for (const bad of invalid) {
      process.env.BOOTSTRAP_CODE = bad;
      expect(() => loadConfig()).toThrow(/BOOTSTRAP_CODE/);
    }
  });

  it('exige SUPER_ADMIN_EMAIL cuando hay BOOTSTRAP_CODE (P2)', () => {
    baseEnv();
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    delete process.env.SUPER_ADMIN_EMAIL;
    process.env.BOOTSTRAP_CODE = '483912';
    expect(() => loadConfig()).toThrow(/BOOTSTRAP_CODE/);
  });

  it('permite MAIL_DRIVER=log en development', () => {
    baseEnv();
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    expect(loadConfig().mailDriver).toBe('log');
  });

  it('cookieSecure: true por defecto en prod; false con COOKIE_SECURE=false o en dev (P3)', () => {
    baseEnv();
    expect(loadConfig().cookieSecure).toBe(true);

    process.env.COOKIE_SECURE = 'false';
    expect(loadConfig().cookieSecure).toBe(false);

    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    expect(loadConfig().cookieSecure).toBe(false);
  });

  it('enableDevCode solo en development con ENABLE_DEV_CODE != false (P1)', () => {
    baseEnv();
    expect(loadConfig().enableDevCode).toBe(false); // producción

    process.env.NODE_ENV = 'development';
    process.env.MAIL_DRIVER = 'log';
    expect(loadConfig().enableDevCode).toBe(true);

    process.env.ENABLE_DEV_CODE = 'false';
    expect(loadConfig().enableDevCode).toBe(false);

    // De vuelta a producción con smtp para no disparar fail-fast.
    process.env.NODE_ENV = 'production';
    process.env.MAIL_DRIVER = 'smtp';
    process.env.ENABLE_DEV_CODE = 'true';
    expect(loadConfig().enableDevCode).toBe(false);
  });

  it('revokeAllOnLogin es false por defecto y true con REVOKE_ALL_ON_LOGIN=true (P6)', () => {
    baseEnv();
    expect(loadConfig().revokeAllOnLogin).toBe(false);
    process.env.REVOKE_ALL_ON_LOGIN = 'true';
    expect(loadConfig().revokeAllOnLogin).toBe(true);
  });

  it('anonymousMode: ON por defecto (compat) y OFF con ANONYMOUS_MODE=off', () => {
    baseEnv();
    delete process.env.ANONYMOUS_MODE;
    expect(loadConfig().anonymousMode).toBe(true);

    process.env.ANONYMOUS_MODE = 'off';
    expect(loadConfig().anonymousMode).toBe(false);

    // Cualquier valor distinto de 'off' mantiene el modo anónimo (default ON).
    process.env.ANONYMOUS_MODE = 'true';
    expect(loadConfig().anonymousMode).toBe(true);
  });

  it('trustProxy: 0 por defecto y solo entero positivo con TRUST_PROXY', () => {
    baseEnv();
    delete process.env.TRUST_PROXY;
    expect(loadConfig().trustProxy).toBe(0);

    process.env.TRUST_PROXY = '1';
    expect(loadConfig().trustProxy).toBe(1);

    process.env.TRUST_PROXY = '2';
    expect(loadConfig().trustProxy).toBe(2);

    process.env.TRUST_PROXY = '0';
    expect(loadConfig().trustProxy).toBe(0);

    process.env.TRUST_PROXY = '-1';
    expect(loadConfig().trustProxy).toBe(0);

    process.env.TRUST_PROXY = 'abc';
    expect(loadConfig().trustProxy).toBe(0);
  });
});
