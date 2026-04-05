const fs = require('fs');
const path = require('path');

async function listFloorplanImages(primaryDir, legacyDir = null) {
  const dirs = [primaryDir, legacyDir].filter(Boolean);
  const uniqueDirs = Array.from(new Set(dirs));
  const files = new Set();

  for (const dir of uniqueDirs) {
    try {
      const names = await fs.promises.readdir(dir);
      names
        .filter((file) => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file))
        .forEach((file) => files.add(file));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Error reading layouts dir:', e);
    }
  }

  return Array.from(files);
}

function resolveFloorplanImagePath(paths, filename) {
  const candidates = [];
  if (paths && paths.layoutsDir) candidates.push(path.join(paths.layoutsDir, filename));
  if (paths && paths.floorplansLegacyDir) candidates.push(path.join(paths.floorplansLegacyDir, filename));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || null;
}

module.exports = {
  listFloorplanImages,
  resolveFloorplanImagePath,
};

