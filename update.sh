#!/usr/bin/env bash
# =============================================================================
# SM-HomePage — actualización segura
#
#   bash update.sh                  # git pull opcional + backup BD + redeploy
#   bash update.sh --source-dir RUTA  # usar RUTA (tarball nuevo) como origen
#
# - Backups de BD OBLIGATORIOS (pg_dump → gzip) en ./backups/ con retención de 5.
# - Nunca borra volúmenes. Las migraciones de schema.sql son idempotentes.
# - Sin secretos en pantalla ni en los logs.
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

LOG="$DIR/update.log"
BACKUP_DIR="$DIR/backups"
SOURCE_DIR=""
DB_USER=""
DB_NAME=""
PORT=3000
VERSION=""

# -----------------------------------------------------------------------------
# Utilidades
# -----------------------------------------------------------------------------
log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"
}

die() {
  printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2
  printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >> "$LOG"
  exit 1
}

confirm() {
  local prompt="$1" default="${2:-no}" answer=""
  while :; do
    printf '  %s [sí/no]: ' "$prompt"
    if ! read -r answer; then echo; echo "  Entrada cancelada."; exit 1; fi
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    [ -z "$answer" ] && answer="$default"
    case "$answer" in
      sí|si|s|y|yes) return 0 ;;
      no|n|q|quit)   return 1 ;;
      *) echo "  ✗ Responde 'sí' o 'no'." ;;
    esac
  done
}

env_get() {
  local file="$1" key="$2" line val
  [ -f "$file" ] || { printf ''; return 0; }
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n1 || true)"
  [ -n "$line" ] || { printf ''; return 0; }
  val="${line#*=}"
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$val" in
    \"*\") val="${val%\"}"; val="${val#\"}" ;;
    \'*\') val="${val%\'}"; val="${val#\'}" ;;
  esac
  val="$(printf '%s' "$val" | sed -e 's/[[:space:]]\+#.*$//')"
  printf '%s' "$val"
}

usage() {
  cat <<'EOF'
SM-HomePage — actualización segura

USO:
  bash update.sh [OPCIONES]

OPCIONES:
  --source-dir RUTA   Copia el código desde RUTA (tarball nuevo) al directorio
                      de instalación antes de actualizar.
  -h, --help          Muestra esta ayuda.
EOF
}

# -----------------------------------------------------------------------------
# Prechecks
# -----------------------------------------------------------------------------
check_repo_integrity() {
  local file="" missing=""
  for file in \
    docker-compose.yml \
    server/Dockerfile \
    server/package.json \
    server/src/schema.sql \
    server/src/index.js
  do
    if [ ! -f "$file" ] || [ ! -s "$file" ]; then
      missing="$missing
    - $file"
    fi
  done
  if [ -n "$missing" ]; then
    die "El repositorio está incompleto o corrupto. Faltan o están vacíos los archivos críticos:$missing"
  fi
  log "Integridad del repositorio OK (archivos críticos presentes y no vacíos)."
}

prechecks() {
  [ -f docker-compose.yml ] || die "No encuentro docker-compose.yml en $DIR. Ejecuta update.sh desde la raíz del proyecto."
  [ -f .env ] || die "No hay .env — ejecuta primero 'bash deploy.sh'."
  command -v docker >/dev/null 2>&1 || die "Docker no está instalado."
  docker compose version >/dev/null 2>&1 || die "Docker Compose (plugin) no está disponible."
  docker compose config --quiet || die "docker-compose.yml es inválido o incompleto. Revisa el archivo y vuelve a ejecutar."
  command -v gzip >/dev/null 2>&1 || die "gzip no está instalado."
  command -v curl >/dev/null 2>&1 || die "curl no está instalado."
  command -v tar >/dev/null 2>&1 || die "tar no está instalado."
  check_repo_integrity
  log "Prechecks OK (docker + compose + dependencias)."
}

read_db_creds() {
  DB_USER="$(env_get .env POSTGRES_USER)"
  [ -z "$DB_USER" ] && DB_USER="corphomepage"
  DB_NAME="$(env_get .env POSTGRES_DB)"
  [ -z "$DB_NAME" ] && DB_NAME="corphomepage"
  PORT="$(env_get .env PORT)"
  [ -z "$PORT" ] && PORT=3000
  log "BD destino: user=$DB_USER db=$DB_NAME puerto=$PORT"
}

