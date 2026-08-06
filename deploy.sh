#!/usr/bin/env bash
# =============================================================================
# SM-HomePage — asistente de instalación y despliegue interactivo (Asistente v2)
#
#   bash deploy.sh                          # asistente guiado (modo rápido o personalizado)
#   bash deploy.sh --dry-run                # solo muestra plan y preguntas
#   bash deploy.sh --force-regenerate       # regenera .env aunque exista
#   bash deploy.sh --non-interactive --env-file ./mi-plantilla.env
#
# Asistente v2: modo rápido (defaults seguros) vs. personalizado, pregunta
# binaria SendGrid con API key, código de arranque de 6 dígitos (BOOTSTRAP_CODE,
# single-use) y coherencia NODE_ENV/COOKIE_SECURE.
#
# Requisitos: Ubuntu 22.04/24.04 o Debian 12, curl, openssl, Docker + compose.
# El log de la sesión se escribe en ./deploy.log con los secretos enmascarados.
# =============================================================================
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

DEPLOY_LOG="$DEPLOY_DIR/deploy.log"
ENV_TARGET="$DEPLOY_DIR/.env"
ENV_BACKUP=""

# Flags
DRY_RUN=0
FORCE_REGENERATE=0
NON_INTERACTIVE=0
ENV_FILE=""

# Valores recogidos (en ámbito global para que los namerefs funcionen)
URL_PUBLICA=""
SITE_NAME=""
SUPER_ADMIN_EMAIL=""
ALLOWED_EMAIL_DOMAINS=""
MAIL_DRIVER=""
SMTP_HOST=""
SMTP_PORT=587
SMTP_USER=""
SMTP_PASS=""
MAIL_FROM=""
SENDGRID_API_KEY=""
PORT=3000
BIND_ADDR=127.0.0.1
NODE_ENV=""
BOOTSTRAP_TOKEN=""
BOOTSTRAP_CODE=""
INSTALL_MODE=""
ANONYMOUS_MODE=on
TRUST_PROXY=0
COOKIE_SECURE=""
SESSION_SECRET=""
POSTGRES_PASSWORD=""

# Estado interno
IS_LOCALHOST=0
STACK_HEALTHY=0
DOCKER_PREFIX=""
SUDO_PREFIX=""
DISTRO_ID=""
DISTRO_VERSION=""
MASK_SECRETS=()
BOOTSTRAP_CODE_LAST=""   # último código generado (evita repetir el mismo)
VALIDATED_MAIL=0         # ya se validaron las credenciales de correo

# Expresiones de validación
URL_RE='^(https?)://[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/.*)?$'
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
HOST_RE='^[A-Za-z0-9.-]+$'
PORT_RE='^[0-9]{1,5}$'
DOMAINS_RE='^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$'

# -----------------------------------------------------------------------------
# Utilidades de salida y seguridad del log
# -----------------------------------------------------------------------------

# Sustituye cualquier secreto conocido por *** (nunca se vuelcan en pantalla/log).
mask() {
  local line="$*" s
  for s in "${MASK_SECRETS[@]:-}"; do
    [ -n "$s" ] || continue
    line="${line//$s/***}"
  done
  printf '%s' "$line"
}

log() {
  local msg
  msg="$(mask "$*")"
  printf '[%s] %s\n' "$(date '+%F %T')" "$msg" | tee -a "$DEPLOY_LOG"
}

die() {
  local msg
  msg="$(mask "$*")"
  printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$msg" >&2
  printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$msg" >> "$DEPLOY_LOG"
  exit 1
}

# Forma corta de un secreto para el resumen (primeros 4 caracteres).
short_mask() {
  local v="$1"
  if [ -z "$v" ]; then
    printf '(vacío)'
  else
    printf '%s...' "${v:0:4}"
  fi
}

# Pregunta sí/no. En dry-run responde sí automáticamente para poder mostrar el plan.
confirm() {
  local prompt="$1" default="${2:-no}" answer=""
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
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

# -----------------------------------------------------------------------------
# Lectura de valores de un archivo .env (sin ejecutarlo)
# -----------------------------------------------------------------------------
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

# -----------------------------------------------------------------------------
# Preguntas interactivas
# -----------------------------------------------------------------------------

# ask <var> <prompt> [default] [regex] [mensaje-error] [opcional(1|0)]
# Si el sexto argumento es 1 (o el prompt contiene "(opcional)"), un valor vacío
# se acepta SIEMPRE (fix Asistente v2: antes se rechazaba pese a regex '.*').
ask() {
  local -n _ref="$1"
  local _prompt="$2" _default="$3" _re="$4" _errmsg="$5" _optional="${6:-0}"
  local _input=""
  while :; do
    if [ -n "$_default" ]; then
      printf '  %s [%s]: ' "$_prompt" "$_default"
    else
      printf '  %s: ' "$_prompt"
    fi
    if ! read -r _input; then echo; echo "  Entrada cancelada."; exit 1; fi
    [ -n "$_input" ] || _input="$_default"
    if [ -z "$_input" ]; then
      # Campo opcional: vacío es válido por definición.
      if [ "$_optional" = "1" ] || printf '%s' "$_prompt" | grep -q "opcional"; then
        _ref=""; return 0
      fi
      # Sin valor y sin default: se permite solo si la validación acepta vacío
      if [ -z "$_re" ]; then _ref=""; return 0; fi
      if printf '%s' "" | grep -qE "$_re"; then _ref=""; return 0; fi
      echo "  ✗ $_errmsg"
      continue
    fi
    if [ -n "$_re" ] && ! printf '%s' "$_input" | grep -qE "$_re"; then
      echo "  ✗ $_errmsg"
      continue
    fi
    break
  done
  _ref="$_input"
}

# ask_choice <var> <prompt> [default] [opciones-sep-por-|] [mensaje-error]
ask_choice() {
  local -n _ref="$1"
  local _prompt="$2" _default="$3" _allowed="$4" _errmsg="$5"
  local _input=""
  while :; do
    printf '  %s [%s]: ' "$_prompt" "$_default"
    if ! read -r _input; then echo; echo "  Entrada cancelada."; exit 1; fi
    [ -z "$_input" ] && _input="$_default"
    case "|$_allowed|" in
      *"|$_input|"*) _ref="$_input"; return 0 ;;
    esac
    echo "  ✗ $_errmsg"
  done
}

# ask_secret <var> <prompt> [min-len] [confirmar(no|yes)]
ask_secret() {
  local -n _ref="$1"
  local _prompt="$2" _min="${3:-1}" _confirm="${4:-no}"
  local _again=""
  while :; do
    printf '  %s (sin eco): ' "$_prompt"
    if ! read -rs _ref; then echo; echo "  Entrada cancelada."; exit 1; fi
    echo
    if [ -z "$_ref" ]; then echo "  ✗ No puede estar vacío."; continue; fi
    if [ "${#_ref}" -lt "$_min" ]; then echo "  ✗ Mínimo $_min caracteres."; continue; fi
    if [ "$_confirm" = "yes" ]; then
      printf '  Confirma (sin eco): '
      if ! read -rs _again; then echo; echo "  Entrada cancelada."; exit 1; fi
      echo
      [ "$_ref" = "$_again" ] || { echo "  ✗ No coinciden. Repite."; continue; }
    fi
    break
  done
  MASK_SECRETS+=("$_ref")
}

