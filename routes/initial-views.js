const express = require('express');
const fs = require('fs');
const path = require('path');
const { diffChangedTopLevelKeys } = require('../utils/diff');

function createInitialViewsRouter({ db, io, projectsService, legacyAuditLogService, requireApiAuth }) {
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

    const changed = diffChangedTopLevelKeys(before, body);

    try {
      for (const filename of Object.keys(body)) {
        const viewData = JSON.stringify(body[filename]);
        await db.query('UPDATE panoramas SET initial_view = $1 WHERE project_id = $2 AND filename = $3', 
          [viewData, paths.projectId, filename]);
      }

      res.json({ success: true });
      try { io.to(`project:${paths.projectId}`).emit('initial-views:changed', body); } catch (e) { console.error('Socket emit error:', e); }
      try {
        changed.forEach((filename) => {
          const img = path.join(paths.uploadsDir, filename);
          if (!fs.existsSync(img)) return;
          legacyAuditLogService.appendAuditEntry(
            paths,
            'pano',
            filename,
            { action: 'initial-view', message: 'Initial view saved.' },
            { dedupeWindowMs: 3000, userId: req.session.userId }
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

module.exports = createInitialViewsRouter;

