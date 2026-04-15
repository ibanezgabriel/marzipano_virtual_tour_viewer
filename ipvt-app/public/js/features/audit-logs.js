/* Loads and renders project audit log activity. */
import Marzipano from "//cdn.skypack.dev/marzipano";
import { appendProjectParams, getUploadBase, getLayoutBase } from '../project-context.js';
import { getSelectedImageName } from '../marzipano-viewer.js';
import { showAlert } from '../dialog.js';

const AUDIT_LOG_MAX_FOV = 100 * Math.PI / 180;
const AUDIT_LOG_MIN_FOV = 30 * Math.PI / 180;
const AUDIT_LOG_EQUIRECT_WIDTH = 4000;
const AUDIT_LOG_SOURCE_READY_TIMEOUT_MS = 30000;
const AUDIT_LOG_SOURCE_PROBE_TIMEOUT_MS = 12000;
const AUDIT_LOG_SOURCE_RETRY_DELAY_MS = 700;
const AUDIT_LOG_LOADING_MIN_VISIBLE_MS = 220;

/* Handles is layout audit kind. */
function isLayoutAuditKind(kind) {
  return kind === 'layout' || kind === 'floorplan';
}

/* Handles select el. */
function selectEl(id) {
  return document.getElementById(id);
}

/* Handles is audit logs tab active. */
function isAuditLogsTabActive() {
  const tab = selectEl('pano-audit-logs');
  return Boolean(tab && tab.classList.contains('active-tab'));
}

/* Handles format timestamp. */
function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

/* Handles format actor. */
function formatActor(entry) {
  const userId = entry && entry.meta && entry.meta.createdByUserId ? String(entry.meta.createdByUserId).trim() : '';
  return userId ? userId : '';
}

/* Gets get active layout from dom. */
function getActiveLayoutFromDom() {
  const li = document.querySelector('#pano-layout-list li.active[data-filename]');
  return li && li.dataset ? li.dataset.filename : null;
}

