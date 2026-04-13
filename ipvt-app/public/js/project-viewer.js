import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { initHotspotsClient, reloadHotspots as reloadHotspotsClient } from './features/hotspots-client.js';
import { initBlurMasksClient, reloadBlurMasksClient } from './features/blur-masks-client.js';
import { initLayoutsClient, reloadLayoutHotspotsClient, reloadLayoutsListClient } from './features/layouts-client.js';
import { getProjectId } from './project-context.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { io } from '/socket.io/socket.io.esm.min.js';

let projectNameResizeBound = false;

function setupProjectNameModal() {
  const modal = document.getElementById('project-name-modal');
  const closeBtn = document.getElementById('project-name-modal-close');
  const headerText = document.getElementById('pano-header-text');

  if (!modal || !headerText) return;

  const close = () => modal.classList.remove('visible');
  const open = () => modal.classList.add('visible');

  const tryOpenFromHeader = (e) => {
    if (!headerText.dataset || headerText.dataset.fullnameTrigger !== '1') return;
    e.preventDefault();
    e.stopPropagation();
    open();
  };

  headerText.addEventListener('click', tryOpenFromHeader);
  headerText.addEventListener('keydown', (e) => {
    if (!e) return;
    const key = e.key || '';
    if (key !== 'Enter' && key !== ' ') return;
    tryOpenFromHeader(e);
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      close();
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
}

function syncProjectNameInfoButtonVisibility() {
  const headerText = document.getElementById('pano-header-text');
  if (!headerText) return;
  const truncated = headerText.scrollWidth > headerText.clientWidth + 1;
  const isMobile = Boolean(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
  const enabled = truncated && isMobile;
  headerText.classList.toggle('project-name-link', enabled);
  if (enabled) {
    headerText.setAttribute('role', 'button');
    headerText.setAttribute('tabindex', '0');
    headerText.setAttribute('aria-label', 'View full project name');
    if (headerText.dataset) headerText.dataset.fullnameTrigger = '1';
  } else {
    headerText.removeAttribute('role');
    headerText.removeAttribute('tabindex');
    headerText.removeAttribute('aria-label');
    if (headerText.dataset) headerText.dataset.fullnameTrigger = '0';
  }
}

function updateProjectNameUi(name) {
  const projectName = typeof name === 'string' ? name : '';
  setProjectName(projectName);

  const fullText = document.getElementById('project-fullname-text');
  if (fullText) fullText.textContent = projectName;

  // Mobile-only: underline the project name only when the header text is actually truncated.
  requestAnimationFrame(syncProjectNameInfoButtonVisibility);
  if (!projectNameResizeBound) {
    projectNameResizeBound = true;
    window.addEventListener(
      'resize',
      () => requestAnimationFrame(syncProjectNameInfoButtonVisibility),
      { passive: true }
    );
  }
}

function resolveProjectId(projects, token) {
  const value = (token || '').trim();
  if (!value || !Array.isArray(projects)) return value;
  const match = projects.find(
    (p) =>
      p.id === value ||
      (p.number && String(p.number).trim() === value)
  );
  return match ? match.id : value;
}

if (!getProjectId()) {
  window.location.replace('dashboard.html');
} else {
  initHotspotsClient();
  initBlurMasksClient();
  document.addEventListener('DOMContentLoaded', async () => {
    setupProjectNameModal();
    await initHotspotsClient();
    await initBlurMasksClient();
    let canonicalId = getProjectId();
    try {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      canonicalId = resolveProjectId(projects, getProjectId());
      const project = Array.isArray(projects) ? projects.find(p => p.id === canonicalId) : null;
      if (project && project.name) updateProjectNameUi(project.name);
    } catch {}
    loadImages();
    initLayoutsClient();
  });

  // Realtime project name updates for client viewers
  try {
    const socket = io();
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        const raw = getProjectId();
        const pid = resolveProjectId(projects, raw);
        if (pid) socket.emit('joinProject', pid);
        socket.on('projects:changed', (projectsUpdate) => {
          const projId = resolveProjectId(projectsUpdate, raw);
          if (!projId) return;
          const proj = Array.isArray(projectsUpdate) ? projectsUpdate.find(p => p.id === projId) : null;
          if (proj && proj.name) updateProjectNameUi(proj.name);
        });
      } catch (e) {}
    })();
    socket.on('panos:ready', () => loadImages());
    socket.on('pano:renamed', () => loadImages());
    socket.on('pano:updated', () => loadImages());
    socket.on('pano:removed', () => loadImages());
    socket.on('panos:order', () => loadImages());
    socket.on('hotspots:changed', () => { try { reloadHotspotsClient(); } catch (e) {} });
    socket.on('blur-masks:changed', () => { try { reloadBlurMasksClient(); } catch (e) {} });
    socket.on('layout-hotspots:changed', () => { try { reloadLayoutHotspotsClient(); } catch (e) {} });
    socket.on('layouts:order', () => { try { reloadLayoutsListClient(); } catch (e) {} });
    socket.on('initial-views:changed', async () => {
      try {
        const { reloadInitialViews, getSelectedImageName, loadPanorama } = await import('./marzipano-viewer.js');
        await reloadInitialViews();
      } catch (e) {}
    });
  } catch (e) {}
}

// Initialize the menu collapsible functionality
initMenuCollapsible();

