import Marzipano from "//cdn.skypack.dev/marzipano";
import { getUploadBase, getTilesBase, appendProjectParams, getProjectId } from './project-context.js';

const LAST_PANO_KEY_PREFIX = 'marzipano-last-pano-';

// --- constants ---
const MAX_FOV = 100 * Math.PI / 180;
const MIN_FOV = 30 * Math.PI / 180;
const FALLBACK_EQUIRECT_WIDTH = 4000;

// --- state ---
let viewer = null;
let currentScene = null;
let currentImagePath = null;
let selectedImageName = null;
let multiSelectedImageNames = new Set();
let lastMultiSelectIndex = null;
let deleteSelectionMode = false;
/** @type {Array<() => void>} Callbacks run when a scene has finished loading (after switchTo). */
let onSceneLoadCallbacks = [];
let projectName = null;

/**
 * Per-image initial views: imageName -> { yaw, pitch, fov }.
 * Loaded from and persisted to the server (and cached in localStorage)
 * so both admin and client can share the same starting views.
 */
let initialViewsByImage = {};
let initialViewsLoaded = false;
const INITIAL_VIEWS_STORAGE_KEY = 'marzipano-initial-views';

function loadInitialViewsFromStorage() {
  try {
    const raw = localStorage.getItem(INITIAL_VIEWS_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      initialViewsByImage = data;
    }
  } catch (e) {
    console.warn('Could not load initial views from localStorage', e);
  }
}

function saveInitialViewsToStorage() {
  try {
    localStorage.setItem(INITIAL_VIEWS_STORAGE_KEY, JSON.stringify(initialViewsByImage));
  } catch (e) {
    console.warn('Could not save initial views to localStorage', e);
  }
}

async function ensureInitialViewsLoaded() {
  if (initialViewsLoaded) return;
  // Try server first so views are shared across devices; fall back to localStorage on failure.
  try {
    const res = await fetch(appendProjectParams('/api/initial-views'));
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        initialViewsByImage = data;
        saveInitialViewsToStorage();
        initialViewsLoaded = true;
        return;
      }
    }
  } catch (e) {
    console.warn('Could not load initial views from server', e);
  }
  // Fallback path
  loadInitialViewsFromStorage();
  initialViewsLoaded = true;
}

const imageListEl = document.getElementById('pano-image-list');
const panoViewerEl = document.getElementById('pano-viewer');
const headerTextEl = document.getElementById('pano-header-text');
const headerEl = document.getElementById('pano-header');

function setListItemFilename(li, filename) {
  li.dataset.filename = filename;
  const nameEl = li.querySelector('.pano-item-name');
  if (nameEl) {
    nameEl.textContent = filename;
    nameEl.title = filename;
  }
}

function updateListItemActionIcons(li) {
  if (!li) return;
  const isActive = li.classList.contains('active');
  const iconByAction = {
    update: isActive ? 'assets/icons/update-w.png' : 'assets/icons/update.png',
    rename: isActive ? 'assets/icons/rename-w.png' : 'assets/icons/rename.png'
  };
  li.querySelectorAll('.pano-item-action-btn').forEach((btn) => {
    const action = btn.dataset.panoAction;
    const img = btn.querySelector('img');
    if (!img || !iconByAction[action]) return;
    img.src = iconByAction[action];
  });
}

function refreshAllListActionIcons() {
  document.querySelectorAll('#pano-image-list li').forEach((li) => updateListItemActionIcons(li));
}

function syncActiveHighlightForDeleteMode() {
  const items = Array.from(document.querySelectorAll('#pano-image-list li'));
  if (deleteSelectionMode) {
    items.forEach((li) => li.classList.remove('active'));
    refreshAllListActionIcons();
    return;
  }
  items.forEach((li) => {
    li.classList.toggle('active', Boolean(selectedImageName) && li.dataset.filename === selectedImageName);
  });
  refreshAllListActionIcons();
}

function syncMultiSelectionClasses() {
  document.querySelectorAll('#pano-image-list li').forEach((li) => {
    const selected = deleteSelectionMode && multiSelectedImageNames.has(li.dataset.filename);
    li.classList.toggle('multi-selected', selected);
  });
}

function updateHeaderText() {
  if (headerTextEl && headerEl) {
    headerTextEl.textContent = projectName || '';
    headerEl.style.display = projectName ? '' : 'none';
    if (projectName) document.body.classList.remove('no-pano-header');
    else document.body.classList.add('no-pano-header');
  }
}

