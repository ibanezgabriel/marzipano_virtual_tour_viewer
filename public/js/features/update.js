import { getSelectedImageName, loadImages, loadPanorama, clearCurrentPath } from '../marzipano-viewer.js';

const updateBtnEl = document.getElementById('pano-update-btn');

export function initUpdate() {
  updateBtnEl.addEventListener('click', handleUpdate);
}

function handleUpdate() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    alert('Please select an image to update');
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

    try {
      const res = await fetch('/upload/update', {
        method: 'PUT',
        body: formData
      });

      const data = await res.json();

      if (data.success) {
        clearCurrentPath();
        await loadImages();
        loadPanorama(`/upload/${data.newFilename}`, data.newFilename);
      } else {
        alert('Error updating image: ' + data.message);
      }
    } catch (error) {
      alert('Error updating image: ' + error);
    }

    document.body.removeChild(updateInput);
  });

  document.body.appendChild(updateInput);
  updateInput.click();
}
