import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showConfirm, showTimedAlert } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

export function initDelete() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pano-action="delete"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const li = button.closest('#pano-image-list li');
    if (li?.dataset?.filename) {
      const { loadPanorama } = await import('../marzipano-viewer.js');
      await loadPanorama(li.dataset.filename);
    }
    await handleDelete();
  });
}

async function handleDelete() {
  const { getSelectedImageName } = await import('../marzipano-viewer.js');
  const selectedName = getSelectedImageName();
  if (!selectedName) {
    await showAlert('Please select an image to delete.', 'Delete');
    return;
  }

  const msg = `Are you sure you want to delete "${selectedName}"?`;
  const confirmDelete = await showConfirm(msg, 'Delete');
  if (!confirmDelete) return;

  const errors = [];
  try {
    const res = await fetch(appendProjectParams(`/upload/${encodeURIComponent(selectedName)}`), { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) errors.push(`${selectedName}: ${data.message}`);
  } catch (err) {
    errors.push(`${selectedName}: ${err.message}`);
  }

  if (errors.length === 0) {
    try {
      const { floorplanApi } = await import('./floorplans.js');
      if (floorplanApi && typeof floorplanApi.cleanupForDeletedPano === 'function') {
        floorplanApi.cleanupForDeletedPano(selectedName);
      }
    } catch (e) {
      // ignore
    }
  }

  const { clearSelection, loadImages } = await import('../marzipano-viewer.js');
  clearSelection();
  await loadImages(cleanupHotspotsForDeletedImages);

  if (errors.length > 0) {
    await showAlert('Some images could not be deleted:\n' + errors.join('\n'), 'Delete');
  } else {
    await showTimedAlert('Panorama image deleted successfully.', 'Delete', 500);
  }
}
