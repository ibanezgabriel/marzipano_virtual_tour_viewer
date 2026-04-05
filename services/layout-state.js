const fs = require('fs');
const path = require('path');
const { listFloorplanImages } = require('../utils/layout-files');

function readFloorplanOrder(primaryPath, legacyPath) {
  try {
    const raw = fs.readFileSync(primaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading layout order:', e);
  }
  try {
    if (!legacyPath) return [];
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading legacy floorplan order:', e);
  }
  return [];
}

function writeFloorplanOrder(primaryPath, order) {
  const dir = path.dirname(primaryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(primaryPath, JSON.stringify(order, null, 2), 'utf8');
}

function readFloorplanHotspots(primaryPath, legacyPath) {
  try {
    const raw = fs.readFileSync(primaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading layout hotspots:', e);
  }
  try {
    if (!legacyPath) return {};
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading legacy floor plan hotspots:', e);
  }
  return {};
}

function writeFloorplanHotspots(primaryPath, hotspots) {
  const dir = path.dirname(primaryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(primaryPath, JSON.stringify(hotspots, null, 2), 'utf8');
}

function clearFloorplanHotspotsForFilenames(paths, filenames) {
  const names = Array.from(new Set((filenames || []).filter(Boolean)));
  if (names.length === 0) return { changed: false, hotspots: null };
  const hotspots = readFloorplanHotspots(paths.layoutHotspotsPath, paths.floorplanHotspotsPath);
  let changed = false;
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(hotspots, name)) {
      delete hotspots[name];
      changed = true;
    }
  });
  if (changed) writeFloorplanHotspots(paths.layoutHotspotsPath, hotspots);
  return { changed, hotspots };
}

function floorplanOrderReplace(paths, oldFilename, newFilename) {
  const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
  const i = order.indexOf(oldFilename);
  if (i !== -1) order[i] = newFilename;
  else order.push(newFilename);
  const deduped = [];
  const seen = new Set();
  for (const f of order) {
    if (seen.has(f)) continue;
    seen.add(f);
    deduped.push(f);
  }
  writeFloorplanOrder(paths.layoutOrderPath, deduped);
  return deduped;
}

/** Return ordered list of floor plan filenames; stored order first, then any new files not in list. */
async function getOrderedFloorplanFilenames(paths) {
  const existing = await listFloorplanImages(paths.layoutsDir, paths.floorplansLegacyDir);
  const existingSet = new Set(existing);
  let order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath).filter(f => existingSet.has(f));
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  const orderChanged = order.length !== result.length || appended.length > 0;
  if (orderChanged && result.length > 0) {
    writeFloorplanOrder(paths.layoutOrderPath, result);
  }
  return result;
}

function floorplanOrderAppend(paths, filenames) {
  const order = readFloorplanOrder(paths.layoutOrderPath, paths.floorplanOrderPath);
  const set = new Set(order);
  let changed = false;
  for (const f of filenames || []) {
    if (!f || set.has(f)) continue;
    order.push(f);
    set.add(f);
    changed = true;
  }
  if (changed) writeFloorplanOrder(paths.layoutOrderPath, order);
  return order;
}

module.exports = {
  readFloorplanOrder,
  writeFloorplanOrder,
  readFloorplanHotspots,
  writeFloorplanHotspots,
  clearFloorplanHotspotsForFilenames,
  floorplanOrderReplace,
  getOrderedFloorplanFilenames,
  floorplanOrderAppend,
};

