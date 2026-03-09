import { appendProjectParams, getFloorplanBase, getProjectId } from '../project-context.js';
import { loadPanorama, registerOnSceneLoad, getSelectedImageName } from '../marzipano-viewer.js';

const FLOORPLAN_HOTSPOTS_KEY = 'floorplan-hotspots';
const LAST_FLOORPLAN_KEY_PREFIX = 'marzipano-last-floorplan-';

// filename -> Array<{ id, x, y, linkTo }>
const floorplanHotspotsByFile = new Map();
let nextFloorplanHotspotId = 0;
let selectedFloorplan = null;
let selectedHotspotId = null;

let previewContainer = null;
let previewImg = null;
let previewHotspotLayer = null;
let modalOverlay = null;
let modalEl = null;
let modalImageWrap = null;
let modalImg = null;
let modalTitleEl = null;
let modalHotspotLayer = null;
let magnifierControls = null;
let magnifierToggleBtn = null;
let magnifierLevelsEl = null;
let magnifierLevelBtns = [];
let magnifierLens = null;
let floorList = null;

const MAGNIFIER_DEFAULT_LEVEL = 2;
const MAGNIFIER_LEVEL_OPTIONS = [2, 2.5];
const MAGNIFIER_LENS_DIAMETER = 180;

let magnifierEnabled = false;
let magnifierLevel = MAGNIFIER_DEFAULT_LEVEL;
let activeMagnifierPointerId = null;
let lastMagnifierClientX = null;
let lastMagnifierClientY = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hideMagnifierLens() {
  if (!magnifierLens) return;
  magnifierLens.classList.remove('visible');
}

function syncMagnifierLensImage() {
  if (!magnifierLens || !modalImg) return;
  const src = modalImg.currentSrc || modalImg.src || '';
  magnifierLens.style.backgroundImage = src ? `url("${src}")` : 'none';
}

function updateMagnifierLevelUi() {
  if (!magnifierLevelBtns.length) return;
  magnifierLevelBtns.forEach((btn) => {
    const level = Number(btn.getAttribute('data-magnifier-level'));
    const selected = level === magnifierLevel;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    btn.disabled = !magnifierEnabled;
  });
}

function setMagnifierLevel(level) {
  const numericLevel = Number(level);
  magnifierLevel = MAGNIFIER_LEVEL_OPTIONS.includes(numericLevel)
    ? numericLevel
    : MAGNIFIER_DEFAULT_LEVEL;
  updateMagnifierLevelUi();
  if (magnifierLens && magnifierLens.classList.contains('visible') && lastMagnifierClientX !== null && lastMagnifierClientY !== null) {
    updateMagnifierLens(lastMagnifierClientX, lastMagnifierClientY, { forceVisible: true });
  }
}

function setMagnifierEnabled(enabled) {
  magnifierEnabled = Boolean(enabled);
  if (magnifierToggleBtn) {
    magnifierToggleBtn.classList.toggle('active', magnifierEnabled);
    magnifierToggleBtn.setAttribute('aria-pressed', magnifierEnabled ? 'true' : 'false');
  }
  if (magnifierControls) {
    magnifierControls.classList.toggle('active', magnifierEnabled);
  }
  if (magnifierLevelsEl) {
    magnifierLevelsEl.classList.toggle('enabled', magnifierEnabled);
  }
  if (modalImg) {
    modalImg.classList.toggle('magnifier-active', magnifierEnabled);
  }
  if (modalHotspotLayer) {
    modalHotspotLayer.classList.toggle('floorplan-hotspots-hidden', magnifierEnabled);
  }
  if (!magnifierEnabled) {
    if (modalImg && activeMagnifierPointerId !== null) {
      try {
        modalImg.releasePointerCapture(activeMagnifierPointerId);
      } catch (err) {}
    }
    activeMagnifierPointerId = null;
    lastMagnifierClientX = null;
    lastMagnifierClientY = null;
    hideMagnifierLens();
  } else {
    syncMagnifierLensImage();
  }
  updateMagnifierLevelUi();
}

function resetMagnifierState() {
  setMagnifierLevel(MAGNIFIER_DEFAULT_LEVEL);
  setMagnifierEnabled(false);
}

