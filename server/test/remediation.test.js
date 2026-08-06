import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Lote de remediación (AppSec F-R1-2/F-R1-3/F-R2-1/F-R5-1/F-R5-3 + QA F-04/F-05).
// IMPORTANTE: los módulos de src/ que leen config (settings.service, logo.service,
// app.js...) se cargan de forma DINÁMICA en beforeAll, después de fijar el env,
// porque en ESM los imports estáticos se evalúan antes que el cuerpo del módulo.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.BOOTSTRAP_TOKEN = 'remediation-bootstrap-token-123';
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `corp-remediation-${process.pid}-${Date.now()}`);

const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;

let db;
let createApp;
let logoService;
let settingsService;
let bootstrapService;

beforeAll(async () => {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: logoService } = await import('../src/services/logo.service.js'));
  ({ default: settingsService } = await import('../src/services/settings.service.js'));
  ({ default: bootstrapService } = await import('../src/services/bootstrap.service.js'));
});

function getCsrf(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('_csrf='));
  expect(c, 'respuesta debe incluir cookie _csrf').toBeTruthy();
  return c.split(';')[0].slice('_csrf='.length);
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

describe('A1/F-R1-2 — rate limiting normalizado de /auth/request', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('4 solicitudes del mismo email (rotando mayúsculas/espacios) -> límite en la 4ª', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const variants = ['user@testcorp.com', 'USER@testcorp.com', '  user@testcorp.com ', 'UsEr@TestCorp.com'];

    const statuses = [];
    for (const email of variants) {
      const r = await request(app)
        .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
        .send({ email, _csrf: csrf });
      statuses.push(r.status);
    }
    // Las 3 primeras (bucket normalizado 3/5min) pasan; la 4ª -> 429.
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
    const last = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email: 'user@testcorp.com', _csrf: csrf });
    expect(last.body.error).toContain('Demasiadas solicitudes');
  });

  it('limitador por IP pura: 11 emails distintos desde la misma IP -> límite en el 11º', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];

    let limited = null;
    for (let i = 0; i < 11; i += 1) {
      const r = await request(app)
        .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
        .send({ email: `ipuser${i}@testcorp.com`, _csrf: csrf });
      if (r.status === 429) {
        limited = r;
        break;
      }
    }
    expect(limited).toBeTruthy();
    expect(limited.body.error).toContain('IP');
  });
});

describe('A3/F-R5-3 — bootstrap_token visible en el login y flujo verify', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET /login?email=SUPER_ADMIN_EMAIL muestra el input visible bootstrap_token', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_TOKEN), true);
    const app = createApp();

    const visible = await request(app).get('/login?email=admin@testcorp.com');
    expect(visible.status).toBe(200);
    expect(visible.text).toContain('bootstrap-token-input');
    expect(visible.text).toContain('Token de arranque');

    // Sin email de super_admin (o sin coincidencia) no se muestra.
    const hidden = await request(app).get('/login');
    expect(hidden.text).not.toContain('bootstrap-token-input');
    const other = await request(app).get('/login?email=emp@testcorp.com');
    expect(other.text).not.toContain('bootstrap-token-input');
  });

  it('verify con token ausente -> error (sin crear usuario); con token correcto -> 302 y super_admin', async () => {
    fakeDb.bootstrapTokens.set(bootstrapService.hashToken(BOOTSTRAP_TOKEN), true);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login?email=admin@testcorp.com'));
    const jar = [`_csrf=${csrf}`];
    const email = 'admin@testcorp.com';

    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    expect(r.body.dev_code).toMatch(/^\d{6}$/);

    // Sin token -> error genérico y NO se crea el usuario.
    const noTok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r.body.dev_code, _csrf: csrf });
    expect(noTok.status).toBe(302);
    expect(noTok.headers.location).toContain('error=invalid');
    expect(fakeDb.users).toHaveLength(0);
    expect(fakeDb.bootstrapTokens.has(bootstrapService.hashToken(BOOTSTRAP_TOKEN))).toBe(true);

    // Con token correcto -> 302, super_admin creado y token consumido (single-use).
    const r2 = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send({ email, _csrf: csrf });
    const ok = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send({ email, code: r2.body.dev_code, _csrf: csrf, bootstrap_token: BOOTSTRAP_TOKEN });
    expect(ok.status).toBe(302);
    expect(fakeDb.users).toHaveLength(1);
    expect(fakeDb.users[0].role).toBe('super_admin');
    expect(fakeDb.bootstrapTokens.size).toBe(0);
  });
});

