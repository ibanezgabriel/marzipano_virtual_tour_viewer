import { initViewer, loadImages } from './marzipano-viewer.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initDelete } from './features/delete.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages } from './features/hotspots.js';

const imageListEl = document.getElementById('pano-image-list');
const listBtnEl = document.getElementById('pano-list-btn');

// Toggle visibility of panoramic images list
listBtnEl.addEventListener('click', () => {
  imageListEl.style.display =
    imageListEl.style.display === 'block' ? 'none' : 'block';
});

// Initialize feature handlers
initRename();
initUpdate();
initDelete();
initUpload();
initHotspots();

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initViewer();
  loadImages(cleanupHotspotsForDeletedImages);
});
