require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { clearAllSessions } = require('./db/users');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists
} = require('./public/js/tiler');
const { findProjectByIdOrNumber } = require('./services/project-manifest.service');
const { getProjectPaths, resolvePaths } = require('./services/project-paths.service');
const { syncProjectToDatabaseOrThrow } = require('./services/project-sync.service');
const {
  protectHtmlPages,
  protectMutationRequests,
} = require('./middleware/auth.middleware');
const { guardProjectPages } = require('./middleware/project-page.middleware');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const projectRoutes = require('./routes/project.routes');
const createProjectAssetsRouter = require('./routes/project-assets.routes');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const { Server } = require('socket.io');

// ---- Audit log (per active pano / floorplan) ----
const AUDIT_LOG_MAX_ENTRIES = 250;

function getAuditDirs(paths) {
  const dataDir = path.dirname(paths.hotspotsPath);
  const base = path.join(dataDir, 'audit');
  return {
    base,
    panos: path.join(base, 'panos'),
    floorplans: path.join(base, 'floorplans'),
    imagesBase: path.join(base, 'images'),
    panoImages: path.join(base, 'images', 'panos'),
    floorplanImages: path.join(base, 'images', 'floorplans'),
  };
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function auditLogPath(paths, kind, filename) {
  const dirs = getAuditDirs(paths);
  const safe = encodeURIComponent(String(filename || ''));
  const baseDir = kind === 'floorplan' ? dirs.floorplans : dirs.panos;
  return path.join(baseDir, `${safe}.json`);
}

function auditImagePath(paths, kind, storedFilename) {
  const dirs = getAuditDirs(paths);
  const baseDir = kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages;
  return path.join(baseDir, storedFilename);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function resolveArchiveImagePath(paths, kind, storedFilename) {
  const dirs = getAuditDirs(paths);
  const baseDir = kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages;
  const candidates = new Set();
  const raw = String(storedFilename || '');
  const dec1 = safeDecodeURIComponent(raw);
  const dec2 = safeDecodeURIComponent(dec1);

  [raw, dec1, dec2, encodeURIComponent(raw), encodeURIComponent(dec1)]
    .filter(Boolean)
    .forEach((name) => {
      if (name.includes('..') || name.includes('/') || name.includes('\\')) return;
      candidates.add(name);
    });

  for (const candidate of candidates) {
    const candidatePath = path.join(baseDir, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }

  // Legacy fallback: some older logs may store only a suffix of the archived filename.
  try {
    const files = fs.readdirSync(baseDir);
    for (const candidate of candidates) {
      const match = files.find((name) => name === candidate || name.endsWith(`-${candidate}`));
      if (match) return path.join(baseDir, match);
    }
  } catch (e) {}

  return null;
}

function createAuditImageStoredFilename(filename) {
  const encoded = encodeURIComponent(String(filename || 'image'));
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${nonce}-${encoded}`;
}

function storeReplacedImageInAudit(paths, kind, originalFilename, sourcePath) {
  if (!paths || !sourcePath || !fs.existsSync(sourcePath)) return null;
  const dirs = getAuditDirs(paths);
  ensureDirSync(dirs.base);
  ensureDirSync(dirs.imagesBase);
  ensureDirSync(kind === 'floorplan' ? dirs.floorplanImages : dirs.panoImages);
  const storedFilename = createAuditImageStoredFilename(originalFilename);
  const targetPath = auditImagePath(paths, kind, storedFilename);
  fs.copyFileSync(sourcePath, targetPath);
  return {
    kind,
    originalFilename: String(originalFilename || ''),
    storedFilename,
  };
}

function readJsonFileOrDefault(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? defaultValue;
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultValue;
    console.error('Error reading json file:', filePath, e);
    return defaultValue;
  }
}

function readAuditEntries(paths, kind, filename) {
  const filePath = auditLogPath(paths, kind, filename);
  const parsed = readJsonFileOrDefault(filePath, null);
  return Array.isArray(parsed) ? parsed : null;
}

function writeAuditEntries(paths, kind, filename, entries) {
  const dirs = getAuditDirs(paths);
  ensureDirSync(dirs.base);
  ensureDirSync(kind === 'floorplan' ? dirs.floorplans : dirs.panos);
  const filePath = auditLogPath(paths, kind, filename);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

function appendAuditEntry(paths, kind, filename, { action, message, meta } = {}, { dedupeWindowMs = 0 } = {}) {
  if (!paths || !filename) return;
  try {
    const existing = readAuditEntries(paths, kind, filename) || [];
    const nowIso = new Date().toISOString();
    const entry = {
      ts: nowIso,
      action: action || 'update',
      message: message || action || 'Update',
      ...(meta && typeof meta === 'object' ? { meta } : {}),
    };
    if (dedupeWindowMs > 0 && existing.length > 0) {
      const last = existing[existing.length - 1];
      const lastTs = last && last.ts ? new Date(last.ts).getTime() : 0;
      const nowTs = Date.now();
      const sameAction = last && last.action === entry.action && last.message === entry.message;
      if (sameAction && lastTs && nowTs - lastTs < dedupeWindowMs) {
        return;
      }
    }
    const updated = [...existing, entry].slice(-AUDIT_LOG_MAX_ENTRIES);
    writeAuditEntries(paths, kind, filename, updated);
  } catch (e) {
    console.error('Error appending audit entry:', e);
  }
}

function buildAuditMeta(meta, user) {
  const nextMeta = meta && typeof meta === 'object' ? { ...meta } : {};
  const userId = user && String(user.id || '').trim();
  if (userId) {
    nextMeta.createdByUserId = userId;
  }
  return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
}

function initAuditLogIfMissing(paths, kind, filename) {
  if (!paths || !filename) return;
  const existing = readAuditEntries(paths, kind, filename);
  if (Array.isArray(existing)) return;
  const baseline = [
    {
      ts: new Date().toISOString(),
      action: 'archive-enabled',
      message: 'No previous records are available.',
    },
  ];
  try {
    writeAuditEntries(paths, kind, filename, baseline);
  } catch (e) {
    console.error('Error initializing audit log:', e);
  }
}

function parseReplacedFilenamesFromAuditMessage(message) {
  const text = String(message || '');
  const match = text.match(/replaced\s+"([^"]+)"\s+with\s+"([^"]+)"/i);
  if (!match) return null;
  const oldFilename = (match[1] || '').trim();
  const newFilename = (match[2] || '').trim();
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

function repairArchiveMetaInEntry(paths, kind, entry) {
  if (!entry || typeof entry !== 'object') return { entry, changed: false };
  const replaced = parseReplacedFilenamesFromAuditMessage(entry.message);
  if (!replaced) return { entry, changed: false };

  const currentMeta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
  const currentArchived = currentMeta.archivedImage && typeof currentMeta.archivedImage === 'object'
    ? currentMeta.archivedImage
    : null;
  const metaKind = currentArchived && currentArchived.kind === 'floorplan' ? 'floorplan' : kind;
  const originalFilename = currentArchived && currentArchived.originalFilename
    ? String(currentArchived.originalFilename)
    : replaced.oldFilename;
  const currentStored = currentArchived && currentArchived.storedFilename
    ? String(currentArchived.storedFilename)
    : '';

  let resolvedPath = null;
  if (currentStored) {
    resolvedPath = resolveArchiveImagePath(paths, metaKind, currentStored);
  }
  if (!resolvedPath && originalFilename) {
    resolvedPath = resolveArchiveImagePath(paths, metaKind, originalFilename);
  }
  if (!resolvedPath) return { entry, changed: false };

  const resolvedStoredFilename = path.basename(resolvedPath);
  const nextArchived = {
    kind: metaKind,
    originalFilename,
    storedFilename: resolvedStoredFilename,
  };
  const sameAsCurrent =
    currentArchived &&
    currentArchived.kind === nextArchived.kind &&
    String(currentArchived.originalFilename || '') === nextArchived.originalFilename &&
    String(currentArchived.storedFilename || '') === nextArchived.storedFilename;
  if (sameAsCurrent) return { entry, changed: false };

  return {
    entry: {
      ...entry,
      meta: {
        ...currentMeta,
        archivedImage: nextArchived,
      },
    },
    changed: true,
  };
}

function readAndRepairAuditEntries(paths, kind, filename) {
  const existing = readAuditEntries(paths, kind, filename) || [];
  if (!Array.isArray(existing) || existing.length === 0) return Array.isArray(existing) ? existing : [];
  let changed = false;
  const repaired = existing.map((entry) => {
    const result = repairArchiveMetaInEntry(paths, kind, entry);
    if (result.changed) changed = true;
    return result.entry;
  });
  if (changed) {
    try {
      writeAuditEntries(paths, kind, filename, repaired);
    } catch (e) {
      console.error('Error writing repaired audit entries:', e);
    }
  }
  return repaired;
}

function renameAuditLog(paths, kind, oldFilename, newFilename) {
  if (!paths || !oldFilename || !newFilename || oldFilename === newFilename) return;
  try {
    const oldPath = auditLogPath(paths, kind, oldFilename);
    if (!fs.existsSync(oldPath)) return;
    const dirs = getAuditDirs(paths);
    ensureDirSync(dirs.base);
    ensureDirSync(kind === 'floorplan' ? dirs.floorplans : dirs.panos);
    const newPath = auditLogPath(paths, kind, newFilename);
    if (!fs.existsSync(newPath)) {
      fs.renameSync(oldPath, newPath);
      return;
    }
    const oldEntries = readJsonFileOrDefault(oldPath, []);
    const newEntries = readJsonFileOrDefault(newPath, []);
    const merged = [...(Array.isArray(newEntries) ? newEntries : []), ...(Array.isArray(oldEntries) ? oldEntries : [])];
    merged.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
    fs.writeFileSync(newPath, JSON.stringify(merged.slice(-AUDIT_LOG_MAX_ENTRIES), null, 2), 'utf8');
    fs.unlinkSync(oldPath);
  } catch (e) {
    console.error('Error renaming audit log:', e);
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = sortDeep(value[k]);
      });
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(sortDeep(value));
  } catch (e) {
    return String(value);
  }
}

function diffChangedTopLevelKeys(beforeObj, afterObj) {
  const before = beforeObj && typeof beforeObj === 'object' ? beforeObj : {};
  const after = afterObj && typeof afterObj === 'object' ? afterObj : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  keys.forEach((k) => {
    if (stableStringify(before[k]) !== stableStringify(after[k])) changed.push(k);
  });
  return changed;
}

function normalizeTopLevelArrayMap(obj) {
  const source = obj && typeof obj === 'object' ? obj : {};
  const normalized = {};
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (!Array.isArray(value) || value.length === 0) return;
    normalized[key] = value;
  });
  return normalized;
}

function getArrayCountByKey(obj, key) {
  if (!obj || typeof obj !== 'object') return 0;
  return Array.isArray(obj[key]) ? obj[key].length : 0;
}

function buildCollectionChangeMessage(labelSingular, labelPlural, beforeCount, afterCount) {
  const before = Math.max(0, Number(beforeCount) || 0);
  const after = Math.max(0, Number(afterCount) || 0);
  if (after > before) {
    const delta = after - before;
    return delta === 1 ? `${labelSingular} added.` : `${delta} ${labelPlural} added.`;
  }
  if (after < before) {
    const delta = before - after;
    return delta === 1 ? `${labelSingular} removed.` : `${delta} ${labelPlural} removed.`;
  }
  return `${labelPlural.charAt(0).toUpperCase()}${labelPlural.slice(1)} updated (${after}).`;
}

// Middleware to parse JSON bodies
app.use(express.json());
app.use(protectHtmlPages);
app.use(protectMutationRequests);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use(guardProjectPages);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/projects/:projectId', createProjectAssetsRouter());

// Create HTTP server and socket.io for realtime updates
const https = require('https');

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

const server = https.createServer(sslOptions, app);
const io = new Server(server);

io.on('connection', (socket) => {
  // Allow clients to join project-specific rooms so they only receive relevant pano events
  socket.on('joinProject', (projectId) => {
    try {
      if (typeof projectId === 'string' && projectId.length > 0) socket.join(`project:${projectId}`);
    } catch (e) {}
  });
  socket.on('leaveProject', (projectId) => {
    try {
      if (typeof projectId === 'string' && projectId.length > 0) socket.leave(`project:${projectId}`);
    } catch (e) {}
  });
});

// Multer: dynamic destination based on project (set by route)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.upload;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    },
  }),
});

// Separate storage for floor plan images (project-scoped "floorplans" directory)
const floorplanUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const projectToken = req.query.project || (req.body && req.body.project);
      const project = findProjectByIdOrNumber(projectToken);
      const projectId = project ? project.id : projectToken;
      const p = getProjectPaths(projectId);
      if (!p) return cb(new Error('Project required'), null);
      const dir = p.floorplans;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    },
  }),
});

async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file));
}

async function listFloorplanImages(floorplansDir) {
  try {
    const files = await fs.promises.readdir(floorplansDir);
    return files.filter(file => /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(file));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floorplans dir:', e);
    return [];
  }
}

function readFloorplanOrder(floorplanOrderPath) {
  try {
    const raw = fs.readFileSync(floorplanOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floorplan order:', e);
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
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading floor plan hotspots:', e);
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
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading blur masks:', e);
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

function clearBlurMasksForPano(paths, filename) {
  if (!filename) return { changed: false, blurMasks: null };
  const blurMasks = readBlurMasks(paths.blurMasksPath);
  if (!Object.prototype.hasOwnProperty.call(blurMasks, filename)) {
    return { changed: false, blurMasks: null };
  }
  delete blurMasks[filename];
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
  writeFloorplanOrder(paths.floorplanOrderPath, deduped);
  return deduped;
}

/** Return ordered list of floor plan filenames; stored order first, then any new files not in list. */
async function getOrderedFloorplanFilenames(paths) {
  const existing = await listFloorplanImages(paths.floorplansDir);
  const existingSet = new Set(existing);
  let order = readFloorplanOrder(paths.floorplanOrderPath).filter(f => existingSet.has(f));
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
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
  for (const f of filenames || []) {
    if (!f || set.has(f)) continue;
    order.push(f);
    set.add(f);
    changed = true;
  }
  if (changed) writeFloorplanOrder(paths.floorplanOrderPath, order);
  return order;
}

/** Return ordered list of panorama filenames: stored order first, then any new uploads not in list. */
async function getOrderedFilenames(paths) {
  const existing = await listUploadedImages(paths.uploadsDir);
  const existingSet = new Set(existing);
  let parsedOrder = [];
  try {
    const raw = fs.readFileSync(paths.panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsedOrder = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading panorama order:', e);
  }
  const seen = new Set();
  const order = parsedOrder.filter((f) => {
    if (!existingSet.has(f) || seen.has(f)) return false;
    seen.add(f);
    return true;
  });
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  const orderChanged = parsedOrder.length !== order.length || parsedOrder.some((v, i) => v !== order[i]);
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
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading panorama order:', e);
    return [];
  }
}

function writePanoramaOrder(panoramaOrderPath, order) {
  fs.writeFileSync(panoramaOrderPath, JSON.stringify(order, null, 2), 'utf8');
}

function panoramaOrderReplace(paths, oldFilename, newFilename) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const replaced = order.map((f) => (f === oldFilename ? newFilename : f));
  const deduped = [];
  const seen = new Set();
  for (const f of replaced) {
    if (seen.has(f)) continue;
    seen.add(f);
    deduped.push(f);
  }
  if (!seen.has(newFilename)) deduped.push(newFilename);
  writePanoramaOrder(paths.panoramaOrderPath, deduped);
}

function panoramaOrderRemove(paths, filename) {
  const order = readPanoramaOrder(paths.panoramaOrderPath).filter(f => f !== filename);
  writePanoramaOrder(paths.panoramaOrderPath, order);
}

function panoramaOrderAppend(paths, filenames) {
  const order = readPanoramaOrder(paths.panoramaOrderPath);
  const set = new Set(order);
  for (const f of filenames) if (!set.has(f)) { order.push(f); set.add(f); }
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
    tilesRootDir: paths.tilesDir
  });
  const builtMeta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
  if (!builtMeta) throw new Error('Tiles built but meta.json missing');
  return builtMeta;
}

// ---- Simple in-memory job tracking for async tile processing ----
const jobs = new Map();
function createJob(filenames, projectId) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = {
    id,
    projectId,
    filenames,
    status: 'processing', // 'processing' | 'done' | 'error'
    percent: 0,
    message: '',
    error: null
  };
  jobs.set(id, job);
  return job;
}
function getJob(id) {
  return jobs.get(id) || null;
}
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ id: job.id, status: job.status, percent: job.percent, message: job.message, error: job.error });
});

// ---- Archive APIs (audit log per pano / floor plan) ----
app.get('/api/archive/panos/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.uploadsDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'pano', filename);
  const entries = readAndRepairAuditEntries(paths, 'pano', filename);
  res.json(entries);
});

app.get('/api/archive/floorplans/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const imagePath = path.join(paths.floorplansDir, filename);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
  initAuditLogIfMissing(paths, 'floorplan', filename);
  const entries = readAndRepairAuditEntries(paths, 'floorplan', filename);
  res.json(entries);
});

app.get('/api/archive/images/:kind/:storedFilename', (req, res) => {
  const kindToken = req.params.kind;
  const storedFilename = req.params.storedFilename;
  const kind =
    kindToken === 'floorplan' || kindToken === 'floorplans'
      ? 'floorplan'
      : kindToken === 'pano' || kindToken === 'panos'
        ? 'pano'
        : null;
  if (!kind) return res.status(400).json({ error: 'Invalid archive image kind' });
  if (!storedFilename) return res.status(400).json({ error: 'storedFilename required' });
  if (storedFilename.includes('..') || storedFilename.includes('/') || storedFilename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid storedFilename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const filePath = resolveArchiveImagePath(paths, kind, storedFilename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve(filePath));
});

// ---- Panorama APIs (project-scoped via ?project=id) ----
app.post('/upload', upload.array("panorama", 20), async (req, res)=>{
  if(!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      message: "no file uploaded"
    });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map(f => f.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'pano', name, {
        action: 'upload',
        message: 'Panorama uploaded.',
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (e) {}
  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after panorama upload:', error);
    return res.status(500).json({ success: false, message: 'Panorama uploaded, but database sync failed.' });
  }
  const job = createJob(filenames, paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    uploaded: filenames
  });
  // Do not notify immediately; wait until tiles are built and emit 'panos:ready'
  (async () => {
    try {
      let overall = 0;
      const totalFiles = filenames.length;
      for (let i = 0; i < filenames.length; i++) {
        const name = filenames[i];
        job.message = `Processing ${name} (${i+1}/${totalFiles})`;
        await buildTilesForImage({
          imagePath: path.join(paths.uploadsDir, name),
          filename: name,
          tilesRootDir: paths.tilesDir,
          onProgress: (frac) => {
            // Map per-file progress to overall percent
            const combined = ((i + frac) / totalFiles) * 100;
            if (combined > overall) overall = combined;
            job.percent = Math.min(100, Math.max(0, Math.round(overall)));
          }
        });
      }
      panoramaOrderAppend(paths, filenames);
      // Notify clients that tiles are ready for these panos
      try { io.to(`project:${paths.projectId}`).emit('panos:ready', { filenames }); } catch (e) { console.error('Socket emit error:', e); }
      job.percent = 100;
      job.status = 'done';
      job.message = 'Completed';
    } catch (e) {
      console.error('Tile generation failed:', e);
      const msg = `Tile generation failed: ${e.message || e}`;
      job.status = 'error';
      job.error = msg;
      job.message = msg;
    }
  })();
});

// ---- Floor plan APIs (project-scoped via ?project=id) ----
app.post('/upload-floorplan', floorplanUpload.array('floorplan', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'no file uploaded' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const filenames = req.files.map((f) => f.filename);
  try {
    filenames.forEach((name) => {
      appendAuditEntry(paths, 'floorplan', name, {
        action: 'upload',
        message: 'Floor plan uploaded.',
        meta: buildAuditMeta(undefined, req.authUser),
      });
    });
  } catch (e) {}
  let updatedOrder = null;
  try {
    updatedOrder = floorplanOrderAppend(paths, filenames);
  } catch (e) {
    console.error('Error updating floor plan order on upload:', e);
  }
  try {
    if (updatedOrder) io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
  } catch (e) {
    console.error('Socket emit error:', e);
  }
  try {
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
  } catch (error) {
    console.error('Project database sync failed after floor plan upload:', error);
    return res.status(500).json({ success: false, message: 'Floor plan uploaded, but database sync failed.' });
  }
  res.json({ success: true, uploaded: filenames });
});

// Update/replace a single floor plan image and adopt the uploaded filename.
// Body fields (multipart/form-data):
// - floorplan: new image file
// - oldFilename: existing floorplan filename to replace
app.put('/upload-floorplan/update', floorplanUpload.single('floorplan'), async (req, res) => {
  const cleanupUploadedFile = async () => {
    if (!req.file || !req.file.path) return;
    try {
      await fs.promises.unlink(req.file.path);
    } catch (e) {}
  };

  const oldFilename = req.body && req.body.oldFilename;
  if (!oldFilename) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    await cleanupUploadedFile();
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.floorplansDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    await cleanupUploadedFile();
    return res.status(404).json({ success: false, message: 'Old floor plan not found' });
  }
  const newFilename = req.file.filename;
  try {
    const hotspotCleanup = clearFloorplanHotspotsForFilenames(paths, [oldFilename, newFilename]);
    if (hotspotCleanup.changed) {
      try {
        io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', hotspotCleanup.hotspots);
      } catch (e) {
        console.error('Socket emit error:', e);
      }
    }

    if (oldFilename === newFilename) {
      try {
        appendAuditEntry(paths, 'floorplan', newFilename, {
          action: 'update',
          message: 'Floor plan updated.',
          meta: buildAuditMeta(undefined, req.authUser),
        });
      } catch (e) {}
      try {
        await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      } catch (error) {
        console.error('Project database sync failed after floor plan update:', error);
        return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
      }
      return res.json({
        success: true,
        message: 'Floor plan updated successfully',
        oldFilename,
        newFilename,
        filename: newFilename
      });
    }

    let archivedImage = null;
    try {
      archivedImage = storeReplacedImageInAudit(paths, 'floorplan', oldFilename, oldFilePath);
    } catch (archiveErr) {
      throw new Error(`Could not archive replaced floor plan: ${archiveErr.message || archiveErr}`);
    }

    await fs.promises.unlink(oldFilePath);

    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'update',
        message: `Floor plan updated (replaced "${oldFilename}" with "${newFilename}").`,
        meta: buildAuditMeta(
          archivedImage
          ? {
              archivedImage: {
                kind: 'floorplan',
                originalFilename: archivedImage.originalFilename,
                storedFilename: archivedImage.storedFilename,
              },
            }
          : undefined,
          req.authUser
        ),
      });
    } catch (e) {}

    let updatedOrder = null;
    try {
      updatedOrder = floorplanOrderReplace(paths, oldFilename, newFilename);
    } catch (e) {
      console.error('Error updating floor plan order:', e);
    }

    try {
      io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: updatedOrder });
    } catch (e) {
      console.error('Socket emit error:', e);
    }
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan replace:', error);
      return res.status(500).json({ success: false, message: 'Floor plan updated, but database sync failed.' });
    }

    return res.json({
      success: true,
      message: 'Floor plan updated successfully',
      oldFilename,
      newFilename,
      filename: newFilename
    });
  } catch (e) {
    console.error('Error updating floor plan:', e);
    await cleanupUploadedFile();
    return res.status(500).json({ success: false, message: 'Error updating floor plan' });
  }
});

// Rename a floor plan file.
app.put('/api/floorplans/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body || {};
  if (!oldFilename || !newFilename) {
    return res.status(400).json({ success: false, message: 'Both old and new filenames are required' });
  }
  if (
    oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
    newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')
  ) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldPath = path.join(paths.floorplansDir, oldFilename);
  const newPath = path.join(paths.floorplansDir, newFilename);
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ success: false, message: 'An image with this name already exists' });
  }
  try {
    await fs.promises.rename(oldPath, newPath);
    try {
      const order = readFloorplanOrder(paths.floorplanOrderPath);
      const newOrder = order.map(f => f === oldFilename ? newFilename : f);
      writeFloorplanOrder(paths.floorplanOrderPath, newOrder);
    } catch (e) {}
    try {
      renameAuditLog(paths, 'floorplan', oldFilename, newFilename);
      appendAuditEntry(paths, 'floorplan', newFilename, {
        action: 'rename',
        message: `Floor plan renamed from "${oldFilename}" to "${newFilename}".`,
        meta: buildAuditMeta(undefined, req.authUser),
      });
    } catch (e) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after floor plan rename:', error);
      return res.status(500).json({ success: false, message: 'Floor plan renamed, but database sync failed.' });
    }
    return res.json({ success: true, message: 'Floor plan renamed successfully', oldFilename, newFilename });
  } catch (err) {
    console.error('Error renaming floor plan:', err);
    return res.status(500).json({ success: false, message: 'Error renaming file' });
  }
});

// Delete a floor plan image.
app.delete('/api/floorplans/:filename', (req, res) => {
  res.status(403).json({ success: false, message: 'Floor plan deletion is disabled.' });
});

app.get('/api/floorplans', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const files = await getOrderedFloorplanFilenames(paths);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: 'Unable to list floor plans' });
  }
});

app.put('/api/floorplans/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    const dir = path.dirname(paths.floorplanOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFloorplanOrder(paths.floorplanOrderPath, body.order);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('floorplans:order', { order: body.order }); } catch (e) { console.error('Socket emit error:', e); }
  } catch (e) {
    console.error('Error writing floorplan order:', e);
    res.status(500).json({ error: 'Unable to save order' });
  }
});

app.get('/upload', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readdir(paths.uploadsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read directory' });
    const images = (files || []).filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
    res.json(images);
  });
});

app.get('/api/panos', async (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const files = await getOrderedFilenames(paths);
    const result = [];
    for (const filename of files) {
      let meta = await readTilesMeta({ tilesRootDir: paths.tilesDir, filename });
      result.push({
        filename,
        tileId: tileIdFromFilename(filename),
        tileReady: Boolean(meta),
        tileSize: meta?.tileSize,
        levels: meta?.levels,
        aspectOk: meta?.aspectOk
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Persist panorama order. Body: { order: [filenames...] }
app.put('/api/panos/order', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const body = req.body;
  if (!body || !Array.isArray(body.order)) return res.status(400).json({ error: 'Invalid payload' });
  // Validate filenames are strings
  const ok = body.order.every(f => typeof f === 'string' && f.length > 0 && !f.includes('..') && !/[\\\/]/.test(f));
  if (!ok) return res.status(400).json({ error: 'Invalid filenames in order' });
  try {
    
    const dir = path.dirname(paths.panoramaOrderPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writePanoramaOrder(paths.panoramaOrderPath, body.order);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('panos:order', { order: body.order }); } catch (e) { console.error('Socket emit error:', e); }
  } catch (e) {
    console.error('Error writing panorama order:', e);
    res.status(500).json({ error: 'Unable to save order' });
  }
});

app.get('/api/panos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  try {
    const meta = await ensureTilesForFilename(paths, filename);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/upload/rename', async (req, res) => {
  const { oldFilename, newFilename } = req.body;

  if (!oldFilename || !newFilename) {
    return res.status(400).json({
      success: false,
      message: 'Both old and new filenames are required'
    });
  }

  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
      newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({
      success: false,
      message: 'Project required'
    });
  }
  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  const newFilePath = path.join(paths.uploadsDir, newFilename);

  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  if (fs.existsSync(newFilePath)) {
    return res.status(409).json({
      success: false,
      message: 'An image with this name already exists'
    });
  }

  try {
    await fs.promises.rename(oldFilePath, newFilePath);
    const oldTileId = tileIdFromFilename(oldFilename);
    const newTileId = tileIdFromFilename(newFilename);
    const oldTilesPath = path.join(paths.tilesDir, oldTileId);
    const newTilesPath = path.join(paths.tilesDir, newTileId);
    if (fs.existsSync(oldTilesPath) && !fs.existsSync(newTilesPath)) {
      try {
        fs.renameSync(oldTilesPath, newTilesPath);
        const metaPath = path.join(newTilesPath, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          meta.filename = newFilename;
          meta.id = newTileId;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        }
      } catch (e) {
        console.error('Error renaming tiles folder:', e);
      }
    }

    panoramaOrderReplace(paths, oldFilename, newFilename);
    const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
    if (blurRename.changed) {
      try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', blurRename.blurMasks); } catch (e) { console.error('Socket emit error:', e); }
    }
    try {
      renameAuditLog(paths, 'pano', oldFilename, newFilename);
      appendAuditEntry(paths, 'pano', newFilename, {
        action: 'rename',
        message: `Panorama renamed from "${oldFilename}" to "${newFilename}".`,
        meta: buildAuditMeta(undefined, req.authUser),
      });
    } catch (e) {}
    try {
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    } catch (error) {
      console.error('Project database sync failed after panorama rename:', error);
      return res.status(500).json({ success: false, message: 'Panorama renamed, but database sync failed.' });
    }
    try { io.to(`project:${paths.projectId}`).emit('pano:renamed', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename
    });
  } catch (err) {
    console.error('Error renaming panorama:', err);
    return res.status(500).json({
      success: false,
      message: 'Error renaming file'
    });
  }
});

app.put('/upload/update', upload.single('panorama'), (req, res) => {
  const oldFilename = req.body.oldFilename;
  if (!oldFilename) {
    return res.status(400).json({ success: false, message: 'Old filename is required' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No new file uploaded' });
  }
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({ success: false, message: 'Project required' });
  }
  const oldFilePath = path.join(paths.uploadsDir, oldFilename);
  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({ success: false, message: 'Old file not found' });
  }
  const newFilename = req.file.filename;
  const job = createJob([newFilename], paths.projectId);
  res.json({
    success: true,
    jobId: job.id,
    newFilename,
    oldFilename
  });
  (async () => {
    try {
      job.message = `Replacing ${oldFilename}…`;
      let archivedImage = null;
      try {
        archivedImage = storeReplacedImageInAudit(paths, 'pano', oldFilename, oldFilePath);
      } catch (archiveErr) {
        throw new Error(`Could not archive replaced panorama: ${archiveErr.message || archiveErr}`);
      }
      await fs.promises.unlink(oldFilePath).catch((err) => {
        console.error('Error deleting old file:', err);
      });
      await removeDirIfExists(path.join(paths.tilesDir, tileIdFromFilename(oldFilename)));
      await buildTilesForImage({
        imagePath: path.join(paths.uploadsDir, newFilename),
        filename: newFilename,
        tilesRootDir: paths.tilesDir,
        onProgress: (frac) => {
          job.percent = Math.min(100, Math.max(0, Math.round(frac * 100)));
        }
      });
      panoramaOrderReplace(paths, oldFilename, newFilename);
      const blurRename = renameBlurMasksForPano(paths, oldFilename, newFilename);
      if (blurRename.changed) {
        try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', blurRename.blurMasks); } catch (e) { console.error('Socket emit error:', e); }
      }
      try {
        renameAuditLog(paths, 'pano', oldFilename, newFilename);
        appendAuditEntry(paths, 'pano', newFilename, {
          action: 'update',
          message: `Panorama updated (replaced "${oldFilename}" with "${newFilename}").`,
          meta: buildAuditMeta(
            archivedImage
            ? {
                archivedImage: {
                  kind: 'pano',
                  originalFilename: archivedImage.originalFilename,
                  storedFilename: archivedImage.storedFilename,
                },
              }
            : undefined,
            req.authUser
          ),
        });
      } catch (e) {}
      await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
      job.percent = 100;
      job.status = 'done';
      job.message = 'Update completed';
      try { io.to(`project:${paths.projectId}`).emit('pano:updated', { oldFilename, newFilename }); } catch (e) { console.error('Socket emit error:', e); }
    } catch (e) {
      console.error('Error updating image tiles:', e);
      const msg = `Error updating image tiles: ${e.message || e}`;
      job.status = 'error';
      job.error = msg;
      job.message = msg;
    }
  })();
});

app.get('/api/hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.hotspotsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read hotspots' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.get('/api/blur-masks', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.blurMasksPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read blur masks' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

// Floor plan hotspots: same shape as pano hotspots but keyed by floor plan filename.
app.get('/api/floorplan-hotspots', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.floorplanHotspotsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read floor plan hotspots' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.post('/api/floorplan-hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.floorplanHotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.floorplanHotspotsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.floorplanHotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const fp = path.join(paths.floorplansDir, filename);
        if (!fs.existsSync(fp)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Floor plan hotspot', 'floor plan hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'floorplan',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('floorplan-hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Floor plan hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save floor plan hotspots' });
  }
});

app.post('/api/blur-masks', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.blurMasksPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  const dir = path.dirname(paths.blurMasksPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.blurMasksPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        if (beforeCount === afterCount) return;
        const message = buildCollectionChangeMessage('Blur mask', 'blur masks', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'blur',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 15000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('blur-masks:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Blur mask save failed:', error);
    return res.status(500).json({ error: 'Unable to save blur masks' });
  }
});

app.post('/api/hotspots', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const beforeRaw = readJsonFileOrDefault(paths.hotspotsPath, {});
  const before = normalizeTopLevelArrayMap(beforeRaw);
  const normalizedBody = normalizeTopLevelArrayMap(body);
  const changed = diffChangedTopLevelKeys(before, normalizedBody);
  const json = JSON.stringify(normalizedBody, null, 2);
  try {
    await fs.promises.mkdir(path.dirname(paths.hotspotsPath), { recursive: true });
    await fs.promises.writeFile(paths.hotspotsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        const beforeCount = getArrayCountByKey(before, filename);
        const afterCount = getArrayCountByKey(normalizedBody, filename);
        const message = buildCollectionChangeMessage('Hotspot', 'hotspots', beforeCount, afterCount);
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'hotspots',
            message,
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 5000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true, unchanged: changed.length === 0 });
    if (changed.length === 0) return;
    try { io.to(`project:${paths.projectId}`).emit('hotspots:changed', normalizedBody); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Hotspot save failed:', error);
    return res.status(500).json({ error: 'Unable to save hotspots' });
  }
});

// Per-image initial view parameters (yaw, pitch, fov) for each panorama
app.get('/api/initial-views', (req, res) => {
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  fs.readFile(paths.initialViewsPath, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json({});
      return res.status(500).json({ error: 'Unable to read initial views' });
    }
    try {
      const obj = JSON.parse(data);
      res.json(typeof obj === 'object' && obj !== null ? obj : {});
    } catch (e) {
      res.json({});
    }
  });
});

app.post('/api/initial-views', async (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const before = readJsonFileOrDefault(paths.initialViewsPath, {});
  const changed = diffChangedTopLevelKeys(before, body);
  const json = JSON.stringify(body, null, 2);
  const dir = path.dirname(paths.initialViewsPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(paths.initialViewsPath, json, 'utf8');
    try {
      changed.forEach((filename) => {
        const img = path.join(paths.uploadsDir, filename);
        if (!fs.existsSync(img)) return;
        appendAuditEntry(
          paths,
          'pano',
          filename,
          {
            action: 'initial-view',
            message: 'Initial view saved.',
            meta: buildAuditMeta(undefined, req.authUser),
          },
          { dedupeWindowMs: 3000 }
        );
      });
    } catch (e) {}
    await syncProjectToDatabaseOrThrow(paths.projectId, req.authUser && req.authUser.id);
    res.json({ success: true });
    try { io.to(`project:${paths.projectId}`).emit('initial-views:changed', body); } catch (e) { console.error('Socket emit error:', e); }
  } catch (error) {
    console.error('Initial view save failed:', error);
    return res.status(500).json({ error: 'Unable to save initial views' });
  }
});

app.delete('/upload/:filename', (req, res) => {
  res.status(403).json({ success: false, message: 'Panorama deletion is disabled.' });
});

async function startServer() {
  await clearAllSessions();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at https://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
