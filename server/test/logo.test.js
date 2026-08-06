import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R2: gestión del logo (PNG/JPEG por MAGIC BYTES, <=2MB, <=2048px, path fijo).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `corp-logo-test-${process.pid}-${Date.now()}`);

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
  b[25] = 0x00; b[26] = 0x01; // height 1
  b[27] = 0x00; b[28] = 0x01; // width 1
  return Buffer.concat([b, Buffer.from([0xff, 0xd9])]);
}

const JPEG_1x1 = makeJpeg1x1();

let db;
let createApp;
let sessionService;
let logoService;

beforeAll(async () => {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  ({ default: logoService } = await import('../src/services/logo.service.js'));
});

describe('logo.service (magic bytes y dimensiones)', () => {
  it('detecta PNG real por sus magic bytes', () => {
    expect(logoService.detectImageType(PNG_1x1)).toBe('png');
  });

  it('detecta JPEG real por sus magic bytes', () => {
    expect(logoService.detectImageType(JPEG_1x1)).toBe('jpeg');
  });

  it('rechaza SVG y cualquier otro formato (nunca confiar en la extensión)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const renamedSvg = Buffer.concat([svg, Buffer.from('x')]); // mismo contenido
    expect(logoService.detectImageType(svg)).toBeNull();
    expect(logoService.detectImageType(renamedSvg)).toBeNull();
    expect(logoService.detectImageType(Buffer.from('GIF89a...'))).toBeNull();
    expect(logoService.detectImageType(Buffer.from([]))).toBeNull();
  });

  it('lee dimensiones de PNG y JPEG', () => {
    expect(logoService.readImageSize(PNG_1x1, 'png')).toEqual({ width: 1, height: 1 });
    expect(logoService.readImageSize(JPEG_1x1, 'jpeg')).toEqual({ width: 1, height: 1 });
  });

  it('validateLogo: acepta PNG/JPEG válidos', () => {
    expect(logoService.validateLogo(PNG_1x1)).toMatchObject({ ok: true, type: 'png', width: 1, height: 1 });
    expect(logoService.validateLogo(JPEG_1x1)).toMatchObject({ ok: true, type: 'jpeg', width: 1, height: 1 });
  });

  it('validateLogo: rechaza SVG y el límite de tamaño (2 MB)', () => {
    expect(logoService.validateLogo(Buffer.from('<svg></svg>'))).toMatchObject({ ok: false });
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
    expect(logoService.validateLogo(big)).toMatchObject({ ok: false });
  });

  it('validateLogo: rechaza dimensiones > 2048 px', () => {
    // PNG con cabecera IHDR falsa de 4096x10.
    const fake = Buffer.from(PNG_1x1);
    fake.writeUInt32BE(4096, 16);
    fake.writeUInt32BE(10, 20);
    const result = logoService.validateLogo(fake);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2048');
  });

  it('saveLogo usa nombre fijo del servidor (path traversal imposible)', () => {
    const saved = logoService.saveLogo(PNG_1x1, 'png');
    expect(path.basename(saved)).toBe('logo.png');
    expect(saved.startsWith(process.env.UPLOADS_DIR)).toBe(true);
    expect(fs.existsSync(saved)).toBe(true);
    // Guardar JPEG reemplaza y limpia el PNG previo.
    logoService.saveLogo(JPEG_1x1, 'jpeg');
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'logo.png'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, 'logo.jpg'))).toBe(true);
  });
});

describe('/logo y /admin/settings/logo (HTTP)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    // Limpiar uploads entre tests para que /logo vuelva al fallback.
    for (const f of ['logo.png', 'logo.jpg']) {
      try {
        fs.unlinkSync(path.join(process.env.UPLOADS_DIR, f));
      } catch (e) {
        /* no existe */
      }
    }
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

  it('GET /logo sin logo subido sirve el fallback SVG', async () => {
    const app = createApp();
    const res = await request(app).get('/logo?v=0');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('admin recibe 403 en POST /admin/settings/logo', async () => {
    const user = seedUser('admin');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app)
      .post('/admin/settings/logo')
      .set('Cookie', [`sid=${token}`])
      .attach('logo', PNG_1x1, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('super_admin sube un PNG y /logo lo sirve como image/png con cache-busting', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const up = await request(app)
      .post(`/admin/settings/logo?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('logo', PNG_1x1, { filename: 'logo.png', contentType: 'image/png' })
      .field('_csrf', csrf);
    expect(up.status).toBe(302);
    expect(up.headers.location).toBe('/admin/settings?logo=1');

    expect(fakeDb.settings.get('logo_version')).toBe('1');
    expect(fakeDb.auditLog.some((a) => a.action === 'logo.upload')).toBe(true);

    const logo = await request(app).get('/logo?v=1');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toContain('image/png');
    expect(logo.headers['cache-control']).toContain('immutable');
    expect(logo.headers['content-disposition']).toContain('inline');
  });

  it('rechaza un SVG aunque se envíe con nombre .png (magic bytes)', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await request(app)
      .post(`/admin/settings/logo?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('logo', svg, { filename: 'logo.png', contentType: 'image/png' })
      .field('_csrf', csrf);
    expect(res.status).toBe(400);
    expect(fakeDb.settings.has('logo_version')).toBe(false);
  });

  it('rechaza un archivo > 2 MB (límite de multer)', async () => {
    const user = seedUser('super_admin');
    const token = seedSession(user);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/settings').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
    const res = await request(app)
      .post(`/admin/settings/logo?_csrf=${csrf}`)
      .set('Cookie', jar)
      .attach('logo', big, { filename: 'logo.png', contentType: 'image/png' })
      .field('_csrf', csrf);
    expect(res.status).toBe(400);
    expect(fakeDb.settings.has('logo_version')).toBe(false);
  });
});