# Pregunta el puerto HTTP validando rango y disponibilidad.
ask_port() {
  local _p=""
  while :; do
    printf '  Puerto HTTP (1-65535) [3000]: '
    if ! read -r _p; then echo; echo "  Entrada cancelada."; exit 1; fi
    [ -z "$_p" ] && _p="3000"
    if ! printf '%s' "$_p" | grep -qE "$PORT_RE" || [ "$_p" -lt 1 ] || [ "$_p" -gt 65535 ]; then
      echo "  ✗ Debe ser un entero entre 1 y 65535."
      continue
    fi
    if port_in_use "$_p"; then
      echo "  ⚠ El puerto $_p está en uso."
      if [ "$DRY_RUN" -eq 1 ]; then PORT="$_p"; return 0; fi
      continue
    fi
    break
  done
  PORT="$_p"
}

# Configuración de correo según el driver elegido (solo interactivo).
# Nota: el driver sendgrid se gestiona en ask_mail_block (camino rápido con API key).
ask_mail_config() {
  local default_dom="$1"
  case "$MAIL_DRIVER" in
    smtp)
      ask SMTP_HOST "Host SMTP (obligatorio)" "" "$HOST_RE" "Host SMTP válido (ej. smtp.miempresa.com)."
      ask SMTP_PORT "Puerto SMTP" "587" "$PORT_RE" "Puerto entre 1 y 65535."
      ask SMTP_USER "Usuario SMTP (opcional)" "" ".*" "Usuario SMTP." 1
      ask_secret SMTP_PASS "Contraseña SMTP" 4 yes
      ask MAIL_FROM "Remitente (MAIL_FROM)" "no-reply@${default_dom}" "$EMAIL_RE" "Debe ser un email válido."
      smtp_sendgrid_hint
      ;;
    log)
      ask MAIL_FROM "Remitente (MAIL_FROM)" "no-reply@${default_dom}" "$EMAIL_RE" "Debe ser un email válido."
      ;;
    sendgrid)
      : # sendgrid se resuelve en ask_mail_block (Asistente v2)
      ;;
  esac
}

# Aviso (no bloqueante) si un SMTP manual parece SendGrid mal configurado.
# Correcto: host smtp.sendgrid.net, usuario literal 'apikey', pass = API key (SG...).
smtp_sendgrid_hint() {
  local host_lc
  host_lc="$(printf '%s' "$SMTP_HOST" | tr '[:upper:]' '[:lower:]')"
  case "$host_lc" in
    *sendgrid*)
      if [ "$host_lc" != "smtp.sendgrid.net" ] || [ "$SMTP_USER" != "apikey" ]; then
        echo "  ⚠ El host SMTP contiene 'sendgrid' pero no es la config válida de SendGrid."
        echo "    Uso correcto: host smtp.sendgrid.net, usuario literal 'apikey' y"
        echo "    password = API key (empieza por SG.)."
        echo "    Sugerencia: responde SÍ a la pregunta SendGrid para el camino rápido con API key."
        log "AVISO: SMTP parece SendGrid mal configurado (host=$SMTP_HOST user=$SMTP_USER)."
      fi
      ;;
  esac
}

# Bloque de correo (Asistente v2): pregunta binaria SendGrid con API key o SMTP/log.
ask_mail_block() {
  local admin_dom="$1"
  echo "  Mail: cómo se enviarán los correos OTP y de acceso a los usuarios."
  if confirm "¿Enviarás correos con SendGrid usando una API Key? [sí/no]" "no"; then
    MAIL_DRIVER="sendgrid"
    ask_secret SENDGRID_API_KEY "SendGrid API Key (empieza por SG.)" 20 yes
    case "$SENDGRID_API_KEY" in
      SG.*) : ;;
      *) echo "  ⚠ Sanity: la clave no empieza por 'SG.' — revisa que sea una API Key de SendGrid (no bloqueante)." ;;
    esac
    # MAIL_FROM derivado automáticamente (camino rápido R3); sin prompts SMTP.
    MAIL_FROM="no-reply@${admin_dom}"
    SMTP_HOST=""; SMTP_PORT=587; SMTP_USER=""; SMTP_PASS=""
    log "SendGrid: MAIL_FROM derivado = $MAIL_FROM."
  else
    local mail_default="smtp"
    [ "$IS_LOCALHOST" -eq 1 ] && mail_default="log"
    ask_choice MAIL_DRIVER "Driver de correo" "$mail_default" "log|smtp" "Opciones: log, smtp."
    ask_mail_config "$admin_dom"
    # Bloqueo: MAIL_DRIVER=log prohibido en producción (fail-fast de la app)
    while [ "$MAIL_DRIVER" = "log" ] && [ "$NODE_ENV" = "production" ]; do
      echo "  ✗ MAIL_DRIVER=log está PROHIBIDO en producción (la app no arranca). Elige otro driver."
      ask_choice MAIL_DRIVER "Driver de correo" "smtp" "log|smtp" "Opciones: log, smtp."
      ask_mail_config "$admin_dom"
    done
  fi
}

# Validación de credenciales de correo ANTES de escribir el .env (no bloqueante).
validate_mail_credentials() {
  if [ "$MAIL_DRIVER" = "sendgrid" ]; then
    case "$SENDGRID_API_KEY" in
      SG.*) : ;;
      *) echo "  ⚠ SENDGRID_API_KEY no empieza por 'SG.' — revisa que sea una API Key de SendGrid." ;;
    esac
  elif [ "$MAIL_DRIVER" = "smtp" ]; then
    smtp_sendgrid_hint
  fi
}

# -----------------------------------------------------------------------------
# Coherencia NODE_ENV/COOKIE_SECURE (Asistente v2, punto 5)
# -----------------------------------------------------------------------------

