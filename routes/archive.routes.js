const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../services/project-paths.service');
const {
  initAuditLogIfMissing,
  readAndRepairAuditEntries,
  resolveArchiveImagePath,
} = require('../services/audit.service');

const router = express.Router();

router.get('/api/archive/project', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filename = 'project';
  initAuditLogIfMissing(paths, 'project', filename);
  const entries = readAndRepairAuditEntries(paths, 'project', filename);
  return res.json(entries);
});

router.get('/api/archive/panos/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'pano', filename);
  const entries = readAndRepairAuditEntries(paths, 'pano', filename);
  return res.json(entries);
});

router.get('/api/archive/floorplans/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.floorplansDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'floorplan', filename);
  const entries = readAndRepairAuditEntries(paths, 'floorplan', filename);
  return res.json(entries);
});

router.get('/api/archive/images/:kind/:storedFilename', (req, res) => {
  const kindToken = req.params.kind;
  const storedFilename = req.params.storedFilename;
  const kind =
    kindToken === 'floorplan' || kindToken === 'floorplans'
      ? 'floorplan'
      : kindToken === 'pano' || kindToken === 'panos'
        ? 'pano'
        : null;
  if (!kind) return res.status(400).json({ error: 'Invalid archive image kind' });
  if (!storedFilename) return res.status(400).json({ error: 'storedFilename required' });
  if (storedFilename.includes('..') || storedFilename.includes('/') || storedFilename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid storedFilename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filePath = resolveArchiveImagePath(paths, kind, storedFilename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.resolve(filePath));
});

module.exports = router;
