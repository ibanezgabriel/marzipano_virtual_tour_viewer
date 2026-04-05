const express = require('express');
const { parseOptionalInt } = require('../utils/parse');

function createNotificationsRouter({ db, approvalRequestsService, requireApiAuth }) {
  const router = express.Router();

  router.get('/notifications', requireApiAuth, async (req, res) => {
    const includeSeenRaw = String((req.query && req.query.includeSeen) || '').trim().toLowerCase();
    const includeSeen = includeSeenRaw === '1' || includeSeenRaw === 'true' || includeSeenRaw === 'yes';
    const limitRaw = parseOptionalInt(req.query && req.query.limit, 20);
    const limit = Math.max(1, Math.min(100, limitRaw));
    const userId = Number(req.session.userId);

    try {
      const supportsSeen = await approvalRequestsService.supportsApprovalRequestNotifications();

      if (supportsSeen) {
        const unseenRes = await db.query(
          `SELECT COUNT(*)::int AS unseen
           FROM approval_requests
           WHERE requester_id = $1
             AND UPPER(status) <> 'PENDING'
             AND requester_seen_at IS NULL`,
          [userId]
        );

        const where = [
          'ar.requester_id = $1',
          "UPPER(ar.status) <> 'PENDING'",
        ];
        const params = [userId];

        if (!includeSeen) {
          where.push('ar.requester_seen_at IS NULL');
        }

        params.push(limit);
        const rowsRes = await db.query(
          `SELECT
             ar.id,
             ar.project_id,
             ar.request_type,
             ar.status,
             ar.admin_comment,
             ar.created_at,
             ar.decided_at,
             ar.requester_seen_at,
             COALESCE(
               ar.decided_at,
               to_timestamp((NULLIF(ar.payload->>'decided_at_ms','')::double precision) / 1000.0),
               ar.created_at
             ) AS event_at,
             COALESCE(ar.payload->'project'->>'number', pj.number, '') AS project_number,
             COALESCE(ar.payload->'project'->>'name', pj.name, '') AS project_name,
             du.username AS decided_by
           FROM approval_requests ar
           LEFT JOIN projects pj ON pj.id = ar.project_id
           LEFT JOIN users du ON du.id = ar.decided_by
           WHERE ${where.join(' AND ')}
           ORDER BY COALESCE(ar.decided_at, ar.created_at) DESC, ar.id DESC
           LIMIT $2`,
          params
        );

        return res.json({
          supports_seen: true,
          unseen: unseenRes.rows[0]?.unseen ?? 0,
          rows: rowsRes.rows
        });
      }

      // Fallback: DB hasn't been migrated yet to support "seen" tracking.
      // Still return the latest decisions so the admin can view them. The frontend will
      // compute "unseen" client-side using localStorage (best-effort).
      const rowsRes = await db.query(
        `SELECT
           ar.id,
           ar.project_id,
           ar.request_type,
           ar.status,
           ar.admin_comment,
           ar.created_at,
           to_timestamp((NULLIF(ar.payload->>'decided_at_ms','')::double precision) / 1000.0) AS decided_at,
           NULL::timestamp AS requester_seen_at,
           COALESCE(
             to_timestamp((NULLIF(ar.payload->>'decided_at_ms','')::double precision) / 1000.0),
             ar.created_at
           ) AS event_at,
           COALESCE(ar.payload->'project'->>'number', pj.number, '') AS project_number,
           COALESCE(ar.payload->'project'->>'name', pj.name, '') AS project_name,
           COALESCE(NULLIF(ar.payload->>'decided_by',''), NULL)::text AS decided_by
         FROM approval_requests ar
         LEFT JOIN projects pj ON pj.id = ar.project_id
         WHERE ar.requester_id = $1
           AND UPPER(ar.status) <> 'PENDING'
         ORDER BY ar.created_at DESC, ar.id DESC
         LIMIT $2`,
        [userId, limit]
      );

      res.json({ supports_seen: false, unseen: 0, rows: rowsRes.rows });
    } catch (e) {
      if (e && e.code === '42P01') {
        return res.json({ supports_seen: false, unseen: 0, rows: [] });
      }
      console.error('Error listing notifications:', e);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/notifications/:id/read', requireApiAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = Number(req.session.userId);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, message: 'Invalid notification id' });

    try {
      if (!(await approvalRequestsService.supportsApprovalRequestNotifications())) {
        return res.json({ success: true, updated: 0 });
      }
      const result = await db.query(
        'UPDATE approval_requests SET requester_seen_at = NOW() WHERE id = $1 AND requester_id = $2 AND requester_seen_at IS NULL',
        [id, userId]
      );
      res.json({ success: true, updated: result.rowCount });
    } catch (e) {
      if (e && e.code === '42P01') {
        return res.json({ success: true, updated: 0 });
      }
      console.error('Error marking notification read:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  router.post('/notifications/read-all', requireApiAuth, async (req, res) => {
    const userId = Number(req.session.userId);
    try {
      if (!(await approvalRequestsService.supportsApprovalRequestNotifications())) {
        return res.json({ success: true, updated: 0 });
      }
      const result = await db.query(
        `UPDATE approval_requests
         SET requester_seen_at = NOW()
         WHERE requester_id = $1
           AND UPPER(status) <> 'PENDING'
           AND requester_seen_at IS NULL`,
        [userId]
      );
      res.json({ success: true, updated: result.rowCount });
    } catch (e) {
      if (e && e.code === '42P01') {
        return res.json({ success: true, updated: 0 });
      }
      console.error('Error marking notifications read:', e);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;

