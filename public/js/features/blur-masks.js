import {
  getCurrentScene,
  getSelectedImageName,
  registerOnSceneLoad,
} from '../marzipano-viewer.js';
import { appendProjectParams } from '../project-context.js';

const BLUR_MASK_CLASS = 'app-blur-mask';
const BLUR_MASK_CORE_CLASS = 'app-blur-mask-core';
const BLUR_MASK_PENDING_CLASS = 'app-blur-mask-pending';
const BLUR_CURSOR_PREVIEW_CLASS = 'app-blur-cursor-preview';
const BLUR_STORAGE_KEY = 'marzipano-blur-masks';

const MIN_BLUR_RADIUS_PX = 20;
const MAX_BLUR_RADIUS_PX = 200;
const DEFAULT_BLUR_RADIUS_PX = 56;
const BLUR_RADIUS_STEP_PX = 6;
const SAVE_DEBOUNCE_MS = 280;

const panoViewerEl = document.getElementById('pano-viewer');
const actionPanelEl = document.getElementById('pano-action');
const blurBtnEl = document.getElementById('pano-blur-btn');
const blurAddBtnEl = document.getElementById('pano-blur-add-btn');
const hotspotBtnEl = document.getElementById('pano-hotspot-btn');

const blurMasksByImage = new Map();

let nextBlurMaskId = 0;
let blurFeatureInitialized = false;
let blurModeEnabled = false;
let addModeEnabled = false;
let placementModeActive = false;
let placementRadiusPx = DEFAULT_BLUR_RADIUS_PX;
let previewEl = null;
let lastPointerClientX = null;
let lastPointerClientY = null;
let pendingMask = null;
let editingMask = null;
let queuedSaveTimer = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewerRect() {
  return panoViewerEl ? panoViewerEl.getBoundingClientRect() : null;
}

function getViewerBaseSize() {
  const rect = getViewerRect();
  if (!rect) return 1;
  return Math.max(1, Math.min(rect.width, rect.height));
}

function radiusPxToRatio(radiusPx) {
  return clamp(radiusPx / getViewerBaseSize(), 0.01, 0.35);
}

function ratioToRadiusPx(radiusRatio) {
  const px = Number(radiusRatio) * getViewerBaseSize();
  return clamp(px, MIN_BLUR_RADIUS_PX, MAX_BLUR_RADIUS_PX);
}

function applyMaskSize(maskEl, radiusRatio) {
  if (!maskEl) return;
  const radiusPx = ratioToRadiusPx(radiusRatio);
  const diameter = radiusPx * 2;
  maskEl.style.width = `${diameter}px`;
  maskEl.style.height = `${diameter}px`;
  maskEl.style.marginLeft = `${-radiusPx}px`;
  maskEl.style.marginTop = `${-radiusPx}px`;
}

function updatePreviewSize() {
  if (!previewEl) return;
  const diameter = placementRadiusPx * 2;
  previewEl.style.width = `${diameter}px`;
  previewEl.style.height = `${diameter}px`;
}

function hidePreview() {
  if (!previewEl) return;
  previewEl.classList.remove('visible');
}

function showPreviewAt(clientX, clientY) {
  if (!previewEl || !placementModeActive) return;
  const rect = getViewerRect();
  if (!rect) return;
  previewEl.style.left = `${clientX - rect.left}px`;
  previewEl.style.top = `${clientY - rect.top}px`;
  previewEl.classList.add('visible');
}

function ensurePreviewElement() {
  if (!panoViewerEl || previewEl) return;
  previewEl = document.createElement('div');
  previewEl.className = BLUR_CURSOR_PREVIEW_CLASS;
  updatePreviewSize();
  panoViewerEl.appendChild(previewEl);
}

function screenToViewCoords(clientX, clientY) {
  const scene = getCurrentScene();
  if (!scene) return null;
  const view = scene.view();
  const rect = getViewerRect();
  if (!rect) return null;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (view.setSize && (view.width() === 0 || view.height() === 0)) {
    view.setSize({ width: rect.width, height: rect.height });
  }
  if (typeof view.screenToCoordinates !== 'function') return null;
  return view.screenToCoordinates({ x, y });
}

