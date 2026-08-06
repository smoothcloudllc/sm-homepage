import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// U-4: los iconos de apps restricted NO deben ser adivinables por anónimos.
// El LOGO (/uploads/logo.*) sigue siendo público (marca del portal); los
// iconos se sirven SOLO desde /uploads/app-icons/app-icon-<id>.<ext> con
// control de acceso:
//   - app public            -> 200 para cualquiera (anónimo incluido).
//   - app restricted        -> 403 sin sesión o sin grupo asignado; 200 para
//                              super_admin/admin y employee con grupo asignado.
//   - nombre inválido       -> 404 (nunca path traversal).
// Los módulos de src/ que leen config se cargan DINÁMICAMENTE en beforeAll
// tras fijar el env (ESM: los imports estáticos se evalúan antes que el body).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `corp-appicon-access-${process.pid}-${Date.now()}`);

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let db;
let createApp;
let sessionService;

beforeAll(async () => {
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, 'app-icons'), { recursive: true });
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
});

function seedApp(fakeDb, { id, visibility, groupIds = [] }) {
  fakeDb.apps.push({
    id,
    name: `App ${id}`,
    url: `https://app${id}.example.com`,
    icon_url: `/uploads/app-icons/app-icon-${id}.png`,
    icon_key: null,
    icon_class: null,
    description: '',
    category: 'General',
    category_id: null,
    color: '#4f8cff',
    visibility,
    groupIds,
  });
  for (const gid of groupIds) {
    fakeDb.appGroupAssignments.push({ app_id: id, group_id: gid, group_name: `G${gid}` });
  }
}

function seedIconFile(appId, ext = 'png') {
  const file = path.join(process.env.UPLOADS_DIR, 'app-icons', `app-icon-${appId}.${ext}`);
  fs.writeFileSync(file, PNG_1x1);
  return file;
}

function seedUser(fakeDb, { role = 'employee', groupIds = [] } = {}) {
  const user = {
    id: fakeDb.sequence.users++,
    email: `${role}-${fakeDb.users.length}@testcorp.com`,
    display_name: role,
    role,
    status: 'active',
    session_version: 0,
    last_login_at: null,
    created_at: new Date(),
    groupIds,
  };
  fakeDb.users.push(user);
  groupIds.forEach((gid) => fakeDb.userGroups.push({ user_id: user.id, id: gid }));
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

describe('U-4 — iconos de apps con control de acceso (/uploads/app-icons)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    // Limpiar uploads (raíz + subcarpeta app-icons) entre tests.
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
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('anónimo NO ve el icono de una app restricted -> 403', async () => {
    seedApp(fakeDb, { id: 1, visibility: 'restricted', groupIds: [10] });
    seedIconFile(1);
    const app = createApp();
    const res = await request(app).get('/uploads/app-icons/app-icon-1.png');
    expect(res.status).toBe(403);
  });

  it('anónimo SÍ ve el icono de una app public -> 200 image/png', async () => {
    seedApp(fakeDb, { id: 2, visibility: 'public' });
    seedIconFile(2);
    const app = createApp();
    const res = await request(app).get('/uploads/app-icons/app-icon-2.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('employee con grupo asignado ve el icono restricted -> 200', async () => {
    seedApp(fakeDb, { id: 3, visibility: 'restricted', groupIds: [10] });
    seedIconFile(3);
    const user = seedUser(fakeDb, { role: 'employee', groupIds: [10] });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app)
      .get('/uploads/app-icons/app-icon-3.png')
      .set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('employee con OTRO grupo (no asignado) NO ve el icono restricted -> 403', async () => {
    seedApp(fakeDb, { id: 4, visibility: 'restricted', groupIds: [10] });
    seedIconFile(4);
    const user = seedUser(fakeDb, { role: 'employee', groupIds: [99] });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app)
      .get('/uploads/app-icons/app-icon-4.png')
      .set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('employee sin ningún grupo NO ve el icono restricted -> 403', async () => {
    seedApp(fakeDb, { id: 5, visibility: 'restricted', groupIds: [10] });
    seedIconFile(5);
    const user = seedUser(fakeDb, { role: 'employee' });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app)
      .get('/uploads/app-icons/app-icon-5.png')
      .set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(403);
  });

  it('super_admin ve el icono restricted -> 200', async () => {
    seedApp(fakeDb, { id: 6, visibility: 'restricted', groupIds: [10] });
    seedIconFile(6);
    const user = seedUser(fakeDb, { role: 'super_admin' });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app)
      .get('/uploads/app-icons/app-icon-6.png')
      .set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
  });

  it('admin ve el icono restricted -> 200', async () => {
    seedApp(fakeDb, { id: 7, visibility: 'restricted', groupIds: [10] });
    seedIconFile(7);
    const user = seedUser(fakeDb, { role: 'admin' });
    const token = seedSession(fakeDb, user);
    const app = createApp();
    const res = await request(app)
      .get('/uploads/app-icons/app-icon-7.png')
      .set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
  });

  it('app inexistente -> 404 (sin importar la sesión)', async () => {
    seedIconFile(999);
    const app = createApp();
    const res = await request(app).get('/uploads/app-icons/app-icon-999.png');
    expect(res.status).toBe(404);
  });

  it('nombre inválido -> 404, nunca path traversal', async () => {
    seedApp(fakeDb, { id: 8, visibility: 'public' });
    seedIconFile(8);
    const app = createApp();
    const attempts = [
      '/uploads/app-icons/..%2F..%2Fpackage.json',
      '/uploads/app-icons/..%2fapp-icon-8.png',
      '/uploads/app-icons/.%2e/app-icon-8.png',
      '/uploads/app-icons/app-icon-8.txt',
      '/uploads/app-icons/otro.png',
      '/uploads/app-icons/app-icon-8',
      '/uploads/app-icons/app-icon-x.png',
      '/uploads/app-icons/%2e%2e%2fsecret',
    ];
    for (const u of attempts) {
      const res = await request(app).get(u);
      expect(res.status, `GET ${u}`).toBe(404);
    }
  });
});

describe('U-4 — el logo /uploads/logo.* sigue público', () => {
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
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('anónimo ve /uploads/logo.png -> 200 image/png con cache inmutable', async () => {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'logo.png'), PNG_1x1);
    const app = createApp();
    const res = await request(app).get('/uploads/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('anónimo ve /uploads/logo.jpg -> 200 image/jpeg', async () => {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'logo.jpg'), PNG_1x1);
    const app = createApp();
    const res = await request(app).get('/uploads/logo.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });

  it('una extensión no permitida en /uploads/logo.* -> 404', async () => {
    const app = createApp();
    const res = await request(app).get('/uploads/logo.svg');
    expect(res.status).toBe(404);
  });
});
