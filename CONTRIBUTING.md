# Contribuir a SM-HomePage

¡Gracias por tu interés en contribuir a **SM-HomePage**! 🎉 Este proyecto es
desarrollado por **SmoothCloud LLC** bajo licencia **MIT** y crece gracias a la
comunidad.

Esta guía cubre cómo ejecutar el proyecto en local, cómo reportar problemas,
proponer mejoras y enviar código de forma que el proceso sea fluido para todos.

---

## Ejecutar el proyecto en local

### Opción A — Instalación completa con el asistente (recomendado)

El proyecto incluye un instalador interactivo que pregunta todo, genera el
`.env` y despliega el stack completo con Docker:

```bash
git clone https://github.com/smoothcloudllc/sm-homepage.git && cd sm-homepage
bash deploy.sh
```

El asistente deja el portal **desplegado y arrancado**, muestra **una única
vez** el código de arranque de 6 dígitos (`BOOTSTRAP_CODE`) para el primer
login del `super_admin`. Para actualizar una instalación existente:

```bash
bash update.sh   # backup de BD obligatorio + build + redeploy
```

> Más opciones (dry-run, no interactivo, TLS) en [`docs/INSTALACION.md`](docs/INSTALACION.md).

### Opción B — Modo desarrollo del servidor

Si trabajas sobre el backend y quieres un ciclo de desarrollo rápido con
recarga automática (`node --watch`):

```bash
cd server
npm ci            # instala dependencias fijadas en package-lock.json
npm run dev       # arranca el servidor en modo watch
```

> El modo dev necesita una instancia de **PostgreSQL**. Puedes levantar una de
> prueba con Docker y apuntar `DATABASE_URL` a ella (ver sección "Desarrollo y
> tests" del `README.md`).

### Opción C — Stack completo en Docker Compose (prueba local)

```bash
cp .env.example .env   # rellena los 5 valores críticos (ver README.md)
docker compose up --build
```

Consulta el [`README.md`](README.md) para el arranque completo, los valores
críticos de `.env` y el flujo de primer inicio.

---

## Reportar bugs y proponer features

Usa **issues** en este repositorio. Antes de abrir una, busca si ya existe una
issue abierta parecida para evitar duplicados.

### Plantilla sugerida para bugs

- **Contexto**: qué estabas haciendo y en qué entorno (OS, versión de Docker,
  rama/tag).
- **Pasos para reproducir**: mínimo y concreto.
- **Comportamiento esperado**: qué debería pasar.
- **Comportamiento real**: qué pasó en su lugar (incluye el mensaje de error,
  nunca secretos ni logs con datos sensibles).

### Plantilla sugerida para features

- **Propuesta**: qué quieres conseguir, en una o dos frases.
- **Motivación**: por qué es útil y para quién.
- (Opcional) **Esbozo de solución**: cómo lo abordarías.

### Vulnerabilidades de seguridad

**No abras issues públicas de seguridad.** Sigue el flujo privado descrito en
[`SECURITY.md`](SECURITY.md) (Security Advisories / reporte privado).

---

## Enviar un Pull Request

1. **Fork** del repositorio y clona tu fork.
2. Crea una **rama descriptiva** desde `main`:
   ```bash
   git checkout -b feat/mejora-descriptiva
   ```
   Prefijos sugeridos: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
3. Haz tus cambios en **commits pequeños y atómicos** con mensajes de commit
   **convencionales**:
   ```
   feat: add optional mail test at end of installer
   fix: correct OTP retry backoff
   docs: clarify bootstrap flow
   ```
   Usa el mismo estilo que el historial del repo (tipos `feat`/`fix`/`chore`/
   `docs`/`refactor`).
4. **Verifica antes de abrir el PR**:
   ```bash
   cd server
   npm test          # vitest — todos los tests deben quedar en verde
   bash -n deploy.sh # si tocas el instalador, solo valida la sintaxis
   ```
5. **No incluyas secretos.** `.env`, claves, certs y logs están en `.gitignore`;
   jamás fuerces un archivo ignorado ni pegues tokens/API keys en el código, el
   mensaje de commit o la descripción del PR.
6. Abre el **PR contra `main`** de `smoothcloudllc/sm-homepage` con una
   descripción clara: qué cambia, por qué, y qué has probado.

### Checklist del PR

- [ ] `npm test` en verde.
- [ ] `bash -n deploy.sh` correcto si se tocó el instalador.
- [ ] Sin secretos ni archivos locales (`node_modules`, `.env`, logs, uploads).
- [ ] Docs actualizadas si cambia el comportamiento (`README.md`,
      `docs/INSTALACION.md`, `docs/ARQUITECTURA.md`).

---

## Buenas prácticas

- **Idioma del código**: los identificadores, nombres de archivo y rutas están
  en **inglés**; los comentarios y la documentación están en **español**.
  Mantén esa convención para que el código sea consistente.
- **Mantén los tests**: cualquier cambio en `server/src/` debe ir acompañado de
  tests en `server/test/` (vitest, con DB mock). Los tests deben quedar verdes.
- **Mensajes de commit claros**: convencionales y en español, describiendo el
  *qué* y el *por qué* (no solo el *cómo*).
- **Documentación**: si cambias comportamiento visible (envs, endpoints, UI,
  scripts), actualiza el `README.md` y las guías de `docs/` en el mismo PR.
- **Auditoría y privacidad**: el proyecto lleva una política de saneamiento de
  secretos; revisa `git status` antes de `git add .` y añade solo lo intencionado.
- **Calidad del instalador**: `deploy.sh` es la cara de la instalación; si lo
  modificas, hazlo de forma no destructiva y mantén el modo `--dry-run`.

---

## Documentación interna (bóveda)

La carpeta **`docs/knowledge-base/`** es la **bóveda interna** de SmoothCloud
(notas, ADRs y minutas de diseño) y **NO se publica** en este repositorio:
está en `.gitignore` y no debe subirse en ningún PR. Los cambios de diseño y las
decisiones de arquitectura se documentan allí para el equipo interno; aquí
también se documentan en `docs/ARQUITECTURA.md` cuando son parte del producto
público.

---

## Licencia

Al contribuir aceptas que tu código se distribuya bajo la licencia **MIT** del
proyecto (ver [`LICENSE`](LICENSE)). Iconos de terceros: ver
[`server/THIRD_PARTY_NOTICES`](server/THIRD_PARTY_NOTICES).

¡Gracias por hacer de SM-HomePage un mejor portal para todos! 💙
