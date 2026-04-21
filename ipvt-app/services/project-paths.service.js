/* Builds the filesystem paths for each project. */
const path = require('path');
const fs = require('fs');
const {
  findProjectByIdOrNumber,
  projectsDir,
} = require('./project-manifest.service');

/* Handles migrate legacy floorplan artifacts. */
function migrateLegacyFloorplanArtifacts(base) {
  if (!base || !fs.existsSync(base)) return;
  const oldDir = path.join(base, 'floorplans');
  const newDir = path.join(base, 'layouts');
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
    }
  } catch (error) {
    console.error('Could not migrate floorplans directory to layouts:', error);
  }
  const dataDir = path.join(base, 'data');
  const filePairs = [
    ['floorplan-hotspots.json', 'layout-hotspots.json'],
    ['floorplan-order.json', 'layout-order.json'],
  ];
  for (const [from, to] of filePairs) {
    const a = path.join(dataDir, from);
    const b = path.join(dataDir, to);
    try {
      if (fs.existsSync(a) && !fs.existsSync(b)) {
        fs.renameSync(a, b);
      }
    } catch (error) {
      console.error(`Could not migrate ${from} to ${to}:`, error);
    }
  }
  const auditBase = path.join(dataDir, 'audit');
  const dirPairs = [
    [path.join(auditBase, 'floorplans'), path.join(auditBase, 'layouts')],
    [path.join(auditBase, 'images', 'floorplans'), path.join(auditBase, 'images', 'layouts')],
  ];
  for (const [oldP, newP] of dirPairs) {
    try {
      if (fs.existsSync(oldP) && !fs.existsSync(newP)) {
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        fs.renameSync(oldP, newP);
      }
    } catch (error) {
      console.error('Could not migrate audit directory:', oldP, error);
    }
  }
}

/* Gets get project paths. */
function getProjectPaths(projectId) {
  if (!projectId || projectId.includes('..') || /[\/\\]/.test(projectId)) return null;
  const base = path.join(projectsDir, projectId);
  migrateLegacyFloorplanArtifacts(base);
  return {
    base,
    upload: path.join(base, 'upload'),
    layouts: path.join(base, 'layouts'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

/* Sets up ensure project dirs. */
function ensureProjectDirs(projectId) {
  const projectPaths = getProjectPaths(projectId);
  if (!projectPaths) return null;
  [projectPaths.upload, projectPaths.layouts, projectPaths.tiles, projectPaths.data].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  return projectPaths;
}

/* Handles resolve paths. */
function resolvePaths(req) {
  const projectToken = req.query.project || (req.body && req.body.project);
  const project = findProjectByIdOrNumber(projectToken);
  const projectId = project ? project.id : projectToken;
  const projectPaths = getProjectPaths(projectId);
  if (!projectPaths) return null;
  return {
    uploadsDir: projectPaths.upload,
    layoutsDir: projectPaths.layouts,
    tilesDir: projectPaths.tiles,
    hotspotsPath: path.join(projectPaths.data, 'hotspots.json'),
    blurMasksPath: path.join(projectPaths.data, 'blur-masks.json'),
    layoutHotspotsPath: path.join(projectPaths.data, 'layout-hotspots.json'),
    initialViewsPath: path.join(projectPaths.data, 'initial-views.json'),
    panoramaOrderPath: path.join(projectPaths.data, 'panorama-order.json'),
    layoutOrderPath: path.join(projectPaths.data, 'layout-order.json'),
    hiddenPanosPath: path.join(projectPaths.data, 'hidden-panos.json'),
    projectId,
  };
}

/* Gets get project id from query. */
function getProjectIdFromQuery(req) {
  if (req.query && typeof req.query === 'object') {
    let token = null;
    if (typeof req.query.project === 'string' && req.query.project.length > 0) {
      token = req.query.project;
    } else {
      const keys = Object.keys(req.query);
      if (keys.length === 1 && req.query[keys[0]] === '') token = keys[0];
    }
    if (token) {
      const project = findProjectByIdOrNumber(token);
      return project ? project.id : token;
    }
  }
  return null;
}

module.exports = {
  getProjectPaths,
  ensureProjectDirs,
  resolvePaths,
  getProjectIdFromQuery,
};
