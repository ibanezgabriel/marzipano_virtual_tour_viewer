import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { initHotspotsClient } from './features/hotspots-client.js';
import { getProjectId } from './project-context.js';
import { initMenuCollapsible } from './menu-collapsible.js';

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
}

// Initialize the menu collapsible functionality
initMenuCollapsible();
