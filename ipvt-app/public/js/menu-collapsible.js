export function initMenuCollapsible() {
  const sidebarBTN = document.getElementById("pano-sidebar-btn");
  const sidebarIMG = sidebarBTN ? sidebarBTN.querySelector('img') : null;
  const sidebarWrapper = document.getElementById("pano-sidebar-wrapper");
  const sidebarContainer = document.getElementById("pano-sidebar-container");
  const isViewer = document.body && document.body.classList && document.body.classList.contains('viewer');

  if (sidebarBTN && sidebarWrapper) {
    sidebarBTN.addEventListener("click", () => {
      sidebarWrapper.classList.toggle("collapsed");
      if (sidebarWrapper.classList.contains("collapsed")) {
        sidebarIMG.src = "../assets/side-bar-show.png";
      } else {
        sidebarIMG.src = "../assets/side-bar-hide.png";
      }
    });
  }

  // Viewer only: swipe left on the sidebar to hide it (mobile/tablet).
  if (isViewer && sidebarWrapper && sidebarContainer) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    sidebarContainer.addEventListener('pointerdown', (e) => {
      if (!e || e.pointerType !== 'touch') return;
      if (sidebarWrapper.classList.contains('collapsed')) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try {
        sidebarContainer.setPointerCapture(e.pointerId);
      } catch (_err) {}
    });
    sidebarContainer.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < 18) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.25) return;
      if (dx < -60) {
        pointerId = null;
        sidebarWrapper.classList.add('collapsed');
        if (sidebarIMG) sidebarIMG.src = "../assets/side-bar-show.png";
        try {
          sidebarContainer.releasePointerCapture(e.pointerId);
        } catch (_err) {}
      }
    });
    sidebarContainer.addEventListener('pointerup', (e) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      try {
        sidebarContainer.releasePointerCapture(e.pointerId);
      } catch (_err) {}
    });
    sidebarContainer.addEventListener('pointercancel', (e) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      try {
        sidebarContainer.releasePointerCapture(e.pointerId);
      } catch (_err) {}
    });
  }
}
