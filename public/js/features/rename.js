import { getSelectedImageName, loadImages, loadPanorama } from '../marzipano-viewer.js';
import { updateHotspotsForRenamedImage } from './hotspots.js';
import { showAlert, showPrompt } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

const renameBtnEl = document.getElementById('pano-rename-btn');

export function initRename() {
  renameBtnEl.addEventListener('click', handleRename);
}

async function handleRename() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    await showAlert('Please select an image to rename.', 'Rename');
    return;
  }

  const lastDotIndex = selectedImageName.lastIndexOf('.');
  const extension = lastDotIndex > -1 ? selectedImageName.substring(lastDotIndex) : '';
  const nameWithoutExt = lastDotIndex > -1 ? selectedImageName.substring(0, lastDotIndex) : selectedImageName;

  const newName = await showPrompt(`Enter new name for "${selectedImageName}":`, nameWithoutExt, 'Rename');

  if (newName === null || newName === '') {
    return;
  }
  const newFileName = newName.includes('.') ? newName : newName + extension;
  if (newFileName.includes('/') || newFileName.includes('\\') || newFileName.includes('..')) {
    await showAlert('Invalid filename. Please avoid special characters like / \\ ..', 'Rename');
    return;
  }

  try {
    const res = await fetch(appendProjectParams('/upload/rename'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldFilename: selectedImageName,
        newFilename: newFileName
      })
    });

    const data = await res.json();

    if (data.success) {
      updateHotspotsForRenamedImage(selectedImageName, newFileName);
      await loadImages();
      await loadPanorama(newFileName);
    } else {
      await showAlert('Error renaming image: ' + data.message, 'Rename');
    }
  } catch (error) {
    await showAlert('Error renaming image: ' + error, 'Rename');
  }
}
