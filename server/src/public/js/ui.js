// UI global: menú de usuario (dropdown), confirmaciones de acciones
// destructivas y cierre por teclado. Sin scripts inline (CSP 'self').
(function () {
  'use strict';

  // --- Menú de usuario (data-menu / data-menu-trigger / data-menu-panel) ---
  const trigger = document.querySelector('[data-menu-trigger]');
  const panel = document.querySelector('[data-menu-panel]');

  if (trigger && panel) {
    function setOpen(open) {
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(panel.hidden);
    });

    // Cerrar al hacer click fuera o al pulsar Escape.
    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (!trigger.contains(e.target) && !panel.contains(e.target)) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        trigger.focus();
      }
    });
  }

  // --- Confirmación de formularios destructivos (data-confirm) ---
  document.querySelectorAll('form.confirm-form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      const message = form.getAttribute('data-confirm') || '¿Confirmar esta acción?';
      if (!window.confirm(message)) e.preventDefault();
    });
  });

  // --- Cadena de iconos de apps: fallback de imágenes sin handlers inline ---
  // Si una img de icono (icon_url del admin o favicon automático) no carga,
  // se intenta la URL de respaldo (data-fallback-src, p. ej. Google s2) y, si
  // tampoco, se muestra el glifo con la inicial (pre-renderizado, hidden).
  // 'error' no burbujea: se captura en fase de captura sobre document.
  document.addEventListener('error', function (e) {
    const img = e.target;
    if (!img || !img.classList || !img.classList.contains('app-icon-img')) return;

    const fallbackSrc = img.getAttribute('data-fallback-src');
    if (fallbackSrc && img.getAttribute('src') !== fallbackSrc) {
      img.setAttribute('src', fallbackSrc);
      return;
    }

    img.hidden = true;
    const glyph = img.parentElement && img.parentElement.querySelector('.app-glyph-fallback');
    if (glyph) glyph.hidden = false;
  }, true);
})();
