# Arquitectura de SM-HomePage

Documento técnico **genérico** del proyecto (sin datos internos de ninguna
organización). Explica el stack, el modelo de datos, el flujo de
autenticación, el control de acceso y las decisiones de seguridad.

---

## 1. Stack

| Capa | Tecnología |
|---|---|
| Backend | **Node.js 20 + Express 4** (CommonJS, sin transpilación) |
| Base de datos | **PostgreSQL 16** (driver `pg` directo, SQL parametrizado) |
| Vistas | **EJS** (SSR, sin build de frontend; Vanilla JS/CSS) |
| Correo | **Nodemailer** (SMTP o SendGrid vía SMTP) |
| Tests | **vitest** (DB mock, sin PostgreSQL real) |
| Despliegue | **Docker + docker-compose** (`deploy.sh` / `update.sh`) |

## 2. Contenedores (docker-compose)

- **`db`**: `postgres:16-alpine`, volumen `pgdata`, healthcheck con
  `pg_isready`. `POSTGRES_PASSWORD` es **obligatoria** (sin default).
- **`web`**: imagen construida desde `server/`, usuario **no-root**
  (`USER node`), `security_opt: no-new-privileges`, bind del puerto a
  `127.0.0.1`, healthcheck con `wget` a `/login`, volumen `uploads` para el
  logo de la empresa. `depends_on: db (service_healthy)`.

El puerto se expone únicamente en `127.0.0.1`; la exposición real debe hacerse
a través de un **reverse proxy con TLS** (Caddy/Nginx/Traefik).

## 3. Modelo de datos

| Tabla | Propósito |
|---|---|
| `users` | Usuarios: `email` (citext, único), `role`, `status`, `session_version`, `last_login_at` |
| `sessions` | Sesiones server-side: `token_hash` (SHA-256), `expires_at`, `revoked_at`, IP y User-Agent |
| `otp_codes` | Códigos OTP: `code_hash` (bcrypt), `expires_at`, `consumed_at` |
| `login_attempts` | Contador de intentos y lockout con backoff exponencial |
| `groups` | Grupos de usuarios (p. ej. dev, finanzas) |
| `user_groups` | Asignación usuario ↔ grupo |
| `categories` | Categorías gestionables para agrupar apps en el dashboard |
| `apps` | Aplicaciones: `url`, `icon_url/icon_key/icon_class`, `category_id`, `color`, `visibility` |
| `app_group_assignments` | Asignación app restringida ↔ grupo |
| `audit_log` | Auditoría **append-only** (`action`, `entity_type`, `details` jsonb, IP) |
| `bootstrap_tokens` | Tokens de bootstrap del super_admin (single-use) |
| `settings` | Configuración key/value editable en runtime (precedencia sobre env) |

Notas:

- `schema.sql` se ejecuta al arrancar con `CREATE TABLE IF NOT EXISTS` +
  `ALTER TABLE ADD COLUMN IF NOT EXISTS` → **idempotente** (las migraciones
  corren solas al levantar).
- La columna `apps.category` es **legacy** (texto); el agrupado efectivo usa
  `category_id → categories`.
- `audit_log` es append-only: solo lectura para `super_admin`.

## 4. Flujo de autenticación OTP

1. `POST /auth/request` con el email. La respuesta es el **mismo 200 genérico**
   para dominios permitidos y no permitidos (**anti-enumeración**).
2. Si el dominio está en la allow-list (`settings.allowed_domains` o env), se
   genera un código de 6 dígitos, se guarda hasheado (bcrypt, cost 10, TTL 10
   min) y se envía por el driver configurado (`log`/`smtp`/`sendgrid`).
3. `POST /auth/verify` valida el código con comparación en tiempo constante,
   consume el token de forma **atómica** (single-use) y crea la sesión
   server-side.
4. **Bootstrap**: solo `SUPER_ADMIN_EMAIL` puede crear el primer
   `super_admin`; opcionalmente exige un `BOOTSTRAP_TOKEN` de un solo uso.
5. Sesión de 30 días con **rotación deslizante** (cada 7 días) y
   revocación server-side vía `session_version`.

### Fail-fast de configuración

La app **no arranca** si: falta `DATABASE_URL`/`SESSION_SECRET`; en
producción falta `SUPER_ADMIN_EMAIL`; `MAIL_DRIVER=log` en producción;
`MAIL_DRIVER=sendgrid` sin `SENDGRID_API_KEY`; hay `BOOTSTRAP_TOKEN` sin
`SUPER_ADMIN_EMAIL`; o el dominio efectivo de `SUPER_ADMIN_EMAIL` no está
permitido (anti-lockout).

## 5. RBAC (3 roles)

| Rol | Dashboard | Usuarios | Grupos | Apps/Categorías | Audit | Settings |
|---|---|---|---|---|---|---|
| `super_admin` | ✔ | ✔ (incl. crear/promover admins) | ✔ | ✔ | ✔ | ✔ |
| `admin` | ✔ | ✔ (solo employees/asignaciones) | solo lectura | ✖ | ✖ | ✖ |
| `employee` | ✔ (solo sus apps) | ✖ | ✖ | ✖ | ✖ | ✖ |

- La visibilidad de apps en el dashboard depende de `visibility` y de las
  asignaciones por grupo del usuario autenticado.
- **Nadie puede desactivar ni cambiar el rol del último super_admin activo.**

## 6. Acceso dual

- **Anónimo** (`ANONYMOUS_MODE=on`): el dashboard público muestra **solo apps
  públicas**, sin revelar nombres de grupos ni apps restringidas.
- **Autenticado**: el dashboard muestra sus apps por grupo con el buscador
  *spotlight* y filtros por grupo.

## 7. Seguridad

- **CSP estricta**: `default-src 'self'`, sin scripts inline.
- **Cookies**: `HttpOnly`, `SameSite=Strict`, `Secure` en producción
  (`COOKIE_SECURE` configurable para HTTP interno).
- **CSRF** en todos los formularios (cookie + campo oculto; en multipart
  también en query/header).
- **Rate limiting** por IP real (`req.ip`). `TRUST_PROXY` solo debe activarse
  si hay un proxy de confianza con TLS delante (si no, un `X-Forwarded-For`
  forjado podría alterar `req.ip`).
- **Queries parametrizadas** en todo el código y escape por defecto en EJS.
- **Logo por magic bytes**: solo PNG/JPEG reales (≤2 MB, ≤2048 px), nombre
  fijado por el servidor (sin path traversal), con cache-busting `?v=`.
- **Cero SSRF**: el servidor nunca realiza peticiones a URLs de apps ni de
  iconos; los iconos los carga el navegador del cliente.
- **Purga diaria** de OTPs expirados, intentos fallidos y sesiones revocadas
  (job interno).

## 8. Configuración en runtime

La tabla `settings` guarda valores de personalización (`site_name`,
`allowed_domains`, `mail_from`, `default_theme`, `logo_version`) con
**precedencia sobre env** y caché de lectura de 30 s. **Nunca guarda
secretos**. Cada cambio se audita.
