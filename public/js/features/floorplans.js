import { appendProjectParams, getFloorplanBase } from '../project-context.js';

function selectEl(id) {
  return document.getElementById(id);
}

export function initFloorplans() {
  const panoTab = selectEl('pano-scenes');
  const floorTab = selectEl('pano-floorplan');
  const panoList = selectEl('pano-image-list');
  const floorList = selectEl('pano-floorplan-list');
  const addPlanBtn = selectEl('add-plan-btn');
  const addFloorInput = selectEl('add-floorplan');

  if (!panoTab || !floorTab || !panoList || !floorList) return;

  const previewContainer = document.createElement('div');
  previewContainer.id = 'floorplan-preview';
  previewContainer.className = 'floorplan-preview';
  previewContainer.innerHTML = '<img id="floorplan-preview-img" alt="Floor plan">';
  const viewerWrap = document.getElementById('pano-viewer-wrap');
  if (viewerWrap) {
    viewerWrap.appendChild(previewContainer);
  }
  const previewImg = previewContainer.querySelector('img');

  function showPanos() {
    panoTab.classList.add('active-tab');
    floorTab.classList.remove('active-tab');
    panoList.style.display = 'block';
    floorList.style.display = 'none';
    // Hide floorplan preview when switching back to panoramic scenes
    previewContainer.style.display = 'none';
  }

  function showFloorplans() {
    panoTab.classList.remove('active-tab');
    floorTab.classList.add('active-tab');
    panoList.style.display = 'none';
    floorList.style.display = 'block';
  }

  panoTab.addEventListener('click', showPanos);
  floorTab.addEventListener('click', showFloorplans);

  // Default state
  showPanos();

  function showPreview(filename) {
    if (!previewImg) return;
    const base = getFloorplanBase();
    previewImg.src = `${base}/${encodeURIComponent(filename)}`;
    previewContainer.style.display = 'block';
  }

  function clearFloorplanItems() {
    // Keep the last <li> that wraps the "+" button; remove others.
    const items = Array.from(floorList.querySelectorAll('li'));
    if (items.length === 0) return;
    const last = items[items.length - 1];
    items.slice(0, -1).forEach((li) => li.remove());
    // Ensure "+" li remains last
    floorList.appendChild(last);
  }

  async function loadFloorplans() {
    try {
      const res = await fetch(appendProjectParams('/api/floorplans'));
      if (!res.ok) return;
      const files = await res.json();
      clearFloorplanItems();
      const plusLi = floorList.querySelector('li:last-child') || null;
      files.forEach((filename) => {
        const li = document.createElement('li');
        li.textContent = filename;
        li.addEventListener('click', () => showPreview(filename));
        if (plusLi) {
          floorList.insertBefore(li, plusLi);
        } else {
          floorList.appendChild(li);
        }
      });
    } catch (e) {
      console.error('Error loading floorplans', e);
    }
  }

  if (addPlanBtn && addFloorInput) {
    addPlanBtn.addEventListener('click', () => addFloorInput.click());
    addFloorInput.addEventListener('change', async () => {
      const files = Array.from(addFloorInput.files || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach((file) => formData.append('floorplan', file));
      try {
        const res = await fetch(appendProjectParams('/upload-floorplan'), {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          console.error('Failed to upload floorplans');
        } else {
          await loadFloorplans();
        }
      } catch (e) {
        console.error('Error uploading floorplans', e);
      } finally {
        addFloorInput.value = '';
      }
    });
  }

  loadFloorplans();
}

