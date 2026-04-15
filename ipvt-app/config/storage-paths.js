/* Centralizes the filesystem paths used for project storage. */
const path = require('path');

/* Handles resolve storage root dir. */
function resolveStorageRootDir() {
  const fromEnv = String(process.env.IPVT_STORAGE_ROOT || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Default to the repo's sibling directory: <repo>/ipvt-storage
  return path.join(__dirname, '..', '..', 'ipvt-storage');
}

const storageRootDir = resolveStorageRootDir();
const projectsDir = path.join(storageRootDir, 'projects');

module.exports = {
  storageRootDir,
  projectsDir,
};

