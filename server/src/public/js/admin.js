// Utilidades para la consola admin. Sin scripts inline (CSP 'self').
// (La confirmación de acciones destructivas vive en ui.js, que se carga en
// todas las páginas.)
(function () {
  'use strict';

  // En apps-form: mostrar/ocultar el selector multi de grupos al cambiar
  // la visibilidad a 'restricted'.
  const visibilitySelect = document.getElementById('visibility');
  const groupsBox = document.getElementById('groups-box');
  if (visibilitySelect && groupsBox) {
    function syncVisibility() {
      groupsBox.hidden = visibilitySelect.value !== 'restricted';
    }
    visibilitySelect.addEventListener('change', syncVisibility);
    syncVisibility();
  }

  // En apps-form: espejo del color elegido en el color picker.
  const colorInput = document.querySelector('input[type="color"][name="color"]');
  const colorValue = document.getElementById('f-color-value');
  if (colorInput && colorValue) {
    colorInput.addEventListener('input', function () {
      colorValue.textContent = colorInput.value;
    });
  }

  // --- Picker de iconos de la biblioteca (filtro por texto/categoría) ---
  const iconSearch = document.getElementById('icon-search');
  const iconCategoryFilter = document.getElementById('icon-category-filter');
  const iconOptions = Array.from(document.querySelectorAll('.icon-option'));

  if (iconOptions.length > 0) {
    function filterIconOptions() {
      const q = (iconSearch ? iconSearch.value : '').trim().toLowerCase();
      const cat = iconCategoryFilter ? iconCategoryFilter.value : '';
      iconOptions.forEach(function (opt) {
        const label = (opt.getAttribute('data-label') || '').toLowerCase();
        const category = opt.getAttribute('data-category') || '';
        const matchQ = !q || label.indexOf(q) !== -1;
        const matchCat = !cat || category === cat;
        opt.hidden = !(matchQ && matchCat);
      });
    }
    if (iconSearch) iconSearch.addEventListener('input', filterIconOptions);
    if (iconCategoryFilter) iconCategoryFilter.addEventListener('change', filterIconOptions);
    filterIconOptions();
  }

  // --- Mutua exclusión icon_url / icon_key (evita el 400 del backend) ---
  const fIconUrl = document.getElementById('f-icon-url');
  const iconKeyRadios = Array.from(document.querySelectorAll('input[name="icon_key"]'));
  if (fIconUrl && iconKeyRadios.length > 0) {
    fIconUrl.addEventListener('input', function () {
      if (fIconUrl.value.trim()) {
        const none = iconKeyRadios.find(function (r) { return r.value === ''; });
        if (none) none.checked = true;
      }
    });
    iconKeyRadios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.value && fIconUrl) fIconUrl.value = '';
      });
    });
  }

  // --- Upload de icono personalizado: preview local del fichero elegido ---
  const iconUploadInput = document.getElementById('f-icon-upload');
  const previewIcon = document.getElementById('preview-icon');
  if (iconUploadInput && previewIcon) {
    iconUploadInput.addEventListener('change', function () {
      const file = iconUploadInput.files && iconUploadInput.files[0];
      if (!file) return;
      // Solo imagenes; el servidor valida de verdad por magic bytes.
      if (!/^image\/(png|jpeg)$/.test(file.type)) {
        iconUploadInput.value = '';
        return;
      }
      const url = URL.createObjectURL(file);
      previewIcon.textContent = '';
      const img = document.createElement('img');
      img.className = 'app-icon-img app-icon-img--custom';
      img.src = url;
      img.alt = '';
      previewIcon.appendChild(img);
    });
  }

  // --- Upload de icono personalizado: envío real vía fetch (multipart).
  // Sin <form> anidado (ver apps-form.ejs): el botón es type="button" y no
  // interfiere con el submit del form padre. El token CSRF viaja en query
  // (?_csrf=), patrón documentado U-5 para multipart (multer no garantiza que
  // _csrf llegue en el body de multipart/form-data). El fichero se lee del
  // mismo input que alimenta el preview local (se conserva ese listener).
  const iconUploadBtn = document.getElementById('icon-upload-btn');
  const iconUploadError = document.getElementById('icon-upload-error');
  if (iconUploadBtn && iconUploadInput) {
    const csrf = (document.querySelector('input[name="_csrf"]') || {}).value || '';

    function iconAppId() {
      const box = iconUploadInput.closest('.icon-upload-box');
      if (box && box.getAttribute('data-app-id')) return box.getAttribute('data-app-id');
      const form = document.querySelector('form.card.form');
      const action = form && form.getAttribute('action') ? form.getAttribute('action') : '';
      const m = action.match(/\/admin\/apps\/(\d+)\/?$/);
      return m ? m[1] : null;
    }

    function setIconUploadError(msg) {
      if (!iconUploadError) return;
      iconUploadError.textContent = msg;
      iconUploadError.hidden = !msg;
    }

    iconUploadBtn.addEventListener('click', async function () {
      const file = iconUploadInput.files && iconUploadInput.files[0];
      if (!file) {
        setIconUploadError('Elige un fichero PNG o JPEG antes de subir.');
        iconUploadInput.focus();
        return;
      }
      const appId = iconAppId();
      if (!appId) {
        setIconUploadError('No se pudo identificar la aplicación para el icono.');
        return;
      }
      const body = new FormData();
      body.append('icon', file);
      setIconUploadError('');
      iconUploadBtn.disabled = true;
      try {
        const res = await fetch('/admin/apps/' + encodeURIComponent(appId) + '/icon?_csrf=' + encodeURIComponent(csrf), {
          method: 'POST',
          body: body,
        });
        // El endpoint responde 302 a /admin/apps; con fetch la redirección se
        // sigue sola pero no cambia la página -> recarga explícita.
        if (res.ok || res.status === 302) {
          window.location.href = '/admin/apps';
          return;
        }
        const text = await res.text().catch(function () { return ''; });
        setIconUploadError((text && text.trim()) || 'No se pudo subir el icono (HTTP ' + res.status + ').');
      } catch (err) {
        setIconUploadError('Error de red al subir el icono.');
      } finally {
        iconUploadBtn.disabled = false;
      }
    });
  }

  // --- En apps-form: vista previa EN VIVO del icono. Misma cadena que el
  // render server-side: icon_url -> icon_key (biblioteca, /icons/<slug>.png)
  // -> icon_class -> favicon del dominio -> inicial.
  if (previewIcon) {
    const fName = document.getElementById('f-name');
    const fUrl = document.getElementById('f-url');
    const fIconClass = document.getElementById('f-icon-class');
    const fColor = document.querySelector('input[type="color"][name="color"]');
    let previewFileUrl = null;

    function previewInitial() {
      const n = (fName ? fName.value : '').trim();
      return n ? n.charAt(0).toUpperCase() : '?';
    }

    // Solo hostnames que parecen públicos (mismo criterio que utils/favicon.js).
    function previewFaviconHost(url) {
      if (!url) return null;
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return null;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const h = parsed.hostname.toLowerCase();
      if (!h || h === 'localhost' || h.includes(':')) return null;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
      if (h.indexOf('.') === -1) return null;
      if (/(^|\.)(local|internal|lan|localdomain|home|intranet|corp|test|invalid|onion|private)(\.|$)/.test(h)) return null;
      return h;
    }

    function selectedIconKey() {
      const checked = iconKeyRadios.find(function (r) { return r.checked; });
      return checked ? checked.value : '';
    }

    function renderPreview() {
      if (fColor) previewIcon.style.setProperty('--accent', fColor.value);
      previewIcon.textContent = '';

      // 0) Preview del fichero local seleccionado para subir (si lo hay).
      if (previewFileUrl) {
        const img = document.createElement('img');
        img.className = 'app-icon-img app-icon-img--custom';
        img.src = previewFileUrl;
        img.alt = '';
        previewIcon.appendChild(img);
        return;
      }

      const iconUrl = (fIconUrl ? fIconUrl.value : '').trim();
      const iconKey = selectedIconKey();
      const iconClass = (fIconClass ? fIconClass.value : '').trim();
      const host = previewFaviconHost((fUrl ? fUrl.value : '').trim());

      if (iconUrl) {
        const img = document.createElement('img');
        img.className = 'app-icon-img app-icon-img--custom';
        img.src = iconUrl;
        img.alt = '';
        previewIcon.appendChild(img);
      } else if (iconKey) {
        const img = document.createElement('img');
        img.className = 'app-icon-img app-icon-img--key';
        img.src = '/icons/' + iconKey + '.png';
        img.alt = '';
        img.title = 'Icono de la biblioteca';
        previewIcon.appendChild(img);
      } else if (iconClass) {
        const g = document.createElement('span');
        g.className = 'app-glyph';
        const i = document.createElement('i');
        i.className = iconClass;
        g.appendChild(i);
        const c = document.createElement('span');
        c.className = 'app-glyph-char';
        c.textContent = previewInitial();
        g.appendChild(c);
        previewIcon.appendChild(g);
      } else if (host) {
        const img = document.createElement('img');
        img.className = 'app-icon-img app-icon-img--favicon';
        img.src = 'https://icons.duckduckgo.com/ip3/' + host + '.ico';
        img.alt = '';
        img.title = 'Favicon automático del sitio';
        previewIcon.appendChild(img);
      } else {
        const g = document.createElement('span');
        g.className = 'app-glyph';
        g.textContent = previewInitial();
        previewIcon.appendChild(g);
      }
    }

    if (iconUploadInput) {
      iconUploadInput.addEventListener('change', function () {
        const file = iconUploadInput.files && iconUploadInput.files[0];
        previewFileUrl = file && /^image\/(png|jpeg)$/.test(file.type)
          ? URL.createObjectURL(file)
          : null;
        renderPreview();
      });
    }
    [fName, fUrl, fIconUrl, fIconClass, fColor].forEach(function (el) {
      if (el) el.addEventListener('input', renderPreview);
    });
    iconKeyRadios.forEach(function (r) { r.addEventListener('change', renderPreview); });
    renderPreview();
  }

  // --- Atajo "+ Nueva categoría" (apps-form): POST al endpoint centralizado
  // de creación de categorías (?inline=1 -> JSON) y recarga el <select>. ---
  const inlineToggle = document.getElementById('inline-category-toggle');
  const inlineBox = document.getElementById('inline-category-box');
  const inlineName = document.getElementById('inline-category-name');
  const inlineSave = document.getElementById('inline-category-save');
  const inlineCancel = document.getElementById('inline-category-cancel');
  const inlineError = document.getElementById('inline-category-error');
  const categorySelect = document.getElementById('f-category');

  if (inlineToggle && inlineBox && inlineName && inlineSave && categorySelect) {
    const csrf = (document.querySelector('input[name="_csrf"]') || {}).value || '';

    function resetInline() {
      inlineName.value = '';
      if (inlineError) inlineError.textContent = '';
    }

    inlineToggle.addEventListener('click', function () {
      inlineBox.hidden = !inlineBox.hidden;
      if (!inlineBox.hidden) inlineName.focus();
    });
    if (inlineCancel) {
      inlineCancel.addEventListener('click', function () {
        inlineBox.hidden = true;
        resetInline();
      });
    }
    inlineName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        inlineSave.click();
      }
    });
    inlineSave.addEventListener('click', async function () {
      const name = inlineName.value.trim();
      if (!name) {
        if (inlineError) inlineError.textContent = 'Escribe un nombre.';
        return;
      }
      const url = '/admin/categories?inline=1&_csrf=' + encodeURIComponent(csrf);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ name: name, _csrf: csrf }),
        });
        const data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) {
          const opt = document.createElement('option');
          opt.value = String(data.id);
          opt.textContent = data.name;
          categorySelect.appendChild(opt);
          categorySelect.value = String(data.id);
          inlineBox.hidden = true;
          resetInline();
        } else if (inlineError) {
          inlineError.textContent = data.error || 'No se pudo crear la categoría.';
        }
      } catch (err) {
        if (inlineError) inlineError.textContent = 'Error de red al crear la categoría.';
      }
    });
  }
})();
