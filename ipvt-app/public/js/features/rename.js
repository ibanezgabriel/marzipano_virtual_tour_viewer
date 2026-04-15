/* Handles rename actions for project media items. */
import { getSelectedImageName, loadImages, loadPanorama, updateInitialViewForRenamedImage } from '../marzipano-viewer.js';
import { updateHotspotsForRenamedImage } from './hotspots.js';
import { showAlert, showPrompt, showTimedAlert } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

export function initRename() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pano-action="rename"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const li = button.closest('#pano-image-list li');
    if (li?.dataset?.filename) {
      await loadPanorama(li.dataset.filename);
    }
    await handleRename();
  });
}

/* Handles handle rename. */
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
      updateInitialViewForRenamedImage(selectedImageName, newFileName);
      await loadPanorama(newFileName);
      await loadImages();
      await showTimedAlert('Panorama image renamed successfully.', 'Rename', 500);
    } else {
      await showAlert('Error renaming image: ' + data.message, 'Rename');
    }
  } catch (error) {
    await showAlert('Error renaming image: ' + error, 'Rename');
  }
}