# ¿El host de la URL es localhost/IP loopback o LAN privada (cualquier esquema)?
is_local_url() {
  local url="$1" host=""
  host="$(printf '%s' "$url" | sed -E 's|^https?://([^/:@]+).*|\1|')"
  case "$host" in
    localhost|127.*|::1|0.0.0.0|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

# ¿El host de la URL es SOLO loopback (localhost, 127.*, ::1, 0.0.0.0)?
# IMPORTANTE: NO incluye RFC1918 (10.x, 192.168.x, 172.16-31.x). Esas IPs son
# red interna: el puerto debe publicarse (BIND_ADDR=0.0.0.0) para que un proxy/
# Caddy en otra máquina alcance la app. Usar is_local_url() aquí reproduciría
# el incidente real de Caddy inalcanzable.
is_loopback_url() {
  local url="$1" host=""
  host="$(printf '%s' "$url" | sed -E 's|^https?://([^/:@]+).*|\1|')"
  case "$host" in
    localhost|127.*|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}

# ¿El host de la URL es una IP RFC1918 (red privada 10/8, 172.16/12, 192.168/16)?
is_rfc1918_url() {
  local url="$1" host=""
  host="$(printf '%s' "$url" | sed -E 's|^https?://([^/:@]+).*|\1|')"
  case "$host" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

# ¿URL HTTP (sin TLS) contra host local/privado? → NODE_ENV=development forzado.
is_insecure_local_url() {
  local url="$1" host=""
  case "$url" in
    https://*) return 1 ;;
    http://*) host="$(printf '%s' "$url" | sed -E 's|^http://([^/:@]+).*|\1|')" ;;
    *) return 1 ;;
  esac
  case "$host" in
    localhost|127.*|::1|0.0.0.0|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

# Deriva BIND_ADDR a partir de URL_PUBLICA con detección SOLO loopback:
#   localhost / 127.* / ::1 / 0.0.0.0      → 127.0.0.1 (solo local, fail-closed)
#   cualquier otra URL (RFC1918, 100.x, IP pública, dominio) → 0.0.0.0 (red interna)
derive_bind_addr() {
  if is_loopback_url "$URL_PUBLICA"; then
    BIND_ADDR="127.0.0.1"
  else
    BIND_ADDR="0.0.0.0"
  fi
  log "BIND_ADDR derivado de URL_PUBLICA ($URL_PUBLICA) → $BIND_ADDR."
}

# Avisos de seguridad del bind (no bloqueantes salvo el caso (b) interactivo):
#   (a) BIND_ADDR=0.0.0.0 con URL no-RFC1918 (posible Internet) → aviso.
#   (b) BIND_ADDR=0.0.0.0 + TRUST_PROXY=1 + URL http → confirmación explícita
#       en interactivo (confiar en X-Forwarded-For sin TLS permite forjar IPs);
#       en no interactivo solo log de aviso (no bloquea).
bind_security_warnings() {
  if [ "$BIND_ADDR" = "0.0.0.0" ] && ! is_rfc1918_url "$URL_PUBLICA" && ! is_loopback_url "$URL_PUBLICA"; then
    echo "  ⚠ BIND_ADDR=0.0.0.0 con URL no-RFC1918 ($URL_PUBLICA): puerto expuesto a red."
    echo "    Si hay ruta a Internet: TLS en el borde + ANONYMOUS_MODE=off."
    log "AVISO: BIND_ADDR=0.0.0.0 con URL no-RFC1918 ($URL_PUBLICA) — puerto expuesto a red."
  fi
  if [ "$BIND_ADDR" = "0.0.0.0" ] && [ "$TRUST_PROXY" = "1" ] && [ "${URL_PUBLICA#http://}" != "$URL_PUBLICA" ]; then
    local msg="Confiar en X-Forwarded-For sin TLS en el borde permite forjar IPs y saltarse el rate limiting."
    echo "  ⚠ $msg"
    log "AVISO: $msg (BIND_ADDR=0.0.0.0 + TRUST_PROXY=1 + URL http)."
    if [ "$NON_INTERACTIVE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      if ! confirm "¿Continuar igualmente (TRUST_PROXY=1 con URL http, sin TLS en el borde)?" "no"; then
        TRUST_PROXY=0
        log "TRUST_PROXY forzado a 0 por confirmación (BIND_ADDR=0.0.0.0 + URL http sin TLS)."
      fi
    fi
  fi
}

# Deriva/valida NODE_ENV coherente con la URL. localhost+production incoherente
# → development; producción sin https → aviso de TLS en el borde (no bloqueante).
derive_node_env() {
  local url_local=0
  is_local_url "$URL_PUBLICA" && url_local=1
  if [ "$url_local" -eq 1 ]; then
    if [ "$NODE_ENV" = "production" ] && is_insecure_local_url "$URL_PUBLICA"; then
      NODE_ENV="development"
      log "AVISO: URL local HTTP + NODE_ENV=production incoherente → forzado a development."
      echo "  ⚠ URL local sin TLS: NODE_ENV forzado a development (producción + http local es incoherente)."
    elif [ -z "$NODE_ENV" ]; then
      NODE_ENV="development"
      log "URL local → NODE_ENV=development."
    fi
  elif [ -z "$NODE_ENV" ]; then
    NODE_ENV="production"
    log "URL remota → NODE_ENV=production."
  fi
  if [ "$NODE_ENV" = "production" ] && [ "${URL_PUBLICA#https://}" = "$URL_PUBLICA" ]; then
    echo "  ⚠ producción con URL no https: considera TLS en el borde (Caddy/Nginx)."
    log "AVISO: producción con URL no https (TLS en el borde recomendado)."
  fi
}

# -----------------------------------------------------------------------------
# Código de arranque de 6 dígitos (Asistente v2, R2)
# -----------------------------------------------------------------------------

# Genera un BOOTSTRAP_CODE decimal de 6 dígitos (sin 000000 ni repetido con el
# último generado). Fuente segura /dev/urandom (od puede devolver espacios).
generate_bootstrap_code() {
  local code=""
  while :; do
    code="$(od -An -N4 -tu4 /dev/urandom | tr -d '[:space:]')"
    code="$(printf '%06d' $(( 10#$code % 1000000 )))"
    [ "$code" = "000000" ] && continue
    [ -n "$BOOTSTRAP_CODE_LAST" ] && [ "$code" = "$BOOTSTRAP_CODE_LAST" ] && continue
    break
  done
  BOOTSTRAP_CODE_LAST="$code"
  printf '%s' "$code"
}

# Máscara corta del código de arranque para el resumen (tipo ••••56).
boot_mask() {
  local v="$1"
  if [ -z "$v" ]; then printf '(no generado)'; return 0; fi
  printf '••••%s' "${v: -2}"
}

# -----------------------------------------------------------------------------
# Prechecks (Fase 0) — no muta nada
# -----------------------------------------------------------------------------
detect_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-unknown}"
  else
    die "No se pudo detectar el SO (/etc/os-release no existe)."
  fi
  case "$DISTRO_ID:$DISTRO_VERSION" in
    ubuntu:22.04|ubuntu:24.04|debian:12)
      log "SO soportado: ${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION}"
      ;;
    *)
      die "SO no soportado: ${DISTRO_ID:-?} ${DISTRO_VERSION:-?}. Soportados: Ubuntu 22.04/24.04 y Debian 12."
      ;;
  esac
}

check_core_deps() {
  local missing=""
  command -v curl >/dev/null 2>&1    || missing="$missing curl"
  command -v openssl >/dev/null 2>&1 || missing="$missing openssl"
  if ! command -v git >/dev/null 2>&1; then
    log "AVISO: git no está instalado (opcional; solo se usa en update.sh)."
  fi
  if [ -n "$missing" ]; then
    die "Faltan dependencias:$missing. Instálalas con: sudo apt-get install${missing}"
  fi
}

ensure_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO_PREFIX=""
    return 0
  fi
  if sudo -n true 2>/dev/null; then
    SUDO_PREFIX="sudo"
    return 0
  fi
  log "AVISO: no hay sudo no-interactivo. Ejecuta el script como root o habilita sudo sin password."
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  if confirm "¿Continuar usando 'sudo' interactivo?" "sí"; then
    SUDO_PREFIX="sudo"
    return 0
  fi
  die "Ejecuta como root (sudo bash deploy.sh) o con sudo no-interactivo para instalar Docker."
}

