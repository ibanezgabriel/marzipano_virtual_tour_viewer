const express = require('express');
const { parseOptionalInt } = require('../utils/parse');

function createApprovalRequestsRouter({ approvalRequestsService, requireApiAuth, requireSuperAdminApiAuth }) {
  const router = express.Router();

  router.get('/approval-requests', requireSuperAdminApiAuth, async (req, res) => {
    const q = String((req.query && req.query.q) || '').trim();
    const status = approvalRequestsService.normalizeApprovalStatus(req.query && req.query.status);
    const limitRaw = parseOptionalInt(req.query && req.query.limit, 50);
    const offsetRaw = parseOptionalInt(req.query && req.query.offset, 0);
    const limit = Math.max(1, Math.min(200, limitRaw));
    const offset = Math.max(0, offsetRaw);

    try {
      const data = await approvalRequestsService.listApprovalRequests({ q, status, limit, offset });
      res.json(data);
    } catch (e) {
      if (e && e.code === '42P01') {
        return res.json({ total: 0, rows: [] });
      }
      console.error('Error listing approval requests:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/projects/:id/request-approval', requireApiAuth, async (req, res) => {
    const projectId = String(req.params.id || '').trim();
    if (!projectId || projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
      return res.status(400).json({ success: false, message: 'Invalid project id' });
    }

    try {
      const result = await approvalRequestsService.createApprovalRequest({
        projectId,
        body: req.body,
        sessionUserId: req.session.userId,
        sessionUsername: req.session && req.session.username ? String(req.session.username) : null,
      });
      if (!result.ok) {
        return res.status(result.status).json(result.json);
      }
      res.json(result.json);
    } catch (e) {
      console.error('Error creating approval request:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  async function handleApprovalDecision(req, res, decision) {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: 'Invalid request id' });

    const comment = req.body && typeof req.body === 'object' ? req.body.comment : null;
    const commentValue = typeof comment === 'string' ? comment.trim() : '';

    try {
      const result = await approvalRequestsService.decideApproval({
        id,
        decision,
        commentValue,
        sessionUserId: req.session.userId,
        sessionUsername: req.session && req.session.username ? String(req.session.username) : null,
      });

      if (!result.ok) {
        return res.status(result.status).json(result.json);
      }

      res.json(result.json);
    } catch (e) {
      console.error('Error processing approval decision:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  }

  router.post('/approval-requests/:id/approve', requireSuperAdminApiAuth, (req, res) =>
    handleApprovalDecision(req, res, 'APPROVED')
  );
  router.post('/approval-requests/:id/reject', requireSuperAdminApiAuth, (req, res) =>
    handleApprovalDecision(req, res, 'REJECTED')
  );

  return router;
}

module.exports = createApprovalRequestsRouter;
