const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const {
  appendAuditEntry,
  buildAuditMeta,
  buildCollectionChangeMessage,
  diffChangedTopLevelKeys,
  getArrayCountByKey,
  normalizeTopLevelArrayMap,
  readJsonFileOrDefault,
} = require('../services/audit.service');

const router = express.Router();

function readObjectFile(res, filePath, errorMessage) {
  fs.readFile(filePath, 'utf8', (error, data) => {
    if (error) {
      if (error.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: errorMessage });
    }
    try {
      const obj = JSON.parse(data);
      return res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (_parseError) {
      return res.json({});
    }
  });
}

router.get('/api/hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.hotspotsPath, 'Unable to read hotspots');
});

router.get('/api/blur-masks', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.blurMasksPath, 'Unable to read blur masks');
});

router.get('/api/floorplan-hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.floorplanHotspotsPath, 'Unable to read floor plan hotspots');
});

router.post('/api/floorplan-hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.floorplanHotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.floorplanHotspotsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.floorplanHotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const floorplanPath = path.join(paths.floorplansDir, filename);
        if (!fs.existsSync(floorplanPath)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Floor plan hotspot', 'floor plan hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'floorplan',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (_error) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    emitToProject(req.app, paths.projectId, 'floorplan-hotspots:changed', normalizedBody);
  } catch (error) {
    console.error('Floor plan hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save floor plan hotspots' });
  }
});

router.post('/api/blur-masks', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.blurMasksPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.blurMasksPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.blurMasksPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const imagePath = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(imagePath)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        if (beforeCount === afterCount) return;
        const message = buildCollectionChangeMessage('Blur mask', 'blur masks', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'blur',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 15000 }
        );
      });
    } catch (_error) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    emitToProject(req.app, paths.projectId, 'blur-masks:changed', normalizedBody);
  } catch (error) {
    console.error('Blur mask save failed:', error);
    return res.status(500).json({ error: 'Unable to save blur masks' });
  }
});

router.post('/api/hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.hotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  try {
    await fs.promises.mkdir(path.dirname(paths.hotspotsPath), { recursive: true });
    await fs.promises.writeFile(paths.hotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const imagePath = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(imagePath)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Hotspot', 'hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (_error) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    emitToProject(req.app, paths.projectId, 'hotspots:changed', normalizedBody);
  } catch (error) {
    console.error('Hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save hotspots' });
  }
});

router.get('/api/initial-views', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.initialViewsPath, 'Unable to read initial views');
});

router.post('/api/initial-views', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const before = readJsonFileOrDefault(paths.initialViewsPath, {});
  const changed = diffChangedTopLevelKeys(before, body);
  const json = JSON.stringify(body, null, 2);
  const dir = path.dirname(paths.initialViewsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.initialViewsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const imagePath = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(imagePath)) return;
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'initial-view',
            message: 'Initial view saved.',
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 3000 }
        );
      });
    } catch (_error) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true });
    emitToProject(req.app, paths.projectId, 'initial-views:changed', body);
  } catch (error) {
    console.error('Initial view save failed:', error);
    return res.status(500).json({ error: 'Unable to save initial views' });
  }
});

module.exports = router;
