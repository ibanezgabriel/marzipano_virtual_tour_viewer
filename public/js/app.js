import { initViewer, loadImages, setProjectName, updateInitialViewForRenamedImage } from './marzipano-viewer.js';
import { getProjectId } from './project-context.js';
import { initFloorplans, floorplanApi } from './features/floorplans.js';
import { initRename } from './features/rename.js';
import { initUpdate } from './features/update.js';
import { initDelete } from './features/delete.js';
import { initUpload } from './features/upload.js';
import { initHotspots, cleanupHotspotsForDeletedImages, updateHotspotsForRenamedImage, reloadHotspots } from './features/hotspots.js';
import { initMenuCollapsible } from './menu-collapsible.js';
import { initInitialView } from './features/initial-view.js';
import { reloadInitialViews } from './marzipano-viewer.js';
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
        const id = resolveProjectId(projects, getProjectId());
        const project = Array.isArray(projects) ? projects.find(p => p.id === id) : null;
        if (project && project.name) setProjectName(project.name);
      } catch {}
    })();
    initViewer();
    loadImages(cleanupHotspotsForDeletedImages);
    initFloorplans();
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
      loadImages(cleanupHotspotsForDeletedImages);
    });
    socket.on('panos:order', (payload) => {
      loadImages(cleanupHotspotsForDeletedImages);
    });
    socket.on('pano:renamed', (payload) => {
      try { updateInitialViewForRenamedImage(payload.oldFilename, payload.newFilename); } catch (e) {}
      try { updateHotspotsForRenamedImage(payload.oldFilename, payload.newFilename); } catch (e) {}
      try { floorplanApi.updateForRenamedPano(payload.oldFilename, payload.newFilename); } catch (e) {}
      loadImages(cleanupHotspotsForDeletedImages);
    });
    socket.on('pano:updated', (payload) => {
      loadImages(cleanupHotspotsForDeletedImages);
    });
    socket.on('pano:removed', (payload) => {
      loadImages(cleanupHotspotsForDeletedImages);
    });
    socket.on('hotspots:changed', (payload) => {
      try { reloadHotspots(); } catch (e) {}
    });
    socket.on('initial-views:changed', async (payload) => {
      try { await reloadInitialViews(); } catch (e) {}
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
