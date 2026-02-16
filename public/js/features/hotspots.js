/**
 * Hotspot feature: place hotspots (with optional link to another image); each pin has a small remove icon beside it.
 */
import {
  getCurrentScene,
  getSelectedImageName,
  getImageList,
  loadPanorama,
  registerOnSceneLoad,
} from '../marzipano-viewer.js';
import { showSelectWithPreview, showAlert } from '../dialog.js';

const HOTSPOT_CLASS = 'app-hotspot-pin';
const HOTSPOT_REMOVE_CLASS = 'app-hotspot-remove';
const STORAGE_KEY = 'marzipano-hotspots';

const panoViewerEl = document.getElementById('pano-viewer');
const hotspotBtnEl = document.getElementById('pano-hotspot-btn');

/** Place mode: click on pano = add hotspot (then choose link). */
let placeMode = false;

let nextHotspotId = 0;

/**
 * Per-image storage: imageName -> Array<{ id, yaw, pitch, linkTo?, hotspot }>.
 * Persisted to localStorage (without hotspot) so hotspots survive refresh.
 */
const hotspotsByImage = new Map();

/** Serialize for storage: only id, yaw, pitch, linkTo (no DOM hotspot). */
function serializeHotspots() {
  const obj = {};
  hotspotsByImage.forEach((list, imageName) => {
    obj[imageName] = list.map((entry) => ({
      id: entry.id,
      yaw: entry.yaw,
      pitch: entry.pitch,
      linkTo: entry.linkTo,
    }));
  });
  return obj;
}

function saveHotspotsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeHotspots()));
  } catch (e) {
    console.warn('Could not save hotspots to localStorage', e);
  }
}

/** Load from localStorage and populate hotspotsByImage; set nextHotspotId. */
function loadHotspotsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
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
          linkTo: entry.linkTo || undefined,
          hotspot: null,
        };
      });
      hotspotsByImage.set(imageName, entries);
    });
    if (maxId >= 0) nextHotspotId = maxId + 1;
  } catch (e) {
    console.warn('Could not load hotspots from localStorage', e);
  }
}

/** Remove stored hotspots for image names that are no longer in the list (panorama deleted).
 *  Also remove any hotspot on other images that links to a deleted image (so image 1 shows no hotspot pointing to deleted image 2).
 */
export function cleanupHotspotsForDeletedImages(validImageNames) {
  const set = new Set(validImageNames);
  let changed = false;
  // Remove entire hotspot lists for deleted images
  hotspotsByImage.forEach((_, imageName) => {
    if (!set.has(imageName)) {
      hotspotsByImage.delete(imageName);
      changed = true;
    }
  });
  // Remove hotspots that link to a deleted image (e.g. on image 1, remove pins that linked to image 2)
  hotspotsByImage.forEach((list, imageName) => {
    const scene = getCurrentScene();
    const currentImageName = getSelectedImageName();
    const container = scene && currentImageName === imageName ? scene.hotspotContainer() : null;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.linkTo && !set.has(entry.linkTo)) {
        if (entry.hotspot && container && typeof container.hasHotspot === 'function' && container.hasHotspot(entry.hotspot)) {
          container.destroyHotspot(entry.hotspot);
        }
        list.splice(i, 1);
        changed = true;
      }
    }
  });
  if (changed) saveHotspotsToStorage();
}

export function initHotspots() {
  if (!panoViewerEl) return;

  loadHotspotsFromStorage();

  if (hotspotBtnEl) {
    hotspotBtnEl.addEventListener('click', togglePlaceMode);
  }
  registerOnSceneLoad(restoreHotspotsForCurrentScene);
}

function togglePlaceMode() {
  placeMode = !placeMode;
  if (placeMode) {
    panoViewerEl.addEventListener('click', onViewerClick, true);
    restoreHotspotsForCurrentScene();
  } else {
    panoViewerEl.removeEventListener('click', onViewerClick, true);
  }
  if (hotspotBtnEl) hotspotBtnEl.classList.toggle('active', placeMode);
  panoViewerEl.classList.toggle('app-hotspot-place-mode', placeMode);
}

function restoreHotspotsForCurrentScene() {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName) return;

  const container = scene.hotspotContainer();
  const list = hotspotsByImage.get(imageName);
  if (!list) return;

  list.forEach((entry) => {
    if (entry.hotspot && typeof container.hasHotspot === 'function' && container.hasHotspot(entry.hotspot)) {
      container.destroyHotspot(entry.hotspot);
    }
    const el = createHotspotElement(entry);
    entry.hotspot = container.createHotspot(el, { yaw: entry.yaw, pitch: entry.pitch });
    bindHotspotClick(el, entry, imageName);
  });
}