describe('A4/F-R1-3 — entradas malformadas -> 400 (nunca 500)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('POST /auth/request con email array (email=a&email=b) -> 400', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send(`email=a@testcorp.com&email=b@testcorp.com&_csrf=${csrf}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  it('POST /auth/verify con email array -> 400', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const r = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send(`email=a@testcorp.com&email=b@testcorp.com&code=123456&_csrf=${csrf}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  it('POST /auth/verify con code array -> 400', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const r = await request(app)
      .post('/auth/verify').redirects(0).set('Cookie', jar).type('form')
      .send(`email=user@testcorp.com&code=123456&code=654321&_csrf=${csrf}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  it('POST /auth/request con email objeto -> 400 (no TypeError)', async () => {
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/login'));
    const jar = [`_csrf=${csrf}`];
    const r = await request(app)
      .post('/auth/request').redirects(0).set('Cookie', jar).type('form')
      .send('email=&_csrf=' + csrf);
    expect(r.status).toBe(400);
  });
});

describe('A5/F-R2-1 — escritura atómica del logo', () => {
  it('saveLogo deja el destino correcto y NO deja archivos temporales', () => {
    const saved = logoService.saveLogo(PNG_1x1, 'png');
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.readFileSync(saved).equals(PNG_1x1)).toBe(true);
    const leftovers = fs.readdirSync(process.env.UPLOADS_DIR).filter((f) => f.includes('.logo.tmp-'));
    expect(leftovers).toHaveLength(0);
  });

  it('cambiar de formato limpia el otro formato y no deja tmp', () => {
    logoService.saveLogo(PNG_1x1, 'png');
    logoService.saveLogo(PNG_1x1, 'jpeg');
    const files = fs.readdirSync(process.env.UPLOADS_DIR);
    expect(files).toContain('logo.jpg');
    expect(files).not.toContain('logo.png');
    expect(files.some((f) => f.includes('.logo.tmp-'))).toBe(false);
  });
});

describe('F-04 — fallback anti-lockout ante fallo de BD en settings', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('si la consulta de settings falla, getAllowedDomains cae a env sin lanzar', async () => {
    class ThrowingDb {
      async query() {
        throw new Error('boom: conexión perdida');
      }
    }
    db.setDbClient(new ThrowingDb());
    await expect(settingsService.getAllowedDomains()).resolves.toEqual(['testcorp.com']);
  });
});

describe('F-05 — theme.js: ciclo light->dark->system y resolve', () => {
  let theme;
  beforeAll(async () => {
    theme = await import('../src/public/js/theme.js');
  });

  it('nextTheme cicla light -> dark -> system -> light', () => {
    expect(theme.nextTheme('light')).toBe('dark');
    expect(theme.nextTheme('dark')).toBe('system');
    expect(theme.nextTheme('system')).toBe('light');
  });

  it('resolve devuelve el tema concreto (system sin matchMedia -> light)', () => {
    expect(theme.resolve('light')).toBe('light');
    expect(theme.resolve('dark')).toBe('dark');
    expect(theme.resolve('system')).toBe('light');
    expect(theme.ORDER).toEqual(['light', 'dark', 'system']);
  });

  it('la clave de persistencia localStorage es estable (cp-theme)', () => {
    expect(theme.STORAGE_KEY).toBe('cp-theme');
  });
});
