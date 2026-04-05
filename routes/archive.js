const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveFloorplanImagePath } = require('../utils/layout-files');

function createArchiveRouter({ projectsService, legacyAuditLogService }) {
  const router = express.Router();

  router.get('/archive/panos/:filename', async (req, res) => {
    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    const imagePath = path.join(paths.uploadsDir, filename);
    if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
    legacyAuditLogService.initAuditLogIfMissing(paths, 'pano', filename);
    const entries = legacyAuditLogService.readAndRepairAuditEntries(paths, 'pano', filename);
    res.json(entries);
  });

  async function handleArchiveLayouts(req, res) {
    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    const imagePath = resolveFloorplanImagePath(paths, filename);
    if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
    legacyAuditLogService.initAuditLogIfMissing(paths, 'floorplan', filename);
    const entries = legacyAuditLogService.readAndRepairAuditEntries(paths, 'floorplan', filename);
    res.json(entries);
  }

  router.get('/archive/floorplans/:filename', handleArchiveLayouts);
  router.get('/archive/layouts/:filename', handleArchiveLayouts);

  router.get('/archive/images/:kind/:storedFilename', async (req, res) => {
    const kindToken = req.params.kind;
    const storedFilename = req.params.storedFilename;
    const kind =
      kindToken === 'floorplan' || kindToken === 'floorplans' || kindToken === 'layout' || kindToken === 'layouts'
        ? 'floorplan'
        : kindToken === 'pano' || kindToken === 'panos'
          ? 'pano'
          : null;
    if (!kind) return res.status(400).json({ error: 'Invalid archive image kind' });
    if (!storedFilename) return res.status(400).json({ error: 'storedFilename required' });
    if (storedFilename.includes('..') || storedFilename.includes('/') || storedFilename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid storedFilename' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    const filePath = legacyAuditLogService.resolveArchiveImagePath(paths, kind, storedFilename);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.resolve(filePath));
  });

  return router;
}

module.exports = createArchiveRouter;