function updateMagnifierLens(clientX, clientY, { forceVisible = false } = {}) {
  if (!magnifierEnabled || !magnifierLens || !modalImg || !modalImageWrap) return;
  const imgRect = modalImg.getBoundingClientRect();
  if (imgRect.width <= 0 || imgRect.height <= 0) {
    hideMagnifierLens();
    return;
  }

  const insideImage =
    clientX >= imgRect.left &&
    clientX <= imgRect.right &&
    clientY >= imgRect.top &&
    clientY <= imgRect.bottom;

  if (!insideImage && !forceVisible) {
    hideMagnifierLens();
    return;
  }

  const clampedX = clamp(clientX, imgRect.left, imgRect.right);
  const clampedY = clamp(clientY, imgRect.top, imgRect.bottom);
  lastMagnifierClientX = clampedX;
  lastMagnifierClientY = clampedY;

  const wrapRect = modalImageWrap.getBoundingClientRect();
  const lensRadius = MAGNIFIER_LENS_DIAMETER / 2;
  const xInImage = clampedX - imgRect.left;
  const yInImage = clampedY - imgRect.top;
  const bgX = -(xInImage * magnifierLevel - lensRadius);
  const bgY = -(yInImage * magnifierLevel - lensRadius);

  magnifierLens.style.left = `${clampedX - wrapRect.left}px`;
  magnifierLens.style.top = `${clampedY - wrapRect.top}px`;
  magnifierLens.style.backgroundSize = `${imgRect.width * magnifierLevel}px ${imgRect.height * magnifierLevel}px`;
  magnifierLens.style.backgroundPosition = `${bgX}px ${bgY}px`;
  magnifierLens.classList.add('visible');
}

function setPreviewVisible(visible) {
  if (!previewContainer) return;
  previewContainer.classList.toggle('visible', Boolean(visible));
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

function applyServerFloorplanHotspots(data) {
  if (!data || typeof data !== 'object') return;
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

async function loadFloorplanHotspotsFromServer() {
  try {
    const res = await fetch(appendProjectParams('/api/floorplan-hotspots'));
    if (!res.ok) return;
    const data = await res.json();
    applyServerFloorplanHotspots(data);
  } catch (e) {
    console.warn('Could not load floorplan hotspots from server', e);
  }
}

function ensurePreviewElements() {
  if (previewContainer) return;
  previewContainer = document.createElement('div');
  previewContainer.id = 'floorplan-preview';
  previewContainer.className = 'floorplan-preview';
  previewContainer.innerHTML = `
    <div class="floorplan-image-wrap">
      <img id="floorplan-preview-img" alt="Floor plan">
      <div class="floorplan-hotspot-layer" data-layer="rendered"></div>
    </div>
  `;
  const viewerWrap = document.getElementById('pano-viewer-wrap') || document.getElementById('pano-panel');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  } else {
    document.body.appendChild(previewContainer);
  }
  previewImg = previewContainer.querySelector('img');
  previewHotspotLayer = previewContainer.querySelector('.floorplan-hotspot-layer');

  setPreviewVisible(false);

  previewContainer.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.floorplan-hotspot-pin')) {
      return;
    }
    if (selectedFloorplan) {
      openModalFor(selectedFloorplan);
    }
  });
}

