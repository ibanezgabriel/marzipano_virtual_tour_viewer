import { loadImages } from '../marzipano-viewer.js';

const addPanoEl = document.getElementById('add-scene');

export function initUpload() {
  addPanoEl.addEventListener('change', handleUpload);
}

async function handleUpload() {
  const files = addPanoEl.files;
  if (!files || files.length === 0) {
    return;
  }

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('panorama', files[i]);
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
      alert(data.message || 'Error uploading images');
    }
  } catch (error) {
    console.error('Error uploading image:', error);
  }
}
