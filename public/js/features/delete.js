import { getSelectedImageNames, loadImages, clearSelection } from '../marzipano-viewer.js';
import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showConfirm } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

const deleteBtnEl = document.getElementById('pano-delete-btn');

export function initDelete() {
  deleteBtnEl.addEventListener('click', handleDelete);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      handleDelete();
    }
  });
}

async function handleDelete() {
  const selectedNames = getSelectedImageNames();
  if (selectedNames.length === 0) {
    await showAlert('Please select one or more images to delete (use Ctrl+click for multi-select).', 'Delete');
    return;
  }

  const msg = selectedNames.length === 1
    ? `Are you sure you want to delete "${selectedNames[0]}"?`
    : `Are you sure you want to delete ${selectedNames.length} images?`;
  const confirmDelete = await showConfirm(msg, 'Delete');
  if (!confirmDelete) return;

  const errors = [];
  for (const name of selectedNames) {
    try {
      const res = await fetch(appendProjectParams(`/upload/${encodeURIComponent(name)}`), { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) errors.push(`${name}: ${data.message}`);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  clearSelection();
  const { getImageList } = await import('../marzipano-viewer.js');
  const imageList = await getImageList();
  cleanupHotspotsForDeletedImages(imageList);
  await loadImages();

  if (errors.length > 0) {
    await showAlert('Some images could not be deleted:\n' + errors.join('\n'), 'Delete');
  }
}
