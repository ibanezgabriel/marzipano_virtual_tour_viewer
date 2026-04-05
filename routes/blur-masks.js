const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  diffChangedTopLevelKeys,
  normalizeTopLevelArrayMap,
  getArrayCountByKey,
  buildCollectionChangeMessage,
} = require('../utils/diff');

function createBlurMasksRouter({
  db,
  io,
  projectsService,
  legacyAuditLogService,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  router.get('/blur-masks', async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      const result = await db.query('SELECT filename, blur_mask FROM panoramas WHERE project_id = $1', [paths.projectId]);
      const out = {};
      result.rows.forEach(r => {
        out[r.filename] = r.blur_mask || [];
      });
      res.json(out);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/blur-masks', requireApiAuth, async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    
    let before = {};
    try {
      const currentRes = await db.query('SELECT filename, blur_mask FROM panoramas WHERE project_id = $1', [paths.projectId]);
      currentRes.rows.forEach(r => before[r.filename] = r.blur_mask || []);
    } catch(e) {}

    const normalizedBody = normalizeTopLevelArrayMap(body);
    const changed = diffChangedTopLevelKeys(before, normalizedBody);

    try {
      for (const filename of Object.keys(normalizedBody)) {
        const maskData = JSON.stringify(normalizedBody[filename]);
        await db.query('UPDATE panoramas SET blur_mask = $1 WHERE project_id = $2 AND filename = $3', 
          [maskData, paths.projectId, filename]);
      }

      if (changed.length > 0) {
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'blur-masks:update' });
      }
      res.json({ success: true, unchanged: changed.length === 0 });

      if (changed.length === 0) return;
      try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
      try {
        changed.forEach((filename) => {
          const img = path.join(paths.uploadsDir, filename);
          if (!fs.existsSync(img)) return;
          const beforeCount = getArrayCountByKey(before, filename);
          const afterCount = getArrayCountByKey(normalizedBody, filename);
          const message = buildCollectionChangeMessage('Blur mask', 'blur masks', beforeCount, afterCount);
          legacyAuditLogService.appendAuditEntry(
            paths,
            'pano',
            filename,
            { action: 'blur', message },
            { dedupeWindowMs: 15000, userId: req.session.userId }
          );
        });
      } catch (e) {}
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  return router;
}

module.exports = createBlurMasksRouter;

