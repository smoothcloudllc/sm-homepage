import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Lote 2 de remediación (hallazgos AppSec BAJOS + Info pendientes):
//   H-1  /icons servido SOLO desde el manifest (defensa en profundidad)
//   U-2  limpiar fichero subido al cambiar de fuente de icono
//   U-6  IDs numéricos validados en rutas admin (404, nunca 500 por NaN)
//   C-1  nombres inválidos en el backfill de categorías -> General
//   G-2  color validado server-side (#rrggbb; vacío -> default)
//   U-1  (regresión) editar app con icon_url local /uploads/ -> 302, no 400
// Los módulos de src/ que leen config se cargan DINÁMICAMENTE en beforeAll
// tras fijar el env (ESM: los imports estáticos se evalúan antes que el body).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `corp-lote2-${process.pid}-${Date.now()}`);

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let db;
let createApp;
let sessionService;
let categoriesService;
let appIconService;

beforeAll(async () => {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, 'app-icons'), { recursive: true });
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  ({ default: categoriesService } = await import('../src/services/categories.service.js'));
  ({ default: appIconService } = await import('../src/services/app-icon.service.js'));
});

function seedUser(fakeDb, role) {
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

function seedSession(fakeDb, user) {
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

function seedGeneral(fakeDb) {
  fakeDb.categories.push({ id: 1, name: 'General', created_at: new Date() });
  return 1;
}

describe('H-1 — /icons servido SOLO desde el manifest (sin express.static)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET /icons/proxmox.png -> 200 image/png', async () => {
    const app = createApp();
    const res = await request(app).get('/icons/proxmox.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('GET /icons/inexistente.png -> 404', async () => {
    const app = createApp();
    const res = await request(app).get('/icons/slug-inexistente.png');
    expect(res.status).toBe(404);
  });

  it('traversal en el slug -> 404 (nunca path traversal)', async () => {
    const app = createApp();
    const attempts = [
      '/icons/..%2F..%2Fpackage.json.png',
      '/icons/..%2fproxmox.png',
      '/icons/.%2e/config.png',
      '/icons/../proxmox.png',
      '/icons/..%5C..%5Csecret.png',
      '/icons/%2e%2e%2fproxmox.png',
    ];
    for (const u of attempts) {
      const res = await request(app).get(u);
      expect(res.status).toBe(404);
    }
  });

  it('un slug del manifest que no existe en disco NO da 500 (404 por manifest)', async () => {
    // el manifest es la única fuente de verdad; slugs no listados -> 404
    // aunque el patrón de URL sea válido.
    const app = createApp();
    const res = await request(app).get('/icons/database.png');
    expect([200, 404]).toContain(res.status);
  });
});

describe('U-2 — limpieza del fichero subido al cambiar de fuente de icono', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    seedGeneral(fakeDb);
    for (const dir of [process.env.UPLOADS_DIR, path.join(process.env.UPLOADS_DIR, 'app-icons')]) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const ent of entries) {
        if (ent.isFile()) fs.unlinkSync(path.join(dir, ent.name));
      }
    }
    fakeDb.apps.push({
      id: 1, name: 'Proxmox', url: 'https://pve.internal', icon_url: null,
      icon_key: 'proxmox', icon_class: null, description: '', category: 'General',
      category_id: 1, color: '#4f8cff', visibility: 'public', groupIds: [],
    });
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  async function seedAuth(fakeDb) {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    return { app, csrf, jar };
  }

  it('editar una app con icono subido y cambiar a icon_key -> 302 y se borra el fichero', async () => {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'), PNG_1x1);
    fakeDb.apps[0].icon_url = '/uploads/app-icons/app-icon-1.png';
    const { app, csrf, jar } = await seedAuth(fakeDb);
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(true);

    const res = await request(app)
      .post('/admin/apps/1')
      .set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Proxmox', url: 'https://pve.internal',
        icon_url: '', icon_key: 'proxmox', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: '1',
      });
    expect(res.status).toBe(302);
    expect(fakeDb.apps[0].icon_key).toBe('proxmox');
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(false);
  });

  it('cambiar a URL externa también limpia el fichero subido', async () => {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'), PNG_1x1);
    fakeDb.apps[0].icon_url = '/uploads/app-icons/app-icon-1.png';
    const { app, csrf, jar } = await seedAuth(fakeDb);

    const res = await request(app)
      .post('/admin/apps/1')
      .set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Proxmox', url: 'https://pve.internal',
        icon_url: 'https://cdn.example.com/icon.png', icon_key: '', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: '1',
      });
    expect(res.status).toBe(302);
    expect(fakeDb.apps[0].icon_url).toBe('https://cdn.example.com/icon.png');
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(false);
  });

  it('mantener el MISMO icon_url local NO borra el fichero (regresión)', async () => {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'), PNG_1x1);
    fakeDb.apps[0].icon_url = '/uploads/app-icons/app-icon-1.png';
    const { app, csrf, jar } = await seedAuth(fakeDb);

    const res = await request(app)
      .post('/admin/apps/1')
      .set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Proxmox Renombrado', url: 'https://pve.internal',
        icon_url: '/uploads/app-icons/app-icon-1.png', icon_key: '', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: '1',
      });
    expect(res.status).toBe(302);
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(true);
  });
});

