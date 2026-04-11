const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const {
  appendAuditEntry,
  buildAuditMeta,
  formatEditorAuditMessage,
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

router.get('/api/layout-hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.layoutHotspotsPath, 'Unable to read layout hotspots');
});

router.post('/api/layout-hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.layoutHotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.layoutHotspotsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.layoutHotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const layoutImagePath = path.join(paths.layoutsDir, filename);
        if (!fs.existsSync(layoutImagePath)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        if (beforeCount === afterCount) return;
        const action = afterCount > beforeCount ? 'Layout_Hotspot_Create' : 'Layout_Hotspot_Delete';
        const message = formatEditorAuditMessage(action, { filename });
        appendAuditEntry(
          paths,
          'layout',
          filename,
          {
            action,
            message,
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (_error) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    emitToProject(req.app, paths.projectId, 'layout-hotspots:changed', normalizedBody);
  } catch (error) {
    console.error('Layout hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save layout hotspots' });
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
        const action =
          afterCount > beforeCount
            ? 'Blur_Mask_Create'
            : afterCount < beforeCount
              ? 'Blur_Mask_Delete'
              : 'Blur_Mask_Update';
        const message = formatEditorAuditMessage(action, { filename });
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action,
            message,
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
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
        if (beforeCount === afterCount) return;
        const action = afterCount > beforeCount ? 'Pano_Hotspot_Create' : 'Pano_Hotspot_Delete';
        const message = formatEditorAuditMessage(action, { filename });
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action,
            message,
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
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
            action: 'Pano_Update',
            message: formatEditorAuditMessage('Pano_Update', { oldFilename: filename, newFilename: filename }),
            meta: buildAuditMeta({ initialView: true }, req.authUser),
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
