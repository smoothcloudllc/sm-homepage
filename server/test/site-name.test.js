import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Nombre del sitio configurable (settings.site_name, precedencia BD > env):
// el <title> del layout y la marca del header deben usar el valor EFECTIVO
// resuelto en runtime (res.locals.siteName), sin reiniciar el proceso.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let settingsService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: settingsService } = await import('../src/services/settings.service.js'));
});

describe('site_name efectivo en el HTML (título + header + login)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('sin BD: fallback "SM-HomePage" en <title>, brand y login', async () => {
    const app = createApp();
    const home = await request(app).get('/');
    expect(home.text).toMatch(/<title>[^<]*SM-HomePage[^<]*<\/title>/);
    expect(home.text).toContain('>SM-HomePage</span>'); // .brand-name

    const login = await request(app).get('/login');
    expect(login.text).toMatch(/<title>[^<]*SM-HomePage[^<]*<\/title>/);
    expect(login.text).toContain('>SM-HomePage</h1>'); // .auth-title
  });

  it('con site_name en BD: <title>, brand y login usan el valor efectivo', async () => {
    fakeDb.settings.set('site_name', 'Portal ACME');
    const app = createApp();

    const home = await request(app).get('/');
    expect(home.text).toMatch(/<title>[^<]*Portal ACME[^<]*<\/title>/);
    expect(home.text).toContain('>Portal ACME</span>');
    expect(home.text).not.toMatch(/<title>[^<]*SM-HomePage/);

    const login = await request(app).get('/login');
    expect(login.text).toContain('>Portal ACME</h1>');
  });

  it('cambiar site_name se refleja en runtime sin reiniciar', async () => {
    fakeDb.settings.set('site_name', 'Antiguo');
    const app = createApp();

    const before = await request(app).get('/');
    expect(before.text).toContain('>Antiguo</span>');

    await settingsService.setSetting('site_name', 'Nuevo Portal', 1);

    const after = await request(app).get('/');
    expect(after.text).toContain('>Nuevo Portal</span>');
    expect(after.text).toMatch(/<title>[^<]*Nuevo Portal[^<]*<\/title>/);
    expect(after.text).not.toContain('>Antiguo</span>');
  });

  it('un site_name vacío en BD cae al fallback "SM-HomePage"', async () => {
    fakeDb.settings.set('site_name', '');
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.text).toContain('>SM-HomePage</span>');
  });
});
