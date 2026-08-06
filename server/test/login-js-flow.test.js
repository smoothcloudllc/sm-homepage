import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Tests del JS de login (src/public/js/login.js) con un stub mínimo de DOM y
// un mock de fetch. Cubren el flujo secuencial request -> verify:
//   - tras éxito: notificación genérica "Código enviado a {email}" sin mostrar
//     dev_code,
//     cambio de forms (solo uno visible) y propagación de next/bootstrap_token.
//   - tras 403/error: mensaje genérico SIN el email del usuario, forms intactos.
//   - botón "← Volver": regresa al paso 1 y oculta la notificación.
const loginJsPath = fileURLToPath(new URL('../src/public/js/login.js', import.meta.url));
const loginJsSource = readFileSync(loginJsPath, 'utf8');

// Stub mínimo de DOM con la superficie exacta que usa login.js:
// getElementById/createElement/querySelector, addEventListener/dispatchEvent,
// hidden (atributo), value, className, textContent, appendChild, before,
// focus y querySelectorAll('[name]') (serialización del form).
function createStubDom() {
  const els = {};
  const mkElement = (id) => {
    const el = {
      id,
      _attrs: {},
      _handlers: {},
      _children: [],
      _text: '',
      value: '',
      checked: false,
      disabled: false,
      className: '',
      _focused: false,
      _beforeSibling: null,
      get hidden() { return '_hidden' in this._attrs; },
      set hidden(v) { if (v) this._attrs._hidden = ''; else delete this._attrs._hidden; },
      get name() { return this._attrs.name || ''; },
      set name(v) { this._attrs.name = v; },
      get type() { return this._attrs.type || 'text'; },
      set type(v) { this._attrs.type = v; },
      get textContent() {
        let out = this._text;
        for (const c of this._children) out += c.textContent;
        return out;
      },
      set textContent(v) { this._text = String(v); this._children = []; },
      setAttribute(n, v) {
        this._attrs[n] = String(v);
        if (n === 'hidden') this._attrs._hidden = '';
      },
      removeAttribute(n) {
        delete this._attrs[n];
        if (n === 'hidden') delete this._attrs._hidden;
      },
      getAttribute(n) { return n === 'hidden' ? (this.hidden ? '' : null) : (n in this._attrs ? this._attrs[n] : null); },
      addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
      dispatchEvent(ev) {
        ev.preventDefault = ev.preventDefault || (() => {});
        ev.target = this;
        (this._handlers[ev.type] || []).forEach((fn) => fn(ev));
      },
      focus() { this._focused = true; },
      appendChild(child) { this._children.push(child); },
      before(child) { this._beforeSibling = child; },
      querySelectorAll(sel) {
        if (sel === '[name]') return this.__named || [];
        return [];
      },
    };
    return el;
  };
  const document = {
    __els: els,
    createElement(tag) { const e = mkElement('el-' + Object.keys(els).length); return e; },
    // Crea bajo demanda (solo para el montaje del test; el DOM real usa HTML).
    ensure(id) { if (!els[id]) els[id] = mkElement(id); return els[id]; },
    getElementById(id) { return els[id] || null; },
    querySelector(sel) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return Object.values(els).find((e) => e.className.split(/\s+/).includes(cls)) || null;
      }
      return null;
    },
  };
  return document;
}

// Carga login.js en el contexto del stub y devuelve la referencia a los elementos.
function bootLogin(document, fetchImpl) {
  const run = new Function('document', 'fetch', loginJsSource);
  run(document, fetchImpl);
  return document.__els;
}

function wireForms(document, { withBootstrapInput = true } = {}) {
  const els = document.__els;
  const get = (id) => document.ensure(id);
  // Campos del form de email (mismo orden que el DOM real: _csrf, next, email, bootstrap).
  const csrf = get('csrf-token');
  csrf.name = '_csrf';
  csrf.type = 'hidden';
  csrf.value = 'csrf-123';
  const next = get('login-next');
  next.name = 'next';
  next.type = 'hidden';
  next.value = '/apps';
  const email = get('email');
  email.name = 'email';
  email.type = 'email';
  email.value = ' alice@testcorp.com ';
  const loginForm = get('login-form');
  const named = [csrf, next, email];
  if (withBootstrapInput) {
    const bootstrap = get('bootstrap-token-input');
    bootstrap.name = 'bootstrap_token';
    bootstrap.type = 'password';
    bootstrap.value = 'tok-visible';
    named.push(bootstrap);
  }
  loginForm.__named = named;
  // Campos del form de verificación.
  const vEmail = get('verify-email');
  vEmail.name = 'email';
  vEmail.type = 'hidden';
  const vBootstrap = get('verify-bootstrap-token');
  vBootstrap.name = 'bootstrap_token';
  vBootstrap.type = 'hidden';
  const vNext = get('verify-next');
  vNext.name = 'next';
  vNext.type = 'hidden';
  const code = get('code');
  code.name = 'code';
  code.type = 'text';
  const verifyForm = get('verify-form');
  verifyForm.__named = [vEmail, vBootstrap, vNext, code];
  // Estado inicial renderizado: solo el form de email visible.
  verifyForm.hidden = true;
  loginForm.hidden = false;
  get('login-status').hidden = true;
  // Elementos a los que login.js se suscribe/activa en el arranque.
  get('back-btn');
  get('request-btn');
  return els;
}

