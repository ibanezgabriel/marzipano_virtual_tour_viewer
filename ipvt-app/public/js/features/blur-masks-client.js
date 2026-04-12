import {
  getCurrentScene,
  getSelectedImageName,
  registerOnSceneLoad,
} from '../marzipano-viewer.js';
import { appendProjectParams } from '../project-context.js';

const BLUR_MASK_CLASS = 'app-blur-mask';
const BLUR_MASK_CORE_CLASS = 'app-blur-mask-core';
const BLUR_STORAGE_KEY = 'marzipano-blur-masks';
const MIN_BLUR_RADIUS_PX = 20;
const MAX_BLUR_RADIUS_PX = 200;

const panoViewerEl = document.getElementById('pano-viewer');
const blurMasksByImage = new Map();
let blurClientInitialized = false;

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

function parseBlurMasksPayload(obj) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.entries(obj).forEach(([imageName, list]) => {
    if (!Array.isArray(list)) return;
    blurMasksByImage.set(
      imageName,
      list.map((entry) => ({
        id: Number(entry.id),
        yaw: Number(entry.yaw),
        pitch: Number(entry.pitch),
        radiusRatio: clamp(Number(entry.radiusRatio) || 0.08, 0.01, 0.35),
        hotspot: null,
      }))
    );
  });
}

function loadBlurMasksFromLocalStorage() {
  try {
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    if (!raw) return;
    parseBlurMasksPayload(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not load blur masks from localStorage', e);
  }
}

async function loadBlurMasks() {
  blurMasksByImage.clear();
  try {
    const res = await fetch(appendProjectParams('/api/blur-masks'));
    if (res.ok) {
      const data = await res.json();
      parseBlurMasksPayload(data);
      return;
    }
  } catch (e) {
    console.warn('Could not load blur masks from server, using localStorage', e);
  }
  loadBlurMasksFromLocalStorage();
}

function createClientBlurMaskElement(entry) {
  const wrapper = document.createElement('div');
  wrapper.className = `${BLUR_MASK_CLASS} app-blur-mask-confirmed`;
  wrapper.setAttribute('data-app-blur-mask-id', String(entry.id));
  wrapper.setAttribute('aria-hidden', 'true');
  applyMaskSize(wrapper, entry.radiusRatio);

  const core = document.createElement('div');
  core.className = BLUR_MASK_CORE_CLASS;
  wrapper.appendChild(core);
  return wrapper;
}

function restoreBlurMasksForCurrentScene() {
  const scene = getCurrentScene();
  const imageName = getSelectedImageName();
  if (!scene || !imageName) return;
  const container = scene.hotspotContainer();
  const list = blurMasksByImage.get(imageName);
  if (!list) return;

  list.forEach((entry) => {
    if (
      entry.hotspot &&
      typeof container.hasHotspot === 'function' &&
      container.hasHotspot(entry.hotspot)
    ) {
      container.destroyHotspot(entry.hotspot);
    }
    const el = createClientBlurMaskElement(entry);
    entry.hotspot = container.createHotspot(el, { yaw: entry.yaw, pitch: entry.pitch });
  });
}

export async function initBlurMasksClient() {
  if (blurClientInitialized) return;
  if (!panoViewerEl) return;
  blurClientInitialized = true;
  await loadBlurMasks();
  registerOnSceneLoad(restoreBlurMasksForCurrentScene);
  window.addEventListener('resize', () => {
    try {
      document.querySelectorAll(`.${BLUR_MASK_CLASS}`).forEach((el) => {
        const id = Number(el.getAttribute('data-app-blur-mask-id'));
        const imageName = getSelectedImageName();
        const list = imageName ? blurMasksByImage.get(imageName) || [] : [];
        const match = list.find((entry) => entry.id === id);
        if (match) applyMaskSize(el, match.radiusRatio);
      });
    } catch (e) {}
  });
}

export async function reloadBlurMasksClient() {
  try {
    document.querySelectorAll(`.${BLUR_MASK_CLASS}`).forEach((el) => el.remove());
  } catch (e) {}
  await loadBlurMasks();
  try {
    restoreBlurMasksForCurrentScene();
  } catch (e) {}
}
