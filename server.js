const express = require('express');
const multer = require('multer'); 
const fs = require('fs');
const path = require('path');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists
} = require('./lib/tiler');

const app = express();
const PORT = 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'upload');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Ensure tiles directory exists
const tilesDir = path.join(__dirname, 'tiles');
if (!fs.existsSync(tilesDir)) {
  fs.mkdirSync(tilesDir);
}

// Ensure data directory exists (for hotspots etc.)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const hotspotsPath = path.join(dataDir, 'hotspots.json');

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/upload', express.static(path.join(__dirname, 'upload')));
app.use('/tiles', express.static(path.join(__dirname, 'tiles')));

// Multer setup for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'upload/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage });

async function listUploadedImages() {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
}

async function ensureTilesForFilename(filename) {
  const meta = await readTilesMeta({ tilesRootDir: tilesDir, filename });
  if (meta) return meta;

  const imagePath = path.join(uploadsDir, filename);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${filename}`);
  }

  await buildTilesForImage({
    imagePath,
    filename,
    tilesRootDir: tilesDir
  });
  const builtMeta = await readTilesMeta({ tilesRootDir: tilesDir, filename });
  if (!builtMeta) throw new Error('Tiles built but meta.json missing');
  return builtMeta;
}

app.post('/upload', upload.array("panorama", 20), async (req, res)=>{
  if(!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      message: "no file uploaded"
    });
  }
  try {
    // Build tiles for each uploaded pano so it can be viewed immediately as multi-res.
    for (const file of req.files) {
      await ensureTilesForFilename(file.filename);
    }
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
})

// API to get list of images
app.get('/upload', (req, res) => {
  fs.readdir('upload', (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read directory' });
    const images = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
    res.json(images);
  });
});

// API to list panos with tile metadata (used by the viewer).
app.get('/api/panos', async (req, res) => {
  try {
    const files = await listUploadedImages();
    const result = [];
    for (const filename of files) {
      let meta = await readTilesMeta({ tilesRootDir: tilesDir, filename });
      // Don't auto-build here to keep listing fast; UI will still work if tiles exist.
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

// API to get (and optionally build) tile metadata for one pano.
app.get('/api/panos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    const meta = await ensureTilesForFilename(filename);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// API to rename an image
app.put('/upload/rename', (req, res) => {
  const { oldFilename, newFilename } = req.body;

  if (!oldFilename || !newFilename) {
    return res.status(400).json({
      success: false,
      message: 'Both old and new filenames are required'
    });
  }

  // Security check: ensure filenames don't contain path traversal
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\') ||
      newFilename.includes('..') || newFilename.includes('/') || newFilename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  const oldFilePath = path.join(__dirname, 'upload', oldFilename);
  const newFilePath = path.join(__dirname, 'upload', newFilename);

  // Check if old file exists
  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  // Check if new filename already exists
  if (fs.existsSync(newFilePath)) {
    return res.status(409).json({
      success: false,
      message: 'A file with this name already exists'
    });
  }

  // Rename the file
  fs.rename(oldFilePath, newFilePath, (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error renaming file'
      });
    }
    // Rename tiles folder if present.
    const oldTileId = tileIdFromFilename(oldFilename);
    const newTileId = tileIdFromFilename(newFilename);
    const oldTilesPath = path.join(tilesDir, oldTileId);
    const newTilesPath = path.join(tilesDir, newTileId);
    if (fs.existsSync(oldTilesPath) && !fs.existsSync(newTilesPath)) {
      try {
        fs.renameSync(oldTilesPath, newTilesPath);
        // Update meta.json filename field if present.
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

    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename,
      newFilename
    });
  });
});

// API to update an image
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

  // Security check: ensure filename doesn't contain path traversal
  if (oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  const oldFilePath = path.join(__dirname, 'upload', oldFilename);

  // Check if old file exists
  if (!fs.existsSync(oldFilePath)) {
    return res.status(404).json({
      success: false,
      message: 'Old file not found'
    });
  }

  // Delete the old file
  try {
    await fs.promises.unlink(oldFilePath).catch((err) => {
      console.error('Error deleting old file:', err);
    });
    // Remove old tiles and build new tiles.
    await removeDirIfExists(path.join(tilesDir, tileIdFromFilename(oldFilename)));
    await ensureTilesForFilename(req.file.filename);

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

// API to get hotspots (for client view)
app.get('/api/hotspots', (req, res) => {
  fs.readFile(hotspotsPath, 'utf8', (err, data) => {
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

// API to save hotspots (called by admin when adding/removing/editing)
app.post('/api/hotspots', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const json = JSON.stringify(body, null, 2);
  fs.writeFile(hotspotsPath, json, 'utf8', (err) => {
    if (err) return res.status(500).json({ error: 'Unable to save hotspots' });
    res.json({ success: true });
  });
});

// API to delete an image
app.delete('/upload/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'upload', filename);

  // Security check: ensure filename doesn't contain path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  // Delete the file
  fs.unlink(filePath, (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error deleting file'
      });
    }
    // Delete tiles folder too (best-effort).
    const tilesPath = path.join(tilesDir, tileIdFromFilename(filename));
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