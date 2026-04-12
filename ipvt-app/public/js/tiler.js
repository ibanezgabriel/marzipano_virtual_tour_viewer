const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_TILE_SIZE = 512;
const DEFAULT_MAX_FACE_SIZE = 4096;

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function tileIdFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  // keep stable, filesystem-safe ids (also safe for URLs)
  return base.replace(/[^a-z0-9_-]/gi, '_');
}

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function floorPowerOfTwo(n) {
  if (n <= 0) return 0;
  return 2 ** Math.floor(Math.log2(n));
}

async function readImageMeta(imagePath) {
  const meta = await sharp(imagePath).metadata();
  return { width: meta.width || 0, height: meta.height || 0 };
}

function chooseFaceSize(equirectWidth, { tileSize = DEFAULT_TILE_SIZE, maxFaceSize = DEFAULT_MAX_FACE_SIZE } = {}) {
  // For a 2:1 equirect, a common cube face size is ~width/4.
  const candidate = Math.floor(equirectWidth / 4);
  let faceSize = floorPowerOfTwo(candidate);

  // Clamp to supported range.
  faceSize = Math.min(faceSize, maxFaceSize);
  faceSize = Math.max(faceSize, tileSize);

  // Ensure divisible by tileSize and power-of-two.
  // (tileSize is power-of-two; if faceSize is power-of-two and >= tileSize, it is divisible.)
  if (!isPowerOfTwo(faceSize)) {
    faceSize = floorPowerOfTwo(faceSize);
  }
  if (faceSize < tileSize) faceSize = tileSize;

  return faceSize;
}

