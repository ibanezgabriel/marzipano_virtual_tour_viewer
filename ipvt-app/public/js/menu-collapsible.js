export function initMenuCollapsible() {
  const sidebarBTN = document.getElementById("pano-sidebar-btn");
  const sidebarIMG = sidebarBTN.querySelector('img');
  const sidebarWrapper = document.getElementById("pano-sidebar-wrapper");

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
}