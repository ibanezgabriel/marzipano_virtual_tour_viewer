import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { getProjectId } from './project-context.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initDelete } from './features/delete.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages } from './features/hotspots.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { initInitialView } from './features/initial-view.js';
import { io } from '/socket.io/socket.io.esm.min.js';
if (!getProjectId()) {
  window.location.replace('index.html');
} else {
  initRename();
  initUpdate();
  initDelete();
  initUpload();
  initHotspots();
  initMenuCollapsible();
  initInitialView();

  document.addEventListener('DOMContentLoaded', () => {
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        const id = getProjectId();
        const project = Array.isArray(projects) ? projects.find(p => p.id === id) : null;
        if (project && project.name) setProjectName(project.name);
      } catch {}
    })();
    initViewer();
    loadImages(cleanupHotspotsForDeletedImages);
  });

  // Realtime project name updates
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

// const sidebarBTN = document.getElementById("pano-sidebar-btn");
// const sidebarIMG = sidebarBTN.querySelector("img")
// const sidebarWrapper = document.getElementById("pano-sidebar-wrapper");

// sidebarBTN.addEventListener("click", () => {
//   sidebarWrapper.classList.toggle("collapsed");
//   if (sidebarWrapper.classList.contains("collapsed")) {
//     sidebarIMG.src = "../assets/side-bar-show.png"
//   } else {
//     sidebarIMG.src = "../assets/side-bar-hide.png"
//   }
// });
