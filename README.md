# SM-HomePage

Portal corporativo de acceso a aplicaciones estilo **Heimdall**. Cada empleado ve una grilla de aplicaciones según su grupo, con buscador *spotlight*, autenticación por **código OTP de 6 dígitos enviado por email** y sesiones server-side de 30 días revocables.

> **Acceso**: es un portal **interno**. Está pensado para publicarse solo dentro de la red interna / VPN / Zero-Trust de tu empresa (no exponer a Internet).

---

## Instalación rápida

> Requisitos: Ubuntu 22.04/24.04 o Debian 12 con acceso a Docker (el
> asistente puede instalarlo). Guía completa en [`docs/INSTALACION.md`](docs/INSTALACION.md).

```bash
# 1. Clona y entra en el repositorio
git clone <url-de-tu-repo> && cd SM-HomePage

# 2. Asistente de instalación interactivo (pregunta todo, genera .env y despliega)
bash deploy.sh
```

El asistente deja el portal **desplegado y arrancado**, muestra **una única
vez** el **código de arranque de 6 dígitos** (`BOOTSTRAP_CODE`, de un solo
uso) para el primer login del `super_admin` y el mensaje final
`SM-HomePage desplegado. Accede a <URL>`.

## Actualizar

```bash
# En el directorio del proyecto: backup de BD obligatorio + build + redeploy
bash update.sh
```

