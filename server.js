const express = require('express');
const multer = require('multer'); 
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'upload');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/upload', express.static(path.join(__dirname, 'upload')));

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

app.post('/upload', upload.array("panorama", 20), (req, res)=>{
  if(!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      message: "no file uploaded"
    });
  }
  const imageURLs = req.files.map(file => `images${file.filename}`)
  res.json({
      success: true,
      imageURLs
  });
})

// API to get list of images
app.get('/upload', (req, res) => {
  fs.readdir('upload', (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read directory' });
    const images = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
    res.json(images);
  });
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
    res.json({
      success: true,
      message: 'File renamed successfully',
      oldFilename: oldFilename,
      newFilename: newFilename
    });
  });
});

// API to update an image
app.put('/upload/update', upload.single('panorama'), (req, res) => {
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
  fs.unlink(oldFilePath, (err) => {
    if (err) {
      console.error('Error deleting old file:', err);
      // Continue anyway, as new file is already uploaded
    }
    
    res.json({
      success: true,
      message: 'Image updated successfully',
      newFilename: req.file.filename,
      oldFilename: oldFilename
    });
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
    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});