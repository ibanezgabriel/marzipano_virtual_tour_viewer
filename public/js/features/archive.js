import { appendProjectParams } from '../project-context.js';
import { getSelectedImageName } from '../marzipano-viewer.js';

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

  let currentKind = 'pano'; // 'pano' | 'floorplan'
  let currentFilename = null;
  let requestSeq = 0;

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
      throw new Error(text || `Server responded with ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
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
    renderEmpty('Loading…');

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

      sorted.forEach((entry) => {
        const li = document.createElement('li');
        const ts = document.createElement('span');
        ts.className = 'archive-entry-ts';
        ts.textContent = formatTimestamp(entry.ts);

        const msg = document.createElement('span');
        msg.className = 'archive-entry-msg';
        msg.textContent = entry.message || entry.action || 'Update';

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