// Initialize Marzipano viewer
export function initViewer() {
  if (!panoViewerEl) {
    console.error('#pano-viewer element not found');
    return null;
  }
  viewer = new Marzipano.Viewer(panoViewerEl);
  console.log('Marzipano viewer initialized');
  return viewer;
}

function saveLastPanorama(imageName) {
  const pid = getProjectId();
  if (pid && imageName) {
    try {
      localStorage.setItem(LAST_PANO_KEY_PREFIX + pid, imageName);
    } catch (e) {}
  }
}

// Load a panorama image into Marzipano (exported for hotspot links and list)
export async function loadPanorama(imageName) {
  const imagePath = `${getUploadBase()}/${imageName}`;
  if (selectedImageName === imageName) {
    try {
      document.dispatchEvent(new CustomEvent('pano:selected', { detail: { filename: imageName } }));
    } catch (e) {}
    // Same image already shown; list may have been rebuilt (e.g. after upload), so re-apply highlight
    document.querySelectorAll('#pano-image-list li').forEach(li => li.classList.remove('active'));
    const sameLi = Array.from(document.querySelectorAll('#pano-image-list li')).find(li => li.dataset.filename === imageName);
    if (sameLi) sameLi.classList.add('active');
    syncActiveHighlightForDeleteMode();
    return;
  }
  currentImagePath = imagePath;
  selectedImageName = imageName;
  try {
    document.dispatchEvent(new CustomEvent('pano:selected', { detail: { filename: imageName } }));
  } catch (e) {}
  saveLastPanorama(imageName);
  updateHeaderText();

  if (panoViewerEl && panoViewerEl.querySelector('.no-pano-msg')) {
    panoViewerEl.innerHTML = '';
  }

  if (!viewer) {
    viewer = initViewer();
    if (!viewer) {
      console.error('Viewer not initialized');
      return;
    }
  }

  // Prefer tiled multi-resolution cube tiles (generated server-side).
  // If tile meta fetch fails, fall back to non-tiled equirect.
  let source = null;
  let geometry = null;
  try {
    const res = await fetch(appendProjectParams(`/api/panos/${encodeURIComponent(imageName)}`));
    const meta = await res.json();
    if (!res.ok || !meta || !Array.isArray(meta.levels) || !meta.tileSize) {
      throw new Error(meta?.error || 'Invalid tile metadata');
    }
    const levels = meta.levels.map((size) => ({ tileSize: meta.tileSize, size }));
    geometry = new Marzipano.CubeGeometry(levels);
    source = Marzipano.ImageUrlSource.fromString(`${getTilesBase()}/${meta.id}/{z}/{f}/{y}/{x}.jpg`);
  } catch (e) {
    console.warn('Falling back to single-image pano:', e);
    source = Marzipano.ImageUrlSource.fromString(imagePath);
    geometry = new Marzipano.EquirectGeometry([{ width: FALLBACK_EQUIRECT_WIDTH }]);
  }
  // Make sure we have the latest initial view data before creating the scene
  await ensureInitialViewsLoaded();
  const limiter = Marzipano.RectilinearView.limit.traditional(MIN_FOV, MAX_FOV);
  // Use a saved initial view for this image if one exists; otherwise fall back to a centered view.
  const savedView = initialViewsByImage && initialViewsByImage[imageName];
  const initialParams = (savedView &&
    typeof savedView.yaw === 'number' &&
    typeof savedView.pitch === 'number' &&
    typeof savedView.fov === 'number')
    ? { yaw: savedView.yaw, pitch: savedView.pitch, fov: savedView.fov }
    : { yaw: 0, pitch: 0, fov: Math.PI / 2 };
  const view = new Marzipano.RectilinearView(initialParams, limiter);
  currentScene = viewer.createScene({ source, geometry, view });
  currentScene.switchTo();

  // Notify listeners (e.g. hotspot feature) so they can restore or attach to the new scene.
  onSceneLoadCallbacks.forEach((cb) => cb());

  // Update active state in list
  document.querySelectorAll('#pano-image-list li').forEach(li => {
    li.classList.remove('active');
  });
  const activeLi = Array.from(document.querySelectorAll('#pano-image-list li'))
    .find(li => li.dataset.filename === imageName);
  if (activeLi) {
    activeLi.classList.add('active');
  }
  syncActiveHighlightForDeleteMode();
}