# -----------------------------------------------------------------------------
# Actualización del código (opcional)
# -----------------------------------------------------------------------------
update_source() {
  if [ -n "$SOURCE_DIR" ]; then
    [ -d "$SOURCE_DIR" ] || die "--source-dir no existe: $SOURCE_DIR"
    log "Copiando código desde $SOURCE_DIR → $DIR (se excluyen .env, .git, node_modules, uploads, backups, logs, bóveda)."
    tar -C "$SOURCE_DIR" \
      --exclude='./.env' --exclude='./.env.*' --exclude='./.git' \
      --exclude='./node_modules' --exclude='./server/node_modules' \
      --exclude='./server/public/uploads' --exclude='./backups' \
      --exclude='./deploy.log' --exclude='./update.log' \
      --exclude='./docs/knowledge-base' \
      -cf - . | tar -C "$DIR" -xf -
    log "Código copiado."
    return 0
  fi

  if [ -d .git ]; then
    if confirm "¿Actualizar el código con 'git pull --ff-only'? [sí/no]" "sí"; then
      log "Ejecutando git pull --ff-only..."
      git pull --ff-only
    else
      log "Omitido git pull (se desplegará el código local actual)."
    fi
  else
    log "Sin repositorio git — se desplegará el código local actual (o usa --source-dir)."
  fi
}

# -----------------------------------------------------------------------------
# Backup de BD obligatorio
# -----------------------------------------------------------------------------
backup_db() {
  mkdir -p "$BACKUP_DIR"
  local stamp file size
  stamp="$(date +%Y%m%d-%H%M%S)"
  file="$BACKUP_DIR/corphomepage-$stamp.sql.gz"
  log "Creando backup de BD → $file"
  if ! docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$file"; then
    rm -f "$file"
    die "Fallo creando el backup de BD (revisa 'docker compose ps'). No se continúa."
  fi
  gzip -t "$file" || { rm -f "$file"; die "El backup está corrupto (gzip -t falló)."; }
  size="$(stat -c%s "$file" 2>/dev/null || echo 0)"
  if [ "$size" -lt 1024 ]; then
    rm -f "$file"
    die "El backup es sospechosamente pequeño (${size} bytes). Abortando."
  fi
  log "Backup OK (${size} bytes): $file"

  # Retención: mantener solo los 5 backups más recientes
  ls -1t "$BACKUP_DIR"/corphomepage-*.sql.gz 2>/dev/null | tail -n +6 | while read -r old; do
    rm -f "$old"
    log "Backup antiguo eliminado: $old"
  done || true
}

# -----------------------------------------------------------------------------
# Bind del puerto (BIND_ADDR) — paso pre-deploy
# -----------------------------------------------------------------------------
# Si el .env no tiene BIND_ADDR (instalaciones previas a esta versión), se
# deriva de PORTAL_URL si existe; si no existe PORTAL_URL, se pregunta al
# operador. La app NO lee esta variable: solo la usa docker-compose.yml para
# publicar el puerto (0.0.0.0 = red interna/intranet, 127.0.0.1 = solo local).
ensure_bind_addr() {
  local current="" host="" answer="" portal_url=""
  current="$(env_get .env BIND_ADDR)"
  if [ -n "$current" ]; then
    log "BIND_ADDR ya definido en .env → $current."
    return 0
  fi

  portal_url="$(env_get .env PORTAL_URL)"
  if [ -n "$portal_url" ]; then
    # Derivación con detección SOLO loopback (localhost/127.*/::1/0.0.0.0 →
    # 127.0.0.1; cualquier otra URL, incl. RFC1918, → 0.0.0.0).
    host="$(printf '%s' "$portal_url" | sed -E 's|^https?://([^/:@]+).*|\1|')"
    case "$host" in
      localhost|127.*|::1|0.0.0.0) current="127.0.0.1" ;;
      *) current="0.0.0.0" ;;
    esac
    log "BIND_ADDR derivado de PORTAL_URL ($portal_url) → $current."
  else
    echo
    echo "  Bind del puerto: ¿el puerto debe ser accesible desde la red interna"
    echo "  (0.0.0.0, recomendado — permite un proxy/Caddy en otra máquina) o solo"
    echo "  local (127.0.0.1)?"
    while :; do
      printf '  Opción [0.0.0.0]: '
      if ! read -r answer; then echo; echo "  Entrada cancelada."; exit 1; fi
      [ -z "$answer" ] && answer="0.0.0.0"
      case "$answer" in
        0.0.0.0|127.0.0.1) current="$answer"; break ;;
        *) echo "  ✗ Opciones válidas: 0.0.0.0 (red interna) o 127.0.0.1 (solo local)." ;;
      esac
    done
    log "BIND_ADDR elegido por el operador → $current."
  fi

  printf 'BIND_ADDR=%s\n' "$current" >> .env
  chmod 600 .env
  log "BIND_ADDR=$current añadido a .env (lo usa docker-compose.yml para publicar el puerto)."
}

