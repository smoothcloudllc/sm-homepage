const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const auditService = require('../services/audit.service');

const router = express.Router();

// GET /admin/audit — auditoría paginada (solo super_admin).
router.get('/', requireAuth, requireRole('super_admin'), async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const pageSize = 25;
    const data = await auditService.listAudit(db, { page: isFinite(page) ? page : 1, pageSize });
    res.renderPage('admin/audit', {
      title: 'Auditoría',
      user: req.user,
      logs: data.rows,
      total: data.total,
      page: data.page,
      totalPages: data.totalPages,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