// Load and display list of images
/** @param {(files: string[]) => void} [onImagesLoaded] Called with the list of image names after fetch. */
export async function loadImages(onImagesLoaded) {
  try {
    const res = await fetch(appendProjectParams("/api/panos"));
    const panos = await res.json();
    const fileList = Array.isArray(panos) ? panos.map(p => p.filename) : [];
    multiSelectedImageNames = new Set(
      Array.from(multiSelectedImageNames).filter((name) => fileList.includes(name))
    );
    if (lastMultiSelectIndex !== null && (lastMultiSelectIndex < 0 || lastMultiSelectIndex >= fileList.length)) {
      lastMultiSelectIndex = null;
    }
    // Ensure initial views are loaded once we know the project context is valid.
    await ensureInitialViewsLoaded();
    if (typeof onImagesLoaded === 'function') onImagesLoaded(fileList);

    imageListEl.innerHTML = "";

    // Detect admin context so drag/reorder is enabled only in admin UI
    const isAdmin = typeof window !== 'undefined' && /project-editor\.html$/i.test(window.location.pathname);

    if (fileList.length > 0) {
      // Admin: ensure viewer ready for immediate panorama loading
      // Client: do not auto-load any panorama; show guidance text instead
      if (panoViewerEl && panoViewerEl.querySelector('.no-pano-msg')) {
        panoViewerEl.innerHTML = '';
      }
      if (isAdmin) {
        if (!viewer) {
          viewer = initViewer();
          if (!viewer) {
            console.error('Viewer not initialized');
            return;
          }
        }
      } else {
        if (!viewer && panoViewerEl) {
          const isLayoutMode = document.body && document.body.classList && document.body.classList.contains('viewer-mode-layout');
          const label = isLayoutMode ? 'layout' : 'panorama';
          panoViewerEl.innerHTML = `<div class="no-pano-msg"><p>Select a ${label} from the list</p></div>`;
        }
      }
    }

    // Helper to create a draggable list item for an image
    function createImageListItem(filename) {
      const li = document.createElement('li');
      const nameEl = document.createElement('span');
      nameEl.className = 'pano-item-name';
      nameEl.textContent = filename;
      li.appendChild(nameEl);

      if (isAdmin) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'pano-item-actions';

        const actionButtons = [
          { action: 'update', icon: 'assets/icons/update.png', alt: 'Update' },
          { action: 'rename', icon: 'assets/icons/rename.png', alt: 'Rename' }
        ];

        actionButtons.forEach(({ action, icon, alt }) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `pano-item-action-btn pano-item-action-${action}`;
          btn.dataset.panoAction = action;
          btn.title = alt;
          btn.setAttribute('aria-label', alt);

          const iconEl = document.createElement('img');
          iconEl.src = icon;
          iconEl.alt = '';
          btn.appendChild(iconEl);

          actionsEl.appendChild(btn);
        });

        li.appendChild(actionsEl);
      }

      li.draggable = isAdmin;
      setListItemFilename(li, filename);
      if (multiSelectedImageNames.has(filename)) {
        li.classList.add('multi-selected');
      }
      updateListItemActionIcons(li);

      li.addEventListener('click', async (ev) => {
        if (ev.target.closest('.pano-item-actions')) return;

        if (!isAdmin) {
          await loadPanorama(li.dataset.filename);
          return;
        }

        const allItems = Array.from(document.querySelectorAll('#pano-image-list li'));
        const currentIndex = allItems.indexOf(li);
        const isRangeSelection = deleteSelectionMode && ev.shiftKey && lastMultiSelectIndex !== null;
        const isToggleSelection = deleteSelectionMode && !isRangeSelection;

        if (deleteSelectionMode) {
          if (isRangeSelection) {
            const start = Math.min(lastMultiSelectIndex, currentIndex);
            const end = Math.max(lastMultiSelectIndex, currentIndex);
            multiSelectedImageNames.clear();
            for (let i = start; i <= end; i += 1) {
              const filename = allItems[i]?.dataset?.filename;
              if (filename) multiSelectedImageNames.add(filename);
            }
            syncMultiSelectionClasses();
          } else if (isToggleSelection) {
            const filename = li.dataset.filename;
            if (multiSelectedImageNames.has(filename)) {
              multiSelectedImageNames.delete(filename);
            } else {
              multiSelectedImageNames.add(filename);
            }
            li.classList.toggle('multi-selected', multiSelectedImageNames.has(filename));
          }
          lastMultiSelectIndex = currentIndex;
          return;
        }

        multiSelectedImageNames.clear();
        syncMultiSelectionClasses();
        lastMultiSelectIndex = currentIndex;
        await loadPanorama(li.dataset.filename);
      });

      // Only enable drag/drop handlers in admin UI
      if (isAdmin) {
        li.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', li.dataset.filename);
          ev.dataTransfer.effectAllowed = 'move';
          li.classList.add('dragging');
        });

        li.addEventListener('dragend', () => {
          li.classList.remove('dragging');
          document.querySelectorAll('#pano-image-list li').forEach(x => x.classList.remove('drag-over'));
        });

        li.addEventListener('dragover', (ev) => {
          ev.preventDefault(); // allow drop
          ev.dataTransfer.dropEffect = 'move';
        });

        li.addEventListener('dragenter', () => {
          li.classList.add('drag-over');
        });

        li.addEventListener('dragleave', () => {
          li.classList.remove('drag-over');
        });

        li.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          li.classList.remove('drag-over');
          const sourceFilename = ev.dataTransfer.getData('text/plain');
          const targetFilename = li.dataset.filename;
          if (!sourceFilename || sourceFilename === targetFilename) return;

          // Find the two list items and swap their filenames
          const allItems = Array.from(document.querySelectorAll('#pano-image-list li'));
          const srcLi = allItems.find(x => x.dataset.filename === sourceFilename);
          const tgtLi = allItems.find(x => x.dataset.filename === targetFilename);
          if (!srcLi || !tgtLi) return;

          // Swap dataset and text
          const tmp = srcLi.dataset.filename;
          setListItemFilename(srcLi, tgtLi.dataset.filename);
          setListItemFilename(tgtLi, tmp);

          // Maintain active state if selection moved
          if (selectedImageName === sourceFilename) selectedImageName = targetFilename;
          else if (selectedImageName === targetFilename) selectedImageName = sourceFilename;
          syncMultiSelectionClasses();

          // Update visual active classes
          document.querySelectorAll('#pano-image-list li').forEach(li => li.classList.remove('active'));
          const activeLi = Array.from(document.querySelectorAll('#pano-image-list li'))
            .find(li => li.dataset.filename === selectedImageName);
          if (activeLi) activeLi.classList.add('active');
          refreshAllListActionIcons();

          // Persist new order to server
          try {
            const newOrder = Array.from(document.querySelectorAll('#pano-image-list li')).map(x => x.dataset.filename);
            const res = await fetch(appendProjectParams('/api/panos/order'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: newOrder })
            });
            if (!res.ok) {
              const txt = await res.text().catch(() => '');
              console.warn('Failed to persist panorama order, server responded:', res.status, txt);
              alert('Failed to save image order: ' + (txt || res.status));
            } else {
              console.log('Panorama order saved');
            }
          } catch (e) {
            console.warn('Failed to persist panorama order:', e);
            alert('Failed to save image order: ' + e.message);
          }
        });
      }

      return li;
    }

    fileList.forEach(file => {
      imageListEl.appendChild(createImageListItem(file));
    });

    if (fileList.length > 0) {
      if (isAdmin) {
        const lastSaved = (() => {
          const pid = getProjectId();
          if (!pid) return null;
          try {
            return localStorage.getItem(LAST_PANO_KEY_PREFIX + pid);
          } catch (e) {
            return null;
          }
        })();
        const imageToShow = (lastSaved && fileList.includes(lastSaved))
          ? lastSaved
          : (selectedImageName && fileList.includes(selectedImageName))
            ? selectedImageName
            : fileList[0];
        await loadPanorama(imageToShow);
      } else {
        const isViewerPanoMode = Boolean(
          document.body &&
          document.body.classList &&
          document.body.classList.contains('viewer-mode-panoramas')
        );
        if (isViewerPanoMode) {
          const lastSaved = (() => {
            const pid = getProjectId();
            if (!pid) return null;
            try {
              return localStorage.getItem(LAST_PANO_KEY_PREFIX + pid);
            } catch (e) {
              return null;
            }
          })();
          const imageToShow = (lastSaved && fileList.includes(lastSaved))
            ? lastSaved
            : (selectedImageName && fileList.includes(selectedImageName))
              ? selectedImageName
              : fileList[0];
          await loadPanorama(imageToShow);
        } else {
          // Client: do not auto-load any panorama; wait for hotspot selection
          // Do not alter viewer or clear its DOM to avoid black screen issues.
        }
      }
    } else {
      currentScene = null;
      currentImagePath = null;
      selectedImageName = null;
      multiSelectedImageNames.clear();
      lastMultiSelectIndex = null;
      viewer = null;
      updateHeaderText();
      try {
        document.dispatchEvent(new CustomEvent('pano:selected', { detail: { filename: null } }));
      } catch (e) {}
      if (panoViewerEl) {
        panoViewerEl.innerHTML = '<div class="no-pano-msg"><p>No panoramas. Upload one to get started.</p></div>';
        
        imageListEl.innerHTML = "<li class='active' style='text-align: center'>No images uploaded</li>"
      }
    }
  } catch (error) {
    alert('Error loading images: ' + error);
  }
}

