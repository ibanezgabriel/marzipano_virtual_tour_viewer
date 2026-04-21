/* Registers routes for the project editor pages. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const { attachAuthenticatedUser } = require('../middleware/auth.middleware');
const { getHiddenPanosSet } = require('../services/project-media.service');
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

router.use(attachAuthenticatedUser);

// In-memory per-file lock to serialize writes and avoid duplicate audit entries
// when multiple identical POSTs arrive nearly simultaneously (e.g., retry/refresh/race).
const fileWriteLocks = new Map();

function withFileWriteLock(lockKey, task) {
  const key = String(lockKey || '').trim();
  if (!key) return task();
  const prev = fileWriteLocks.get(key);
  const start = prev ? prev.catch(() => {}) : Promise.resolve();
  const next = start.then(() => task());
  fileWriteLocks.set(key, next);
  next.finally(() => {
    if (fileWriteLocks.get(key) === next) fileWriteLocks.delete(key);
  });
  return next;
}

/* Handles round hotspot number. */
function roundHotspotNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10000) / 10000;
}

/* Handles hotspot entry key. */
function hotspotEntryKey(entry, kind) {
  if (!entry || typeof entry !== 'object') return null;
  const id = Number(entry.id);
  if (Number.isFinite(id)) return `id:${id}`;
  const linkTo = typeof entry.linkTo === 'string' ? entry.linkTo : '';
  const label = typeof entry.label === 'string' ? entry.label : '';
  if (kind === 'layout') {
    return `legacy:${linkTo}:${label}:${roundHotspotNumber(entry.x)}:${roundHotspotNumber(entry.y)}`;
  }
  return `legacy:${linkTo}:${label}:${roundHotspotNumber(entry.yaw)}:${roundHotspotNumber(entry.pitch)}`;
}

/* Handles diff hotspot entry keys. */
function diffHotspotEntryKeys(beforeList, afterList, kind) {
  const beforeCounts = new Map();
  const afterCounts = new Map();
  (Array.isArray(beforeList) ? beforeList : []).forEach((entry) => {
    const key = hotspotEntryKey(entry, kind);
    if (!key) return;
    beforeCounts.set(key, (beforeCounts.get(key) || 0) + 1);
  });
  (Array.isArray(afterList) ? afterList : []).forEach((entry) => {
    const key = hotspotEntryKey(entry, kind);
    if (!key) return;
    afterCounts.set(key, (afterCounts.get(key) || 0) + 1);
  });
  const created = [];
  const deleted = [];
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  keys.forEach((key) => {
    const beforeCount = beforeCounts.get(key) || 0;
    const afterCount = afterCounts.get(key) || 0;
    if (afterCount > beforeCount) {
      for (let i = 0; i < afterCount - beforeCount; i++) created.push(key);
    } else if (beforeCount > afterCount) {
      for (let i = 0; i < beforeCount - afterCount; i++) deleted.push(key);
    }
  });
  return { created, deleted };
}

/* Handles blur mask entry key. */
function blurMaskEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = Number(entry.id);
  if (Number.isFinite(id)) return `id:${id}`;
  return `legacy:${roundHotspotNumber(entry.yaw)}:${roundHotspotNumber(entry.pitch)}:${roundHotspotNumber(entry.radiusRatio)}`;
}

/* Handles blur mask entry fingerprint. */
function blurMaskEntryFingerprint(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return `${roundHotspotNumber(entry.yaw)}|${roundHotspotNumber(entry.pitch)}|${roundHotspotNumber(entry.radiusRatio)}`;
}

/* Handles diff blur mask entries. */
function diffBlurMaskEntries(beforeList, afterList) {
  const beforeMap = new Map();
  const afterMap = new Map();
  (Array.isArray(beforeList) ? beforeList : []).forEach((entry) => {
    const key = blurMaskEntryKey(entry);
    if (!key) return;
    beforeMap.set(key, blurMaskEntryFingerprint(entry));
  });
  (Array.isArray(afterList) ? afterList : []).forEach((entry) => {
    const key = blurMaskEntryKey(entry);
    if (!key) return;
    afterMap.set(key, blurMaskEntryFingerprint(entry));
  });
  const created = [];
  const deleted = [];
  const updated = [];
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  keys.forEach((key) => {
    const beforeFp = beforeMap.get(key);
    const afterFp = afterMap.get(key);
    if (beforeFp === undefined && afterFp !== undefined) {
      created.push(key);
      return;
    }
    if (beforeFp !== undefined && afterFp === undefined) {
      deleted.push(key);
      return;
    }
    if (beforeFp !== undefined && afterFp !== undefined && beforeFp !== afterFp) {
      updated.push(key);
    }
  });
  return { created, deleted, updated };
}

function filterPanoramaHotspotsForResponse(data, hiddenSet, { authenticated } = {}) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  Object.keys(data).forEach((key) => {
    if (hiddenSet && hiddenSet.has(key)) return;
    const list = Array.isArray(data[key]) ? data[key] : [];
    const next = [];
    list.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const linkTo = typeof entry.linkTo === 'string' ? entry.linkTo : '';
      if (linkTo && hiddenSet && hiddenSet.has(linkTo)) {
        if (authenticated) {
          next.push({ ...entry, linkTo: undefined });
        }
        return;
      }
      if (!authenticated && !linkTo) return;
      next.push(entry);
    });
    if (next.length > 0) out[key] = next;
  });
  return out;
}

