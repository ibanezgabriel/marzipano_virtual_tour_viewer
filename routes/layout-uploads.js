const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveFloorplanImagePath } = require('../utils/layout-files');
const {
  clearFloorplanHotspotsForFilenames,
  floorplanOrderAppend,
  floorplanOrderReplace,
} = require('../services/layout-state');

function createLayoutUploadsRouter({
  db,
  io,
  floorplanUpload,
  projectsService,
  legacyAuditLogService,
  markProjectModifiedIfPublished,
  requireApiAuth,
}) {
  const router = express.Router();

  async function handleLayoutUpload(req, res) {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'no file uploaded' });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      return res.status(400).json({ success: false, message: 'Project required' });
    }
    const filenames = req.files.map((f) => f.filename);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Backward compatibility: older DBs may still have `floorplans` instead of `layouts`.
      const regRes = await client.query("SELECT to_regclass('public.layouts') AS reg");
      const layoutsTable = regRes.rows[0] && regRes.rows[0].reg ? 'layouts' : 'floorplans';

      const rankRes = await client.query(
        `SELECT COALESCE(MAX(rank), -1)::int as maxr FROM ${layoutsTable} WHERE project_id = $1`,
        [paths.projectId]
      );
      let currentRank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;
      for (const filename of filenames) {
        const upsertRes = await client.query(
          `INSERT INTO ${layoutsTable} (project_id, filename, rank)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, filename)
           DO UPDATE SET rank = ${layoutsTable}.rank
           RETURNING id, (xmax = 0) AS inserted`,
          [paths.projectId, filename, currentRank]
        );
        if (upsertRes.rows[0]?.inserted) currentRank += 1;
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
      try {
        filenames.forEach((name) => {
          const img = path.join(paths.floorplansDir, name);
          if (fs.existsSync(img)) fs.unlinkSync(img);
        });
      } catch (cleanupErr) {}
      console.error('Error saving uploaded layouts to DB:', e);
      return res.status(500).json({
        success: false,
        message: 'Upload saved to disk but failed to persist to database',
        error: String(e.message || e),
      });
    } finally {
      try { client.release(); } catch (e) {}
    }
    try {
      filenames.forEach((name) => {
        legacyAuditLogService.appendAuditEntry(
          paths,
          'floorplan',
          name,
          { action: 'upload', message: 'Layout uploaded.' },
          { userId: req.session.userId }
        );
      });
    } catch (e) {}
    await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout:upload' });
    let updatedOrder = null;
    try {
      updatedOrder = floorplanOrderAppend(paths, filenames);
    } catch (e) {
      console.error('Error updating layout order on upload:', e);
    }
    try {
      if (updatedOrder) {
        io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
        io.to(`project:${paths.projectId}`).emit('layouts:order', { order: updatedOrder });
      }
    } catch (e) {
      console.error('Socket emit error:', e);
    }
    res.json({ success: true, uploaded: filenames });
  }

  router.post('/upload-floorplan', requireApiAuth, floorplanUpload.array('floorplan', 20), handleLayoutUpload);
  router.post('/upload-layout', requireApiAuth, floorplanUpload.array('layout', 20), handleLayoutUpload);

  async function handleLayoutUpdate(req, res) {
    const cleanupUploadedFile = async () => {
      if (!req.file || !req.file.path) return;
      try {
        await fs.promises.unlink(req.file.path);
      } catch (e) {}
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
    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      await cleanupUploadedFile();
      return res.status(400).json({ success: false, message: 'Project required' });
    }
    const oldFilePath = resolveFloorplanImagePath(paths, oldFilename);
    if (!fs.existsSync(oldFilePath)) {
      await cleanupUploadedFile();
      return res.status(404).json({ success: false, message: 'Old layout not found' });
    }
    const newFilename = req.file.filename;
    try {
      const hotspotCleanup = clearFloorplanHotspotsForFilenames(paths, [oldFilename, newFilename]);
      if (hotspotCleanup.changed) {
        try {
          io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', hotspotCleanup.hotspots);
          io.to(`project:${paths.projectId}`).emit('layout-hotspots:changed', hotspotCleanup.hotspots);
        } catch (e) {
          console.error('Socket emit error:', e);
        }
      }

      if (oldFilename === newFilename) {
        try {
          legacyAuditLogService.appendAuditEntry(
            paths,
            'floorplan',
            newFilename,
            { action: 'update', message: 'Layout updated.' },
            { userId: req.session.userId }
          );
        } catch (e) {}
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout:update' });
        return res.json({
          success: true,
          message: 'Layout updated successfully',
          oldFilename,
          newFilename,
          filename: newFilename
        });
      }

      let archivedImage = null;
      try {
        archivedImage = legacyAuditLogService.storeReplacedImageInAudit(paths, 'floorplan', oldFilename, oldFilePath);
      } catch (archiveErr) {
        throw new Error(`Could not archive replaced layout: ${archiveErr.message || archiveErr}`);
      }

      await fs.promises.unlink(oldFilePath);

      try {
        legacyAuditLogService.renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
        legacyAuditLogService.appendAuditEntry(
          paths,
          'floorplan',
          newFilename,
          {
            action: 'update',
            message: `Layout updated (replaced "${oldFilename}" with "${newFilename}").`,
            ...(archivedImage
              ? {
                  meta: {
                    archivedImage: {
                      kind: 'floorplan',
                      originalFilename: archivedImage.originalFilename,
                      storedFilename: archivedImage.storedFilename,
                    },
                  },
                }
              : {}),
          },
          { userId: req.session.userId }
        );
      } catch (e) {}

      let updatedOrder = null;
      try {
        updatedOrder = floorplanOrderReplace(paths, oldFilename, newFilename);
      } catch (e) {
        console.error('Error updating layout order:', e);
      }

      try {
        io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
        io.to(`project:${paths.projectId}`).emit('layouts:order', { order: updatedOrder });
      } catch (e) {
        console.error('Socket emit error:', e);
      }

      await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'layout:update' });
      return res.json({
        success: true,
        message: 'Layout updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename
      });
    } catch (e) {
      console.error('Error updating layout:', e);
      await cleanupUploadedFile();
      return res.status(500).json({ success: false, message: 'Error updating layout' });
    }
  }

  router.put('/upload-floorplan/update', requireApiAuth, floorplanUpload.single('floorplan'), handleLayoutUpdate);
  router.put('/upload-layout/update', requireApiAuth, floorplanUpload.single('layout'), handleLayoutUpdate);

  return router;
}

module.exports = createLayoutUploadsRouter;

