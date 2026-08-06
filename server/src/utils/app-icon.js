// Resolución de la cadena de iconos de una aplicación (Single Source of Truth).
//
// Cadena FINAL de resolución, aplicada server-side y replicada client-side en
// la vista previa del formulario de apps:
//   a) app.icon_url         -> imagen externa (o local subida por el admin)
//   b) app.icon_key         -> icono de la biblioteca local: /icons/<slug>.png
//                              (SIEMPRE se valida el slug contra icons.json;
//                               si el slug no existe, se pasa al siguiente)
//   c) app.icon_class       -> icono de fuente (<i class="...">)
//   d) favicon público      -> favicon del dominio público de app.url
//                              (solo URL client-side; nunca fetch server-side)
//   e) glifo                -> inicial del nombre + color de la app
//
// El manifest (icons.json) es el registro de la biblioteca local; NO se
// confía en la existencia del fichero para validar el slug.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { faviconUrls } = require('./favicon');

const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'icons', 'icons.json');

let manifestCache = null;

function loadManifest() {
  if (manifestCache) return manifestCache;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    manifestCache = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    manifestCache = [];
  }
  return manifestCache;
}

// Exposición para tests: permite recalcular el manifest sin reiniciar.
function resetManifestCache() {
  manifestCache = null;
}

// Devuelve la lista completa del manifest [{ slug, label, category }].
function listIcons() {
  return loadManifest().map((i) => ({ ...i }));
}

// ¿Existe el slug en la biblioteca local?
function isValidSlug(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') return false;
  return loadManifest().some((i) => i.slug === slug.trim());
}

// Devuelve la entrada del manifest para un slug (o null).
function getIcon(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') return null;
  return loadManifest().find((i) => i.slug === slug.trim()) || null;
}

// Cache-busting de iconos subidos localmente: si la URL es un upload del
// portal (/uploads/app-icons/app-icon-<id>.<ext>) se añade ?v=<mtime del
// fichero> para que el navegador refresque al reemplazar la imagen. Si no se
// puede leer el fichero, se devuelve la URL sin versión (defensa: nunca romper
// el render).
function withUploadVersion(url) {
  if (typeof url !== 'string') return url;
  if (!url.startsWith('/uploads/app-icons/app-icon-')) return url;
  const filename = url.split('?')[0].replace(/^\/uploads\/app-icons\//, '');
  const safeName = path.basename(filename);
  try {
    const stat = fs.statSync(path.join(config.uploadsDir, 'app-icons', safeName));
    return `${url}${url.includes('?') ? '&' : '?'}v=${Math.round(stat.mtimeMs)}`;
  } catch (err) {
    return url;
  }
}

// Resuelve el icono efectivo de una app devolviendo un objeto descriptivo.
// Cada tipo (kind) indica cómo debe renderizarse:
//   { kind: 'url',     url }                 -> <img src="url">
//   { kind: 'key',     slug, url }           -> <img src="/icons/<slug>.png">
//   { kind: 'class',   iconClass }           -> <i class="iconClass">
//   { kind: 'favicon', url, fallbackUrl }    -> <img> con fallback client-side
//   { kind: 'glyph',   initial, color }      -> inicial + color (fallback final)
function resolveAppIcon(app) {
  if (!app) return { kind: 'glyph', initial: '?', color: '#4f8cff' };

  // a) icon_url (externo o upload local) — precede siempre.
  if (typeof app.icon_url === 'string' && app.icon_url.trim() !== '') {
    return { kind: 'url', url: withUploadVersion(app.icon_url.trim()) };
  }

  // b) icon_key de la biblioteca local, validado contra el manifest.
  if (typeof app.icon_key === 'string' && app.icon_key.trim() !== '') {
    const entry = getIcon(app.icon_key);
    if (entry) {
      return { kind: 'key', slug: entry.slug, url: `/icons/${entry.slug}.png` };
    }
    // Slug desconocido -> cae al siguiente eslabón.
  }

  // c) icon_class (icono de fuente).
  if (typeof app.icon_class === 'string' && app.icon_class.trim() !== '') {
    return { kind: 'class', iconClass: app.icon_class.trim() };
  }

  // d) favicon automático SOLO de hostnames públicos (cero SSRF).
  const icons = faviconUrls(app.url);
  if (icons) {
    return { kind: 'favicon', url: icons.primary, fallbackUrl: icons.fallback };
  }

  // e) glifo con la inicial y el color.
  const name = app.name || '?';
  return { kind: 'glyph', initial: name.charAt(0).toUpperCase(), color: app.color || '#4f8cff' };
}

// Etiqueta amigable de un slug (para la UI del picker y el form).
function labelForSlug(slug) {
  const entry = getIcon(slug);
  return entry ? entry.label : slug;
}

module.exports = {
  resolveAppIcon,
  listIcons,
  getIcon,
  isValidSlug,
  labelForSlug,
  loadManifest,
  resetManifestCache,
  withUploadVersion,
};
