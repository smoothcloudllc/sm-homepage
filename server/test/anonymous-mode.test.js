import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// ANONYMOUS_MODE=off: el dashboard exige sesión. GET / sin sesión -> 302 a
// /login (despliegues solo-autenticados); con sesión -> 200 sin cambios.
// La variable se fija ANTES de cargar el módulo (config se lee al importar).
process.env.ANONYMOUS_MODE = 'off';

let db;
let createApp;
let sessionService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
});

describe('ANONYMOUS_MODE=off (dashboard solo-autenticado)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
    fakeDb.apps.push({
      id: 1, name: 'Portal Público', url: 'https://public.example.com', icon_url: null,
      icon_key: null, icon_class: null, description: '', category: 'General',
      category_id: null, color: '#4f8cff', visibility: 'public', groupIds: [],
    });
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('GET / sin sesión -> 302 a /login', async () => {
    const app = createApp();
    const res = await request(app).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET / con sesión -> 200 y sigue mostrando el dashboard', async () => {
    const user = {
      id: fakeDb.sequence.users++,
      email: 'admin@testcorp.com',
      display_name: 'admin',
      role: 'super_admin',
      status: 'active',
      session_version: 0,
      last_login_at: null,
      created_at: new Date(),
    };
    fakeDb.users.push(user);
    const token = sessionService.generateToken();
    fakeDb.sessions.push({
      id: 's-1',
      token_hash: sessionService.hashToken(token),
      user_id: user.id,
      session_version_enrolled: 0,
      expires_at: new Date(Date.now() + 86400000),
      created_at: new Date(),
      revoked_at: null,
    });
    const app = createApp();
    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Portal Público');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('GET /login sigue siendo accesible sin sesión (para autenticarse)', async () => {
    const app = createApp();
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
  });
});
