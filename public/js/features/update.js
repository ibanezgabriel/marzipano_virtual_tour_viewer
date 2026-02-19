import { getSelectedImageName, loadImages, loadPanorama, clearCurrentPath } from '../marzipano-viewer.js';
import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert } from '../dialog.js';

const updateBtnEl = document.getElementById('pano-update-btn');

export function initUpdate() {
  updateBtnEl.addEventListener('click', handleUpdate);
}

async function handleUpdate() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    await showAlert('Please select an image to update.', 'Update');
    return;
  }

  const updateInput = document.createElement('input');
  updateInput.type = 'file';
  updateInput.accept = 'image/*';
  updateInput.style.display = 'none';

  updateInput.addEventListener('change', async () => {
    const file = updateInput.files[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append('panorama', file);
    formData.append('oldFilename', selectedImageName);

    // Find the corresponding <li> and show updating text
    const imageListEl = document.getElementById('pano-image-list');
    let updatingLi = null;
    if (imageListEl) {
      updatingLi = Array.from(imageListEl.children).find(
        li => li.textContent === selectedImageName
      );
      if (updatingLi) {
        updatingLi.dataset.originalText = updatingLi.textContent;
        updatingLi.textContent = 'Updating image…';
      }
    }

    try {
      const res = await fetch('/upload/update', {
        method: 'PUT',
        body: formData
      });

      const data = await res.json();

      if (data.success) {
        clearCurrentPath();
        await loadImages(cleanupHotspotsForDeletedImages);
      } else {
        if (updatingLi && updatingLi.dataset.originalText) {
          updatingLi.textContent = updatingLi.dataset.originalText;
          delete updatingLi.dataset.originalText;
        }
        await showAlert('Error updating image: ' + data.message, 'Update');
      }
    } catch (error) {
      if (updatingLi && updatingLi.dataset.originalText) {
        updatingLi.textContent = updatingLi.dataset.originalText;
        delete updatingLi.dataset.originalText;
      }
      await showAlert('Error updating image: ' + error, 'Update');
    }

    document.body.removeChild(updateInput);
  });

  document.body.appendChild(updateInput);
  updateInput.click();
}