export function getSelectedImageName() {
  return selectedImageName;
}

export function clearSelection() {
  currentImagePath = null;
  selectedImageName = null;
}

export function getMultiSelectedImageNames() {
  return Array.from(multiSelectedImageNames);
}

export function clearMultiSelection() {
  multiSelectedImageNames.clear();
  lastMultiSelectIndex = null;
  syncMultiSelectionClasses();
}

export function setDeleteSelectionMode(enabled) {
  deleteSelectionMode = !!enabled;
  if (!deleteSelectionMode) {
    multiSelectedImageNames.clear();
    lastMultiSelectIndex = null;
  }
  syncMultiSelectionClasses();
  syncActiveHighlightForDeleteMode();
}

export function isDeleteSelectionMode() {
  return deleteSelectionMode;
}

export function clearCurrentPath() {
  currentImagePath = null;
}

/** Return the Marzipano viewer instance (for hotspot container, etc.). */
export function getViewer() {
  return viewer;
}

/** Return the current scene (for hotspot container and view). */
export function getCurrentScene() {
  return currentScene;
}

/**
 * Return the current view parameters (yaw, pitch, fov) for the active scene, if any.
 */
export function getCurrentViewParams() {
  if (!currentScene) return null;
  const view = currentScene.view && currentScene.view();
  if (!view || typeof view.parameters !== 'function') return null;
  try {
    return view.parameters();
  } catch (e) {
    console.warn('Could not read current view parameters', e);
    return null;
  }
}

