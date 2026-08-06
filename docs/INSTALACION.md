# Instalación de SM-HomePage

Guía para desplegar **SM-HomePage** en un servidor Ubuntu 22.04/24.04 o
Debian 12 con Docker. Hay dos flujos: **asistente interactivo** (recomendado)
y **despliegue no interactivo** (scripts/CI).

---

## 1. Requisitos previos

- Servidor **Ubuntu 22.04/24.04** o **Debian 12** (x86_64/arm64).
- Acceso a Internet para descargar imágenes Docker.
- Acceso a la red interna / VPN de tu organización para alcanzar el portal.
- Opcional pero recomendado: un **dominio + DNS** apuntando al servidor y un
  **reverse proxy con TLS** (Caddy/Nginx/Traefik) delante.

El asistente comprueba e instala automáticamente **Docker Engine** y el plugin
**Docker Compose** si no están presentes (requiere `sudo` no-interactivo o
ejecutar como root).

## 2. Descargar el código

```bash
# Opción A — git
git clone <url-de-tu-repo> && cd SM-HomePage

# Opción B — tarball
# Descomprime la release en una carpeta y entra en ella
```

## 3. Instalación con el asistente (`deploy.sh`)

```bash
bash deploy.sh
```

El asistente hace lo siguiente:

### Fase 0 — Prechecks (no modifica nada)
- Verifica el SO y las dependencias (`curl`, `openssl`, `git` opcional).
- Verifica **Docker + Docker Compose**; si faltan, pregunta si desea
  instalarlos vía `apt-get` o con el script oficial de Docker.
- Comprueba que el puerto HTTP elegido esté libre.
- Si ya existe un `.env`, aborta salvo que uses `--force-regenerate`.

### Fase 1 — Preguntas guiadas
El asistente arranca preguntando el **modo de instalación**: **rápido** aplica
defaults seguros y solo pide lo esencial; **personalizado** pregunta cada
opción. Cada pregunta muestra el valor por defecto entre corchetes; pulsa
**Enter** para aceptarlo. Las respuestas se validan y se re-preguntan si son
inválidas:

| Pregunta | Default | Notas |
|---|---|---|
| Modo de instalación | `rapido` | **rápido** aplica defaults seguros (puerto 3000, anónimo `on`, `TRUST_PROXY` coherente con la URL, dominios = dominio del admin, código de arranque siempre generado); **personalizado** pregunta cada opción |
| URL pública del portal | `http://localhost` | `https://…` deriva `COOKIE_SECURE=true`; `http://…` advierte (cookies sin Secure) y deriva `false` |
| Nombre de la empresa/portal | `SM-HomePage` | 1-60 caracteres |
| Email del super_admin | — | **obligatorio**; única vía de bootstrap |
| ¿Enviarás correos con SendGrid usando una API Key? | `no` | **sí** → driver `sendgrid`: solo pegar la **API Key** (formato `SG.…`); `MAIL_FROM` se deriva a `no-reply@<dominio>` automáticamente. **no** → driver `smtp` (o `log` si localhost); `log` está **prohibido** en producción |
| — SendGrid API Key | — | solo si respondiste **sí**; sanity check del prefijo `SG.` (no bloqueante) |
| — Driver / Host/Puerto/Usuario/Password SMTP | `smtp` (o `log` si localhost) / — / 587 / — / — | solo si respondiste **no** y elegiste `smtp` (password sin eco); camino manual para otros proveedores o relays |
| Remitente (`MAIL_FROM`) | `no-reply@<dominio>` | email válido; en el camino SendGrid se deriva automáticamente |
| Dominios de correo permitidos | dominio del email del admin | separados por coma; solo se pregunta en modo **personalizado** |
| Puerto HTTP | `3000` | solo en modo **personalizado**; 1-65535 y debe estar libre |
| Bind del puerto (`BIND_ADDR`) | derivado de la URL | en modo **personalizado** se pregunta: `0.0.0.0` (accesible desde la red interna — recomendado si hay un proxy/Caddy en otra máquina) o `127.0.0.1` (solo local). En modo **rápido** se deriva automáticamente: URL `localhost`/`127.*` → `127.0.0.1`; cualquier otra (RFC1918, dominio…) → `0.0.0.0` |
| Entorno | `production` (o `development` si localhost) | solo en modo **personalizado**; `development` con URL no-localhost avisa |
| Código de arranque de 6 dígitos (`BOOTSTRAP_CODE`) | `generar` | en modo **rápido** se genera **siempre**; en modo **personalizado** se pregunta `generar`/`no`. Se muestra **una sola vez** al final (single-use). Prioridad sobre `BOOTSTRAP_TOKEN` |
| Modo anónimo | `on` | solo en modo **personalizado**; `on`/`off` |
| TRUST_PROXY | `1` si la URL es https, si no `0` | solo en modo **personalizado**; pon `1` **solo** si hay Caddy/Nginx con TLS delante |

