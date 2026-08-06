// Gestión del logo de la empresa. SOLO PNG/JPEG, validación por MAGIC BYTES
// (nunca por extensión), ≤2 MB y dimensiones ≤2048 px. El archivo se guarda en
// el volumen de uploads con nombre FIJO por el servidor (logo.png|logo.jpg),
// lo que hace imposible path traversal. El servicio lo expone la ruta /logo
// con cache-busting ?v=<logo_version>.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const MAX_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;

// Detecta el tipo real de imagen leyendo los primeros bytes.
// Devuelve 'png' | 'jpeg' | null. Rechaza SVG y cualquier otro formato.
function detectImageType(buffer) {
  if (!buffer || buffer.length < 3) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpeg';
  return null;
}

// PNG: la cabecera IHDR tiene width/height en offset 16/20 (big-endian).
function readPngSize(buffer) {
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// JPEG: recorre los segmentos hasta un marcador SOF (dimensiones reales).
function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function readImageSize(buffer, type) {
  if (type === 'png') return readPngSize(buffer);
  if (type === 'jpeg') return readJpegSize(buffer);
  return null;
}

// Validación completa de un logo subido.
// Devuelve { ok: true, type, width, height } o { ok: false, error }.
function validateLogo(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'No se recibió ningún archivo.' };
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    return { ok: false, error: 'El archivo supera el tamaño máximo de 2 MB.' };
  }
  const type = detectImageType(buffer);
  if (!type) {
    return {
      ok: false,
      error: 'Formato no soportado: solo se admiten imágenes PNG o JPEG (validadas por contenido real, no por la extensión).',
    };
  }
  const size = readImageSize(buffer, type);
  if (!size) {
    return { ok: false, error: 'No se pudieron leer las dimensiones de la imagen.' };
  }
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    return {
      ok: false,
      error: `La imagen supera las dimensiones máximas (${MAX_DIMENSION}px por lado).`,
    };
  }
  return { ok: true, type, width: size.width, height: size.height };
}

function fileNameFor(type) {
  return `logo.${type === 'jpeg' ? 'jpg' : 'png'}`;
}

// Guarda el logo con nombre fijo (logo.png|logo.jpg) en el volumen de uploads.
// Escritura ATÓMICA (F-R2-1): primero a un archivo temporal en el mismo
// directorio y luego fs.renameSync (misma filesystem) para que un fallo a mitad
// de escritura nunca deje un logo truncado servible. Si falla, limpia el tmp.
// Elimina el otro formato para mantener un único logo activo.
function saveLogo(buffer, type) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const target = path.join(config.uploadsDir, fileNameFor(type));
  const tmp = path.join(config.uploadsDir, `.logo.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      // El tmp pudo no haberse creado: no es un error adicional.
    }
    throw err;
  }
  const other = path.join(config.uploadsDir, fileNameFor(type === 'jpeg' ? 'png' : 'jpeg'));
  try {
    fs.unlinkSync(other);
  } catch (err) {
    // No existía el otro formato: no es un error.
  }
  return target;
}

// Resuelve el logo a servir: si hay uno subido (png/jpg) lo devuelve; si no,
// sirve el logo por defecto (SVG embebido) para que la UI siempre renderice.
function resolveLogo() {
  for (const [ext, contentType] of [
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
  ]) {
    try {
      const buffer = fs.readFileSync(path.join(config.uploadsDir, `logo.${ext}`));
      return { buffer, contentType };
    } catch (err) {
      // No existe ese archivo: seguimos al siguiente.
    }
  }
  return { buffer: defaultLogoSvg(), contentType: 'image/svg+xml' };
}

// Logo por defecto (SVG mínimo inline, sin recursos externos).
function defaultLogoSvg() {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Logo">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#a371f7"/>
      </linearGradient></defs>
      <rect width="120" height="120" rx="24" fill="url(#g)"/>
      <g fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round">
        <rect x="30" y="30" width="24" height="24" rx="5"/>
        <rect x="66" y="30" width="24" height="24" rx="5"/>
        <rect x="30" y="66" width="24" height="24" rx="5"/>
        <rect x="66" y="66" width="24" height="24" rx="5"/>
      </g>
    </svg>`
  );
}

module.exports = {
  detectImageType,
  readImageSize,
  readPngSize,
  readJpegSize,
  validateLogo,
  saveLogo,
  resolveLogo,
  MAX_SIZE_BYTES,
  MAX_DIMENSION,
};