sudo_cmd() {
  if [ -n "${SUDO_PREFIX:-}" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

install_docker() {
  ensure_sudo
  log "Instalando Docker Engine + plugin compose..."
  if confirm "¿Usar apt-get (docker.io + docker-compose-plugin)? [sí/no]" "sí"; then
    sudo_cmd apt-get update
    sudo_cmd apt-get install -y docker.io docker-compose-plugin
  else
    log "Descargando el script oficial de Docker (get.docker.com)..."
    curl -fsSL https://get.docker.com | sudo_cmd sh
  fi
  sudo_cmd systemctl enable --now docker || true
  docker --version
  docker compose version
}

detect_docker_prefix() {
  if [ "$(id -u)" -eq 0 ]; then DOCKER_PREFIX=""; return 0; fi
  if docker info >/dev/null 2>&1; then DOCKER_PREFIX=""; return 0; fi
  if sudo -n docker info >/dev/null 2>&1; then DOCKER_PREFIX="sudo"; return 0; fi
  DOCKER_PREFIX=""
  log "AVISO: no se puede hablar con el daemon docker (¿permisos?). Si falla, ejecuta con sudo o añade tu usuario al grupo docker."
}

dc() {
  if [ -n "$DOCKER_PREFIX" ]; then
    "$DOCKER_PREFIX" docker "$@"
  else
    docker "$@"
  fi
}

check_docker() {
  local docker_ok=0 compose_ok=0
  if command -v docker >/dev/null 2>&1 && docker --version >/dev/null 2>&1; then docker_ok=1; fi
  if dc compose version >/dev/null 2>&1; then compose_ok=1; fi
  if [ "$docker_ok" -eq 1 ] && [ "$compose_ok" -eq 1 ]; then
    log "Docker + Docker Compose detectados."
    detect_docker_prefix
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[DRY-RUN] Docker/Compose no detectados (en modo real se preguntaría la instalación)."
    return 0
  fi
  if confirm "¿Instalar Docker Engine y el plugin compose? [sí/no]" "no"; then
    install_docker
    detect_docker_prefix
  else
    die "Docker es imprescindible. Instálalo manualmente y vuelve a ejecutar."
  fi
}

# ¿Hay algo escuchando en ese puerto? (ss > lsof > /dev/tcp)
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "(:${port})$"; then return 0; fi
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then return 0; fi
  return 1
}

check_default_port() {
  if port_in_use 3000; then
    log "AVISO: el puerto 3000 está ocupado. El asistente pedirá otro."
  else
    log "Puerto 3000 disponible."
  fi
}

check_existing_env() {
  if [ -f "$ENV_TARGET" ]; then
    if [ "$FORCE_REGENERATE" -eq 1 ]; then
      log "Ya existe .env → se regenerará (--force-regenerate) con backup previo."
    elif [ "$DRY_RUN" -eq 1 ]; then
      log "[DRY-RUN] Ya existe .env → en modo real se abortaría salvo --force-regenerate."
    else
      die "Ya existe .env. Usa --force-regenerate para regenerarlo (se hará copia de seguridad)."
    fi
  fi
}

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
  log "Fase 0 — Prechecks"
  detect_os
  check_core_deps
  check_repo_integrity
  check_docker
  check_default_port
  check_existing_env
}

# -----------------------------------------------------------------------------
# Fase 1 — Preguntas guiadas
# -----------------------------------------------------------------------------
derive_cookie_secure() {
  case "$URL_PUBLICA" in
    https://*)
      COOKIE_SECURE=true
      IS_LOCALHOST=0
      log "URL https:// → COOKIE_SECURE=true."
      ;;
    *)
      COOKIE_SECURE=false
      if is_local_url "$URL_PUBLICA"; then
        IS_LOCALHOST=1
        log "URL local (${URL_PUBLICA}) → COOKIE_SECURE=false (modo desarrollo)."
      else
        IS_LOCALHOST=0
        log "URL por HTTP plano → COOKIE_SECURE=false (cookies sin Secure)."
      fi
      ;;
  esac
}

