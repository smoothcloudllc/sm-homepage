const path = require('path');

if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

function parseAllowedDomains(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS || process.env.ALLOWED_DOMAINS);

  // En development, si la allow-list está vacía se permite "localhost"
  // para facilitar las pruebas locales.
  if (nodeEnv === 'development' && allowedDomains.length === 0) {
    allowedDomains.push('localhost');
  }

  const config = {
    nodeEnv,
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    sessionDays: parseInt(process.env.SESSION_DAYS || '30', 10),
    sessionRotateDays: parseInt(process.env.SESSION_ROTATE_DAYS || '7', 10),
    revokeAllOnLogin: process.env.REVOKE_ALL_ON_LOGIN === 'true',
    allowedDomains,
    superAdminEmail: (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase(),
    bootstrapToken: process.env.BOOTSTRAP_TOKEN || null,
    // Credencial de arranque alternativa del primer login del super_admin:
    // código de 6 dígitos (BOOTSTRAP_CODE). Retrocompat: BOOTSTRAP_TOKEN (hex)
    // sigue soportado; si ambos existen, BOOTSTRAP_CODE tiene prioridad.
    bootstrapCode: process.env.BOOTSTRAP_CODE || null,
    otpTtlMin: parseInt(process.env.OTP_TTL_MIN || '10', 10),
    mailDriver: process.env.MAIL_DRIVER || 'log',
    // SendGrid vía SMTP: MAIL_DRIVER=sendgrid usa el transporte de Nodemailer
    // contra smtp.sendgrid.net. La clave SOLO vive en env (nunca en BD).
    sendgridApiKey: process.env.SENDGRID_API_KEY || null,
    // Remitente por defecto de los correos OTP. El valor de aquí es un
    // PLACEHOLDER genérico: en producción SIEMPRE se define MAIL_FROM en el
    // entorno. Si viene de settings (mail_from) en la BD, el resolver runtime
    // lo usa con prioridad.
    mailFrom: process.env.MAIL_FROM || 'no-reply@example.com',
    smtp: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || 'SM-HomePage <no-reply@localhost>',
    },
    // Personalización con fallback a env; el valor efectivo lo resuelve
    // settings.service (BD con precedencia sobre env).
    siteName: process.env.SITE_NAME || 'SM-HomePage',
    defaultTheme: process.env.DEFAULT_THEME || 'system',
    // Directorio donde se guarda el logo subido por super_admin.
    // En docker se monta el volumen nombrado en /app/public/uploads.
    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads'),
    portal: {
      bgImage: process.env.PORTAL_BG_IMAGE || '',
      bgColor: process.env.PORTAL_BG_COLOR || '#0f1115',
    },
    isProd,
    // dev_code solo se expone en desarrollo y si ENABLE_DEV_CODE != false.
    // Nunca está activo en producción, aunque se fuerce ENABLE_DEV_CODE=true.
    enableDevCode: nodeEnv === 'development' && process.env.ENABLE_DEV_CODE !== 'false',
    // Cookie Secure configurable: por defecto Secure=true en producción, pero
    // puede desactivarse con COOKIE_SECURE=false SOLO para HTTP plano interno
    // detrás del borde de la red interna / VPN (recomendado: terminar TLS y
    // dejar Secure=true).
    cookieSecure: process.env.COOKIE_SECURE !== 'false' && isProd,
    // Modo anónimo del dashboard: por defecto ACTIVO (comportamiento actual:
    // GET / muestra las apps públicas sin sesión). ANONYMOUS_MODE=off lo
    // desactiva: GET / sin sesión redirige a /login (recomendado en
    // despliegues solo-autenticados expuestos a Internet con TLS).
    anonymousMode: process.env.ANONYMOUS_MODE !== 'off',
    // Hops de reverse proxy de confianza (Caddy/Nginx) para rate limiting y
    // auditoría. 0 = red interna directa (comportamiento actual: req.ip es la
    // IP real). SOLO se activa app.set('trust proxy', N) cuando N>0 (entonces
    // X-Forwarded-For se considera fiable). NUNCA activar sin proxy delante.
    trustProxy: Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0),
  };

  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (config.superAdminEmail) {
    const domain = config.superAdminEmail.split('@')[1];
    if (domain && allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
      throw new Error(
        `SUPER_ADMIN_EMAIL (${config.superAdminEmail}) no pertenece a un dominio permitido en ALLOWED_DOMAINS.`
      );
    }
  }
  if (config.mailDriver === 'smtp' && !config.smtp.host) {
    missing.push('SMTP_HOST (obligatorio si MAIL_DRIVER=smtp)');
  }
  if (config.mailDriver === 'sendgrid' && !config.sendgridApiKey) {
    throw new Error(
      'MAIL_DRIVER=sendgrid requiere SENDGRID_API_KEY. Define SENDGRID_API_KEY en el entorno (nunca en la BD).'
    );
  }
  if (config.mailDriver === 'log' && isProd) {
    throw new Error(
      'MAIL_DRIVER=log está prohibido en producción: imprime los códigos OTP en la consola. Usa MAIL_DRIVER=smtp, o NODE_ENV=development para pruebas locales.'
    );
  }
  if (isProd && !config.superAdminEmail) {
    missing.push('SUPER_ADMIN_EMAIL (obligatorio en producción)');
  }
  if (config.bootstrapToken && !config.superAdminEmail) {
    throw new Error('BOOTSTRAP_TOKEN requiere SUPER_ADMIN_EMAIL: el token solo aplica al bootstrap del super_admin.');
  }
  if (config.bootstrapCode && !/^\d{6}$/.test(config.bootstrapCode)) {
    throw new Error(
      `BOOTSTRAP_CODE debe ser un código de 6 dígitos (p. ej. 483912). Valor recibido: "${config.bootstrapCode}".`
    );
  }
  if (config.bootstrapCode && !config.superAdminEmail) {
    throw new Error('BOOTSTRAP_CODE requiere SUPER_ADMIN_EMAIL: el código solo aplica al bootstrap del super_admin.');
  }

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno críticas: ${missing.join(', ')}. Revisa el archivo .env (ver .env.example).`
    );
  }

  return config;
}

const config = loadConfig();

module.exports = { config, loadConfig };