/**
 * Save the current view as the initial view for the selected image, persisting to the server.
 */
export async function saveInitialViewForCurrentImage() {
  if (!selectedImageName || !currentScene) {
    throw new Error('No panorama is currently selected');
  }
  await ensureInitialViewsLoaded();
  const params = getCurrentViewParams();
  if (!params) {
    throw new Error('Unable to read current view parameters');
  }
  initialViewsByImage[selectedImageName] = {
    yaw: params.yaw,
    pitch: params.pitch,
    fov: params.fov,
  };
  // Persist to localStorage immediately so refresh on this device keeps the view,
  // even if the server is temporarily unavailable.
  saveInitialViewsToStorage();
  const res = await fetch(appendProjectParams('/api/initial-views'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initialViewsByImage),
  });
  if (!res.ok) {
    throw new Error(`Server responded with ${res.status}`);
  }
}

/**
 * Update initial view when an image is renamed: move the saved view from oldName to newName.
 */
export function updateInitialViewForRenamedImage(oldName, newName) {
  if (!initialViewsByImage[oldName]) return;
  initialViewsByImage[newName] = initialViewsByImage[oldName];
  delete initialViewsByImage[oldName];
  saveInitialViewsToStorage();
  fetch(appendProjectParams('/api/initial-views'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initialViewsByImage),
  }).catch((e) => console.warn('Could not persist initial view rename to server', e));
}

/** Force-reload initial views from the server and reapply to the current scene. */
export async function reloadInitialViews() {
  initialViewsLoaded = false;
  try {
    await ensureInitialViewsLoaded();
    if (selectedImageName) {
      // Re-load current panorama to apply new initial view params
      await loadPanorama(selectedImageName);
    }
  } catch (e) {
    console.warn('Could not reload initial views', e);
  }
}

/** Register a callback to run when a new scene has finished loading. */
export function registerOnSceneLoad(callback) {
  if (typeof callback === 'function') {
    onSceneLoadCallbacks.push(callback);
  }
}

export function setProjectName(name) {
  projectName = typeof name === 'string' ? name : null;
  updateHeaderText();
}

/** Fetch and return the list of uploaded image file names. */
export async function getImageList() {
  const res = await fetch(appendProjectParams('/api/panos'));
  const panos = await res.json();
  return Array.isArray(panos) ? panos.map(p => p.filename) : [];
}