### Fase 2 — Resumen y confirmación
Se muestran todos los valores con los secretos **enmascarados** (`****…`).
Confirma con `sí` o cancela sin haber modificado nada.

### Fase 3 — Generación de `.env`
- `umask 077` + `chmod 600`.
- Genera **`POSTGRES_PASSWORD`** y **`SESSION_SECRET`** aleatorios con
  `openssl rand -hex 32` (nunca se preguntan ni se muestran completos).
- Escribe **`BOOTSTRAP_CODE`** (si se generó) o `BOOTSTRAP_TOKEN` (retrocompat)
  y el resto de variables, incluido `ENABLE_DEV_CODE=false` en producción y
  `OTP_TTL_MIN=10`.

### Fase 4 — Despliegue
1. `docker compose config --quiet` (valida el archivo).
2. `docker compose build --pull`.
3. `docker compose up -d` (sin borrar volúmenes).
4. Espera de salud (hasta 90 s): `db` y `web` en estado `healthy` y
   `GET /login` respondiendo `200`.

Si el build falla no se toca el stack; si `up` falla se hace
`docker compose down` (sin `-v`) y se restaura el `.env` previo si existía.

### Fase 5 — Bootstrap y cierre
Si generaste `BOOTSTRAP_CODE`, se muestra **una única vez** enmarcado:

1. Abre la URL del portal.
2. Introduce el email del `super_admin`.
3. En el primer login, en el paso **"Primer inicio"**, escribe el **código de
   6 dígitos** (es de un solo uso: se consume al aplicarse con éxito).

Por retrocompatibilidad, si en lugar de código definiste `BOOTSTRAP_TOKEN`
(hex), se muestra el token y se pega en el campo **"Token de arranque"**
(mismo comportamiento de un solo uso).

Mensaje final: `SM-HomePage desplegado. Accede a <URL>`.

### Flags del asistente

```bash
bash deploy.sh --dry-run                 # muestra plan y preguntas, no ejecuta nada
bash deploy.sh --force-regenerate        # regenera .env aunque exista (con backup)
bash deploy.sh --non-interactive --env-file ./plantilla.env
```

Modo no interactivo: usa los valores del `--env-file` (o defaults) y **falla
con mensaje claro si faltan valores obligatorios** (p. ej. `SUPER_ADMIN_EMAIL`,
`SMTP_HOST` si el driver es `smtp`, `SENDGRID_API_KEY` si es `sendgrid`).

## 4. Configuración de producción

### TLS en el borde (recomendado)

Expón el portal **solo** a través de un reverse proxy con TLS. El bind del
puerto es parametrizable con `BIND_ADDR` (lo escribe `deploy.sh` según la URL
pública):

- **Proxy en la misma máquina (variante)**: `BIND_ADDR=127.0.0.1` y el proxy
  apunta a `127.0.0.1:3000`.
- **Proxy en otra máquina / intranet (caso real)**: `BIND_ADDR=0.0.0.0` — el
  puerto se publica en la red interna y el proxy remoto apunta a la **IP del
  host** que ejecuta la app (p. ej. `172.16.30.12:3000`).

Ejemplo con **Caddy** (proxy en otra máquina, intranet):

```
portal.miempresa.com {
    reverse_proxy 172.16.30.12:3000
}
```

Variante **Caddy same-host**: `reverse_proxy 127.0.0.1:3000`.

Ejemplo con **Nginx** (variante same-host):

```nginx
server {
    listen 443 ssl;
    server_name portal.miempresa.com;
    ssl_certificate     /etc/letsencrypt/live/portal.miempresa.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.miempresa.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> Si pones el proxy delante, configura `TRUST_PROXY=1` durante el despliegue
> (o edítalo en `.env` y reinicia) para que el rate limiting use la IP real.
> Con URL `https://` el asistente lo activa automáticamente.

### Correo real (SMTP / SendGrid)

