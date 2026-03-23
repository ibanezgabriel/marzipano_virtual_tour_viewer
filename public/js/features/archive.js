import Marzipano from "//cdn.skypack.dev/marzipano";
import { appendProjectParams, getUploadBase, getFloorplanBase } from '../project-context.js';
import { getSelectedImageName } from '../marzipano-viewer.js';
import { showAlert } from '../dialog.js';

const ARCHIVE_MAX_FOV = 100 * Math.PI / 180;
const ARCHIVE_MIN_FOV = 30 * Math.PI / 180;
const ARCHIVE_EQUIRECT_WIDTH = 4000;
const ARCHIVE_SOURCE_READY_TIMEOUT_MS = 30000;
const ARCHIVE_SOURCE_PROBE_TIMEOUT_MS = 12000;
const ARCHIVE_SOURCE_RETRY_DELAY_MS = 700;
const ARCHIVE_LOADING_MIN_VISIBLE_MS = 220;

function selectEl(id) {
  return document.getElementById(id);
}

function isArchiveTabActive() {
  const tab = selectEl('pano-archive');
  return Boolean(tab && tab.classList.contains('active-tab'));
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function getActiveFloorplanFromDom() {
  const li = document.querySelector('#pano-floorplan-list li.active[data-filename]');
  return li && li.dataset ? li.dataset.filename : null;
}

function parseArchiveFetchError(res, text) {
  if (res.status === 404 && /Cannot GET\s+\/api\/archive\//i.test(text || '')) {
    return 'Archive API is unavailable on the running server. Please restart the server to load the latest routes.';
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    }
  } catch (e) {}

  if (typeof text === 'string' && text.trim()) {
    const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/i);
    const htmlMessage = (preMatch ? preMatch[1] : text).replace(/\s+/g, ' ').trim();
    if (htmlMessage) return htmlMessage;
  }

  return `Server responded with ${res.status}`;
}

function createArchiveImageUrl(kind, storedFilename) {
  const safeKind = kind === 'floorplan' ? 'floorplan' : 'pano';
  return appendProjectParams(`/api/archive/images/${safeKind}/${encodeURIComponent(storedFilename)}`);
}

function createLiveImageUrl(kind, filename) {
  if (!filename) return null;
  const base = kind === 'floorplan' ? getFloorplanBase() : getUploadBase();
  return `${base}/${encodeURIComponent(filename)}`;
}

