import { getSelectedImageName, loadImages, clearSelection } from '../marzipano-viewer.js';

const deleteBtnEl = document.getElementById('pano-delete-btn');

export function initDelete() {
  deleteBtnEl.addEventListener('click', handleDelete);
}

async function handleDelete() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    alert('Please select an image to delete');
    return;
  }

  const confirmDelete = confirm(`Are you sure you want to delete "${selectedImageName}"?`);
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
      await loadImages();
    } else {
      alert('Error deleting image: ' + data.message);
    }
  } catch (error) {
    alert('Error deleting image: ' + error);
  }
}
