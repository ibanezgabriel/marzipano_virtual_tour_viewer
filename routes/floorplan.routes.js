const express = require('express');
const fs = require('fs');
const path = require('path');
const { floorplanUpload } = require('../middleware/upload.middleware');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const {
  appendAuditEntry,
  buildAuditMeta,
  renameAuditLog,
  storeReplacedImageInAudit,
} = require('../services/audit.service');
const {
  clearFloorplanHotspotsForFilenames,
  floorplanOrderAppend,
  floorplanOrderReplace,
  getOrderedFloorplanFilenames,
  readFloorplanOrder,
  writeFloorplanOrder,
} = require('../services/project-media.service');

const router = express.Router();

router.post('/upload-floorplan', floorplanUpload.array('floorplan', 20), async (req, res) => {
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
      appendAuditEntry(paths, 'floorplan', name, {
        action: 'upload',
        message: 'Floor plan uploaded.',
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (_error) {}

  let updatedOrder = null;
  try {
    updatedOrder = floorplanOrderAppend(paths, filenames);
  } catch (error) {
    console.error('Error updating floor plan order on upload:', error);
  }

  if (updatedOrder) {
    emitToProject(req.app, paths.projectId, 'floorplans:order', { order: updatedOrder });
  }

  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after floor plan upload:', error);
    return res.status(500).json({ success: false, message: 'Floor plan uploaded, but database sync failed.' });
  }
  return res.json({ success: true, uploaded: filenames });
});

router.put('/upload-floorplan/update', floorplanUpload.single('floorplan'), async (req, res) => {
  const cleanupUploadedFile = async () => {
    if (!req.file || !req.file.path) return;
    try {
      await fs.promises.unlink(req.file.path);
    } catch (_error) {}
  };

  const oldFilename = req.body && req.body.oldFilename;
  if (!oldFilename) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }

  const paths = resolvePaths(req);
  if (!paths) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.floorplansDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    await cleanupUploadedFile();
    return res.status(404).json({ success: false, message: 'Old floor plan not found' });
  }
  const newFilename = req.file.filename;

  try {
    const hotspotCleanup = clearFloorplanHotspotsForFilenames(paths, [oldFilename, newFilename]);
    if (hotspotCleanup.changed) {
      emitToProject(req.app, paths.projectId, 'floorplan-hotspots:changed', hotspotCleanup.hotspots);
    }

    if (oldFilename === newFilename) {
      try {
        appendAuditEntry(paths, 'floorplan', newFilename, {
          action: 'update',
          message: 'Floor plan updated.',
          meta: buildAuditMeta(undefined, req.authUser),
        });
      } catch (_error) {}
      try {
        await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      } catch (error) {
        console.error('Project database sync failed after floor plan update:', error);
        return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
      }
      return res.json({
        success: true,
        message: 'Floor plan updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename,
      });
    }

    let archivedImage = null;
    try {
      archivedImage = storeReplacedImageInAudit(paths, 'floorplan', oldFilename, oldFilePath);
    } catch (archiveError) {
      throw new Error(`Could not archive replaced floor plan: ${archiveError.message || archiveError}`);
    }

    await fs.promises.unlink(oldFilePath);

    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'update',
        message: `Floor plan updated (replaced "${oldFilename}" with "${newFilename}").`,
        meta: buildAuditMeta(
          archivedImage
            ? {
                archivedImage: {
                  kind: 'floorplan',
                  originalFilename: archivedImage.originalFilename,
                  storedFilename: archivedImage.storedFilename,
                },
              }
            : undefined,
          req.authUser
        ),
      });
    } catch (_error) {}

    let updatedOrder = null;
    try {
      updatedOrder = floorplanOrderReplace(paths, oldFilename, newFilename);
    } catch (error) {
      console.error('Error updating floor plan order:', error);
    }

    emitToProject(req.app, paths.projectId, 'floorplans:order', { order: updatedOrder });

    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan replace:', error);
      return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
    }

    return res.json({
      success: true,
      message: 'Floor plan updated successfully',
      oldFilename,
      newFilename,
      filename: newFilename,
    });
  } catch (error) {
    console.error('Error updating floor plan:', error);
    await cleanupUploadedFile();
    return res.status(500).json({ success: false, message: 'Error updating floor plan' });
  }
});

router.put('/api/floorplans/rename', async (req, res) => {
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

  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldPath = path.join(paths.floorplansDir, oldFilename);
  const newPath = path.join(paths.floorplansDir, newFilename);
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }

  try {
    await fs.promises.rename(oldPath, newPath);
    try {
      const order = readFloorplanOrder(paths.floorplanOrderPath);
      const newOrder = order.map((filename) => (filename === oldFilename ? newFilename : filename));
      writeFloorplanOrder(paths.floorplanOrderPath, newOrder);
    } catch (_error) {}
    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'rename',
        message: `Floor plan renamed from "${oldFilename}" to "${newFilename}".`,
        meta: buildAuditMeta(undefined, req.authUser),
      });
    } catch (_error) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan rename:', error);
      return res.status(500).json({ success: false, message: 'Floor plan renamed, but database sync failed.' });
    }
    return res.json({ success: true, message: 'Floor plan renamed successfully', oldFilename, newFilename });
  } catch (error) {
    console.error('Error renaming floor plan:', error);
    return res.status(500).json({ success: false, message: 'Error renaming file' });
  }
});

router.delete('/api/floorplans/:filename', (_req, res) => {
  return res.status(403).json({ success: false, message: 'Floor plan deletion is disabled.' });
});

router.get('/api/floorplans', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const files = await getOrderedFloorplanFilenames(paths);
    return res.json(files);
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to list floor plans' });
  }
});

router.put('/api/floorplans/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every((filename) => typeof filename === 'string' && filename.length > 0 && !filename.includes('..') && !/[\\\/]/.test(filename));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    writeFloorplanOrder(paths.floorplanOrderPath, body.order);
    res.json({ success: true });
    emitToProject(req.app, paths.projectId, 'floorplans:order', { order: body.order });
  } catch (error) {
    console.error('Error writing floorplan order:', error);
    return res.status(500).json({ error: 'Unable to save order' });
  }
});

module.exports = router;