gather_interactive() {
  echo
  log "Fase 1 — Preguntas de configuración (Enter = valor entre corchetes)"

  # 0. Modo de instalación: rápido (defaults seguros) o personalizado (completo)
  ask_choice INSTALL_MODE \
    "Modo de instalación (rápido aplica defaults seguros; personalizado configura todo)" \
    "rapido" \
    "rapido|personalizado" \
    "Opciones: rapido, personalizado."

  # 1. URL pública (esencial en ambos modos)
  ask URL_PUBLICA \
    "URL pública del portal (cómo accederán los usuarios; define cookies seguras y redirects)" \
    "http://localhost" \
    "$URL_RE" \
    "Debe ser una URL con esquema http:// o https://."
  derive_cookie_secure
  derive_node_env
  derive_bind_addr

  # 2. Nombre del sitio
  ask SITE_NAME "Nombre del sitio (aparece en el título, login y correos)" "SM-HomePage" '^.{1,60}$' "Entre 1 y 60 caracteres."

  # 3. Email del super_admin (única vía de bootstrap)
  ask SUPER_ADMIN_EMAIL "Email del super_admin (única vía de bootstrap; recibe el OTP)" "" "$EMAIL_RE" "Debe ser un email válido."
  local admin_dom
  admin_dom="$(printf '%s' "$SUPER_ADMIN_EMAIL" | cut -d@ -f2)"

  # 4. Bloque de correo (pregunta binaria SendGrid o SMTP/log manual)
  ask_mail_block "$admin_dom"

  if [ "$INSTALL_MODE" = "rapido" ]; then
    # Defaults seguros del modo rápido
    PORT=3000
    ANONYMOUS_MODE="on"
    # Coherencia TRUST_PROXY: URL https → proxy de confianza delante (1); si no, 0.
    if [ "${URL_PUBLICA#https://}" != "$URL_PUBLICA" ]; then
      TRUST_PROXY=1
      log "Modo rápido: URL https:// → TRUST_PROXY=1 (proxy de confianza delante)."
      echo "  (Modo rápido: URL https → TRUST_PROXY=1 para que el rate limiting vea la IP real.)"
    else
      TRUST_PROXY=0
    fi
    ALLOWED_EMAIL_DOMAINS="$admin_dom"
    log "Modo rápido: defaults PORT=3000, ANONYMOUS_MODE=on, TRUST_PROXY=$TRUST_PROXY, dominios=$admin_dom."
    echo "  (Defaults del modo rápido: puerto 3000, modo anónimo on, trust proxy $TRUST_PROXY, dominios = $admin_dom)"
    if [ "$BIND_ADDR" = "127.0.0.1" ]; then
      echo "  ⚠ AVISO: URL localhost → bind loopback; el puerto NO será alcanzable desde la red/proxy remoto."
      log "AVISO: URL localhost → bind loopback (BIND_ADDR=127.0.0.1); el puerto NO será alcanzable desde la red/proxy remoto."
    fi

    # 5. Código de arranque: se genera SIEMPRE en modo rápido (R2)
    BOOTSTRAP_CODE="$(generate_bootstrap_code)"
    MASK_SECRETS+=("$BOOTSTRAP_CODE")
    log "BOOTSTRAP_CODE de 6 dígitos generado (se mostrará una única vez al final)."
  else
    # 5. Dominios de correo permitidos (personalizado)
    ask ALLOWED_EMAIL_DOMAINS "Dominios de correo permitidos (coma-separados; solo estos dominios pueden registrarse)" "$admin_dom" "$DOMAINS_RE" "Lista de dominios separados por coma (ej. miempresa.com,otra.com)."

    # 6. Entorno (personalizado). La coherencia local→development ya la aplicó derive_node_env.
    local env_default="$NODE_ENV"
    [ -z "$env_default" ] && env_default="production"
    ask_choice NODE_ENV "Entorno" "$env_default" "production|development" "Opciones: production, development."
    if is_insecure_local_url "$URL_PUBLICA" && [ "$NODE_ENV" = "production" ]; then
      NODE_ENV="development"
      echo "  ⚠ URL local sin TLS: NODE_ENV forzado a development (producción + http local es incoherente)."
      log "AVISO: NODE_ENV forzado a development por URL local sin TLS."
    fi
    # Si el usuario eligió development con URL remota, avisamos (cookie no Secure).
    if [ "$NODE_ENV" = "development" ] && [ "$IS_LOCALHOST" -eq 0 ]; then
      echo "  ⚠ Entorno development con URL no-localhost: la cookie no será Secure."
    fi

    # 7. Puerto HTTP
    ask_port

    # 7b. Bind del puerto (BIND_ADDR): red interna (0.0.0.0) o solo local (127.0.0.1)
    ask_choice BIND_ADDR \
      "Bind del puerto — accesible desde la red interna (0.0.0.0) o solo local (127.0.0.1)" \
      "$BIND_ADDR" \
      "0.0.0.0|127.0.0.1" \
      "Opciones: 0.0.0.0 (red interna), 127.0.0.1 (solo local)."
    log "BIND_ADDR (personalizado) → $BIND_ADDR."

    # 8. Código de arranque de 6 dígitos (R2, reemplaza al token hex)
    local bc_choice=""
    ask_choice bc_choice "Generar código de arranque de 6 dígitos (de un solo uso, recomendado)" "generar" "generar|no" "Opciones: generar, no."
    if [ "$bc_choice" = "generar" ]; then
      BOOTSTRAP_CODE="$(generate_bootstrap_code)"
      MASK_SECRETS+=("$BOOTSTRAP_CODE")
      log "BOOTSTRAP_CODE de 6 dígitos generado (se mostrará una única vez al final)."
    else
      BOOTSTRAP_CODE=""
      log "Sin código de arranque (bootstrap directo con $SUPER_ADMIN_EMAIL)."
    fi

    # 9. Avanzadas opcionales
    ask_choice ANONYMOUS_MODE "Modo anónimo (permite ver apps públicas sin login)" "on" "on|off" "Opciones: on, off."
    echo "  (TRUST_PROXY: pon 1 SOLO si hay Caddy/Nginx con TLS delante de la app)"
    # Coherencia TRUST_PROXY: URL https → default 1 (proxy de confianza); si no, 0.
    local trust_default="0"
    [ "${URL_PUBLICA#https://}" != "$URL_PUBLICA" ] && trust_default="1"
    ask_choice TRUST_PROXY "TRUST_PROXY" "$trust_default" "0|1" "Opciones: 0, 1."
    log "TRUST_PROXY (personalizado) → $TRUST_PROXY."
  fi

  bind_security_warnings

  # Garantía final: si MAIL_DRIVER=sendgrid siempre debe haber MAIL_FROM derivado.
  if [ "$MAIL_DRIVER" = "sendgrid" ] && [ -z "$MAIL_FROM" ]; then
    MAIL_FROM="no-reply@${admin_dom}"
  fi
}

