// Flujo de login en dos pasos (email -> código OTP) con fetch.
// No hay ningún script inline (CSP); todo vive en este archivo externo.
// Propaga el campo oculto ?next= de la primera a la segunda fase para que
// POST /auth/verify redirija a la ruta local originalmente solicitada.
//
// Visibilidad: los dos forms NUNCA se ven a la vez. El form de código nace
// con el atributo `hidden` en el HTML (regla CSS `[hidden]{display:none!important}`)
// y login.js alterna la propiedad .hidden (mismo patrón que admin.js).
(function () {
  const requestForm = document.getElementById('login-form');
  const verifyForm = document.getElementById('verify-form');
  const backBtn = document.getElementById('back-btn');
  const emailInput = document.getElementById('email');
  const verifyEmail = document.getElementById('verify-email');
  const verifyBootstrapToken = document.getElementById('verify-bootstrap-token');
  const verifyBootstrapCode = document.getElementById('verify-bootstrap-code');
  const verifyNext = document.getElementById('verify-next');
  const loginNext = document.getElementById('login-next');
  const requestBtn = document.getElementById('request-btn');
  const codeInput = document.getElementById('code');
  const statusRegion = document.getElementById('login-status');

  // Serializa un form a application/x-www-form-urlencoded respetando el valor
  // de cada campo con name (incluye los type=hidden: _csrf, next, …).
  function formToParams(form) {
    const params = new URLSearchParams();
    const fields = form.querySelectorAll('[name]');
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.name && (field.type !== 'checkbox' || field.checked)) {
        params.set(field.name, field.value);
      }
    }
    return params;
  }

  // Notificación accesible en #login-status (role=status / aria-live=polite).
  // El email mostrado es el que el PROPIO usuario escribió (no es enumeración).
  function showSentStatus(email) {
    if (!statusRegion) return;
    statusRegion.hidden = false;
    statusRegion.textContent = '';
    const main = document.createElement('span');
    main.textContent = 'Código enviado a ' + email + '. Revisa tu bandeja de entrada.';
    statusRegion.appendChild(main);
  }

  function showError(message) {
    const box = document.querySelector('.alert-error');
    if (box) box.textContent = message;
    else {
      const div = document.createElement('div');
      div.className = 'alert alert-error';
      div.setAttribute('role', 'alert');
      div.textContent = message;
      requestForm.before(div);
    }
  }

  requestForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return; // la validación nativa (required + type=email) ya avisa
    emailInput.value = email; // el body viaja con el email normalizado
    const btn = requestBtn;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const res = await fetch('/auth/request', {
        method: 'POST',
        body: formToParams(requestForm).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Error genérico: nunca se filtra si el correo existe o no (la API ya
        // responde 200 genérico; un fallo aquí es rate-limit/CSRF/red).
        showError(data.error || 'No se pudo enviar el código. Intenta de nuevo.');
        return;
      }
      verifyEmail.value = email;
      if (verifyBootstrapCode) {
        // Primer inicio con código de 6 dígitos (BOOTSTRAP_CODE): prioridad al
        // input visible; en dev, si la API devuelve bootstrap_code, se usa como
        // respaldo (mismo patrón que el token hex).
        const visibleCode = document.getElementById('bootstrap-code-input');
        verifyBootstrapCode.value = (visibleCode && visibleCode.value.trim()) || (data && data.bootstrap_code) || '';
      }
      if (verifyBootstrapToken) {
        // Retrocompat: flujo producción con BOOTSTRAP_TOKEN hex. Prioridad al
        // input visible; en dev, respaldo desde la API.
        const visibleToken = document.getElementById('bootstrap-token-input');
        verifyBootstrapToken.value = (visibleToken && visibleToken.value.trim()) || (data && data.bootstrap_token) || '';
      }
      if (verifyNext && loginNext) {
        verifyNext.value = loginNext.value || '/';
      }
      // Paso 2: se muestra la notificación y SOLO el form de código.
      showSentStatus(email);
      requestForm.hidden = true;
      verifyForm.hidden = false;
      if (codeInput) codeInput.focus();
    } catch (err) {
      showError('Error de red. Intenta de nuevo.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar código';
    }
  });

  // El verify-form se envía por submit NATIVO (sin fetch): re-sincronizamos el
  // bootstrap visible (código o token) con su hidden justo antes de partir, por
  // si el usuario volvió atrás (back-btn) y modificó el valor. Solo se copia
  // cuando el campo visible tiene contenido, para no pisar un respaldo de la
  // API (dev) cuando no hay input visible.
  verifyForm.addEventListener('submit', function () {
    if (verifyBootstrapCode) {
      const visibleCode = document.getElementById('bootstrap-code-input');
      if (visibleCode && visibleCode.value.trim()) {
        verifyBootstrapCode.value = visibleCode.value.trim();
      }
    }
    if (verifyBootstrapToken) {
      const visibleToken = document.getElementById('bootstrap-token-input');
      if (visibleToken && visibleToken.value.trim()) {
        verifyBootstrapToken.value = visibleToken.value.trim();
      }
    }
  });

  backBtn.addEventListener('click', function () {
    verifyForm.hidden = true;
    requestForm.hidden = false;
    if (statusRegion) statusRegion.hidden = true;
    if (emailInput) emailInput.focus();
  });
})();