function serializeBlurMasks() {
  const obj = {};
  blurMasksByImage.forEach((list, imageName) => {
    obj[imageName] = list.map((entry) => ({
      id: entry.id,
      yaw: entry.yaw,
      pitch: entry.pitch,
      radiusRatio: entry.radiusRatio,
    }));
  });
  return obj;
}

function saveBlurMasksToStorage({ persistToServer = true } = {}) {
  const payload = serializeBlurMasks();
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not save blur masks to localStorage', e);
  }
  if (!persistToServer) return;
  fetch(appendProjectParams('/api/blur-masks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => console.warn('Could not save blur masks to server', err));
}

function queueSaveBlurMasks() {
  if (queuedSaveTimer) {
    clearTimeout(queuedSaveTimer);
  }
  queuedSaveTimer = setTimeout(() => {
    queuedSaveTimer = null;
    saveBlurMasksToStorage();
  }, SAVE_DEBOUNCE_MS);
}

function flushQueuedSave() {
  if (!queuedSaveTimer) return;
  clearTimeout(queuedSaveTimer);
  queuedSaveTimer = null;
  saveBlurMasksToStorage();
}

function parseBlurMasksPayload(obj) {
  if (typeof obj !== 'object' || obj === null) return;
  let maxId = -1;
  Object.entries(obj).forEach(([imageName, list]) => {
    if (!Array.isArray(list)) return;
    const entries = list.map((entry) => {
      const id = Number(entry.id);
      if (id > maxId) maxId = id;
      return {
        id,
        yaw: Number(entry.yaw),
        pitch: Number(entry.pitch),
        radiusRatio: clamp(Number(entry.radiusRatio) || radiusPxToRatio(DEFAULT_BLUR_RADIUS_PX), 0.01, 0.35),
        hotspot: null,
      };
    });
    blurMasksByImage.set(imageName, entries);
  });
  if (maxId >= 0) nextBlurMaskId = maxId + 1;
}

function loadBlurMasksFromStorage() {
  try {
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    if (!raw) return;
    parseBlurMasksPayload(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not load blur masks from localStorage', e);
  }
}

async function loadBlurMasksFromServer() {
  const res = await fetch(appendProjectParams('/api/blur-masks'));
  if (!res.ok) throw new Error('Blur masks fetch failed');
  const data = await res.json();
  blurMasksByImage.clear();
  parseBlurMasksPayload(data);
  restoreBlurMasksForCurrentScene();
}

function updateBlurModeUi() {
  if (actionPanelEl) {
    actionPanelEl.classList.toggle('blur-mode', blurModeEnabled);
  }
  if (blurBtnEl) {
    blurBtnEl.classList.toggle('active', blurModeEnabled);
  }
  if (blurAddBtnEl) {
    blurAddBtnEl.classList.toggle('active', blurModeEnabled && addModeEnabled);
  }
  if (panoViewerEl) {
    const editModeActive = blurModeEnabled && !addModeEnabled && !pendingMask;
    panoViewerEl.classList.toggle('app-blur-edit-mode', editModeActive);
  }
}

function clearEditingMask() {
  if (!editingMask) return;
  if (editingMask.element) {
    editingMask.element.classList.remove('editing');
  }
  editingMask = null;
}

function setEditingMask(entry, imageName, element) {
  if (!blurModeEnabled || addModeEnabled || pendingMask) return;
  if (editingMask && editingMask.entry === entry) return;
  clearEditingMask();
  editingMask = { entry, imageName, element };
  element.classList.add('editing');
}

function destroyPendingMask() {
  if (!pendingMask) return;
  try {
    const scene = getCurrentScene();
    const container = scene && scene.hotspotContainer ? scene.hotspotContainer() : null;
    if (
      container &&
      pendingMask.hotspot &&
      typeof container.hasHotspot === 'function' &&
      container.hasHotspot(pendingMask.hotspot)
    ) {
      container.destroyHotspot(pendingMask.hotspot);
    }
  } catch (e) {}
  pendingMask = null;
}

function setPlacementModeActive(active) {
  placementModeActive = Boolean(active) && blurModeEnabled && addModeEnabled && !pendingMask;
  if (!panoViewerEl) return;
  panoViewerEl.classList.toggle('app-blur-place-mode', placementModeActive);
  if (!placementModeActive) {
    hidePreview();
  } else {
    updatePreviewSize();
    if (lastPointerClientX !== null && lastPointerClientY !== null) {
      showPreviewAt(lastPointerClientX, lastPointerClientY);
    }
  }
  updateBlurModeUi();
}

function setAddModeEnabled(enabled) {
  addModeEnabled = Boolean(enabled) && blurModeEnabled;
  if (addModeEnabled) {
    clearEditingMask();
  }
  setPlacementModeActive(addModeEnabled);
  updateBlurModeUi();
}

function setBlurModeEnabled(enabled) {
  blurModeEnabled = Boolean(enabled);
  if (!blurModeEnabled) {
    setAddModeEnabled(false);
    clearEditingMask();
    destroyPendingMask();
    setPlacementModeActive(false);
    flushQueuedSave();
    updateBlurModeUi();
    return;
  }

  // Prevent conflicts with hotspot place mode.
  if (hotspotBtnEl && hotspotBtnEl.classList.contains('active')) {
    hotspotBtnEl.click();
  }
  clearEditingMask();
  setAddModeEnabled(false);
  updateBlurModeUi();
  restoreBlurMasksForCurrentScene();
}

function removeMaskEntry(entry, imageName) {
  const list = blurMasksByImage.get(imageName) || [];
  const idx = list.findIndex((x) => x.id === entry.id);
  if (idx === -1) return;
  if (editingMask && editingMask.entry && editingMask.entry.id === entry.id) {
    clearEditingMask();
  }
  list.splice(idx, 1);
  try {
    const scene = getCurrentScene();
    const container = scene && scene.hotspotContainer ? scene.hotspotContainer() : null;
    if (container && entry.hotspot && typeof container.hasHotspot === 'function' && container.hasHotspot(entry.hotspot)) {
      container.destroyHotspot(entry.hotspot);
    }
  } catch (e) {}
  flushQueuedSave();
  saveBlurMasksToStorage();
  restoreBlurMasksForCurrentScene();
}

function createConfirmedMaskElement(entry, imageName) {
  const wrapper = document.createElement('div');
  wrapper.className = `${BLUR_MASK_CLASS} app-blur-mask-confirmed`;
  wrapper.setAttribute('data-app-blur-mask-id', String(entry.id));
  wrapper.setAttribute('aria-hidden', 'true');
  applyMaskSize(wrapper, entry.radiusRatio);

  const core = document.createElement('div');
  core.className = BLUR_MASK_CORE_CLASS;
  wrapper.appendChild(core);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'app-blur-delete-btn';
  deleteBtn.setAttribute('aria-label', 'Delete blur mask');
  deleteBtn.textContent = 'X';
  wrapper.appendChild(deleteBtn);

  wrapper.addEventListener('click', (e) => {
    if (!blurModeEnabled || addModeEnabled || pendingMask) return;
    e.preventDefault();
    e.stopPropagation();
    setEditingMask(entry, imageName, wrapper);
  });

  wrapper.addEventListener(
    'wheel',
    (e) => {
      if (!blurModeEnabled || addModeEnabled || pendingMask) return;
      e.preventDefault();
      e.stopPropagation();
      setEditingMask(entry, imageName, wrapper);
      const currentPx = ratioToRadiusPx(entry.radiusRatio);
      const nextPx = clamp(
        currentPx + (e.deltaY < 0 ? BLUR_RADIUS_STEP_PX : -BLUR_RADIUS_STEP_PX),
        MIN_BLUR_RADIUS_PX,
        MAX_BLUR_RADIUS_PX
      );
      entry.radiusRatio = radiusPxToRatio(nextPx);
      applyMaskSize(wrapper, entry.radiusRatio);
      queueSaveBlurMasks();
    },
    { passive: false }
  );

  deleteBtn.addEventListener('click', (e) => {
    if (!blurModeEnabled || addModeEnabled || pendingMask) return;
    e.preventDefault();
    e.stopPropagation();
    removeMaskEntry(entry, imageName);
  });

  return wrapper;
}

function finalizePendingMask(confirm) {
  if (!pendingMask) return;
  const { entry, imageName } = pendingMask;
  destroyPendingMask();
  if (confirm) {
    let list = blurMasksByImage.get(imageName);
    if (!list) {
      list = [];
      blurMasksByImage.set(imageName, list);
    }
    list.push({
      id: entry.id,
      yaw: entry.yaw,
      pitch: entry.pitch,
      radiusRatio: entry.radiusRatio,
      hotspot: null,
    });
    flushQueuedSave();
    saveBlurMasksToStorage();
    restoreBlurMasksForCurrentScene();
  }
  setPlacementModeActive(addModeEnabled);
}

function adjustPendingMaskRadius(deltaPx) {
  if (!pendingMask) return;
  const currentPx = ratioToRadiusPx(pendingMask.entry.radiusRatio);
  const nextPx = clamp(currentPx + deltaPx, MIN_BLUR_RADIUS_PX, MAX_BLUR_RADIUS_PX);
  pendingMask.entry.radiusRatio = radiusPxToRatio(nextPx);
  applyMaskSize(pendingMask.element, pendingMask.entry.radiusRatio);
}

function createPendingMaskElement(entry) {
  const wrapper = document.createElement('div');
  wrapper.className = `${BLUR_MASK_CLASS} ${BLUR_MASK_PENDING_CLASS}`;
  wrapper.setAttribute('data-app-blur-mask-id', String(entry.id));
  wrapper.setAttribute('role', 'group');
  wrapper.setAttribute('aria-label', 'Pending blur mask');
  applyMaskSize(wrapper, entry.radiusRatio);

  const core = document.createElement('div');
  core.className = BLUR_MASK_CORE_CLASS;
  wrapper.appendChild(core);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'app-blur-confirm-btn';
  confirmBtn.setAttribute('aria-label', 'Confirm blur mask');
  confirmBtn.textContent = 'OK';
  wrapper.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'app-blur-cancel-btn';
  cancelBtn.setAttribute('aria-label', 'Cancel blur mask');
  cancelBtn.textContent = 'X';
  wrapper.appendChild(cancelBtn);

  confirmBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finalizePendingMask(true);
  });

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finalizePendingMask(false);
  });

  wrapper.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      adjustPendingMaskRadius(e.deltaY < 0 ? BLUR_RADIUS_STEP_PX : -BLUR_RADIUS_STEP_PX);
    },
    { passive: false }
  );

  return wrapper;
}