# -----------------------------------------------------------------------------
# Fase 1 no interactiva (--non-interactive [--env-file RUTA])
# -----------------------------------------------------------------------------
gather_noninteractive() {
  log "Fase 1 — Modo no interactivo (origen: ${ENV_FILE:-valores por defecto})"
  if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || die "--env-file no existe: $ENV_FILE"
    log "Leyendo valores base de $ENV_FILE"
    URL_PUBLICA="$(env_get "$ENV_FILE" PORTAL_URL)"
    [ -z "$URL_PUBLICA" ] && URL_PUBLICA="$(env_get "$ENV_FILE" URL)"
    SITE_NAME="$(env_get "$ENV_FILE" SITE_NAME)"
    SUPER_ADMIN_EMAIL="$(env_get "$ENV_FILE" SUPER_ADMIN_EMAIL)"
    ALLOWED_EMAIL_DOMAINS="$(env_get "$ENV_FILE" ALLOWED_EMAIL_DOMAINS)"
    [ -z "$ALLOWED_EMAIL_DOMAINS" ] && ALLOWED_EMAIL_DOMAINS="$(env_get "$ENV_FILE" ALLOWED_DOMAINS)"
    MAIL_DRIVER="$(env_get "$ENV_FILE" MAIL_DRIVER)"
    SMTP_HOST="$(env_get "$ENV_FILE" SMTP_HOST)"
    SMTP_PORT="$(env_get "$ENV_FILE" SMTP_PORT)"
    SMTP_USER="$(env_get "$ENV_FILE" SMTP_USER)"
    SMTP_PASS="$(env_get "$ENV_FILE" SMTP_PASS)"
    MAIL_FROM="$(env_get "$ENV_FILE" MAIL_FROM)"
    SENDGRID_API_KEY="$(env_get "$ENV_FILE" SENDGRID_API_KEY)"
    NODE_ENV="$(env_get "$ENV_FILE" NODE_ENV)"
    PORT="$(env_get "$ENV_FILE" PORT)"
    BIND_ADDR="$(env_get "$ENV_FILE" BIND_ADDR)"
    SESSION_SECRET="$(env_get "$ENV_FILE" SESSION_SECRET)"
    POSTGRES_PASSWORD="$(env_get "$ENV_FILE" POSTGRES_PASSWORD)"
    BOOTSTRAP_TOKEN="$(env_get "$ENV_FILE" BOOTSTRAP_TOKEN)"
    BOOTSTRAP_CODE="$(env_get "$ENV_FILE" BOOTSTRAP_CODE)"
    ANONYMOUS_MODE="$(env_get "$ENV_FILE" ANONYMOUS_MODE)"
    TRUST_PROXY="$(env_get "$ENV_FILE" TRUST_PROXY)"
    COOKIE_SECURE="$(env_get "$ENV_FILE" COOKIE_SECURE)"
  fi

  # Defaults coherentes
  [ -z "$URL_PUBLICA" ] && URL_PUBLICA="http://localhost"
  [ -z "$SITE_NAME" ] && SITE_NAME="SM-HomePage"
  [ -z "$MAIL_DRIVER" ] && MAIL_DRIVER="log"
  [ -z "$SMTP_PORT" ] && SMTP_PORT=587
  [ -z "$PORT" ] && PORT=3000
  [ -z "$ANONYMOUS_MODE" ] && ANONYMOUS_MODE="on"
  [ -z "$TRUST_PROXY" ] && TRUST_PROXY=0
  if [ -z "$NODE_ENV" ]; then
    case "$URL_PUBLICA" in
      http://localhost*) NODE_ENV="development" ;;
      *) NODE_ENV="production" ;;
    esac
  fi
  if [ -z "$COOKIE_SECURE" ]; then
    case "$URL_PUBLICA" in
      https://*) COOKIE_SECURE=true ;;
      *) COOKIE_SECURE=false ;;
    esac
  fi

  # BIND_ADDR: si viene del env-file se valida abajo; si no, se deriva de la
  # URL con detección SOLO loopback (RFC1918 NO cuenta como local).
  if [ -z "$BIND_ADDR" ]; then
    if is_loopback_url "$URL_PUBLICA"; then
      BIND_ADDR="127.0.0.1"
    else
      BIND_ADDR="0.0.0.0"
    fi
    log "BIND_ADDR derivado de URL_PUBLICA ($URL_PUBLICA) → $BIND_ADDR."
  else
    log "BIND_ADDR leído del env-file → $BIND_ADDR."
  fi

  # Coherencia NODE_ENV/COOKIE_SECURE (Asistente v2, punto 5) — no interactivo.
  if is_insecure_local_url "$URL_PUBLICA" && [ "$NODE_ENV" = "production" ]; then
    NODE_ENV="development"
    log "AVISO: URL local sin TLS + NODE_ENV=production → forzado a development (coherencia)."
  fi
  if [ -z "$NODE_ENV" ]; then
    if is_local_url "$URL_PUBLICA"; then NODE_ENV="development"; else NODE_ENV="production"; fi
    log "NODE_ENV derivado de la URL: $NODE_ENV."
  fi
  if [ "$NODE_ENV" = "production" ] && [ "${URL_PUBLICA#https://}" = "$URL_PUBLICA" ]; then
    log "AVISO: producción con URL no https — considera TLS en el borde (Caddy/Nginx)."
  fi

  # Incorporar secretos al enmascarado
  for s in "$SENDGRID_API_KEY" "$SMTP_PASS" "$SESSION_SECRET" "$POSTGRES_PASSWORD" "$BOOTSTRAP_TOKEN" "$BOOTSTRAP_CODE"; do
    [ -n "$s" ] && MASK_SECRETS+=("$s")
  done

  # Derivar dominios permitidos y remitente desde el email del admin
  if [ -n "$SUPER_ADMIN_EMAIL" ]; then
    local admin_dom
    admin_dom="$(printf '%s' "$SUPER_ADMIN_EMAIL" | cut -d@ -f2)"
    [ -z "$ALLOWED_EMAIL_DOMAINS" ] && ALLOWED_EMAIL_DOMAINS="$admin_dom"
    [ -z "$MAIL_FROM" ] && MAIL_FROM="no-reply@${admin_dom}"
  fi

  # Generar secretos que falten (nunca se preguntan, nunca se muestran completos)
  if [ -z "$SESSION_SECRET" ]; then
    SESSION_SECRET="$(openssl rand -hex 32)"
    MASK_SECRETS+=("$SESSION_SECRET")
  fi
  if [ -z "$POSTGRES_PASSWORD" ]; then
    POSTGRES_PASSWORD="$(openssl rand -hex 32)"
    MASK_SECRETS+=("$POSTGRES_PASSWORD")
  fi

  # Validaciones obligatorias (falla con mensaje claro)
  local errors=()

  # Código de arranque: si no viene del env-file ni hay BOOTSTRAP_TOKEN previo,
  # se genera automáticamente (default recomendado del asistente v2).
  if [ -z "$BOOTSTRAP_CODE" ] && [ -z "$BOOTSTRAP_TOKEN" ]; then
    BOOTSTRAP_CODE="$(generate_bootstrap_code)"
    MASK_SECRETS+=("$BOOTSTRAP_CODE")
    log "BOOTSTRAP_CODE de 6 dígitos generado automáticamente (no interactivo)."
  fi
  if [ -n "$BOOTSTRAP_CODE" ] && { ! printf '%s' "$BOOTSTRAP_CODE" | grep -qE '^[0-9]{6}$' || [ "$BOOTSTRAP_CODE" = "000000" ]; }; then
    errors+=("BOOTSTRAP_CODE debe ser un número de 6 dígitos (no 000000): $BOOTSTRAP_CODE")
  fi

  # Validación de credenciales de correo (avisos no bloqueantes) antes del resumen.
  validate_mail_credentials
  VALIDATED_MAIL=1

  if ! printf '%s' "$URL_PUBLICA" | grep -qE "$URL_RE"; then
    errors+=("URL inválida: $URL_PUBLICA")
  fi
  if [ -z "$SUPER_ADMIN_EMAIL" ]; then
    errors+=("SUPER_ADMIN_EMAIL es obligatorio")
  elif ! printf '%s' "$SUPER_ADMIN_EMAIL" | grep -qE "$EMAIL_RE"; then
    errors+=("SUPER_ADMIN_EMAIL inválido: $SUPER_ADMIN_EMAIL")
  fi
  case "$MAIL_DRIVER" in
    log|smtp|sendgrid) : ;;
    *) errors+=("MAIL_DRIVER inválido: $MAIL_DRIVER") ;;
  esac
  if [ "$MAIL_DRIVER" = "smtp" ] && [ -z "$SMTP_HOST" ]; then
    errors+=("SMTP_HOST obligatorio si MAIL_DRIVER=smtp")
  fi
  if [ "$MAIL_DRIVER" = "sendgrid" ] && [ -z "$SENDGRID_API_KEY" ]; then
    errors+=("SENDGRID_API_KEY obligatoria si MAIL_DRIVER=sendgrid")
  fi
  if [ "$MAIL_DRIVER" = "log" ] && [ "$NODE_ENV" = "production" ]; then
    errors+=("MAIL_DRIVER=log está prohibido en producción")
  fi
  if ! printf '%s' "$PORT" | grep -qE "$PORT_RE" || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    errors+=("Puerto HTTP inválido: $PORT")
  fi
  case "$BIND_ADDR" in
    127.0.0.1|0.0.0.0) : ;;
    *) errors+=("BIND_ADDR inválido: $BIND_ADDR (valores válidos: 127.0.0.1 o 0.0.0.0)") ;;
  esac
  if [ "${#errors[@]}" -gt 0 ]; then
    local msg
    msg="Faltan o son inválidos valores obligatorios (--non-interactive):
$(printf '  - %s\n' "${errors[@]}")"
    die "$msg"
  fi
  if port_in_use "$PORT"; then
    log "AVISO: el puerto $PORT está en uso (continúa igualmente)."
  fi

  # Avisos de seguridad del bind (en no interactivo: solo log, no bloquea).
  bind_security_warnings
}

# -----------------------------------------------------------------------------
# Fase 2 — Resumen y confirmación
# -----------------------------------------------------------------------------
generate_secrets() {
  if [ -z "$SESSION_SECRET" ]; then
    SESSION_SECRET="$(openssl rand -hex 32)"
    MASK_SECRETS+=("$SESSION_SECRET")
  fi
  if [ -z "$POSTGRES_PASSWORD" ]; then
    POSTGRES_PASSWORD="$(openssl rand -hex 32)"
    MASK_SECRETS+=("$POSTGRES_PASSWORD")
  fi
  log "Secretos autogenerados (SESSION_SECRET y POSTGRES_PASSWORD) — no se muestran completos."
}

