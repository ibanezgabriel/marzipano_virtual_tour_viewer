import Marzipano from "https://cdn.skypack.dev/marzipano";
// const Marzipano = require("https://cdn.skypack.dev/marzipano");
const imageListEl = document.getElementById('pano-image-list');

const panoViewerEl = document.getElementById('pano-viewer');
const listBtnEl = document.getElementById('pano-list-btn');
const deleteBtnEl = document.getElementById('pano-delete-btn');
const updateBtnEl = document.getElementById('pano-update-btn');
const renameBtnEl = document.getElementById('pano-rename-btn');

//hide the list of panoramic images
listBtnEl.addEventListener('click', ()=> {
    imageListEl.style.display =
    imageListEl.style.display === "block" ? "none" : "block";
})

// --- constants ---
const MAX_FOV = 100 * Math.PI / 180;
const MIN_FOV = 30 * Math.PI / 180;
const IMAGE_WIDTH = 4000;

let viewer = null;
let currentScene = null;
let currentImagePath = null;
let selectedImageName = null; // Track selected image

// Initialize Marzipano viewer
function initViewer() {
  if (!panoViewerEl) {
    console.error('#pano element not found');
    return null;
  }
  viewer = new Marzipano.Viewer(panoViewerEl);
  console.log('Marzipano viewer initialized');
  return viewer;
}

// Load a panorama image into Marzipano
function loadPanorama(imagePath, imageName) {
  // Prevent reloading the same image
  if (currentImagePath === imagePath) {
    return;
  }
  currentImagePath = imagePath;
  selectedImageName = imageName; // Store selected image name
  
  // Ensure viewer is initialized
  if (!viewer) {
    viewer = initViewer();
    console.error('Viewer not initialized');
    return;
  }

  const source = Marzipano.ImageUrlSource.fromString(imagePath);
  const geometry = new Marzipano.EquirectGeometry([
    { width: IMAGE_WIDTH }
  ]);
  const limiter = Marzipano.RectilinearView.limit.traditional(
    MIN_FOV,
    MAX_FOV
  );
  const view = new Marzipano.RectilinearView(
    { 
      yaw: 0, 
      pitch: 0, 
      fov: Math.PI / 2
    },
    limiter
  );
  currentScene = viewer.createScene({
    source,
    geometry,
    view,
  });
  // Use a short timeout to allow Marzipano to sync DOM state
  currentScene.switchTo();
  
  // Update active state in list
  const allImages = document.querySelectorAll('#pano-image-list li')
  allImages.forEach(li => {
    li.classList.remove('active');
  });
  const activeLi = Array.from(document.querySelectorAll('#pano-image-list li'))
    .find(li => li.textContent === imageName);
  if (activeLi) {
    activeLi.classList.add('active');
  }
}

// Load and display list of images
async function loadImages() {
  try {
    const res = await fetch("upload");
    const files = await res.json();

    imageListEl.innerHTML = "";

    // Ensure viewer is initialized before assigning click handlers
    if (!viewer) {
      viewer = initViewer();
      if (!viewer) {
        console.error('Viewer not initialized');
        return;
      }
    }

    files.forEach(file => {
      const li = document.createElement("li");
      li.textContent = file;
      li.onclick = () => loadPanorama(`/upload/${file}`, file);
      imageListEl.appendChild(li);
    });

    // Load first image if available
    if (files.length > 0) {
      loadPanorama(`/upload/${files[0]}`, files[0]);
    } else {
      // Clear viewer if no images
      currentImagePath = null;
      selectedImageName = null;
    }
  } catch (error) {
    alert('Error loading images: ' + error);
  }
}

// Handle rename button
renameBtnEl.addEventListener('click', async () => {
  if (!selectedImageName) {
    alert('Please select an image to rename');
    return;
  }

  // Get file extension
  const lastDotIndex = selectedImageName.lastIndexOf('.');
  const extension = lastDotIndex > -1 ? selectedImageName.substring(lastDotIndex) : '';
  const nameWithoutExt = lastDotIndex > -1 ? selectedImageName.substring(0, lastDotIndex) : selectedImageName;

  const newName = prompt(`Enter new name for "${selectedImageName}":`, nameWithoutExt);
  
  if (!newName || newName.trim() === '') {
    return; // User cancelled or entered empty name
  }
  // Add extension if not provided
  const newFileName = newName.includes('.') ? newName : newName + extension;
  // Validate filename
  if (newFileName.includes('/') || newFileName.includes('\\') || newFileName.includes('..')) {
    alert('Invalid filename. Please avoid special characters like / \\ ..');
    return;
  }

  try {
    const res = await fetch('/upload/rename', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        oldFilename: selectedImageName,
        newFilename: newFileName
      })
    });

    const data = await res.json();
    
    if (data.success) {
      // Update selected image name
      currentImagePath = null;
      selectedImageName = newFileName;
      
      // Reload images and select the renamed one
      await loadImages();
      loadPanorama(`/upload/${newFileName}`, newFileName);
    } else {
      alert('Error renaming image: ' + data.message);
    }
  } catch (error) {
    alert('Error renaming image: ' + error);
  }
});

// Handle update button
updateBtnEl.addEventListener('click', () => {
  if (!selectedImageName) {
    alert('Please select an image to update');
    return;
  }

  // Create a hidden file input for update
  const updateInput = document.createElement('input');
  updateInput.type = 'file';
  updateInput.accept = 'image/*';
  updateInput.style.display = 'none';
  
  updateInput.addEventListener('change', async () => {
    const file = updateInput.files[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append('panorama', file);
    formData.append('oldFilename', selectedImageName);

    try {
      const res = await fetch('/upload/update', {
        method: 'PUT',
        body: formData
      });

      const data = await res.json();
      
      if (data.success) {
        // Force reload the updated image by clearing cache
        currentImagePath = null;
        // Reload images and select the updated one
        await loadImages();
        // Find and load the new image
        const newImagePath = `/upload/${data.newFilename}`;
        loadPanorama(newImagePath, data.newFilename);
      } else {
        alert('Error updating image: ' + data.message);
      }
    } catch (error) {
      alert('Error updating image: ' + error);
    }
    
    // Clean up
    document.body.removeChild(updateInput);
  });

  document.body.appendChild(updateInput);
  updateInput.click();
});

// Handle delete button
deleteBtnEl.addEventListener('click', async () => {
  if (!selectedImageName) {
    alert('Please select an image to delete');
    return;
  }

  const confirmDelete = confirm(`Are you sure you want to delete "${selectedImageName}"?`);
  if (!confirmDelete) {
    return;
  }

  try {
    const res = await fetch(`/upload/${selectedImageName}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    
    if (data.success) {
      currentImagePath = null;
      selectedImageName = null;
      loadImages(); // Reload the list
    } else {
      alert('Error deleting image: ' + data.message);
    }
  } catch (error) {
    alert('Error deleting image: ' + error);
  }
});

// Handle file upload
const addPanoEl = document.getElementById('add-scene');
addPanoEl.addEventListener("change", async () => {
    const files = addPanoEl.files;
    const formData = new FormData();
    if (!files) {
        return;
    } else {
        for (let i=0; i<files.length; i++) {
        formData.append('panorama', files[i]);
    }
  }
  try {
    const res = await fetch("./upload", {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      loadImages();
    }
  } catch (error) {
    console.error('Error uploading image:', error);
  }
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  viewer = initViewer();
  loadImages();
});