function createPendingMaskAt(clientX, clientY) {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName || pendingMask) return;
  const coords = screenToViewCoords(clientX, clientY);
  if (!coords) return;

  clearEditingMask();

  const entry = {
    id: nextBlurMaskId++,
    yaw: coords.yaw,
    pitch: coords.pitch,
    radiusRatio: radiusPxToRatio(placementRadiusPx),
  };

  const el = createPendingMaskElement(entry);
  const hotspot = scene.hotspotContainer().createHotspot(el, {
    yaw: entry.yaw,
    pitch: entry.pitch,
  });
  pendingMask = { entry, hotspot, element: el, imageName };
  setPlacementModeActive(false);
}

function restoreBlurMasksForCurrentScene() {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName) return;

  if (pendingMask && pendingMask.imageName !== imageName) {
    destroyPendingMask();
  }
  clearEditingMask();

  const container = scene.hotspotContainer();
  const list = blurMasksByImage.get(imageName) || [];
  list.forEach((entry) => {
    if (
      entry.hotspot &&
      typeof container.hasHotspot === 'function' &&
      container.hasHotspot(entry.hotspot)
    ) {
      container.destroyHotspot(entry.hotspot);
    }
    const el = createConfirmedMaskElement(entry, imageName);
    entry.hotspot = container.createHotspot(el, { yaw: entry.yaw, pitch: entry.pitch });
  });
  updateBlurModeUi();
}

