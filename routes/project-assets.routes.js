const express = require('express');
const fs = require('fs');
const { findProjectByIdOrNumber } = require('../services/project-manifest.service');
const { getProjectPaths } = require('../services/project-paths.service');

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

function createProjectAssetsRouter() {
  const router = express.Router({ mergeParams: true });
  router.use('/upload', createStaticProjectDirMiddleware('upload'));
  router.use('/floorplans', createStaticProjectDirMiddleware('floorplans'));
  router.use('/tiles', createStaticProjectDirMiddleware('tiles'));
  return router;
}

module.exports = createProjectAssetsRouter;
