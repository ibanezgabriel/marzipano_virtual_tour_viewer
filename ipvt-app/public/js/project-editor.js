/* Bootstraps the project editor and its feature modules. */
import { initViewer, loadImages, setProjectName, updateInitialViewForRenamedImage } from './marzipano-viewer.js';
import { getProjectId } from './project-context.js';
import { initLayouts, layoutApi } from './features/layouts.js';
import { initAuditLogs, auditLogsApi } from './features/audit-logs.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages, updateHotspotsForRenamedImage, reloadHotspots } from './features/hotspots.js';
import { initBlurMasks, cleanupBlurMasksForDeletedImages, updateBlurMasksForRenamedImage, reloadBlurMasks } from './features/blur-masks.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { initInitialView } from './features/initial-view.js';
import { reloadInitialViews } from './marzipano-viewer.js';
import { io } from '/socket.io/socket.io.esm.min.js';

/* Handles resolve project id. */
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

/* Handles cleanup scene linked data. */
function cleanupSceneLinkedData(validImageNames) {
  try { cleanupHotspotsForDeletedImages(validImageNames); } catch (e) {}
  try { cleanupBlurMasksForDeletedImages(validImageNames); } catch (e) {}
}

if (!getProjectId()) {
  window.location.replace('dashboard.html');
} else {
  initRename();
  initUpdate();
  initUpload();
  initAuditLogs();
  initHotspots();
  initBlurMasks();
  initMenuCollapsible();
  initInitialView();

  document.addEventListener('DOMContentLoaded', () => {
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        const id = resolveProjectId(projects, getProjectId());
        const project = Array.isArray(projects) ? projects.find(p => p.id === id) : null;
        if (project && project.name) setProjectName(project.name);
      } catch {}
    })();
    initViewer();
    loadImages(cleanupSceneLinkedData);
    initLayouts();
  });

  // Realtime project name updates
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
          if (proj && proj.name) setProjectName(proj.name);
        });
      } catch (e) {}
    })();

    socket.on('panos:ready', (payload) => {
      loadImages(cleanupSceneLinkedData);
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('panos:order', (payload) => {
      loadImages(cleanupSceneLinkedData);
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('pano:renamed', (payload) => {
      try { updateInitialViewForRenamedImage(payload.oldFilename, payload.newFilename); } catch (e) {}
      try { updateHotspotsForRenamedImage(payload.oldFilename, payload.newFilename); } catch (e) {}
      try { updateBlurMasksForRenamedImage(payload.oldFilename, payload.newFilename); } catch (e) {}
      try { layoutApi.updateForRenamedPano(payload.oldFilename, payload.newFilename); } catch (e) {}
      loadImages(cleanupSceneLinkedData);
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('pano:updated', (payload) => {
      loadImages(cleanupSceneLinkedData);
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('pano:removed', (payload) => {
      loadImages(cleanupSceneLinkedData);
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('hotspots:changed', (payload) => {
      try { reloadHotspots(); } catch (e) {}
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('blur-masks:changed', () => {
      try { reloadBlurMasks(); } catch (e) {}
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('initial-views:changed', async (payload) => {
      try { await reloadInitialViews(); } catch (e) {}
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
    socket.on('layouts:order', () => {
      try { layoutApi.reloadList(); } catch (e) {}
      try { auditLogsApi.refreshIfVisible(); } catch (e) {}
    });
  } catch (e) {}
}
