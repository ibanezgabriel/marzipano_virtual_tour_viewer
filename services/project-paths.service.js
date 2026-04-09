const path = require('path');
const {
  findProjectByIdOrNumber,
  projectsDir,
} = require('./project-manifest.service');

function getProjectPaths(projectId) {
  if (!projectId || projectId.includes('..') || /[\/\\]/.test(projectId)) return null;
  const base = path.join(projectsDir, projectId);
  return {
    base,
    upload: path.join(base, 'upload'),
    floorplans: path.join(base, 'floorplans'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

function ensureProjectDirs(projectId) {
  const fs = require('fs');
  const projectPaths = getProjectPaths(projectId);
  if (!projectPaths) return null;
  [projectPaths.upload, projectPaths.floorplans, projectPaths.tiles, projectPaths.data].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  return projectPaths;
}

function resolvePaths(req) {
  const projectToken = req.query.project || (req.body && req.body.project);
  const project = findProjectByIdOrNumber(projectToken);
  const projectId = project ? project.id : projectToken;
  const projectPaths = getProjectPaths(projectId);
  if (!projectPaths) return null;
  return {
    uploadsDir: projectPaths.upload,
    floorplansDir: projectPaths.floorplans,
    tilesDir: projectPaths.tiles,
    hotspotsPath: path.join(projectPaths.data, 'hotspots.json'),
    blurMasksPath: path.join(projectPaths.data, 'blur-masks.json'),
    floorplanHotspotsPath: path.join(projectPaths.data, 'floorplan-hotspots.json'),
    initialViewsPath: path.join(projectPaths.data, 'initial-views.json'),
    panoramaOrderPath: path.join(projectPaths.data, 'panorama-order.json'),
    floorplanOrderPath: path.join(projectPaths.data, 'floorplan-order.json'),
    projectId,
  };
}

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
