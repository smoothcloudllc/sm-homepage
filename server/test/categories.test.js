import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';
import {
  seedCategories,
  backfillCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  validateCategoryName,
  normalizeCategoryName,
  listCategories,
} from '../src/services/categories.service.js';
import { withTransaction } from '../src/db.js';

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

describe('validateCategoryName (servicio)', () => {
  it('acepta nombres válidos (trim + colapso de espacios)', () => {
    expect(validateCategoryName('  Finanzas  ')).toEqual({ ok: true, name: 'Finanzas' });
    expect(validateCategoryName('Dev Ops')).toEqual({ ok: true, name: 'Dev Ops' });
    expect(validateCategoryName('  Herramientas   Internas  ')).toEqual({ ok: true, name: 'Herramientas Internas' });
  });

  it('rechaza vacío, solo espacios y >80 caracteres', () => {
    expect(validateCategoryName('').ok).toBe(false);
    expect(validateCategoryName('   ').ok).toBe(false);
    expect(validateCategoryName(null).ok).toBe(false);
    expect(validateCategoryName(undefined).ok).toBe(false);
    expect(validateCategoryName('x'.repeat(81)).ok).toBe(false);
  });

  it('rechaza caracteres de control y saltos de línea (XSS/formato)', () => {
    expect(validateCategoryName('DevOps\n<script>alert(1)</script>').ok).toBe(false);
    expect(validateCategoryName('Dev\u0000Ops').ok).toBe(false);
    expect(validateCategoryName('Tab\there').ok).toBe(false);
    expect(validateCategoryName('Line1\r\nLine2').ok).toBe(false);
  });

  it('normalizeCategoryName colapsa espacios internos', () => {
    expect(normalizeCategoryName('  a   b  c ')).toBe('a b c');
    expect(normalizeCategoryName(null)).toBe('');
  });
});

describe('seedCategories y backfill (migración)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('seed idempotente: crea los defaults una sola vez y audita categories.seed', async () => {
    const first = await seedCategories(fakeDb);
    expect(first.sort()).toEqual(['Comunicación', 'DevOps', 'Finanzas', 'General', 'Herramientas', 'Productividad']);
    expect(fakeDb.categories).toHaveLength(6);

    const second = await seedCategories(fakeDb);
    expect(second).toEqual([]);
    expect(fakeDb.categories).toHaveLength(6);
    expect(fakeDb.auditLog.filter((a) => a.action === 'categories.seed')).toHaveLength(1);
  });

  it('backfill: apps con categories viejas se asignan (case-insensitive) y quedan 0 NULLs', async () => {
    await seedCategories(fakeDb);
    fakeDb.apps.push(
      { id: 1, name: 'A1', url: 'https://a', category: 'Finanzas', visibility: 'public' },
      { id: 2, name: 'A2', url: 'https://a', category: 'finanzas ', visibility: 'public' },
      { id: 3, name: 'A3', url: 'https://a', category: 'DevOps', visibility: 'public' },
      { id: 4, name: 'A4', url: 'https://a', category: '', visibility: 'public' },
      { id: 5, name: 'A5', url: 'https://a', category: null, visibility: 'public' },
      { id: 6, name: 'A6', url: 'https://a', category: 'Unknown Cat', visibility: 'public' }
    );

    const result = await backfillCategories(fakeDb);

    // 0 NULLs tras la migración.
    expect(fakeDb.apps.filter((a) => a.category_id == null)).toHaveLength(0);

    // 1 sola categoría Finanzas (case-insensitive), no dos.
    const finanzas = fakeDb.categories.filter((c) => c.name.toLowerCase() === 'finanzas');
    expect(finanzas).toHaveLength(1);

    // DevOps existe y 'Unknown Cat' se crea normalizada.
    expect(fakeDb.categories.some((c) => c.name === 'DevOps')).toBe(true);
    expect(fakeDb.categories.some((c) => c.name === 'Unknown Cat')).toBe(true);

    // Las apps de 'finanzas ' y 'Finanzas' comparten categoría.
    const finanzasId = finanzas[0].id;
    expect(fakeDb.apps.find((a) => a.id === 1).category_id).toBe(finanzasId);
    expect(fakeDb.apps.find((a) => a.id === 2).category_id).toBe(finanzasId);

    // Vacía/NULL -> General.
    const general = fakeDb.categories.find((c) => c.name === 'General');
    expect(fakeDb.apps.find((a) => a.id === 4).category_id).toBe(general.id);
    expect(fakeDb.apps.find((a) => a.id === 5).category_id).toBe(general.id);

    // Inventario reportado + auditoría de asignación.
    expect(result.inventory.length).toBeGreaterThan(0);
    expect(fakeDb.auditLog.some((a) => a.action === 'apps.category_assign')).toBe(true);
  });

  it('backfill idempotente: una segunda ejecución no rompe nada', async () => {
    await seedCategories(fakeDb);
    fakeDb.apps.push({ id: 1, name: 'A1', url: 'https://a', category: 'Finanzas', visibility: 'public' });

    await backfillCategories(fakeDb);
    const firstState = fakeDb.categories.map((c) => ({ id: c.id, name: c.name }));
    await backfillCategories(fakeDb);

    expect(fakeDb.apps.filter((a) => a.category_id == null)).toHaveLength(0);
    expect(fakeDb.categories).toHaveLength(firstState.length);
    expect(fakeDb.categories.length).toBeGreaterThanOrEqual(6);
  });

  it('backfill: sin apps no lanza y el seed de General sigue presente', async () => {
    await seedCategories(fakeDb);
    await backfillCategories(fakeDb);
    expect(fakeDb.categories.some((c) => c.name === 'General')).toBe(true);
  });
});

