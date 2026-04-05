const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  stableStringify,
} = require('../utils/diff');

function createBlurMasksRouter({
  db,
  io,
  projectsService,
  insertAuditLog,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  function normalizeMaskEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = entry.id === undefined || entry.id === null ? null : Number(entry.id);
    const yaw = Number(entry.yaw);
    const pitch = Number(entry.pitch);
    const radiusRatio = Number(entry.radiusRatio);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(radiusRatio)) return null;
    const out = { yaw, pitch, radiusRatio };
    if (Number.isFinite(id)) out.id = id;
    return out;
  }

  function normalizeMaskList(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeMaskEntry).filter(Boolean);
  }

  function normalizeBlurMasksPayload(body) {
    const source = body && typeof body === 'object' ? body : {};
    const out = {};
    Object.entries(source).forEach(([filename, list]) => {
      if (!filename) return;
      if (!Array.isArray(list)) return;
      out[filename] = normalizeMaskList(list);
    });
    return out;
  }

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
      currentRes.rows.forEach(r => before[r.filename] = normalizeMaskList(r.blur_mask || []));
    } catch(e) {}

    const normalizedBody = normalizeBlurMasksPayload(body);
    const changed = Object.keys(normalizedBody).filter((filename) => {
      const beforeList = before && typeof before === 'object' ? before[filename] : [];
      const beforeNormalized = normalizeMaskList(beforeList);
      const afterNormalized = normalizedBody[filename] || [];
      return stableStringify(beforeNormalized) !== stableStringify(afterNormalized);
    });

    try {
      for (const filename of changed) {
        const maskData = JSON.stringify(normalizedBody[filename] || []);
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
          const beforeCount = Array.isArray(before[filename]) ? before[filename].length : 0;
          const afterCount = Array.isArray(normalizedBody[filename]) ? normalizedBody[filename].length : 0;
          if (beforeCount === 0 && afterCount === 0) return;
          const action = afterCount === 0 && beforeCount > 0 ? 'BLUR_REMOVE' : 'BLUR_APPLY';
          const message = action === 'BLUR_REMOVE' ? `Blur removed on ${filename}` : `Blur applied on ${filename}`;
          insertAuditLog({
            projectId: paths.projectId,
            userId: req.session.userId,
            action,
            message,
            metadata: {
              feature: 'blur',
              asset_kind: 'pano',
              asset_name: filename,
              before_count: beforeCount,
              after_count: afterCount,
            },
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

module.exports = createBlurMasksRouter;
