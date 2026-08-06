// Resolución del FAVICON automático por dominio (estilo Linkwarden).
//
// Política de seguridad: el favicon externo se genera SOLO como URL client-side
// que el NAVEGADOR cargará directamente (icons.duckduckgo.com / google s2).
// El servidor NUNCA hace fetch a estos servicios -> cero SSRF.
//
// Cadena de iconos de una app (se aplica en el template):
//   a) icon_url         -> imagen explícita del admin
//   b) icon_class       -> icono de fuente (<i class="...">)
//   c) favicon auto     -> favicon del dominio PÚBLICO de app.url
//   d) fallback         -> inicial del nombre con el color de la app
//
// Este módulo SOLO extrae el hostname y decide si parece público; nunca
// contacta con la red.

const FAVICON_SERVICE_DUCKDUCKGO = 'https://icons.duckduckgo.com/ip3/';
const FAVICON_SERVICE_GOOGLE = 'https://www.google.com/s2/favicons?domain=';

// Labels/hostnames internos (lista corta, no exhaustiva). Se comprueba en
// CUALQUIER posición del hostname (no solo como TLD): p. ej. una URL interna
// típica es `pve.corp.example.com` (label "corp").
const PRIVATE_LABELS = new Set([
  'local',
  'internal',
  'lan',
  'localdomain',
  'home',
  'intranet',
  'corp',
  'test',
  'invalid',
  'onion',
  'private',
]);

// Extrae el hostname de una URL http/https (o null si no es válida o no es
// http(s)). Nunca resuelve ni hace peticiones: solo parseo local.
function extractHostname(urlString) {
  if (typeof urlString !== 'string' || urlString.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname || null;
}

function isIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Decide si un hostname parece PÚBLICO (candidato a favicon externo):
//   - rechaza localhost, IPs (públicas y privadas), IPv6
//   - rechaza dominios single-label (intranet, k8s, ...) sin punto
//   - rechaza labels internos en cualquier posición (.local, .internal,
//     .lan, .localdomain, .corp, ...) aunque el TLD parezca público
function isPublicHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.trim() === '') return false;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h.includes(':')) return false; // IPv6
  if (isIpv4(h)) return false;       // IPv4 (privada o pública)
  if (h === 'localhost') return false;

  const labels = h.split('.');
  if (labels.length < 2) return false; // single-label -> interno
  for (const label of labels) {
    if (PRIVATE_LABELS.has(label)) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

// URL principal (DuckDuckGo, estable y sin key) + URL de respaldo (Google,
// devuelve un icono por defecto en caso de que DDG no tenga el sitio).
// Devuelve null si la URL no es http/https o el dominio no parece público.
function faviconUrls(appUrl) {
  const host = extractHostname(appUrl);
  if (!host || !isPublicHostname(host)) return null;
  return {
    primary: `${FAVICON_SERVICE_DUCKDUCKGO}${host}.ico`,
    fallback: `${FAVICON_SERVICE_GOOGLE}${host}&sz=128`,
  };
}

// Conveniencia: URL primaria (o null).
function faviconUrl(appUrl) {
  const urls = faviconUrls(appUrl);
  return urls ? urls.primary : null;
}

module.exports = { faviconUrl, faviconUrls, extractHostname, isPublicHostname };