> Más opciones (dry-run, no-interactivo, tarball, TLS con Caddy/Nginx):
> [`docs/INSTALACION.md`](docs/INSTALACION.md). Detalles técnicos:
> [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

---

## Stack

- Node.js 20 + Express 4 + PostgreSQL 16 (pg directo, SQL parametrizado).
- EJS (server-side rendering, sin build de frontend).
- Vanilla JS/CSS en el cliente. bcryptjs (hash de OTP). Nodemailer (SMTP). dotenv (config).
- Sesiones server-side (tabla `sessions`), token opaco en cookie `HttpOnly`, `SameSite=Strict`, `Secure` en producción.
- Tests con **vitest** (sin PostgreSQL real; se inyecta un cliente DB mock).

---

## Requisitos

- **Docker** y **Docker Compose** (versión con soporte de `depends_on: condition: service_healthy`).
- Acceso a la red interna / VPN / Zero-Trust de tu empresa para alcanzar el portal.
- Opcional: un **SMTP** corporativo o relay para el envío real de códigos (ver sección "Configurar SMTP real").

---

## Primeros pasos en 5 minutos

> ⚠️ **PRUEBA LOCAL ≠ PRODUCCIÓN.** Los pasos de esta sección usan valores de
> ejemplo (`MAIL_DRIVER=log`, `NODE_ENV=development`, `ENABLE_DEV_CODE=true`)
> que son **SOLO para pruebas locales**. **No despliegues así en producción** ni
> expongas el puerto 3000 a Internet. Consulta la sección [Producción](#producción).

```bash
# 1. Clona el repositorio
git clone <url-de-tu-repo> && cd SM-HomePage

# 2. Prepara la configuración a partir de la plantilla
cp .env.example .env

# 3. Rellena SOLO estos 5 valores en .env:
#    PORT=3000
#    SESSION_SECRET=<openssl rand -hex 32>     <- clave secreta de sesión
#    SUPER_ADMIN_EMAIL=admin@tu-dominio.com    <- única vía de bootstrap del super_admin
#    ALLOWED_DOMAINS=tu-dominio.com            <- dominios de correo permitidos
#    POSTGRES_PASSWORD=<una-contrasena-fuerte> <- define PostgreSQL (no uses el default)

# 4. Arranca el stack
docker compose up --build
```

1. Abre **http://localhost:3000**.
2. Introduce tu correo y pulsa "Enviar código".
3. Mira el código en los logs del contenedor web:

   ```bash
   docker compose logs web        # buscar "Código OTP para admin@tu-dominio.com: 123456"
   ```

4. Introduce el código y accede. El **super_admin se crea SOLO si el email es
   `SUPER_ADMIN_EMAIL`** (bootstrap). Si configuras `BOOTSTRAP_CODE`, el primer
   login de ese email exige además presentarlo en el paso "Primer inicio"
   (single-use).
5. Ya en la consola admin:
   - Crea **grupos** (ej. `dev`, `finanzas`).
   - Crea **aplicaciones** (públicas o restringidas; para las restringidas asigna grupos).
   - Crea usuarios y asígnales grupos. **Solo el super_admin puede crear o
     promover admins**; un admin (RRHH) crea/edita employees y asignaciones.
   - Vuelve a probar el dashboard con un usuario con/sin grupos para ver la visibilidad.

> En modo dev (`NODE_ENV=development` + `MAIL_DRIVER=log` + `ENABLE_DEV_CODE=true`)
> la API responde además el campo `dev_code` con el código para automatizar
> pruebas, y si el email es el `SUPER_ADMIN_EMAIL` con `BOOTSTRAP_CODE`
> configurado, también incluye `bootstrap_code` para completar el flujo.
>
> ⚠️ **Advertencia explícita**: estos valores (`MAIL_DRIVER=log`,
> `NODE_ENV=development`, `dev_code`) son SOLO para pruebas locales. En
> producción la app **no arranca** con `MAIL_DRIVER=log` (fail-fast), el
> `dev_code` nunca se expone y el puerto no debe quedar abierto a Internet.

---

## Bootstrap del super_admin (P2)

La **única** vía para crear el primer `super_admin` es un login con el email
`SUPER_ADMIN_EMAIL`. Ya **no** existe "primer usuario de la tabla" ni "si no
hay ningún super_admin, cualquier email permitido se autopromociona": un email
distinto a `SUPER_ADMIN_EMAIL` siempre nace `employee`.

- **Con `BOOTSTRAP_CODE` (recomendado)**: tras `bash deploy.sh`, el asistente
  muestra **una única vez** un **código de 6 dígitos** (`BOOTSTRAP_CODE`,
  single-use). En el **primer login** el super_admin introduce su email y, en
  el paso **"Primer inicio"**, escribe ese código (se consume al usarse). El
  código se genera automáticamente con `deploy.sh` (siempre en modo rápido; a
  petición en modo personalizado) y **tiene prioridad** sobre `BOOTSTRAP_TOKEN`.
  Ejemplo: `483912`.
- **Sin código**: `SUPER_ADMIN_EMAIL=admin@tu-dominio.com` → ese email obtiene
  `super_admin` en su primer login, directamente.
- **Retrocompatibilidad (`BOOTSTRAP_TOKEN`)**: si defines `BOOTSTRAP_TOKEN=<secreto>`
  (`openssl rand -hex 32`) en lugar de `BOOTSTRAP_CODE`, el campo sigue
  funcionando: el primer login de `SUPER_ADMIN_EMAIL` exige presentar el token
  hex en el input **"Token de arranque (primera activación del administrador)"**
  (también puede enviarse como campo `bootstrap_token` del verify, o
  `POST /auth/verify`). Es **single-use**: se consume al aplicarse con éxito.
  Si ambos están definidos, `BOOTSTRAP_CODE` tiene prioridad.
- **Sin credencial de arranque**: si no defines ni `BOOTSTRAP_CODE` ni
  `BOOTSTRAP_TOKEN`, el bootstrap ocurre solo con `SUPER_ADMIN_EMAIL` (el
  primer login del admin crea el super_admin sin código ni token). Es lo más
  simple y sin fricción.
- En dev, si `ENABLE_DEV_CODE=true`, la respuesta de `/auth/request` para el
  email del super_admin incluye `bootstrap_code` (o `bootstrap_token` si solo
  está definido el token) para completar la prueba.
- En producción, `SUPER_ADMIN_EMAIL` es **obligatorio** (fail-fast si falta).

Si no defines `SUPER_ADMIN_EMAIL`, el primer login crea un `employee` (no hay
super_admin autopromocionado) — útil para entornos de prueba.

### Usuario inicial (seed idempotente)

Al **primer arranque** con una base de datos **vacía**, la app crea
automáticamente el usuario de `SUPER_ADMIN_EMAIL` con rol `super_admin`
(estado activo). El seed es idempotente y seguro:

- Solo actúa si la tabla `users` está **vacía**. Si la BD ya tiene usuarios,
  **nunca** se auto-crea un super_admin (evita auto-super-admin en BD poblada).
- Usa `ON CONFLICT DO NOTHING`: nunca modifica roles ni datos existentes.
- Si en la BD no hay `allowed_domains` configurado y `ALLOWED_EMAIL_DOMAINS`
  está vacío, el dominio de `SUPER_ADMIN_EMAIL` se añade a `allowed_domains`
  (garantiza que el super_admin pueda iniciar sesión).

```env
# Ejemplo (sustituye por tu dominio corporativo):
SUPER_ADMIN_EMAIL=admin@tu-dominio.com
ALLOWED_EMAIL_DOMAINS=tu-dominio.com
```

> El primer login de ese usuario sigue el flujo bootstrap normal (si defines
> `BOOTSTRAP_CODE`, lo exigirá en el paso "Primer inicio"; `BOOTSTRAP_TOKEN`
> funciona igual por retrocompatibilidad).

---

## Configurar SMTP real

Cuando quieras enviar correos de verdad:

1. En `.env`, cambia `MAIL_DRIVER=smtp` y rellena:

   ```env
   MAIL_DRIVER=smtp
   SMTP_HOST=smtp.tu-dominio.com
   SMTP_PORT=587
   SMTP_USER=no-reply@tu-dominio.com
   SMTP_PASS=la-contrasena
   SMTP_FROM="SM-HomePage <no-reply@tu-dominio.com>"
   ```

2. Reinicia: `docker compose up -d --build`.

> ⚠️ `MAIL_DRIVER=log` está **prohibido** en producción: la app **no arranca**
> (fail-fast). Imprime los códigos en la consola; úsalo solo en dev.

---

## SendGrid vía SMTP (R1)

`MAIL_DRIVER=sendgrid` usa el transporte SMTP de Nodemailer contra SendGrid
(sin dependencia nueva): `smtp.sendgrid.net:587`, auth `user=apikey`,
`pass=SENDGRID_API_KEY`.

```env
MAIL_DRIVER=sendgrid
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MAIL_FROM=no-reply@tu-dominio.com
```

**Checklist para SendGrid real:**

1. En **Settings → Sender Authentication** verifica el **dominio remitente**
   (`tu-dominio.com`) con los registros DNS que pide SendGrid:
   - 3 registros `CNAME` (clic.verify, link, email) — o `SPF`+`DKIM` si
     prefieres autenticación sin CNAME.
   - Estado **Verified** en el dashboard.
2. Crea una **API Key** en **Settings → API Keys** con permisos de
   *Mail Send* y pégala en `SENDGRID_API_KEY` (solo env; nunca en la BD).
3. Confirma que `MAIL_FROM` (o `settings.mail_from` si lo editas por consola)
   usa un dominio verificado.
4. Reinicia: `docker compose up -d --build`.

**Fail-fast**: si `MAIL_DRIVER=sendgrid` sin `SENDGRID_API_KEY`, la app **no
arranca**. En desarrollo sigue funcionando `MAIL_DRIVER=log` (el código se
imprime en consola y la API devuelve `dev_code`).

**Fall-soft en runtime**: si el envío del código OTP falla tras 2 reintentos
(backoff 500 ms/1 s), el código se invalida (single-active), se registra
`mail.send_failed` en auditoría y la app responde el mismo 200 genérico
(anti-enumeración) sin caerse. El transporte SMTP/SendGrid lleva throttling
(10 correos/segundo) para no agotar la cuota.

---

## Configuración del portal en runtime (R5)

Además de las variables de entorno, la configuración se puede editar en
**`/admin/settings`** (solo `super_admin`). Los valores guardados en la tabla
`settings` tienen **precedencia sobre env** y se aplican **en runtime sin
reiniciar** (caché de lectura de 30 s).

| Clave (settings) | Env de fallback | Descripción |
|---|---|---|
| `allowed_domains` | `ALLOWED_EMAIL_DOMAINS` \|\| `ALLOWED_DOMAINS` | Dominios de correo permitidos para login y creación de usuarios |
| `site_name` | `SITE_NAME` | Nombre del portal (header, títulos) |
| `mail_from` | `MAIL_FROM` | Remitente de los correos OTP |
| `default_theme` | `DEFAULT_THEME` | Tema inicial: `light` \| `dark` \| `system` |
| `logo_version` | (interno) | Contador de cache-busting del logo (`/logo?v=n`) |

Consideraciones:

- **Solo `super_admin`** puede editar settings y el logo. Cada cambio se
  audita (`settings.update`, `settings.seed`, `logo.upload`).
- **Nunca se guardan secretos** en `settings` (solo personalización).
- **Anti-lockout**: si al editar quitas un dominio que tiene usuarios activos,
  la UI muestra cuántos y exige marcar una casilla de confirmación.
- La creación de usuarios desde `/admin/users` **rechaza emails cuyo dominio no
  esté** en `allowed_domains` (mismo criterio que el login OTP).

---

## Logo de la empresa (R2)

Solo `super_admin`, desde **`/admin/settings`** → bloque "Logo de la empresa".

- Formatos: **PNG o JPEG** (validados por **magic bytes**, nunca por la
  extensión; se rechaza SVG y cualquier otro). Máximo **2 MB** y **2048 px**
  por lado.
- El archivo se guarda con **nombre fijo del servidor** (`logo.png`/`logo.jpg`)
  en el **volumen `uploads`** montado en `/app/public/uploads` (persistente
  entre rebuilds) → imposible path traversal.
- Se sirve por `GET /logo` (público, misma origin) con `Cache-Control:
  public, max-age=31536000, immutable` y **cache-busting** `?v=<logo_version>`
  en todas las referencias (header, login, favicon). La URL directa
  `/uploads/logo.<png|jpg>` también es **pública** (marca del portal; U-4). Sin
  logo subido, se sirve el logo por defecto.
- Cada subida se audita (`logo.upload`) e incrementa `logo_version`.

> Los **iconos personalizados de apps** se guardan en la subcarpeta
> `app-icons/` del mismo volumen y se sirven en `/uploads/app-icons/` **con
> control de acceso** (U-4): el de una app `restricted` solo lo ven sesiones
> con acceso a esa app; el anónimo recibe 403. El logo, en cambio, es público
> por diseño.

---

## Tema claro / oscuro (R3)

Tres estados: **claro**, **oscuro** y **sistema** (por defecto).

- Persistencia en `localStorage` (`cp-theme`). El valor inicial respeta
  `default_theme` de settings/env.
- Un script externo (`/js/theme.js`) en `<head>` fija `data-theme` **antes del
  primer paint** (sin FOUC). Sin scripts inline (CSP).
- El botón del encabezado (disponible en dashboard, admin y login) **cicla**
  claro → oscuro → sistema. Los dos temas cumplen contraste AA.
- Sin JS, un `@media (prefers-color-scheme)` decide como fallback.

---

## Filtro de grupos en el dashboard (R4)

En el dashboard **autenticado**, debajo del buscador aparecen **chips** con los
grupos del usuario (el anónimo no los ve). El filtro es **AND** con el texto
del buscador: solo se muestran las apps que pertenecen al grupo elegido **y**
cuyo nombre/descripción/categoría contiene el texto. Las categorías sin
resultados se ocultan y el contador por categoría se actualiza. Con un filtro
que no deja nada, se muestra un estado vacío con CTA para limpiar. Los chips
son `<button>` accesibles (`aria-pressed`, foco visible).

---

## Cookie `Secure` en HTTP interno (P3)

Por defecto las cookies (`sid` y `_csrf`) llevan `Secure=true` en producción.
Si el portal se sirve por **HTTP plano** dentro de la red interna / VPN (el
borde no termina TLS), el navegador descartaría esas cookies. Para ese caso
puntual:

```env
COOKIE_SECURE=false
```

> ⚠️ Solo si el borde de la red interna / VPN NO termina TLS. **Recomendación**:
> terminar TLS en el borde (o poner un reverse proxy TLS antes de la app) y
> dejar `Secure=true`.

---

## Producción

Despliegue recomendado de un entorno de producción:

1. **TLS en el borde**: sitúa la app detrás de un reverse proxy (nginx,
   Traefik, Caddy…) que termine TLS. Deja `COOKIE_SECURE=true` (el default) y
   **no expongas el puerto 3000 directamente a Internet**: en `docker-compose`
   el bind es parametrizable con `BIND_ADDR` (default `127.0.0.1`). El
   asistente escribe `BIND_ADDR=0.0.0.0` cuando la URL pública es de red
   interna (RFC1918, dominio) — entonces el puerto se publica en la intranet y
   un proxy/Caddy en **otra máquina** puede enrutar hacia él; escribe
   `127.0.0.1` cuando la URL es `localhost` (solo local).
2. **Correo real**: usa `MAIL_DRIVER=smtp` (o `sendgrid`) con `MAIL_FROM`
   definido y un dominio remitente verificado. Nunca `MAIL_DRIVER=log`.
3. **Variables críticas**: define `SESSION_SECRET` (largo y aleatorio),
   `SUPER_ADMIN_EMAIL` (obligatorio), `ALLOWED_EMAIL_DOMAINS` y
   `POSTGRES_PASSWORD` (sin default). `BOOTSTRAP_CODE` (o `BOOTSTRAP_TOKEN`
   por retrocompat) es recomendable.
   Si el portal se expone a Internet, **activa los interruptores de
   endurecimiento**: `ANONYMOUS_MODE=off` (dashboard solo-autenticado) y
   `TRUST_PROXY=1` (hay un reverse proxy de confianza delante; así el rate
   limiting por IP del brute-force OTP ve la IP real del cliente).
4. **Seguridad**: la app trae por defecto CSP estricta, cookies
   `HttpOnly`/`SameSite=Strict`, rate limiting por IP real, CSRF en todos los
   formularios, RBAC en backend, queries parametrizadas, logo validado por
   magic bytes, iconos de apps `restricted` con control de acceso (U-4) y cero
   SSRF. Mantén la imagen actualizada (`docker compose build --pull`) y la BD
   en un volumen persistente.
5. **Backups**: realiza copias periódicas del volumen `pgdata` (o con
   `pg_dump`). El proyecto no incluye servicio de backups.

---

## ¿En qué se diferencia de Heimdall?

SM-HomePage está inspirado en **Heimdall** (portal de enlaces estilo dashboard),
pero se orienta a un **portal corporativo de acceso** con una capa de seguridad
y gobernanza mayor:

| Capacidad | Heimdall | SM-HomePage |
|---|---|---|
| Gestión de apps y enlaces | ✔ | ✔ |
| Búsqueda *spotlight* | ✔ | ✔ |
| **Autenticación OTP por email** | ✖ | ✔ (código 6 dígitos, single-use) |
| **Sesiones server-side revocables** | ✖ | ✔ (30 días, rotación deslizante, revocación por `session_version`) |
| **RBAC (super_admin / admin / employee)** | limitado | ✔ (grupos y asignaciones por grupo) |
| **Visibilidad por grupos** | ✖ | ✔ (cada empleado ve solo sus apps) |
| **Bootstrap seguro del primer admin** | ✖ | ✔ (`SUPER_ADMIN_EMAIL` + `BOOTSTRAP_CODE` de 6 dígitos single-use) |
| **Anti-enumeración de emails** | ✖ | ✔ (misma respuesta 200 genérica) |
| **Logo por magic bytes + cache-busting** | ✖ | ✔ |
| **Auditoría append-only** | ✖ | ✔ (tabla `audit_log`) |

Si solo quieres un dashboard de enlaces para tu equipo, Heimdall te vale. Si
necesitas un **portal de acceso con login OTP, control de acceso por grupos,
sesiones seguras y auditoría**, SM-HomePage aporta esa capa sin añadir un
frontend build (EJS SSR).

---

## Variables de entorno (`.env`)

Todas están documentadas (en español) en `.env.example`. Las críticas son:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión a PostgreSQL. En compose se inyecta automáticamente. |
| `SESSION_SECRET` | Clave para firmar cookies. Generar con `openssl rand -hex 32`. |
| `ALLOWED_DOMAINS` | Dominios de correo permitidos, separados por coma (`miempresa.com,otra.com`). En dev, si está vacío, se permite `localhost`. |
| `SUPER_ADMIN_EMAIL` | Email que obtiene rol `super_admin` al entrar. **ÚNICA vía de bootstrap**. Obligatorio en producción. |
| `BOOTSTRAP_CODE` | Código de **6 dígitos** de primer inicio, **single-use**, generado automáticamente por `deploy.sh` (Asistente v2). **Prioridad sobre `BOOTSTRAP_TOKEN`**. Solo se exige en la primera activación del super_admin (ver sección Bootstrap). |
| `BOOTSTRAP_TOKEN` | Token hex opcional single-use (retrocompat): si no hay `BOOTSTRAP_CODE`, el primer login del super_admin exige este token (ver sección Bootstrap). |
| `NODE_ENV` | `development` (permite `dev_code`, cookie sin `Secure`, `MAIL_DRIVER=log`) o `production` (fail-fast si `MAIL_DRIVER=log`). |
| `MAIL_DRIVER` | `log` (solo pruebas/dev), `smtp` (SMTP corporativo) o `sendgrid` (SendGrid vía SMTP). |
| `SENDGRID_API_KEY` | Obligatoria si `MAIL_DRIVER=sendgrid` (fail-fast si falta). Nunca en la BD. |
| `MAIL_FROM` | Remitente por defecto de los correos OTP (settings `mail_from` tiene precedencia). |
| `SITE_NAME` | Nombre del sitio (settings `site_name` tiene precedencia). |
| `DEFAULT_THEME` | Tema inicial: `light` \| `dark` \| `system` (settings `default_theme` tiene precedencia). |
| `ALLOWED_EMAIL_DOMAINS` | Alias nuevo de la allow-list de dominios; si existe, tiene prioridad sobre `ALLOWED_DOMAINS`. |
| `POSTGRES_PASSWORD` | Contraseña del usuario de PostgreSQL. **Obligatoria** (sin default): `docker-compose` falla si no la defines. |
| `PORT` | Puerto HTTP donde escucha la app (por defecto 3000). En compose el bind es parametrizable con `BIND_ADDR` (default `127.0.0.1`; `0.0.0.0` publica en la red interna). |
| `BIND_ADDR` | Dirección de bind del puerto en `docker-compose` (default `127.0.0.1` = solo loopback). `0.0.0.0` publica en la red interna (intranet/VLAN/proxy remoto en otra máquina). Lo deriva y escribe `deploy.sh` (detección solo-loopback) y `update.sh`; **la app no la lee**. |
| `ANONYMOUS_MODE` | Modo anónimo del dashboard. Default `ON` (las apps públicas se ven sin sesión). `ANONYMOUS_MODE=off` lo desactiva: GET `/` sin sesión redirige a `/login`. **Recomendado `off`** en despliegues solo-autenticados expuestos a Internet con TLS. |
| `TRUST_PROXY` | Hops de reverse proxy de confianza (Caddy/Nginx) para el rate limiting y la auditoría. `0` (default) = red interna directa / red privada (VPN): `req.ip` es la IP real y un `X-Forwarded-For` forjado no altera nada. `1` = detrás de un proxy de confianza con TLS (entonces `X-Forwarded-For` es fiable). NUNCA activar sin proxy delante. |

Opcionales: `SESSION_DAYS` (30), `SESSION_ROTATE_DAYS` (7),
`REVOKE_ALL_ON_LOGIN` (false), `OTP_TTL_MIN` (10), `ENABLE_DEV_CODE` (true solo
en dev), `COOKIE_SECURE` (ver sección P3), `SMTP_HOST` / `SMTP_PORT` /
`SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`, `PORTAL_BG_COLOR`, `PORTAL_BG_IMAGE`,
`UPLOADS_DIR` (ruta de uploads: logo en la raíz y iconos de apps en
`app-icons/`; en docker el volumen `uploads` se monta en
`/app/public/uploads`), `POSTGRES_DB`, `POSTGRES_USER`.

El arranque **falla** con un mensaje claro si faltan `DATABASE_URL` o
`SESSION_SECRET`, si en producción falta `SUPER_ADMIN_EMAIL`, si se usa
`MAIL_DRIVER=log` en producción, si `MAIL_DRIVER=sendgrid` sin
`SENDGRID_API_KEY`, si hay `BOOTSTRAP_CODE` (6 dígitos) o `BOOTSTRAP_TOKEN` sin
`SUPER_ADMIN_EMAIL`, o si el
`allowed_domains` **efectivo** (BD con precedencia sobre env) excluye el dominio
de `SUPER_ADMIN_EMAIL` (fail-fast anti-lockout F-R5-1: evita que el admin nunca
pueda iniciar sesión).

---

## Notas de seguridad

- **Autenticación de único factor**: código OTP de 6 dígitos por email, TTL 10 min, hash bcrypt (cost 10), comparación en tiempo constante, **single-use atómico** y una sola solicitud activa por email. Máximo 3 solicitudes de código por email cada 5 min; 5 fallos de verificación bloquean el email con **backoff exponencial**: 1er lockout 5 min, 2º 15 min, 3º 30 min (techo).
- **Sesiones de 30 días**: token opaco (32 bytes aleatorios) guardado como SHA-256 en `sessions`; cookie `HttpOnly`, `SameSite=Strict`, `Secure` en producción (configurable con `COOKIE_SECURE` para HTTP interno).
- **Rotación deslizante (F5)**: cada 7 días (`SESSION_ROTATE_DAYS`) la sesión se rota: token nuevo, se revoca el anterior y se emite una `Set-Cookie` nueva. Así un token robado caduca.
- **Revocación server-side + `session_version`**: desactivar un usuario o cambiar su rol incrementa `session_version` y **mata todas sus sesiones**; el logout (POST + CSRF) revoca la sesión actual. Opcionalmente, `REVOKE_ALL_ON_LOGIN=true` revoca las sesiones previas en cada login (trade-off: rompe multi-dispositivo).
- **Anti-enumeración**: `POST /auth/request` responde el mismo 200 genérico tanto para dominios permitidos como no permitidos; el código solo se genera server-side para dominios permitidos. El `dev_code` nunca se expone en producción.
- **Bootstrap del super_admin**: solo `SUPER_ADMIN_EMAIL`, con `BOOTSTRAP_CODE`
  (6 dígitos, single-use) recomendado; `BOOTSTRAP_TOKEN` hex sigue soportado
  (retrocompat). Sin "primer usuario" ni autopromociones.
- **RBAC en backend**: `super_admin` (todo), `admin` (usuarios/employees y asignaciones, sin apps ni auditoría ni grupos de escritura, **sin crear/promover admins**), `employee` (solo dashboard). Nadie puede desactivar ni cambiar el rol del **último super_admin activo**.
- **Cero SSRF**: el servidor nunca hace peticiones a URLs de apps ni de iconos; el navegador carga los iconos directamente. Las URLs de apps e iconos se validan con esquema `http/https` al crearlas/editarlas.
- **Rate limiting por IP real**: por defecto NO se configura `trust proxy` (la app corre dentro de la red interna / VPN, overlay L3, sin proxy de confianza); un `X-Forwarded-For` forjado no altera `req.ip`. El limitador de `/auth/verify` limita por `IP+email`. Si el portal se despliega tras un reverse proxy de confianza (Caddy/Nginx con TLS), define `TRUST_PROXY=1` para que el rate limiting (brute-force OTP) y la auditoría vean la IP real del cliente y no la del proxy.
- **Iconos de apps con control de acceso (U-4)**: los iconos subidos viven en `uploads/app-icons/` y se sirven desde `/uploads/app-icons/app-icon-<id>.<ext>` con verificación de acceso: una app `public` se sirve a cualquiera; una app `restricted` SOLO a sesión válida con acceso a esa app (grupo asignado; `super_admin`/`admin` siempre). Anónimo o sin acceso -> `403`; nombre inválido o app inexistente -> `404` (el nombre se valida por regex, sin path traversal). El **logo** (`/uploads/logo.*`) sigue siendo **público** (es la marca del portal), igual que la ruta `/logo` con cache-busting.
- **Modo anónimo configurable**: el dashboard sin sesión muestra solo apps públicas; por defecto está ACTIVO (compatibilidad). `ANONYMOUS_MODE=off` lo desactiva (GET `/` redirige a `/login`) para despliegues solo-autenticados. En cualquier caso, los nombres/URLs de apps `restricted` nunca se revelan al anónimo.
- **Queries parametrizadas** siempre (pg `$1`, `$2`…). EJS escapa por defecto (`<%= %>`).
- **CSRF** en todos los formularios (cookie + campo oculto; en las subidas
  multipart el token se acepta también en la query/header) y **CSP** estricta
  (`default-src 'self'`, sin scripts inline; `img-src` permite `http:` para
  iconos de apps internas tras la red interna / VPN). Las URLs internas de las
  apps aparecen como `href` en el DOM (política D5 aceptada por el negocio).
- **Purga diaria** (job en `index.js`): borra OTPs expirados/consumidos, `login_attempts` >7 días y sesiones revocadas/expiradas >7 días (queries parametrizadas).
- **Settings en runtime**: tabla `settings` key/value con precedencia sobre env y caché de lectura de 30 s. Cada cambio se audita (`settings.update`, `settings.seed`). Nunca guarda secretos.
- **Logo por magic bytes**: solo PNG/JPEG reales, ≤2 MB y ≤2048 px, nombre de archivo fijado por el servidor (sin path traversal), servido con cache-busting `?v=`.

---

## Desarrollo y tests

```bash
cd server
npm install
npm test            # vitest: config, otp, visibility, session, rbac, bootstrap,
                    # integración HTTP, settings, sendgrid, mail-failure,
                    # logo, tema y chips (DB mock, sin PostgreSQL)
npm run dev         # arranque local con --watch (necesita PostgreSQL)
```

Para probar el flujo completo en local sin SMTP:

```bash
# 1. Levantar PostgreSQL (ej. Docker):
docker run -d --name pg-dev -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=corphomepage -p 5437:5432 postgres:16-alpine

# 2. Arrancar el servidor (PRUEBA LOCAL):
NODE_ENV=development MAIL_DRIVER=log ENABLE_DEV_CODE=true \
ALLOWED_DOMAINS=localhost SUPER_ADMIN_EMAIL=admin@localhost \
DATABASE_URL=postgres://postgres:postgres@localhost:5437/corphomepage \
SESSION_SECRET=dev-secret PORT=3000 node src/index.js

# 3. Flujo con curl (usando un cookie jar para CSRF/sesión):
curl -c /tmp/jar.txt http://localhost:3000/login
CSRF=$(awk '/_csrf/{print $NF}' /tmp/jar.txt)
curl -b /tmp/jar.txt -c /tmp/jar.txt -X POST http://localhost:3000/auth/request \
  --data-urlencode "email=admin@localhost" --data-urlencode "_csrf=$CSRF"
#   -> dev_code en la respuesta (y bootstrap_code si aplica)
curl -b /tmp/jar.txt -c /tmp/jar.txt -X POST http://localhost:3000/auth/verify \
  --data-urlencode "email=admin@localhost" --data-urlencode "code=DEV_CODE" \
  --data-urlencode "bootstrap_code=BOOTSTRAP_CODE" --data-urlencode "_csrf=$CSRF"
curl -b /tmp/jar.txt http://localhost:3000/   # dashboard 200
# Logout (POST + CSRF):
curl -b /tmp/jar.txt -c /tmp/jar.txt -X POST http://localhost:3000/auth/logout \
  --data-urlencode "_csrf=$CSRF"
```

> Si `BOOTSTRAP_CODE` está definido, `/auth/request` en dev devuelve también
> `bootstrap_code`; en producción se pasa como campo `bootstrap_code` del
> verify (o por la API). Con `BOOTSTRAP_TOKEN` (retrocompat) el campo es
> `bootstrap_token`. Un dominio no permitido recibe el mismo 200 genérico.

---

## Estructura

```
.
├── docker-compose.yml
├── .env.example
└── server/
    ├── Dockerfile
    ├── THIRD_PARTY_NOTICES
    ├── src/
    │   ├── index.js / app.js / config.js / db.js / schema.sql
    │   ├── middleware/ (auth, rbac, security)
    │   ├── services/  (otp, session, bootstrap, mail, audit, visibility, settings, logo)
    │   ├── routes/    (auth, dashboard, admin.*)
    │   ├── views/     (layouts, auth, dashboard, admin, errors)
    │   └── public/    (css, js/theme.js, js/spotlight.js, js/login.js, js/admin.js)
    └── test/          (config, otp, visibility, session, rbac, bootstrap, settings,
                        sendgrid, mail-failure, logo, theme, chips, integración HTTP)
```

La auditoría (`audit_log`) es **append-only**: solo lectura para `super_admin` en `/admin/audit`.

---

## Licencia

**Código del proyecto**: distribuido bajo la licencia **MIT** — consulta
`LICENSE` en la raíz del repositorio.

**Iconos de la biblioteca local** (`server/src/public/icons/`): copia local de
PNG de [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
distribuidos bajo la licencia **Apache-2.0**. Ver `server/THIRD_PARTY_NOTICES`
para la atribución completa y el texto de la licencia.

---

## Créditos / Atribución

**SM-HomePage** es desarrollado y mantenido por **SmoothCloud LLC**.

- El proyecto está inspirado en **Heimdall** (portal de enlaces estilo
  dashboard), aunque no comparte código con él.
- Los iconos de la biblioteca local
  (`server/src/public/icons/`) provienen de
  [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
  y se distribuyen bajo la licencia **Apache-2.0** (ver
  `server/THIRD_PARTY_NOTICES`).
