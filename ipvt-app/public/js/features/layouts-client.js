/* Handles layout previews and interactions in the viewer. */
import { appendProjectParams, getLayoutBase, getProjectId } from '../project-context.js';
import { loadPanorama, registerOnSceneLoad, getSelectedImageName } from '../marzipano-viewer.js';

const LAYOUT_HOTSPOTS_KEY = 'layout-hotspots';
const LEGACY_LAYOUT_HOTSPOTS_KEY = 'floorplan-hotspots';
const LAST_LAYOUT_KEY_PREFIX = 'marzipano-last-layout-';
const LEGACY_LAST_LAYOUT_KEY_PREFIX = 'marzipano-last-floorplan-';

// filename -> Array<{ id, x, y, linkTo }>
const layoutHotspotsByFile = new Map();
let nextLayoutHotspotId = 0;
let selectedLayout = null;
let selectedHotspotId = null;

let previewContainer = null;
let previewImg = null;
let previewHotspotLayer = null;
let modalOverlay = null;
let modalEl = null;
let modalImageWrap = null;
let modalStageEl = null;
let modalImg = null;
let modalTitleEl = null;
let modalHotspotLayer = null;
let magnifierControls = null;
let magnifierToggleBtn = null;
let magnifierLevelsEl = null;
let magnifierLevelBtns = [];
let magnifierLens = null;
let floorList = null;
let layoutFiles = [];
let layoutPrevBtn = null;
let layoutNextBtn = null;
let previewToggleBtn = null;
let previewCollapsed = false;

const MAGNIFIER_DEFAULT_LEVEL = 2;
const MAGNIFIER_LEVEL_OPTIONS = [2, 2.5];
const MAGNIFIER_LENS_DIAMETER = 180;

let magnifierEnabled = false;
let magnifierLevel = MAGNIFIER_DEFAULT_LEVEL;
let activeMagnifierPointerId = null;
let lastMagnifierClientX = null;
let lastMagnifierClientY = null;

/* Handles clamp. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* Cleans up hide magnifier lens. */
function hideMagnifierLens() {
  if (!magnifierLens) return;
  magnifierLens.classList.remove('visible');
}

/* Updates sync magnifier lens image. */
function syncMagnifierLensImage() {
  if (!magnifierLens || !modalImg) return;
  const src = modalImg.currentSrc || modalImg.src || '';
  magnifierLens.style.backgroundImage = src ? `url("${src}")` : 'none';
}

/* Updates update magnifier level ui. */
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

/* Updates set magnifier level. */
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

/* Updates set magnifier enabled. */
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
    modalHotspotLayer.classList.toggle('layout-hotspots-hidden', magnifierEnabled);
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

/* Handles reset magnifier state. */
function resetMagnifierState() {
  setMagnifierLevel(MAGNIFIER_DEFAULT_LEVEL);
  setMagnifierEnabled(false);
}

/* Gets get layout index. */
function getLayoutIndex(name) {
  if (!name) return -1;
  return layoutFiles.indexOf(name);
}

/* Updates update layout nav. */
function updateLayoutNav() {
  if (!layoutPrevBtn || !layoutNextBtn) return;
  const idx = getLayoutIndex(selectedLayout);
  const showNav = layoutFiles.length > 1;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < layoutFiles.length - 1;
  layoutPrevBtn.disabled = !hasPrev;
  layoutNextBtn.disabled = !hasNext;
  layoutPrevBtn.style.display = showNav ? 'inline-flex' : 'none';
  layoutNextBtn.style.display = showNav ? 'inline-flex' : 'none';
}

/* Updates set active layout. */
function setActiveLayout(filename) {
  if (!filename) return;
  selectedLayout = filename;
  if (floorList) {
    Array.from(floorList.querySelectorAll('li')).forEach((node) => {
      node.classList.toggle('active', node.dataset.filename === filename);
    });
  }
  showPreview(filename);
  updateLayoutNav();
}

/* Updates update magnifier lens. */
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

/* Updates set preview visible. */
function setPreviewVisible(visible) {
  if (!previewContainer) return;
  previewContainer.classList.toggle('visible', Boolean(visible));
}

/* Updates set preview collapsed. */
function setPreviewCollapsed(collapsed) {
  previewCollapsed = Boolean(collapsed);
  if (!previewContainer) return;
  previewContainer.classList.toggle('layout-preview-collapsed', previewCollapsed);
}