function ensureModalElements() {
  if (modalOverlay) return;
  modalOverlay = document.createElement('div');
  modalOverlay.id = 'floorplan-modal-overlay';
  modalOverlay.className = 'floorplan-modal-overlay floorplan-modal-overlay-client';
  modalOverlay.innerHTML = `
    <div class="floorplan-modal" role="dialog" aria-modal="true">
      <div class="floorplan-modal-header">
        <div class="floorplan-modal-title" id="floorplan-modal-title"></div>
      </div>
      <div class="floorplan-modal-body">
        <div class="floorplan-image-wrap">
          <img id="floorplan-modal-img" alt="Floor plan expanded">
          <div class="floorplan-hotspot-layer" data-layer="expanded"></div>
          <div class="floorplan-magnifier-lens" aria-hidden="true"></div>
        </div>
      </div>
      <div class="floorplan-magnifier-controls" aria-label="Floor plan magnifier controls">
        <div id="floorplan-magnifier-levels" class="floorplan-magnifier-levels" role="group" aria-label="Magnification level">
          <button type="button" data-magnifier-level="2">2x</button>
          <button type="button" data-magnifier-level="2.5">2.5x</button>
        </div>
        <button type="button" id="floorplan-magnifier-toggle" class="floorplan-magnifier-toggle" aria-label="Toggle floor plan magnifier" aria-pressed="false">
          <img src="assets/search.png" alt="" aria-hidden="true">
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  modalEl = modalOverlay.querySelector('.floorplan-modal');
  modalImageWrap = modalOverlay.querySelector('.floorplan-modal-body .floorplan-image-wrap');
  modalImg = modalOverlay.querySelector('#floorplan-modal-img');
  modalTitleEl = modalOverlay.querySelector('#floorplan-modal-title');
  modalHotspotLayer = modalOverlay.querySelector('.floorplan-hotspot-layer[data-layer="expanded"]');
  magnifierLens = modalOverlay.querySelector('.floorplan-magnifier-lens');
  magnifierControls = modalOverlay.querySelector('.floorplan-magnifier-controls');
  magnifierToggleBtn = modalOverlay.querySelector('#floorplan-magnifier-toggle');
  magnifierLevelsEl = modalOverlay.querySelector('#floorplan-magnifier-levels');
  magnifierLevelBtns = Array.from(modalOverlay.querySelectorAll('[data-magnifier-level]'));

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });

  if (modalImg) {
    modalImg.addEventListener('click', (e) => {
      if (magnifierEnabled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Clicking on empty floor plan area in client just ignores; hotspots handle their own clicks.
      e.stopPropagation();
    });
    modalImg.addEventListener('load', () => {
      syncMagnifierLensImage();
      hideMagnifierLens();
    });
    modalImg.addEventListener('pointerenter', (e) => {
      if (!magnifierEnabled || e.pointerType === 'touch') return;
      updateMagnifierLens(e.clientX, e.clientY);
    });
    modalImg.addEventListener('pointermove', (e) => {
      if (!magnifierEnabled) return;
      const forceVisible = activeMagnifierPointerId === e.pointerId;
      updateMagnifierLens(e.clientX, e.clientY, { forceVisible });
    });
    modalImg.addEventListener('pointerleave', (e) => {
      if (!magnifierEnabled) return;
      if (e.pointerType !== 'touch') {
        hideMagnifierLens();
      }
    });
    modalImg.addEventListener('pointerdown', (e) => {
      if (!magnifierEnabled) return;
      if (e.pointerType === 'touch') {
        activeMagnifierPointerId = e.pointerId;
        try {
          modalImg.setPointerCapture(e.pointerId);
        } catch (err) {}
        updateMagnifierLens(e.clientX, e.clientY, { forceVisible: true });
        e.preventDefault();
      }
    });
    modalImg.addEventListener('pointerup', (e) => {
      if (activeMagnifierPointerId !== e.pointerId) return;
      activeMagnifierPointerId = null;
      hideMagnifierLens();
      try {
        modalImg.releasePointerCapture(e.pointerId);
      } catch (err) {}
    });
    modalImg.addEventListener('pointercancel', (e) => {
      if (activeMagnifierPointerId !== e.pointerId) return;
      activeMagnifierPointerId = null;
      hideMagnifierLens();
      try {
        modalImg.releasePointerCapture(e.pointerId);
      } catch (err) {}
    });
  }

  if (magnifierToggleBtn) {
    magnifierToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMagnifierEnabled(!magnifierEnabled);
    });
  }

  magnifierLevelBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!magnifierEnabled) return;
      const level = Number(btn.getAttribute('data-magnifier-level'));
      setMagnifierLevel(level);
    });
  });

  if (modalEl) {
    modalEl.addEventListener('mouseleave', () => {
      hideMagnifierLens();
    });
  }

  resetMagnifierState();
}

function closeModal() {
  if (!modalOverlay) return;
  resetMagnifierState();
  modalOverlay.classList.remove('visible');
  document.body.classList.remove('floorplan-modal-open');
  setPreviewVisible(Boolean(selectedFloorplan));
}

function openModalFor(filename) {
  if (!filename) return;
  ensurePreviewElements();
  ensureModalElements();
  const base = getFloorplanBase();
  const src = `${base}/${encodeURIComponent(filename)}`;
  if (modalImg) {
    modalImg.src = src;
    modalImg.alt = filename;
  }
  if (modalTitleEl) {
    const dot = filename.lastIndexOf('.');
    const displayName = dot > 0 ? filename.substring(0, dot) : filename;
    modalTitleEl.textContent = displayName;
  }
  resetMagnifierState();
  syncMagnifierLensImage();
  // When entering Expanded Display, hide the Rendered Display (minimized preview).
  setPreviewVisible(false);
  modalOverlay.classList.add('visible');
  document.body.classList.add('floorplan-modal-open');
  renderFloorplanHotspots();
}

function showPreview(filename) {
  ensurePreviewElements();
  if (!previewImg) return;
  const base = getFloorplanBase();
  previewImg.src = `${base}/${encodeURIComponent(filename)}`;
  setPreviewVisible(true);
  renderRenderedHotspots();
}

function renderHotspotsToLayer(layerEl, { allowClickToPanorama, showTitle }) {
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
      dot.title = entry.linkTo ? `Go to ${entry.linkTo}` : 'Hotspot';
    }

    if (allowClickToPanorama && entry.linkTo) {
      dot.addEventListener('click', async (e) => {
        if (magnifierEnabled) return;
        e.stopPropagation();
        e.preventDefault();
        selectedHotspotId = entry.id;
        renderFloorplanHotspots();
        renderRenderedHotspots();
        closeModal();
        await loadPanorama(entry.linkTo);
      });
    }

    wrapper.appendChild(dot);
    layerEl.appendChild(wrapper);
  });
}

function renderFloorplanHotspots() {
  if (!modalHotspotLayer) return;
  renderHotspotsToLayer(modalHotspotLayer, { allowClickToPanorama: true, showTitle: true });
}

function renderRenderedHotspots() {
  if (!previewHotspotLayer) return;
  renderHotspotsToLayer(previewHotspotLayer, { allowClickToPanorama: true, showTitle: false });
}

function saveLastFloorplan(filename) {
  const pid = getProjectId();
  if (pid) {
    try {
      localStorage.setItem(LAST_FLOORPLAN_KEY_PREFIX + pid, filename);
    } catch (e) {}
  }
}

async function loadFloorplans() {
  if (!floorList) return;
  try {
    const res = await fetch(appendProjectParams('/api/floorplans'));
    if (!res.ok) return;
    const files = await res.json();
    floorList.innerHTML = '';
    files.forEach((filename) => {
      const li = document.createElement('li');
      const dotIndex = filename.lastIndexOf('.');
      const displayName = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
      li.textContent = displayName;
      li.dataset.filename = filename;
      li.draggable = false;
      li.onclick = () => {
        const name = li.dataset.filename;
        selectedFloorplan = name;
        Array.from(floorList.querySelectorAll('li')).forEach((node) => {
          node.classList.toggle('active', node === li);
        });
        showPreview(name);
        openModalFor(name);
      };
      floorList.appendChild(li);
    });
    if (!files || files.length === 0) {
      selectedFloorplan = null;
      setPreviewVisible(false);
      floorList.innerHTML = "<li class='active' style='text-align: center'>No floor plan uploaded</li>";
    }
  } catch (e) {
    console.error('Error loading client floorplans', e);
  }
}

export async function reloadFloorplanHotspotsClient() {
  await loadFloorplanHotspotsFromServer();
  renderFloorplanHotspots();
  renderRenderedHotspots();
}

export async function reloadFloorplansListClient() {
  await loadFloorplans();
}

export function initFloorplansClient() {
  const toggleBtn = document.getElementById('pano-floorplan-toggle');
  floorList = document.getElementById('pano-floorplan-list');

  if (!toggleBtn || !floorList) return;

  ensurePreviewElements();
  ensureModalElements();

  // Highlight hotspot when panorama loads in viewer
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

  toggleBtn.addEventListener('click', () => {
    const isVisible = floorList.style.display === 'block';
    floorList.style.display = isVisible ? 'none' : 'block';
  });

  // Show list by default on client; no preselection
  floorList.style.display = 'block';

  (async () => {
    loadFloorplanHotspotsFromStorage();
    await loadFloorplanHotspotsFromServer();
    await loadFloorplans();
  })();
}

