// Spotlight + filtro de grupos (chips) combinado en AND.
// - Texto: filtra por nombre/descripción/categoría con debounce 200 ms.
// - Grupo: chip activo ('all' o un grupo del usuario).
// Función pura matchesAppFilter exportada para tests unitarios.
// Sin scripts inline (CSP 'self').
(function () {
  'use strict';

  // Función pura y testeable. app: { name, description, category, groups[] }.
  function matchesAppFilter(app, opts) {
    var options = opts || {};
    var group = options.group || 'all';
    var query = String(options.query || '').trim().toLowerCase();
    var groups = Array.isArray(app.groups) ? app.groups : [];

    var groupOk = group === 'all' || groups.some(function (g) {
      return String(g).toLowerCase() === String(group).toLowerCase();
    });
    if (!groupOk) return false;

    if (!query) return true;
    var name = String(app.name || '').toLowerCase();
    var desc = String(app.description || '').toLowerCase();
    var category = String(app.category || '').toLowerCase();
    return name.indexOf(query) !== -1 ||
      desc.indexOf(query) !== -1 ||
      category.indexOf(query) !== -1;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { matchesAppFilter };
  }

  if (typeof document === 'undefined') return;

  var input = document.getElementById('spotlight');
  if (!input) return;

  var cards = Array.from(document.querySelectorAll('.app-card'));
  var categories = Array.from(document.querySelectorAll('.category'));
  var chips = Array.from(document.querySelectorAll('.chip[data-group]'));

  var selectedGroup = 'all';
  var timer = null;

  var noResults = document.createElement('div');
  noResults.className = 'empty-state';
  noResults.innerHTML =
    '<div class="empty-state-icon" aria-hidden="true">&#9686;</div>' +
    '<h2 id="no-results-title">Sin resultados</h2>' +
    '<p id="no-results-text">Ninguna aplicación coincide con tu búsqueda.</p>' +
    '<button type="button" class="btn btn-ghost" id="clear-filters">Limpiar filtros</button>';
  noResults.id = 'no-results';
  noResults.hidden = true;
  input.parentElement.after(noResults);

  var clearBtn = document.getElementById('clear-filters');

  // Guarda el texto plano original para re-resaltar sin acumular <mark>.
  cards.forEach(function (card) {
    var name = card.querySelector('.app-name');
    var desc = card.querySelector('.app-desc');
    if (name) name.dataset.plain = name.textContent;
    if (desc) desc.dataset.plain = desc.textContent;
  });

  function highlight(el, query) {
    if (!el) return;
    var plain = el.dataset.plain || el.textContent;
    el.textContent = plain;
    if (!query) return;
    var lower = plain.toLowerCase();
    var idx = lower.indexOf(query);
    if (idx === -1) return;
    el.textContent = '';
    if (idx > 0) el.appendChild(document.createTextNode(plain.slice(0, idx)));
    var mark = document.createElement('mark');
    mark.textContent = plain.slice(idx, idx + query.length);
    el.appendChild(mark);
    if (idx + query.length < plain.length) {
      el.appendChild(document.createTextNode(plain.slice(idx + query.length)));
    }
  }

  function appFromCard(card) {
    var groups = [];
    try {
      var parsed = JSON.parse(card.dataset.appGroups || '[]');
      if (Array.isArray(parsed)) groups = parsed;
    } catch (e) {
      groups = [];
    }
    return {
      name: card.dataset.name || '',
      description: card.dataset.description || '',
      category: card.dataset.category || '',
      groups: groups,
    };
  }

  function isFiltering() {
    return selectedGroup !== 'all' || input.value.trim().length > 0;
  }

  function applyFilter() {
    var query = input.value.trim();
    var visibleCount = 0;

    cards.forEach(function (card) {
      var visible = matchesAppFilter(appFromCard(card), { group: selectedGroup, query: query });
      card.hidden = !visible;
      if (visible) {
        visibleCount += 1;
        highlight(card.querySelector('.app-name'), query.toLowerCase());
        highlight(card.querySelector('.app-desc'), query.toLowerCase());
      }
    });

    categories.forEach(function (cat) {
      var visibleInCat = Array.from(cat.querySelectorAll('.app-card')).filter(function (c) {
        return !c.hidden;
      });
      var countEl = cat.querySelector('.category-count');
      if (countEl) countEl.textContent = String(visibleInCat.length);
      cat.hidden = visibleInCat.length === 0;
    });

    if (visibleCount === 0 && isFiltering()) {
      document.getElementById('no-results-title').textContent = 'Sin aplicaciones';
      document.getElementById('no-results-text').textContent =
        'No hay aplicaciones en este grupo (o con ese término).';
      noResults.hidden = false;
    } else {
      noResults.hidden = true;
    }
  }

  function setChips(group) {
    selectedGroup = group;
    chips.forEach(function (chip) {
      var active = chip.dataset.group === group;
      chip.classList.toggle('chip-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      setChips(chip.dataset.group);
      applyFilter();
    });
  });

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(applyFilter, 200);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      input.value = '';
      setChips('all');
      applyFilter();
      input.focus();
    });
  }

  applyFilter();
})();
