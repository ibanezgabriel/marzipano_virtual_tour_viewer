const express = require('express');
const fs = require('fs');
const path = require('path');
const { stableStringify } = require('../utils/diff');

function createInitialViewsRouter({
  db,
  io,
  projectsService,
  insertAuditLog,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  router.get('/initial-views', async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      const result = await db.query('SELECT filename, initial_view FROM panoramas WHERE project_id = $1', [paths.projectId]);
      const out = {};
      result.rows.forEach(r => {
        out[r.filename] = r.initial_view || {};
      });
      res.json(out);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/initial-views', requireApiAuth, async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    
    let before = {};
    try {
      const currentRes = await db.query('SELECT filename, initial_view FROM panoramas WHERE project_id = $1', [paths.projectId]);
      currentRes.rows.forEach(r => before[r.filename] = r.initial_view || {});
    } catch(e) {}

    const changed = Object.keys(body).filter((filename) => {
      const beforeValue = before && typeof before === 'object' ? before[filename] : undefined;
      const afterValue = body && typeof body === 'object' ? body[filename] : undefined;
      const beforeNormalized = beforeValue && typeof beforeValue === 'object' ? beforeValue : {};
      const afterNormalized = afterValue && typeof afterValue === 'object' ? afterValue : {};
      return stableStringify(beforeNormalized) !== stableStringify(afterNormalized);
    });

    try {
      for (const filename of Object.keys(body)) {
        const viewData = JSON.stringify(body[filename]);
        await db.query('UPDATE panoramas SET initial_view = $1 WHERE project_id = $2 AND filename = $3', 
          [viewData, paths.projectId, filename]);
      }

      if (changed.length > 0) {
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'initial-views:update' });
      }
      res.json({ success: true });
      try { io.to(`project:${paths.projectId}`).emit('initial-views:changed', body); } catch (e) { console.error('Socket emit error:', e); }
      try {
        changed.forEach((filename) => {
          const img = path.join(paths.uploadsDir, filename);
          if (!fs.existsSync(img)) return;
          insertAuditLog({
            projectId: paths.projectId,
            userId: req.session.userId,
            action: 'VIEW_SET',
            message: `Initial view set on ${filename}`,
            metadata: { feature: 'initial_view', asset_kind: 'pano', asset_name: filename },
          }).catch(() => {});
        });
      } catch (e) {}
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  return router;
}

module.exports = createInitialViewsRouter;
