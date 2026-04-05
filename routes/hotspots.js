const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  diffChangedTopLevelKeys,
  normalizeTopLevelArrayMap,
  getArrayCountByKey,
} = require('../utils/diff');

function createHotspotsRouter({
  db,
  io,
  projectsService,
  insertAuditLog,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  router.get('/hotspots', async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      const result = await db.query(
        `SELECT
           hs.id,
           src.filename AS source_filename,
           hs.yaw,
           hs.pitch,
           hs.rotation,
           tgt.filename AS target_filename
         FROM hotspots hs
         JOIN panoramas src ON src.id = hs.source_pano_id
         LEFT JOIN panoramas tgt ON tgt.id = hs.target_pano_id
         WHERE src.project_id = $1
         ORDER BY src.filename ASC, hs.id ASC`,
        [paths.projectId]
      );
      const out = {};
      result.rows.forEach((row) => {
        const source = row.source_filename;
        if (!source) return;
        if (!out[source]) out[source] = [];
        out[source].push({
          id: row.id,
          yaw: row.yaw,
          pitch: row.pitch,
          linkTo: row.target_filename || undefined,
        });
      });
      res.json(out);
    } catch (err) {
      console.error('Error getting hotspots:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/hotspots', requireApiAuth, async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });

    const normalizedBody = normalizeTopLevelArrayMap(body);

    const stripIds = (obj) => {
      const out = {};
      Object.entries(obj || {}).forEach(([key, list]) => {
        if (!Array.isArray(list)) return;
        out[key] = list.map((h) => ({
          yaw: Number(h.yaw),
          pitch: Number(h.pitch),
          linkTo: h.linkTo || undefined,
        }));
      });
      return out;
    };

    // Current DB state for audit comparison (ignore ids)
    const beforeStripped = {};
    try {
      const resDb = await db.query(
        `SELECT
           src.filename AS source_filename,
           hs.yaw,
           hs.pitch,
           tgt.filename AS target_filename
         FROM hotspots hs
         JOIN panoramas src ON src.id = hs.source_pano_id
         LEFT JOIN panoramas tgt ON tgt.id = hs.target_pano_id
         WHERE src.project_id = $1
         ORDER BY src.filename ASC, hs.id ASC`,
        [paths.projectId]
      );
      resDb.rows.forEach((row) => {
        const source = row.source_filename;
        if (!source) return;
        if (!beforeStripped[source]) beforeStripped[source] = [];
        beforeStripped[source].push({
          yaw: row.yaw,
          pitch: row.pitch,
          linkTo: row.target_filename || undefined,
        });
      });
    } catch (e) {}

    const strippedBody = stripIds(normalizedBody);
    const changed = diffChangedTopLevelKeys(beforeStripped, strippedBody);

    // Persist (DB is canonical; file is legacy/backup)
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const panoRes = await client.query(
        'SELECT id, filename FROM panoramas WHERE project_id = $1',
        [paths.projectId]
      );
      const panoIdByFilename = new Map(panoRes.rows.map((r) => [r.filename, r.id]));

      await client.query(
        `DELETE FROM hotspots
         WHERE source_pano_id IN (SELECT id FROM panoramas WHERE project_id = $1)`,
        [paths.projectId]
      );

      for (const [sourceFilename, list] of Object.entries(strippedBody)) {
        const sourceId = panoIdByFilename.get(sourceFilename);
        if (!sourceId || !Array.isArray(list)) continue;
        for (const h of list) {
          const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
          await client.query(
            'INSERT INTO hotspots (source_pano_id, target_pano_id, yaw, pitch, rotation) VALUES ($1, $2, $3, $4, $5)',
            [sourceId, targetId || null, Number(h.yaw), Number(h.pitch), 0]
          );
        }
      }

      await client.query('COMMIT');

      try {
        const json = JSON.stringify(normalizedBody, null, 2);
        await fs.promises.writeFile(paths.hotspotsPath, json, 'utf8');
      } catch (e) {}

      if (changed.length > 0) {
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'hotspots:update' });
      }
      res.json({ success: true, unchanged: changed.length === 0 });
      if (changed.length === 0) return;

      try { io.to(`project:${paths.projectId}`).emit('hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }

      try {
        changed.forEach((filename) => {
          const img = path.join(paths.uploadsDir, filename);
          if (!fs.existsSync(img)) return;
          const beforeCount = getArrayCountByKey(beforeStripped, filename);
          const afterCount = getArrayCountByKey(strippedBody, filename);
          const action = afterCount < beforeCount ? 'HOTSPOT_REMOVE' : 'HOTSPOT_ADD';
          const message =
            afterCount < beforeCount
              ? `Hotspot removed on ${filename}`
              : afterCount > beforeCount
                ? `Hotspot added on ${filename}`
                : `Hotspot updated on ${filename}`;
          insertAuditLog({
            projectId: paths.projectId,
            userId: req.session.userId,
            action,
            message,
            metadata: {
              feature: 'hotspot',
              asset_kind: 'pano',
              asset_name: filename,
              before_count: beforeCount,
              after_count: afterCount,
            },
          }).catch(() => {});
        });
      } catch (e) {}
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
      console.error('Error saving hotspots:', err);
      res.status(500).json({ error: 'Database error' });
    } finally {
      try { client.release(); } catch (e) {}
    }
  });

  return router;
}

module.exports = createHotspotsRouter;
