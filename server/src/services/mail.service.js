const nodemailer = require('nodemailer');

// Throttling global del transporte SMTP/SendGrid para no agotar la cuota:
// máximo 10 correos por segundo (rateDelta en ms).
const RATE_LIMIT_PER_SECOND = 10;
const RATE_DELTA_MS = 1000;

// Hook de test (mismo patrón que db.setDbClient): permite simular fallos de
// envío sin tocar la red. Se guarda en globalThis porque vitest puede crear
// instancias duplicadas del módulo (import ESM vs require CJS).
const SEND_OVERRIDE_KEY = '__corpHomepage_mail_send_override__';

function setSendOtpEmailWithRetryOverride(fn) {
  globalThis[SEND_OVERRIDE_KEY] = fn;
}

function getSendOtpEmailWithRetry() {
  return globalThis[SEND_OVERRIDE_KEY] || sendOtpEmailWithRetry;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_SITE_NAME = 'SM-HomePage';

// Escape HTML básico para un site_name configurable: si el valor guardado en
// settings fuera malicioso (p. ej. "<img onerror=...>") no puede inyectar
// marcado en el cuerpo del correo. Solo se aplica a la salida HTML; el
// asunto y el texto plano usan el valor sin escapar (no son HTML).
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Resuelve el nombre del sitio con fallback: si no viene o está vacío, cae a
// 'SM-HomePage' (no rompe llamadas antiguas ni tests que no lo pasan).
function siteNameOrDefault(siteName) {
  return typeof siteName === 'string' && siteName.trim() ? siteName : DEFAULT_SITE_NAME;
}

// Driver "log": imprime el código en consola (solo para pruebas/dev).
// Devuelve una promesa resuelta para que el flujo sea uniforme.
async function sendViaLog(config, { to, code, siteName }) {
  // Nunca loguear códigos en producción (MAIL_DRIVER=log no debe usarse en prod).
  if (config.isProd) {
    console.error('[mail] MAIL_DRIVER=log está activado en producción. No se muestra el código.');
    return;
  }
  console.log('============================================');
  console.log(`[MAIL_DRIVER=log] Código OTP para ${to} (${siteNameOrDefault(siteName)}): ${code}`);
  console.log('============================================');
}

// Configuración del transporte SMTP (incluye throttling anti-cuota).
function smtpTransportOptions(config) {
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
    rateLimit: RATE_LIMIT_PER_SECOND,
    rateDelta: RATE_DELTA_MS,
  };
}

// Configuración del transporte SendGrid (mismo contrato que smtp).
function sendgridTransportOptions(config) {
  return {
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    auth: {
      user: 'apikey',
      pass: config.sendgridApiKey,
    },
    rateLimit: RATE_LIMIT_PER_SECOND,
    rateDelta: RATE_DELTA_MS,
  };
}

// Driver "smtp": envía correo real mediante Nodemailer.
async function sendViaSmtp(config, { to, code, from, siteName }) {
  const brand = siteNameOrDefault(siteName);
  const transporter = nodemailer.createTransport(smtpTransportOptions(config));
  await transporter.sendMail({
    from: from || config.smtp.from,
    to,
    subject: `Tu código de acceso a ${brand}`,
    text: `Tu código de acceso a ${brand} es: ${code}\nTiene una validez de ${config.otpTtlMin} minutos.`,
    html: buildOtpHtml(code, config.otpTtlMin, siteName),
  });
}

// Driver "sendgrid": mismo contrato que "smtp" pero con el transporte
// específico de SendGrid (sin dependencia adicional: nodemailer ya lo cubre).
async function sendViaSendgrid(config, { to, code, from, siteName }) {
  const brand = siteNameOrDefault(siteName);
  const transporter = nodemailer.createTransport(sendgridTransportOptions(config));
  await transporter.sendMail({
    from: from || config.mailFrom,
    to,
    subject: `Tu código de acceso a ${brand}`,
    text: `Tu código de acceso a ${brand} es: ${code}\nTiene una validez de ${config.otpTtlMin} minutos.`,
    html: buildOtpHtml(code, config.otpTtlMin, siteName),
  });
}

function buildOtpHtml(code, otpTtlMin, siteName) {
  const brand = escapeHtml(siteNameOrDefault(siteName));
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: auto;">
      <h2>${brand}</h2>
      <p>Tu código de acceso es:</p>
      <p style="font-size: 28px; letter-spacing: 8px; font-weight: bold;">${code}</p>
      <p>Válido durante ${otpTtlMin} minutos. Si no solicitaste este código, ignora este correo.</p>
    </div>`;
}

// Envía el código OTP según el driver configurado.
// `from` es el remitente efectivo resuelto en runtime (settings.mail_from
// tiene precedencia; si no, el de config).
async function sendOtpEmail(config, { to, code, from, siteName }) {
  if (config.mailDriver === 'smtp') {
    await sendViaSmtp(config, { to, code, from, siteName });
  } else if (config.mailDriver === 'sendgrid') {
    await sendViaSendgrid(config, { to, code, from, siteName });
  } else {
    await sendViaLog(config, { to, code, siteName });
  }
}

// Envío transaccional con reintentos y backoff corto (500 ms, 1 s).
// Si TODOS los intentos fallan, lanza el error para que la ruta invalide el
// código generado y audite mail.send_failed SIN tumbar la app.
async function sendOtpEmailWithRetry(config, { to, code, from, siteName }) {
  const delays = [500, 1000];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      // Se resuelve desde module.exports para que tests puedan espiar el envío.
      await module.exports.sendOtpEmail(config, { to, code, from, siteName });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw lastError;
}

module.exports = {
  sendOtpEmail,
  sendOtpEmailWithRetry,
  getSendOtpEmailWithRetry,
  setSendOtpEmailWithRetryOverride,
  sendViaLog,
  sendViaSmtp,
  sendViaSendgrid,
  buildOtpHtml,
  escapeHtml,
  smtpTransportOptions,
  sendgridTransportOptions,
  RATE_LIMIT_PER_SECOND,
  RATE_DELTA_MS,
};
