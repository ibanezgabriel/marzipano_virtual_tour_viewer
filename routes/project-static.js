const express = require('express');
const fs = require('fs');

function createProjectStaticRouter({ projectsService, getValidSessionUser, isAdminRole }) {
  const projectRouter = express.Router({ mergeParams: true });

  projectRouter.use('/upload', async (req, res, next) => {
    const token = req.params.projectId;
    const project = await projectsService.findProjectByIdOrNumber(token);
    const id = project ? project.id : token;
    const folderName = project ? (projectsService.getProjectFolderName(project) || id) : token;
    const workflow = project ? String(project.workflow_state || 'DRAFT') : 'DRAFT';
    if (workflow !== 'PUBLISHED') {
      const user = await getValidSessionUser(req);
      if (!user || !isAdminRole(user.role)) return res.status(404).send('Not found');
    }
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
    const p = projectsService.getProjectPaths(folderName);
    if (!p) return res.status(400).send('Invalid project');
    if (!fs.existsSync(p.upload)) return next();
    express.static(p.upload)(req, res, next);
  });

  projectRouter.use(['/layouts', '/floorplans'], async (req, res, next) => {
    const token = req.params.projectId;
    const project = await projectsService.findProjectByIdOrNumber(token);
    const id = project ? project.id : token;
    const folderName = project ? (projectsService.getProjectFolderName(project) || id) : token;
    const workflow = project ? String(project.workflow_state || 'DRAFT') : 'DRAFT';
    if (workflow !== 'PUBLISHED') {
      const user = await getValidSessionUser(req);
      if (!user || !isAdminRole(user.role)) return res.status(404).send('Not found');
    }
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
    const p = projectsService.getProjectPaths(folderName);
    if (!p) return res.status(400).send('Invalid project');

    const middleware = [];
    if (fs.existsSync(p.layouts)) middleware.push(express.static(p.layouts));
    if (fs.existsSync(p.floorplans)) middleware.push(express.static(p.floorplans));
    if (middleware.length === 0) return next();

    let idx = 0;
    const run = (err) => {
      if (err) return next(err);
      const mw = middleware[idx++];
      if (!mw) return next();
      mw(req, res, run);
    };
    run();
  });

  projectRouter.use('/tiles', async (req, res, next) => {
    const token = req.params.projectId;
    const project = await projectsService.findProjectByIdOrNumber(token);
    const id = project ? project.id : token;
    const folderName = project ? (projectsService.getProjectFolderName(project) || id) : token;
    const workflow = project ? String(project.workflow_state || 'DRAFT') : 'DRAFT';
    if (workflow !== 'PUBLISHED') {
      const user = await getValidSessionUser(req);
      if (!user || !isAdminRole(user.role)) return res.status(404).send('Not found');
    }
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
    const p = projectsService.getProjectPaths(folderName);
    if (!p) return res.status(400).send('Invalid project');
    if (!fs.existsSync(p.tiles)) return next();
    express.static(p.tiles)(req, res, next);
  });

  return projectRouter;
}

module.exports = createProjectStaticRouter;
