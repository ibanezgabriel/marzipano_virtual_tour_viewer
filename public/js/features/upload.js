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

  // Allowed file types
  const allowedTypes = ['image/jpeg', 'image/jpg'];

  // Filter files by allowed types
  const validFiles = Array.from(files).filter(file => allowedTypes.includes(file.type));

  if (validFiles.length === 0) {
    alert("The file you selected is invalid");
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
