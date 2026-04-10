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

function mapImageKindToken(kindToken) {
  const t = String(kindToken || '').toLowerCase();
  if (t === 'floorplan' || t === 'floorplans' || t === 'layout' || t === 'layouts') return 'layout';
  if (t === 'pano' || t === 'panos') return 'pano';
  return null;
}

router.get('/api/audit-logs/project', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filename = 'project';
  initAuditLogIfMissing(paths, 'project', filename);
  const entries = readAndRepairAuditEntries(paths, 'project', filename);
  return res.json(entries);
});

router.get('/api/audit-logs/panos/:filename', (req, res) => {
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

router.get('/api/audit-logs/layouts/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.layoutsDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'layout', filename);
  const entries = readAndRepairAuditEntries(paths, 'layout', filename);
  return res.json(entries);
});

router.get('/api/audit-logs/images/:kind/:storedFilename', (req, res) => {
  const kindToken = req.params.kind;
  const storedFilename = req.params.storedFilename;
  const kind = mapImageKindToken(kindToken);
  if (!kind) return res.status(400).json({ error: 'Invalid audit log image kind' });
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
