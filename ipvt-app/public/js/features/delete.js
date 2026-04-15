/* Handles delete workflows for project assets and scenes. */
import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showConfirm, showTimedAlert } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

export function initDelete() {
  const deleteSelectionBtnEl = document.getElementById('pano-delete-selection-btn');
  const deleteConfirmBtnEl = document.getElementById('pano-delete-confirm-btn');
  const deleteBackBtnEl = document.getElementById('pano-delete-back-btn');
  const actionPanelEl = document.getElementById('pano-action');

  if (deleteSelectionBtnEl) {
    deleteSelectionBtnEl.addEventListener('click', () => enterDeleteSelectionMode({ deleteSelectionBtnEl, actionPanelEl }));
    deleteSelectionBtnEl.title = 'Click to start delete-selection mode';
  }
  if (deleteConfirmBtnEl) {
    deleteConfirmBtnEl.addEventListener('click', () => handleDeleteMarked({ deleteSelectionBtnEl, actionPanelEl }));
  }
  if (deleteBackBtnEl) {
    deleteBackBtnEl.addEventListener('click', () => exitDeleteSelectionMode({ deleteSelectionBtnEl, actionPanelEl }));
  }

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
    await handleDeleteSingle();
  });
}

/* Handles enter delete selection mode. */
async function enterDeleteSelectionMode({ deleteSelectionBtnEl, actionPanelEl }) {
  const { isDeleteSelectionMode, setDeleteSelectionMode } = await import('../marzipano-viewer.js');
  if (isDeleteSelectionMode()) return;

  setDeleteSelectionMode(true);
  if (actionPanelEl) actionPanelEl.classList.add('delete-mode');
  if (deleteSelectionBtnEl) {
    deleteSelectionBtnEl.classList.add('active');
    deleteSelectionBtnEl.title = 'Click panoramas to mark them, then press Delete';
  }

  await showTimedAlert(
    'Delete selection mode enabled. Click panoramas to mark them in red, then press Delete.',
    'Delete selection',
    900
  );
}

/* Handles exit delete selection mode. */
async function exitDeleteSelectionMode({ deleteSelectionBtnEl, actionPanelEl }) {
  const { isDeleteSelectionMode, setDeleteSelectionMode } = await import('../marzipano-viewer.js');
  if (!isDeleteSelectionMode()) {
    if (actionPanelEl) actionPanelEl.classList.remove('delete-mode');
    if (deleteSelectionBtnEl) {
      deleteSelectionBtnEl.classList.remove('active');
      deleteSelectionBtnEl.title = 'Click to start delete-selection mode';
    }
    return;
  }

  setDeleteSelectionMode(false);
  if (actionPanelEl) actionPanelEl.classList.remove('delete-mode');
  if (deleteSelectionBtnEl) {
    deleteSelectionBtnEl.classList.remove('active');
    deleteSelectionBtnEl.title = 'Click to start delete-selection mode';
  }
}

/* Handles handle delete marked. */
async function handleDeleteMarked({ deleteSelectionBtnEl, actionPanelEl }) {
  const { getMultiSelectedImageNames, isDeleteSelectionMode } = await import('../marzipano-viewer.js');
  if (!isDeleteSelectionMode()) return;

  const selectedNames = getMultiSelectedImageNames();
  if (selectedNames.length === 0) {
    await showAlert('No panoramas selected. Click panoramas to mark them in red.', 'Delete');
    return;
  }

  const msg =
    selectedNames.length === 1
      ? `Are you sure you want to delete "${selectedNames[0]}"?`
      : `Are you sure you want to delete ${selectedNames.length} selected images?`;
  const confirmDelete = await showConfirm(msg, 'Delete');
  if (!confirmDelete) return;

  try {
    await deleteImages(selectedNames, 'Delete');
  } finally {
    await exitDeleteSelectionMode({ deleteSelectionBtnEl, actionPanelEl });
  }
}

/* Handles handle delete single. */
async function handleDeleteSingle() {
  const { getSelectedImageName } = await import('../marzipano-viewer.js');
  const selectedName = getSelectedImageName();
  if (!selectedName) {
    await showAlert('Please select an image to delete.', 'Delete');
    return;
  }

  const msg = `Are you sure you want to delete "${selectedName}"?`;
  const confirmDelete = await showConfirm(msg, 'Delete');
  if (!confirmDelete) return;

  await deleteImages([selectedName], 'Delete');
}

/* Cleans up delete images. */
async function deleteImages(imageNames, title) {
  if (!Array.isArray(imageNames) || imageNames.length === 0) return;

  const errors = [];
  const deletedNames = [];
  for (const name of imageNames) {
    try {
      const res = await fetch(appendProjectParams(`/upload/${encodeURIComponent(name)}`), { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        errors.push(`${name}: ${data.message}`);
      } else {
        deletedNames.push(name);
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (deletedNames.length > 0) {
    try {
      const { layoutApi } = await import('./layouts.js');
      if (layoutApi && typeof layoutApi.cleanupForDeletedPano === 'function') {
        deletedNames.forEach((name) => layoutApi.cleanupForDeletedPano(name));
      }
    } catch (e) {
      // ignore
    }
  }

  const { clearSelection, clearMultiSelection, loadImages } = await import('../marzipano-viewer.js');
  clearSelection();
  clearMultiSelection();
  await loadImages(cleanupHotspotsForDeletedImages);

  if (errors.length > 0) {
    await showAlert('Some images could not be deleted:\n' + errors.join('\n'), title);
  } else {
    const successMsg = imageNames.length === 1
      ? 'Panorama image deleted successfully.'
      : `${imageNames.length} panorama images deleted successfully.`;
    await showTimedAlert(successMsg, title, 500);
  }
}
