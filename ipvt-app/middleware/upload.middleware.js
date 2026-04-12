const fs = require('fs');
const multer = require('multer');
const { findProjectByIdOrNumber } = require('../services/project-manifest.service');
const { getProjectPaths } = require('../services/project-paths.service');

function createProjectStorage(dirKey) {
  return multer.diskStorage({
    destination: (req, _file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const projectPaths = getProjectPaths(projectId);
      if (!projectPaths) return cb(new Error('Project required'), null);
      const dir = projectPaths[dirKey];
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  });
}

const panoramaUpload = multer({
  storage: createProjectStorage('upload'),
});

const layoutUpload = multer({
  storage: createProjectStorage('layouts'),
});

module.exports = {
  panoramaUpload,
  layoutUpload,
};
