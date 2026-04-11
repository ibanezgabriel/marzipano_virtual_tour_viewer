const express = require('express');
const fs = require('fs');
const path = require('path');
const { panoramaUpload } = require('../middleware/upload.middleware');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const { createJob } = require('../services/job.service');
const {
  appendAuditEntry,
  buildAuditMeta,
  formatEditorAuditMessage,
  renameAuditLog,
  storeReplacedImageInAudit,
} = require('../services/audit.service');
const {
  listUploadedImages,
  getOrderedFilenames,
  writePanoramaOrder,
  panoramaOrderAppend,
  panoramaOrderReplace,
  ensureTilesForFilename,
  renameBlurMasksForPano,
} = require('../services/project-media.service');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists,
} = require('../public/js/tiler');

const router = express.Router();

router.post('/upload', panoramaUpload.array('panorama', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'no file uploaded' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }

  const filenames = req.files.map((file) => file.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'pano', name, {
        action: 'Pano_Upload',
        message: formatEditorAuditMessage('Pano_Upload', { filename: name }),
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (_error) {}

  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after panorama upload:', error);
    return res.status(500).json({ success: false, message: 'Panorama uploaded, but database sync failed.' });
  }

  const job = createJob(filenames, paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    uploaded: filenames,
  });

  (async () => {
    try {
      let overall = 0;
      const totalFiles = filenames.length;
      for (let index = 0; index < filenames.length; index += 1) {
        const name = filenames[index];
        job.message = `Processing ${name} (${index + 1}/${totalFiles})`;
        await buildTilesForImage({
          imagePath: path.join(paths.uploadsDir, name),
          filename: name,
          tilesRootDir: paths.tilesDir,
          onProgress: (fraction) => {
            const combined = ((index + fraction) / totalFiles) * 100;
            if (combined > overall) overall = combined;
            job.percent = Math.min(100, Math.max(0, Math.round(overall)));
          },
        });
      }
      panoramaOrderAppend(paths, filenames);
      emitToProject(req.app, paths.projectId, 'panos:ready', { filenames });
      job.percent = 100;
      job.status = 'done';
      job.message = 'Completed';
    } catch (error) {
      console.error('Tile generation failed:', error);
      const message = `Tile generation failed: ${error.message || error}`;
      job.status = 'error';
      job.error = message;
      job.message = message;
    }
  })();
});

router.get('/upload', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const images = await listUploadedImages(paths.uploadsDir);
    return res.json(images);
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to read directory' });
  }
});

router.get('/api/panos', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const files = await getOrderedFilenames(paths);
    const result = [];
    for (const filename of files) {
      const meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
      result.push({
        filename,
        tileId: tileIdFromFilename(filename),
        tileReady: Boolean(meta),
        tileSize: meta?.tileSize,
        levels: meta?.levels,
        aspectOk: meta?.aspectOk,
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.put('/api/panos/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every((filename) => typeof filename === 'string' && filename.length > 0 && !filename.includes('..') && !/[\\\/]/.test(filename));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    const dir = path.dirname(paths.panoramaOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writePanoramaOrder(paths.panoramaOrderPath, body.order);
    res.json({ success: true });
    emitToProject(req.app, paths.projectId, 'panos:order', { order: body.order });
  } catch (error) {
    console.error('Error writing panorama order:', error);
    return res.status(500).json({ error: 'Unable to save order' });
  }
});

router.get('/api/panos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const meta = await ensureTilesForFilename(paths, filename);
    return res.json(meta);
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});

router.put('/upload/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body;

  if (!oldFilename || !newFilename) {
    return res.status(400).json({ success: false, message: 'Both old and new filenames are required' });
  }

  if (
    oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
    newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')
  ) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }

  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }

  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  const newFilePath = path.join(paths.uploadsDir, newFilename);

  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }

  if (fs.existsSync(newFilePath)) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }

  try {
    await fs.promises.rename(oldFilePath, newFilePath);
    const oldTileId = tileIdFromFilename(oldFilename);
    const newTileId = tileIdFromFilename(newFilename);
    const oldTilesPath = path.join(paths.tilesDir, oldTileId);
    const newTilesPath = path.join(paths.tilesDir, newTileId);
    if (fs.existsSync(oldTilesPath) && !fs.existsSync(newTilesPath)) {
      try {
        fs.renameSync(oldTilesPath, newTilesPath);
        const metaPath = path.join(newTilesPath, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          meta.filename = newFilename;
          meta.id = newTileId;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        }
      } catch (error) {
        console.error('Error renaming tiles folder:', error);
      }
    }

    panoramaOrderReplace(paths, oldFilename, newFilename);
    const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
    if (blurRename.changed) {
      emitToProject(req.app, paths.projectId, 'blur-masks:changed', blurRename.blurMasks);
    }
    try {
      renameAuditLog(paths, 'pano', oldFilename, newFilename);
      appendAuditEntry(paths, 'pano', newFilename, {
        action: 'Pano_Rename',
        message: formatEditorAuditMessage('Pano_Rename', { oldFilename, newFilename }),
        meta: buildAuditMeta({ renamed: { oldFilename, newFilename } }, req.authUser),
      });
    } catch (_error) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after panorama rename:', error);
      return res.status(500).json({ success: false, message: 'Panorama renamed, but database sync failed.' });
    }
    emitToProject(req.app, paths.projectId, 'pano:renamed', { oldFilename, newFilename });
    return res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename,
    });
  } catch (error) {
    console.error('Error renaming panorama:', error);
    return res.status(500).json({ success: false, message: 'Error renaming file' });
  }
});

