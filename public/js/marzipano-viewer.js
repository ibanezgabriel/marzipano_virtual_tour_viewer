import Marzipano from "https://cdn.skypack.dev/marzipano";

// --- constants ---
const MAX_FOV = 100 * Math.PI / 180;
const MIN_FOV = 30 * Math.PI / 180;
const IMAGE_WIDTH = 4000;

// --- state ---
let viewer = null;
let currentScene = null;
let currentImagePath = null;
let selectedImageName = null;

const imageListEl = document.getElementById('pano-image-list');
const panoViewerEl = document.getElementById('pano-viewer');

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

// Load a panorama image into Marzipano
export function loadPanorama(imagePath, imageName) {
  if (currentImagePath === imagePath) {
    return;
  }
  currentImagePath = imagePath;
  selectedImageName = imageName;

  if (!viewer) {
    viewer = initViewer();
    if (!viewer) {
      console.error('Viewer not initialized');
      return;
    }
  }

  const source = Marzipano.ImageUrlSource.fromString(imagePath);
  const geometry = new Marzipano.EquirectGeometry([{ width: IMAGE_WIDTH }]);
  const limiter = Marzipano.RectilinearView.limit.traditional(MIN_FOV, MAX_FOV);
  const view = new Marzipano.RectilinearView(
    { yaw: 0, pitch: 0, fov: Math.PI / 2 },
    limiter
  );
  currentScene = viewer.createScene({ source, geometry, view });
  currentScene.switchTo();

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
export async function loadImages() {
  try {
    const res = await fetch("upload");
    const files = await res.json();

    imageListEl.innerHTML = "";

    if (!viewer) {
      viewer = initViewer();
      if (!viewer) {
        console.error('Viewer not initialized');
        return;
      }
    }

    files.forEach(file => {
      const li = document.createElement("li");
      li.textContent = file;
      li.onclick = () => loadPanorama(`/upload/${file}`, file);
      imageListEl.appendChild(li);
    });

    if (files.length > 0) {
      loadPanorama(`/upload/${files[0]}`, files[0]);
    } else {
      currentImagePath = null;
      selectedImageName = null;
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