describe('U-6 — IDs numéricos en rutas admin (404, nunca 500)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET /admin/apps/abc/edit -> 404 (no 500)', async () => {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const res = await request(app).get('/admin/apps/abc/edit').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(404);
  });

  it('POST /admin/apps/abc -> 404; POST /admin/apps/-1 -> 404', async () => {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    expect((await request(app).post('/admin/apps/abc').set('Cookie', jar).type('form').send({ _csrf: csrf })).status).toBe(404);
    expect((await request(app).post('/admin/apps/-1').set('Cookie', jar).type('form').send({ _csrf: csrf })).status).toBe(404);
    expect((await request(app).post('/admin/apps/0/delete').set('Cookie', jar).type('form').send({ _csrf: csrf })).status).toBe(404);
  });

  it('POST /admin/categories/abc/rename -> 404', async () => {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/categories').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    const res = await request(app)
      .post('/admin/categories/abc/rename').set('Cookie', jar).type('form')
      .send({ name: 'X', _csrf: csrf });
    expect(res.status).toBe(404);
  });
});

describe('C-1 — nombres inválidos en el backfill -> General', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('backfill con un nombre legacy de 100 chars -> la app cae a General (sin crear categoría)', async () => {
    await categoriesService.seedCategories(fakeDb);
    const longName = 'x'.repeat(100);
    fakeDb.apps.push(
      { id: 1, name: 'A1', url: 'https://a', category: 'Finanzas', visibility: 'public' },
      { id: 2, name: 'A2', url: 'https://a', category: longName, visibility: 'public' },
      { id: 3, name: 'A3', url: 'https://a', category: 'Con\nSalto\nDe\nLinea', visibility: 'public' },
      { id: 4, name: 'A4', url: 'https://a', category: 'Valid\u0000ConTrol', visibility: 'public' }
    );

    const result = await backfillCategoriesHelper();

    expect(fakeDb.apps.filter((a) => a.category_id == null)).toHaveLength(0);
    // No se crea categoría con el nombre legacy inválido.
    expect(fakeDb.categories.some((c) => c.name === longName)).toBe(false);
    expect(fakeDb.categories.some((c) => c.name === 'Con\nSalto\nDe\nLinea')).toBe(false);
    // Las apps con nombre legacy inválido quedan en General.
    const general = fakeDb.categories.find((c) => c.name === 'General');
    expect(fakeDb.apps.find((a) => a.id === 2).category_id).toBe(general.id);
    expect(fakeDb.apps.find((a) => a.id === 3).category_id).toBe(general.id);
    expect(fakeDb.apps.find((a) => a.id === 4).category_id).toBe(general.id);
    // La válida (Finanzas) sigue en su categoría.
    const finanzas = fakeDb.categories.find((c) => c.name === 'Finanzas');
    expect(fakeDb.apps.find((a) => a.id === 1).category_id).toBe(finanzas.id);
    // El resultado reporta los inválidos reasignados.
    expect(result.invalidToGeneral.length).toBeGreaterThan(0);
  });

  async function backfillCategoriesHelper() {
    return categoriesService.backfillCategories(fakeDb);
  }
});

describe('G-2 — color validado server-side', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    seedGeneral(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  async function postApp(color) {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    return request(app)
      .post('/admin/apps').set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Color Test', url: 'https://color.example.com',
        icon_url: '', icon_key: '', icon_class: '', description: '',
        category: 'General', color, visibility: 'public', category_id: '1',
      });
  }

  it("color 'red' -> 400", async () => {
    const res = await postApp('red');
    expect(res.status).toBe(400);
    expect(res.text.toLowerCase()).toContain('hexadecimal');
  });

  it("color '#ff0000' -> 302 y se guarda", async () => {
    const res = await postApp('#ff0000');
    expect(res.status).toBe(302);
    expect(fakeDb.apps[0].color).toBe('#ff0000');
  });

  it('color vacío -> default #4f8cff (302)', async () => {
    const res = await postApp('');
    expect(res.status).toBe(302);
    expect(fakeDb.apps[0].color).toBe('#4f8cff');
  });
});

describe('U-1 (regresión) — editar app con icon_url local /uploads/ -> 302, no 400', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    seedGeneral(fakeDb);
    fakeDb.apps.push({
      id: 1, name: 'Proxmox', url: 'https://pve.internal', icon_url: '/uploads/app-icons/app-icon-1.png',
      icon_key: null, icon_class: null, description: '', category: 'General',
      category_id: 1, color: '#4f8cff', visibility: 'public', groupIds: [],
    });
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('guardar el form manteniendo el icon_url local -> 302 y conserva la ruta', async () => {
    const su = seedUser(fakeDb, 'super_admin');
    const token = seedSession(fakeDb, su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps/1/edit').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const res = await request(app)
      .post('/admin/apps/1')
      .set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Proxmox Editado', url: 'https://pve.internal',
        icon_url: '/uploads/app-icons/app-icon-1.png', icon_key: '', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: '1',
      });
    expect(res.status).toBe(302);
    expect(fakeDb.apps[0].icon_url).toBe('/uploads/app-icons/app-icon-1.png');
  });
});
