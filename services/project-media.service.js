const fs = require('fs');
const path = require('path');
const {
  buildTilesForImage,
  readTilesMeta,
} = require('../public/js/tiler');

const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp|jfif)$/i;

async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter((file) => IMAGE_PATTERN.test(file));
}

async function listFloorplanImages(floorplansDir) {
  try {
    const files = await fs.promises.readdir(floorplansDir);
    return files.filter((file) => IMAGE_PATTERN.test(file));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading floorplans dir:', error);
    return [];
  }
}

function readFloorplanOrder(floorplanOrderPath) {
  try {
    const raw = fs.readFileSync(floorplanOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading floorplan order:', error);
    return [];
  }
}

function writeFloorplanOrder(floorplanOrderPath, order) {
  const dir = path.dirname(floorplanOrderPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(floorplanOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

function readFloorplanHotspots(floorplanHotspotsPath) {
  try {
    const raw = fs.readFileSync(floorplanHotspotsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading floor plan hotspots:', error);
    return {};
  }
}

function writeFloorplanHotspots(floorplanHotspotsPath, hotspots) {
  const dir = path.dirname(floorplanHotspotsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(floorplanHotspotsPath, JSON.stringify(hotspots, null, 2), 'utf8');
}

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

function writeBlurMasks(blurMasksPath, blurMasks) {
  const dir = path.dirname(blurMasksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blurMasksPath, JSON.stringify(blurMasks, null, 2), 'utf8');
}

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

function clearFloorplanHotspotsForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, hotspots: null };
  const hotspots = readFloorplanHotspots(paths.floorplanHotspotsPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(hotspots, name)) {
      delete hotspots[name];
      changed = true;
    }
  });
  if (changed) writeFloorplanHotspots(paths.floorplanHotspotsPath, hotspots);
  return { changed, hotspots };
}

function floorplanOrderReplace(paths, oldFilename, newFilename) {
  const order = readFloorplanOrder(paths.floorplanOrderPath);
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
  writeFloorplanOrder(paths.floorplanOrderPath, deduped);
  return deduped;
}

async function getOrderedFloorplanFilenames(paths) {
  const existing = await listFloorplanImages(paths.floorplansDir);
  const existingSet = new Set(existing);
  const order = readFloorplanOrder(paths.floorplanOrderPath).filter((filename) => existingSet.has(filename));
  const inOrder = new Set(order);
  const appended = existing.filter((filename) => !inOrder.has(filename));
  const result = [...order, ...appended];
  const orderChanged = order.length !== result.length || appended.length > 0;
  if (orderChanged && result.length > 0) {
    writeFloorplanOrder(paths.floorplanOrderPath, result);
  }
  return result;
}

function floorplanOrderAppend(paths, filenames) {
  const order = readFloorplanOrder(paths.floorplanOrderPath);
  const set = new Set(order);
  let changed = false;
  for (const filename of filenames || []) {
    if (!filename || set.has(filename)) continue;
    order.push(filename);
    set.add(filename);
    changed = true;
  }
  if (changed) writeFloorplanOrder(paths.floorplanOrderPath, order);
  return order;
}

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

function writePanoramaOrder(panoramaOrderPath, order) {
  fs.writeFileSync(panoramaOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

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
  readFloorplanOrder,
  writeFloorplanOrder,
  getOrderedFloorplanFilenames,
  floorplanOrderAppend,
  floorplanOrderReplace,
  getOrderedFilenames,
  writePanoramaOrder,
  panoramaOrderAppend,
  panoramaOrderReplace,
  ensureTilesForFilename,
  renameBlurMasksForPano,
  clearFloorplanHotspotsForFilenames,
};