# -----------------------------------------------------------------------------
# Salud y restauración
# -----------------------------------------------------------------------------
wait_healthy() {
  local port="$1" deadline n
  deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    n="$(docker compose ps --format '{{.Status}}' 2>/dev/null | grep -c 'healthy' || true)"
    if [ "$n" -ge 2 ] && curl -fsS -o /dev/null "http://127.0.0.1:${port}/login" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

restore_db() {
  local file="$1"
  log "Restaurando backup: $file"
  gunzip -c "$file" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"
  log "Restauración ejecutada. Revisa la salida anterior por errores (si hay tablas existentes, considera recrear la BD desde cero)."
}

get_version() {
  if [ -f server/package.json ]; then
    VERSION="$(grep '"version"' server/package.json | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'desconocida')"
  else
    VERSION="desconocida"
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  umask 077
  : > "$LOG" 2>/dev/null || touch "$LOG"
  chmod 600 "$LOG" 2>/dev/null || true

  while [ $# -gt 0 ]; do
    case "$1" in
      --source-dir) shift; SOURCE_DIR="$1" ;;
      --source-dir=*) SOURCE_DIR="${1#--source-dir=}" ;;
      -h|--help) usage; exit 0 ;;
      *) die "Opción desconocida: $1 (usa --help)" ;;
    esac
    shift
  done

  log "SM-HomePage update.sh — inicio ($(date '+%F %T'))"

  prechecks
  read_db_creds
  update_source

  local latest=""
  latest="$(ls -1t "$BACKUP_DIR"/corphomepage-*.sql.gz 2>/dev/null | head -n1 || true)"
  backup_db
  latest="$(ls -1t "$BACKUP_DIR"/corphomepage-*.sql.gz 2>/dev/null | head -n1 || true)"

  log "Build + despliegue (sin tocar volúmenes)..."
  ensure_bind_addr
  docker compose build --pull
  docker compose up -d
  log "Nota: 'docker compose up -d' recrea SOLO el contenedor web si BIND_ADDR/ports cambió (caída breve); no se tocan secretos ni volúmenes."

  log "Esperando salud del stack (db+web healthy y /login 200, máx 120 s)..."
  if wait_healthy "$PORT"; then
    log "Smoke OK."
  else
    log "ERROR: smoke falló. Intentando restaurar el backup de BD..."
    if [ -n "$latest" ]; then
      restore_db "$latest"
    else
      log "No hay backup que restaurar."
    fi
    die "La actualización falló tras el smoke. Revisa 'docker compose logs web'. Backup restaurado/avisado."
  fi

  get_version
  log "────────────────────────────────────────────"
  log "Informe de actualización"
  log "  Versión desplegada : $VERSION"
  log "  Backup creado      : $latest"
  log "  URL de acceso      : http://127.0.0.1:$PORT"
  log "  Estado del stack   : $(docker compose ps --format '{{.Service}}: {{.Status}}' | tr '\n' ' ')"
  log "────────────────────────────────────────────"
  log "SM-HomePage actualizado correctamente."
}

main "$@"
