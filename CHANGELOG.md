# Changelog

Todas las entradas notables del proyecto **SM-HomePage**. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto
mantiene [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

### Añadido

- **Bind de puerto configurable (`BIND_ADDR`)** para despliegues de intranet:
  `docker-compose.yml` publica el puerto en `BIND_ADDR` (default `127.0.0.1`,
  fail-closed) y `deploy.sh`/`update.sh` lo derivan de la URL pública con
  **detección solo-loopback** (localhost/`127.*`/`::1`/`0.0.0.0` →
  `127.0.0.1`; cualquier otra URL —RFC1918, dominio…— → `0.0.0.0`), de modo que
  un proxy/Caddy en otra máquina de la red alcanza la app. Incluye pregunta en
  modo personalizado, coherencia `TRUST_PROXY` con la URL (`https` → default
  `1`), avisos de seguridad (bind expuesto a red no-RFC1918 y confirmación
  explícita si `BIND_ADDR=0.0.0.0` + `TRUST_PROXY=1` + URL `http`), escritura
  de `BIND_ADDR` y `PORTAL_URL` en el `.env`, y re-derivación segura en
  `update.sh`. Documentación actualizada (README, INSTALACION, ARQUITECTURA,
  `.env.example`).

## [1.0.0] - 2026-08-04

### Primera versión estable

Portal corporativo de acceso a aplicaciones estilo **Heimdall**, listo para
desplegar con un asistente de instalación.

#### Acceso y autenticación

- Autenticación por **código OTP de 6 dígitos enviado por email** (driver
  `log` | `smtp` | `sendgrid`), TTL 10 minutos, hash bcrypt (cost 10),
  comparación en tiempo constante y **single-use atómico**.
- Sesiones **server-side de 30 días** (token opaco de 32 bytes guardado como
  SHA-256 en la tabla `sessions`), cookie `HttpOnly`, `SameSite=Strict` y
  `Secure` en producción.
- **Rotación deslizante** (F5): cada 7 días la sesión se rota (token nuevo,
  revocación del anterior).
- **Revocación server-side**: desactivar un usuario o cambiar su rol incrementa
  `session_version` y mata todas sus sesiones.
- **Anti-enumeración**: la petición de código responde el mismo 200 genérico
  para dominios permitidos y no permitidos.
- **Bootstrap seguro del super_admin**: única vía `SUPER_ADMIN_EMAIL`, con
  `BOOTSTRAP_TOKEN` opcional de **un solo uso**.
- **Acceso dual**: portal usable en modo **anónimo** (solo apps públicas) o
  autenticado, con `ANONYMOUS_MODE` configurable.

#### Portal y contenido

- Dashboard con buscador **spotlight**, agrupado por **categorías
  gestionables** y filtro por grupos del usuario.
- Catálogo de aplicaciones (públicas/restringidas) con **biblioteca de iconos**
  integrada y **subida de iconos personalizados**.
- **Logo de empresa** por `super_admin` validado por **magic bytes**
  (PNG/JPEG), cache-busting `?v=` y almacenamiento en volumen persistente.
- **Tema claro/oscuro/sistema** sin FOUC y sin scripts inline (CSP).

#### Administración y gobernanza

- **RBAC con 3 roles**: `super_admin` (todo), `admin` (usuarios y asignaciones)
  y `employee` (solo dashboard). Nadie puede desactivar al último
  super_admin activo.
- **Consola de administración** completa: usuarios, grupos, aplicaciones,
  categorías y settings.
- **Settings en BD** (tabla `settings`) con precedencia sobre env y aplicación
  en runtime sin reiniciar (caché de 30 s).
- **Auditoría append-only** (tabla `audit_log`) visible por super_admin.

#### Seguridad

- CSP estricta, cookies `HttpOnly`/`SameSite=Strict`/`Secure`, **CSRF** en
  todos los formularios, **rate limiting** por IP real, queries
  parametrizadas, **cero SSRF** (el servidor nunca consulta URLs de apps) y
  purga diaria de OTPs/sesiones caducadas.

#### Despliegue

- **`deploy.sh`**: asistente de instalación interactivo (prechecks de SO y
  Docker, preguntas guiadas con defaults, generación de `.env` con secretos
  aleatorios, build+up con espera de salud y bootstrap del admin). Soporta
  `--dry-run`, `--force-regenerate`, `--non-interactive` y `--env-file`.
- **`update.sh`**: actualización segura con backup de BD obligatorio
  (`pg_dump` → gzip), retención de 5 backups, smoke test y restauración ante
  fallos.
- **Docker + docker-compose** endurecido: PostgreSQL 16, bind a
  `127.0.0.1`, `POSTGRES_PASSWORD` obligatoria, `security_opt
  no-new-privileges` y healthchecks.

### Mejoras futuras

- **U-3**: mutex de OTP por email (una solicitud activa, sin carreras).
- **U-5**: CSRF adicional vía cabecera (no solo campo oculto/cookie).
- **Dropar la columna `apps.category`** (legacy) en favor de `category_id`.
- **Integración SSO futura** (OIDC/SAML) junto al flujo OTP por email.
- Soporte de despliegue con `docker-compose` clásico (no solo plugin).
- `pg_dump` programado (cron) como servicio de backups opcional.
- Interfaz de administración de logs de auditoría con filtros y exportación.
