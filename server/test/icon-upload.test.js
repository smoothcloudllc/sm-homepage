import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R: upload de icono personalizado por app (SOLO super_admin).
// PNG/JPEG por MAGIC BYTES, <=2MB, <=1024px, fichero fijo app-icon-<id>.<ext>.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `corp-appicon-test-${process.pid}-${Date.now()}`);

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function makeJpeg1x1() {
  const b = Buffer.alloc(29);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b[4] = 0x00; b[5] = 0x10;
  b[6] = 0x4a; b[7] = 0x46; b[8] = 0x49; b[9] = 0x46; b[10] = 0x00;
  b[20] = 0xff; b[21] = 0xc0;
  b[22] = 0x00; b[23] = 0x0b;
  b[24] = 0x08;
  b[25] = 0x00; b[26] = 0x01;
  b[27] = 0x00; b[28] = 0x01;
  return Buffer.concat([b, Buffer.from([0xff, 0xd9])]);
}

const JPEG_1x1 = makeJpeg1x1();

let db;
let createApp;
let sessionService;
let appIconService;

beforeAll(async () => {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  appIconService = await import('../src/services/app-icon.service.js');
});

describe('validateIconUpload (magic bytes, tamaño y dimensiones)', () => {
  it('acepta PNG y JPEG reales', () => {
    expect(appIconService.validateIconUpload(PNG_1x1)).toMatchObject({ ok: true, type: 'png', width: 1, height: 1 });
    expect(appIconService.validateIconUpload(JPEG_1x1)).toMatchObject({ ok: true, type: 'jpeg', width: 1, height: 1 });
  });

  it('rechaza SVG y cualquier archivo con extensión .png pero contenido falso', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(appIconService.validateIconUpload(svg).ok).toBe(false);
    expect(appIconService.validateIconUpload(Buffer.from('GIF89a........')).ok).toBe(false);
    expect(appIconService.validateIconUpload(Buffer.from([])).ok).toBe(false);
  });

  it('rechaza archivos > 2 MB', () => {
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
    const res = appIconService.validateIconUpload(big);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2 MB');
  });

  it('rechaza dimensiones > 1024 px (parseo manual de IHDR)', () => {
    const fake = Buffer.from(PNG_1x1);
    fake.writeUInt32BE(1025, 16);
    fake.writeUInt32BE(10, 20);
    const res = appIconService.validateIconUpload(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('1024');
  });
});

describe('saveAppIcon / deleteAppIcon (fichero fijo por appId en app-icons/)', () => {
  function uploadsFile(...names) {
    return path.join(process.env.UPLOADS_DIR, 'app-icons', ...names);
  }

  function clearUploads() {
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
  }

  beforeEach(() => {
    clearUploads();
  });

  it('guarda app-icons/app-icon-<id>.png y limpia el formato alternativo al reemplazar', () => {
    const saved = appIconService.saveAppIcon(7, PNG_1x1, 'png');
    expect(path.basename(saved)).toBe('app-icon-7.png');
    expect(fs.existsSync(uploadsFile('app-icon-7.png'))).toBe(true);
    expect(appIconService.iconUrlFor(7, 'png')).toBe('/uploads/app-icons/app-icon-7.png');

    appIconService.saveAppIcon(7, JPEG_1x1, 'jpeg');
    expect(fs.existsSync(uploadsFile('app-icon-7.png'))).toBe(false);
    expect(fs.existsSync(uploadsFile('app-icon-7.jpg'))).toBe(true);
  });

  it('deleteAppIcon limpia ambos formatos (al borrar la app)', () => {
    appIconService.saveAppIcon(3, PNG_1x1, 'png');
    expect(fs.existsSync(uploadsFile('app-icon-3.png'))).toBe(true);
    appIconService.deleteAppIcon(3);
    expect(fs.existsSync(uploadsFile('app-icon-3.png'))).toBe(false);
    expect(fs.existsSync(uploadsFile('app-icon-3.jpg'))).toBe(false);
  });

  it('deleteAppIcon limpia también el formato JPEG (regresión: fileNameFor \'jpg\' vs \'jpeg\')', () => {
    appIconService.saveAppIcon(9, JPEG_1x1, 'jpeg');
    expect(fs.existsSync(uploadsFile('app-icon-9.jpg'))).toBe(true);
    appIconService.deleteAppIcon(9);
    expect(fs.existsSync(uploadsFile('app-icon-9.jpg'))).toBe(false);
    expect(fs.existsSync(uploadsFile('app-icon-9.png'))).toBe(false);
  });
});