- **SendGrid (camino rápido del asistente)**: al responder **sí** a la
  pregunta *"¿Enviarás correos con SendGrid usando una API Key? [sí/no]"*, el
  instalador usa el driver `sendgrid` y solo pide pegar la **API Key**
  (formato `SG.…`). `MAIL_FROM` se deriva automáticamente como
  `no-reply@<dominio>`. Verifica el **dominio remitente** en SendGrid
  (Settings → Sender Authentication): 3 CNAME (o SPF/DKIM) y estado
  *Verified*.
- **SMTP manual**: si respondes **no**, el asistente sigue ofreciendo
  `MAIL_DRIVER=smtp` con `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y
  `MAIL_FROM` de un dominio verificado (útil para otros proveedores o relays
  corporativos).
- La app **no arranca** (`fail-fast`) si `MAIL_DRIVER=log` está en producción
  o si `MAIL_DRIVER=sendgrid` sin `SENDGRID_API_KEY`.

### Backups

El asistente no programa backups automáticos. Realiza copias periódicas del
volumen `pgdata` o usa `pg_dump` (el mismo mecanismo que `update.sh`):

```bash
docker compose exec -T db pg_dump -U corphomepage -d corphomepage | gzip > backups/corphomepage-$(date +%F).sql.gz
```

## 5. Actualización (`update.sh`)

```bash
bash update.sh
```

1. **Prechecks**: `.env` presente, Docker/Compose instalados y directorio
   correcto.
2. **`git pull --ff-only` opcional** (pregunta sí/no). Si instalaste por
   tarball, usa `--source-dir`:
   ```bash
   bash update.sh --source-dir /ruta/al/tarball/nuevo
   ```
3. **Backup de BD obligatorio**: `pg_dump` → `backups/corphomepage-<fecha>.sql.gz`
   (verificado con `gzip -t` y tamaño mínimo). Retención de **5 backups**.
4. `docker compose build --pull` + `docker compose up -d` (sin borrar
   volúmenes; `schema.sql` es idempotente y las migraciones corren al
   arrancar).
5. **Smoke test**: espera `db`/`web` `healthy` y `GET /login` → `200`.
6. Si el smoke falla: **restaura el backup** y avisa.
7. Informe final con versión, backup creado, URL y estado del stack.

## 6. Resolución de problemas

### La app no arranca / el stack no queda sano

```bash
docker compose ps                 # estado de los contenedores
docker compose logs db            # errores de PostgreSQL
docker compose logs web           # errores de la app (fail-fast de env)
```

Causas habituales:

- `MAIL_DRIVER=log` en producción → la app hace **fail-fast**. Cambia a
  `smtp`/`sendgrid`.
- `POSTGRES_PASSWORD` distinta a la de una BD ya inicializada (Postgres solo
  lee el password en el primer init). Ver "Volumen pgdata preexistente".
- Falta `SESSION_SECRET` o `SUPER_ADMIN_EMAIL` en producción → fail-fast.
- `BOOTSTRAP_CODE` inválido (no es un número de 6 dígitos, o es `000000`) o
  sin `SUPER_ADMIN_EMAIL` → fail-fast (igual con `BOOTSTRAP_TOKEN`).
- `SENDGRID_API_KEY` sin verificar el dominio → los correos fallan (la app lo
  audita como `mail.send_failed` y responde igualmente 200).

### Volumen pgdata preexistente

Si ya existía una base de datos y regeneras `.env` con una password nueva,
Postgres **no la aplicará** (solo se lee en el primer init). Opciones:

```bash
# Reutilizar la password anterior (ver .env.backup.*) o cambiarla:
docker compose exec db psql -U corphomepage -d corphomepage \
  -c "ALTER USER corphomepage WITH PASSWORD 'nueva-clave';"
```

### Ver el código OTP en desarrollo

Solo en `NODE_ENV=development` con `MAIL_DRIVER=log`:

```bash
docker compose logs web | grep -i "Código OTP"
```

### Contraseña del puerto ya en uso

Cambia `PORT` en `.env` o elige otro puerto en el asistente. Recuerda que el
bind (`BIND_ADDR`) es `127.0.0.1` solo para localhost (o modo rápido con URL
`localhost`); con `0.0.0.0` el puerto queda publicado en la red interna y el
proxy debe apuntar a la **IP del host** (p. ej. `172.16.30.12:<nuevo-puerto>`).

### Reparar el `.env`

```bash
bash deploy.sh --force-regenerate   # regenera con valores nuevos (backup previo)
```
