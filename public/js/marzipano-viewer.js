import Marzipano from "https://cdn.skypack.dev/marzipano";

// --- constants ---
const MAX_FOV = 100 * Math.PI / 180;
const MIN_FOV = 30 * Math.PI / 180;
const FALLBACK_EQUIRECT_WIDTH = 4000;

// --- state ---
let viewer = null;
let currentScene = null;
let currentImagePath = null;
let selectedImageName = null;
/** @type {Array<() => void>} Callbacks run when a scene has finished loading (after switchTo). */
let onSceneLoadCallbacks = [];

const imageListEl = document.getElementById('pano-image-list');
const panoViewerEl = document.getElementById('pano-viewer');
const headerTextEl = document.getElementById('pano-header-text');
const headerEl = document.getElementById('pano-header');

function updateHeaderText(imageName) {
  if (headerTextEl && headerEl) {
    if (imageName) {
      headerTextEl.textContent = imageName;
      headerEl.style.display = '';
      document.body.classList.remove('no-pano-header');
    } else {
      headerTextEl.textContent = '';
      headerEl.style.display = 'none';
      document.body.classList.add('no-pano-header');
    }
  }
}

// Initialize Marzipano viewer
export function initViewer() {
  if (!panoViewerEl) {
    console.error('#pano-viewer element not found');
    return null;
  }
  viewer = new Marzipano.Viewer(panoViewerEl);
  console.log('Marzipano viewer initialized');
  return viewer;
}

// Load a panorama image into Marzipano (exported for hotspot links and list)
export async function loadPanorama(imageName) {
  const imagePath = `/upload/${imageName}`;
  if (selectedImageName === imageName) {
    // Same image already shown; list may have been rebuilt (e.g. after upload), so re-apply highlight
    document.querySelectorAll('#pano-image-list li').forEach(li => li.classList.remove('active'));
    const sameLi = Array.from(document.querySelectorAll('#pano-image-list li')).find(li => li.textContent === imageName);
    if (sameLi) sameLi.classList.add('active');
    return;
  }
  currentImagePath = imagePath;
  selectedImageName = imageName;
  updateHeaderText(imageName);

  if (!viewer) {
    viewer = initViewer();
    if (!viewer) {
      console.error('Viewer not initialized');
      return;
    }
  }

  // Prefer tiled multi-resolution cube tiles (generated server-side).
  // If tile meta fetch fails, fall back to non-tiled equirect.
  let source = null;
  let geometry = null;
  try {
    const res = await fetch(`/api/panos/${encodeURIComponent(imageName)}`);
    const meta = await res.json();
    if (!res.ok || !meta || !Array.isArray(meta.levels) || !meta.tileSize) {
      throw new Error(meta?.error || 'Invalid tile metadata');
    }
    const levels = meta.levels.map((size) => ({ tileSize: meta.tileSize, size }));
    geometry = new Marzipano.CubeGeometry(levels);
    source = Marzipano.ImageUrlSource.fromString(`/tiles/${meta.id}/{z}/{f}/{y}/{x}.jpg`);
  } catch (e) {
    console.warn('Falling back to single-image pano:', e);
    source = Marzipano.ImageUrlSource.fromString(imagePath);
    geometry = new Marzipano.EquirectGeometry([{ width: FALLBACK_EQUIRECT_WIDTH }]);
  }
  const limiter = Marzipano.RectilinearView.limit.traditional(MIN_FOV, MAX_FOV);
  const view = new Marzipano.RectilinearView(
    { yaw: 0, pitch: 0, fov: Math.PI / 2 },
    limiter
  );
  currentScene = viewer.createScene({ source, geometry, view });
  currentScene.switchTo();

  // Notify listeners (e.g. hotspot feature) so they can restore or attach to the new scene.
  onSceneLoadCallbacks.forEach((cb) => cb());

  // Update active state in list
  document.querySelectorAll('#pano-image-list li').forEach(li => {
    li.classList.remove('active');
  });
  const activeLi = Array.from(document.querySelectorAll('#pano-image-list li'))
    .find(li => li.textContent === imageName);
  if (activeLi) {
    activeLi.classList.add('active');
  }
}

// Load and display list of images
/** @param {(files: string[]) => void} [onImagesLoaded] Called with the list of image names after fetch. */
export async function loadImages(onImagesLoaded) {
  try {
    const res = await fetch("/api/panos");
    const panos = await res.json();
    const fileList = Array.isArray(panos) ? panos.map(p => p.filename) : [];
    if (typeof onImagesLoaded === 'function') onImagesLoaded(fileList);

    imageListEl.innerHTML = "";

    if (fileList.length > 0) {
      // Clear "No panoramas" placeholder so the viewer can show the first image (e.g. after first upload)
      if (panoViewerEl && panoViewerEl.querySelector('.no-pano-msg')) {
        panoViewerEl.innerHTML = '';
      }
      if (!viewer) {
        viewer = initViewer();
        if (!viewer) {
          console.error('Viewer not initialized');
          return;
        }
      }
    }

    fileList.forEach(file => {
      const li = document.createElement("li");
      li.textContent = file;
      li.onclick = () => loadPanorama(file);
      imageListEl.appendChild(li);
    });

    if (fileList.length > 0) {
      const imageToShow = (selectedImageName && fileList.includes(selectedImageName))
        ? selectedImageName
        : fileList[0];
      await loadPanorama(imageToShow);
    } else {
      currentScene = null;
      currentImagePath = null;
      selectedImageName = null;
      viewer = null;
      updateHeaderText(null);
      if (panoViewerEl) panoViewerEl.innerHTML = '<p class="no-pano-msg">No panoramas. Upload one to get started.</p>';
    }
  } catch (error) {
    alert('Error loading images: ' + error);
  }
}

export function getSelectedImageName() {
  return selectedImageName;
}

export function clearSelection() {
  currentImagePath = null;
  selectedImageName = null;
}

export function clearCurrentPath() {
  currentImagePath = null;
}

/** Return the Marzipano viewer instance (for hotspot container, etc.). */
export function getViewer() {
  return viewer;
}

/** Return the current scene (for hotspot container and view). */
export function getCurrentScene() {
  return currentScene;
}

/** Register a callback to run when a new scene has finished loading. */
export function registerOnSceneLoad(callback) {
  if (typeof callback === 'function') {
    onSceneLoadCallbacks.push(callback);
  }
}

/** Fetch and return the list of uploaded image file names. */
export async function getImageList() {
  const res = await fetch('/api/panos');
  const panos = await res.json();
  return Array.isArray(panos) ? panos.map(p => p.filename) : [];
}
