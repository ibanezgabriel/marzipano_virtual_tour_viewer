import { appendProjectParams, getFloorplanBase, getProjectId } from '../project-context.js';
import {
  showAlert,
  showConfirm,
  showPrompt,
  showSelectWithPreview,
  showTimedAlert,
  showProgressDialog,
  hideProgressDialog,
  updateProgressDialog,
} from '../dialog.js';
import { getImageList, loadPanorama, registerOnSceneLoad, getSelectedImageName } from '../marzipano-viewer.js';

function selectEl(id) {
  return document.getElementById(id);
}

/** Called when a panorama is renamed; updates floor plan hotspot linkTo and persists. */
export const floorplanApi = {
  updateForRenamedPano(_oldName, _newName) {},
  cleanupForDeletedPano(_deletedName) {},
  reloadList() {},
};

export function initFloorplans() {
  const panoTab = selectEl('pano-scenes');
  const floorTab = selectEl('pano-floorplan');
  const archiveTab = selectEl('pano-archive');
  const panoList = selectEl('pano-image-list');
  const floorList = selectEl('pano-floorplan-list');
  const archivePanel = selectEl('pano-archive-panel');
  const addPlanBtn = selectEl('add-plan-btn');
  const addFloorInput = selectEl('add-floorplan');

  if (!panoTab || !floorTab || !panoList || !floorList) return;

  let selectedFloorplan = null;
  let lastSidebarKind = 'pano'; // 'pano' | 'floorplan'

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
          <div class="floorplan-image-stage">
            <img id="floorplan-modal-img" alt="Floor plan expanded">
            <div class="floorplan-hotspot-layer" data-layer="expanded"></div>
          </div>
        </div>
      </div>
      <div class="floorplan-modal-actions">
        <button type="button" id="floorplan-hotspot-btn" class="floorplan-action-btn floorplan-hotspot">Hotspot</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  const modalImg = modalOverlay.querySelector('#floorplan-modal-img');
  const modalEl = modalOverlay.querySelector('.floorplan-modal');
  const modalTitleEl = modalOverlay.querySelector('#floorplan-modal-title');
  const modalHotspotLayer = modalOverlay.querySelector('.floorplan-hotspot-layer[data-layer="expanded"]');
  const modalStageEl = modalOverlay.querySelector('.floorplan-image-stage');
  const modalImageWrapEl = modalOverlay.querySelector('.floorplan-modal-body .floorplan-image-wrap');
  const hotspotBtn = modalOverlay.querySelector('#floorplan-hotspot-btn');

  let hotspotPlaceMode = false;
  const floorplanCacheBustByFile = new Map();

  function setPreviewVisible(visible) {
    if (!previewContainer) return;
    previewContainer.classList.toggle('visible', Boolean(visible));
  }

  function updateFloorplanListItemActionIcons(li) {
    if (!li) return;
    const isActive = li.classList.contains('active');
    const iconByAction = {
      update: isActive ? 'assets/icons/update-w.png' : 'assets/icons/update.png',
      rename: isActive ? 'assets/icons/rename-w.png' : 'assets/icons/rename.png',
    };
    li.querySelectorAll('.floorplan-item-action-btn').forEach((btn) => {
      const action = btn.dataset.floorplanAction;
      const img = btn.querySelector('img');
      if (!img || !iconByAction[action]) return;
      img.src = iconByAction[action];
    });
  }

  function refreshAllFloorplanListActionIcons() {
    floorList.querySelectorAll('li[data-filename]').forEach((li) => updateFloorplanListItemActionIcons(li));
  }

  function getFloorplanTitleFromList(filename) {
    if (!floorList || !filename) return '';
    const items = Array.from(floorList.querySelectorAll('li[data-filename]'));
    const match = items.find((li) => li.dataset && li.dataset.filename === filename);
    if (!match) return '';
    const nameEl = match.querySelector('.floorplan-item-name');
    return (nameEl ? nameEl.textContent : match.textContent || '').trim();
  }

  function getFloorplanImageSrc(filename) {
    const base = getFloorplanBase();
    const encoded = encodeURIComponent(filename);
    const token = floorplanCacheBustByFile.get(filename);
    if (token === undefined || token === null) return `${base}/${encoded}`;
    return `${base}/${encoded}?v=${encodeURIComponent(String(token))}`;
  }

  function bumpFloorplanImageCache(filename) {
    if (!filename) return;
    floorplanCacheBustByFile.set(filename, Date.now());
  }

  function moveFloorplanImageCache(oldFilename, newFilename) {
    if (!oldFilename || !newFilename || oldFilename === newFilename) return;
    if (!floorplanCacheBustByFile.has(oldFilename)) return;
    const token = floorplanCacheBustByFile.get(oldFilename);
    floorplanCacheBustByFile.delete(oldFilename);
    floorplanCacheBustByFile.set(newFilename, token);
  }

  function closeModal() {
    modalOverlay.classList.remove('visible');
    document.body.classList.remove('floorplan-modal-open');
    hotspotPlaceMode = false;
    if (hotspotBtn) hotspotBtn.classList.remove('active');
    // When leaving Expanded Display, return to Rendered Display if a floor plan is selected.
    setPreviewVisible(selectedFloorplan && isFloorTabActive());
  }

  function syncStageContain(imgEl, stageEl, containerEl) {
    if (!imgEl || !stageEl || !containerEl) return;
    const nw = Number(imgEl.naturalWidth || 0);
    const nh = Number(imgEl.naturalHeight || 0);
    if (!nw || !nh) return;
    const cw = Math.max(0, containerEl.clientWidth || 0);
    const ch = Math.max(0, containerEl.clientHeight || 0);
    if (!cw || !ch) return;

    const scale = Math.min(cw / nw, ch / nh);
    const w = Math.max(1, Math.floor(nw * scale));
    const h = Math.max(1, Math.floor(nh * scale));

    stageEl.style.width = `${w}px`;
    stageEl.style.height = `${h}px`;
  }

  function syncModalStageSize() {
    if (!modalOverlay.classList.contains('visible')) return;
    syncStageContain(modalImg, modalStageEl, modalImageWrapEl);
  }

  // Keep hotspot overlays aligned after image loads or viewport resizes.
  function rerenderHotspotsForLayout() {
    try {
      if (modalOverlay.classList.contains('visible')) {
        syncModalStageSize();
        renderFloorplanHotspots();
      }
    } catch (e) {}
    try {
      if (previewContainer.classList.contains('visible')) renderRenderedHotspots();
    } catch (e) {}
  }

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });

  function openModalFor(filename) {
    if (!filename || !previewImg || !modalImg) return;
    const src = getFloorplanImageSrc(filename);
    modalImg.src = src;
    modalImg.alt = filename;
    if (modalTitleEl) {
      const listTitle = getFloorplanTitleFromList(filename);
      if (listTitle) {
        modalTitleEl.textContent = listTitle;
      } else {
        const dot = filename.lastIndexOf('.');
        const displayName = dot > 0 ? filename.substring(0, dot) : filename;
        modalTitleEl.textContent = displayName;
      }
    }
    // When entering Expanded Display, hide the Rendered Display (minimized preview).
    setPreviewVisible(false);
    modalOverlay.classList.add('visible');
    document.body.classList.add('floorplan-modal-open');
    // Re-render hotspots whenever modal opens
    renderFloorplanHotspots();
  }

  if (previewImg) previewImg.addEventListener('load', rerenderHotspotsForLayout);
  if (modalImg) modalImg.addEventListener('load', rerenderHotspotsForLayout);
  window.addEventListener('resize', () => requestAnimationFrame(rerenderHotspotsForLayout));

  function showPanos() {
    lastSidebarKind = 'pano';
    panoTab.classList.add('active-tab');
    floorTab.classList.remove('active-tab');
    if (archiveTab) archiveTab.classList.remove('active-tab');
    panoList.style.display = 'block';
    floorList.style.display = 'none';
    if (archivePanel) archivePanel.style.display = 'none';
    // Hide floorplan preview when switching back to panoramic scenes
    setPreviewVisible(false);
  }

  function showFloorplans() {
    lastSidebarKind = 'floorplan';
    panoTab.classList.remove('active-tab');
    floorTab.classList.add('active-tab');
    if (archiveTab) archiveTab.classList.remove('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'block';
    if (archivePanel) archivePanel.style.display = 'none';
    setPreviewVisible(Boolean(selectedFloorplan));
  }

  function showArchive() {
    if (!archiveTab || !archivePanel) return;
    panoTab.classList.remove('active-tab');
    floorTab.classList.remove('active-tab');
    archiveTab.classList.add('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'none';
    archivePanel.style.display = 'block';
    setPreviewVisible(false);
    document.dispatchEvent(new CustomEvent('archive:shown', { detail: { kind: lastSidebarKind } }));
  }

  panoTab.addEventListener('click', showPanos);
  floorTab.addEventListener('click', showFloorplans);
  if (archiveTab && archivePanel) archiveTab.addEventListener('click', showArchive);

  // Default state
  showPanos();

  function isFloorTabActive() {
    return floorTab.classList.contains('active-tab');
  }

  function showPreview(filename) {
    if (!previewImg) return;
    previewImg.src = getFloorplanImageSrc(filename);
    setPreviewVisible(isFloorTabActive());
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
      updateFloorplanListItemActionIcons(li);
    });
  }

  function onFloorplanClick(filename) {
    selectedFloorplan = filename;
    saveLastFloorplan(filename);
    setActiveFloorplanLi(filename);
    showPreview(filename);
    document.dispatchEvent(new CustomEvent('floorplan:selected', { detail: { filename } }));
  }

  function clearFloorplanItems() {
    // Remove all existing floor plan list items; keep the "+" button (which is a <button>, not <li>)
    const items = Array.from(floorList.querySelectorAll('li'));
    items.forEach((li) => li.remove());
  }

  async function loadFloorplans() {
    try {
      const res = await fetch(appendProjectParams('/api/floorplans'), { cache: 'no-store' });
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
        const nameEl = document.createElement('span');
        nameEl.className = 'floorplan-item-name';
        nameEl.textContent = filename;
        nameEl.title = filename;

        const actionsEl = document.createElement('div');
        actionsEl.className = 'floorplan-item-actions';

        const actionConfigs = [
          { action: 'update', icon: 'assets/icons/update.png', label: 'Update floor plan' },
          { action: 'rename', icon: 'assets/icons/rename.png', label: 'Rename floor plan' },
        ];

        actionConfigs.forEach(({ action, icon, label }) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `floorplan-item-action-btn floorplan-item-action-${action}`;
          button.dataset.floorplanAction = action;
          button.setAttribute('aria-label', label);
          button.title = label;

          const img = document.createElement('img');
          img.src = icon;
          img.alt = '';
          button.appendChild(img);

          button.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onFloorplanClick(filename);
            if (action === 'update') {
              handleUpdateFloorplan();
              return;
            }
            if (action === 'rename') {
              handleRenameFloorplan();
              return;
            }
          });

          actionsEl.appendChild(button);
        });

        li.append(nameEl, actionsEl);
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
        updateFloorplanListItemActionIcons(li);
        if (addBtn && addBtn.parentElement === floorList) {
          floorList.insertBefore(li, addBtn);
        } else {
          floorList.appendChild(li);
        }
      });
      if (!files || files.length === 0) {
        selectedFloorplan = null;
        document.dispatchEvent(new CustomEvent('floorplan:selected', { detail: { filename: null } }));
        setPreviewVisible(false);
        const emptyLi = document.createElement('li');
        emptyLi.className = 'active';
        emptyLi.style.textAlign = 'center';
        emptyLi.textContent = 'No floor plan uploaded';
        if (addBtn && addBtn.parentElement === floorList) {
          floorList.insertBefore(emptyLi, addBtn);
        } else {
          floorList.appendChild(emptyLi);
        }
      }
      if (files.length > 0 && lastSaved && files.includes(lastSaved)) {
        onFloorplanClick(lastSaved);
      } else {
        refreshAllFloorplanListActionIcons();
      }
    } catch (e) {
      console.error('Error loading floorplans', e);
    }
  }

  floorplanApi.reloadList = function () {
    return loadFloorplans();
  };

  // Highlight hotspot when panorama loads in viewer (admin)
  try {
    registerOnSceneLoad(() => {
      const current = getSelectedImageName();
      if (!current || !selectedFloorplan) return;
      const list = floorplanHotspotsByFile.get(selectedFloorplan) || [];
      const match = list.find((e) => e.linkTo === current);
      selectedHotspotId = match ? match.id : null;
      renderFloorplanHotspots();
      renderRenderedHotspots();
    });
  } catch (e) {}

  if (addPlanBtn && addFloorInput) {
    addPlanBtn.addEventListener('click', () => addFloorInput.click());
    addFloorInput.addEventListener('change', async () => {
      const files = Array.from(addFloorInput.files || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach((file) => formData.append('floorplan', file));
      showProgressDialog('Uploading Floor Plan images(s)');
      try {
        const data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', appendProjectParams('/upload-floorplan'));
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable || e.total <= 0) return;
            const percent = Math.round((e.loaded / e.total) * 100);
            updateProgressDialog(percent);
          };
          xhr.onload = () => {
            try {
              const json = JSON.parse(xhr.responseText || '{}');
              resolve({ ok: xhr.status >= 200 && xhr.status < 300, json });
            } catch (err) {
              reject(err);
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(formData);
        });
        updateProgressDialog(100);
        hideProgressDialog();
        if (!data.ok || !data.json || !data.json.success) {
          await showAlert(
            (data.json && data.json.message) || 'Failed to upload floor plans.',
            'Upload floor plan'
          );
        } else {
          await loadFloorplans();
        }
      } catch (e) {
        hideProgressDialog();
        console.error('Error uploading floorplans', e);
        await showAlert('Error uploading floor plans: ' + e, 'Upload floor plan');
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
      const sizeClass = allowDelete ? ' hotspot-modal' : ' hotspot-preview';
      dot.className = `floorplan-hotspot-pin-dot${sizeClass}${selectedHotspotId === entry.id ? ' selected' : ''}`;
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
    syncModalStageSize();
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

  async function handleUpdateFloorplan() {
    if (!selectedFloorplan) {
      await showAlert('Please select a floor plan to update.', 'Update floor plan');
      return;
    }
    const floorplanToUpdate = selectedFloorplan;
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
      const confirmed = await showConfirm(
        `Are you sure you want to update "${floorplanToUpdate}"?`,
        'Update floor plan'
      );
      if (!confirmed) {
        document.body.removeChild(input);
        return;
      }
      const formData = new FormData();
      formData.append('floorplan', file);
      formData.append('oldFilename', floorplanToUpdate);
      showProgressDialog('Updating floor plan image...');
      try {
        const response = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', appendProjectParams('/upload-floorplan/update'));
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable || e.total <= 0) return;
            const percent = Math.round((e.loaded / e.total) * 100);
            updateProgressDialog(percent);
          };
          xhr.onload = () => {
            try {
              const json = JSON.parse(xhr.responseText || '{}');
              resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
            } catch (err) {
              reject(err);
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(formData);
        });
        updateProgressDialog(100);
        hideProgressDialog();
        const data = response.json;
        if (!response.ok || !data.success) {
          await showAlert('Error updating floor plan: ' + (data && data.message ? data.message : response.status), 'Update floor plan');
        } else {
          const updatedFilename = (() => {
            const fromNew = data && typeof data.newFilename === 'string' ? data.newFilename.trim() : '';
            if (fromNew) return fromNew;
            const fromAlias = data && typeof data.filename === 'string' ? data.filename.trim() : '';
            if (fromAlias) return fromAlias;
            return floorplanToUpdate;
          })();

          let hotspotsChanged = false;
          if (floorplanHotspotsByFile.has(floorplanToUpdate)) {
            floorplanHotspotsByFile.delete(floorplanToUpdate);
            hotspotsChanged = true;
          }
          if (updatedFilename !== floorplanToUpdate && floorplanHotspotsByFile.has(updatedFilename)) {
            floorplanHotspotsByFile.delete(updatedFilename);
            hotspotsChanged = true;
          }
          if (hotspotsChanged) {
            selectedHotspotId = null;
            saveFloorplanHotspotsToStorage();
            renderFloorplanHotspots();
            renderRenderedHotspots();
          }
          moveFloorplanImageCache(floorplanToUpdate, updatedFilename);
          bumpFloorplanImageCache(updatedFilename);
          selectedFloorplan = updatedFilename;
          await loadFloorplans();
          onFloorplanClick(updatedFilename);
          await showTimedAlert('Floor plan updated successfully.', 'Update floor plan', 500);
        }
      } catch (e) {
        hideProgressDialog();
        await showAlert('Error updating floor plan: ' + e, 'Update floor plan');
      } finally {
        document.body.removeChild(input);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function handleRenameFloorplan() {
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
        if (floorplanHotspotsByFile.has(selectedFloorplan)) {
          const list = floorplanHotspotsByFile.get(selectedFloorplan);
          floorplanHotspotsByFile.delete(selectedFloorplan);
          floorplanHotspotsByFile.set(newFileName, list);
          saveFloorplanHotspotsToStorage();
        }
        moveFloorplanImageCache(selectedFloorplan, newFileName);
        selectedFloorplan = newFileName;
        await loadFloorplans();
        onFloorplanClick(selectedFloorplan);
        await showTimedAlert('Floor plan renamed successfully.', 'Rename floor plan', 500);
      }
    } catch (e) {
      await showAlert('Error renaming floor plan: ' + e, 'Rename floor plan');
    }
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
      const res = await fetch(appendProjectParams('/api/floorplan-hotspots'), { cache: 'no-store' });
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