function submitRequest(els) {
  const handler = els['login-form']._handlers.submit[0];
  expect(handler, 'login-form debe tener handler submit').toBeTruthy();
  return handler({ preventDefault() {} });
}

function clickBack(els) {
  const handler = els['back-btn']._handlers.click[0];
  expect(handler, 'back-btn debe tener handler click').toBeTruthy();
  handler({ preventDefault() {} });
}

describe('login.js: flujo request -> verify (mock fetch)', () => {
  it('(d1) éxito: notificación genérica sin mostrar dev_code, un solo form visible, propagación de next y bootstrap', async () => {
    const document = createStubDom();
    wireForms(document);
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'Si el correo existe, se envió un código.', dev_code: '123456' }),
    });
    bootLogin(document, fetchMock);

    await submitRequest(els);

    // Llamada al backend con el body correcto (email recortado).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/auth/request');
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get('email')).toBe('alice@testcorp.com');
    expect(body.get('_csrf')).toBe('csrf-123');
    expect(body.get('next')).toBe('/apps');
    expect(body.get('bootstrap_token')).toBe('tok-visible');

    // UN solo form visible: el de código.
    expect(els['login-form'].hidden).toBe(true);
    expect(els['verify-form'].hidden).toBe(false);

    // Notificación accesible con el email del propio usuario, sin exponer dev_code.
    const status = els['login-status'];
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('Código enviado a alice@testcorp.com.');
    expect(status.textContent).toContain('Revisa tu bandeja de entrada.');
    expect(status.textContent).not.toContain('Modo desarrollo: tu código es');

    // Propagación de campos ocultos al form de verificación.
    expect(els['verify-email'].value).toBe('alice@testcorp.com');
    expect(els['verify-bootstrap-token'].value).toBe('tok-visible'); // prioridad input visible
    expect(els['verify-next'].value).toBe('/apps');

    // Foco en el input del código + botón restaurado.
    expect(els['code']._focused).toBe(true);
    expect(els['request-btn'].disabled).toBe(false);
    expect(els['request-btn'].textContent).toBe('Enviar código');
  });

  it('(d2) sin input bootstrap visible: la API (dev) rellena verify-bootstrap-token como respaldo', async () => {
    const document = createStubDom();
    wireForms(document, { withBootstrapInput: false });
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'ok', dev_code: '654321', bootstrap_token: 'tok-api' }),
    });
    bootLogin(document, fetchMock);

    await submitRequest(els);

    expect(els['verify-form'].hidden).toBe(false);
    expect(els['verify-bootstrap-token'].value).toBe('tok-api');
    expect(els['verify-next'].value).toBe('/apps');
  });

  it('(d3) sin dev_code en la respuesta: NO se muestra hint de código (producción)', async () => {
    const document = createStubDom();
    wireForms(document, { withBootstrapInput: false });
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'ok' }),
    });
    bootLogin(document, fetchMock);

    await submitRequest(els);

    const status = els['login-status'];
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('Código enviado a alice@testcorp.com.');
    expect(status.textContent).not.toContain('código es');
  });

  it('(d4) 403/error: mensaje genérico, el email NO se filtra, los forms no cambian', async () => {
    const document = createStubDom();
    wireForms(document);
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'No se pudo enviar el código.' }),
    });
    bootLogin(document, fetchMock);

    await submitRequest(els);

    // Error genérico mostrado (sin email) y sin notificación de éxito.
    const errDiv = els['login-form']._beforeSibling;
    expect(errDiv).toBeTruthy();
    expect(errDiv.textContent).toBe('No se pudo enviar el código.');
    expect(errDiv.textContent).not.toContain('alice@testcorp.com');
    expect(els['login-status'].hidden).toBe(true);

    // El flujo sigue en el paso 1 (solo el form de email visible).
    expect(els['login-form'].hidden).toBe(false);
    expect(els['verify-form'].hidden).toBe(true);
    expect(els['request-btn'].disabled).toBe(false);
  });

  it('(d5) 403 con cuerpo no-JSON (p. ej. HTML de CSRF): fallback genérico sin email', async () => {
    const document = createStubDom();
    wireForms(document);
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => { throw new Error('HTML page'); },
    });
    bootLogin(document, fetchMock);

    await submitRequest(els);

    const errDiv = els['login-form']._beforeSibling;
    expect(errDiv.textContent).toBe('No se pudo enviar el código. Intenta de nuevo.');
    expect(errDiv.textContent).not.toContain('alice@testcorp.com');
    expect(els['login-form'].hidden).toBe(false);
    expect(els['verify-form'].hidden).toBe(true);
  });

  it('(d6) botón "← Volver": regresa al paso 1 y oculta la notificación', async () => {
    const document = createStubDom();
    wireForms(document);
    const els = document.__els;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'ok', dev_code: '123456' }),
    });
    bootLogin(document, fetchMock);
    await submitRequest(els);

    expect(els['verify-form'].hidden).toBe(false);

    clickBack(els);

    expect(els['verify-form'].hidden).toBe(true);
    expect(els['login-form'].hidden).toBe(false);
    expect(els['login-status'].hidden).toBe(true);
    expect(els['email']._focused).toBe(true);
  });
});
