const express = require('express');
const fs = require('fs');

function createProjectsRouter({
  db,
  projectsService,
  requireApiAuth,
  getValidSessionUser,
  isAdminRole,
  isSuperAdminRole,
  emitProjectsChanged,
  insertAuditLog,
}) {
  const router = express.Router();

  router.get('/projects', async (req, res) => {
    try {
      const user = await getValidSessionUser(req);
      if (user && isAdminRole(user.role)) {
        // Admin/Super Admin can see all projects (including drafts).
        const result = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
        return res.json(result.rows);
      }

      // Public listing is limited to published projects only.
      const result = await db.query(
        "SELECT * FROM projects WHERE workflow_state = 'PUBLISHED' ORDER BY created_at ASC"
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.post('/projects', requireApiAuth, async (req, res) => {
    const { name, number, status } = req.body || {};
    if (number === undefined || number === null || !String(number).trim()) {
      return res.status(400).json({ success: false, message: 'Project number is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Project name is required' });
    }
    const trimmedName = name.trim();
    const trimmedNumber = String(number).trim();
    if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
      return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
    }
    if (trimmedNumber.length > projectsService.MAX_PROJECT_NUMBER_LENGTH) {
      return res.status(400).json({ success: false, message: `Project number must be ${projectsService.MAX_PROJECT_NUMBER_LENGTH} characters or less` });
    }
    let id = projectsService.sanitizeProjectId(name);
    const normalized = trimmedName.toLowerCase();

    try {
      const existing = await db.query('SELECT id FROM projects WHERE LOWER(name) = $1 OR number = $2', [normalized, trimmedNumber]);
      if (existing.rows.length > 0) {
        const isName = existing.rows.some(r => r.name && r.name.toLowerCase() === normalized);
        return res.status(409).json({ success: false, message: `A project with this ${isName ? 'name' : 'number'} already exists` });
      }
      
      let suffix = 0;
      let finalId = id;
      while (true) {
        const check = await db.query('SELECT 1 FROM projects WHERE id = $1', [finalId]);
        if (check.rows.length === 0) break;
        suffix++;
        finalId = `${id}-${suffix}`;
      }
      
      projectsService.ensureProjectDirs(finalId);
    
      let insertRes = null;
      try {
        insertRes = await db.query(
          "INSERT INTO projects (id, folder_name, name, number, status, workflow_state) VALUES ($1, $2, $3, $4, $5, 'DRAFT') RETURNING *",
          [finalId, finalId, trimmedName, trimmedNumber, projectsService.normalizeProjectStatus(status)]
        );
      } catch (e) {
        // Backward compatibility if the DB hasn't been migrated yet.
        if (e && e.code === '42703') {
          insertRes = await db.query(
            "INSERT INTO projects (id, name, number, status, workflow_state) VALUES ($1, $2, $3, $4, 'DRAFT') RETURNING *",
            [finalId, trimmedName, trimmedNumber, projectsService.normalizeProjectStatus(status)]
          );
        } else {
          throw e;
        }
      }
    
      await emitProjectsChanged();
      await insertAuditLog({
        projectId: finalId,
        userId: req.session.userId,
        action: 'project:create',
        message: `Project created: ${trimmedName} (${trimmedNumber}).`,
        metadata: {
          id: finalId,
          name: trimmedName,
          number: trimmedNumber,
          status: projectsService.normalizeProjectStatus(status),
        },
      });
      res.json(insertRes.rows[0]);

    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  router.put('/projects/:id', requireApiAuth, async (req, res) => {
    const oldId = req.params.id;
    if (oldId.includes('..') || oldId.includes('/') || oldId.includes('\\')) {
      return res.status(400).json({ success: false, message: 'Invalid project id' });
    }
    const { name, number, status } = req.body || {};
    if (number === undefined || number === null || !String(number).trim()) {
      return res.status(400).json({ success: false, message: 'Project number is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Project name is required' });
    }
    
    try {
      const currentRes = await db.query('SELECT * FROM projects WHERE id = $1', [oldId]);
      if (currentRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Project not found' });
      const currentProject = currentRes.rows[0];

      const trimmedName = name.trim();
      const trimmedNumber = String(number).trim();
      if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
        return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
      }
      if (trimmedNumber.length > projectsService.MAX_PROJECT_NUMBER_LENGTH) {
        return res.status(400).json({ success: false, message: `Project number must be ${projectsService.MAX_PROJECT_NUMBER_LENGTH} characters or less` });
      }
      const normalized = trimmedName.toLowerCase();

      const conflictRes = await db.query('SELECT * FROM projects WHERE (LOWER(name) = $1 OR number = $2) AND id != $3', [normalized, trimmedNumber, oldId]);
      if (conflictRes.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'A project with this name already exists' });
      }

      const actorRole = req.session && req.session.role ? req.session.role : null;
      const actorIsSuperAdmin = isSuperAdminRole(actorRole);

      const nextStatus = projectsService.normalizeProjectStatus(status || currentProject.status);
      const prevStatus = projectsService.normalizeProjectStatus(currentProject.status);
      const nameChanged = trimmedName !== currentProject.name;
      const numberChanged = trimmedNumber !== currentProject.number;
      const statusChanged = nextStatus !== prevStatus;
      const renamed = nameChanged || numberChanged;
      const shouldMarkModified =
        !actorIsSuperAdmin &&
        String(currentProject.workflow_state || '').toUpperCase() === 'PUBLISHED' &&
        (renamed || statusChanged);

      // Keep project id stable, but optionally rename the on-disk folder when the display name changes.
      const currentFolderName = projectsService.getProjectFolderName(currentProject) || oldId;
      let nextFolderName = currentFolderName;
      let folderRenamedOnDisk = false;
      let folderRenameFrom = null;
      let folderRenameTo = null;

      const folderNameInDb = Object.prototype.hasOwnProperty.call(currentProject, 'folder_name')
        ? String(currentProject.folder_name || '').trim()
        : null;
      // Sync folder name on:
      // - actual display-name changes, OR
      // - older rows where folder_name is missing/empty/defaults to the project id (common after past renames).
      const shouldSyncFolderToName =
        nameChanged || (folderNameInDb !== null && (!folderNameInDb || folderNameInDb === oldId));

      if (shouldSyncFolderToName) {
        const desiredBase = projectsService.sanitizeProjectId(trimmedName);
        if (desiredBase && desiredBase !== currentFolderName) {
          // Ensure we don't collide with an existing folder name.
          let suffix = 0;
          let candidate = desiredBase;
          while (suffix < 200) {
            const candidatePaths = projectsService.getProjectPaths(candidate);
            if (!candidatePaths) break;
            if (!fs.existsSync(candidatePaths.base)) break;
            suffix += 1;
            candidate = `${desiredBase}-${suffix}`;
          }
          nextFolderName = candidate || currentFolderName;
        }
      }

      if (nextFolderName !== currentFolderName) {
        const currentPaths = projectsService.getProjectPaths(currentFolderName);
        const legacyPaths = currentFolderName !== oldId ? projectsService.getProjectPaths(oldId) : null;
        const targetPaths = projectsService.getProjectPaths(nextFolderName);
        if (!targetPaths) {
          return res.status(400).json({ success: false, message: 'Invalid project folder name' });
        }

        const sourceCandidates = [currentPaths && currentPaths.base, legacyPaths && legacyPaths.base].filter(Boolean);
        const sourceDir = sourceCandidates.find((p) => fs.existsSync(p)) || null;

        // If no folder exists yet (e.g. DB-only project), just create the new folder structure.
        if (!sourceDir) {
          projectsService.ensureProjectDirs(nextFolderName);
        } else if (fs.existsSync(targetPaths.base)) {
          return res.status(409).json({ success: false, message: 'A project folder with this name already exists' });
        } else {
          try {
            fs.renameSync(sourceDir, targetPaths.base);
            folderRenamedOnDisk = true;
            folderRenameFrom = sourceDir;
            folderRenameTo = targetPaths.base;
          } catch (e) {
            console.error('Error renaming project folder:', e);
            return res.status(500).json({ success: false, message: 'Failed to rename project folder' });
          }
        }
      }

      let updateRes = null;
      try {
        updateRes = await db.query(
          `UPDATE projects
           SET name = $1,
               number = $2,
               status = $3,
               folder_name = $4,
               workflow_state = CASE
                 WHEN workflow_state = 'PUBLISHED' AND $6::boolean THEN 'MODIFIED'
                 ELSE workflow_state
               END,
               updated_at = NOW()
           WHERE id = $5
           RETURNING *`,
          [
            trimmedName,
            trimmedNumber,
            nextStatus,
            nextFolderName,
            oldId,
            shouldMarkModified,
          ]
        );
      } catch (e) {
        // If the folder_name column doesn't exist yet, roll back the on-disk rename and use the legacy update.
        if (folderRenamedOnDisk) {
          try {
            fs.renameSync(folderRenameTo, folderRenameFrom);
          } catch (rollbackErr) {
            console.error('Error rolling back project folder rename:', rollbackErr);
          }
        }
        if (e && e.code === '42703') {
          updateRes = await db.query(
            `UPDATE projects
             SET name = $1,
                 number = $2,
                 status = $3,
                 workflow_state = CASE
                   WHEN workflow_state = 'PUBLISHED' AND $5::boolean THEN 'MODIFIED'
                   ELSE workflow_state
                 END,
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [
              trimmedName,
              trimmedNumber,
              nextStatus,
              oldId,
              shouldMarkModified,
            ]
          );
        } else {
          // Best-effort: keep FS/DB consistent by rolling back rename above, then surface the error.
          throw e;
        }
      }

      await emitProjectsChanged();

      const messageParts = [];
      if (nameChanged) messageParts.push(`Name: "${currentProject.name}" -> "${trimmedName}"`);
      if (numberChanged) messageParts.push(`Number: "${currentProject.number}" -> "${trimmedNumber}"`);
      if (statusChanged) messageParts.push(`Status: "${prevStatus}" -> "${nextStatus}"`);

      if (messageParts.length > 0) {
        let action = 'project:update';
        if (nameChanged && numberChanged) action = 'project:rename';
        else if (nameChanged) action = 'project:name';
        else if (numberChanged) action = 'project:number';
        else if (statusChanged) action = 'project:status';

        await insertAuditLog({
          projectId: oldId,
          projectNumber: trimmedNumber,
          projectName: trimmedName,
          userId: req.session.userId,
          action,
          message: messageParts.join('; '),
          metadata: {
            old: {
              name: currentProject.name,
              number: currentProject.number,
              status: currentProject.status,
            },
            new: {
              name: trimmedName,
              number: trimmedNumber,
              status: nextStatus,
            },
          },
        });
      }
      // If this update moved a published project back to MODIFIED, record a single "modified" audit entry.
      if (String(currentProject.workflow_state || '').toUpperCase() === 'PUBLISHED' && String(updateRes.rows[0]?.workflow_state || '').toUpperCase() === 'MODIFIED') {
        try {
          await insertAuditLog({
            projectId: oldId,
            userId: req.session.userId,
            action: 'project:modified',
            message: 'Project modified; requires approval before publishing changes.',
            metadata: { via: 'project:update' },
          });
        } catch (e) {}
      }
      res.json(updateRes.rows[0]);

    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

  return router;
}

module.exports = createProjectsRouter;