function isInteractiveOverlayTarget(target) {
  if (!target || !target.closest) return false;
  return Boolean(
    target.closest('.app-hotspot-pin') ||
      target.closest(`.${BLUR_MASK_CLASS}`) ||
      target.closest('.app-hotspot-remove')
  );
}

function onViewerPointerMove(e) {
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
  if (!placementModeActive) return;
  showPreviewAt(e.clientX, e.clientY);
}

function onViewerPointerLeave() {
  hidePreview();
}

function onViewerWheel(e) {
  if (!placementModeActive) return;
  e.preventDefault();
  placementRadiusPx = clamp(
    placementRadiusPx + (e.deltaY < 0 ? BLUR_RADIUS_STEP_PX : -BLUR_RADIUS_STEP_PX),
    MIN_BLUR_RADIUS_PX,
    MAX_BLUR_RADIUS_PX
  );
  updatePreviewSize();
  if (lastPointerClientX !== null && lastPointerClientY !== null) {
    showPreviewAt(lastPointerClientX, lastPointerClientY);
  }
}

function onViewerClick(e) {
  if (!blurModeEnabled) return;
  if (!getCurrentScene() || !getSelectedImageName()) return;

  if (placementModeActive) {
    if (isInteractiveOverlayTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    createPendingMaskAt(e.clientX, e.clientY);
    return;
  }

  if (!addModeEnabled && !pendingMask && !isInteractiveOverlayTarget(e.target)) {
    clearEditingMask();
  }
}

export function updateBlurMasksForRenamedImage(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  if (!blurMasksByImage.has(oldName)) return;
  const list = blurMasksByImage.get(oldName);
  blurMasksByImage.delete(oldName);
  blurMasksByImage.set(newName, list);
  // Local cache update only; server DB uses pano IDs so rename does not require persistence.
  saveBlurMasksToStorage({ persistToServer: false });
}

export function cleanupBlurMasksForDeletedImages(validImageNames) {
  const validSet = new Set(validImageNames || []);
  let changed = false;
  blurMasksByImage.forEach((_, imageName) => {
    if (!validSet.has(imageName)) {
      blurMasksByImage.delete(imageName);
      changed = true;
    }
  });
  if (changed) {
    flushQueuedSave();
    saveBlurMasksToStorage();
    restoreBlurMasksForCurrentScene();
  }
}

export function initBlurMasks() {
  if (blurFeatureInitialized) return;
  if (!panoViewerEl || !actionPanelEl || !blurBtnEl || !blurAddBtnEl) return;
  blurFeatureInitialized = true;

  ensurePreviewElement();

  loadBlurMasksFromServer().catch(() => {
    loadBlurMasksFromStorage();
    restoreBlurMasksForCurrentScene();
  });

  blurBtnEl.addEventListener('click', () => {
    setBlurModeEnabled(!blurModeEnabled);
  });

  blurAddBtnEl.addEventListener('click', () => {
    if (!blurModeEnabled) return;
    setAddModeEnabled(!addModeEnabled);
  });

  panoViewerEl.addEventListener('pointermove', onViewerPointerMove);
  panoViewerEl.addEventListener('pointerleave', onViewerPointerLeave);
  panoViewerEl.addEventListener('click', onViewerClick, true);
  panoViewerEl.addEventListener('wheel', onViewerWheel, { passive: false });

  window.addEventListener('resize', () => {
    restoreBlurMasksForCurrentScene();
    if (pendingMask) {
      applyMaskSize(pendingMask.element, pendingMask.entry.radiusRatio);
    }
    updatePreviewSize();
  });

  registerOnSceneLoad(() => {
    destroyPendingMask();
    clearEditingMask();
    restoreBlurMasksForCurrentScene();
    setPlacementModeActive(addModeEnabled);
  });

  updateBlurModeUi();
}

export async function reloadBlurMasks() {
  try {
    destroyPendingMask();
    clearEditingMask();
    try {
      document.querySelectorAll(`.${BLUR_MASK_CLASS}`).forEach((el) => el.remove());
    } catch (e) {}
    blurMasksByImage.clear();
    await loadBlurMasksFromServer();
    restoreBlurMasksForCurrentScene();
    setPlacementModeActive(addModeEnabled);
  } catch (e) {
    console.warn('Could not reload blur masks from server', e);
    try {
      loadBlurMasksFromStorage();
      restoreBlurMasksForCurrentScene();
      setPlacementModeActive(addModeEnabled);
    } catch (err) {}
  }
}
