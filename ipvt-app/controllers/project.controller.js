const fs = require('fs');
const {
  MAX_PROJECT_NUMBER_LENGTH,
  getProjectsManifest,
  sanitizeProjectId,
  normalizeProjectStatus,
  writeProjectsManifest,
} = require('../services/project-manifest.service');
const {
  ensureProjectDirs,
  getProjectPaths,
} = require('../services/project-paths.service');
const { emitProjectsChanged } = require('../services/project-events.service');
const { syncProjectToDatabaseOrThrow } = require('../services/project-sync.service');
const { appendAuditEntry, buildAuditMeta } = require('../services/audit.service');

function makeAuditPathsForProject(projectId) {
  const projectPaths = getProjectPaths(projectId);
  if (!projectPaths) return null;
  return {
    hotspotsPath: require('path').join(projectPaths.data, 'hotspots.json'),
  };
}

function list(_req, res) {
  const projects = getProjectsManifest();
  res.json(projects);
}

async function create(req, res) {
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
  if (trimmedNumber.length > MAX_PROJECT_NUMBER_LENGTH) {
    return res.status(400).json({ success: false, message: `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less` });
  }

  let id = sanitizeProjectId(trimmedName);
  const projects = getProjectsManifest();
  const normalizedName = trimmedName.toLowerCase();
  if (projects.some((project) => (project.name || '').trim().toLowerCase() === normalizedName)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }
  if (projects.some((project) => String(project.number || '').trim() === trimmedNumber)) {
    return res.status(409).json({ success: false, message: 'A project with this number already exists' });
  }
  if (projects.some((project) => project.id === id)) {
    let suffix = 1;
    while (projects.some((project) => project.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  ensureProjectDirs(id);
  const project = {
    id,
    name: trimmedName,
    number: trimmedNumber,
    status: normalizeProjectStatus(status),
  };
  projects.push(project);
  writeProjectsManifest(projects);

  try {
    const auditPaths = makeAuditPathsForProject(id);
    if (auditPaths) {
      appendAuditEntry(
        auditPaths,
        'project',
        'project',
        {
          action: 'Project_Create',
          message: `Project created: [${trimmedNumber}] — [${trimmedName}].`,
          meta: buildAuditMeta(
            {
              project: {
                id,
                number: trimmedNumber,
                name: trimmedName,
                status: project.status,
              },
            },
            req.authUser
          ),
        }
      );
    }
  } catch (_error) {}

  try {
    await syncProjectToDatabaseOrThrow(id, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after create:', error);
    return res.status(500).json({ success: false, message: 'Project saved, but database sync failed.' });
  }

  emitProjectsChanged(req.app);
  return res.json(project);
}

async function update(req, res) {
  const projectToken = String(req.params.id || '').trim();
  if (!projectToken || projectToken.includes('..') || projectToken.includes('/') || projectToken.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid project id' });
  }

  const { name, number, status } = req.body || {};
  if (number === undefined || number === null || !String(number).trim()) {
    return res.status(400).json({ success: false, message: 'Project number is required' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }

  const projects = getProjectsManifest();
  const index = projects.findIndex((project) => (
    String((project && project.id) || '').trim() === projectToken ||
    String((project && project.number) || '').trim() === projectToken
  ));
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Project not found' });
  }

  const oldId = String(projects[index].id || '').trim();
  const oldName = String(projects[index].name || '').trim();
  const oldNumber = String(projects[index].number || '').trim();
  const oldStatus = normalizeProjectStatus(projects[index].status);
  const trimmedName = name.trim();
  const trimmedNumber = String(number).trim();
  if (!/^[A-Za-z0-9-]+$/.test(trimmedNumber)) {
    return res.status(400).json({ success: false, message: 'Project number can only contain letters, numbers, and "-"' });
  }
  if (trimmedNumber.length > MAX_PROJECT_NUMBER_LENGTH) {
    return res.status(400).json({ success: false, message: `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less` });
  }

  const normalizedName = trimmedName.toLowerCase();
  if (projects.some((project, projectIndex) => projectIndex !== index && (project.name || '').trim().toLowerCase() === normalizedName)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }
  if (projects.some((project, projectIndex) => projectIndex !== index && String(project.number || '').trim() === trimmedNumber)) {
    return res.status(409).json({ success: false, message: 'A project with this number already exists' });
  }

  let newId = sanitizeProjectId(trimmedName);
  if (projects.some((project, projectIndex) => projectIndex !== index && project.id === newId)) {
    let suffix = 1;
    while (projects.some((project, projectIndex) => projectIndex !== index && project.id === `${newId}-${suffix}`)) suffix++;
    newId = `${newId}-${suffix}`;
  }

  if (newId !== oldId) {
    const oldPaths = getProjectPaths(oldId);
    const newPaths = getProjectPaths(newId);
    if (oldPaths && newPaths && fs.existsSync(oldPaths.base)) {
      if (fs.existsSync(newPaths.base)) {
        return res.status(409).json({ success: false, message: `A project folder "${newId}" already exists` });
      }
      try {
        fs.renameSync(oldPaths.base, newPaths.base);
      } catch (error) {
        console.error('Error renaming project folder:', error);
        return res.status(500).json({ success: false, message: `Failed to rename folder: ${error.message || error}` });
      }
    }
    projects[index].id = newId;
  }

  projects[index].name = trimmedName;
  projects[index].number = trimmedNumber;
  projects[index].status = normalizeProjectStatus(status || projects[index].status);
  writeProjectsManifest(projects);

  try {
    const auditPaths = makeAuditPathsForProject(projects[index].id);
    if (auditPaths) {
      const nextStatus = normalizeProjectStatus(projects[index].status);

      const commonMeta = buildAuditMeta(
        {
          before: { id: oldId, number: oldNumber, name: oldName, status: oldStatus },
          after: {
            id: projects[index].id,
            number: trimmedNumber,
            name: trimmedName,
            status: nextStatus,
          },
        },
        req.authUser
      );

      // Atomic logging: one audit entry per changed property.
      if (oldStatus && nextStatus && oldStatus !== nextStatus) {
        appendAuditEntry(auditPaths, 'project', 'project', {
          action: 'Project_Status_Update',
          message: `Project Status: Update ('[${oldStatus}]' to '[${nextStatus}]')`,
          meta: commonMeta,
        });
      }

      if (oldName && trimmedName && oldName !== trimmedName) {
        appendAuditEntry(auditPaths, 'project', 'project', {
          action: 'Project_Name_Update',
          message: `Project Name: Update ('[${oldName}]' to '[${trimmedName}]')`,
          meta: commonMeta,
        });
      }

      if (oldNumber && trimmedNumber && oldNumber !== trimmedNumber) {
        appendAuditEntry(auditPaths, 'project', 'project', {
          action: 'Project_Number_Update',
          message: `Project Number: Update ('[${oldNumber}]' to '[${trimmedNumber}]')`,
          meta: commonMeta,
        });
      }
    }
  } catch (_error) {}

  try {
    await syncProjectToDatabaseOrThrow(projects[index].id, req.authUser && req.authUser.id, {
      previousProjectToken: oldId,
      previousProjectNumber: oldNumber,
    });
  } catch (error) {
    console.error('Project database sync failed after update:', error);
    return res.status(500).json({ success: false, message: 'Project updated, but database sync failed.' });
  }

  emitProjectsChanged(req.app);
  return res.json(projects[index]);
}

function remove(_req, res) {
  return res.status(403).json({ success: false, message: 'Project deletion is disabled.' });
}

module.exports = {
  list,
  create,
  update,
  remove,
};
