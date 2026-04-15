/* Handles hotspot rendering and interaction in the client. */
/**
 * Client-only hotspots: display pins from server (or localStorage fallback) and navigate on click.
 * No place mode, no remove buttons. Admin saves to server so clients on any device can see hotspots.
 */
import {
  getCurrentScene,
  getSelectedImageName,
  loadPanorama,
  registerOnSceneLoad,
} from '../marzipano-viewer.js';
import { appendProjectParams } from '../project-context.js';

const HOTSPOT_CLASS = 'app-hotspot-pin';
const STORAGE_KEY = 'marzipano-hotspots';

/** imageName -> Array<{ id, yaw, pitch, linkTo? }> */
const hotspotsByImage = new Map();

/* Handles parse hotspots payload. */
function parseHotspotsPayload(obj) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.entries(obj).forEach(([imageName, list]) => {
    if (!Array.isArray(list)) return;
    hotspotsByImage.set(
      imageName,
      list.map((entry) => ({
        id: Number(entry.id),
        yaw: Number(entry.yaw),
        pitch: Number(entry.pitch),
        linkTo: entry.linkTo || undefined,
      }))
    );
  });
}

/* Gets load hotspots from local storage. */
function loadHotspotsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    parseHotspotsPayload(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not load hotspots from localStorage', e);
  }
}

/** Load hotspots from server; fall back to localStorage if fetch fails. Returns a Promise. */
async function loadHotspots() {
  hotspotsByImage.clear();
  try {
    const res = await fetch(appendProjectParams('/api/hotspots'));
    if (res.ok) {
      const data = await res.json();
      parseHotspotsPayload(data);
      return;
    }
  } catch (e) {
    console.warn('Could not load hotspots from server, using localStorage', e);
  }
  loadHotspotsFromLocalStorage();
}

/* Sets up create client hotspot element. */
function createClientHotspotElement(entry) {
  const wrapper = document.createElement('div');
  wrapper.className = HOTSPOT_CLASS;
  wrapper.setAttribute('data-app-hotspot-id', String(entry.id));
  if (entry.linkTo) {
    wrapper.setAttribute('data-link-to', entry.linkTo);
  }
  wrapper.setAttribute('role', 'group');
  const label = entry.linkTo
    ? `Go to ${entry.linkTo}`
    : 'Hotspot';
  wrapper.setAttribute('aria-label', label);

  const pin = document.createElement('span');
  pin.className = 'app-hotspot-pin-dot';
  pin.setAttribute('role', 'button');
  pin.setAttribute('tabindex', '0');

  wrapper.appendChild(pin);
  return wrapper;
}

/* Handles bind client hotspot click. */
function bindClientHotspotClick(el, entry) {
  if (!entry.linkTo) return;
  // Bind on the wrapper so the hotspot is easier to tap on mobile (larger hit target via CSS).
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    loadPanorama(entry.linkTo);
  });
}

/* Handles restore hotspots for current scene. */
function restoreHotspotsForCurrentScene() {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName) return;

  const container = scene.hotspotContainer();
  const list = hotspotsByImage.get(imageName);
  if (!list) return;

  list.forEach((entry) => {
    const el = createClientHotspotElement(entry);
    container.createHotspot(el, { yaw: entry.yaw, pitch: entry.pitch });
    bindClientHotspotClick(el, entry);
  });
}

/** Initialize client hotspots. Returns a Promise that resolves when hotspots are loaded (from server or localStorage). */
export async function initHotspotsClient() {
  await loadHotspots();
  registerOnSceneLoad(restoreHotspotsForCurrentScene);
}

/** Reload hotspots from server and apply to current scene (for realtime updates). */
export async function reloadHotspots() {
  try {
    // Remove any existing client hotspot DOM nodes to avoid duplicates
    document.querySelectorAll(`.${HOTSPOT_CLASS}`).forEach(el => el.remove());
  } catch (e) {}
  await loadHotspots();
  try { restoreHotspotsForCurrentScene(); } catch (e) {}
}
