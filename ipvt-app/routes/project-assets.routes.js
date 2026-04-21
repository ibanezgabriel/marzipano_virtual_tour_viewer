/* Registers project asset API endpoints. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  attachAuthenticatedUser,
  requireAuthenticatedApi,
} = require('../middleware/auth.middleware');
const { getHiddenPanosSet } = require('../services/project-media.service');
const { findProjectByIdOrNumber } = require('../services/project-manifest.service');
const { getProjectPaths } = require('../services/project-paths.service');
const { tileIdFromFilename } = require('../public/js/tiler');

function isUnsafeFilename(value) {
  const name = String(value || '');
  return !name || name.includes('..') || name.includes('/') || name.includes('\\');
}

/* Sets up create static project dir middleware. */
function createStaticProjectDirMiddleware(dirKey) {
  return (req, res, next) => {
    const token = req.params.projectId;
    const project = findProjectByIdOrNumber(token);
    const projectId = project ? project.id : token;
    const projectPaths = getProjectPaths(projectId);
    if (!projectPaths) return res.status(400).send('Invalid project');
    const dirPath = projectPaths[dirKey];
    if (!fs.existsSync(dirPath)) return next();
    return express.static(dirPath)(req, res, next);
  };
}

/* Sets up create project assets router. */
function createProjectAssetsRouter() {
  const router = express.Router({ mergeParams: true });

  // Raw uploads are protected (not publicly accessible).
  router.get('/upload/:filename', attachAuthenticatedUser, requireAuthenticatedApi, (req, res) => {
    const token = req.params.projectId;
    const filename = req.params.filename;
    if (isUnsafeFilename(filename)) return res.status(400).send('Invalid filename');

    const project = findProjectByIdOrNumber(token);
    const projectId = project ? project.id : token;
    const projectPaths = getProjectPaths(projectId);
    if (!projectPaths) return res.status(400).send('Invalid project');

    const filePath = path.join(projectPaths.upload, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.resolve(filePath));
  });

  router.use('/layouts', createStaticProjectDirMiddleware('layouts'));
  router.use(
    '/tiles',
    attachAuthenticatedUser,
    (req, res, next) => {
      if (req.authUser) return next();
      const token = req.params.projectId;
      const project = findProjectByIdOrNumber(token);
      const projectId = project ? project.id : token;
      const projectPaths = getProjectPaths(projectId);
      if (!projectPaths) return res.status(400).send('Invalid project');

      const requestedTileId = String(req.path || '')
        .split('/')
        .filter(Boolean)[0];
      if (!requestedTileId) return next();

      const hiddenPanosPath = path.join(projectPaths.data, 'hidden-panos.json');
      const hiddenSet = getHiddenPanosSet({ hiddenPanosPath });
      if (!hiddenSet || hiddenSet.size === 0) return next();

      const hiddenTileIds = new Set(Array.from(hiddenSet).map((filename) => tileIdFromFilename(filename)));
      if (hiddenTileIds.has(requestedTileId)) {
        return res.status(404).send('Not found');
      }

      return next();
    },
    createStaticProjectDirMiddleware('tiles')
  );
  return router;
}

module.exports = createProjectAssetsRouter;