function parseRenamedFilenamesFromMessage(message) {
  const text = String(message || '');
  const match = text.match(/renamed\s+from\s+"([^"]+)"\s+to\s+"([^"]+)"/i);
  if (!match) return null;
  const oldFilename = match[1] ? match[1].trim() : '';
  const newFilename = match[2] ? match[2].trim() : '';
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

function parseReplacedFilenamesFromMessage(message) {
  const text = String(message || '');
  const match = text.match(/replaced\s+"([^"]+)"\s+with\s+"([^"]+)"/i);
  if (!match) return null;
  const oldFilename = match[1] ? match[1].trim() : '';
  const newFilename = match[2] ? match[2].trim() : '';
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

function createLiveFilenameResolver(entries) {
  const renameMap = new Map();
  const ordered = Array.isArray(entries)
    ? entries
        .slice()
        .sort((a, b) => new Date(a && a.ts ? a.ts : 0).getTime() - new Date(b && b.ts ? b.ts : 0).getTime())
    : [];

  ordered.forEach((entry) => {
    const rename = parseRenamedFilenamesFromMessage(entry && entry.message);
    if (rename) renameMap.set(rename.oldFilename, rename.newFilename);
  });

  return function resolveLiveFilename(filename) {
    let current = String(filename || '').trim();
    if (!current) return current;
    const seen = new Set();
    while (renameMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = renameMap.get(current);
    }
    return current;
  };
}

function createArchivedImageResolver(entries, defaultKind) {
  const archiveMap = new Map();
  const fallbackKind = defaultKind === 'floorplan' ? 'floorplan' : 'pano';
  const ordered = Array.isArray(entries)
    ? entries
        .slice()
        .sort((a, b) => new Date(a && a.ts ? a.ts : 0).getTime() - new Date(b && b.ts ? b.ts : 0).getTime())
    : [];

  ordered.forEach((entry) => {
    const replaced = parseReplacedFilenamesFromMessage(entry && entry.message);
    if (!replaced) return;
    const archived = entry && entry.meta && entry.meta.archivedImage;
    if (!archived || !archived.storedFilename) return;
    const kind = archived.kind === 'floorplan' ? 'floorplan' : fallbackKind;
    const originalFilename = String(archived.originalFilename || replaced.oldFilename || '').trim();
    const storedFilename = String(archived.storedFilename || '').trim();
    if (!storedFilename) return;

    const payload = { kind, storedFilename, originalFilename };
    archiveMap.set(replaced.oldFilename, payload);
    if (originalFilename) archiveMap.set(originalFilename, payload);
  });

  return function resolveArchivedImage(filename) {
    const key = String(filename || '').trim();
    if (!key) return null;
    return archiveMap.get(key) || null;
  };
}

function withCacheBust(url) {
  const separator = String(url || '').includes('?') ? '&' : '?';
  return `${url}${separator}archiveReady=${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

async function waitForMinimumLoadingDuration(startedAtMs, minDurationMs = ARCHIVE_LOADING_MIN_VISIBLE_MS) {
  const elapsed = Date.now() - startedAtMs;
  const remaining = minDurationMs - elapsed;
  if (remaining > 0) {
    await sleep(remaining);
  }
}

function makeSourceProbeError(message, permanent = false) {
  const error = new Error(message);
  error.permanent = Boolean(permanent);
  return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = ARCHIVE_SOURCE_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw makeSourceProbeError('Timed out while checking image source.');
    }
    throw makeSourceProbeError('Could not reach image source.');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function throwForProbeStatus(status) {
  if (status === 404) {
    throw makeSourceProbeError('Archived image file was not found.', true);
  }
  if (status === 400 || status === 403) {
    throw makeSourceProbeError('Archived image request was rejected.', true);
  }
  throw makeSourceProbeError(`Image source check failed (${status}).`);
}

async function probeArchiveImageSource(imageUrl, timeoutMs = ARCHIVE_SOURCE_PROBE_TIMEOUT_MS) {
  const probeUrl = withCacheBust(imageUrl);
  const headRes = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, timeoutMs);
  if (headRes.ok) return probeUrl;
  if (headRes.status === 400 || headRes.status === 403) {
    throwForProbeStatus(headRes.status);
  }

  // Fallback to GET when HEAD fails or is not allowed by the server/proxy.
  // Some environments return 404 for HEAD even when GET is valid.
  const getRes = await fetchWithTimeout(
    probeUrl,
    {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    },
    timeoutMs
  );
  if (getRes.ok || getRes.status === 206) return probeUrl;
  throwForProbeStatus(getRes.status);
}

async function waitForArchiveImageSource(imageUrl, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : ARCHIVE_SOURCE_READY_TIMEOUT_MS;
  const retryDelayMs = Number(opts.retryDelayMs) >= 0 ? Number(opts.retryDelayMs) : ARCHIVE_SOURCE_RETRY_DELAY_MS;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await probeArchiveImageSource(imageUrl);
    } catch (error) {
      lastError = error;
      if (error && error.permanent) break;
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error('Image source is still not ready.');
}

async function resolveArchiveImageSourceUrl(primaryUrl, fallbackUrls = []) {
  const candidates = [primaryUrl, ...fallbackUrls]
    .map((url) => String(url || '').trim())
    .filter(Boolean);

  const uniqueCandidates = [];
  const seen = new Set();
  candidates.forEach((url) => {
    if (seen.has(url)) return;
    seen.add(url);
    uniqueCandidates.push(url);
  });

  let lastError = null;
  for (const candidate of uniqueCandidates) {
    try {
      return await waitForArchiveImageSource(candidate);
    } catch (error) {
      lastError = error;
      // Keep trying every candidate (archive/live variants) before failing.
    }
  }

  throw lastError || new Error('Image source is unavailable.');
}

function createArchiveLoadingScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'archive-source-loading-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="archive-source-loading-box" role="status" aria-live="polite">
      <div class="archive-source-loading-spinner" aria-hidden="true"></div>
      <div class="archive-source-loading-text">Preparing image...</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const textEl = overlay.querySelector('.archive-source-loading-text');

  function show(message) {
    if (textEl && typeof message === 'string' && message.trim()) {
      textEl.textContent = message.trim();
    }
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hide() {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
  }

  return { show, hide };
}

function createArchiveViewerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'archive-viewer-modal-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="archive-viewer-modal" role="dialog" aria-modal="true" aria-label="Archive image viewer">
      <div class="archive-viewer-modal-header">
        <div class="archive-viewer-modal-title"></div>
        <button type="button" class="archive-viewer-close" aria-label="Close">Close</button>
      </div>
      <div class="archive-viewer-modal-body">
        <div class="archive-viewer-pano"></div>
        <img class="archive-viewer-image" alt="Archived image" />
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleEl = overlay.querySelector('.archive-viewer-modal-title');
  const closeBtn = overlay.querySelector('.archive-viewer-close');
  const paneEl = overlay.querySelector('.archive-viewer-pano');
  const imgEl = overlay.querySelector('.archive-viewer-image');

  let panoViewer = null;

  function resetPanoSurface() {
    paneEl.classList.remove('visible');
    paneEl.textContent = '';
    panoViewer = null;
  }

  function ensurePanoViewer() {
    if (!panoViewer) {
      panoViewer = new Marzipano.Viewer(paneEl);
    }
    return panoViewer;
  }

  function close() {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    imgEl.classList.remove('visible');
    imgEl.removeAttribute('src');
    resetPanoSurface();
  }

  function open({ kind, title, imageUrl }) {
    if (!imageUrl) return;
    titleEl.textContent = title || 'Archived image';
    // Clear any previous content so old media never flashes before the new source renders.
    imgEl.classList.remove('visible');
    imgEl.removeAttribute('src');
    resetPanoSurface();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');

    if (kind === 'pano') {
      paneEl.classList.add('visible');
      imgEl.classList.remove('visible');
      try {
        const viewer = ensurePanoViewer();
        const source = Marzipano.ImageUrlSource.fromString(imageUrl);
        const geometry = new Marzipano.EquirectGeometry([{ width: ARCHIVE_EQUIRECT_WIDTH }]);
        const limiter = Marzipano.RectilinearView.limit.traditional(ARCHIVE_MIN_FOV, ARCHIVE_MAX_FOV);
        const view = new Marzipano.RectilinearView({ yaw: 0, pitch: 0, fov: Math.PI / 2 }, limiter);
        const scene = viewer.createScene({ source, geometry, view });
        scene.switchTo();
      } catch (e) {
        paneEl.classList.remove('visible');
        imgEl.classList.add('visible');
        imgEl.src = imageUrl;
      }
      return;
    }

    paneEl.classList.remove('visible');
    imgEl.classList.add('visible');
    imgEl.src = imageUrl;
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overlay.classList.contains('visible')) {
      close();
    }
  });

  return { open, close };
}

export const archiveApi = {
  setTarget(_kind, _filename) {},
  refreshNow() {},
  refreshIfVisible() {},
};

export function initArchive() {
  const archiveTab = selectEl('pano-archive');
  const archivePanel = selectEl('pano-archive-panel');
  const targetEl = selectEl('pano-archive-target');
  const listEl = selectEl('pano-archive-list');

  if (!archiveTab || !archivePanel || !targetEl || !listEl) return;

  const archiveViewerModal = createArchiveViewerModal();
  const archiveLoadingScreen = createArchiveLoadingScreen();

  let currentKind = 'pano'; // 'pano' | 'floorplan'
  let currentFilename = null;
  let requestSeq = 0;
  let sourceLoadSeq = 0;

  function setTarget(kind, filename) {
    if (kind !== 'pano' && kind !== 'floorplan') return;
    currentKind = kind;
    currentFilename = filename || null;
  }

  function renderEmpty(message) {
    listEl.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = message;
    listEl.appendChild(li);
  }

  function updateTargetLabel() {
    if (!currentFilename) {
      targetEl.textContent = 'Select a panorama or floor plan to view its archive.';
      return;
    }
    const label = currentKind === 'floorplan' ? 'Floor plan' : 'Panorama';
    targetEl.textContent = `${label}: ${currentFilename}`;
  }

  async function fetchArchive(kind, filename) {
    const endpoint =
      kind === 'floorplan'
        ? `/api/archive/floorplans/${encodeURIComponent(filename)}`
        : `/api/archive/panos/${encodeURIComponent(filename)}`;
    const res = await fetch(appendProjectParams(endpoint), { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(parseArchiveFetchError(res, text));
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  function createArchiveFilenameButton(label, { kind, imageUrl, titleName, fallbackImageUrls = [] }) {
    if (!label || !imageUrl) return null;
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'archive-entry-image-link';
    linkBtn.textContent = label;
    const openTitleName = titleName || label;
    linkBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const seq = ++sourceLoadSeq;
      const loadingStartedAt = Date.now();
      linkBtn.disabled = true;
      archiveLoadingScreen.show('Preparing image source...');
      await waitForNextPaint();

      try {
        const readyImageUrl = await resolveArchiveImageSourceUrl(imageUrl, fallbackImageUrls);
        if (seq !== sourceLoadSeq) return;
        await waitForMinimumLoadingDuration(loadingStartedAt);
        archiveLoadingScreen.hide();
        archiveViewerModal.open({
          kind,
          title: `${kind === 'floorplan' ? 'Floor plan' : 'Panorama'}: ${openTitleName}`,
          imageUrl: readyImageUrl,
        });
      } catch (error) {
        if (seq !== sourceLoadSeq) return;
        await waitForMinimumLoadingDuration(loadingStartedAt);
        archiveLoadingScreen.hide();
        const message = error && error.message
          ? error.message
          : 'Image source is still not ready. Please try again in a few seconds.';
        void showAlert(message, 'Archive');
      } finally {
        linkBtn.disabled = false;
      }
    });
    return linkBtn;
  }

  function renderArchiveMessage(entry, resolveLiveFilename, resolveArchivedImage) {
    const msg = document.createElement('span');
    msg.className = 'archive-entry-msg';
    const text = entry && entry.message ? String(entry.message) : String(entry && entry.action ? entry.action : 'Update');

    const replacedMatch = text.match(/^(.*replaced\s+)\"([^\"]+)\"(\s+with\s+)\"([^\"]+)\"(.*)$/i);
    if (!replacedMatch) {
      msg.textContent = text;
      return msg;
    }

    const [, beforeOld, oldFilename, between, newFilename, afterNew] = replacedMatch;
    msg.appendChild(document.createTextNode(beforeOld || ''));

    const entryArchived = entry && entry.meta && entry.meta.archivedImage;
    const archivedKind = entryArchived && entryArchived.kind === 'floorplan' ? 'floorplan' : currentKind;
    const resolvedOldFilename = resolveLiveFilename(oldFilename);
    const resolvedArchivedOldImage =
      (entryArchived && entryArchived.storedFilename
        ? {
            kind: entryArchived.kind === 'floorplan' ? 'floorplan' : currentKind,
            storedFilename: entryArchived.storedFilename,
            originalFilename: entryArchived.originalFilename || oldFilename,
          }
        : null) ||
      resolveArchivedImage(resolvedOldFilename || oldFilename) ||
      resolveArchivedImage(oldFilename);
    const oldImageUrl =
      resolvedArchivedOldImage && resolvedArchivedOldImage.storedFilename
        ? createArchiveImageUrl(resolvedArchivedOldImage.kind, resolvedArchivedOldImage.storedFilename)
        : createArchiveImageUrl(archivedKind, oldFilename);
    const oldFallbackImageUrls = [];
    if (!resolvedArchivedOldImage || !resolvedArchivedOldImage.storedFilename) {
      const resolvedArchiveOldImageUrl = createArchiveImageUrl(archivedKind, resolvedOldFilename || oldFilename);
      if (resolvedArchiveOldImageUrl && resolvedArchiveOldImageUrl !== oldImageUrl) {
        oldFallbackImageUrls.push(resolvedArchiveOldImageUrl);
      }
    }
    const fallbackLiveOldImageUrl = createLiveImageUrl(currentKind, resolvedOldFilename || oldFilename);
    if (fallbackLiveOldImageUrl && fallbackLiveOldImageUrl !== oldImageUrl) {
      oldFallbackImageUrls.push(fallbackLiveOldImageUrl);
    }
    const oldLabel =
      resolvedArchivedOldImage && resolvedArchivedOldImage.storedFilename
        ? oldFilename
        : (resolvedOldFilename || oldFilename);
    const oldBtn = createArchiveFilenameButton(oldLabel, {
      kind: archivedKind === 'floorplan' ? 'floorplan' : 'pano',
      imageUrl: oldImageUrl,
      titleName: oldLabel,
      fallbackImageUrls: oldFallbackImageUrls,
    });
    if (oldBtn) msg.appendChild(oldBtn);
    else msg.appendChild(document.createTextNode(`"${oldFilename}"`));

    msg.appendChild(document.createTextNode(between || ' with '));

    const resolvedNewFilename = resolveLiveFilename(newFilename);
    const resolvedArchivedNewImage =
      resolveArchivedImage(resolvedNewFilename || newFilename) ||
      resolveArchivedImage(newFilename);
    const newImageUrl =
      resolvedArchivedNewImage && resolvedArchivedNewImage.storedFilename
        ? createArchiveImageUrl(resolvedArchivedNewImage.kind, resolvedArchivedNewImage.storedFilename)
        : createLiveImageUrl(currentKind, resolvedNewFilename || newFilename);
    const newFallbackImageUrls = [];
    const newArchiveByName = createArchiveImageUrl(currentKind, resolvedNewFilename || newFilename);
    if (newArchiveByName && newArchiveByName !== newImageUrl) {
      newFallbackImageUrls.push(newArchiveByName);
    }
    const newLiveByName = createLiveImageUrl(currentKind, resolvedNewFilename || newFilename);
    if (newLiveByName && newLiveByName !== newImageUrl) {
      newFallbackImageUrls.push(newLiveByName);
    }
    const newLabel = resolvedNewFilename || newFilename;
    const newBtn = createArchiveFilenameButton(newLabel, {
      kind: currentKind === 'floorplan' ? 'floorplan' : 'pano',
      imageUrl: newImageUrl,
      titleName: newLabel,
      fallbackImageUrls: newFallbackImageUrls,
    });
    if (newBtn) msg.appendChild(newBtn);
    else msg.appendChild(document.createTextNode(`"${newFilename}"`));

    msg.appendChild(document.createTextNode(afterNew || ''));
    return msg;
  }

  async function refreshNow() {
    // If we don't have a filename yet, try to infer it from the UI state.
    if (!currentFilename) {
      if (currentKind === 'floorplan') {
        const floor = getActiveFloorplanFromDom();
        if (floor) setTarget('floorplan', floor);
      } else {
        const pano = getSelectedImageName();
        if (pano) setTarget('pano', pano);
      }
      if (!currentFilename) {
        // Fallback to the other kind if the preferred kind has no active selection.
        if (currentKind === 'floorplan') {
          const pano = getSelectedImageName();
          if (pano) setTarget('pano', pano);
        } else {
          const floor = getActiveFloorplanFromDom();
          if (floor) setTarget('floorplan', floor);
        }
      }
    }

    updateTargetLabel();
    if (!currentFilename) {
      renderEmpty('Select a panorama or floor plan to view its archive.');
      return;
    }

    requestSeq += 1;
    const seq = requestSeq;
    renderEmpty('Loading...');

    try {
      const entries = await fetchArchive(currentKind, currentFilename);
      if (seq !== requestSeq) return;

      listEl.innerHTML = '';
      const visibleEntries = entries.filter((entry) => entry && entry.action !== 'processed');
      if (!visibleEntries.length) {
        renderEmpty('No archive entries yet for this item.');
        return;
      }

      const sorted = visibleEntries
        .slice()
        .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());
      const resolveLiveFilename = createLiveFilenameResolver(visibleEntries);
      const resolveArchivedImage = createArchivedImageResolver(visibleEntries, currentKind);

      sorted.forEach((entry) => {
        const li = document.createElement('li');
        const ts = document.createElement('span');
        ts.className = 'archive-entry-ts';
        ts.textContent = formatTimestamp(entry.ts);

        const msg = renderArchiveMessage(entry, resolveLiveFilename, resolveArchivedImage);

        li.append(ts, msg);
        listEl.appendChild(li);
      });
    } catch (e) {
      if (seq !== requestSeq) return;
      renderEmpty(`Could not load archive: ${e.message || e}`);
    }
  }

  function refreshIfVisible() {
    if (!isArchiveTabActive()) return;
    refreshNow();
  }

  archiveApi.setTarget = setTarget;
  archiveApi.refreshNow = refreshNow;
  archiveApi.refreshIfVisible = refreshIfVisible;

  document.addEventListener('pano:selected', (ev) => {
    const filename = ev && ev.detail ? ev.detail.filename : null;
    setTarget('pano', filename);
    refreshIfVisible();
  });

  document.addEventListener('floorplan:selected', (ev) => {
    const filename = ev && ev.detail ? ev.detail.filename : null;
    setTarget('floorplan', filename);
    refreshIfVisible();
  });

  document.addEventListener('archive:shown', (ev) => {
    const kind = ev && ev.detail ? ev.detail.kind : null;
    if (kind === 'floorplan') {
      setTarget('floorplan', getActiveFloorplanFromDom());
    } else if (kind === 'pano') {
      setTarget('pano', getSelectedImageName());
    }
    refreshNow();
  });
}
