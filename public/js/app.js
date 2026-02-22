import { initViewer, loadImages, setProjectName } from './marzipano-viewer.js';
import { getProjectId } from './project-context.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initDelete } from './features/delete.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages } from './features/hotspots.js';
import { initMenuCollapsible } from './menu-collapsible.js';
if (!getProjectId()) {
  window.location.replace('index.html');
} else {
  initRename();
  initUpdate();
  initDelete();
  initUpload();
  initHotspots();
  initMenuCollapsible();

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
