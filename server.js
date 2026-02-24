const express = require('express');
const multer = require('multer'); 
const fs = require('fs');
const path = require('path');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists
} = require('./public/js/tiler');

const app = express();
const PORT = 3000;

const projectsDir = path.join(__dirname, 'projects');
const projectsManifestPath = path.join(projectsDir, 'projects.json');

if (!fs.existsSync(projectsDir)) {
  fs.mkdirSync(projectsDir, { recursive: true });
}



function getProjectsManifest() {
  try {
    const raw = fs.readFileSync(projectsManifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading projects manifest:', e);
    return [];
  }
}

function writeProjectsManifest(projects) {
  fs.writeFileSync(projectsManifestPath, JSON.stringify(projects, null, 2), 'utf8');
}

function sanitizeProjectId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || 'project';
}

/** Get paths for a project. projectId must be validated (no .., no slashes). */
function getProjectPaths(projectId) {
  if (!projectId || projectId.includes('..') || /[\/\\]/.test(projectId)) return null;
  const base = path.join(projectsDir, projectId);
  return {
    base,
    upload: path.join(base, 'upload'),
    tiles: path.join(base, 'tiles'),
    data: path.join(base, 'data'),
  };
}

function ensureProjectDirs(projectId) {
  const p = getProjectPaths(projectId);
  if (!p) return null;
  [p.upload, p.tiles, p.data].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  return p;
}

/** Resolve paths: require project id */
function resolvePaths(req) {
  const projectId = req.query.project || (req.body && req.body.project);
  const p = getProjectPaths(projectId);
  if (!p) return null;
  return {
    uploadsDir: p.upload,
    tilesDir: p.tiles,
    hotspotsPath: path.join(p.data, 'hotspots.json'),
    initialViewsPath: path.join(p.data, 'initial-views.json'),
    panoramaOrderPath: path.join(p.data, 'panorama-order.json'),
    projectId,
  };
}

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));



// Project-scoped static: /projects/:id/upload and /projects/:id/tiles
const projectRouter = express.Router({ mergeParams: true });
projectRouter.use('/upload', (req, res, next) => {
  const id = req.params.projectId;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.upload)) return next();
  express.static(p.upload)(req, res, next);
});
projectRouter.use('/tiles', (req, res, next) => {
  const id = req.params.projectId;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return res.status(400).send('Invalid project');
  const p = getProjectPaths(id);
  if (!p) return res.status(400).send('Invalid project');
  if (!fs.existsSync(p.tiles)) return next();
  express.static(p.tiles)(req, res, next);
});
app.use('/projects/:projectId', projectRouter);

// Multer: dynamic destination based on project (set by route)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const projectId = req.query.project || (req.body && req.body.project);
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

async function listUploadedImages(uploadsDir) {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
}

