const express = require('express');
const { parseOptionalInt } = require('../utils/parse');

function createAuditLogsRouter({ auditLogsService, requireSuperAdminApiAuth }) {
  const router = express.Router();

  router.get('/audit-logs', requireSuperAdminApiAuth, async (req, res) => {
    const q = String((req.query && req.query.q) || '').trim();
    const limitRaw = parseOptionalInt(req.query && req.query.limit, 50);
    const offsetRaw = parseOptionalInt(req.query && req.query.offset, 0);
    const limit = Math.max(1, Math.min(200, limitRaw));
    const offset = Math.max(0, offsetRaw);

    try {
      const data = await auditLogsService.listAuditLogs({ q, limit, offset });
      res.json(data);
    } catch (e) {
      // If migrations haven't been applied yet, return an empty list instead of failing the UI.
      if (e && e.code === '42P01') {
        return res.json({ total: 0, rows: [] });
      }
      console.error('Error listing audit logs:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  return router;
}

module.exports = createAuditLogsRouter;