function buildLevelSizes(faceSize, tileSize) {
  const levels = [];
  for (let size = tileSize; size <= faceSize; size *= 2) {
    levels.push(size);
  }
  return levels;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function faceDirection(face, u, v) {
  // u, v in [-1, 1]
  // Returns a direction vector for the given cube face.
  // Face ids follow Marzipano tool convention: l, f, r, b, u, d.
  switch (face) {
    case 'r': // +X
      return { x: 1, y: -v, z: -u };
    case 'l': // -X
      return { x: -1, y: -v, z: u };
    case 'u': // +Y
      return { x: u, y: 1, z: v };
    case 'd': // -Y
      return { x: u, y: -1, z: -v };
    case 'f': // +Z
      return { x: u, y: -v, z: 1 };
    case 'b': // -Z
      return { x: -u, y: -v, z: -1 };
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

function dirToEquirectUV(dir, width, height) {
  // Normalize
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const x = dir.x / len;
  const y = dir.y / len;
  const z = dir.z / len;

  // lon in [-pi, pi], lat in [-pi/2, pi/2]
  const lon = Math.atan2(x, z);
  const lat = Math.asin(clamp(y, -1, 1));

  const uf = (lon + Math.PI) / (2 * Math.PI) * width;
  const vf = (Math.PI / 2 - lat) / Math.PI * height;
  return { uf, vf };
}

function sampleBilinearRGBA(src, srcW, srcH, x, y) {
  // Wrap horizontally (longitude), clamp vertically.
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const fx = x - x0;
  const fy = y - y0;

  const sx0 = mod(x0, srcW);
  const sx1 = mod(x1, srcW);
  const sy0 = clamp(y0, 0, srcH - 1);
  const sy1 = clamp(y1, 0, srcH - 1);

  const idx00 = (sy0 * srcW + sx0) * 4;
  const idx10 = (sy0 * srcW + sx1) * 4;
  const idx01 = (sy1 * srcW + sx0) * 4;
  const idx11 = (sy1 * srcW + sx1) * 4;

  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const v00 = src[idx00 + c];
    const v10 = src[idx10 + c];
    const v01 = src[idx01 + c];
    const v11 = src[idx11 + c];
    const v0 = v00 + (v10 - v00) * fx;
    const v1 = v01 + (v11 - v01) * fx;
    out[c] = Math.round(v0 + (v1 - v0) * fy);
  }
  return out;
}

async function equirectToCubemapFacesRGBA(imagePath, faceSize) {
  // Resize source to something reasonable for sampling.
  const srcW = faceSize * 4;
  const srcH = faceSize * 2;

  const { data, info } = await sharp(imagePath)
    .resize(srcW, srcH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const src = data; // RGBA

  const faces = {};
  const faceIds = ['l', 'f', 'r', 'b', 'u', 'd'];

  for (const face of faceIds) {
    const out = Buffer.alloc(faceSize * faceSize * 4);
    let p = 0;
    for (let j = 0; j < faceSize; j++) {
      const v = (2 * (j + 0.5) / faceSize) - 1;
      for (let i = 0; i < faceSize; i++) {
        const u = (2 * (i + 0.5) / faceSize) - 1;
        const dir = faceDirection(face, u, v);
        const { uf, vf } = dirToEquirectUV(dir, width, height);
        const [r, g, b, a] = sampleBilinearRGBA(src, width, height, uf, vf);
        out[p++] = r;
        out[p++] = g;
        out[p++] = b;
        out[p++] = a;
      }
    }
    faces[face] = out;
  }

  return faces;
}

async function writeMeta(metaPath, metaObj) {
  await fs.promises.writeFile(metaPath, JSON.stringify(metaObj, null, 2), 'utf8');
}

async function removeDirIfExists(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  await fs.promises.rm(dirPath, { recursive: true, force: true });
}

/**
 * Build Marzipano cube tiles for one panorama.
 *
 * Output structure:
 *   <tilesRoot>/<tileId>/
 *     meta.json
 *     <z>/<f>/<y>/<x>.jpg
 *
 * Where:
 *  - z is 0-based level index (0 is the lowest)
 *  - f is one of: l, f, r, b, u, d
 */
async function buildTilesForImage({
  imagePath,
  filename,
  tilesRootDir,
  tileSize = DEFAULT_TILE_SIZE,
  maxFaceSize = DEFAULT_MAX_FACE_SIZE,
  jpegQuality = 85,
  onProgress // optional: (fraction 0..1) => void
}) {
  const tileId = tileIdFromFilename(filename);
  const outDir = path.join(tilesRootDir, tileId);
  const metaPath = path.join(outDir, 'meta.json');

  ensureDirSync(outDir);

  const { width, height } = await readImageMeta(imagePath);
  if (!width || !height) {
    throw new Error(`Unable to read image dimensions for ${filename}`);
  }
  // Basic guard for equirect panoramas. (We won't hard-fail; but warn in meta.)
  const aspect = width / height;
  const aspectOk = Math.abs(aspect - 2) < 0.03;

  const faceSize = chooseFaceSize(width, { tileSize, maxFaceSize });
  const levelSizes = buildLevelSizes(faceSize, tileSize);

  // Convert equirect to cube faces (RGBA raw buffers).
  const facesRGBA = await equirectToCubemapFacesRGBA(imagePath, faceSize);

  const expectedFaces = ['l', 'f', 'r', 'b', 'u', 'd'];
  const missing = expectedFaces.filter((f) => !facesRGBA[f]);
  if (missing.length) {
    throw new Error(`Cubemap conversion missing faces: ${missing.join(', ')}`);
  }

  // Generate tiles for each level and face.
  let totalTiles = 0;
  for (let z = 0; z < levelSizes.length; z++) {
    const levelSize = levelSizes[z];
    const tilesPerSide = Math.max(1, Math.floor(levelSize / tileSize));
    totalTiles += 6 * tilesPerSide * tilesPerSide;
  }
  let writtenTiles = 0;
  const notify = () => {
    if (typeof onProgress === 'function') {
      const frac = totalTiles > 0 ? writtenTiles / totalTiles : 0;
      try { onProgress(frac); } catch {}
    }
  };
  notify();
  for (let z = 0; z < levelSizes.length; z++) {
    const levelSize = levelSizes[z];
    const tilesPerSide = Math.max(1, Math.floor(levelSize / tileSize));

    for (const f of expectedFaces) {
      // Resize face down to target level size (no upscaling: faceSize chosen as max).
      const resizedObj = await sharp(facesRGBA[f], { raw: { width: faceSize, height: faceSize, channels: 4 } })
        .resize(levelSize, levelSize, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const resized = resizedObj.data;

      for (let y = 0; y < tilesPerSide; y++) {
        const rowDir = path.join(outDir, String(z), f, String(y));
        ensureDirSync(rowDir);

        const rowPromises = [];
        for (let x = 0; x < tilesPerSide; x++) {
          const tilePath = path.join(rowDir, `${x}.jpg`);
          rowPromises.push(
            sharp(resized, { raw: { width: levelSize, height: levelSize, channels: 4 } })
              .extract({ left: x * tileSize, top: y * tileSize, width: tileSize, height: tileSize })
              .jpeg({ quality: jpegQuality })
              .toFile(tilePath)
          );
        }
        await Promise.all(rowPromises);
        writtenTiles += tilesPerSide;
        notify();
      }
    }
  }

  await writeMeta(metaPath, {
    id: tileId,
    filename,
    tileSize,
    faceSize,
    levels: levelSizes,
    aspectOk
  });

  return {
    id: tileId,
    metaPath,
    tileSize,
    faceSize,
    levels: levelSizes
  };
}

async function readTilesMeta({ tilesRootDir, filename }) {
  const tileId = tileIdFromFilename(filename);
  const metaPath = path.join(tilesRootDir, tileId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const raw = await fs.promises.readFile(metaPath, 'utf8');
  return JSON.parse(raw);
}

module.exports = {
  DEFAULT_TILE_SIZE,
  tileIdFromFilename,
  buildTilesForImage,
  readTilesMeta,
  removeDirIfExists
};
