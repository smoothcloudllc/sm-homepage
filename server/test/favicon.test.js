import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { FakeDb } from './helpers/mockDb.js';

// Cadena de iconos automática (estilo Linkwarden): a) icon_url -> b) icon_class
// -> c) favicon del dominio público -> d) inicial con el color de la app.
// El favicon se resuelve como URL client-side (cero SSRF): el servidor solo
// extrae el hostname y decide si parece público; el navegador carga la img.
process.env.NODE_ENV = 'development';
process.env.ENABLE_DEV_CODE = 'true';

let db;
let createApp;
let sessionService;
let favicon;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
  ({ default: sessionService } = await import('../src/services/session.service.js'));
  const mod = await import('../src/utils/favicon.js');
  favicon = mod.default || mod;
});

describe('favicon helper: hostname público vs interno (unitario)', () => {
  it('extrae el hostname de URLs http/https (sin puerto ni ruta)', () => {
    expect(favicon.extractHostname('https://github.com/foo/bar')).toBe('github.com');
    expect(favicon.extractHostname('http://intra.example.com:8080/x')).toBe('intra.example.com');
  });

  it('devuelve null para URLs inválidas o de otro esquema', () => {
    expect(favicon.extractHostname('')).toBeNull();
    expect(favicon.extractHostname(null)).toBeNull();
    expect(favicon.extractHostname('no es una url')).toBeNull();
    expect(favicon.extractHostname('javascript:alert(1)')).toBeNull();
    expect(favicon.extractHostname('ftp://x.com')).toBeNull();
  });

  it('dominio público -> URL de DuckDuckGo (primaria) y Google (respaldo)', () => {
    const urls = favicon.faviconUrls('https://www.google.com/search?q=x');
    expect(urls.primary).toBe('https://icons.duckduckgo.com/ip3/www.google.com.ico');
    expect(urls.fallback).toBe('https://www.google.com/s2/favicons?domain=www.google.com&sz=128');
    expect(favicon.faviconUrl('https://www.google.com')).toBe('https://icons.duckduckgo.com/ip3/www.google.com.ico');
  });

  it('dominios internos -> null (cae al fallback de inicial)', () => {
    expect(favicon.faviconUrls('http://localhost:3000')).toBeNull();
    expect(favicon.faviconUrls('http://127.0.0.1:8080')).toBeNull();
    expect(favicon.faviconUrls('http://10.0.0.5:8080')).toBeNull();
    expect(favicon.faviconUrls('http://192.168.1.1')).toBeNull();
    expect(favicon.faviconUrls('http://172.16.0.1/app')).toBeNull();
    expect(favicon.faviconUrls('http://[::1]:8080')).toBeNull();
    expect(favicon.faviconUrls('http://intranet.local')).toBeNull();
    expect(favicon.faviconUrls('http://svc.internal')).toBeNull();
    expect(favicon.faviconUrls('http://nas.lan')).toBeNull();
    expect(favicon.faviconUrls('http://host.localdomain')).toBeNull();
    expect(favicon.faviconUrls('http://k8s')).toBeNull();       // single-label
    expect(favicon.faviconUrls('http://corp')).toBeNull();      // single-label
    expect(favicon.faviconUrls('https://pve.corp.example.com:8006')).toBeNull(); // label .corp.
  });

  it('isPublicHostname: público vs interno (casuística corta)', () => {
    expect(favicon.isPublicHostname('github.com')).toBe(true);
    expect(favicon.isPublicHostname('portal.acme.io')).toBe(true);
    expect(favicon.isPublicHostname('localhost')).toBe(false);
    expect(favicon.isPublicHostname('10.0.0.5')).toBe(false);
    expect(favicon.isPublicHostname('nas.lan')).toBe(false);
    expect(favicon.isPublicHostname('svc.internal')).toBe(false);
    expect(favicon.isPublicHostname('intranet')).toBe(false);
  });
});

describe('cadena de iconos en el render del dashboard (a->b->c->d)', () => {
  let fakeDb;
  beforeEach(() => {
    fakeDb = new FakeDb();
    db.setDbClient(fakeDb);
  });
  afterEach(() => {
    db.setDbClient(null);
  });

  function seedApp(fakeDb, app) {
    fakeDb.apps.push({
      id: app.id,
      name: app.name,
      url: app.url,
      icon_url: app.icon_url || null,
      icon_class: app.icon_class || null,
      description: app.description || `${app.name} desc`,
      category: app.category || 'General',
      color: app.color || '#4f8cff',
      visibility: 'public',
      groupIds: [],
    });
  }

  it('(c) app pública sin icono propio: el HTML incluye la img del favicon automático', async () => {
    seedApp(fakeDb, { id: 1, name: 'GitHub', url: 'https://github.com' });
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://icons.duckduckgo.com/ip3/github.com.ico');
    expect(res.text).toContain('class="app-icon-img app-icon-img--favicon"');
    // URL de respaldo (Google s2) presente como data-fallback-src (& escapado por EJS).
    expect(res.text).toContain('data-fallback-src="https://www.google.com/s2/favicons?domain=github.com&amp;sz=128"');
    // El glifo de fallback se pre-renderiza oculto para el onerror.
    expect(res.text).toContain('app-glyph-fallback');
  });

  it('(d) app interna (IP privada): fallback a la inicial, SIN favicon externo', async () => {
    seedApp(fakeDb, { id: 2, name: 'NAS', url: 'http://10.0.0.5:8080' });
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('icons.duckduckgo.com');
    expect(res.text).not.toContain('app-icon-img--favicon');
    expect(res.text).toContain('NAS');
    expect(res.text).toContain('app-glyph');
  });

  it('(a) app con icon_url: usa la URL del icono, no el favicon', async () => {
    seedApp(fakeDb, { id: 3, name: 'CRM', url: 'https://crm.acme.io', icon_url: 'https://cdn.acme.io/crm.png' });
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('src="https://cdn.acme.io/crm.png"');
    expect(res.text).not.toContain('icons.duckduckgo.com');
  });

  it('admin: la lista de apps muestra el favicon para dominios públicos', async () => {
    seedApp(fakeDb, { id: 4, name: 'Grafana', url: 'https://grafana.example.io' });
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
    const res = await request(app).get('/admin/apps').set('Cookie', [`sid=${token}`]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://icons.duckduckgo.com/ip3/grafana.example.io.ico');
    expect(res.text).toContain('cell-app-icon');
  });
});
