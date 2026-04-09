const express = require('express');
const path = require('path');
const {
  attachAuthenticatedUser,
  protectHtmlPages,
  protectMutationRequests,
} = require('./middleware/auth.middleware');
const { guardProjectPages } = require('./middleware/project-page.middleware');
const {
  clearSessionCookie,
  getHomePathForUser,
} = require('./services/auth.service');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const projectRoutes = require('./routes/project.routes');
const createProjectAssetsRouter = require('./routes/project-assets.routes');
const jobRoutes = require('./routes/job.routes');
const archiveRoutes = require('./routes/archive.routes');
const panoramaRoutes = require('./routes/panorama.routes');
const floorplanRoutes = require('./routes/floorplan.routes');
const editorRoutes = require('./routes/editor.routes');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(protectHtmlPages);
  app.use(protectMutationRequests);

  app.get('/', attachAuthenticatedUser, (req, res) => {
    if (!req.authUser) {
      clearSessionCookie(res);
      return res.redirect('/login.html');
    }
    return res.redirect(getHomePathForUser(req.authUser));
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use(archiveRoutes);
  app.use(panoramaRoutes);
  app.use(floorplanRoutes);
  app.use(editorRoutes);

  app.use(guardProjectPages);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/projects/:projectId', createProjectAssetsRouter());

  return app;
}

module.exports = {
  createApp,
};
