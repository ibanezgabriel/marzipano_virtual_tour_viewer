const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const projectsDir = path.join(__dirname, '..', 'projects');

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

ensureDirSync(projectsDir);

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

function createStoredUploadFilename(originalName) {
  const base = path.basename(String(originalName || 'image'));
  const safe = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${Date.now()}-${nonce}-${safe || 'image'}`;
}

/** Get paths for a project. projectId must be validated (no .., no slashes). */
function getProjectPaths(projectId) {
  const id = String(projectId || '');
  if (!id || id.includes('..') || /[\/\\]/.test(id)) return null;
  const base = path.join(projectsDir, id);
  return {
    base,
    upload: path.join(base, 'upload'),
    layouts: path.join(base, 'layouts'),
    floorplans: path.join(base, 'floorplans'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

function createProjectDestination(getDir) {
  return async (req, file, cb) => {
    try {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = await findProjectByIdOrNumber(projectToken);
      const folderName = project ? String(project.folder_name || project.id || '').trim() : String(projectToken || '').trim();
      const p = getProjectPaths(folderName);
      if (!p) return cb(new Error('Project required'), null);
      const dir = getDir(p);
      ensureDirSync(dir);
      cb(null, dir);
    } catch (err) {
      cb(err, null);
    }
  };
}

// Multer: dynamic destination based on project (set by route)
const upload = multer({
  storage: multer.diskStorage({
    destination: createProjectDestination((p) => p.upload),
    filename: (req, file, cb) => {
      cb(null, createStoredUploadFilename(file.originalname));
    },
  }),
});

// Separate storage for layout images (project-scoped "layouts" directory; legacy fallback: "floorplans")
const floorplanUpload = multer({
  storage: multer.diskStorage({
    destination: createProjectDestination((p) => p.layouts),
    filename: (req, file, cb) => {
      cb(null, createStoredUploadFilename(file.originalname));
    },
  }),
});

module.exports = {
  upload,
  floorplanUpload,
};

