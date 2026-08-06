import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// R3: tema claro/oscuro. El HTML renderizado debe incluir el script externo
// de tema en <head>, el atributo data-default-theme, y NINGÚN script inline
// (CSP 'self').
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let sessionService;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
});

function hasInlineScript(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>/i;
  return re.test(html);
}

describe('tema (R3): script externo, data-default-theme y sin scripts inline', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('login incluye /js/theme.js en <head> y data-default-theme', async () => {
    const app = createApp();
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<html[^>]*data-default-theme="/);
    expect(res.text).toMatch(/<head>[\s\S]*<script src="\/js\/theme\.js(?:\?v=[0-9a-f]{8})?"><\/script>/);
  });

  it('el dashboard anónimo también aplica el tema', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/theme.js');
    expect(res.text).toContain('data-default-theme=');
    expect(res.text).toContain('data-theme-toggle');
  });

  it('Ninguna página renderiza scripts inline (CSP)', async () => {
    const app = createApp();
    const pages = ['/', '/login', '/admin/audit', '/no-existe'];
    for (const p of pages) {
      const res = await request(app).get(p);
      expect(hasInlineScript(res.text), `página ${p} no debe tener <script> inline`).toBe(false);
    }
  });

  it('una página autenticada (admin) usa el tema y data-default-theme', async () => {
    const user = {
      id: 1, email: 'admin@testcorp.com', display_name: 'admin', role: 'super_admin',
      status: 'active', session_version: 0, last_login_at: null, created_at: new Date(),
    };
    fakeDb.users.push(user);
    const token = sessionService.generateToken();
    fakeDb.sessions.push({
      id: 's-1', token_hash: sessionService.hashToken(token), user_id: user.id,
      session_version_enrolled: 0, expires_at: new Date(Date.now() + 86400000),
      created_at: new Date(), revoked_at: null,
    });

    const app = createApp();
    const res = await request(app).get('/admin/audit').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/theme.js');
    expect(res.text).toContain('data-theme-toggle');
  });
});
