import { appendProjectParams, getFloorplanBase } from '../project-context.js';
import { showAlert, showConfirm, showPrompt, showSelectWithPreview } from '../dialog.js';
import { getImageList, loadPanorama } from '../marzipano-viewer.js';

function selectEl(id) {
  return document.getElementById(id);
}

export function initFloorplans() {
  const panoTab = selectEl('pano-scenes');
  const floorTab = selectEl('pano-floorplan');
  const panoList = selectEl('pano-image-list');
  const floorList = selectEl('pano-floorplan-list');
  const addPlanBtn = selectEl('add-plan-btn');
  const addFloorInput = selectEl('add-floorplan');

  if (!panoTab || !floorTab || !panoList || !floorList) return;

  let selectedFloorplan = null;

  // In-memory + persisted floor plan hotspots:
  // filename -> Array<{ id, x, y, linkTo }>
  const FLOORPLAN_HOTSPOTS_KEY = 'floorplan-hotspots';
  const floorplanHotspotsByFile = new Map();
  let nextFloorplanHotspotId = 0;

  function loadFloorplanHotspotsFromStorage() {
    try {
      const raw = localStorage.getItem(FLOORPLAN_HOTSPOTS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null) return;
      let maxId = -1;
      Object.entries(obj).forEach(([filename, list]) => {
        if (!Array.isArray(list)) return;
        const entries = list.map((entry) => {
          const id = Number(entry.id);
          if (id > maxId) maxId = id;
          return {
            id,
            x: Number(entry.x),
            y: Number(entry.y),
            linkTo: entry.linkTo || undefined,
          };
        });
        floorplanHotspotsByFile.set(filename, entries);
      });
      if (maxId >= 0) nextFloorplanHotspotId = maxId + 1;
    } catch (e) {
      console.warn('Could not load floorplan hotspots from localStorage', e);
    }
  }

  function serializeFloorplanHotspots() {
    const obj = {};
    floorplanHotspotsByFile.forEach((list, filename) => {
      obj[filename] = list.map((entry) => ({
        id: entry.id,
        x: entry.x,
        y: entry.y,
        linkTo: entry.linkTo,
      }));
    });
    return obj;
  }

  function saveFloorplanHotspotsToStorage() {
    const payload = serializeFloorplanHotspots();
    try {
      localStorage.setItem(FLOORPLAN_HOTSPOTS_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Could not save floorplan hotspots to localStorage', e);
    }
    // Persist to server so hotspots follow the project
    fetch(appendProjectParams('/api/floorplan-hotspots'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => console.warn('Could not save floorplan hotspots to server', err));
  }

  const previewContainer = document.createElement('div');
  previewContainer.id = 'floorplan-preview';
  previewContainer.className = 'floorplan-preview';
  previewContainer.innerHTML = '<img id="floorplan-preview-img" alt="Floor plan">';
  const viewerWrap = document.getElementById('pano-viewer-wrap');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  }
  const previewImg = previewContainer.querySelector('img');

  // Modal elements for full-screen floor plan view
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'floorplan-modal-overlay';
  modalOverlay.className = 'floorplan-modal-overlay';
  modalOverlay.innerHTML = `
    <div class="floorplan-modal" role="dialog" aria-modal="true">
      <div class="floorplan-modal-body">
        <img id="floorplan-modal-img" alt="Floor plan expanded">
      </div>
      <div class="floorplan-modal-actions">
        <button type="button" id="floorplan-update-btn" class="floorplan-action-btn floorplan-update">Update</button>
        <button type="button" id="floorplan-rename-btn" class="floorplan-action-btn floorplan-rename">Rename</button>
        <button type="button" id="floorplan-delete-btn" class="floorplan-action-btn floorplan-delete">Delete</button>
        <button type="button" id="floorplan-hotspot-btn" class="floorplan-action-btn floorplan-hotspot">Hotspot</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  const modalImg = modalOverlay.querySelector('#floorplan-modal-img');
  const modalEl = modalOverlay.querySelector('.floorplan-modal');
  const updateBtn = modalOverlay.querySelector('#floorplan-update-btn');
  const renameBtn = modalOverlay.querySelector('#floorplan-rename-btn');
  const deleteBtn = modalOverlay.querySelector('#floorplan-delete-btn');
  const hotspotBtn = modalOverlay.querySelector('#floorplan-hotspot-btn');

  let hotspotPlaceMode = false;

  function closeModal() {
    modalOverlay.classList.remove('visible');
    document.body.classList.remove('floorplan-modal-open');
    hotspotPlaceMode = false;
    if (hotspotBtn) hotspotBtn.classList.remove('active');
  }

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });

  function openModalFor(filename) {
    if (!filename || !previewImg || !modalImg) return;
    const base = getFloorplanBase();
    const src = `${base}/${encodeURIComponent(filename)}`;
    modalImg.src = src;
    modalImg.alt = filename;
    modalOverlay.classList.add('visible');
    document.body.classList.add('floorplan-modal-open');
    // Re-render hotspots whenever modal opens
    renderFloorplanHotspots();
  }

  function showPanos() {
    panoTab.classList.add('active-tab');
    floorTab.classList.remove('active-tab');
    panoList.style.display = 'block';
    floorList.style.display = 'none';
    // Hide floorplan preview when switching back to panoramic scenes
    previewContainer.style.display = 'none';
  }

  function showFloorplans() {
    panoTab.classList.remove('active-tab');
    floorTab.classList.add('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'block';
  }

  panoTab.addEventListener('click', showPanos);
  floorTab.addEventListener('click', showFloorplans);

  // Default state
  showPanos();

  function showPreview(filename) {
    if (!previewImg) return;
    const base = getFloorplanBase();
    previewImg.src = `${base}/${encodeURIComponent(filename)}`;
    previewContainer.style.display = 'block';
  }

  function setActiveFloorplanLi(filename) {
    const items = Array.from(floorList.querySelectorAll('li'));
    items.forEach((li) => {
      if (li.dataset && li.dataset.filename === filename) {
        li.classList.add('active');
      } else {
        li.classList.remove('active');
      }
    });
  }

  function onFloorplanClick(filename) {
    selectedFloorplan = filename;
    setActiveFloorplanLi(filename);
    showPreview(filename);
  }

  function clearFloorplanItems() {
    // Keep the last <li> that wraps the "+" button; remove others.
    const items = Array.from(floorList.querySelectorAll('li'));
    if (items.length === 0) return;
    const last = items[items.length - 1];
    items.slice(0, -1).forEach((li) => li.remove());
    // Ensure "+" li remains last
    floorList.appendChild(last);
  }

  async function loadFloorplans() {
    try {
      const res = await fetch(appendProjectParams('/api/floorplans'));
      if (!res.ok) return;
      const files = await res.json();
      clearFloorplanItems();
      const plusLi = floorList.querySelector('li:last-child') || null;
      files.forEach((filename) => {
        const li = document.createElement('li');
        li.textContent = filename;
        li.dataset.filename = filename;
        li.addEventListener('click', () => onFloorplanClick(filename));
        if (plusLi) {
          floorList.insertBefore(li, plusLi);
        } else {
          floorList.appendChild(li);
        }
      });
    } catch (e) {
      console.error('Error loading floorplans', e);
    }
  }

  if (addPlanBtn && addFloorInput) {
    addPlanBtn.addEventListener('click', () => addFloorInput.click());
    addFloorInput.addEventListener('change', async () => {
      const files = Array.from(addFloorInput.files || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach((file) => formData.append('floorplan', file));
      try {
        const res = await fetch(appendProjectParams('/upload-floorplan'), {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          console.error('Failed to upload floorplans');
        } else {
          await loadFloorplans();
        }
      } catch (e) {
        console.error('Error uploading floorplans', e);
      } finally {
        addFloorInput.value = '';
      }
    });
  }

  // Floor plan hotspot rendering inside the modal
  function renderFloorplanHotspots() {
    if (!modalEl || !modalImg || !selectedFloorplan) return;
    // Remove any existing overlay container
    let overlay = modalEl.querySelector('.floorplan-hotspot-layer');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'floorplan-hotspot-layer';
      const body = modalEl.querySelector('.floorplan-modal-body');
      if (!body) return;
      body.style.position = 'relative';
      body.appendChild(overlay);
    } else {
      overlay.innerHTML = '';
    }

    const list = floorplanHotspotsByFile.get(selectedFloorplan) || [];
    list.forEach((entry) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'floorplan-hotspot-dot';
      dot.style.left = `${entry.x * 100}%`;
      dot.style.top = `${entry.y * 100}%`;
      dot.title = entry.linkTo ? `Links to ${entry.linkTo}` : 'Unlinked hotspot';
      dot.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!entry.linkTo) return;
        await loadPanorama(entry.linkTo);
      });
      overlay.appendChild(dot);
    });
  }

  async function addFloorplanHotspotAt(clientX, clientY) {
    if (!modalImg || !selectedFloorplan) return;
    const rect = modalImg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    let linkTo = null;
    const originalSelection = selectedFloorplan;
    try {
      const images = await getImageList();
      const options = images;
      if (!options || options.length === 0) {
        await showAlert('No panoramic scenes available to link. Upload a panorama first.', 'Hotspot');
        return;
      }
      const selected = await showSelectWithPreview(
        'Bind hotspot to panoramic scene',
        options,
        (val) => loadPanorama(val)
      );
      if (selected === null) {
        // User cancelled; nothing to do
        return;
      }
      linkTo = selected;
      // Restore any previous pano view if needed; the admin UI already manages the viewer
    } catch (e) {
      console.warn('Error selecting pano for floorplan hotspot', e);
      linkTo = undefined;
    }

    const id = nextFloorplanHotspotId++;
    const entry = { id, x, y, linkTo: linkTo || undefined };
    let list = floorplanHotspotsByFile.get(originalSelection);
    if (!list) {
      list = [];
      floorplanHotspotsByFile.set(originalSelection, list);
    }
    list.push(entry);
    saveFloorplanHotspotsToStorage();
    renderFloorplanHotspots();
  }

  if (modalImg) {
    modalImg.addEventListener('click', (e) => {
      if (!hotspotPlaceMode) return;
      e.stopPropagation();
      addFloorplanHotspotAt(e.clientX, e.clientY);
    });
  }

  if (hotspotBtn) {
    hotspotBtn.addEventListener('click', () => {
      hotspotPlaceMode = !hotspotPlaceMode;
      hotspotBtn.classList.toggle('active', hotspotPlaceMode);
    });
  }

  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      if (!selectedFloorplan) {
        await showAlert('Please select a floor plan to update.', 'Update floor plan');
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) {
          document.body.removeChild(input);
          return;
        }
        const formData = new FormData();
        formData.append('floorplan', file);
        formData.append('oldFilename', selectedFloorplan);
        try {
          const res = await fetch(appendProjectParams('/upload-floorplan/update'), {
            method: 'PUT',
            body: formData,
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            await showAlert('Error updating floor plan: ' + (data && data.message ? data.message : res.status), 'Update floor plan');
          } else {
            await loadFloorplans();
            onFloorplanClick(selectedFloorplan);
            openModalFor(selectedFloorplan);
          }
        } catch (e) {
          await showAlert('Error updating floor plan: ' + e, 'Update floor plan');
        } finally {
          document.body.removeChild(input);
        }
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      if (!selectedFloorplan) {
        await showAlert('Please select a floor plan to rename.', 'Rename floor plan');
        return;
      }
      const lastDotIndex = selectedFloorplan.lastIndexOf('.');
      const extension = lastDotIndex > -1 ? selectedFloorplan.substring(lastDotIndex) : '';
      const nameWithoutExt = lastDotIndex > -1 ? selectedFloorplan.substring(0, lastDotIndex) : selectedFloorplan;
      const newName = await showPrompt(`Enter new name for "${selectedFloorplan}":`, nameWithoutExt, 'Rename floor plan');
      if (newName === null || newName === '') return;
      const newFileName = newName.includes('.') ? newName : newName + extension;
      if (newFileName.includes('/') || newFileName.includes('\\') || newFileName.includes('..')) {
        await showAlert('Invalid filename. Please avoid special characters like / \\ ..', 'Rename floor plan');
        return;
      }
      try {
        const res = await fetch(appendProjectParams('/api/floorplans/rename'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldFilename: selectedFloorplan, newFilename: newFileName }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          await showAlert('Error renaming floor plan: ' + (data && data.message ? data.message : res.status), 'Rename floor plan');
        } else {
          // Move hotspots mapping to new key
          if (floorplanHotspotsByFile.has(selectedFloorplan)) {
            const list = floorplanHotspotsByFile.get(selectedFloorplan);
            floorplanHotspotsByFile.delete(selectedFloorplan);
            floorplanHotspotsByFile.set(newFileName, list);
            saveFloorplanHotspotsToStorage();
          }
          selectedFloorplan = newFileName;
          await loadFloorplans();
          onFloorplanClick(selectedFloorplan);
          openModalFor(selectedFloorplan);
        }
      } catch (e) {
        await showAlert('Error renaming floor plan: ' + e, 'Rename floor plan');
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!selectedFloorplan) {
        await showAlert('Please select a floor plan to delete.', 'Delete floor plan');
        return;
      }
      const confirmed = await showConfirm(`Are you sure you want to delete "${selectedFloorplan}"?`, 'Delete floor plan');
      if (!confirmed) return;
      try {
        const res = await fetch(appendProjectParams(`/api/floorplans/${encodeURIComponent(selectedFloorplan)}`), {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          await showAlert('Error deleting floor plan: ' + (data && data.message ? data.message : res.status), 'Delete floor plan');
        } else {
          floorplanHotspotsByFile.delete(selectedFloorplan);
          saveFloorplanHotspotsToStorage();
          selectedFloorplan = null;
          closeModal();
          await loadFloorplans();
          previewContainer.style.display = 'none';
        }
      } catch (e) {
        await showAlert('Error deleting floor plan: ' + e, 'Delete floor plan');
      }
    });
  }

  // Open modal when clicking the small preview
  previewContainer.addEventListener('click', () => {
    if (selectedFloorplan) {
      openModalFor(selectedFloorplan);
    }
  });

  // Initial load: hotspots then floorplans
  (async () => {
    loadFloorplanHotspotsFromStorage();
    try {
      const res = await fetch(appendProjectParams('/api/floorplan-hotspots'));
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          floorplanHotspotsByFile.clear();
          let maxId = -1;
          Object.entries(data).forEach(([filename, list]) => {
            if (!Array.isArray(list)) return;
            const entries = list.map((entry) => {
              const id = Number(entry.id);
              if (id > maxId) maxId = id;
              return {
                id,
                x: Number(entry.x),
                y: Number(entry.y),
                linkTo: entry.linkTo || undefined,
              };
            });
            floorplanHotspotsByFile.set(filename, entries);
          });
          if (maxId >= 0) nextFloorplanHotspotId = maxId + 1;
        }
      }
    } catch (e) {
      console.warn('Could not load floorplan hotspots from server', e);
    }
    loadFloorplans();
  })();
}

