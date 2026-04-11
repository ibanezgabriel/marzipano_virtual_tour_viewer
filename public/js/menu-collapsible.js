export function initMenuCollapsible() {
  const sidebarBTN = document.getElementById("pano-sidebar-btn");
  const sidebarIMG = sidebarBTN ? sidebarBTN.querySelector("img") : null;
  const sidebarWrapper = document.getElementById("pano-sidebar-wrapper");

  if (sidebarBTN && sidebarWrapper) {
    sidebarBTN.addEventListener("click", () => {
      sidebarWrapper.classList.toggle("collapsed");
      if (sidebarWrapper.classList.contains("collapsed")) {
        if (sidebarIMG) sidebarIMG.src = "assets/side-bar-show.png";
      } else {
        if (sidebarIMG) sidebarIMG.src = "assets/side-bar-hide.png";
      }
    });
  }
}
