// Cache-busting por contenido de los assets estáticos propios (/js, /css).
//
// Problema resuelto: express.static servía los estáticos con maxAge 1 día y el
// navegador conservaba versiones viejas de p.ej. /js/login.js durante 24 h,
// con lo que los cambios no se propagaban sin un hard reload.
//
// Estrategia:
//   1) Cada vista referencia el asset con query string ?v=<hash del contenido>
//      (p. ej. /js/login.js?v=1f0a4c2b). Cuando el archivo cambia, cambia el
//      hash, la URL cambia y el navegador descarga la versión nueva.
//   2) Los assets se sirven con caché agresiva en producción (maxAge 1 día):
//      como la URL cambia con el contenido, esa caché nunca devuelve una
//      versión obsoleta. En desarrollo se sirven con Cache-Control: no-cache.
//
// CSP: la directiva script-src/style-src usa 'self' (mismo origen). El query
// string NO forma parte de la ruta a la hora de casar 'self' (CSP3: path
// matching ignora query y fragment), por lo que ?v= NO rompe la política.
//
// El hash se calcula de forma LENTA y se cachea en memoria por (mtimeMs, size):
// el costo es un stat por asset por request y el hash solo se recalcula cuando
// el archivo cambia. Así en desarrollo los cambios se recogen sin reiniciar.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ALLOWED_EXT = new Set(['.js', '.css']);
const HASH_LEN = 8;

// urlPath -> { mtimeMs, size, hash }
const hashCache = new Map();

// Resuelve la ruta absoluta dentro de PUBLIC_DIR para un urlPath público
// (p. ej. '/js/login.js'). Devuelve null si el path es inválido o se sale de
// PUBLIC_DIR (defensa contra traversal, aunque el caller sea una vista).
function resolvePublicPath(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;
  if (!ALLOWED_EXT.has(path.extname(urlPath).toLowerCase())) return null;
  const abs = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

// Devuelve el hash corto (hex, HASH_LEN chars) del contenido del asset o null
// si el archivo no existe / no es legible / el path no es válido.
function getAssetVersion(urlPath) {
  const abs = resolvePublicPath(urlPath);
  if (!abs) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const cached = hashCache.get(urlPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.hash;
    }
    const content = fs.readFileSync(abs);
    const hash = crypto
      .createHash('sha1')
      .update(content)
      .digest('hex')
      .slice(0, HASH_LEN);
    hashCache.set(urlPath, { mtimeMs: st.mtimeMs, size: st.size, hash });
    return hash;
  } catch {
    return null;
  }
}

// Devuelve la URL pública con el versionado por contenido: '/js/login.js?v=abc'.
// Si el hash no se puede calcular (fallback de seguridad) devuelve la URL sin
// versionar (el maxAge por entorno evita cachés obsoletas en ese caso).
function assetUrl(urlPath) {
  const hash = getAssetVersion(urlPath);
  return hash ? `${urlPath}?v=${hash}` : urlPath;
}

module.exports = { getAssetVersion, assetUrl, PUBLIC_DIR };
