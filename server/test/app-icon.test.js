import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAppIcon, isValidSlug, getIcon, listIcons, labelForSlug } from '../src/utils/app-icon.js';

// Cadena de resolución de iconos (utils/app-icon.js):
//   a) icon_url (externa o upload local)
//   b) icon_key -> /icons/<slug>.png (SIEMPRE validado contra icons.json)
//   c) icon_class -> <i class="...">
//   d) favicon del dominio PÚBLICO (solo hostnames públicos)
//   e) glifo (inicial + color)

function app(overrides = {}) {
  return {
    name: 'Proxmox',
    url: 'https://pve.internal.corp',
    color: '#4f8cff',
    icon_url: null,
    icon_key: null,
    icon_class: null,
    ...overrides,
  };
}

describe('resolveAppIcon — precedencia de la cadena', () => {
  it('a) icon_url gana sobre todo lo demás', () => {
    const icon = resolveAppIcon(app({
      icon_url: 'https://cdn.example.com/icon.png',
      icon_key: 'proxmox',
      icon_class: 'fas fa-server',
    }));
    expect(icon.kind).toBe('url');
    expect(icon.url).toBe('https://cdn.example.com/icon.png');
  });

  it('a) el upload local /uploads/app-icons/ recibe cache-busting ?v= (si el fichero existe)', () => {
    const icon = resolveAppIcon(app({ icon_url: '/uploads/app-icons/app-icon-3.png' }));
    expect(icon.kind).toBe('url');
    expect(icon.url).toMatch(/^\/uploads\/app-icons\/app-icon-3\.png(\?v=\d+)?$/);
  });

  it('b) icon_key válido -> ruta estática /icons/<slug>.png', () => {
    const icon = resolveAppIcon(app({ icon_key: 'proxmox' }));
    expect(icon.kind).toBe('key');
    expect(icon.slug).toBe('proxmox');
    expect(icon.url).toBe('/icons/proxmox.png');
  });

  it('b) icon_key con slug INEXISTENTE en el manifest cae al siguiente eslabón', () => {
    const icon = resolveAppIcon(app({ icon_key: 'no-existe-este-slug', icon_class: 'fas fa-database' }));
    expect(icon.kind).toBe('class');
    expect(icon.iconClass).toBe('fas fa-database');
  });

  it('b) icon_key inexistente y sin más -> favicon público si el dominio lo parece', () => {
    const icon = resolveAppIcon(app({ icon_key: 'slug-inventado', url: 'https://grafana.com' }));
    expect(icon.kind).toBe('favicon');
    expect(icon.url).toContain('grafana.com');
  });

  it('c) icon_class -> kind class', () => {
    const icon = resolveAppIcon(app({ icon_class: 'fas fa-server' }));
    expect(icon.kind).toBe('class');
    expect(icon.iconClass).toBe('fas fa-server');
  });

  it('d) favicon solo para hostnames PÚBLICOS (nunca internos/IPs)', () => {
    const pub = resolveAppIcon(app({ url: 'https://nextcloud.com' }));
    expect(pub.kind).toBe('favicon');
    expect(pub.url).toContain('nextcloud.com');

    const internal = resolveAppIcon(app({ url: 'http://pve.corp.example.com' }));
    expect(internal.kind).toBe('glyph');

    const ip = resolveAppIcon(app({ url: 'https://10.0.0.5:8006' }));
    expect(ip.kind).toBe('glyph');
  });

  it('e) glifo con inicial y color como fallback final', () => {
    const icon = resolveAppIcon(app());
    expect(icon.kind).toBe('glyph');
    expect(icon.initial).toBe('P');
    expect(icon.color).toBe('#4f8cff');
  });

  it('app nula/nombre vacío -> glifo seguro', () => {
    expect(resolveAppIcon(null).kind).toBe('glyph');
    expect(resolveAppIcon({}).initial).toBe('?');
  });

  it('icon_url e icon_key NO se mezclan (precedencia estricta a)', () => {
    const icon = resolveAppIcon(app({ icon_url: 'https://x.com/i.png', icon_key: 'docker' }));
    expect(icon.kind).toBe('url');
    expect(icon.url).toBe('https://x.com/i.png');
  });
});

describe('manifest icons.json', () => {
  it('el manifest está cargado y contiene los slugs esenciales', () => {
    expect(isValidSlug('proxmox')).toBe(true);
    expect(isValidSlug('docker')).toBe(true);
    expect(isValidSlug('n8n')).toBe(true);
    expect(isValidSlug('paperless-ngx')).toBe(true);
    expect(isValidSlug('adguard-home')).toBe(true);
    expect(isValidSlug('pi-hole')).toBe(true);
  });

  it('slugs desconocidos o vacíos no son válidos', () => {
    expect(isValidSlug('no-existe')).toBe(false);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug(null)).toBe(false);
  });

  it('cada entrada del manifest tiene slug, label y category', () => {
    const icons = listIcons();
    expect(icons.length).toBeGreaterThanOrEqual(40);
    for (const i of icons) {
      expect(typeof i.slug).toBe('string');
      expect(i.slug).toBeTruthy();
      expect(typeof i.label).toBe('string');
      expect(i.label).toBeTruthy();
      expect(typeof i.category).toBe('string');
      expect(i.category).toBeTruthy();
    }
  });

  it('labelForSlug devuelve la etiqueta o el propio slug', () => {
    expect(labelForSlug('proxmox')).toBe('Proxmox');
    expect(labelForSlug('whatever')).toBe('whatever');
  });

  it('getIcon devuelve la entrada completa del manifest', () => {
    const entry = getIcon('proxmox');
    expect(entry).toMatchObject({ slug: 'proxmox', category: 'Virtualización' });
  });
});
