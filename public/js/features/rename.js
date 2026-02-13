import { getSelectedImageName, loadImages, loadPanorama } from '../marzipano-viewer.js';

const renameBtnEl = document.getElementById('pano-rename-btn');

export function initRename() {
  renameBtnEl.addEventListener('click', handleRename);
}

async function handleRename() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    alert('Please select an image to rename');
    return;
  }

  const lastDotIndex = selectedImageName.lastIndexOf('.');
  const extension = lastDotIndex > -1 ? selectedImageName.substring(lastDotIndex) : '';
  const nameWithoutExt = lastDotIndex > -1 ? selectedImageName.substring(0, lastDotIndex) : selectedImageName;

  const newName = prompt(`Enter new name for "${selectedImageName}":`, nameWithoutExt);

  if (!newName || newName.trim() === '') {
    return;
  }
  const newFileName = newName.includes('.') ? newName : newName + extension;
  if (newFileName.includes('/') || newFileName.includes('\\') || newFileName.includes('..')) {
    alert('Invalid filename. Please avoid special characters like / \\ ..');
    return;
  }

  try {
    const res = await fetch('/upload/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldFilename: selectedImageName,
        newFilename: newFileName
      })
    });

    const data = await res.json();

    if (data.success) {
      await loadImages();
      loadPanorama(`/upload/${newFileName}`, newFileName);
    } else {
      alert('Error renaming image: ' + data.message);
    }
  } catch (error) {
    alert('Error renaming image: ' + error);
  }
}