/* Handles is phone viewport. */
function isPhoneViewport() {
  try {
    return window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
  } catch (_e) {
    return false;
  }
}

/* Updates sync stage contain. */
function syncStageContain(imgEl, stageEl, containerEl) {
  if (!imgEl || !stageEl || !containerEl) return;
  const naturalW = Number(imgEl.naturalWidth || 0);
  const naturalH = Number(imgEl.naturalHeight || 0);
  if (!naturalW || !naturalH) return;
  const containerW = Math.max(0, containerEl.clientWidth || 0);
  const containerH = Math.max(0, containerEl.clientHeight || 0);
  if (!containerW || !containerH) return;

  const scale = Math.min(containerW / naturalW, containerH / naturalH);
  const renderedW = Math.max(1, Math.floor(naturalW * scale));
  const renderedH = Math.max(1, Math.floor(naturalH * scale));

  stageEl.style.width = `${renderedW}px`;
  stageEl.style.height = `${renderedH}px`;
}

/* Updates sync modal stage size. */
function syncModalStageSize() {
  if (!modalOverlay || !modalOverlay.classList.contains('visible')) return;
  syncStageContain(modalImg, modalStageEl, modalImageWrap);
}

/* Handles rerender hotspots for layout. */
function rerenderHotspotsForLayout() {
  try {
    if (modalOverlay && modalOverlay.classList.contains('visible')) {
      syncModalStageSize();
      renderLayoutHotspots();
    }
  } catch (e) {}
  try {
    if (previewContainer && previewContainer.classList.contains('visible')) renderRenderedHotspots();
  } catch (e) {}
}

/* Gets load layout hotspots from storage. */
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