function filterLayoutHotspotsForResponse(data, hiddenSet, { authenticated } = {}) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  Object.keys(data).forEach((key) => {
    const list = Array.isArray(data[key]) ? data[key] : [];
    const next = [];
    list.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const linkTo = typeof entry.linkTo === 'string' ? entry.linkTo : '';
      if (linkTo && hiddenSet && hiddenSet.has(linkTo)) {
        if (authenticated) {
          next.push({ ...entry, linkTo: undefined });
        }
        return;
      }
      if (!authenticated && !linkTo) return;
      next.push(entry);
    });
    if (next.length > 0) out[key] = next;
  });
  return out;
}

function findHiddenLinkTargets(body, hiddenSet) {
  const found = new Set();
  if (!body || typeof body !== 'object') return found;
  Object.values(body).forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((entry) => {
      const linkTo = entry && typeof entry === 'object' && typeof entry.linkTo === 'string'
        ? entry.linkTo
        : '';
      if (linkTo && hiddenSet && hiddenSet.has(linkTo)) found.add(linkTo);
    });
  });
  return found;
}

/* Gets read object file. */
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

/* Wires HTTP endpoints to their controller handlers. */
router.get('/api/hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return fs.promises.readFile(paths.hotspotsPath, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw);
      const hiddenSet = getHiddenPanosSet(paths);
      const authenticated = Boolean(req.authUser);
      return res.json(filterPanoramaHotspotsForResponse(parsed, hiddenSet, { authenticated }));
    })
    .catch((error) => {
      if (error && error.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read hotspots' });
    });
});

router.get('/api/blur-masks', (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Unauthorized' });
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.blurMasksPath, 'Unable to read blur masks');
});

router.get('/api/layout-hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return fs.promises.readFile(paths.layoutHotspotsPath, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw);
      const hiddenSet = getHiddenPanosSet(paths);
      const authenticated = Boolean(req.authUser);
      return res.json(filterLayoutHotspotsForResponse(parsed, hiddenSet, { authenticated }));
    })
    .catch((error) => {
      if (error && error.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read layout hotspots' });
    });
});

router.post('/api/layout-hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const hiddenSet = getHiddenPanosSet(paths);
  const hiddenTargets = findHiddenLinkTargets(body, hiddenSet);
  if (hiddenTargets.size > 0) {
    return res.status(400).json({ error: `Cannot link hotspots to hidden panoramas: ${Array.from(hiddenTargets).join(', ')}` });
  }
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
        const beforeList = before && before[filename];
        const afterList = normalizedBody && normalizedBody[filename];
        const beforeCount = Array.isArray(beforeList) ? beforeList.length : 0;
        const afterCount = Array.isArray(afterList) ? afterList.length : 0;
        const { created, deleted } = diffHotspotEntryKeys(beforeList, afterList, 'layout');

        created.forEach(() => {
          const action = 'Layout_Hotspot_Create';
          appendAuditEntry(paths, 'layout', filename, {
            action,
            message: formatEditorAuditMessage(action, { filename }),
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          });
        });

        deleted.forEach(() => {
          const action = 'Layout_Hotspot_Delete';
          appendAuditEntry(paths, 'layout', filename, {
            action,
            message: formatEditorAuditMessage(action, { filename }),
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          });
        });
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
        const beforeList = before && before[filename];
        const afterList = normalizedBody && normalizedBody[filename];
        const beforeCount = Array.isArray(beforeList) ? beforeList.length : 0;
        const afterCount = Array.isArray(afterList) ? afterList.length : 0;
        const { created, deleted, updated } = diffBlurMaskEntries(beforeList, afterList);

        created.forEach(() => {
          const action = 'Blur_Mask_Create';
          appendAuditEntry(paths, 'pano', filename, {
            action,
            message: formatEditorAuditMessage(action, { filename }),
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          });
        });

        deleted.forEach(() => {
          const action = 'Blur_Mask_Delete';
          appendAuditEntry(paths, 'pano', filename, {
            action,
            message: formatEditorAuditMessage(action, { filename }),
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          });
        });

        updated.forEach(() => {
          const action = 'Blur_Mask_Update';
          appendAuditEntry(paths, 'pano', filename, {
            action,
            message: formatEditorAuditMessage(action, { filename }),
            meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
          });
        });
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
  const hiddenSet = getHiddenPanosSet(paths);
  const hiddenTargets = findHiddenLinkTargets(body, hiddenSet);
  if (hiddenTargets.size > 0) {
    return res.status(400).json({ error: `Cannot link hotspots to hidden panoramas: ${Array.from(hiddenTargets).join(', ')}` });
  }
  return withFileWriteLock(paths.hotspotsPath, async () => {
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
          const beforeList = before && before[filename];
          const afterList = normalizedBody && normalizedBody[filename];
          const beforeCount = Array.isArray(beforeList) ? beforeList.length : 0;
          const afterCount = Array.isArray(afterList) ? afterList.length : 0;
          const { created, deleted } = diffHotspotEntryKeys(beforeList, afterList, 'pano');

          created.forEach(() => {
            const action = 'Pano_Hotspot_Create';
            appendAuditEntry(paths, 'pano', filename, {
              action,
              message: formatEditorAuditMessage(action, { filename }),
              meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
            });
          });

          deleted.forEach(() => {
            const action = 'Pano_Hotspot_Delete';
            appendAuditEntry(paths, 'pano', filename, {
              action,
              message: formatEditorAuditMessage(action, { filename }),
              meta: buildAuditMeta({ beforeCount, afterCount }, req.authUser),
            });
          });
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
});

router.get('/api/initial-views', (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Unauthorized' });
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  return readObjectFile(res, paths.initialViewsPath, 'Unable to read initial views');
});

router.post('/api/initial-views', async (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Unauthorized' });
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
        const action = 'Pano_Initial_View_Set';
        appendAuditEntry(paths, 'pano', filename, {
          action,
          message: formatEditorAuditMessage(action, { filename }),
          meta: buildAuditMeta({ initialView: true }, req.authUser),
        });
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
