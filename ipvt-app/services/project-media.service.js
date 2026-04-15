/* Handles project media files, ordering, and metadata. */
const fs = require('fs');
const path = require('path');
const {
  buildTilesForImage,
  readTilesMeta,
} = require('../public/js/tiler');

const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp|jfif)$/i;

/* Returns uploaded panorama image filenames. */
async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter((file) => IMAGE_PATTERN.test(file));
}

/* Returns uploaded layout image filenames. */
async function listLayoutImages(layoutsDir) {
  try {
    const files = await fs.promises.readdir(layoutsDir);
    return files.filter((file) => IMAGE_PATTERN.test(file));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading layouts dir:', error);
    return [];
  }
}

/* Reads the saved layout display order. */
function readLayoutOrder(layoutOrderPath) {
  try {
    const raw = fs.readFileSync(layoutOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading layout order:', error);
    return [];
  }
}

/* Writes the saved layout display order. */
function writeLayoutOrder(layoutOrderPath, order) {
  const dir = path.dirname(layoutOrderPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(layoutOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

/* Reads saved hotspot positions for layouts. */
function readLayoutHotspots(layoutHotspotsPath) {
  try {
    const raw = fs.readFileSync(layoutHotspotsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading layout hotspots:', error);
    return {};
  }
}

/* Writes saved hotspot positions for layouts. */
function writeLayoutHotspots(layoutHotspotsPath, hotspots) {
  const dir = path.dirname(layoutHotspotsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(layoutHotspotsPath, JSON.stringify(hotspots, null, 2), 'utf8');
}

/* Reads saved blur mask data. */
function readBlurMasks(blurMasksPath) {
  try {
    const raw = fs.readFileSync(blurMasksPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading blur masks:', error);
    return {};
  }
}

/* Writes saved blur mask data. */
function writeBlurMasks(blurMasksPath, blurMasks) {
  const dir = path.dirname(blurMasksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blurMasksPath, JSON.stringify(blurMasks, null, 2), 'utf8');
}

/* Moves blur mask data to a renamed panorama. */
function renameBlurMasksForPano(paths, oldFilename, newFilename) {
  if (!oldFilename || !newFilename || oldFilename === newFilename) {
    return { changed: false, blurMasks: null };
  }
  const blurMasks = readBlurMasks(paths.blurMasksPath);
  if (!Object.prototype.hasOwnProperty.call(blurMasks, oldFilename)) {
    return { changed: false, blurMasks: null };
  }
  const oldList = Array.isArray(blurMasks[oldFilename]) ? blurMasks[oldFilename] : [];
  const newList = Array.isArray(blurMasks[newFilename]) ? blurMasks[newFilename] : [];
  blurMasks[newFilename] = [...newList, ...oldList];
  delete blurMasks[oldFilename];
  writeBlurMasks(paths.blurMasksPath, blurMasks);
  return { changed: true, blurMasks };
}

/* Removes blur masks for deleted panorama files. */
function clearBlurMasksForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, blurMasks: null };
  const blurMasks = readBlurMasks(paths.blurMasksPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(blurMasks, name)) {
      delete blurMasks[name];
      changed = true;
    }
  });
  if (changed) writeBlurMasks(paths.blurMasksPath, blurMasks);
  return { changed, blurMasks };
}

/* Removes layout hotspots for deleted files. */
function clearLayoutHotspotsForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, hotspots: null };
  const hotspots = readLayoutHotspots(paths.layoutHotspotsPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(hotspots, name)) {
      delete hotspots[name];
      changed = true;
    }
  });
  if (changed) writeLayoutHotspots(paths.layoutHotspotsPath, hotspots);
  return { changed, hotspots };
}

/* Replaces a filename inside the saved layout order. */
function layoutOrderReplace(paths, oldFilename, newFilename) {
  const order = readLayoutOrder(paths.layoutOrderPath);
  const index = order.indexOf(oldFilename);
  if (index !== -1) order[index] = newFilename;
  else order.push(newFilename);
  const deduped = [];
  const seen = new Set();
  for (const filename of order) {
    if (seen.has(filename)) continue;
    seen.add(filename);
    deduped.push(filename);
  }
  writeLayoutOrder(paths.layoutOrderPath, deduped);
  return deduped;
}

