/* Configures upload handling for project media files. */
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { findProjectByIdOrNumber } = require('../services/project-manifest.service');
const { getProjectPaths } = require('../services/project-paths.service');

const MAX_UPLOAD_FILE_SIZE_BYTES = 30 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function normalizeOriginalName(value) {
  const text = String(value || '')
    .replace(/\0/g, '')
    .trim();
  try {
    return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch (_error) {
    return text;
  }
}

function sanitizeFilename(originalname) {
  const raw = normalizeOriginalName(originalname);
  const base = path.basename(raw);
  const extRaw = path.extname(base);
  const extClean = extRaw
    ? `.${extRaw.slice(1).replace(/[^a-z0-9]+/gi, '').toLowerCase()}`
    : '';
  const nameRaw = extRaw ? base.slice(0, -extRaw.length) : base;
  let nameClean = nameRaw.replace(/[^a-z0-9_-]+/gi, '');
  nameClean = nameClean.replace(/^[_-]+/, '').replace(/[_-]+$/, '');
  if (!nameClean) nameClean = 'upload';
  if (WINDOWS_RESERVED_BASENAMES.has(nameClean.toLowerCase())) {
    nameClean = `file-${nameClean}`;
  }
  const limited = nameClean.slice(0, 80);
  const extLimited = extClean && extClean !== '.' ? extClean.slice(0, 10) : '';
  return `${limited}${extLimited}`;
}

/* Sets up create project storage. */
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
      const safeOriginal = sanitizeFilename(file.originalname);
      const nonce = crypto.randomBytes(6).toString('hex');
      cb(null, `${Date.now()}-${nonce}-${safeOriginal}`);
    },
  });
}

const panoramaUpload = multer({
  storage: createProjectStorage('upload'),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!file || !ALLOWED_IMAGE_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      req.fileValidationError = 'Only JPG/JPEG/PNG images are allowed.';
      return cb(null, false);
    }
    return cb(null, true);
  },
});

const layoutUpload = multer({
  storage: createProjectStorage('layouts'),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!file || !ALLOWED_IMAGE_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      req.fileValidationError = 'Only JPG/JPEG/PNG images are allowed.';
      return cb(null, false);
    }
    return cb(null, true);
  },
});

module.exports = {
  panoramaUpload,
  layoutUpload,
};
