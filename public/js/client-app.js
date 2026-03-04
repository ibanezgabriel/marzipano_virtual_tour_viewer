import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { initHotspotsClient, reloadHotspots as reloadHotspotsClient } from './features/hotspots-client.js';
import { initFloorplansClient, reloadFloorplanHotspotsClient, reloadFloorplansListClient } from './features/floorplans-client.js';
import { getProjectId } from './project-context.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { io } from '/socket.io/socket.io.esm.min.js';

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
  window.location.replace('index.html');
} else {
  initHotspotsClient();
  document.addEventListener('DOMContentLoaded', async () => {
    await initHotspotsClient();
    let canonicalId = getProjectId();
    try {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      canonicalId = resolveProjectId(projects, getProjectId());
      const project = Array.isArray(projects) ? projects.find(p => p.id === canonicalId) : null;
      if (project && project.name) setProjectName(project.name);
    } catch {}
    loadImages();
    initFloorplansClient();
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
          if (proj && proj.name) setProjectName(proj.name);
        });
      } catch (e) {}
    })();
    socket.on('panos:ready', () => loadImages());
    socket.on('pano:renamed', () => loadImages());
    socket.on('pano:updated', () => loadImages());
    socket.on('pano:removed', () => loadImages());
    socket.on('panos:order', () => loadImages());
    socket.on('hotspots:changed', () => { try { reloadHotspotsClient(); } catch (e) {} });
    socket.on('floorplan-hotspots:changed', () => { try { reloadFloorplanHotspotsClient(); } catch (e) {} });
    socket.on('floorplans:order', () => { try { reloadFloorplansListClient(); } catch (e) {} });
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