/* Returns layouts in their saved display order. */
async function getOrderedLayoutFilenames(paths) {
  const existing = await listLayoutImages(paths.layoutsDir);
  const existingSet = new Set(existing);
  const order = readLayoutOrder(paths.layoutOrderPath).filter((filename) => existingSet.has(filename));
  const inOrder = new Set(order);
  const appended = existing.filter((filename) => !inOrder.has(filename));
  const result = [...order, ...appended];
  const orderChanged = order.length !== result.length || appended.length > 0;
  if (orderChanged && result.length > 0) {
    writeLayoutOrder(paths.layoutOrderPath, result);
  }
  return result;
}

/* Appends new layouts to the saved order. */
function layoutOrderAppend(paths, filenames) {
  const order = readLayoutOrder(paths.layoutOrderPath);
  const set = new Set(order);
  let changed = false;
  for (const filename of filenames || []) {
    if (!filename || set.has(filename)) continue;
    order.push(filename);
    set.add(filename);
    changed = true;
  }
  if (changed) writeLayoutOrder(paths.layoutOrderPath, order);
  return order;
}

/* Returns panoramas in their saved display order. */
async function getOrderedFilenames(paths) {
  const existing = await listUploadedImages(paths.uploadsDir);
  const existingSet = new Set(existing);
  let parsedOrder = [];
  try {
    const raw = fs.readFileSync(paths.panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsedOrder = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading panorama order:', error);
  }
  const seen = new Set();
  const order = parsedOrder.filter((filename) => {
    if (!existingSet.has(filename) || seen.has(filename)) return false;
    seen.add(filename);
    return true;
  });
  const inOrder = new Set(order);
  const appended = existing.filter((filename) => !inOrder.has(filename));
  const result = [...order, ...appended];
  const orderChanged = parsedOrder.length !== order.length || parsedOrder.some((value, index) => value !== order[index]);
  if ((orderChanged || appended.length > 0) && result.length > 0) {
    writePanoramaOrder(paths.panoramaOrderPath, result);
  }
  return result;
}

/* Reads the saved panorama display order. */
function readPanoramaOrder(panoramaOrderPath) {
  try {
    const raw = fs.readFileSync(panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading panorama order:', error);
    return [];
  }
}

/* Writes the saved panorama display order. */
function writePanoramaOrder(panoramaOrderPath, order) {
  fs.writeFileSync(panoramaOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

/* Replaces a filename inside the panorama order. */
function panoramaOrderReplace(paths, oldFilename, newFilename) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const replaced = order.map((filename) => (filename === oldFilename ? newFilename : filename));
  const deduped = [];
  const seen = new Set();
  for (const filename of replaced) {
    if (seen.has(filename)) continue;
    seen.add(filename);
    deduped.push(filename);
  }
  if (!seen.has(newFilename)) deduped.push(newFilename);
  writePanoramaOrder(paths.panoramaOrderPath, deduped);
}

/* Handles panorama order append. */
function panoramaOrderAppend(paths, filenames) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const set = new Set(order);
  for (const filename of filenames) {
    if (!set.has(filename)) {
      order.push(filename);
      set.add(filename);
    }
  }
  writePanoramaOrder(paths.panoramaOrderPath, order);
}

/* Sets up ensure tiles for filename. */
async function ensureTilesForFilename(paths, filename) {
  const meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
  if (meta) return meta;

  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${filename}`);
  }

  await buildTilesForImage({
    imagePath,
    filename,
    tilesRootDir: paths.tilesDir,
  });
  const builtMeta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
  if (!builtMeta) throw new Error('Tiles built but meta.json missing');
  return builtMeta;
}

module.exports = {
  listUploadedImages,
  readLayoutOrder,
  writeLayoutOrder,
  getOrderedLayoutFilenames,
  layoutOrderAppend,
  layoutOrderReplace,
  getOrderedFilenames,
  writePanoramaOrder,
  panoramaOrderAppend,
  panoramaOrderReplace,
  ensureTilesForFilename,
  renameBlurMasksForPano,
  clearBlurMasksForFilenames,
  clearLayoutHotspotsForFilenames,
};
