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
let modalImg = null;
let modalTitleEl = null;
let modalHotspotLayer = null;
let floorList = null;

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

  previewContainer.style.display = 'none';

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
    </div>
  `;
  document.body.appendChild(modalOverlay);

  modalImg = modalOverlay.querySelector('#floorplan-modal-img');
  modalTitleEl = modalOverlay.querySelector('#floorplan-modal-title');
  modalHotspotLayer = modalOverlay.querySelector('.floorplan-hotspot-layer[data-layer="expanded"]');

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });

  if (modalImg) {
    modalImg.addEventListener('click', (e) => {
      // Clicking on empty floor plan area in client just ignores; hotspots handle their own clicks.
      e.stopPropagation();
    });
  }
}

function closeModal() {
  if (!modalOverlay) return;
  modalOverlay.classList.remove('visible');
  document.body.classList.remove('floorplan-modal-open');
  if (previewContainer) {
    previewContainer.style.display = selectedFloorplan ? 'block' : 'none';
  }
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
  // When entering Expanded Display, hide the Rendered Display (minimized preview).
  if (previewContainer) {
    previewContainer.style.display = 'none';
  }
  modalOverlay.classList.add('visible');
  document.body.classList.add('floorplan-modal-open');
  renderFloorplanHotspots();
}

function showPreview(filename) {
  ensurePreviewElements();
  if (!previewImg) return;
  const base = getFloorplanBase();
  previewImg.src = `${base}/${encodeURIComponent(filename)}`;
  previewContainer.style.display = 'block';
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
      if (previewContainer) previewContainer.style.display = 'none';
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

