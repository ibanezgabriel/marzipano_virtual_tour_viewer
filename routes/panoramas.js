const express = require('express');
const fs = require('fs');
const path = require('path');

function createPanoramasRouter({
  db,
  io,
  projectsService,
  markProjectModifiedIfPublished,
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  requireApiAuth,
}) {
  const router = express.Router();

  async function ensureTilesForFilename(paths, filename) {
    const meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
    if (meta) return meta;

    const imagePath = path.join(paths.uploadsDir, filename);
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image not found: ${filename}`);
    }

    await buildTilesForImage({
      imagePath,
      filename,
      tilesRootDir: paths.tilesDir
    });
    const builtMeta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
    if (!builtMeta) throw new Error('Tiles built but meta.json missing');
    return builtMeta;
  }

  router.get('/panos', async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    console.log(`[DEBUG] /api/panos: Fetching panoramas for project_id: '${paths.projectId}'`);
    try {
      const resultRes = await db.query(
        'SELECT filename FROM panoramas WHERE project_id = $1 AND is_active = true ORDER BY rank ASC', 
        [paths.projectId]
      );
      console.log(`[DEBUG] /api/panos: DB query returned ${resultRes.rows.length} rows.`);
      const files = resultRes.rows.map(r => r.filename);

      const result = [];
      for (const filename of files) {
        let meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
        result.push({
          filename,
          tileId: tileIdFromFilename(filename),
          tileReady: Boolean(meta),
          tileSize: meta?.tileSize,
          levels: meta?.levels,
          aspectOk: meta?.aspectOk
        });
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.put('/panos/order', requireApiAuth, async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    const body = req.body;
    if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
    const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
    if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
    try {
      for (let i = 0; i < body.order.length; i++) {
        const filename = body.order[i];
        await db.query('UPDATE panoramas SET rank = $1 WHERE project_id = $2 AND filename = $3', [i, paths.projectId, filename]);
      }
      await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'panorama:order' });
      res.json({ success: true });
      try { io.to(`project:${paths.projectId}`).emit('panos:order', { order: body.order }); } catch (e) { console.error('Socket emit error:', e); }
    } catch (e) {
      console.error('Error writing panorama order:', e);
      res.status(500).json({ error: 'Unable to save order' });
    }
  });

  router.get('/panos/:filename', async (req, res) => {
    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    try {
      const meta = await ensureTilesForFilename(paths, filename);
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return router;
}

module.exports = createPanoramasRouter;

