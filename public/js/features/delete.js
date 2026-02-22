import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showConfirm } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

const deleteBtnEl = document.getElementById('pano-delete-btn');

export function initDelete() {
  deleteBtnEl.addEventListener('click', handleDelete);
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

  const { clearSelection, loadImages } = await import('../marzipano-viewer.js');
  clearSelection();
  await loadImages(cleanupHotspotsForDeletedImages);

  if (errors.length > 0) {
    await showAlert('Some images could not be deleted:\n' + errors.join('\n'), 'Delete');
  }
}