describe('POST /admin/apps/:id/icon (HTTP, RBAC y contenido)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
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
      category_id: null, color: '#4f8cff', visibility: 'public', groupIds: [],
    });
    fakeDb.categories.push({ id: 1, name: 'General', created_at: new Date() });
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
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('admin recibe 403; super_admin puede subir PNG y /uploads/app-icons lo sirve como image/png', async () => {
    const admin = seedUser('admin');
    const adminToken = seedSession(admin);
    const app = createApp();
    const asAdmin = await request(app)
      .post('/admin/apps/1/icon')
      .set('Cookie', [`sid=${adminToken}`])
      .attach('icon', PNG_1x1, { filename: 'icon.png', contentType: 'image/png' });
    expect(asAdmin.status).toBe(403);

    const su = seedUser('super_admin');
    const suToken = seedSession(su);
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${suToken}`]));
    const jar = [`sid=${suToken}`, `_csrf=${csrf}`];

    const up = await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', PNG_1x1, { filename: 'icon.png', contentType: 'image/png' });
    expect(up.status).toBe(302);
    expect(up.headers.location).toBe('/admin/apps');

    // BD: icon_url local y icon_key limpiado.
    expect(fakeDb.apps[0].icon_url).toBe('/uploads/app-icons/app-icon-1.png');
    expect(fakeDb.apps[0].icon_key).toBeNull();
    expect(fakeDb.auditLog.some((a) => a.action === 'icon.upload')).toBe(true);

    // App pública: el icono se sirve incluso a anónimos (U-4).
    const served = await request(app).get('/uploads/app-icons/app-icon-1.png');
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
  });

  it('super_admin puede subir JPEG (extensión .jpg) y se sirve image/jpeg', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const up = await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', JPEG_1x1, { filename: 'icon.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(302);
    expect(fakeDb.apps[0].icon_url).toBe('/uploads/app-icons/app-icon-1.jpg');

    const served = await request(app).get('/uploads/app-icons/app-icon-1.jpg');
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/jpeg');
  });

  it('rechaza SVG aunque se envíe como .png (magic bytes) -> 400', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', svg, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(fakeDb.apps[0].icon_url).toBeNull();
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(false);
  });

  it('rechaza archivo > 2 MB (límite multer) -> 400', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
    const res = await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', big, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(fakeDb.apps[0].icon_url).toBeNull();
  });

  it('rechaza imagen > 1024px -> 400', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const big = Buffer.from(PNG_1x1);
    big.writeUInt32BE(appIconService.MAX_DIMENSION + 1, 16);
    big.writeUInt32BE(10, 20);
    const res = await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', big, { filename: 'icon.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(fakeDb.apps[0].icon_url).toBeNull();
  });

  it('al BORRAR la app se limpia su fichero de icono subido', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', PNG_1x1, { filename: 'icon.png', contentType: 'image/png' });
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(true);

    await request(app)
      .post('/admin/apps/1/delete')
      .set('Cookie', jar)
      .type('form')
      .send({ _csrf: csrf });
    expect(fakeDb.apps).toHaveLength(0);
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'app-icons', 'app-icon-1.png'))).toBe(false);
  });

  it('editar una app con icono subido (icon_url local /uploads/) se guarda -> 302 (regresión)', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    await request(app)
      .post(`/admin/apps/1/icon?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('icon', PNG_1x1, { filename: 'icon.png', contentType: 'image/png' });
    expect(fakeDb.apps[0].icon_url).toBe('/uploads/app-icons/app-icon-1.png');

    // Guardar el formulario con el icon_url local intacto (no debe dar 400).
    const update = await request(app)
      .post('/admin/apps/1')
      .set('Cookie', jar)
      .type('form')
      .send({
        _csrf: csrf, name: 'Proxmox Editado', url: 'https://pve.internal',
        icon_url: '/uploads/app-icons/app-icon-1.png', icon_key: '', icon_class: '',
        description: '', category: 'General', color: '#4f8cff', visibility: 'public',
        category_id: '1',
      });
    expect(update.status).toBe(302);
    expect(fakeDb.apps[0].name).toBe('Proxmox Editado');
    expect(fakeDb.apps[0].icon_url).toBe('/uploads/app-icons/app-icon-1.png');
  });
});
