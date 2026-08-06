import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Tests de RENDER del login (flujo de 2 pasos):
//   (a) En el HTML inicial SOLO #login-form está visible; #verify-form nace
//       oculto con el ATRIBUTO `hidden` (no con una clase que el CSS ignora).
//   (a2) El CSS servido contiene la regla [hidden]{display:none!important}
//       (ningún selector .auth-card form puede pisarla) y el espaciado nuevo.
//   (b) El email del usuario no se filtra en el alert de error (mensaje
//       genérico) cuando la página se renderiza con ?error=….
//   (c) El input visible bootstrap_token existe cuando corresponde
//       (needsBootstrap = email == SUPER_ADMIN_EMAIL + BOOTSTRAP_TOKEN).
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';
process.env.BOOTSTRAP_TOKEN = 'bootstrap-secret-token-123';

let db;
let createApp;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
});

describe('login: render del flujo secuencial (un solo form visible)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  it('(a) HTML inicial: solo #login-form visible; #verify-form oculto con el atributo hidden', async () => {
    const app = createApp();
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);

    // Paso 1 (email) visible: su tag NO contiene hidden.
    expect(res.text).toMatch(/<form id="login-form" method="post" action="\/auth\/request"[^>]*>/);
    expect(res.text).not.toMatch(/<form id="login-form"[^>]*hidden/);

    // Paso 2 (código) oculto: su tag SÍ contiene el atributo hidden.
    expect(res.text).toMatch(/<form id="verify-form"[^>]*hidden/);
    // La clase obsoleta "verify-form hidden" ya no existe (ahora es atributo).
    expect(res.text).not.toContain('class="verify-form hidden"');
    expect(res.text).not.toMatch(/<form id="verify-form"[^>]*class="[^"]*hidden/);

    // La región viva de notificación existe y nace oculta (aria-live lista).
    expect(res.text).toMatch(/<div id="login-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);

    // Ambos forms siguen presentes en el DOM (el flujo 2 pasos se mantiene).
    expect(res.text).toContain('id="login-form"');
    expect(res.text).toContain('id="verify-form"');
    expect(res.text).toContain('id="back-btn"');
  });

  it('(a2) CSS servido: [hidden]{display:none!important} y espaciado .auth-card form', async () => {
    const app = createApp();
    const res = await request(app).get('/css/styles.css');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    // El form de email es una columna con gap (espaciado label->input->botón).
    expect(res.text).toMatch(/\.auth-card form\s*\{\s*display:\s*flex;/);
    expect(res.text).toMatch(/gap:\s*14px;/);
    // El botón "Enviar código" nunca queda pegado al input.
    expect(res.text).toMatch(/\.auth-card \.btn-block\s*\{\s*margin-top:\s*4px;/);
  });

  it('(b) error genérico: el email del usuario NO se filtra en el alert de error', async () => {
    const app = createApp();
    const res = await request(app).get('/login?error=invalid&email=alice@testcorp.com');
    expect(res.status).toBe(200);

    const alert = res.text.match(/<div class="alert alert-error"[^>]*>([^<]*)<\/div>/);
    expect(alert).toBeTruthy();
    expect(alert[1]).toContain('Credenciales inválidas');
    expect(alert[1]).not.toContain('alice@testcorp.com');

    // El email solo se refleja como prefill del input (comportamiento intencional,
    // no es una filtración: es el correo que el propio usuario escribió).
    expect(res.text).toContain('value="alice@testcorp.com"');
  });

  it('(c) needsBootstrap: el input visible bootstrap_token existe si email == SUPER_ADMIN_EMAIL', async () => {
    const app = createApp();

    // admin@testcorp.com == SUPER_ADMIN_EMAIL y hay BOOTSTRAP_TOKEN -> input visible.
    const res = await request(app).get('/login?email=admin@testcorp.com');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="bootstrap-token-input"');
    expect(res.text).toContain('name="bootstrap_token"');

    // Cualquier otro email -> sin input de bootstrap.
    const res2 = await request(app).get('/login?email=emp@testcorp.com');
    expect(res2.status).toBe(200);
    expect(res2.text).not.toContain('bootstrap-token-input');

    // Y el login sin email en la query tampoco lo pide.
    const res3 = await request(app).get('/login');
    expect(res3.text).not.toContain('bootstrap-token-input');
  });

  it('(e) cache-busting: los assets se referencian con ?v=<hash del contenido>', async () => {
    const app = createApp();
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);

    // login.js (esta vista) y los del layout (theme.js, styles.css) versionados.
    const loginMatch = res.text.match(/<script src="\/js\/login\.js\?v=([0-9a-f]{8})" defer><\/script>/);
    expect(loginMatch).toBeTruthy();
    expect(res.text).toMatch(/<script src="\/js\/theme\.js\?v=[0-9a-f]{8}"><\/script>/);
    expect(res.text).toMatch(/<link rel="stylesheet" href="\/css\/styles\.css\?v=[0-9a-f]{8}">/);

    // El versionado es POR CONTENIDO: el hash en la URL coincide con el hash
    // calculado por el helper sobre el fichero real (src/utils/asset-version.js).
    const { getAssetVersion } = await import('../src/utils/asset-version.js');
    expect(loginMatch[1]).toBe(getAssetVersion('/js/login.js'));
    expect(getAssetVersion('/js/login.js')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('(e2) dev: los estáticos se sirven con Cache-Control: no-cache (sin caché de 24 h)', async () => {
    const app = createApp();
    const res = await request(app).get('/js/login.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
