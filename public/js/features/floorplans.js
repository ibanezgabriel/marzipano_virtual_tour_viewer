import { appendProjectParams, getFloorplanBase, getProjectId } from '../project-context.js';
import { showAlert, showConfirm, showPrompt, showSelectWithPreview } from '../dialog.js';
import { getImageList, loadPanorama } from '../marzipano-viewer.js';

function selectEl(id) {
  return document.getElementById(id);
}

/** Called when a panorama is renamed; updates floor plan hotspot linkTo and persists. */
export const floorplanApi = {
  updateForRenamedPano(_oldName, _newName) {},
  cleanupForDeletedPano(_deletedName) {},
};

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
  const LAST_FLOORPLAN_KEY_PREFIX = 'marzipano-last-floorplan-';
  const floorplanHotspotsByFile = new Map();
  let nextFloorplanHotspotId = 0;
  let selectedHotspotId = null;

  function saveLastFloorplan(filename) {
    const pid = getProjectId();
    if (pid) {
      try {
        localStorage.setItem(LAST_FLOORPLAN_KEY_PREFIX + pid, filename);
      } catch (e) {}
    }
  }

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

  floorplanApi.updateForRenamedPano = function (oldName, newName) {
    let changed = false;
    floorplanHotspotsByFile.forEach((list) => {
      list.forEach((entry) => {
        if (entry.linkTo === oldName) {
          entry.linkTo = newName;
          changed = true;
        }
      });
    });
    if (changed) {
      saveFloorplanHotspotsToStorage();
      renderFloorplanHotspots();
      renderRenderedHotspots();
    }
  };

  floorplanApi.cleanupForDeletedPano = function (deletedName) {
    let changed = false;
    floorplanHotspotsByFile.forEach((list, filename) => {
      const originalLen = list.length;
      const filtered = list.filter((entry) => entry.linkTo !== deletedName);
      if (filtered.length !== originalLen) {
        changed = true;
        if (filtered.length > 0) {
          floorplanHotspotsByFile.set(filename, filtered);
        } else {
          floorplanHotspotsByFile.delete(filename);
        }
      }
    });
    if (changed) {
      saveFloorplanHotspotsToStorage();
      renderFloorplanHotspots();
      renderRenderedHotspots();
    }
  };

  const previewContainer = document.createElement('div');
  previewContainer.id = 'floorplan-preview';
  previewContainer.className = 'floorplan-preview';
  previewContainer.innerHTML = `
    <div class="floorplan-image-wrap">
      <img id="floorplan-preview-img" alt="Floor plan">
      <div class="floorplan-hotspot-layer" data-layer="rendered"></div>
    </div>
  `;
  const viewerWrap = document.getElementById('pano-viewer-wrap');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  }
  const previewImg = previewContainer.querySelector('img');
  const previewHotspotLayer = previewContainer.querySelector('.floorplan-hotspot-layer');

  // Modal elements for full-screen floor plan view
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'floorplan-modal-overlay';
  modalOverlay.className = 'floorplan-modal-overlay';
  modalOverlay.innerHTML = `
    <div class="floorplan-modal" role="dialog" aria-modal="true">
      <div class="floorplan-modal-header">
        <div class="floorplan-modal-title" id="floorplan-modal-title"></div>
      </div>
      <div class="floorplan-modal-body">
        <div class="floorplan-image-wrap">
          <img id="floorplan-modal-img" alt="Floor plan expanded">
          <div class="floorplan-hotspot-layer" data-layer="expanded"></div>
        </div>
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
  const modalTitleEl = modalOverlay.querySelector('#floorplan-modal-title');
  const modalHotspotLayer = modalOverlay.querySelector('.floorplan-hotspot-layer[data-layer="expanded"]');
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
    // When leaving Expanded Display, return to Rendered Display if a floor plan is selected.
    if (previewContainer) {
      previewContainer.style.display = selectedFloorplan ? 'block' : 'none';
    }
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
    if (modalTitleEl) {
      const dot = filename.lastIndexOf('.');
      const displayName = dot > 0 ? filename.substring(0, dot) : filename;
      modalTitleEl.textContent = displayName;
    }
    // When entering Expanded Display, hide the Rendered Display (minimized preview).
    if (previewContainer) {
      previewContainer.style.display = 'none';
    }
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
    renderRenderedHotspots();
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
    saveLastFloorplan(filename);
    setActiveFloorplanLi(filename);
    showPreview(filename);
  }

  function clearFloorplanItems() {
    // Remove all existing floor plan list items; keep the "+" button (which is a <button>, not <li>)
    const items = Array.from(floorList.querySelectorAll('li'));
    items.forEach((li) => li.remove());
  }

  async function loadFloorplans() {
    try {
      const res = await fetch(appendProjectParams('/api/floorplans'));
      if (!res.ok) return;
      const files = await res.json();
      clearFloorplanItems();
      const addBtn = document.getElementById('add-plan-btn');
      const lastSaved = (() => {
        const pid = getProjectId();
        if (!pid) return null;
        try {
          return localStorage.getItem(LAST_FLOORPLAN_KEY_PREFIX + pid);
        } catch (e) {
          return null;
        }
      })();
      files.forEach((filename) => {
        const li = document.createElement('li');
        li.textContent = filename;
        li.dataset.filename = filename;
        li.draggable = true;
        li.addEventListener('click', () => onFloorplanClick(filename));
        li.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', li.dataset.filename);
          ev.dataTransfer.effectAllowed = 'move';
          li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => {
          li.classList.remove('dragging');
          floorList.querySelectorAll('li').forEach(x => x.classList.remove('drag-over'));
        });
        li.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          if (li.classList.contains('dragging')) return;
          li.classList.add('drag-over');
        });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          li.classList.remove('drag-over');
          const sourceFilename = ev.dataTransfer.getData('text/plain');
          if (!sourceFilename || sourceFilename === filename) return;
          const items = Array.from(floorList.querySelectorAll('li[data-filename]'));
          const srcIdx = items.findIndex(el => el.dataset.filename === sourceFilename);
          const tgtIdx = items.findIndex(el => el.dataset.filename === filename);
          if (srcIdx === -1 || tgtIdx === -1) return;
          const reordered = items.map(el => el.dataset.filename);
          const [removed] = reordered.splice(srcIdx, 1);
          reordered.splice(tgtIdx, 0, removed);
          try {
            const orderRes = await fetch(appendProjectParams('/api/floorplans/order'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered }),
            });
            if (orderRes.ok) await loadFloorplans();
          } catch (e) {
            console.warn('Failed to save floor plan order', e);
          }
        });
        if (addBtn && addBtn.parentElement === floorList) {
          floorList.insertBefore(li, addBtn);
        } else {
          floorList.appendChild(li);
        }
      });
      if (files.length > 0 && lastSaved && files.includes(lastSaved)) {
        onFloorplanClick(lastSaved);
      }
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
  function renderHotspotsToLayer(layerEl, { allowDelete, showTitle }) {
    if (!layerEl || !selectedFloorplan) return;
    layerEl.innerHTML = '';
    const list = floorplanHotspotsByFile.get(selectedFloorplan) || [];

    list.forEach((entry) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'floorplan-hotspot-pin';
      wrapper.style.left = `${entry.x * 100}%`;
      wrapper.style.top = `${entry.y * 100}%`;
      wrapper.setAttribute('data-floorplan-hotspot-id', String(entry.id));

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'floorplan-hotspot-pin-dot' + (selectedHotspotId === entry.id ? ' selected' : '');
      if (showTitle) {
        dot.title = entry.linkTo ? `Links to ${entry.linkTo}` : 'Unlinked hotspot';
      }
      dot.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        selectedHotspotId = entry.id;
        renderFloorplanHotspots();
        renderRenderedHotspots();
        if (!entry.linkTo) return;
        await loadPanorama(entry.linkTo);
      });

      wrapper.appendChild(dot);

      if (allowDelete) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'floorplan-hotspot-pin-remove';
        removeBtn.setAttribute('aria-label', 'Remove hotspot');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const list = floorplanHotspotsByFile.get(selectedFloorplan) || [];
          const idx = list.findIndex((x) => x.id === entry.id);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) floorplanHotspotsByFile.delete(selectedFloorplan);
          saveFloorplanHotspotsToStorage();
          renderFloorplanHotspots();
          renderRenderedHotspots();
          if (selectedHotspotId === entry.id) selectedHotspotId = null;
        });
        wrapper.appendChild(removeBtn);
      }

      layerEl.appendChild(wrapper);
    });
  }

  function renderFloorplanHotspots() {
    renderHotspotsToLayer(modalHotspotLayer, { allowDelete: true, showTitle: true });
  }

  function renderRenderedHotspots() {
    renderHotspotsToLayer(previewHotspotLayer, { allowDelete: false, showTitle: false });
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
      // Disallow binding the same panoramic image to multiple floorplan hotspots.
      // Build a set of all pano filenames already used as linkTo in any floorplan hotspot.
      const usedLinks = new Set();
      floorplanHotspotsByFile.forEach((list) => {
        list.forEach((entry) => {
          if (entry.linkTo) usedLinks.add(entry.linkTo);
        });
      });
      const options = images.filter((name) => !usedLinks.has(name));
      if (!options || options.length === 0) {
        await showAlert(
          'All panoramic scenes are already linked to floor plan hotspots. Delete an existing floor plan hotspot or upload a new panorama to create another link.',
          'Hotspot'
        );
        return;
      }
      const selected = await showSelectWithPreview(
        'Bind hotspot to panoramic scene',
        options,
        (val) => {
          // When previewing a panorama, revert floorplan back to Rendered Display.
          closeModal();
          loadPanorama(val);
        }
      );
      // When the preview flow ends (OK/Cancel), revert floorplan back to Expanded Display.
      openModalFor(originalSelection);
      if (selected === null) {
        // User cancelled; nothing to do
        return;
      }
      linkTo = selected;
      // Restore any previous pano view if needed; the admin UI already manages the viewer
    } catch (e) {
      console.warn('Error selecting pano for floorplan hotspot', e);
      linkTo = undefined;
      // If the modal was closed for preview, restore it on error as well.
      openModalFor(originalSelection);
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
    renderRenderedHotspots();
    // After placing one hotspot, require the user to click the Hotspot button again
    hotspotPlaceMode = false;
    if (hotspotBtn) hotspotBtn.classList.remove('active');
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
  previewContainer.addEventListener('click', (e) => {
    // If user clicked a hotspot in the rendered display, do NOT open modal.
    if (e.target && e.target.closest && e.target.closest('.floorplan-hotspot-pin')) {
      return;
    }
    if (selectedFloorplan) openModalFor(selectedFloorplan);
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

