import { initViewer, loadImages } from './marzipano-viewer.js';
import { initHotspotsClient } from './features/hotspots-client.js';
import { getProjectId } from './project-context.js';

if (!getProjectId()) {
  window.location.replace('index.html');
} else {
  const imageListEl = document.getElementById('pano-image-list');
  const listBtnEl = document.getElementById('pano-list-btn');

  if (listBtnEl) {
    listBtnEl.addEventListener('click', () => {
      if (imageListEl) {
        imageListEl.style.display =
          imageListEl.style.display === 'block' ? 'none' : 'block';
      }
    });
  }

  initHotspotsClient();

  document.addEventListener('DOMContentLoaded', async () => {
    await initHotspotsClient();
    initViewer();
    loadImages();
  });
}