describe('CRUD de categorías (servicio)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('crear y listar alfabéticamente', async () => {
    const a = await createCategory(fakeDb, 'Zebra', 1);
    const b = await createCategory(fakeDb, 'Alpha', 1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const list = await listCategories(fakeDb);
    expect(list.map((c) => c.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('23505 duplicado -> mensaje amigable (case-insensitive)', async () => {
    await createCategory(fakeDb, 'Finanzas', 1);
    const dup = await createCategory(fakeDb, 'finanzas', 1);
    expect(dup.ok).toBe(false);
    expect(dup.error.toLowerCase()).toContain('ya existe');
    const dup2 = await createCategory(fakeDb, ' FINANZAS ', 1);
    expect(dup2.ok).toBe(false);
  });

  it('renombrar: cambia el nombre y el duplicado se reporta amigable', async () => {
    await createCategory(fakeDb, 'Vieja', 1);
    await createCategory(fakeDb, 'Nueva', 1);
    const renamed = await renameCategory(fakeDb, 1, '  Renombrada  ', 1);
    expect(renamed.ok).toBe(true);
    expect(renamed.name).toBe('Renombrada');

    const dup = await renameCategory(fakeDb, 1, 'Nueva', 1);
    expect(dup.ok).toBe(false);
    expect(dup.error.toLowerCase()).toContain('ya existe');
  });

  it('borrar: sin apps elimina', async () => {
    await createCategory(fakeDb, 'Temporal', 1);
    const res = await deleteCategory(fakeDb, 1, { withTransaction });
    expect(res.ok).toBe(true);
    expect(fakeDb.categories).toHaveLength(0);
  });

  it('borrar en uso -> 400 bloqueado; con reassign=true reasigna a General y borra', async () => {
    await seedCategories(fakeDb); // crea General (id 1) y otras
    await createCategory(fakeDb, 'Ventas', 1);
    const ventas = fakeDb.categories.find((c) => c.name === 'Ventas');
    fakeDb.apps.push(
      { id: 1, name: 'CRM', url: 'https://a', category: 'Ventas', visibility: 'public', category_id: ventas.id },
      { id: 2, name: 'Otro', url: 'https://a', category: 'Ventas', visibility: 'public', category_id: ventas.id }
    );

    const blocked = await deleteCategory(fakeDb, ventas.id, { withTransaction });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(400);
    expect(blocked.error).toContain('aplicaciones');

    const ok = await deleteCategory(fakeDb, ventas.id, { reassign: true, withTransaction });
    expect(ok.ok).toBe(true);
    expect(ok.reassigned).toBe(true);
    expect(fakeDb.categories.some((c) => c.id === ventas.id)).toBe(false);
    const general = fakeDb.categories.find((c) => c.name === 'General');
    expect(fakeDb.apps.every((a) => a.category_id === general.id)).toBe(true);
  });

  it('General está protegida (no se borra nunca)', async () => {
    await seedCategories(fakeDb);
    const general = fakeDb.categories.find((c) => c.name === 'General');
    const res = await deleteCategory(fakeDb, general.id, { reassign: true, withTransaction });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toContain('protegida');
    expect(fakeDb.categories.some((c) => c.name === 'General')).toBe(true);
  });
});

describe('/admin/categories (HTTP, RBAC super_admin)', () => {
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
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('sin sesión -> 302; admin -> 403; super_admin -> 200', async () => {
    const app = createApp();
    expect((await request(app).get('/admin/categories')).status).toBe(302);

    const admin = seedUser('admin');
    const adminToken = seedSession(admin);
    const asAdmin = await request(app).get('/admin/categories').set('Cookie', [`sid=${adminToken}`]);
    expect(asAdmin.status).toBe(403);

    const su = seedUser('super_admin');
    const suToken = seedSession(su);
    const asSu = await request(app).get('/admin/categories').set('Cookie', [`sid=${suToken}`]);
    expect(asSu.status).toBe(200);
    expect(asSu.text).toContain('Categorías');
  });

  it('crear, renombrar y borrar (con reasignación a General)', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/categories').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const created = await request(app)
      .post(`/admin/categories?_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ name: 'Ventas', _csrf: csrf });
    expect(created.status).toBe(302);
    const ventas = fakeDb.categories.find((c) => c.name === 'Ventas');
    expect(ventas).toBeTruthy();
    expect(fakeDb.auditLog.some((a) => a.action === 'categories.create')).toBe(true);

    const renamed = await request(app)
      .post(`/admin/categories/${ventas.id}/rename?_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ name: 'Comercial', _csrf: csrf });
    expect(renamed.status).toBe(302);
    expect(fakeDb.categories.find((c) => c.id === ventas.id).name).toBe('Comercial');

    // En uso sin reassign -> 400.
    fakeDb.apps.push({ id: 1, name: 'CRM', url: 'https://a', category: 'Comercial', visibility: 'public', category_id: ventas.id });
    const blocked = await request(app)
      .post(`/admin/categories/${ventas.id}/delete?_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ _csrf: csrf });
    expect(blocked.status).toBe(400);

    // Con reassign=true -> 302 y reasignación a General.
    const withReassign = await request(app)
      .post(`/admin/categories/${ventas.id}/delete?reassign=true&_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ _csrf: csrf });
    expect(withReassign.status).toBe(302);
    expect(fakeDb.categories.some((c) => c.id === ventas.id)).toBe(false);
    const general = fakeDb.categories.find((c) => c.name === 'General');
    expect(fakeDb.apps.find((a) => a.id === 1).category_id).toBe(general.id);
    expect(fakeDb.auditLog.some((a) => a.action === 'categories.delete' && a.details.reassigned === true)).toBe(true);
  });

  it('duplicado y General protegida -> 400 con mensaje amigable', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/categories').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const dup = await request(app)
      .post(`/admin/categories?_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ name: 'Finanzas', _csrf: csrf });
    expect(dup.status).toBe(400);
    expect(dup.text.toLowerCase()).toContain('ya existe');

    const general = fakeDb.categories.find((c) => c.name === 'General');
    const delGeneral = await request(app)
      .post(`/admin/categories/${general.id}/delete?_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ _csrf: csrf });
    expect(delGeneral.status).toBe(400);
    expect(delGeneral.text).toContain('protegida');
  });

  it('POST ?inline=1 responde JSON con {id, name} (atajo del form de apps)', async () => {
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/categories').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];

    const res = await request(app)
      .post(`/admin/categories?inline=1&_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ name: 'Finanzas', _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.name).toBe('Finanzas');
    expect(res.body.id).toBeTruthy();

    const dup = await request(app)
      .post(`/admin/categories?inline=1&_csrf=${csrf}`).set('Cookie', jar).type('form')
      .send({ name: 'finanzas', _csrf: csrf });
    expect(dup.status).toBe(400);
    expect(dup.body.error.toLowerCase()).toContain('ya existe');
  });
});

describe('apps-form: select de categoría + validación category_id', () => {
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
    return c.split(';')[0].slice('_csrf='.length);
  }

  it('GET /admin/apps/new: <select name="category_id"> con General preseleccionada', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const res = await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="category_id"');
    const general = fakeDb.categories.find((c) => c.name === 'General');
    // La opción de General aparece con selected y el value del id real.
    expect(res.text).toMatch(new RegExp(`<option value="${general.id}"\\s*selected>`));
  });

  it('POST /admin/apps con category_id válido -> 302; con inexistente -> 400', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    const finanzas = fakeDb.categories.find((c) => c.name === 'Finanzas');

    const ok = await request(app)
      .post('/admin/apps').set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Banca', url: 'https://banca.example.com',
        icon_url: '', icon_key: '', icon_class: '', description: '', category: 'Finanzas',
        color: '#4f8cff', visibility: 'public', category_id: String(finanzas.id),
      });
    expect(ok.status).toBe(302);
    const created = fakeDb.apps[0];
    expect(created.category_id).toBe(finanzas.id);

    const bad = await request(app)
      .post('/admin/apps').set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Fake', url: 'https://fake.example.com',
        icon_url: '', icon_key: '', icon_class: '', description: '', category: 'General',
        color: '#4f8cff', visibility: 'public', category_id: '999999',
      });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('no existe');
  });

  it('POST con icon_url E icon_key a la vez -> 400 "una sola fuente"', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    const general = fakeDb.categories.find((c) => c.name === 'General');

    const res = await request(app)
      .post('/admin/apps').set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'Ambos', url: 'https://ambos.example.com',
        icon_url: 'https://x.com/i.png', icon_key: 'docker', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: String(general.id),
      });
    expect(res.status).toBe(400);
    expect(res.text).toContain('una sola fuente');
  });

  it('POST con icon_key desconocido -> 400', async () => {
    await seedCategories(fakeDb);
    const su = seedUser('super_admin');
    const token = seedSession(su);
    const app = createApp();
    const csrf = getCsrf(await request(app).get('/admin/apps/new').set('Cookie', [`sid=${token}`]));
    const jar = [`sid=${token}`, `_csrf=${csrf}`];
    const general = fakeDb.categories.find((c) => c.name === 'General');

    const res = await request(app)
      .post('/admin/apps').set('Cookie', jar).type('form')
      .send({
        _csrf: csrf, name: 'BadIcon', url: 'https://bad.example.com',
        icon_url: '', icon_key: 'slug-que-no-existe', icon_class: '',
        description: '', category: 'General', color: '#4f8cff',
        visibility: 'public', category_id: String(general.id),
      });
    expect(res.status).toBe(400);
    expect(res.text).toContain('no existe');
  });
});

describe('Dashboard agrupa por category_name y no filtra el acceso', () => {
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

  function seedApp(fakeDb, { id, name, url, visibility, categoryId, categoryName, groupIds = [] }) {
    fakeDb.apps.push({
      id, name, url, icon_url: null, icon_key: null, icon_class: null,
      description: `${name} desc`, category: categoryName, category_id: categoryId,
      category_name: categoryName, color: '#4f8cff', visibility, groupIds,
    });
  }

  it('anónimo NO muestra la categoría que solo tiene apps restricted (sin fuga)', async () => {
    await seedCategories(fakeDb);
    const finanzas = fakeDb.categories.find((c) => c.name === 'Finanzas');
    seedApp(fakeDb, { id: 1, name: 'Secreta', url: 'https://secreta.internal', visibility: 'restricted', categoryId: finanzas.id, categoryName: 'Finanzas' });

    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Secreta');
    expect(res.text).not.toContain('Finanzas');
  });

  it('autenticado: agrupa por category_name (JOIN) y ordena alfabéticamente', async () => {
    await seedCategories(fakeDb);
    const finanzas = fakeDb.categories.find((c) => c.name === 'Finanzas');
    const general = fakeDb.categories.find((c) => c.name === 'General');
    seedApp(fakeDb, { id: 1, name: 'Banca', url: 'https://banca.example.com', visibility: 'public', categoryId: finanzas.id, categoryName: 'Finanzas' });
    seedApp(fakeDb, { id: 2, name: 'Wiki', url: 'https://wiki.example.com', visibility: 'public', categoryId: general.id, categoryName: 'General' });

    const user = seedUser('employee');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    // Los títulos de sección salen por category_name.
    const titleIndex = res.text.indexOf('category-title');
    expect(titleIndex).toBeGreaterThan(-1);
    const generalPos = res.text.indexOf('>General</h2>');
    const finanzasPos = res.text.indexOf('>Finanzas</h2>');
    expect(generalPos).toBeGreaterThan(-1);
    expect(finanzasPos).toBeGreaterThan(-1);
    // Orden alfabético: Finanzas antes que General.
    expect(finanzasPos).toBeLessThan(generalPos);
    // data-category usa el nombre de la categoría.
    expect(res.text).toContain('data-category="finanzas"');
  });

  it('el icono de una app con icon_key="proxmox" es <img src="/icons/proxmox.png">', async () => {
    const general = { id: 1, name: 'General', created_at: new Date() };
    fakeDb.categories.push(general);
    fakeDb.apps.push({
      id: 1, name: 'Proxmox', url: 'https://pve.internal', icon_url: null,
      icon_key: 'proxmox', icon_class: null, description: '', category: 'General',
      category_id: general.id, category_name: 'General', color: '#4f8cff',
      visibility: 'public', groupIds: [],
    });
    const user = seedUser('employee');
    const token = seedSession(user);
    const app = createApp();
    const res = await request(app).get('/').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('src="/icons/proxmox.png"');
  });
});
