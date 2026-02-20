import { initViewer, loadImages } from './marzipano-viewer.js';
import { getProjectId } from './project-context.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initDelete } from './features/delete.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages } from './features/hotspots.js';

if (!getProjectId()) {
  window.location.replace('index.html');
} else {
  const listBtn = document.getElementById("pano-list-btn");
  const imageList = document.getElementById("pano-image-list");

  listBtn.addEventListener("click", ()=> {
    imageList.style.display =
      imageList.style.display === 'none' ? 'block' : 'none';
  })

  initRename();
  initUpdate();
  initDelete();
  initUpload();
  initHotspots();

  document.addEventListener('DOMContentLoaded', () => {
    initViewer();
    loadImages(cleanupHotspotsForDeletedImages);
  });
}
