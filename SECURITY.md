# Security Policy

## Reporte de vulnerabilidades

**NO abras issues públicos de seguridad en el repositorio.**

Los problemas de seguridad deben reportarse de forma privada para que el
mantenedor pueda corregirlos y publicar una versión parchada antes de que el
detalle sea público.

### Cómo reportar

- **Email**: `security@tu-dominio.com` (sustituye por el canal de contacto
  del mantenedor del fork).
- **Issue privada**: si usas GitHub, abre una issue **privada** (o usa el
  flujo de *Security Advisories* / *Report a vulnerability*) en lugar de una
  pública.

Incluye en el reporte:

1. **Versión afectada** (busca `version` en `server/package.json` o el tag
   del commit/rama).
2. **Pasos para reproducir** (mínimo, de forma reproducible).
3. **Impacto esperado** (qué podría hacer un atacante y bajo qué
   condiciones).
4. Si lo tienes, una **prueba de concepto** o snippet que lo demuestre.
5. Tu entorno de despliegue (solo si es relevante): versión de Docker,
   Postgres, sistema operativo.

> No incluyas secretos reales en el reporte (tokens, contraseñas, API keys).

### Qué esperar

- **Acuse de recibo**: en un plazo de **72 horas** tras recibir el reporte.
- El mantenedor responderá con una evaluación inicial y un plan de
  mitigación/parche.
- Coordinación responsable: se puede acordar publicar un **advisory**
  (GitHub Security Advisory) o aviso coordinado una vez corregido.
- Agradecimientos: si lo deseas, tu nombre/nick se añadirá al advisory o al
  `CHANGELOG.md` como agradecimiento (opt-in).

### Alcance

Este proyecto es de **código abierto** (MIT). Los mantenedores agradecen el
trabajo de los investigadores, pero **no existe programa de bug bounty** ni
se ofrece compensación económica.
