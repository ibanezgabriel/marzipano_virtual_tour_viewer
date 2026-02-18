import { getSelectedImageName, loadImages, clearSelection } from '../marzipano-viewer.js';
import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showConfirm } from '../dialog.js';

const deleteBtnEl = document.getElementById('pano-delete-btn');

export function initDelete() {
  deleteBtnEl.addEventListener('click', handleDelete);
}

async function handleDelete() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    await showAlert('Please select an image to delete.', 'Delete');
    return;
  }

  const confirmDelete = await showConfirm(`Are you sure you want to delete "${selectedImageName}"?`, 'Delete');
  if (!confirmDelete) {
    return;
  }

  try {
    const res = await fetch(`/upload/${selectedImageName}`, {
      method: 'DELETE'
    });

    const data = await res.json();

    if (data.success) {
      clearSelection();
      const { getImageList } = await import('../marzipano-viewer.js');
      const imageList = await getImageList();
      cleanupHotspotsForDeletedImages(imageList);
      await loadImages();
    } else {
      await showAlert('Error deleting image: ' + data.message, 'Delete');
    }
  } catch (error) {
    await showAlert('Error deleting image: ' + error, 'Delete');
  }
}