/* Handles apply server layout hotspots. */
function applyServerLayoutHotspots(data) {
  if (!data || typeof data !== 'object') return;
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

/* Gets load layout hotspots from server. */
async function loadLayoutHotspotsFromServer() {
  try {
    const res = await fetch(appendProjectParams('/api/layout-hotspots'), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    applyServerLayoutHotspots(data);
  } catch (e) {
    console.warn('Could not load layout hotspots from server', e);
  }
}

/* Sets up ensure preview elements. */
function ensurePreviewElements() {
  if (previewContainer) return;
  previewContainer = document.createElement('div');
  previewContainer.id = 'layout-preview';
  previewContainer.className = 'layout-preview';
  previewContainer.innerHTML = `
    <div class="layout-image-wrap">
      <img id="layout-preview-img" alt="Layout">
      <div class="layout-hotspot-layer" data-layer="rendered"></div>
    </div>
  `;
  previewToggleBtn = document.createElement('button');
  previewToggleBtn.type = 'button';
  previewToggleBtn.className = 'layout-preview-toggle';
  previewToggleBtn.innerHTML = `<span class="arrow"></span>`;
  previewContainer.appendChild(previewToggleBtn);
  const viewerWrap = document.getElementById('pano-viewer-wrap') || document.getElementById('pano-panel');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  } else {
    document.body.appendChild(previewContainer);
  }
  previewImg = previewContainer.querySelector('img');
  previewHotspotLayer = previewContainer.querySelector('.layout-hotspot-layer');

  setPreviewVisible(false);
  setPreviewCollapsed(false);

  if (previewToggleBtn) {
    previewToggleBtn.addEventListener('click', (e) => {
      if (previewToggleBtn.dataset && previewToggleBtn.dataset.suppressClick) return;
      e.preventDefault();
      e.stopPropagation();
      setPreviewCollapsed(!previewCollapsed);
    });
  }

  // Swipe left on the preview to hide it (mobile/tablet).
  let swipePointerId = null;
  let swipeCaptureEl = null;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeMoved = false;
  previewContainer.addEventListener('pointerdown', (e) => {
    if (!e || e.pointerType !== 'touch') return;
    swipeCaptureEl = null;
    swipePointerId = e.pointerId;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
    swipeMoved = false;
    swipeCaptureEl = (previewToggleBtn && e.target === previewToggleBtn) ? previewToggleBtn : previewContainer;
    try {
      swipeCaptureEl.setPointerCapture(e.pointerId);
    } catch (_err) {}
  });
  previewContainer.addEventListener('pointermove', (e) => {
    if (swipePointerId !== e.pointerId) return;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    if (Math.abs(dx) < 18) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.25) return;
    swipeMoved = true;
    if (dx < -50) {
      setPreviewCollapsed(true);
      previewContainer.dataset.suppressNextClick = '1';
      if (previewToggleBtn && previewToggleBtn.dataset) previewToggleBtn.dataset.suppressClick = '1';
      setTimeout(() => {
        try { delete previewContainer.dataset.suppressNextClick; } catch (_e2) {}
        try { if (previewToggleBtn && previewToggleBtn.dataset) delete previewToggleBtn.dataset.suppressClick; } catch (_e3) {}
      }, 250);
      swipePointerId = null;
      try {
        (swipeCaptureEl || previewContainer).releasePointerCapture(e.pointerId);
      } catch (_err) {}
    } else if (dx > 50) {
      setPreviewCollapsed(false);
      previewContainer.dataset.suppressNextClick = '1';
      if (previewToggleBtn && previewToggleBtn.dataset) previewToggleBtn.dataset.suppressClick = '1';
      setTimeout(() => {
        try { delete previewContainer.dataset.suppressNextClick; } catch (_e2) {}
        try { if (previewToggleBtn && previewToggleBtn.dataset) delete previewToggleBtn.dataset.suppressClick; } catch (_e3) {}
      }, 250);
      swipePointerId = null;
      try {
        (swipeCaptureEl || previewContainer).releasePointerCapture(e.pointerId);
      } catch (_err) {}
    }
  });
  previewContainer.addEventListener('pointerup', (e) => {
    if (swipePointerId !== e.pointerId) return;
    swipePointerId = null;
    try {
      (swipeCaptureEl || previewContainer).releasePointerCapture(e.pointerId);
    } catch (_err) {}
    // If this was a swipe, prevent the "open modal" click right after.
    if (swipeMoved) {
      previewContainer.dataset.suppressNextClick = '1';
      if (previewToggleBtn && previewToggleBtn.dataset) previewToggleBtn.dataset.suppressClick = '1';
      setTimeout(() => {
        try { delete previewContainer.dataset.suppressNextClick; } catch (_e2) {}
        try { if (previewToggleBtn && previewToggleBtn.dataset) delete previewToggleBtn.dataset.suppressClick; } catch (_e3) {}
      }, 250);
    }
  });
  previewContainer.addEventListener('pointercancel', (e) => {
    if (swipePointerId !== e.pointerId) return;
    swipePointerId = null;
    try {
      (swipeCaptureEl || previewContainer).releasePointerCapture(e.pointerId);
    } catch (_err) {}
  });

  previewContainer.addEventListener('click', (e) => {
    if (previewContainer.dataset && previewContainer.dataset.suppressNextClick) return;
    if (previewCollapsed) return;
    if (e.target && e.target.closest && e.target.closest('.layout-hotspot-pin')) {
      return;
    }
    if (selectedLayout) {
      openModalFor(selectedLayout);
    }
  });
}

