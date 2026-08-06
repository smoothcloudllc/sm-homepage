import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R5: settings en BD (precedencia sobre env), seed de defaults, usuario
// inicial idempotente y /admin/settings (solo super_admin).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let settingsService;
let sessionService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: settingsService } = await import('../src/services/settings.service.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
});

describe('settings.service (precedencia y caché)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('getAllowedDomains: la BD tiene precedencia sobre env', async () => {
    fakeDb.settings.set('allowed_domains', 'empresa.com,otra.com');
    expect(await settingsService.getAllowedDomains()).toEqual(['empresa.com', 'otra.com']);
  });

  it('getAllowedDomains: si la BD está vacía, usa env', async () => {
    // test/helpers/env.js define ALLOWED_DOMAINS=testcorp.com
    expect(await settingsService.getAllowedDomains()).toEqual(['testcorp.com']);
  });

  it('getAllowedDomains normaliza (minúsculas, sin espacios, sin @)', async () => {
    fakeDb.settings.set('allowed_domains', ' Empresa.com , @OTRA.com\ntercera.com');
    expect(await settingsService.getAllowedDomains()).toEqual(['empresa.com', 'otra.com', 'tercera.com']);
  });

  it('getSetting: fallback a env cuando la BD no tiene la clave', async () => {
    expect(await settingsService.getSetting('site_name')).toBe('SM-HomePage');
    expect(await settingsService.getSetting('default_theme')).toBe('system');
  });

  it('setSetting hace upsert, invalida caché y audita settings.update', async () => {
    await settingsService.setSetting('site_name', 'Mi Portal', 1);
    expect(await settingsService.getSetting('site_name')).toBe('Mi Portal');

    const update = fakeDb.auditLog.find((a) => a.action === 'settings.update');
    expect(update).toBeTruthy();
    expect(update.entity_id).toBe('site_name');
    expect(update.details.after).toBe('Mi Portal');
  });

  it('setSetting sobrescribe un valor previo y registra before/after', async () => {
    fakeDb.settings.set('site_name', 'Viejo');
    await settingsService.setSetting('site_name', 'Nuevo', 1);
    expect(await settingsService.getSetting('site_name')).toBe('Nuevo');
    const update = fakeDb.auditLog.find((a) => a.action === 'settings.update');
    expect(update.details.before).toBe('Viejo');
    expect(update.details.after).toBe('Nuevo');
  });

  it('seedDefaults: siembra desde env solo cuando la tabla está vacía', async () => {
    await settingsService.seedDefaults();
    expect(fakeDb.settings.get('allowed_domains')).toBe('testcorp.com');
    expect(fakeDb.settings.get('site_name')).toBe('SM-HomePage');
    expect(fakeDb.settings.get('default_theme')).toBe('system');
    expect(fakeDb.auditLog.some((a) => a.action === 'settings.seed')).toBe(true);

    // No sobrescribe valores existentes (idempotente).
    fakeDb.settings.set('site_name', 'Manual');
    await settingsService.seedDefaults();
    expect(fakeDb.settings.get('site_name')).toBe('Manual');
  });

  it('seedInitialUser: crea super_admin solo si la tabla users está vacía', async () => {
    await settingsService.seedInitialUser();
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].email).toBe('admin@testcorp.com');
    expect(fakeDb.users[0].role).toBe('super_admin');
    expect(
      fakeDb.auditLog.some(
        (a) => a.action === 'user.create' && a.details && a.details.origin === 'seed'
      )
    ).toBe(true);

    // Repetir arranque: no duplica ni cambia roles.
    await settingsService.seedInitialUser();
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('super_admin');
  });

  it('seedInitialUser: NO crea un super_admin en BD poblada', async () => {
    fakeDb.users.push({
      id: 1, email: 'emp@testcorp.com', display_name: 'emp', role: 'employee',
      status: 'active', session_version: 0, last_login_at: null, created_at: new Date(),
    });
    await settingsService.seedInitialUser();
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('employee');
  });
});

describe('/admin/settings (RBAC y runtime)', () => {
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
      created_at: new Date(),
      revoked_at: null,
    });
    return token;
  }

  function getCsrf(res) {
    const sc = res.headers['set-cookie'] || [];
    const c = sc.find((x) => x.startsWith('_csrf='));
    expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('sin sesión -> 302 a /login', async () => {
    const app = createApp();
    const res = await request(app).get('/admin/settings').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('admin -> 403 en /admin/settings', async () => {
    const user = seedUser('admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('super_admin -> 200 en GET /admin/settings', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dominios de confianza');
    expect(res.text).toContain('Logo de la empresa');
  });

  it('POST /admin/settings cambia allowed_domains y aplica en runtime', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const post = await request(app)
      .post('/admin/settings').redirects(0).set('Cookie', jar).type('form')
      .send({
        allowed_domains: 'testcorp.com\nnuevadom.com',
        site_name: 'Mi Portal',
        mail_from: '',
        default_theme: 'light',
        _csrf: csrf,
      });
    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/admin/settings?saved=1');

    // El dominio nuevo pasa la validación de /auth/request (genera OTP).
    const reqNew = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', [`_csrf=${csrf}`]).type('form')
      .send({ email: 'persona@nuevadom.com', _csrf: csrf });
    expect(reqNew.status).toBe(200);
    expect(reqNew.body.dev_code).toMatch(/^\d{6}$/);

    // Un dominio fuera de la nueva allow-list recibe rechazo genérico.
    const reqOut = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', [`_csrf=${csrf}`]).type('form')
      .send({ email: 'x@evil.com', _csrf: csrf });
    expect(reqOut.status).toBe(200);
    expect(reqOut.body.dev_code).toBeUndefined();
    expect(fakeDb.otpCodes.filter((o) => o.email === 'x@evil.com')).toHaveLength(0);
  });

  it('anti-lockout: eliminar dominios con usuarios activos exige confirmación', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    // Sin confirmación -> 400 y no se guarda.
    const denied = await request(app)
      .post('/admin/settings').redirects(0).set('Cookie', jar).type('form')
      .send({
        allowed_domains: 'otro.com',
        site_name: 'Mi Portal',
        mail_from: '',
        default_theme: 'system',
        _csrf: csrf,
      });
    expect(denied.status).toBe(400);
    expect(fakeDb.settings.has('allowed_domains')).toBe(false);

    // Con confirmación -> se guarda.
    const ok = await request(app)
      .post('/admin/settings').redirects(0).set('Cookie', jar).type('form')
      .send({
        allowed_domains: 'otro.com',
        site_name: 'Mi Portal',
        mail_from: '',
        default_theme: 'system',
        confirm_remove_domains: '1',
        _csrf: csrf,
      });
    expect(ok.status).toBe(302);
    expect(await settingsService.getAllowedDomains()).toEqual(['otro.com']);
  });

  it('la creación de usuarios en admin valida el dominio de confianza', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/users').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const res = await request(app)
      .post('/admin/users').redirects(0).set('Cookie', jar).type('form')
      .send({ email: 'foraneo@externo.com', display_name: 'X', role: 'employee', _csrf: csrf });
    expect(res.status).toBe(400);
    expect(res.text).toContain('El dominio del email no está en los dominios de confianza');
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.auditLog.some((a) => a.action === 'user.create.rejected')).toBe(true);
  });
});
