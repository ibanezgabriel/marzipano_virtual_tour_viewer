import { appendProjectParams, getLayoutBase, getProjectId } from '../project-context.js';
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

/** Called when a panorama is renamed; updates layout hotspot linkTo and persists. */
export const layoutApi = {
  updateForRenamedPano(_oldName, _newName) {},
  cleanupForDeletedPano(_deletedName) {},
  reloadList() {},
};

export function initLayouts() {
  const panoTab = selectEl('pano-scenes');
  const floorTab = selectEl('pano-layout');
  const auditLogsTab = selectEl('pano-audit-logs');
  const panoList = selectEl('pano-image-list');
  const floorList = selectEl('pano-layout-list');
  const auditLogsPanel = selectEl('pano-audit-logs-panel');
  const addPlanBtn = selectEl('add-plan-btn');
  const addFloorInput = selectEl('add-layout');

  if (!panoTab || !floorTab || !panoList || !floorList) return;

  let selectedLayout = null;
  let lastSidebarKind = 'pano'; // 'pano' | 'layout'

  // In-memory + persisted layout hotspots:
  // filename -> Array<{ id, x, y, linkTo }>
  const LAYOUT_HOTSPOTS_KEY = 'layout-hotspots';
  const LEGACY_LAYOUT_HOTSPOTS_KEY = 'floorplan-hotspots';
  const LAST_LAYOUT_KEY_PREFIX = 'marzipano-last-layout-';
  const LEGACY_LAST_LAYOUT_KEY_PREFIX = 'marzipano-last-floorplan-';
  const layoutHotspotsByFile = new Map();
  let nextLayoutHotspotId = 0;
  let selectedHotspotId = null;

  function saveLastLayout(filename) {
    const pid = getProjectId();
    if (pid) {
      try {
        localStorage.setItem(LAST_LAYOUT_KEY_PREFIX + pid, filename);
      } catch (e) {}
    }
  }

  function loadLayoutHotspotsFromStorage() {
    try {
      const raw = localStorage.getItem(LAYOUT_HOTSPOTS_KEY) || localStorage.getItem(LEGACY_LAYOUT_HOTSPOTS_KEY);
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
        layoutHotspotsByFile.set(filename, entries);
      });
      if (maxId >= 0) nextLayoutHotspotId = maxId + 1;
    } catch (e) {
      console.warn('Could not load layout hotspots from localStorage', e);
    }
  }

  function serializeLayoutHotspots() {
    const obj = {};
    layoutHotspotsByFile.forEach((list, filename) => {
      obj[filename] = list.map((entry) => ({
        id: entry.id,
        x: entry.x,
        y: entry.y,
        linkTo: entry.linkTo,
      }));
    });
    return obj;
  }

  function saveLayoutHotspotsToStorage() {
    const payload = serializeLayoutHotspots();
    try {
      localStorage.setItem(LAYOUT_HOTSPOTS_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Could not save layout hotspots to localStorage', e);
    }
    // Persist to server so hotspots follow the project
    fetch(appendProjectParams('/api/layout-hotspots'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => console.warn('Could not save layout hotspots to server', err));
  }

  layoutApi.updateForRenamedPano = function (oldName, newName) {
    let changed = false;
    layoutHotspotsByFile.forEach((list) => {
      list.forEach((entry) => {
        if (entry.linkTo === oldName) {
          entry.linkTo = newName;
          changed = true;
        }
      });
    });
    if (changed) {
      saveLayoutHotspotsToStorage();
      renderLayoutHotspots();
      renderRenderedHotspots();
    }
  };

  layoutApi.cleanupForDeletedPano = function (deletedName) {
    let changed = false;
    layoutHotspotsByFile.forEach((list, filename) => {
      const originalLen = list.length;
      const filtered = list.filter((entry) => entry.linkTo !== deletedName);
      if (filtered.length !== originalLen) {
        changed = true;
        if (filtered.length > 0) {
          layoutHotspotsByFile.set(filename, filtered);
        } else {
          layoutHotspotsByFile.delete(filename);
        }
      }
    });
    if (changed) {
      saveLayoutHotspotsToStorage();
      renderLayoutHotspots();
      renderRenderedHotspots();
    }
  };

  const previewContainer = document.createElement('div');
  previewContainer.id = 'layout-preview';
  previewContainer.className = 'layout-preview';
  previewContainer.innerHTML = `
    <div class="layout-image-wrap">
      <img id="layout-preview-img" alt="Layout">
      <div class="layout-hotspot-layer" data-layer="rendered"></div>
    </div>
  `;
  const viewerWrap = document.getElementById('pano-viewer-wrap');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  }
  const previewImg = previewContainer.querySelector('img');
  const previewHotspotLayer = previewContainer.querySelector('.layout-hotspot-layer');

  // Modal elements for full-screen layout view
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'layout-modal-overlay';
  modalOverlay.className = 'layout-modal-overlay';
  modalOverlay.innerHTML = `
    <div class="layout-modal" role="dialog" aria-modal="true">
      <div class="layout-modal-header">
        <div class="layout-modal-title" id="layout-modal-title"></div>
      </div>
      <div class="layout-modal-body">
        <div class="layout-image-wrap">
          <div class="layout-image-stage">
            <img id="layout-modal-img" alt="Expanded layout">
            <div class="layout-hotspot-layer" data-layer="expanded"></div>
          </div>
        </div>
      </div>
      <div class="layout-modal-actions">
        <button type="button" id="layout-hotspot-btn" class="layout-action-btn layout-hotspot">Hotspot</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  const modalImg = modalOverlay.querySelector('#layout-modal-img');
  const modalEl = modalOverlay.querySelector('.layout-modal');
  const modalTitleEl = modalOverlay.querySelector('#layout-modal-title');
  const modalHotspotLayer = modalOverlay.querySelector('.layout-hotspot-layer[data-layer="expanded"]');
  const modalStageEl = modalOverlay.querySelector('.layout-image-stage');
  const modalImageWrapEl = modalOverlay.querySelector('.layout-modal-body .layout-image-wrap');
  const hotspotBtn = modalOverlay.querySelector('#layout-hotspot-btn');

  let hotspotPlaceMode = false;
  const layoutCacheBustByFile = new Map();

  function setPreviewVisible(visible) {
    if (!previewContainer) return;
    previewContainer.classList.toggle('visible', Boolean(visible));
  }

  function updateLayoutListItemActionIcons(li) {
    if (!li) return;
    const isActive = li.classList.contains('active');
    const iconByAction = {
      update: isActive ? 'assets/icons/update-w.png' : 'assets/icons/update.png',
      rename: isActive ? 'assets/icons/rename-w.png' : 'assets/icons/rename.png',
    };
    li.querySelectorAll('.layout-item-action-btn').forEach((btn) => {
      const action = btn.dataset.layoutAction;
      const img = btn.querySelector('img');
      if (!img || !iconByAction[action]) return;
      img.src = iconByAction[action];
    });
  }

  function refreshAllLayoutListActionIcons() {
    floorList.querySelectorAll('li[data-filename]').forEach((li) => updateLayoutListItemActionIcons(li));
  }

  function getLayoutTitleFromList(filename) {
    if (!floorList || !filename) return '';
    const items = Array.from(floorList.querySelectorAll('li[data-filename]'));
    const match = items.find((li) => li.dataset && li.dataset.filename === filename);
    if (!match) return '';
    const nameEl = match.querySelector('.layout-item-name');
    return (nameEl ? nameEl.textContent : match.textContent || '').trim();
  }

  function getLayoutImageSrc(filename) {
    const base = getLayoutBase();
    const encoded = encodeURIComponent(filename);
    const token = layoutCacheBustByFile.get(filename);
    if (token === undefined || token === null) return `${base}/${encoded}`;
    return `${base}/${encoded}?v=${encodeURIComponent(String(token))}`;
  }

  function bumpLayoutImageCache(filename) {
    if (!filename) return;
    layoutCacheBustByFile.set(filename, Date.now());
  }

  function moveLayoutImageCache(oldFilename, newFilename) {
    if (!oldFilename || !newFilename || oldFilename === newFilename) return;
    if (!layoutCacheBustByFile.has(oldFilename)) return;
    const token = layoutCacheBustByFile.get(oldFilename);
    layoutCacheBustByFile.delete(oldFilename);
    layoutCacheBustByFile.set(newFilename, token);
  }

  function closeModal() {
    modalOverlay.classList.remove('visible');
    document.body.classList.remove('layout-modal-open');
    hotspotPlaceMode = false;
    if (hotspotBtn) hotspotBtn.classList.remove('active');
    // When leaving Expanded Display, return to Rendered Display if a layout is selected.
    setPreviewVisible(selectedLayout && isFloorTabActive());
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
        renderLayoutHotspots();
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
    const src = getLayoutImageSrc(filename);
    modalImg.src = src;
    modalImg.alt = filename;
    if (modalTitleEl) {
      const listTitle = getLayoutTitleFromList(filename);
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
    document.body.classList.add('layout-modal-open');
    // Re-render hotspots whenever modal opens
    renderLayoutHotspots();
  }

  if (previewImg) previewImg.addEventListener('load', rerenderHotspotsForLayout);
  if (modalImg) modalImg.addEventListener('load', rerenderHotspotsForLayout);
  window.addEventListener('resize', () => requestAnimationFrame(rerenderHotspotsForLayout));

  function showPanos() {
    lastSidebarKind = 'pano';
    panoTab.classList.add('active-tab');
    floorTab.classList.remove('active-tab');
    if (auditLogsTab) auditLogsTab.classList.remove('active-tab');
    panoList.style.display = 'block';
    floorList.style.display = 'none';
    if (auditLogsPanel) auditLogsPanel.style.display = 'none';
    // Hide layout preview when switching back to panoramic scenes
    setPreviewVisible(false);
  }

  function showLayouts() {
    lastSidebarKind = 'layout';
    panoTab.classList.remove('active-tab');
    floorTab.classList.add('active-tab');
    if (auditLogsTab) auditLogsTab.classList.remove('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'block';
    if (auditLogsPanel) auditLogsPanel.style.display = 'none';
    setPreviewVisible(Boolean(selectedLayout));
  }

  function showAuditLogs() {
    if (!auditLogsTab || !auditLogsPanel) return;
    panoTab.classList.remove('active-tab');
    floorTab.classList.remove('active-tab');
    auditLogsTab.classList.add('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'none';
    auditLogsPanel.style.display = 'block';
    setPreviewVisible(false);
    document.dispatchEvent(new CustomEvent('audit-logs:shown', { detail: { kind: lastSidebarKind } }));
  }

  panoTab.addEventListener('click', showPanos);
  floorTab.addEventListener('click', showLayouts);
  if (auditLogsTab && auditLogsPanel) auditLogsTab.addEventListener('click', showAuditLogs);

  // Default state
  showPanos();

  function isFloorTabActive() {
    return floorTab.classList.contains('active-tab');
  }

  function showPreview(filename) {
    if (!previewImg) return;
    previewImg.src = getLayoutImageSrc(filename);
    setPreviewVisible(isFloorTabActive());
    renderRenderedHotspots();
  }

  function setActiveLayoutLi(filename) {
    const items = Array.from(floorList.querySelectorAll('li'));
    items.forEach((li) => {
      if (li.dataset && li.dataset.filename === filename) {
        li.classList.add('active');
      } else {
        li.classList.remove('active');
      }
      updateLayoutListItemActionIcons(li);
    });
  }

  function onLayoutClick(filename) {
    selectedLayout = filename;
    saveLastLayout(filename);
    setActiveLayoutLi(filename);
    showPreview(filename);
    document.dispatchEvent(new CustomEvent('layout:selected', { detail: { filename } }));
  }

  function clearLayoutItems() {
    // Remove all existing layout list items; keep the "+" button (which is a <button>, not <li>)
    const items = Array.from(floorList.querySelectorAll('li'));
    items.forEach((li) => li.remove());
  }

  async function loadLayouts() {
    try {
      const res = await fetch(appendProjectParams('/api/layouts'), { cache: 'no-store' });
      if (!res.ok) return;
      const files = await res.json();
      clearLayoutItems();
      const addBtn = document.getElementById('add-plan-btn');
      const lastSaved = (() => {
        const pid = getProjectId();
        if (!pid) return null;
        try {
          return (
            localStorage.getItem(LAST_LAYOUT_KEY_PREFIX + pid) ||
            localStorage.getItem(LEGACY_LAST_LAYOUT_KEY_PREFIX + pid)
          );
        } catch (e) {
          return null;
        }
      })();
      files.forEach((filename) => {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'layout-item-name';
        nameEl.textContent = filename;
        nameEl.title = filename;

        const actionsEl = document.createElement('div');
        actionsEl.className = 'layout-item-actions';

        const actionConfigs = [
          { action: 'update', icon: 'assets/icons/update.png', label: 'Update layout' },
          { action: 'rename', icon: 'assets/icons/rename.png', label: 'Rename layout' },
        ];

        actionConfigs.forEach(({ action, icon, label }) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `layout-item-action-btn layout-item-action-${action}`;
          button.dataset.layoutAction = action;
          button.setAttribute('aria-label', label);
          button.title = label;

          const img = document.createElement('img');
          img.src = icon;
          img.alt = '';
          button.appendChild(img);

          button.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onLayoutClick(filename);
            if (action === 'update') {
              handleUpdateLayout();
              return;
            }
            if (action === 'rename') {
              handleRenameLayout();
              return;
            }
          });

          actionsEl.appendChild(button);
        });

        li.append(nameEl, actionsEl);
        li.dataset.filename = filename;
        li.title = filename;
        li.draggable = true;
        li.addEventListener('click', () => onLayoutClick(filename));
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
            const orderRes = await fetch(appendProjectParams('/api/layouts/order'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered }),
            });
            if (orderRes.ok) await loadLayouts();
          } catch (e) {
            console.warn('Failed to save layout order', e);
          }
        });
        updateLayoutListItemActionIcons(li);
        if (addBtn && addBtn.parentElement === floorList) {
          floorList.insertBefore(li, addBtn);
        } else {
          floorList.appendChild(li);
        }
      });
      if (!files || files.length === 0) {
        selectedLayout = null;
        document.dispatchEvent(new CustomEvent('layout:selected', { detail: { filename: null } }));
        setPreviewVisible(false);
        const emptyLi = document.createElement('li');
        emptyLi.className = 'active';
        emptyLi.style.textAlign = 'center';
        emptyLi.textContent = 'No layout uploaded';
        if (addBtn && addBtn.parentElement === floorList) {
          floorList.insertBefore(emptyLi, addBtn);
        } else {
          floorList.appendChild(emptyLi);
        }
      }
      if (files.length > 0 && lastSaved && files.includes(lastSaved)) {
        onLayoutClick(lastSaved);
      } else {
        refreshAllLayoutListActionIcons();
      }
    } catch (e) {
      console.error('Error loading layouts', e);
    }
  }

  layoutApi.reloadList = function () {
    return loadLayouts();
  };

  // Highlight hotspot when panorama loads in viewer (admin)
  try {
    registerOnSceneLoad(() => {
      const current = getSelectedImageName();
      if (!current || !selectedLayout) return;
      const list = layoutHotspotsByFile.get(selectedLayout) || [];
      const match = list.find((e) => e.linkTo === current);
      selectedHotspotId = match ? match.id : null;
      renderLayoutHotspots();
      renderRenderedHotspots();
    });
  } catch (e) {}

  if (addPlanBtn && addFloorInput) {
    addPlanBtn.addEventListener('click', () => addFloorInput.click());
    addFloorInput.addEventListener('change', async () => {
      const files = Array.from(addFloorInput.files || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach((file) => formData.append('layout', file));
      showProgressDialog('Uploading layout image(s)');
      try {
        const data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', appendProjectParams('/upload-layout'));
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
            (data.json && data.json.message) || 'Failed to upload layouts.',
            'Upload layout'
          );
        } else {
          await loadLayouts();
        }
      } catch (e) {
        hideProgressDialog();
        console.error('Error uploading layouts', e);
        await showAlert('Error uploading layouts: ' + e, 'Upload layout');
      } finally {
        addFloorInput.value = '';
      }
    });
  }

  // Layout hotspot rendering inside the modal
  function renderHotspotsToLayer(layerEl, { allowDelete, showTitle }) {
    if (!layerEl || !selectedLayout) return;
    layerEl.innerHTML = '';
    const list = layoutHotspotsByFile.get(selectedLayout) || [];

    list.forEach((entry) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'layout-hotspot-pin';
      wrapper.style.left = `${entry.x * 100}%`;
      wrapper.style.top = `${entry.y * 100}%`;
      wrapper.setAttribute('data-layout-hotspot-id', String(entry.id));

      const dot = document.createElement('button');
      dot.type = 'button';
      const sizeClass = allowDelete ? ' hotspot-modal' : ' hotspot-preview';
      dot.className = `layout-hotspot-pin-dot${sizeClass}${selectedHotspotId === entry.id ? ' selected' : ''}`;
      if (showTitle) {
        dot.title = entry.linkTo ? `Links to ${entry.linkTo}` : 'Unlinked hotspot';
      }
      dot.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        selectedHotspotId = entry.id;
        renderLayoutHotspots();
        renderRenderedHotspots();
        if (!entry.linkTo) return;
        await loadPanorama(entry.linkTo);
      });

      wrapper.appendChild(dot);

      if (allowDelete) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'layout-hotspot-pin-remove';
        removeBtn.setAttribute('aria-label', 'Remove hotspot');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const list = layoutHotspotsByFile.get(selectedLayout) || [];
          const idx = list.findIndex((x) => x.id === entry.id);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) layoutHotspotsByFile.delete(selectedLayout);
          saveLayoutHotspotsToStorage();
          renderLayoutHotspots();
          renderRenderedHotspots();
          if (selectedHotspotId === entry.id) selectedHotspotId = null;
        });
        wrapper.appendChild(removeBtn);
      }

      layerEl.appendChild(wrapper);
    });
  }

  function renderLayoutHotspots() {
    renderHotspotsToLayer(modalHotspotLayer, { allowDelete: true, showTitle: true });
  }

  function renderRenderedHotspots() {
    renderHotspotsToLayer(previewHotspotLayer, { allowDelete: false, showTitle: false });
  }

  async function addLayoutHotspotAt(clientX, clientY) {
    if (!modalImg || !selectedLayout) return;
    syncModalStageSize();
    const rect = modalImg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    let linkTo = null;
    const originalSelection = selectedLayout;
    try {
      const images = await getImageList();
      // Disallow binding the same panoramic image to multiple layout hotspots.
      // Build a set of all pano filenames already used as linkTo in any layout hotspot.
      const usedLinks = new Set();
      layoutHotspotsByFile.forEach((list) => {
        list.forEach((entry) => {
          if (entry.linkTo) usedLinks.add(entry.linkTo);
        });
      });
      const options = images.filter((name) => !usedLinks.has(name));
      if (!options || options.length === 0) {
        await showAlert(
          'All panoramic scenes are already linked to layout hotspots. Delete an existing layout hotspot or upload a new panorama to create another link.',
          'Hotspot'
        );
        return;
      }
      const selected = await showSelectWithPreview(
        'Bind hotspot to panoramic scene',
        options,
        (val) => {
          // When previewing a panorama, revert layout back to Rendered Display.
          closeModal();
          loadPanorama(val);
        }
      );
      // When the preview flow ends (OK/Cancel), revert layout back to Expanded Display.
      openModalFor(originalSelection);
      if (selected === null) {
        // User cancelled; nothing to do
        return;
      }
      linkTo = selected;
      // Restore any previous pano view if needed; the admin UI already manages the viewer
    } catch (e) {
      console.warn('Error selecting pano for layout hotspot', e);
      linkTo = undefined;
      // If the modal was closed for preview, restore it on error as well.
      openModalFor(originalSelection);
    }

    const id = nextLayoutHotspotId++;
    const entry = { id, x, y, linkTo: linkTo || undefined };
    let list = layoutHotspotsByFile.get(originalSelection);
    if (!list) {
      list = [];
      layoutHotspotsByFile.set(originalSelection, list);
    }
    list.push(entry);
    saveLayoutHotspotsToStorage();
    renderLayoutHotspots();
    renderRenderedHotspots();
    // After placing one hotspot, require the user to click the Hotspot button again
    hotspotPlaceMode = false;
    if (hotspotBtn) hotspotBtn.classList.remove('active');
  }

  if (modalImg) {
    modalImg.addEventListener('click', (e) => {
      if (!hotspotPlaceMode) return;
      e.stopPropagation();
      addLayoutHotspotAt(e.clientX, e.clientY);
    });
  }

  if (hotspotBtn) {
    hotspotBtn.addEventListener('click', () => {
      hotspotPlaceMode = !hotspotPlaceMode;
      hotspotBtn.classList.toggle('active', hotspotPlaceMode);
    });
  }

  async function handleUpdateLayout() {
    if (!selectedLayout) {
      await showAlert('Please select a layout to update.', 'Update layout');
      return;
    }
    const layoutToUpdate = selectedLayout;
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
        `Are you sure you want to update "${layoutToUpdate}"?`,
        'Update layout'
      );
      if (!confirmed) {
        document.body.removeChild(input);
        return;
      }
      const formData = new FormData();
      formData.append('layout', file);
      formData.append('oldFilename', layoutToUpdate);
      showProgressDialog('Updating layout image...');
      try {
        const response = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', appendProjectParams('/upload-layout/update'));
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
          await showAlert('Error updating layout: ' + (data && data.message ? data.message : response.status), 'Update layout');
        } else {
          const updatedFilename = (() => {
            const fromNew = data && typeof data.newFilename === 'string' ? data.newFilename.trim() : '';
            if (fromNew) return fromNew;
            const fromAlias = data && typeof data.filename === 'string' ? data.filename.trim() : '';
            if (fromAlias) return fromAlias;
            return layoutToUpdate;
          })();

          let hotspotsChanged = false;
          if (layoutHotspotsByFile.has(layoutToUpdate)) {
            layoutHotspotsByFile.delete(layoutToUpdate);
            hotspotsChanged = true;
          }
          if (updatedFilename !== layoutToUpdate && layoutHotspotsByFile.has(updatedFilename)) {
            layoutHotspotsByFile.delete(updatedFilename);
            hotspotsChanged = true;
          }
          if (hotspotsChanged) {
            selectedHotspotId = null;
            saveLayoutHotspotsToStorage();
            renderLayoutHotspots();
            renderRenderedHotspots();
          }
          moveLayoutImageCache(layoutToUpdate, updatedFilename);
          bumpLayoutImageCache(updatedFilename);
          selectedLayout = updatedFilename;
          await loadLayouts();
          onLayoutClick(updatedFilename);
          await showTimedAlert('Layout updated successfully.', 'Update layout', 500);
        }
      } catch (e) {
        hideProgressDialog();
        await showAlert('Error updating layout: ' + e, 'Update layout');
      } finally {
        document.body.removeChild(input);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function handleRenameLayout() {
    if (!selectedLayout) {
      await showAlert('Please select a layout to rename.', 'Rename layout');
      return;
    }
    const lastDotIndex = selectedLayout.lastIndexOf('.');
    const extension = lastDotIndex > -1 ? selectedLayout.substring(lastDotIndex) : '';
    const nameWithoutExt = lastDotIndex > -1 ? selectedLayout.substring(0, lastDotIndex) : selectedLayout;
    const newName = await showPrompt(`Enter new name for "${selectedLayout}":`, nameWithoutExt, 'Rename layout');
    if (newName === null || newName === '') return;
    const newFileName = newName.includes('.') ? newName : newName + extension;
    if (newFileName.includes('/') || newFileName.includes('\\') || newFileName.includes('..')) {
      await showAlert('Invalid filename. Please avoid special characters like / \\ ..', 'Rename layout');
      return;
    }
    try {
      const res = await fetch(appendProjectParams('/api/layouts/rename'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldFilename: selectedLayout, newFilename: newFileName }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await showAlert('Error renaming layout: ' + (data && data.message ? data.message : res.status), 'Rename layout');
      } else {
        if (layoutHotspotsByFile.has(selectedLayout)) {
          const list = layoutHotspotsByFile.get(selectedLayout);
          layoutHotspotsByFile.delete(selectedLayout);
          layoutHotspotsByFile.set(newFileName, list);
          saveLayoutHotspotsToStorage();
        }
        moveLayoutImageCache(selectedLayout, newFileName);
        selectedLayout = newFileName;
        await loadLayouts();
        onLayoutClick(selectedLayout);
        await showTimedAlert('Layout renamed successfully.', 'Rename layout', 500);
      }
    } catch (e) {
        await showAlert('Error renaming layout: ' + e, 'Rename layout');
    }
  }

  // Open modal when clicking the small preview
  previewContainer.addEventListener('click', (e) => {
    // If user clicked a hotspot in the rendered display, do NOT open modal.
    if (e.target && e.target.closest && e.target.closest('.layout-hotspot-pin')) {
      return;
    }
    if (selectedLayout) openModalFor(selectedLayout);
  });

  // Initial load: hotspots then layouts
  (async () => {
    loadLayoutHotspotsFromStorage();
    try {
      const res = await fetch(appendProjectParams('/api/layout-hotspots'), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          layoutHotspotsByFile.clear();
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
            layoutHotspotsByFile.set(filename, entries);
          });
          if (maxId >= 0) nextLayoutHotspotId = maxId + 1;
        }
      }
    } catch (e) {
      console.warn('Could not load layout hotspots from server', e);
    }
    loadLayouts();
  })();
}