/* Sets up ensure modal elements. */
function ensureModalElements() {
  if (modalOverlay) return;
  modalOverlay = document.createElement('div');
  modalOverlay.id = 'layout-modal-overlay';
  modalOverlay.className = 'layout-modal-overlay layout-modal-overlay-client';
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
          <div class="layout-magnifier-lens" aria-hidden="true"></div>
        </div>
      </div>
      <div class="layout-modal-actions">
        <div class="layout-nav" aria-label="Layout navigation">
          <button type="button" id="layout-prev" class="layout-nav-btn layout-nav-btn-prev" aria-label="Previous layout">
            <img src="assets/icons/left-arrow.png" alt="" aria-hidden="true">
          </button>
          <button type="button" id="layout-next" class="layout-nav-btn layout-nav-btn-next" aria-label="Next layout">
            <img src="assets/icons/right-arrow.png" alt="" aria-hidden="true">
          </button>
        </div>
        <div class="layout-magnifier-controls" aria-label="Layout magnifier controls">
          <div id="layout-magnifier-levels" class="layout-magnifier-levels" role="group" aria-label="Magnification level">
            <button type="button" data-magnifier-level="2">2x</button>
            <button type="button" data-magnifier-level="2.5">2.5x</button>
          </div>
          <button type="button" id="layout-magnifier-toggle" class="layout-magnifier-toggle" aria-label="Toggle layout magnifier" aria-pressed="false">
            <img src="assets/search.png" alt="" aria-hidden="true">
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  modalEl = modalOverlay.querySelector('.layout-modal');
  modalImageWrap = modalOverlay.querySelector('.layout-modal-body .layout-image-wrap');
  modalStageEl = modalOverlay.querySelector('.layout-modal-body .layout-image-stage');
  modalImg = modalOverlay.querySelector('#layout-modal-img');
  modalTitleEl = modalOverlay.querySelector('#layout-modal-title');
  modalHotspotLayer = modalOverlay.querySelector('.layout-hotspot-layer[data-layer="expanded"]');
  magnifierLens = modalOverlay.querySelector('.layout-magnifier-lens');
  magnifierControls = modalOverlay.querySelector('.layout-magnifier-controls');
  magnifierToggleBtn = modalOverlay.querySelector('#layout-magnifier-toggle');
  magnifierLevelsEl = modalOverlay.querySelector('#layout-magnifier-levels');
  magnifierLevelBtns = Array.from(modalOverlay.querySelectorAll('[data-magnifier-level]'));
  layoutPrevBtn = modalOverlay.querySelector('#layout-prev');
  layoutNextBtn = modalOverlay.querySelector('#layout-next');

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) return closeModal();
    if (isPhoneViewport()) {
      // On phones: tapping anywhere closes (hotspot dots already close & navigate).
      if (e.target && e.target.closest && e.target.closest('.layout-hotspot-pin-dot')) return;
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
      if (isPhoneViewport()) {
        e.preventDefault();
        closeModal();
        return;
      }
      // Clicking on empty layout area in client just ignores; hotspots handle their own clicks.
      e.stopPropagation();
    });
    modalImg.addEventListener('load', () => {
      syncMagnifierLensImage();
      hideMagnifierLens();
      rerenderHotspotsForLayout();
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

  if (layoutPrevBtn) {
    layoutPrevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = getLayoutIndex(selectedLayout);
      if (idx > 0) {
        const target = layoutFiles[idx - 1];
        setActiveLayout(target);
        openModalFor(target);
      }
    });
  }

  if (layoutNextBtn) {
    layoutNextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = getLayoutIndex(selectedLayout);
      if (idx >= 0 && idx < layoutFiles.length - 1) {
        const target = layoutFiles[idx + 1];
        setActiveLayout(target);
        openModalFor(target);
      }
    });
  }

  if (modalEl) {
    modalEl.addEventListener('mouseleave', () => {
      hideMagnifierLens();
    });
  }

  window.addEventListener('resize', () => requestAnimationFrame(rerenderHotspotsForLayout));

  resetMagnifierState();
}

/* Cleans up close modal. */
function closeModal() {
  if (!modalOverlay) return;
  resetMagnifierState();
  modalOverlay.classList.remove('visible');
  document.body.classList.remove('layout-modal-open');
  setPreviewVisible(Boolean(selectedLayout));
}

/* Shows open modal for. */
function openModalFor(filename) {
  if (!filename) return;
  ensurePreviewElements();
  ensureModalElements();
  selectedLayout = filename;
  const base = getLayoutBase();
  const src = `${base}/${encodeURIComponent(filename)}`;
  if (modalImg) {
    modalImg.src = src;
    modalImg.alt = filename;
  }
  if (modalTitleEl) modalTitleEl.textContent = '';
  resetMagnifierState();
  syncMagnifierLensImage();
  // When entering Expanded Display, hide the Rendered Display (minimized preview).
  setPreviewVisible(false);
  modalOverlay.classList.add('visible');
  document.body.classList.add('layout-modal-open');
  updateLayoutNav();
  requestAnimationFrame(() => {
    rerenderHotspotsForLayout();
  });
}

/* Shows show preview. */
function showPreview(filename) {
  ensurePreviewElements();
  if (!previewImg) return;
  const base = getLayoutBase();
  previewImg.src = `${base}/${encodeURIComponent(filename)}`;
  setPreviewVisible(true);
  renderRenderedHotspots();
}

