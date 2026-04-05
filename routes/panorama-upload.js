const express = require('express');
const fs = require('fs');
const path = require('path');

function createPanoramaUploadRouter({
  db,
  io,
  upload,
  jobsService,
  projectsService,
  legacyAuditLogService,
  markProjectModifiedIfPublished,
  buildTilesForImage,
  tileIdFromFilename,
  removeDirIfExists,
  requireApiAuth,
}) {
  const router = express.Router();

  router.post('/upload', requireApiAuth, upload.array("panorama", 20), async (req, res) => {
    if(!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "no file uploaded"
      });
    }
    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      return res.status(400).json({ success: false, message: 'Project required' });
    }
    const filenames = req.files.map(f => f.filename);
    
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const rankRes = await client.query(
        'SELECT COALESCE(MAX(rank), -1)::int as maxr FROM panoramas WHERE project_id = $1',
        [paths.projectId]
      );
      let currentRank = Number(rankRes.rows[0]?.maxr ?? -1) + 1;

      for (const filename of filenames) {
        const upsertRes = await client.query(
          `INSERT INTO panoramas (project_id, filename, rank, is_active)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (project_id, filename)
           DO UPDATE SET is_active = true
           RETURNING id, (xmax = 0) AS inserted`,
          [paths.projectId, filename, currentRank]
        );
        if (upsertRes.rows[0]?.inserted) currentRank += 1;
      }

      await client.query('COMMIT');

      try {
        filenames.forEach((name) => {
          legacyAuditLogService.appendAuditEntry(
            paths,
            'pano',
            name,
            { action: 'upload', message: 'Panorama uploaded.' },
            { userId: req.session.userId }
          );
        });
      } catch (e) {}

      // If this was a published project, move it back to staging as MODIFIED.
      await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'panorama:upload' });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
      // Best-effort cleanup of the just-uploaded files if we couldn't persist to the DB.
      try {
        filenames.forEach((name) => {
          const img = path.join(paths.uploadsDir, name);
          if (fs.existsSync(img)) fs.unlinkSync(img);
        });
      } catch (cleanupErr) {}
      console.error('Error saving uploaded panoramas to DB:', e);
      return res.status(500).json({
        success: false,
        message: 'Upload saved to disk but failed to persist to database',
        error: String(e.message || e),
      });
    } finally {
      try { client.release(); } catch (e) {}
    }

    const job = jobsService.createJob(filenames, paths.projectId);
    res.json({
      success: true,
      jobId: job.id,
      uploaded: filenames
    });

    (async () => {
      try {
        let overall = 0;
        const totalFiles = filenames.length;
        for (let i = 0; i < filenames.length; i++) {
          const name = filenames[i];
          job.message = `Processing ${name} (${i+1}/${totalFiles})`;
          await buildTilesForImage({
            imagePath: path.join(paths.uploadsDir, name),
            filename: name,
            tilesRootDir: paths.tilesDir,
            onProgress: (frac) => {
              const combined = ((i + frac) / totalFiles) * 100;
              if (combined > overall) overall = combined;
              job.percent = Math.min(100, Math.max(0, Math.round(overall)));
            }
          });
        }
        try { io.to(`project:${paths.projectId}`).emit('panos:ready', { filenames }); } catch (e) { console.error('Socket emit error:', e); }
        job.percent = 100;
        job.status = 'done';
        job.message = 'Completed';
      } catch (e) {
        console.error('Tile generation failed:', e);
        const msg = `Tile generation failed: ${e.message || e}`;
        job.status = 'error';
        job.error = msg;
        job.message = msg;
      }
    })();
  });

  router.get('/upload', async (req, res) => {
    const paths = await projectsService.resolvePaths(req);
    if (!paths) return res.status(400).json({ error: 'Project required' });
    fs.readdir(paths.uploadsDir, (err, files) => {
      if (err) return res.status(500).json({ error: 'Unable to read directory' });
      const images = (files || []).filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
      res.json(images);
    });
  });

  router.put('/upload/rename', requireApiAuth, async (req, res) => {
    const { oldFilename, newFilename } = req.body;

    if (!oldFilename || !newFilename) {
      return res.status(400).json({
        success: false,
        message: 'Both old and new filenames are required'
      });
    }

    if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
        newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid filename'
      });
    }

    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      return res.status(400).json({
        success: false,
        message: 'Project required'
      });
    }

    const checkRes = await db.query('SELECT id FROM panoramas WHERE project_id = $1 AND filename = $2', [paths.projectId, oldFilename]);
    if (checkRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Panorama not found in database' });

    const oldFilePath = path.join(paths.uploadsDir, oldFilename);
    const newFilePath = path.join(paths.uploadsDir, newFilename);

    if (!fs.existsSync(oldFilePath)) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    if (fs.existsSync(newFilePath)) {
      return res.status(409).json({
        success: false,
        message: 'An image with this name already exists'
      });
    }

    fs.rename(oldFilePath, newFilePath, async (err) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error renaming file'
        });
      }

      await db.query('UPDATE panoramas SET filename = $1 WHERE project_id = $2 AND filename = $3', [newFilename, paths.projectId, oldFilename]);

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
        } catch (e) {
          console.error('Error renaming tiles folder:', e);
        }
      }

      try {
        legacyAuditLogService.renameAuditLog(paths, 'pano', oldFilename, newFilename);
        legacyAuditLogService.appendAuditEntry(
          paths,
          'pano',
          newFilename,
          {
            action: 'rename',
            message: `Panorama renamed from "${oldFilename}" to "${newFilename}".`,
          },
          { userId: req.session.userId }
        );
      } catch (e) {}
      await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'panorama:rename' });
      try { io.to(`project:${paths.projectId}`).emit('pano:renamed', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
      res.json({
        success: true,
        message: 'File renamed successfully',
        oldFilename,
        newFilename
      });
    });
  });

  router.put('/upload/update', requireApiAuth, upload.single('panorama'), async (req, res) => {
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
    const paths = await projectsService.resolvePaths(req);
    if (!paths) {
      return res.status(400).json({ success: false, message: 'Project required' });
    }

    const checkRes = await db.query('SELECT id FROM panoramas WHERE project_id = $1 AND filename = $2', [paths.projectId, oldFilename]);
    if (checkRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Panorama not found in database' });

    const oldFilePath = path.join(paths.uploadsDir, oldFilename);
    if (!fs.existsSync(oldFilePath)) {
      return res.status(404).json({ success: false, message: 'Old file not found' });
    }
    const newFilename = req.file.filename;
    const job = jobsService.createJob([newFilename], paths.projectId);
    res.json({
      success: true,
      jobId: job.id,
      newFilename,
      oldFilename
    });
    (async () => {
      try {
        job.message = `Replacing ${oldFilename}…`;
        let archivedImage = null;
        try {
          archivedImage = legacyAuditLogService.storeReplacedImageInAudit(paths, 'pano', oldFilename, oldFilePath);
        } catch (archiveErr) {
          throw new Error(`Could not archive replaced panorama: ${archiveErr.message || archiveErr}`);
        }
        await fs.promises.unlink(oldFilePath).catch((err) => {
          console.error('Error deleting old file:', err);
        });
        await removeDirIfExists(path.join(paths.tilesDir, tileIdFromFilename(oldFilename)));
        await buildTilesForImage({
          imagePath: path.join(paths.uploadsDir, newFilename),
          filename: newFilename,
          tilesRootDir: paths.tilesDir,
          onProgress: (frac) => {
            job.percent = Math.min(100, Math.max(0, Math.round(frac * 100)));
          }
        });

        await db.query('UPDATE panoramas SET filename = $1 WHERE project_id = $2 AND filename = $3', [newFilename, paths.projectId, oldFilename]);
        await markProjectModifiedIfPublished(paths.projectId, req.session.userId, req.session.role, { via: 'panorama:update' });

        try {
          legacyAuditLogService.renameAuditLog(paths, 'pano', oldFilename, newFilename);
          legacyAuditLogService.appendAuditEntry(
            paths,
            'pano',
            newFilename,
            {
              action: 'update',
              message: `Panorama updated (replaced "${oldFilename}" with "${newFilename}").`,
              ...(archivedImage
                ? {
                    meta: {
                      archivedImage: {
                        kind: 'pano',
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
        job.percent = 100;
        job.status = 'done';
        job.message = 'Update completed';
        try { io.to(`project:${paths.projectId}`).emit('pano:updated', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
      } catch (e) {
        console.error('Error updating image tiles:', e);
        const msg = `Error updating image tiles: ${e.message || e}`;
        job.status = 'error';
        job.error = msg;
        job.message = msg;
      }
    })();
  });

  return router;
}

module.exports = createPanoramaUploadRouter;

