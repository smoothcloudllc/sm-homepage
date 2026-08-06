// Upload de icono personalizado por aplicación (SOLO super_admin).
//
// Seguridad: la validación es por MAGIC BYTES (nunca por extensión), tamaño
// <=2 MB y dimensiones <=1024 px (parseadas manualmente, sin dependencias).
// El fichero se guarda en el volumen de uploads dentro de la subcarpeta
// /app-icons con nombre FIJO por el servidor: app-icon-<appId>.<png|jpg>
// (imposible path traversal). Escritura atómica (tmp + rename) y limpieza del
// formato alternativo previo.
//
// U-4: los iconos se sirven con control de acceso (ver app.js): la URL pública
// es /uploads/app-icons/app-icon-<id>.<ext>. Una app restricted NO expone su
// icono a anónimos. La app con upload se resuelve como icon_url local
// '/uploads/app-icons/app-icon-<id>.<ext>' (precedencia a) con cache-busting
// ?v=<mtime> aplicado en el render.
//
// TODO (U-3, riesgo ACEPTADO — fase producción): la escritura atómica evita
// corrupción, pero dos POST /admin/apps/:id/icon concurrentes sobre la misma
// app pueden "ganar" indistintamente (last-write-wins) dejando el fichero y el
// valor icon_url de la BD coherentes pero provenientes de peticiones distintas.
// No se implementa mutex/advisory-lock (colisión improbable, solo super_admin).
// Evaluar en producción: bloqueo por appId (p.ej. PgAdvisoryLock) alrededor de
// saveAppIcon + UPDATE, o serializar las subidas por app.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const logoService = require('./logo.service');

const MAX_DIMENSION = 1024;
const MAX_SIZE_BYTES = 2 * 1024 * 1024;

// Subcarpeta dentro del volumen de uploads donde viven los iconos de apps.
// Separados del logo (que sigue siendo público) para poder servirlos con
// control de acceso (U-4) sin exponer el resto del volumen.
const ICONS_SUBDIR = 'app-icons';

function fileNameFor(appId, type) {
  return `app-icon-${appId}.${type === 'jpeg' ? 'jpg' : 'png'}`;
}

// Directorio real de los iconos en disco (uploadsDir/app-icons).
function iconsDir() {
  return path.join(config.uploadsDir, ICONS_SUBDIR);
}

// URL servida por el controlador de /uploads/app-icons (con acceso, U-4).
function iconUrlFor(appId, type) {
  return `/uploads/${ICONS_SUBDIR}/${fileNameFor(appId, type)}`;
}

// Valida un buffer de icono subido (PNG/JPEG real, <=2MB, <=1024px).
// Reutiliza la detección de magic bytes y el parseo de dimensiones de
// logo.service (misma base, sin dependencias nuevas).
function validateIconUpload(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'No se recibió ningún archivo.' };
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    return { ok: false, error: 'El archivo supera el tamaño máximo de 2 MB.' };
  }
  const type = logoService.detectImageType(buffer);
  if (!type) {
    return {
      ok: false,
      error: 'Formato no soportado: solo PNG o JPEG (validado por contenido real, nunca por la extensión).',
    };
  }
  const size = logoService.readImageSize(buffer, type);
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

// Guarda el icono con nombre fijo por appId. Escritura atómica (tmp + rename)
// y borrado del formato alternativo previo.
function saveAppIcon(appId, buffer, type) {
  const dir = iconsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileNameFor(appId, type));
  const tmp = path.join(dir, `.app-icon-${appId}.tmp-${process.pid}-${Date.now()}`);
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
  const other = path.join(dir, fileNameFor(appId, type === 'jpeg' ? 'png' : 'jpeg'));
  try {
    fs.unlinkSync(other);
  } catch (err) {
    // No existía el otro formato: no es un error.
  }
  return target;
}

// Borra el icono subido de una app (ambos formatos). Usado al borrar la app
// y al reemplazar el icono.
function deleteAppIcon(appId) {
  // 'jpeg' (no 'jpg'): fileNameFor() espera el tipo interno del validador
  // ('png' | 'jpeg') para mapear a la extensión correcta del fichero.
  const dir = iconsDir();
  for (const type of ['png', 'jpeg']) {
    try {
      fs.unlinkSync(path.join(dir, fileNameFor(appId, type)));
    } catch (err) {
      // No existe el fichero: no es un error.
    }
  }
}

module.exports = {
  MAX_DIMENSION,
  MAX_SIZE_BYTES,
  ICONS_SUBDIR,
  iconsDir,
  validateIconUpload,
  saveAppIcon,
  deleteAppIcon,
  iconUrlFor,
  fileNameFor,
};