/* Shows render hotspots to layer. */
function renderHotspotsToLayer(layerEl, { allowClickToPanorama, showTitle, sizeClass }) {
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
    dot.className =
      'layout-hotspot-pin-dot' +
      (sizeClass ? ` ${sizeClass}` : '') +
      (selectedHotspotId === entry.id ? ' selected' : '');
    if (allowClickToPanorama && entry.linkTo) {
      dot.addEventListener('click', async (e) => {
        if (magnifierEnabled) return;
        e.stopPropagation();
        e.preventDefault();
        selectedHotspotId = entry.id;
        renderLayoutHotspots();
        renderRenderedHotspots();
        closeModal();
        await loadPanorama(entry.linkTo);
      });
    }

    wrapper.appendChild(dot);
    layerEl.appendChild(wrapper);
  });
}

/* Shows render layout hotspots. */
function renderLayoutHotspots() {
  if (!modalHotspotLayer) return;
  renderHotspotsToLayer(modalHotspotLayer, {
    allowClickToPanorama: true,
    showTitle: false,
    sizeClass: 'hotspot-modal',
  });
}

/* Shows render rendered hotspots. */
function renderRenderedHotspots() {
  if (!previewHotspotLayer) return;
  renderHotspotsToLayer(previewHotspotLayer, {
    allowClickToPanorama: true,
    showTitle: false,
    sizeClass: 'hotspot-preview',
  });
}

/* Updates save last layout. */
function saveLastLayout(filename) {
  const pid = getProjectId();
  if (pid) {
    try {
      localStorage.setItem(LAST_LAYOUT_KEY_PREFIX + pid, filename);
    } catch (e) {}
  }
}

/* Gets load layouts. */
async function loadLayouts() {
  if (!floorList) return;
  try {
    const res = await fetch(appendProjectParams('/api/layouts'));
    if (!res.ok) return;
    const files = await res.json();
    layoutFiles = Array.isArray(files) ? files.slice() : [];
    floorList.innerHTML = '';
    files.forEach((filename) => {
      const li = document.createElement('li');
      const dotIndex = filename.lastIndexOf('.');
      const displayName = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
      li.textContent = displayName;
      li.dataset.filename = filename;
      li.title = filename;
      li.draggable = false;
      li.onclick = () => {
        const name = li.dataset.filename;
        setActiveLayout(name);
        openModalFor(name);
      };
      floorList.appendChild(li);
    });
    if (files.length > 0 && !selectedLayout) {
      const firstFile = files[0];
      setActiveLayout(firstFile);
      openModalFor(firstFile);
    }
    if (!files || files.length === 0) {
      layoutFiles = [];
      selectedLayout = null;
      setPreviewVisible(false);
      updateLayoutNav();
      floorList.innerHTML = "<li class='active' style='text-align: center'>No layout uploaded</li>";
    }
  } catch (e) {
    console.error('Error loading client layouts', e);
  }
}

export async function reloadLayoutHotspotsClient() {
  await loadLayoutHotspotsFromServer();
  rerenderHotspotsForLayout();
}

export async function reloadLayoutsListClient() {
  await loadLayouts();
}

