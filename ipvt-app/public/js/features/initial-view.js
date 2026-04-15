/* Manages the saved initial camera view for panoramas. */
import { getSelectedImageName, saveInitialViewForCurrentImage } from '../marzipano-viewer.js';
import { showAlert, showTimedAlert } from '../dialog.js';

const initialViewBtnEl = document.getElementById('pano-initial-view-btn');

export function initInitialView() {
  if (!initialViewBtnEl) return;

  initialViewBtnEl.addEventListener('click', async () => {
    const imageName = getSelectedImageName();
    if (!imageName) {
      await showAlert('Please select a panorama first.', 'Set initial view');
      return;
    }
    try {
      await saveInitialViewForCurrentImage();
      await showTimedAlert('Initial view saved for this panorama.', 'Set initial view', 500);
    } catch (e) {
      console.error('Error saving initial view', e);
      await showAlert('Could not save the initial view. Please try again.', 'Set initial view');
    }
  });
}

