/* Registers layout-related API endpoints. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { layoutUpload } = require('../middleware/upload.middleware');
const { resolvePaths } = require('../services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { emitToProject } = require('../services/project-events.service');
const {
  appendAuditEntry,
  buildAuditMeta,
  formatEditorAuditMessage,
  renameAuditLog,
  storeReplacedImageInAudit,
} = require('../services/audit.service');
const {
  clearLayoutHotspotsForFilenames,
  layoutOrderAppend,
  layoutOrderReplace,
  getOrderedLayoutFilenames,
  readLayoutOrder,
  writeLayoutOrder,
} = require('../services/project-media.service');

const router = express.Router();

const SAFE_RENAME_PATTERN = /^[a-zA-Z0-9-_ ]+$/;

function validateRenameFilename(filename, label) {
  const value = String(filename || '').trim();
  if (!value) return `${label} is required`;
  if (value.length > 50) return `${label} must be 50 characters or less`;
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return `Invalid ${label.toLowerCase()}`;
  if (value.endsWith('.') || value.endsWith(' ')) return `Invalid ${label.toLowerCase()}`;

  const ext = path.extname(value);
  const base = ext ? value.slice(0, -ext.length) : value;
  const baseName = path.basename(base);
  if (!SAFE_RENAME_PATTERN.test(baseName)) return `Invalid ${label.toLowerCase()}`;
  if (ext) {
    const extValue = ext.slice(1);
    if (!/^[a-zA-Z0-9]+$/.test(extValue)) return `Invalid ${label.toLowerCase()}`;
  }
  return null;
}

/* Wires HTTP endpoints to their controller handlers. */
router.post('/upload-layout', layoutUpload.array('layout', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    if (req.fileValidationError) {
      return res.status(400).json({ success: false, message: req.fileValidationError });
    }
    return res.status(400).json({ success: false, message: 'no file uploaded' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map((file) => file.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'layout', name, {
        action: 'Layout_Upload',
        message: formatEditorAuditMessage('Layout_Upload', { filename: name }),
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (_error) {}

  let updatedOrder = null;
  try {
    updatedOrder = layoutOrderAppend(paths, filenames);
  } catch (error) {
    console.error('Error updating layout order on upload:', error);
  }

  if (updatedOrder) {
    emitToProject(req.app, paths.projectId, 'layouts:order', { order: updatedOrder });
  }

  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after layout upload:', error);
    return res.status(500).json({ success: false, message: 'Layout uploaded, but database sync failed.' });
  }
  return res.json({ success: true, uploaded: filenames });
});

router.put('/upload-layout/update', layoutUpload.single('layout'), async (req, res) => {
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
  if (req.fileValidationError) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: req.fileValidationError });
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
  const oldFilePath = path.join(paths.layoutsDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    await cleanupUploadedFile();
    return res.status(404).json({ success: false, message: 'Old layout not found' });
  }
  const newFilename = req.file.filename;

  try {
    const hotspotCleanup = clearLayoutHotspotsForFilenames(paths, [oldFilename, newFilename]);
    if (hotspotCleanup.changed) {
      emitToProject(req.app, paths.projectId, 'layout-hotspots:changed', hotspotCleanup.hotspots);
    }

    if (oldFilename === newFilename) {
      try {
        appendAuditEntry(paths, 'layout', newFilename, {
          action: 'Layout_Update',
          message: formatEditorAuditMessage('Layout_Update', { oldFilename, newFilename }),
          meta: buildAuditMeta({ replaced: { oldFilename, newFilename } }, req.authUser),
        });
      } catch (_error) {}
      try {
        await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      } catch (error) {
        console.error('Project database sync failed after layout update:', error);
        return res.status(500).json({ success: false, message: 'Layout updated, but database sync failed.' });
      }
      return res.json({
        success: true,
        message: 'Layout updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename,
      });
    }

    let archivedImage = null;
    try {
      archivedImage = storeReplacedImageInAudit(paths, 'layout', oldFilename, oldFilePath);
    } catch (archiveError) {
      throw new Error(`Could not store replaced layout in audit logs: ${archiveError.message || archiveError}`);
    }

    await fs.promises.unlink(oldFilePath);

    try {
      renameAuditLog(paths, 'layout', oldFilename, newFilename);
      appendAuditEntry(paths, 'layout', newFilename, {
        action: 'Layout_Update',
        message: formatEditorAuditMessage('Layout_Update', { oldFilename, newFilename }),
        meta: buildAuditMeta(
          {
            replaced: { oldFilename, newFilename },
            ...(archivedImage
              ? {
                  archivedImage: {
                    kind: 'layout',
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

    let updatedOrder = null;
    try {
      updatedOrder = layoutOrderReplace(paths, oldFilename, newFilename);
    } catch (error) {
      console.error('Error updating layout order:', error);
    }

    emitToProject(req.app, paths.projectId, 'layouts:order', { order: updatedOrder });

    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after layout replace:', error);
      return res.status(500).json({ success: false, message: 'Layout updated, but database sync failed.' });
    }

    return res.json({
      success: true,
      message: 'Layout updated successfully',
      oldFilename,
      newFilename,
      filename: newFilename,
    });
  } catch (error) {
    console.error('Error updating layout:', error);
    await cleanupUploadedFile();
    return res.status(500).json({ success: false, message: 'Error updating layout' });
  }
});

router.put('/api/layouts/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body || {};
  const oldError = validateRenameFilename(oldFilename, 'Old filename');
  if (oldError) return res.status(400).json({ success: false, message: oldError });
  const newError = validateRenameFilename(newFilename, 'New filename');
  if (newError) return res.status(400).json({ success: false, message: newError });
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
  const oldPath = path.join(paths.layoutsDir, oldFilename);
  const newPath = path.join(paths.layoutsDir, newFilename);
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }

  try {
    await fs.promises.rename(oldPath, newPath);
    try {
      const order = readLayoutOrder(paths.layoutOrderPath);
      const newOrder = order.map((filename) => (filename === oldFilename ? newFilename : filename));
      writeLayoutOrder(paths.layoutOrderPath, newOrder);
    } catch (_error) {}
    try {
      renameAuditLog(paths, 'layout', oldFilename, newFilename);
      appendAuditEntry(paths, 'layout', newFilename, {
        action: 'Layout_Rename',
        message: formatEditorAuditMessage('Layout_Rename', { oldFilename, newFilename }),
        meta: buildAuditMeta({ renamed: { oldFilename, newFilename } }, req.authUser),
      });
    } catch (_error) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after layout rename:', error);
      return res.status(500).json({ success: false, message: 'Layout renamed, but database sync failed.' });
    }
    return res.json({ success: true, message: 'Layout renamed successfully', oldFilename, newFilename });
  } catch (error) {
    console.error('Error renaming layout:', error);
    return res.status(500).json({ success: false, message: 'Error renaming file' });
  }
});

router.delete('/api/layouts/:filename', (_req, res) => {
  return res.status(403).json({ success: false, message: 'Layout deletion is disabled.' });
});

router.get('/api/layouts', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const files = await getOrderedLayoutFilenames(paths);
    return res.json(files);
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to list layouts' });
  }
});

router.put('/api/layouts/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every((filename) => typeof filename === 'string' && filename.length > 0 && !filename.includes('..') && !/[\\\/]/.test(filename));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    writeLayoutOrder(paths.layoutOrderPath, body.order);
    res.json({ success: true });
    emitToProject(req.app, paths.projectId, 'layouts:order', { order: body.order });
  } catch (error) {
    console.error('Error writing layout order:', error);
    return res.status(500).json({ error: 'Unable to save order' });
  }
});

router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large. Maximum size is 30MB.' });
  }
  return next(err);
});

module.exports = router;