show_summary() {
  echo
  echo "────────────────────────────────────────────"
  echo " Resumen de configuración"
  echo "────────────────────────────────────────────"
  echo "  URL pública     : $URL_PUBLICA"
  echo "  Sitio           : $SITE_NAME"
  echo "  Super admin     : $SUPER_ADMIN_EMAIL"
  echo "  Dominios        : $ALLOWED_EMAIL_DOMAINS"
  echo "  Driver correo   : $MAIL_DRIVER"
  case "$MAIL_DRIVER" in
    smtp)
      echo "    Host SMTP     : $SMTP_HOST"
      echo "    Puerto SMTP   : $SMTP_PORT"
      echo "    Usuario SMTP  : $SMTP_USER"
      echo "    Pass SMTP     : $(short_mask "$SMTP_PASS")"
      echo "    Remitente     : $MAIL_FROM"
      ;;
    sendgrid)
      echo "    SendGrid API Key: $(short_mask "$SENDGRID_API_KEY")"
      echo "    Remitente     : $MAIL_FROM"
      ;;
    log)
      echo "    Remitente     : $MAIL_FROM"
      ;;
  esac
  echo "  Puerto HTTP     : $PORT"
  echo "  Bind de red     : $BIND_ADDR (0.0.0.0 = red interna, 127.0.0.1 = solo local)"
  echo "  Entorno         : $NODE_ENV"
  echo "  Cookie Secure   : $COOKIE_SECURE"
  echo "  Modo anónimo    : $ANONYMOUS_MODE"
  echo "  Trust proxy     : $TRUST_PROXY"
  if [ -n "$BOOTSTRAP_CODE" ]; then
    echo "  Bootstrap code  : $(boot_mask "$BOOTSTRAP_CODE") (6 dígitos, se mostrará una vez al final)"
  elif [ -n "$BOOTSTRAP_TOKEN" ]; then
    echo "  Bootstrap token : $(short_mask "$BOOTSTRAP_TOKEN") (se mostrará una vez al final)"
  else
    echo "  Bootstrap code  : no generado (bootstrap directo con $SUPER_ADMIN_EMAIL)"
  fi
  echo "  SESSION_SECRET  : $(short_mask "$SESSION_SECRET") (autogenerado)"
  echo "  POSTGRES_PASS   : $(short_mask "$POSTGRES_PASSWORD") (autogenerado)"
  echo "────────────────────────────────────────────"
}

# -----------------------------------------------------------------------------
# Fase 3 — Generación del .env
# -----------------------------------------------------------------------------
write_env() {
  umask 077
  if [ -f "$ENV_TARGET" ]; then
    ENV_BACKUP="$DEPLOY_DIR/.env.backup.$(date +%Y%m%d%H%M%S)"
    cp "$ENV_TARGET" "$ENV_BACKUP"
    chmod 600 "$ENV_BACKUP"
    log "Copia de seguridad del .env anterior: $ENV_BACKUP"
  fi

  # Validación de credenciales de correo antes de escribir (Asistente v2, punto 6).
  [ "$VALIDATED_MAIL" -eq 1 ] || validate_mail_credentials

  local dev_code="true"
  [ "$NODE_ENV" = "production" ] && dev_code="false"

  # Con MAIL_DRIVER=sendgrid las variables SMTP_* se escriben vacías (evita confusión).
  local smtp_host="$SMTP_HOST" smtp_port="$SMTP_PORT" smtp_user="$SMTP_USER" smtp_pass="$SMTP_PASS"
  if [ "$MAIL_DRIVER" = "sendgrid" ]; then
    smtp_host=""; smtp_port=""; smtp_user=""; smtp_pass=""
  fi

  cat > "$ENV_TARGET" <<EOF
# ======================================================================
# SM-HomePage — generado por deploy.sh el $(date '+%Y-%m-%d %H:%M')
# NO compartas este archivo. Para regenerarlo: bash deploy.sh --force-regenerate
# ======================================================================
NODE_ENV=$NODE_ENV
PORT=$PORT
# BIND_ADDR y PORTAL_URL son SOLO para el asistente/update.sh — la app no las lee.
BIND_ADDR=$BIND_ADDR
PORTAL_URL=$URL_PUBLICA
SESSION_SECRET=$SESSION_SECRET
SESSION_DAYS=30
SESSION_ROTATE_DAYS=7
REVOKE_ALL_ON_LOGIN=false
DATABASE_URL=postgres://corphomepage:${POSTGRES_PASSWORD}@db:5432/corphomepage
ALLOWED_EMAIL_DOMAINS=$ALLOWED_EMAIL_DOMAINS
SUPER_ADMIN_EMAIL=$SUPER_ADMIN_EMAIL
BOOTSTRAP_CODE=$BOOTSTRAP_CODE
BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN
ENABLE_DEV_CODE=$dev_code
OTP_TTL_MIN=10
MAIL_DRIVER=$MAIL_DRIVER
MAIL_FROM=$MAIL_FROM
SMTP_HOST=$smtp_host
SMTP_PORT=$smtp_port
SMTP_USER=$smtp_user
SMTP_PASS=$smtp_pass
SMTP_FROM="${SITE_NAME} <${MAIL_FROM}>"
SENDGRID_API_KEY=$SENDGRID_API_KEY
COOKIE_SECURE=$COOKIE_SECURE
SITE_NAME=$SITE_NAME
DEFAULT_THEME=system
PORTAL_BG_COLOR=#0f1115
ANONYMOUS_MODE=$ANONYMOUS_MODE
TRUST_PROXY=$TRUST_PROXY
POSTGRES_DB=corphomepage
POSTGRES_USER=corphomepage
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
  chmod 600 "$ENV_TARGET"
  log "Archivo .env generado (chmod 600, secretos enmascarados en logs)."
}

# -----------------------------------------------------------------------------
# Fase 4 — Despliegue con docker compose
# -----------------------------------------------------------------------------
run() {
  local desc="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[DRY-RUN] se ejecutaría: $desc"
    return 0
  fi
  log "▶ $desc"
  "$@"
}

# Advertir si existe un volumen pgdata preexistente con otra password.
warn_pgdata() {
  local vols
  vols="$(dc volume ls -q 2>/dev/null | grep -E 'pgdata$' || true)"
  if [ -n "$vols" ]; then
    log "AVISO: volúmenes PostgreSQL preexistentes detectados."
    echo "  ⚠ Existen volúmenes de BD previos ($(printf '%s' "$vols" | tr '\n' ' '))."
    echo "    Postgres SOLO lee POSTGRES_PASSWORD en el primer init, así que una"
    echo "    password nueva NO se aplicará a una BD existente. Opciones:"
    echo "      a) Reutilizar la password anterior (ver .env.backup.*)."
    echo "      b) docker compose exec db psql -U corphomepage -c \"ALTER USER corphomepage WITH PASSWORD '...';\""
    echo "      c) Respaldo + recrear el volumen (docker compose down -v) SOLO si no hay datos que perder."
  fi
}

