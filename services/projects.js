const fs = require('fs');
const path = require('path');

function createProjectsService({ db, projectsDir }) {
  const MAX_PROJECT_NUMBER_LENGTH = 20;
  const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);

  /**
   * Look up a project by either its internal id or its human-facing number.
   * Returns the full project object or null if not found.
   */
  async function findProjectByIdOrNumber(token) {
    if (!token) return null;
    const value = String(token).trim();
    if (!value) return null;
    try {
      // Single bind variable is intentional: we compare the same token against both columns.
      const res = await db.query('SELECT * FROM projects WHERE id = $1 OR number = $1', [value]);
      return res.rows[0] || null;
    } catch (err) {
      console.error('Error finding project:', err);
      return null;
    }
  }

  function sanitizeProjectId(name) {
    return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || 'project';
  }

  function normalizeProjectStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'in-progress') return 'on-going';
    return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
  }

  /** Get paths for a project. projectId must be validated (no .., no slashes). */
  function getProjectPaths(folderName) {
    if (!folderName || folderName.includes('..') || /[\/\\]/.test(folderName)) return null;
    const base = path.join(projectsDir, folderName);
    return {
      base,
      upload: path.join(base, 'upload'),
      layouts: path.join(base, 'layouts'),
      floorplans: path.join(base, 'floorplans'),
      tiles: path.join(base, 'tiles'),
      data: path.join(base, 'data'),
    };
  }

  function ensureProjectDirs(folderName) {
    const p = getProjectPaths(folderName);
    if (!p) return null;
    // Note: `floorplans` is a legacy folder kept for backward compatibility.
    // New uploads are stored under `layouts`, and we no longer auto-create `floorplans`.
    [p.upload, p.layouts, p.tiles, p.data].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    return p;
  }

  function getProjectFolderName(project) {
    if (!project || typeof project !== 'object') return null;
    const raw = project.folder_name || project.folder || project.folder_id || project.id;
    const value = String(raw || '').trim();
    if (!value) return null;
    if (value.includes('..') || /[\/\\]/.test(value)) return null;
    return value;
  }

  /** Resolve paths: require project id */
  async function resolvePaths(req) {
    const projectToken = req.query.project || (req.body && req.body.project);
    const project = await findProjectByIdOrNumber(projectToken);
    const projectId = project ? project.id : projectToken;
    const folderName = project ? getProjectFolderName(project) : projectToken;
    const p = getProjectPaths(folderName);
    if (!p) return null;
    return {
      uploadsDir: p.upload,
      // New name: layouts. Keep legacy floorplans directory as a fallback for older projects.
      layoutsDir: p.layouts,
      floorplansDir: p.layouts,
      floorplansLegacyDir: p.floorplans,
      tilesDir: p.tiles,
      hotspotsPath: path.join(p.data, 'hotspots.json'),
      // New names: layout-*.json, but keep legacy floorplan-*.json as fallback.
      layoutHotspotsPath: path.join(p.data, 'layout-hotspots.json'),
      floorplanHotspotsPath: path.join(p.data, 'floorplan-hotspots.json'),
      layoutOrderPath: path.join(p.data, 'layout-order.json'),
      floorplanOrderPath: path.join(p.data, 'floorplan-order.json'),
      projectId,
    };
  }

  async function getProjectIdFromQuery(req) {
    if (req.query && typeof req.query === 'object') {
      let token = null;
      if (typeof req.query.project === 'string' && req.query.project.length > 0) {
        token = req.query.project;
      } else {
        const keys = Object.keys(req.query);
        if (keys.length === 1 && req.query[keys[0]] === '') token = keys[0];
      }
      if (token) {
        const project = await findProjectByIdOrNumber(token);
        return project ? project.id : token;
      }
    }
    return null;
  }

  return {
    MAX_PROJECT_NUMBER_LENGTH,
    ALLOWED_PROJECT_STATUSES,
    findProjectByIdOrNumber,
    sanitizeProjectId,
    normalizeProjectStatus,
    getProjectPaths,
    ensureProjectDirs,
    getProjectFolderName,
    resolvePaths,
    getProjectIdFromQuery,
  };
}

module.exports = createProjectsService;