function createHotspotElement(entry) {
  const wrapper = document.createElement('div');
  wrapper.className = HOTSPOT_CLASS;
  wrapper.setAttribute('data-app-hotspot-id', String(entry.id));
  if (entry.linkTo) {
    wrapper.setAttribute('data-link-to', entry.linkTo);
  }
  wrapper.setAttribute('role', 'group');
  const label = entry.linkTo
    ? `Hotspot, links to ${entry.linkTo}, click to go there`
    : 'Hotspot marker';
  wrapper.setAttribute('aria-label', label);

  const pin = document.createElement('span');
  pin.className = 'app-hotspot-pin-dot';
  pin.setAttribute('role', 'button');
  pin.setAttribute('tabindex', '0');
  if (entry.linkTo) {
    pin.setAttribute('title', `Links to ${entry.linkTo} `);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = HOTSPOT_REMOVE_CLASS;
  removeBtn.setAttribute('aria-label', 'Remove hotspot');

  wrapper.appendChild(pin);
  wrapper.appendChild(removeBtn);
  return wrapper;
}

function bindHotspotClick(el, entry, imageName) {
  const pin = el.querySelector('.app-hotspot-pin-dot');
  const removeBtn = el.querySelector(`.${HOTSPOT_REMOVE_CLASS}`);

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    removeHotspot(entry, imageName);
  });

  if (pin) {
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (placeMode) {
        removeHotspot(entry, imageName);
        return;
      }
      if (entry.linkTo) {
        loadPanorama(`/upload/${entry.linkTo}`, entry.linkTo);
      }
    });
  }
}

function removeHotspot(entry, imageName) {
  const scene = getCurrentScene();
  if (!scene) return;
  const container = scene.hotspotContainer();
  if (entry.hotspot && container.hasHotspot && container.hasHotspot(entry.hotspot)) {
    container.destroyHotspot(entry.hotspot);
  }
  entry.hotspot = null;
  const list = hotspotsByImage.get(imageName) || [];
  const idx = list.indexOf(entry);
  if (idx !== -1) list.splice(idx, 1);
  saveHotspotsToStorage();
}

function getViewerRect() {
  return panoViewerEl ? panoViewerEl.getBoundingClientRect() : null;
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

async function addHotspotAt(clientX, clientY) {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName) return;

  const coords = screenToViewCoords(clientX, clientY);
  if (!coords) return;

  let linkTo = null;
  const originalPath = `/upload/${imageName}`;
  try {
    const imageList = await getImageList();
    const options = imageList.filter((name) => name !== imageName);
    if (options.length === 0) {
      await showAlert(
        'Hotspot links need at least 2 images. Upload another panorama to link between scenes.',
        'Hotspot link'
      );
      return;
    }
    const selected = await showSelectWithPreview(
      'Link hotspot to image',
      options,
      (val) => loadPanorama(`/upload/${val}`, val)
    );
    if (selected === null) {
      loadPanorama(originalPath, imageName);
      return;
    }
    linkTo = selected;
    loadPanorama(originalPath, imageName);
  } catch (err) {
    linkTo = undefined;
    loadPanorama(originalPath, imageName);
  }

  const container = scene.hotspotContainer();
  const id = nextHotspotId++;
  const entry = {
    id,
    yaw: coords.yaw,
    pitch: coords.pitch,
    linkTo: linkTo || undefined,
    hotspot: null,
  };
  const el = createHotspotElement(entry);
  entry.hotspot = container.createHotspot(el, { yaw: coords.yaw, pitch: coords.pitch });

  let list = hotspotsByImage.get(imageName);
  if (!list) {
    list = [];
    hotspotsByImage.set(imageName, list);
  }
  list.push(entry);
  bindHotspotClick(el, entry, imageName);
  saveHotspotsToStorage();
}

function isHotspotElement(target) {
  return target.closest && target.closest(`.${HOTSPOT_CLASS}`);
}

function onViewerClick(e) {
  if (!placeMode) return;
  if (!getCurrentScene()) return;
  if (isHotspotElement(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  addHotspotAt(e.clientX, e.clientY);
}
