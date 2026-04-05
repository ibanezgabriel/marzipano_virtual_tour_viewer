const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveFloorplanImagePath } = require('../utils/layout-files');
const {
  readFloorplanOrder,
  writeFloorplanOrder,
  getOrderedFloorplanFilenames,
} = require('../services/layout-state');
const {
  diffChangedTopLevelKeys,
  normalizeTopLevelArrayMap,
  getArrayCountByKey,
} = require('../utils/diff');

function createLayoutsRouter({
  db,
  io,
  projectsService,
  legacyAuditLogService,
  insertAuditLog,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  async function handleLayoutRename(req, res) {
    const { oldFilename, newFilename } = req.body || {};
    if (!oldFilename || !newFilename) {
      return res.status(400).json({ success: false, message: 'Both old and new filenames are required' });
    }
    if (
      oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
      newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')
    ) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      return res.status(400).json({ success: false, message: 'Project required' });
    }

    const oldPath = resolveFloorplanImagePath(paths, oldFilename);
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    const newExists =
      (paths.layoutsDir && fs.existsSync(path.join(paths.layoutsDir, newFilename))) ||
      (paths.floorplansLegacyDir && fs.existsSync(path.join(paths.floorplansLegacyDir, newFilename)));
    if (newExists) {
      return res.status(409).json({ success: false, message: 'An image with this name already exists' });
    }
    const newPath = path.join(path.dirname(oldPath), newFilename);
    fs.rename(oldPath, newPath, (err) => {
      if (err) {
        console.error('Error renaming layout:', err);
        return res.status(500).json({ success: false, message: 'Error renaming file' });
      }
      try {
        const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
        const newOrder = order.map(f => f === oldFilename ? newFilename : f);
        writeFloorplanOrder(paths.layoutOrderPath, newOrder);
      } catch (e) {}
      try {
        legacyAuditLogService.renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
        legacyAuditLogService.appendAuditEntry(
          paths,
          'floorplan',
          newFilename,
          {
            action: 'rename',
            message: `Layout renamed from "${oldFilename}" to "${newFilename}".`,
          },
          { userId: req.session.userId }
        );
      } catch (e) {}
      markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout:rename' }).catch(() => {});
      return res.json({ success: true, message: 'Layout renamed successfully', oldFilename, newFilename });
    });
  }

  router.put('/floorplans/rename', requireApiAuth, handleLayoutRename);
  router.put('/layouts/rename', requireApiAuth, handleLayoutRename);

  async function handleLayoutsList(req, res) {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      const files = await getOrderedFloorplanFilenames(paths);
      res.json(files);
    } catch (e) {
      res.status(500).json({ error: 'Unable to list layouts' });
    }
  }

  router.get('/floorplans', handleLayoutsList);
  router.get('/layouts', handleLayoutsList);

  async function handleLayoutsOrder(req, res) {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    const body = req.body;
    if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
    const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
    if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
    try {
      const dir = path.dirname(paths.layoutOrderPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeFloorplanOrder(paths.layoutOrderPath, body.order);
      await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout:order' });
      res.json({ success: true });
      try {
        io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: body.order });
        io.to(`project:${paths.projectId}`).emit('layouts:order', { order: body.order });
      } catch (e) { console.error('Socket emit error:', e); }
    } catch (e) {
      console.error('Error writing floorplan order:', e);
      res.status(500).json({ error: 'Unable to save order' });
    }
  }

  router.put('/floorplans/order', requireApiAuth, handleLayoutsOrder);
  router.put('/layouts/order', requireApiAuth, handleLayoutsOrder);

  async function handleLayoutHotspotsGet(req, res) {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      const result = await db.query(
        `SELECT
           lh.id,
           l.filename AS layout_filename,
           lh.x_coord,
           lh.y_coord,
           p.filename AS target_filename
         FROM layout_hotspots lh
         JOIN layouts l ON l.id = lh.layout_id
         LEFT JOIN panoramas p ON p.id = lh.target_pano_id
         WHERE l.project_id = $1
         ORDER BY l.filename ASC, lh.id ASC`,
        [paths.projectId]
      );
      const out = {};
      result.rows.forEach((row) => {
        const layoutFilename = row.layout_filename;
        if (!layoutFilename) return;
        if (!out[layoutFilename]) out[layoutFilename] = [];
        out[layoutFilename].push({
          id: row.id,
          x: row.x_coord,
          y: row.y_coord,
          linkTo: row.target_filename || undefined,
        });
      });
      res.json(out);
    } catch (e) {
      console.error('Error getting layout hotspots:', e);
      res.status(500).json({ error: 'Database error' });
    }
  }

  async function handleLayoutHotspotsPost(req, res) {
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
          x: Number(h.x),
          y: Number(h.y),
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
           l.filename AS layout_filename,
           lh.x_coord,
           lh.y_coord,
           p.filename AS target_filename
         FROM layout_hotspots lh
         JOIN layouts l ON l.id = lh.layout_id
         LEFT JOIN panoramas p ON p.id = lh.target_pano_id
         WHERE l.project_id = $1
         ORDER BY l.filename ASC, lh.id ASC`,
        [paths.projectId]
      );
      resDb.rows.forEach((row) => {
        const layoutFilename = row.layout_filename;
        if (!layoutFilename) return;
        if (!beforeStripped[layoutFilename]) beforeStripped[layoutFilename] = [];
        beforeStripped[layoutFilename].push({
          x: row.x_coord,
          y: row.y_coord,
          linkTo: row.target_filename || undefined,
        });
      });
    } catch (e) {}

    const strippedBody = stripIds(normalizedBody);
    const changed = diffChangedTopLevelKeys(beforeStripped, strippedBody);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const panoRes = await client.query(
        'SELECT id, filename FROM panoramas WHERE project_id = $1',
        [paths.projectId]
      );
      const panoIdByFilename = new Map(panoRes.rows.map((r) => [r.filename, r.id]));

      const layoutRes = await client.query(
        'SELECT id, filename, rank FROM layouts WHERE project_id = $1',
        [paths.projectId]
      );
      const layoutIdByFilename = new Map(layoutRes.rows.map((r) => [r.filename, r.id]));

      const missingLayouts = Object.keys(strippedBody).filter((name) => name && !layoutIdByFilename.has(name));
      if (missingLayouts.length > 0) {
        const rankRes = await client.query(
          'SELECT COALESCE(MAX(rank), -1)::int as maxr FROM layouts WHERE project_id = $1',
          [paths.projectId]
        );
        let rank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;
        for (const filename of missingLayouts) {
          await client.query(
            `INSERT INTO layouts (project_id, filename, rank)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, filename) DO NOTHING`,
            [paths.projectId, filename, rank++]
          );
        }
        const refreshed = await client.query('SELECT id, filename FROM layouts WHERE project_id = $1', [paths.projectId]);
        refreshed.rows.forEach((r) => layoutIdByFilename.set(r.filename, r.id));
      }

      await client.query(
        `DELETE FROM layout_hotspots
         WHERE layout_id IN (SELECT id FROM layouts WHERE project_id = $1)`,
        [paths.projectId]
      );

      for (const [layoutFilename, list] of Object.entries(strippedBody)) {
        const layoutId = layoutIdByFilename.get(layoutFilename);
        if (!layoutId || !Array.isArray(list)) continue;
        for (const h of list) {
          const targetId = h.linkTo ? panoIdByFilename.get(h.linkTo) : null;
          await client.query(
            'INSERT INTO layout_hotspots (layout_id, target_pano_id, x_coord, y_coord) VALUES ($1, $2, $3, $4)',
            [layoutId, targetId || null, Number(h.x), Number(h.y)]
          );
        }
      }

      await client.query('COMMIT');

      try {
        const json = JSON.stringify(normalizedBody, null, 2);
        const dir = path.dirname(paths.layoutHotspotsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await fs.promises.writeFile(paths.layoutHotspotsPath, json, 'utf8');
      } catch (e) {}

      if (changed.length > 0) {
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout-hotspots:update' });
      }
      res.json({ success: true, unchanged: changed.length === 0 });
      if (changed.length === 0) return;

      try {
        io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', normalizedBody);
        io.to(`project:${paths.projectId}`).emit('layout-hotspots:changed', normalizedBody);
      } catch (e) { console.error('Socket emit error:', e); }

      try {
        changed.forEach((filename) => {
          const fp = resolveFloorplanImagePath(paths, filename);
          if (!fp || !fs.existsSync(fp)) return;
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
              asset_kind: 'layout',
              asset_name: filename,
              before_count: beforeCount,
              after_count: afterCount,
            },
          }).catch(() => {});
        });
      } catch (e) {}
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) {}
      console.error('Error saving layout hotspots:', err);
      res.status(500).json({ error: 'Database error' });
    } finally {
      try { client.release(); } catch (e) {}
    }
  }

  router.get('/floorplan-hotspots', handleLayoutHotspotsGet);
  router.get('/layout-hotspots', handleLayoutHotspotsGet);
  router.post('/floorplan-hotspots', requireApiAuth, handleLayoutHotspotsPost);
  router.post('/layout-hotspots', requireApiAuth, handleLayoutHotspotsPost);

  return router;
}

module.exports = createLayoutsRouter;