router.put('/upload/update', panoramaUpload.single('panorama'), (req, res) => {
  const oldFilename = req.body.oldFilename;
  if (!oldFilename) {
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({ success: false, message: 'Old file not found' });
  }
  const newFilename = req.file.filename;
  const job = createJob([newFilename], paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    newFilename,
    oldFilename,
  });

  (async () => {
    try {
      job.message = `Replacing ${oldFilename}…`;
      let archivedImage = null;
      try {
        archivedImage = storeReplacedImageInAudit(paths, 'pano', oldFilename, oldFilePath);
      } catch (archiveError) {
        throw new Error(`Could not store replaced panorama in audit logs: ${archiveError.message || archiveError}`);
      }
      await fs.promises.unlink(oldFilePath).catch((error) => {
        console.error('Error deleting old file:', error);
      });
      await removeDirIfExists(path.join(paths.tilesDir, tileIdFromFilename(oldFilename)));
      await buildTilesForImage({
        imagePath: path.join(paths.uploadsDir, newFilename),
        filename: newFilename,
        tilesRootDir: paths.tilesDir,
        onProgress: (fraction) => {
          job.percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
        },
      });
      panoramaOrderReplace(paths, oldFilename, newFilename);
      const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
      if (blurRename.changed) {
        emitToProject(req.app, paths.projectId, 'blur-masks:changed', blurRename.blurMasks);
      }
      try {
        renameAuditLog(paths, 'pano', oldFilename, newFilename);
        appendAuditEntry(paths, 'pano', newFilename, {
          action: 'Pano_Update',
          message: formatEditorAuditMessage('Pano_Update', { oldFilename, newFilename }),
          meta: buildAuditMeta(
            {
              replaced: { oldFilename, newFilename },
              ...(archivedImage
                ? {
                    archivedImage: {
                      kind: 'pano',
                      originalFilename: archivedImage.originalFilename,
                      storedFilename: archivedImage.storedFilename,
                    },
                  }
                : {}),
            },
            req.authUser
          ),
        });
      } catch (_error) {}
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      job.percent = 100;
      job.status = 'done';
      job.message = 'Update completed';
      emitToProject(req.app, paths.projectId, 'pano:updated', { oldFilename, newFilename });
    } catch (error) {
      console.error('Error updating image tiles:', error);
      const message = `Error updating image tiles: ${error.message || error}`;
      job.status = 'error';
      job.error = message;
      job.message = message;
    }
  })();
});

router.delete('/upload/:filename', (_req, res) => {
  return res.status(403).json({ success: false, message: 'Panorama deletion is disabled.' });
});

module.exports = router;
