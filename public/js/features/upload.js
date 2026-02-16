import { loadImages } from '../marzipano-viewer.js';
import { showAlert } from '../dialog.js';

const addPanoEl = document.getElementById('add-scene');

export function initUpload() {
  addPanoEl.addEventListener('change', handleUpload);
}

async function handleUpload() {
  const files = addPanoEl.files;
  if (!files || files.length === 0) {
    return;
  }

  // Allowed file types
  const allowedTypes = ['image/jpeg', 'image/jpg'];

  // Filter files by allowed types
  const validFiles = Array.from(files).filter(file => allowedTypes.includes(file.type));

  if (validFiles.length === 0) {
    await showAlert(
      'Please select a valid panorama image. Only JPEG (.jpg, .jpeg) files are supported.',
      'Invalid file'
    );
    addPanoEl.value = '';
    return;
  }

  const formData = new FormData();
  for (let i = 0; i < validFiles.length; i++) {
    formData.append('panorama', validFiles[i]);
  }

  try {
    const res = await fetch('./upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      await loadImages();
    } else {
      await showAlert(data.message || 'Error uploading images', 'Upload error');
    }
    addPanoEl.value = '';
  } catch (error) {
    console.error('Error uploading image:', error);
    await showAlert('Failed to upload. Please check your connection and try again.', 'Upload error');
    addPanoEl.value = '';
  }
}
