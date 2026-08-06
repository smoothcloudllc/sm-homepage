import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Regresión del bug reportado: "el botón Guardar cambios no hace nada" al
// editar una app con icono subido.
//   Causa 1: #f-icon-url era type="url"; la validación nativa HTML5 rechazaba
//            el value local /uploads/app-icons/app-icon-<id>.png (ruta RELATIVA) y el
//            navegador bloqueaba el submit del form.
//   Causa 2: había un <form> ANIDADO (el del upload multipart) dentro del form
//            principal; el HTML prohibe forms anidados e interfería con el
//            submit del form padre.
// Corrección: #f-icon-url pasa a type="text" (la validación real es server-side
// isHttpUrl) y el upload multipart se hace vía fetch desde admin.js con un
// botón type="button" (sin form anidado).
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

// Extrae el HTML INTERIOR del form principal (el de action=<formAction>).
// El layout solo tiene un form antes (logout, en el header) y ninguno después,
// así que lastIndexOf('</form>') ancla el cierre del form principal.
function mainFormInner(html, formAction) {
  const open = html.indexOf(`<form method="post" action="${formAction}"`);
  expect(open, `form con action="${formAction}" debe existir`).toBeGreaterThan(-1);
  const openEnd = html.indexOf('>', open);
  const close = html.lastIndexOf('</form>');
  expect(close).toBeGreaterThan(openEnd);
  return html.slice(openEnd + 1, close);
}

describe('apps-form: #f-icon-url type="text" y sin form anidado (bug del botón Guardar)', () => {
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

  function seedGeneral() {
    fakeDb.categories.push({ id: 1, name: 'General', created_at: new Date() });
  }

  function seedApp(overrides = {}) {
    fakeDb.apps.push({
      id: 1, name: 'Proxmox', url: 'https://pve.internal', icon_url: null,
      icon_key: null, icon_class: null, description: '', category: 'General',
      category_id: 1, color: '#4f8cff', visibility: 'public', groupIds: [],
      ...overrides,
    });
  }

  async function getEditHtml(id = 1) {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const res = await request(app).get(`/admin/apps/${id}/edit`).set('Cookie', [`sid=${token}`]);
    return res;
  }

  it('(a) #f-icon-url es type="text", nunca type="url", y conserva el value local (caso del bug)', async () => {
    seedGeneral();
    seedApp({ icon_url: '/uploads/app-icons/app-icon-1.png' });
    const res = await getEditHtml(1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('type="text" id="f-icon-url" name="icon_url"');
    expect(res.text).not.toContain('type="url" id="f-icon-url"');
    expect(res.text).toContain('value="/uploads/app-icons/app-icon-1.png"');
  });

  it('(b) no hay <form> anidado dentro del form principal con icono subido', async () => {
    seedGeneral();
    seedApp({ icon_url: '/uploads/app-icons/app-icon-1.png' });
    const res = await getEditHtml(1);
    const inner = mainFormInner(res.text, '/admin/apps/1');
    expect(inner).not.toMatch(/<form[\s>]/);
    expect(inner).not.toContain('icon-upload-form');
    // El input file y el botón de upload viven DENTRO del form principal.
    expect(inner).toContain('id="f-icon-upload"');
    expect(inner).toContain('id="icon-upload-btn"');
    // El token CSRF del form principal se mantiene.
    expect(inner).toContain('name="_csrf"');
  });

  it('(c) el botón de upload es type="button" y el div expone data-app-id del appId', async () => {
    seedGeneral();
    seedApp({ icon_url: '/uploads/app-icons/app-icon-1.png' });
    const res = await getEditHtml(1);
    expect(res.text).toContain('<div class="icon-upload-box" data-app-id="1">');
    expect(res.text).toMatch(/<button type="button" class="btn btn-small" id="icon-upload-btn">/);
    expect(res.text).not.toContain('id="icon-upload-form"');
  });

  it('(d) sin icono, con icon_key y con URL externa https: type="text" y sin form anidado', async () => {
    seedGeneral();
    seedApp({ id: 1, name: 'A1', url: 'https://a1.internal', icon_url: null });
    seedApp({ id: 2, name: 'A2', url: 'https://a2.internal', icon_url: null, icon_key: 'proxmox' });
    seedApp({ id: 3, name: 'A3', url: 'https://a3.internal', icon_url: 'https://cdn.example.com/icon.png' });
    for (const id of [1, 2, 3]) {
      const res = await getEditHtml(id);
      expect(res.status).toBe(200);
      expect(res.text).toContain('type="text" id="f-icon-url" name="icon_url"');
      expect(res.text).not.toContain('type="url" id="f-icon-url"');
      const inner = mainFormInner(res.text, `/admin/apps/${id}`);
      expect(inner).not.toMatch(/<form[\s>]/);
    }
    // El value externo https se conserva tal cual.
    const res3 = await getEditHtml(3);
    expect(res3.text).toContain('value="https://cdn.example.com/icon.png"');
  });

  it('(e) el form "Nueva aplicación" (no edición) no renderiza el bloque de upload', async () => {
    seedGeneral();
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const res = await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('type="text" id="f-icon-url" name="icon_url"');
    expect(res.text).not.toContain('data-app-id');
    expect(res.text).not.toContain('icon-upload-btn');
  });
});
