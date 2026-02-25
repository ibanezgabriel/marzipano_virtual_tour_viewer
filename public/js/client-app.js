import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { initHotspotsClient } from './features/hotspots-client.js';
import { getProjectId } from './project-context.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { io } from '/socket.io/socket.io.esm.min.js';

if (!getProjectId()) {
  window.location.replace('index.html');
} else {
  initHotspotsClient();
  document.addEventListener('DOMContentLoaded', async () => {
    await initHotspotsClient();
    try {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      const id = getProjectId();
      const project = Array.isArray(projects) ? projects.find(p => p.id === id) : null;
      if (project && project.name) setProjectName(project.name);
    } catch {}
    initViewer();
    loadImages();
  });

  // Realtime project name updates for client viewers
  try {
    const socket = io();
    socket.on('projects:changed', (projects) => {
      const id = getProjectId();
      if (!id) return;
      const proj = Array.isArray(projects) ? projects.find(p => p.id === id) : null;
      if (proj && proj.name) setProjectName(proj.name);
    });
  } catch (e) {}
}

// Initialize the menu collapsible functionality
initMenuCollapsible();