wait_healthy() {
  local port="$1" deadline n
  deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    n="$(dc compose ps --format '{{.Status}}' 2>/dev/null | grep -c 'healthy' || true)"
    if [ "$n" -ge 2 ] && curl -fsS -o /dev/null "http://127.0.0.1:${port}/login" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

rollback() {
  log "Aplicando rollback..."
  run "docker compose down (sin -v, se conservan los volúmenes)" dc compose down 2>/dev/null || true
  if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" "$ENV_TARGET"
    chmod 600 "$ENV_TARGET"
    log "Restaurado el .env previo desde $ENV_BACKUP"
  else
    log "No hay .env previo que restaurar."
  fi
}

deploy_stack() {
  warn_pgdata
  run "validar docker-compose.yml (docker compose config --quiet)" dc compose config --quiet
  run "docker compose build --pull" dc compose build --pull
  if [ "$DRY_RUN" -eq 1 ]; then
    run "docker compose up -d" dc compose up -d
    run "esperar salud (db+web healthy y /login 200, máx 90 s)" true
    STACK_HEALTHY=1
    return 0
  fi
  if ! dc compose up -d; then
    log "ERROR: docker compose up -d falló."
    rollback
    die "No se pudo levantar el stack. Los contenedores anteriores quedan intactos."
  fi
  log "Esperando salud del stack (hasta 90 s)..."
  if wait_healthy "$PORT"; then
    STACK_HEALTHY=1
    log "Stack sano: db healthy + web healthy + /login responde 200."
  else
    log "ERROR: el stack no quedó sano en 90 s."
    rollback
    die "Despliegue fallido tras el timeout de salud. Revisa: dc compose ps y dc compose logs web"
  fi
}

# -----------------------------------------------------------------------------
# Fase 5 — Bootstrap y cierre
# -----------------------------------------------------------------------------
finish() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo
    echo "════════════════════════════════════════════════════════"
    echo "  DRY-RUN — plan completo, NO se ha ejecutado nada."
    echo "  Pasos que se ejecutarían en modo real:"
    echo "   1. Generar .env (chmod 600) con POSTGRES_PASSWORD y"
    echo "      SESSION_SECRET aleatorios."
    echo "   2. docker compose config --quiet"
    echo "   3. docker compose build --pull"
    echo "   4. docker compose up -d"
    echo "   5. Esperar salud (db+web healthy, /login 200, máx 90 s)"
    if [ -n "$BOOTSTRAP_CODE" ]; then
      echo "   6. Mostrar BOOTSTRAP_CODE una vez ($(boot_mask "$BOOTSTRAP_CODE"))"
    elif [ -n "$BOOTSTRAP_TOKEN" ]; then
      echo "   6. Mostrar BOOTSTRAP_TOKEN una vez ($(short_mask "$BOOTSTRAP_TOKEN"))"
    fi
    echo "  URL de acceso    : $URL_PUBLICA"
    echo "════════════════════════════════════════════════════════"
    return 0
  fi

  echo
  if [ -n "$BOOTSTRAP_CODE" ]; then
    echo "  ┌──────────────────────────────────────────────────────┐"
    echo "  │  CÓDIGO DE ARRANQUE (6 dígitos, de un solo uso)      │"
    echo "  └──────────────────────────────────────────────────────┘"
    echo
    echo "      $BOOTSTRAP_CODE"
    echo
    echo "  1. Abre $URL_PUBLICA"
    echo "  2. Introduce el email $SUPER_ADMIN_EMAIL"
    echo "  3. En el paso 'Primer inicio', escribe el código de 6 dígitos."
    echo "     Se consume al usarse — guárdalo ahora, no se volverá a mostrar."
    echo
  elif [ -n "$BOOTSTRAP_TOKEN" ]; then
    echo "  ┌──────────────────────────────────────────────────────┐"
    echo "  │  BOOTSTRAP_TOKEN (muestra única, de un solo uso)     │"
    echo "  └──────────────────────────────────────────────────────┘"
    echo
    echo "      $BOOTSTRAP_TOKEN"
    echo
    echo "  1. Abre $URL_PUBLICA"
    echo "  2. Introduce el email $SUPER_ADMIN_EMAIL"
    echo "  3. En el primer login, pega el token en el campo"
    echo "     'Token de arranque'. Se consume al usarse."
    echo
  else
    echo
    echo "  1. Abre $URL_PUBLICA"
    echo "  2. Introduce el email $SUPER_ADMIN_EMAIL"
    echo "     (bootstrap directo, sin código ni token)."
    echo
  fi
  echo "  ✔ SM-HomePage desplegado. Accede a $URL_PUBLICA"
  log "SM-HomePage desplegado. Accede a $URL_PUBLICA (bootstrap mostrado en consola)."
}

# -----------------------------------------------------------------------------
# Argumentos y entrada
# -----------------------------------------------------------------------------
usage() {
  cat <<'EOF'
SM-HomePage — asistente de instalación y despliegue

USO:
  bash deploy.sh [OPCIONES]

OPCIONES:
  --dry-run            Muestra el plan y las preguntas sin ejecutar nada.
  --force-regenerate   Regenera .env aunque ya exista (con backup previo).
  --non-interactive    Sin prompts: usa --env-file o valores por defecto.
  --env-file RUTA      Archivo con valores base (recomendado con --non-interactive).
  -h, --help           Muestra esta ayuda.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --force-regenerate) FORCE_REGENERATE=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --env-file) shift; [ $# -eq 0 ] && die "--env-file requiere una ruta"; ENV_FILE="$1" ;;
      --env-file=*) ENV_FILE="${1#--env-file=}" ;;
      -h|--help) usage; exit 0 ;;
      *) die "Opción desconocida: $1 (usa --help)" ;;
    esac
    shift
  done
  if [ "$NON_INTERACTIVE" -eq 0 ] && [ -n "$ENV_FILE" ]; then
    log "AVISO: --env-file sin --non-interactive (se usará como base pre-rellena)."
  fi
}

main() {
  umask 077
  : > "$DEPLOY_LOG" 2>/dev/null || touch "$DEPLOY_LOG"
  chmod 600 "$DEPLOY_LOG" 2>/dev/null || true

  parse_args "$@"
  log "SM-HomePage deploy.sh — inicio ($(date '+%F %T'))"
  [ "$DRY_RUN" -eq 1 ] && log "MODO DRY-RUN activado: no se ejecutará nada, solo se muestra el plan."

  prechecks

  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    gather_noninteractive
  else
    gather_interactive
  fi

  generate_secrets

  show_summary

  if [ "$DRY_RUN" -eq 0 ] && [ "$NON_INTERACTIVE" -eq 0 ]; then
    if ! confirm "¿Confirmas el despliegue?" "no"; then
      die "Despliegue cancelado. No se ha modificado nada."
    fi
  fi

  # Fase 3
  if [ "$DRY_RUN" -eq 0 ]; then
    write_env
  else
    log "[DRY-RUN] se escribiría .env (chmod 600) con las variables del resumen."
  fi

  # Fase 4
  deploy_stack

  # Fase 5
  finish
}

main "$@"

