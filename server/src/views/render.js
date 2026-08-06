// Helper para renderizar páginas dentro del layout principal.
// Cada vista es un "partial" incluido por layouts/main.ejs mediante
// <%- include(view) %>. La ruta se expresa relativa a "layouts/".
function renderPage(res, view, locals) {
  res.render('layouts/main', { ...locals, view: `../${view}` });
}

module.exports = { renderPage };