/* Handles parse audit logs fetch error. */
function parseAuditLogsFetchError(res, text) {
  if (res.status === 404 && /Cannot GET\s+\/api\/audit-logs\//i.test(text || '')) {
    return 'Audit logs API is unavailable on the running server. Please restart the server to load the latest routes.';
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

/* Sets up create audit log image url. */
function createAuditLogImageUrl(kind, storedFilename) {
  const safeKind = isLayoutAuditKind(kind) ? 'layout' : 'pano';
  return appendProjectParams(`/api/audit-logs/images/${safeKind}/${encodeURIComponent(storedFilename)}`);
}

/* Sets up create live image url. */
function createLiveImageUrl(kind, filename) {
  if (!filename) return null;
  const base = isLayoutAuditKind(kind) ? getLayoutBase() : getUploadBase();
  return `${base}/${encodeURIComponent(filename)}`;
}

/* Handles parse renamed filenames from message. */
function parseRenamedFilenamesFromMessage(message) {
  const text = String(message || '');
  const legacy = text.match(/renamed\s+from\s+"([^"]+)"\s+to\s+"([^"]+)"/i);
  const modern = text.match(/rename:\s*'([^']+)'\s*to\s*'([^']+)'/i);
  const match = legacy || modern;
  if (!match) return null;
  const oldFilename = match[1] ? match[1].trim() : '';
  const newFilename = match[2] ? match[2].trim() : '';
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

/* Handles parse replaced filenames from message. */
function parseReplacedFilenamesFromMessage(message) {
  const text = String(message || '');
  const legacy = text.match(/replaced\s+"([^"]+)"\s+with\s+"([^"]+)"/i);
  const modern = text.match(/update:\s*'([^']+)'\s*to\s*'([^']+)'/i);
  const match = legacy || modern;
  if (!match) return null;
  const oldFilename = match[1] ? match[1].trim() : '';
  const newFilename = match[2] ? match[2].trim() : '';
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

/* Gets read replaced meta. */
function readReplacedMeta(entry) {
  const replaced = entry && entry.meta && entry.meta.replaced && typeof entry.meta.replaced === 'object'
    ? entry.meta.replaced
    : null;
  if (!replaced) return null;
  const oldFilename = replaced.oldFilename ? String(replaced.oldFilename).trim() : '';
  const newFilename = replaced.newFilename ? String(replaced.newFilename).trim() : '';
  if (!oldFilename || !newFilename) return null;
  return { oldFilename, newFilename };
}

/* Gets get replaced pair. */
function getReplacedPair(entry) {
  return readReplacedMeta(entry) || parseReplacedFilenamesFromMessage(entry && entry.message);
}

/* Sets up create live filename resolver. */
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

/* Sets up create archived image resolver. */
function createArchivedImageResolver(entries, defaultKind) {
  const archiveMap = new Map();
  const fallbackKind = isLayoutAuditKind(defaultKind) ? 'layout' : 'pano';
  const ordered = Array.isArray(entries)
    ? entries
        .slice()
        .sort((a, b) => new Date(a && a.ts ? a.ts : 0).getTime() - new Date(b && b.ts ? b.ts : 0).getTime())
    : [];

  ordered.forEach((entry) => {
    const replaced = getReplacedPair(entry);
    if (!replaced) return;
    const archived = entry && entry.meta && entry.meta.archivedImage;
    if (!archived || !archived.storedFilename) return;
    const kind = isLayoutAuditKind(archived.kind) ? 'layout' : fallbackKind;
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

/* Handles with cache bust. */
function withCacheBust(url) {
  const separator = String(url || '').includes('?') ? '&' : '?';
  return `${url}${separator}auditLogReady=${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* Handles sleep. */
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* Handles wait for next paint. */
function waitForNextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

/* Handles wait for minimum loading duration. */
async function waitForMinimumLoadingDuration(startedAtMs, minDurationMs = AUDIT_LOG_LOADING_MIN_VISIBLE_MS) {
  const elapsed = Date.now() - startedAtMs;
  const remaining = minDurationMs - elapsed;
  if (remaining > 0) {
    await sleep(remaining);
  }
}

/* Sets up make source probe error. */
function makeSourceProbeError(message, permanent = false) {
  const error = new Error(message);
  error.permanent = Boolean(permanent);
  return error;
}

/* Gets fetch with timeout. */
async function fetchWithTimeout(url, options = {}, timeoutMs = AUDIT_LOG_SOURCE_PROBE_TIMEOUT_MS) {
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

/* Handles throw for probe status. */
function throwForProbeStatus(status) {
  if (status === 404) {
    throw makeSourceProbeError('Audit log image file was not found.', true);
  }
  if (status === 400 || status === 403) {
    throw makeSourceProbeError('Audit log image request was rejected.', true);
  }
  throw makeSourceProbeError(`Image source check failed (${status}).`);
}

/* Handles probe audit log image source. */
async function probeAuditLogImageSource(imageUrl, timeoutMs = AUDIT_LOG_SOURCE_PROBE_TIMEOUT_MS) {
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

/* Handles wait for audit log image source. */
async function waitForAuditLogImageSource(imageUrl, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : AUDIT_LOG_SOURCE_READY_TIMEOUT_MS;
  const retryDelayMs = Number(opts.retryDelayMs) >= 0 ? Number(opts.retryDelayMs) : AUDIT_LOG_SOURCE_RETRY_DELAY_MS;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await probeAuditLogImageSource(imageUrl);
    } catch (error) {
      lastError = error;
      if (error && error.permanent) break;
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error('Image source is still not ready.');
}

/* Handles resolve audit log image source url. */
async function resolveAuditLogImageSourceUrl(primaryUrl, fallbackUrls = []) {
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
      return await waitForAuditLogImageSource(candidate);
    } catch (error) {
      lastError = error;
      // Keep trying every candidate (audit log / live variants) before failing.
    }
  }

  throw lastError || new Error('Image source is unavailable.');
}

/* Sets up create audit log loading screen. */
function createAuditLogLoadingScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'audit-log-source-loading-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="audit-log-source-loading-box" role="status" aria-live="polite">
      <div class="audit-log-source-loading-spinner" aria-hidden="true"></div>
      <div class="audit-log-source-loading-text">Preparing image...</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const textEl = overlay.querySelector('.audit-log-source-loading-text');

/* Shows show. */
  function show(message) {
    if (textEl && typeof message === 'string' && message.trim()) {
      textEl.textContent = message.trim();
    }
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
  }

/* Cleans up hide. */
  function hide() {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
  }

  return { show, hide };
}

/* Sets up create audit log viewer modal. */
function createAuditLogViewerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'audit-log-viewer-modal-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="audit-log-viewer-modal" role="dialog" aria-modal="true" aria-label="Audit log image viewer">
      <div class="audit-log-viewer-modal-header">
        <div class="audit-log-viewer-modal-title"></div>
        <button type="button" class="audit-log-viewer-close" aria-label="Close">Close</button>
      </div>
      <div class="audit-log-viewer-modal-body">
        <div class="audit-log-viewer-pano"></div>
        <img class="audit-log-viewer-image" alt="Audit log image" />
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleEl = overlay.querySelector('.audit-log-viewer-modal-title');
  const closeBtn = overlay.querySelector('.audit-log-viewer-close');
  const paneEl = overlay.querySelector('.audit-log-viewer-pano');
  const imgEl = overlay.querySelector('.audit-log-viewer-image');

  let panoViewer = null;

/* Handles reset pano surface. */
  function resetPanoSurface() {
    paneEl.classList.remove('visible');
    paneEl.textContent = '';
    panoViewer = null;
  }

/* Sets up ensure pano viewer. */
  function ensurePanoViewer() {
    if (!panoViewer) {
      panoViewer = new Marzipano.Viewer(paneEl);
    }
    return panoViewer;
  }

/* Cleans up close. */
  function close() {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    imgEl.classList.remove('visible');
    imgEl.removeAttribute('src');
    resetPanoSurface();
  }

/* Shows open. */
  function open({ kind, title, imageUrl }) {
    if (!imageUrl) return;
    titleEl.textContent = title || 'Audit log image';
    // Clear any previous content so old media never flashes before the new source renders.
    imgEl.classList.remove('visible');
    imgEl.removeAttribute('src');
    resetPanoSurface();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');

    if (kind === 'pano') {
      // Use a plain <img> for audit comparisons to avoid black/blank Marzipano renders
      // when the source is a raw archived image instead of a tiled scene.
      paneEl.classList.remove('visible');
      imgEl.classList.add('visible');
      imgEl.src = imageUrl;
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

export const auditLogsApi = {
  setTarget(_kind, _filename) {},
  refreshNow() {},
  refreshIfVisible() {},
};

export function initAuditLogs() {
  const auditLogsTab = selectEl('pano-audit-logs');
  const auditLogsPanel = selectEl('pano-audit-logs-panel');
  const targetEl = selectEl('pano-audit-logs-target');
  const listEl = selectEl('pano-audit-logs-list');
  const projectListEl = selectEl('pano-audit-logs-project-list');

  if (!auditLogsTab || !auditLogsPanel || !targetEl || !listEl) return;

  const auditLogViewerModal = createAuditLogViewerModal();
  const auditLogLoadingScreen = createAuditLogLoadingScreen();

  let currentKind = 'pano'; // 'pano' | 'layout'
  let currentFilename = null;
  let requestSeq = 0;
  let sourceLoadSeq = 0;

/* Updates set target. */
  function setTarget(kind, filename) {
    if (kind !== 'pano' && !isLayoutAuditKind(kind)) return;
    currentKind = isLayoutAuditKind(kind) ? 'layout' : kind;
    currentFilename = filename || null;
  }

/* Shows render empty. */
  function renderEmpty(message) {
    listEl.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = message;
    listEl.appendChild(li);
  }

/* Shows render project empty. */
  function renderProjectEmpty(message) {
    if (!projectListEl) return;
    projectListEl.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = message;
    projectListEl.appendChild(li);
  }

/* Updates update target label. */
  function updateTargetLabel() {
    if (!currentFilename) {
      targetEl.textContent = 'Select a panorama or layout to view its audit logs.';
      return;
    }
    const label = currentKind === 'layout' ? 'Layout' : 'Panorama';
    targetEl.textContent = `${label}: ${currentFilename}`;
  }

/* Gets fetch audit logs for asset. */
  async function fetchAuditLogsForAsset(kind, filename) {
    const endpoint =
      kind === 'layout'
        ? `/api/audit-logs/layouts/${encodeURIComponent(filename)}`
        : `/api/audit-logs/panos/${encodeURIComponent(filename)}`;
    const res = await fetch(appendProjectParams(endpoint), { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(parseAuditLogsFetchError(res, text));
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

/* Gets fetch project audit logs. */
  async function fetchProjectAuditLogs() {
    const res = await fetch(appendProjectParams('/api/audit-logs/project'), { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(parseAuditLogsFetchError(res, text));
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

/* Sets up create audit log filename button. */
  function createAuditLogFilenameButton(label, { kind, imageUrl, titleName, fallbackImageUrls = [] }) {
    if (!label || !imageUrl) return null;
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'audit-log-entry-image-link';
    linkBtn.textContent = label;
    const openTitleName = titleName || label;
    linkBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const seq = ++sourceLoadSeq;
      const loadingStartedAt = Date.now();
      linkBtn.disabled = true;
      auditLogLoadingScreen.show('Preparing image source...');
      await waitForNextPaint();

      try {
        const readyImageUrl = await resolveAuditLogImageSourceUrl(imageUrl, fallbackImageUrls);
        if (seq !== sourceLoadSeq) return;
        await waitForMinimumLoadingDuration(loadingStartedAt);
        auditLogLoadingScreen.hide();
        auditLogViewerModal.open({
          kind,
          title: `${kind === 'layout' ? 'Layout' : 'Panorama'}: ${openTitleName}`,
          imageUrl: readyImageUrl,
        });
      } catch (error) {
        if (seq !== sourceLoadSeq) return;
        await waitForMinimumLoadingDuration(loadingStartedAt);
        auditLogLoadingScreen.hide();
        const message = error && error.message
          ? error.message
          : 'Image source is still not ready. Please try again in a few seconds.';
        void showAlert(message, 'Audit Logs');
      } finally {
        linkBtn.disabled = false;
      }
    });
    return linkBtn;
  }

/* Shows render audit log message. */
  function renderAuditLogMessage(entry, resolveLiveFilename, resolveArchivedImage) {
    const msg = document.createElement('span');
    msg.className = 'audit-log-entry-msg';
    const text = entry && entry.message ? String(entry.message) : String(entry && entry.action ? entry.action : 'Update');

    const legacyMatch = text.match(/^(.*replaced\s+)\"([^\"]+)\"(\s+with\s+)\"([^\"]+)\"(.*)$/i);
    const modernMatch = text.match(/^(.*update:\s*)'([^']+)'(\s*to\s*)'([^']+)'(.*)$/i);
    const match = legacyMatch || modernMatch;
    if (!match) {
      msg.textContent = text;
      return msg;
    }

    const [, beforeOld, oldFilename, betweenRaw, newFilename, afterNew] = match;
    msg.appendChild(document.createTextNode(beforeOld || ''));
    const between = betweenRaw || (legacyMatch ? ' with ' : ' to ');
    if (modernMatch) msg.appendChild(document.createTextNode(`'`));

    const entryArchived = entry && entry.meta && entry.meta.archivedImage;
    const archivedKind =
      entryArchived && isLayoutAuditKind(entryArchived.kind) ? 'layout' : currentKind;
    const resolvedOldFilename = resolveLiveFilename(oldFilename);
    const resolvedArchivedOldImage =
      (entryArchived && entryArchived.storedFilename
        ? {
            kind: isLayoutAuditKind(entryArchived.kind) ? 'layout' : currentKind,
            storedFilename: entryArchived.storedFilename,
            originalFilename: entryArchived.originalFilename || oldFilename,
          }
        : null) ||
      resolveArchivedImage(resolvedOldFilename || oldFilename) ||
      resolveArchivedImage(oldFilename);
    const oldImageUrl =
      resolvedArchivedOldImage && resolvedArchivedOldImage.storedFilename
        ? createAuditLogImageUrl(resolvedArchivedOldImage.kind, resolvedArchivedOldImage.storedFilename)
        : createAuditLogImageUrl(archivedKind, oldFilename);
    const oldFallbackImageUrls = [];
    if (!resolvedArchivedOldImage || !resolvedArchivedOldImage.storedFilename) {
      const resolvedArchiveOldImageUrl = createAuditLogImageUrl(archivedKind, resolvedOldFilename || oldFilename);
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
    const oldBtn = createAuditLogFilenameButton(oldLabel, {
      kind: archivedKind === 'layout' ? 'layout' : 'pano',
      imageUrl: oldImageUrl,
      titleName: oldLabel,
      fallbackImageUrls: oldFallbackImageUrls,
    });
    if (oldBtn) msg.appendChild(oldBtn);
    else msg.appendChild(document.createTextNode(`"${oldFilename}"`));

    if (modernMatch) msg.appendChild(document.createTextNode(`'`));
    msg.appendChild(document.createTextNode(between));
    if (modernMatch) msg.appendChild(document.createTextNode(`'`));

    const resolvedNewFilename = resolveLiveFilename(newFilename);
    const resolvedArchivedNewImage =
      resolveArchivedImage(resolvedNewFilename || newFilename) ||
      resolveArchivedImage(newFilename);
    const newImageUrl =
      resolvedArchivedNewImage && resolvedArchivedNewImage.storedFilename
        ? createAuditLogImageUrl(resolvedArchivedNewImage.kind, resolvedArchivedNewImage.storedFilename)
        : createLiveImageUrl(currentKind, resolvedNewFilename || newFilename);
    const newFallbackImageUrls = [];
    const newArchiveByName = createAuditLogImageUrl(currentKind, resolvedNewFilename || newFilename);
    if (newArchiveByName && newArchiveByName !== newImageUrl) {
      newFallbackImageUrls.push(newArchiveByName);
    }
    const newLiveByName = createLiveImageUrl(currentKind, resolvedNewFilename || newFilename);
    if (newLiveByName && newLiveByName !== newImageUrl) {
      newFallbackImageUrls.push(newLiveByName);
    }
    const newLabel = resolvedNewFilename || newFilename;
    const newBtn = createAuditLogFilenameButton(newLabel, {
      kind: currentKind === 'layout' ? 'layout' : 'pano',
      imageUrl: newImageUrl,
      titleName: newLabel,
      fallbackImageUrls: newFallbackImageUrls,
    });
    if (newBtn) msg.appendChild(newBtn);
    else msg.appendChild(document.createTextNode(`"${newFilename}"`));

    if (modernMatch) msg.appendChild(document.createTextNode(`'`));
    msg.appendChild(document.createTextNode(afterNew || ''));
    return msg;
  }

/* Shows render actor line. */
  function renderActorLine(entry) {
    const actor = formatActor(entry);
    if (!actor) return null;
    const by = document.createElement('span');
    by.className = 'audit-log-entry-by';
    by.textContent = `Created by ${actor}`;
    return by;
  }

/* Shows render project entry. */
  function renderProjectEntry(entry) {
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'audit-log-entry-ts';
    ts.textContent = formatTimestamp(entry && entry.ts ? entry.ts : '');

    const msg = document.createElement('span');
    msg.className = 'audit-log-entry-msg';
    msg.textContent = entry && entry.message ? String(entry.message) : String(entry && entry.action ? entry.action : 'Update');

    const by = renderActorLine(entry);
    if (by) li.append(ts, msg, by);
    else li.append(ts, msg);
    return li;
  }

/* Handles refresh now. */
  async function refreshNow() {
    // If we don't have a filename yet, try to infer it from the UI state.
    if (!currentFilename) {
      if (currentKind === 'layout') {
        const floor = getActiveLayoutFromDom();
        if (floor) setTarget('layout', floor);
      } else {
        const pano = getSelectedImageName();
        if (pano) setTarget('pano', pano);
      }
      if (!currentFilename) {
        // Fallback to the other kind if the preferred kind has no active selection.
        if (currentKind === 'layout') {
          const pano = getSelectedImageName();
          if (pano) setTarget('pano', pano);
        } else {
          const floor = getActiveLayoutFromDom();
          if (floor) setTarget('layout', floor);
        }
      }
    }

    updateTargetLabel();

    if (projectListEl) {
      try {
        renderProjectEmpty('Loading project activity...');
        const projectEntries = await fetchProjectAuditLogs();
        projectListEl.innerHTML = '';
        const visible = projectEntries.filter((entry) => entry && entry.action !== 'processed');
        if (!visible.length) {
          renderProjectEmpty('No project activity yet.');
        } else {
          visible
            .slice()
            .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime())
            .forEach((entry) => projectListEl.appendChild(renderProjectEntry(entry)));
        }
      } catch (e) {
        renderProjectEmpty(`Could not load project activity: ${e.message || e}`);
      }
    }

    if (!currentFilename) {
      renderEmpty('Select a panorama or layout to view its audit logs.');
      return;
    }

    requestSeq += 1;
    const seq = requestSeq;
    renderEmpty('Loading...');

    try {
      const entries = await fetchAuditLogsForAsset(currentKind, currentFilename);
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
        ts.className = 'audit-log-entry-ts';
        ts.textContent = formatTimestamp(entry.ts);

        const msg = renderAuditLogMessage(entry, resolveLiveFilename, resolveArchivedImage);
        const by = renderActorLine(entry);

        if (by) li.append(ts, msg, by);
        else li.append(ts, msg);
        listEl.appendChild(li);
      });
    } catch (e) {
      if (seq !== requestSeq) return;
      renderEmpty(`Could not load archive: ${e.message || e}`);
    }
  }

/* Handles refresh if visible. */
  function refreshIfVisible() {
    if (!isAuditLogsTabActive()) return;
    refreshNow();
  }

  auditLogsApi.setTarget = setTarget;
  auditLogsApi.refreshNow = refreshNow;
  auditLogsApi.refreshIfVisible = refreshIfVisible;

  document.addEventListener('pano:selected', (ev) => {
    const filename = ev && ev.detail ? ev.detail.filename : null;
    setTarget('pano', filename);
    refreshIfVisible();
  });

  document.addEventListener('layout:selected', (ev) => {
    const filename = ev && ev.detail ? ev.detail.filename : null;
    setTarget('layout', filename);
    refreshIfVisible();
  });

  document.addEventListener('audit-logs:shown', (ev) => {
    const kind = ev && ev.detail ? ev.detail.kind : null;
    if (kind === 'layout') {
      setTarget('layout', getActiveLayoutFromDom());
    } else if (kind === 'pano') {
      setTarget('pano', getSelectedImageName());
    }
    refreshNow();
  });
}