/** Return ordered list of panorama filenames: stored order first, then any new uploads not in list. */
async function getOrderedFilenames(paths) {
  const existing = await listUploadedImages(paths.uploadsDir);
  const existingSet = new Set(existing);
  let order = [];
  try {
    const raw = fs.readFileSync(paths.panoramaOrderPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) order = parsed.filter(f => existingSet.has(f));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error reading panorama order:', e);
  }
  const inOrder = new Set(order);
  const appended = existing.filter(f => !inOrder.has(f));
  const result = [...order, ...appended];
  if (order.length === 0 && result.length > 0) {
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
  const i = order.indexOf(oldFilename);
  if (i !== -1) order[i] = newFilename;
  else order.push(newFilename);
  writePanoramaOrder(paths.panoramaOrderPath, order);
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

// ---- Project APIs ----
app.get('/api/projects', (req, res) => {
  const projects = getProjectsManifest();
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  const trimmedName = name.trim();
  let id = sanitizeProjectId(name);
  const projects = getProjectsManifest();
  const normalized = trimmedName.toLowerCase();
  if (projects.some((p) => (p.name || '').trim().toLowerCase() === normalized)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }
  if (projects.some(p => p.id === id)) {
    let suffix = 1;
    while (projects.some(p => p.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }
  const finalId = id;
  ensureProjectDirs(finalId);
  const project = { id: finalId, name: trimmedName };
  projects.push(project);
  writeProjectsManifest(projects);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const oldId = req.params.id;
  if (oldId.includes('..') || oldId.includes('/') || oldId.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid project id' });
  }
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  const projects = getProjectsManifest();
  const idx = projects.findIndex(p => p.id === oldId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Project not found' });
  const trimmedName = name.trim();
  const normalized = trimmedName.toLowerCase();
  if (projects.some((p, i) => i !== idx && (p.name || '').trim().toLowerCase() === normalized)) {
    return res.status(409).json({ success: false, message: 'A project with this name already exists' });
  }

  let newId = sanitizeProjectId(trimmedName);
  if (projects.some((p, i) => i !== idx && p.id === newId)) {
    let suffix = 1;
    while (projects.some((p, i) => i !== idx && p.id === `${newId}-${suffix}`)) suffix++;
    newId = `${newId}-${suffix}`;
  }

  if (newId !== oldId) {
    const oldPaths = getProjectPaths(oldId);
    const newPaths = getProjectPaths(newId);
    if (oldPaths && newPaths && fs.existsSync(oldPaths.base)) {
      if (fs.existsSync(newPaths.base)) {
        return res.status(409).json({ success: false, message: `A project folder "${newId}" already exists` });
      }
      try {
        fs.renameSync(oldPaths.base, newPaths.base);
      } catch (e) {
        console.error('Error renaming project folder:', e);
        return res.status(500).json({ success: false, message: `Failed to rename folder: ${e.message || e}` });
      }
    }
    projects[idx].id = newId;
  }
  projects[idx].name = trimmedName;
  writeProjectsManifest(projects);
  res.json(projects[idx]);
});

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid project id' });
  }
  const projects = getProjectsManifest();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Project not found' });
  projects.splice(idx, 1);
  writeProjectsManifest(projects);
  const p = getProjectPaths(id);
  if (p && fs.existsSync(p.base)) {
    fs.rmSync(p.base, { recursive: true, force: true });
  }
  res.json({ success: true });
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
  try {
    for (const file of req.files) {
      await ensureTilesForFilename(paths, file.filename);
    }
    panoramaOrderAppend(paths, req.files.map(f => f.filename));
    res.json({
      success: true,
      uploaded: req.files.map(f => f.filename)
    });
  } catch (e) {
    console.error('Tile generation failed:', e);
    res.status(500).json({
      success: false,
      message: `Tile generation failed: ${e.message || e}`
    });
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

app.put('/upload/rename', (req, res) => {
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
      message: 'A file with this name already exists'
    });
  }

  fs.rename(oldFilePath, newFilePath, (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error renaming file'
      });
    }
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
    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename
    });
  });
});

app.put('/upload/update', upload.single('panorama'), async (req, res) => {
  const oldFilename = req.body.oldFilename;
  
  if (!oldFilename) {
    return res.status(400).json({
      success: false,
      message: 'Old filename is required'
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No new file uploaded'
    });
  }

  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
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

  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'Old file not found'
    });
  }

  try {
    await fs.promises.unlink(oldFilePath).catch((err) => {
      console.error('Error deleting old file:', err);
    });
    await removeDirIfExists(path.join(paths.tilesDir, tileIdFromFilename(oldFilename)));
    await ensureTilesForFilename(paths, req.file.filename);

    panoramaOrderReplace(paths, oldFilename, req.file.filename);
    res.json({
      success: true,
      message: 'Image updated successfully',
      newFilename: req.file.filename,
      oldFilename
    });
  } catch (e) {
    console.error('Error updating image tiles:', e);
    res.status(500).json({
      success: false,
      message: `Error updating image tiles: ${e.message || e}`
    });
  }
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

app.post('/api/hotspots', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const json = JSON.stringify(body, null, 2);
  fs.writeFile(paths.hotspotsPath, json, 'utf8', (err) => {
    if (err) return res.status(500).json({ error: 'Unable to save hotspots' });
    res.json({ success: true });
  });
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

app.post('/api/initial-views', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const paths = resolvePaths(req);
  if (!paths) return res.status(400).json({ error: 'Project required' });
  const json = JSON.stringify(body, null, 2);
  const dir = path.dirname(paths.initialViewsPath);
  fs.mkdir(dir, { recursive: true }, (mkErr) => {
    if (mkErr) return res.status(500).json({ error: 'Unable to prepare storage for initial views' });
    fs.writeFile(paths.initialViewsPath, json, 'utf8', (err) => {
      if (err) return res.status(500).json({ error: 'Unable to save initial views' });
      res.json({ success: true });
    });
  });
});

app.delete('/upload/:filename', (req, res) => {
  const filename = req.params.filename;
  const paths = resolvePaths(req);
  if (!paths) {
    return res.status(400).json({
      success: false,
      message: 'Project required'
    });
  }
  const filePath = path.join(paths.uploadsDir, filename);

  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  fs.unlink(filePath, (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error deleting file'
      });
    }
    panoramaOrderRemove(paths, filename);
    const tilesPath = path.join(paths.tilesDir, tileIdFromFilename(filename));
    if (fs.existsSync(tilesPath)) {
      fs.rm(tilesPath, { recursive: true, force: true }, (rmErr) => {
        if (rmErr) console.error('Error deleting tiles folder:', rmErr);
      });
    }
    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