export function initLayoutsClient() {
  const toggleBtn = document.getElementById('pano-layout-toggle');
  floorList = document.getElementById('pano-layout-list');
  const sidebarContainer = document.getElementById('pano-sidebar-container');

  if (!toggleBtn || !floorList || !sidebarContainer) return;

  ensurePreviewElements();
  ensureModalElements();

  // Highlight hotspot when panorama loads in viewer
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

  const isMobileLayoutListViewport = () => {
    try {
      return window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    } catch (_e) {
      return false;
    }
  };

  let viewMode = null;
  try {
    const fromData = document.body && document.body.dataset ? (document.body.dataset.viewMode || '') : '';
    const normalized = String(fromData || '').trim().toLowerCase();
    if (normalized === 'layout' || normalized === 'panoramas') {
      viewMode = normalized;
    }
  } catch (_e) {}
  if (!viewMode) {
    try {
      const path = (window.location.pathname || '').toLowerCase();
      if (path.endsWith('project-viewer-layout.html')) viewMode = 'layout';
      if (path.endsWith('project-viewer-panoramas.html')) viewMode = 'panoramas';
    } catch (_e) {}
  }
  if (!viewMode) {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const rawView = (params.get('view') || '').trim().toLowerCase();
      if (rawView === 'layout' || rawView === 'panoramas') {
        viewMode = rawView;
      }
    } catch (_e) {}
  }

  let lastIsMobileLayoutListViewport = isMobileLayoutListViewport();
  let layoutListOpen = !lastIsMobileLayoutListViewport;
  if (viewMode === 'layout') layoutListOpen = true;
  if (viewMode === 'panoramas') layoutListOpen = false;

  const applyViewMode = (nextMode) => {
    if (nextMode !== 'layout' && nextMode !== 'panoramas' && nextMode !== null) return;
    viewMode = nextMode;
    if (viewMode === 'layout') layoutListOpen = true;
    if (viewMode === 'panoramas') layoutListOpen = false;
    if (viewMode === null) layoutListOpen = !lastIsMobileLayoutListViewport;
    syncLayoutListState();
  };

  const syncLayoutListState = () => {
    sidebarContainer.classList.toggle('layout-list-open', layoutListOpen);
    toggleBtn.setAttribute('aria-expanded', layoutListOpen ? 'true' : 'false');
    toggleBtn.setAttribute('aria-controls', 'pano-layout-list');
  };

  const setLayoutListOpen = (nextOpen) => {
    layoutListOpen = Boolean(nextOpen);
    syncLayoutListState();
  };

  const toggleLayoutList = () => setLayoutListOpen(!layoutListOpen);

  // Tap toggles list.
  toggleBtn.addEventListener('click', (e) => {
    if (toggleBtn.dataset && toggleBtn.dataset.suppressClick) return;
    e.preventDefault();
    toggleLayoutList();
  });

  // Swipe right/left on the Layout button (mobile) to open/close.
  let listSwipePointerId = null;
  let listSwipeStartX = 0;
  let listSwipeStartY = 0;
  let listSwipeMoved = false;

  toggleBtn.addEventListener('pointerdown', (e) => {
    if (!e || e.pointerType !== 'touch') return;
    if (!isMobileLayoutListViewport()) return;
    listSwipePointerId = e.pointerId;
    listSwipeStartX = e.clientX;
    listSwipeStartY = e.clientY;
    listSwipeMoved = false;
    try {
      toggleBtn.setPointerCapture(e.pointerId);
    } catch (_err) {}
  });

  toggleBtn.addEventListener('pointermove', (e) => {
    if (listSwipePointerId !== e.pointerId) return;
    const dx = e.clientX - listSwipeStartX;
    const dy = e.clientY - listSwipeStartY;
    if (Math.abs(dx) < 18) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.25) return;
    listSwipeMoved = true;
    if (dx > 50) {
      setLayoutListOpen(true);
      listSwipePointerId = null;
      try { toggleBtn.releasePointerCapture(e.pointerId); } catch (_err) {}
    } else if (dx < -50) {
      setLayoutListOpen(false);
      listSwipePointerId = null;
      try { toggleBtn.releasePointerCapture(e.pointerId); } catch (_err) {}
    }
  });

  toggleBtn.addEventListener('pointerup', (e) => {
    if (listSwipePointerId !== e.pointerId) return;
    listSwipePointerId = null;
    try { toggleBtn.releasePointerCapture(e.pointerId); } catch (_err) {}
    if (listSwipeMoved) {
      if (toggleBtn.dataset) toggleBtn.dataset.suppressClick = '1';
      setTimeout(() => {
        try { if (toggleBtn.dataset) delete toggleBtn.dataset.suppressClick; } catch (_e2) {}
      }, 250);
    }
  });

  toggleBtn.addEventListener('pointercancel', (e) => {
    if (listSwipePointerId !== e.pointerId) return;
    listSwipePointerId = null;
    try { toggleBtn.releasePointerCapture(e.pointerId); } catch (_err) {}
  });

  // Default: open on desktop, closed on mobile.
  syncLayoutListState();
  window.addEventListener('resize', () => {
    if (viewMode) return;
    const isMobile = isMobileLayoutListViewport();
    if (isMobile === lastIsMobileLayoutListViewport) return;
    lastIsMobileLayoutListViewport = isMobile;
    setLayoutListOpen(!isMobile);
  });

  document.addEventListener('viewer:viewmode', (ev) => {
    const mode = ev && ev.detail && ev.detail.mode ? String(ev.detail.mode).toLowerCase() : null;
    if (mode !== 'layout' && mode !== 'panoramas') {
      applyViewMode(null);
      return;
    }
    applyViewMode(mode);
  });

  (async () => {
    loadLayoutHotspotsFromStorage();
    await loadLayoutHotspotsFromServer();
    await loadLayouts();
  })();
}
