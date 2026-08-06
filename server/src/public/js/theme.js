// Modo claro/oscuro con 3 estados (light | dark | system).
// Se carga en <head> SIN defer para fijar data-theme ANTES del primer paint
// (sin FOUC). Sin scripts inline (CSP 'self').
// Las funciones puras (resolve/nextTheme/ORDER/LABELS) se exportan vía
// module.exports cuando hay CommonJS (tests), sin interferir en el navegador.
(function () {
  'use strict';

  var STORAGE_KEY = 'cp-theme';
  var ORDER = ['light', 'dark', 'system'];
  var LABELS = { light: 'Claro', dark: 'Oscuro', system: 'Sistema' };

  // Resuelve una preferencia a un tema concreto ('light'|'dark').
  // 'system' consulta matchMedia; sin matchMedia (Node/tests) cae a 'light'.
  function resolve(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  // Cicla light -> dark -> system -> light (orden estable del toggle).
  function nextTheme(theme) {
    var idx = ORDER.indexOf(theme);
    return ORDER[(idx + 1) % ORDER.length];
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STORAGE_KEY, ORDER, LABELS, resolve, nextTheme };
  }

  // --- Wiring del navegador: solo si hay DOM ---------------------------
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var html = document.documentElement;
  var defaultTheme = html.getAttribute('data-default-theme') || 'system';
  var stored = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    stored = null;
  }

  // Estado base: preferencia guardada -> si no, default del servidor.
  var base = stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : defaultTheme;

  html.setAttribute('data-theme', resolve(base));
  html.setAttribute('data-theme-pref', base);

  function apply(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      // localStorage no disponible: el tema aplica solo para esta sesión.
    }
    html.setAttribute('data-theme', resolve(theme));
    html.setAttribute('data-theme-pref', theme);
    updateButton();
  }

  function updateButton() {
    var btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    var current = html.getAttribute('data-theme-pref') || 'system';
    btn.setAttribute('data-theme-state', current);
    btn.setAttribute(
      'aria-label',
      'Tema actual: ' + (LABELS[current] || 'Sistema') + '. Cambiar a ' + (LABELS[nextTheme(current)] || '')
    );
  }

  function wireToggle() {
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.addEventListener('click', function () {
        apply(nextTheme(html.getAttribute('data-theme-pref') || 'system'));
      });
    }
    updateButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggle);
  } else {
    wireToggle();
  }
})();
