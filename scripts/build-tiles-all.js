const fs = require('fs');
const path = require('path');
const { buildTilesForImage, readTilesMeta } = require('../lib/tiler');

const uploadsDir = path.join(__dirname, '..', 'upload');
const tilesDir = path.join(__dirname, '..', 'tiles');

async function listUploadedImages() {
  const files = await fs.promises.readdir(uploadsDir);
  return files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
}

async function main() {
  if (!fs.existsSync(tilesDir)) {
    fs.mkdirSync(tilesDir, { recursive: true });
  }

  const files = await listUploadedImages();
  if (!files.length) {
    console.log('No images in upload/.');
    return;
  }

  for (const filename of files) {
    const existing = await readTilesMeta({ tilesRootDir: tilesDir, filename });
    if (existing) {
      console.log(`skip  ${filename} (tiles already exist)`);
      continue;
    }
    console.log(`build ${filename}`);
    await buildTilesForImage({
      imagePath: path.join(uploadsDir, filename),
      filename,
      tilesRootDir: tilesDir
    });
    console.log(`done  ${filename}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

