const projectListEl = document.getElementById('project-list');
const emptyStateEl = document.getElementById('empty-state');
const projectSearchInput = document.getElementById('project-search-input');
const newProjectModal = document.getElementById('new-project-modal');
const newProjectNameInput = document.getElementById('new-project-name');
const newProjectErrorEl = document.getElementById('new-project-error');
const modalCreateBtn = document.getElementById('modal-create');
const modalCancelBtn = document.getElementById('modal-cancel');
const openProjectModal = document.getElementById('open-project-modal');
const openProjectListEl = document.getElementById('open-project-list');
const openModalCloseBtn = document.getElementById('open-modal-close');
const renameProjectModal = document.getElementById('rename-project-modal');
const renameProjectNameInput = document.getElementById('rename-project-name');
const renameProjectErrorEl = document.getElementById('rename-project-error');
const renameModalCancelBtn = document.getElementById('rename-modal-cancel');
const renameModalSaveBtn = document.getElementById('rename-modal-save');
const deleteProjectModal = document.getElementById('delete-project-modal');
const deleteProjectTextEl = document.getElementById('delete-project-text');
const deleteModalCancelBtn = document.getElementById('delete-modal-cancel');
const deleteModalConfirmBtn = document.getElementById('delete-modal-confirm');

// Import dialog functions for delete progress
import { showProgressDialog, hideProgressDialog, updateProgressDialog, setProgressDialogMessage } from './dialog.js';

const MAX_PROJECT_NAME_LENGTH = 100;
let allProjects = [];

function normalizeProjectName(name) {
  return (name || '').trim().toLowerCase();
}

function projectNameExists(name, excludeId = null) {
  const n = normalizeProjectName(name);
  if (!n) return false;
  return allProjects.some((p) => normalizeProjectName(p.name) === n && (!excludeId || p.id !== excludeId));
}

/** Sanitize string for URL/folder id */
function toProjectId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

async function fetchProjects() {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error('Failed to load projects');
  return res.json();
}

async function createProject(name) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to create project');
  return data;
}

async function renameProject(id, newName) {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName.trim() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to rename project');
  return data;
}

async function deleteProject(id) {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to delete project');
  return data;
}

function openProject(project) {
  const params = new URLSearchParams({ project: project.id });
  window.location.href = `admin.html?${params}`;
}

function validateProjectName(name, currentName = null) {
  const trimmed = name.trim();
  if (!trimmed) return 'Project name is required.';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`;
  if (/[<>:"/\\|?*]/.test(trimmed)) return 'Project name cannot contain: < > : " / \\ | ? *';
  if (currentName && trimmed === currentName.trim()) return 'No changes made.';
  return null;
}

function showRenameModal(project, nameDisplayEl) {
  renameProjectErrorEl.textContent = '';
  renameProjectNameInput.value = project.name;
  renameProjectModal.classList.add('visible');
  renameProjectNameInput.focus();
  renameProjectNameInput.select();

  const cleanup = () => {
    renameModalCancelBtn.onclick = null;
    renameModalSaveBtn.onclick = null;
    renameProjectNameInput.onkeydown = null;
    renameProjectModal.classList.remove('visible');
    renameProjectModal.onclick = null;
  };

  renameModalCancelBtn.onclick = cleanup;

  renameModalSaveBtn.onclick = async () => {
    const name = renameProjectNameInput.value;
    const error = validateProjectName(name, project.name);
    if (error) {
      renameProjectErrorEl.textContent = error;
      return;
    }
    if (projectNameExists(name, project.id)) {
      renameProjectErrorEl.textContent = 'A project with this name already exists.';
      return;
    }
    try {
      const updated = await renameProject(project.id, name.trim());
      project.name = updated.name || name.trim();
      project.id = updated.id || project.id;
      nameDisplayEl.textContent = project.name;
      const row = nameDisplayEl.closest('.project-row');
      if (row) row.dataset.projectId = project.id;
      cleanup();
    } catch (e) {
      renameProjectErrorEl.textContent = e.message || 'Failed to rename project.';
    }
  };

  renameProjectNameInput.onkeydown = (e) => {
    if (e.key === 'Escape') cleanup();
    if (e.key === 'Enter') {
      e.preventDefault();
      renameModalSaveBtn.click();
    }
  };

  renameProjectModal.onclick = (e) => {
    if (e.target === renameProjectModal) cleanup();
  };
}

function showDeleteModal(project, rowEl) {
  deleteProjectTextEl.textContent = `Are you sure you want to delete "${project.name}"? This cannot be undone.`;
  deleteProjectModal.classList.add('visible');
  deleteModalConfirmBtn.focus();

  const cleanup = () => {
    deleteModalCancelBtn.onclick = null;
    deleteModalConfirmBtn.onclick = null;
    deleteProjectModal.onclick = null;
    deleteProjectModal.classList.remove('visible');
  };

  deleteModalCancelBtn.onclick = cleanup;

  deleteModalConfirmBtn.onclick = async () => {
    cleanup(); // Close the confirmation modal
    
    try {
      // Show deleting progress dialog
      showProgressDialog('Deleting project...');
      setProgressDialogMessage(`Deleting "${project.name}"...`);
      
      // Simulate progress since delete is usually fast
      updateProgressDialog(10);
      
      // Add a small delay to show progress
      await new Promise(resolve => setTimeout(resolve, 300));
      updateProgressDialog(50);
      
      await deleteProject(project.id);
      
      updateProgressDialog(90);
      
      allProjects = allProjects.filter((p) => p.id !== project.id);
      applyProjectSearch();
      
      updateProgressDialog(100);
      
      // Add a small delay to show completion
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Hide progress dialog when done
      hideProgressDialog();
    } catch (e) {
      // Hide progress dialog and show error
      hideProgressDialog();
      alert(e.message);
    }
  };

  deleteProjectModal.onclick = (e) => {
    if (e.target === deleteProjectModal) cleanup();
  };
}

function renderProjectRow(project) {
  const row = document.createElement('div');
  row.className = 'project-row';
  row.dataset.projectId = project.id;

  const nameDisplay = document.createElement('div');
  nameDisplay.className = 'project-name-display';
  nameDisplay.textContent = project.name;

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn-open';
  // viewBtn.textContent = 'View';
  const viewIcon = document.createElement('img')
  viewIcon.src = "../assets/p-view.png";
  viewIcon.style.height = '20px';
  viewIcon.style.width = '20px';
  viewBtn.appendChild(viewIcon)

  // Store original and hover image paths
const viewOrigIcon = "../assets/p-view.png";
const viewHoverIcon = "../assets/w-view.png";

// Change image on hover
viewBtn.addEventListener("mouseenter", () => {
  viewIcon.src = viewHoverIcon;
});

viewBtn.addEventListener("mouseleave", () => {
  viewIcon.src = viewOrigIcon;
});

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn-rename';
  // renameBtn.textContent = 'Rename';
  const renameIcon = document.createElement('img');
  renameIcon.src = "../assets/p-rename.png"
  renameIcon.style.height = "20px";
  renameIcon.style.width = "20px";
  renameBtn.appendChild(renameIcon)

  const renameOrigIcon = "../assets/p-rename.png";
  const renameHoverIcon = "../assets/w-rename.png";

// Change image on hover
  renameBtn.addEventListener("mouseenter", () => {
    renameIcon.src = renameHoverIcon;
  });

  renameBtn.addEventListener("mouseleave", () => {
    renameIcon.src = renameOrigIcon;
  })

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-delete';
  const deleteIcon = document.createElement('img');
  // deleteBtn.textContent = 'Delete';
  deleteIcon.src = "../assets/p-delete.png"
  deleteIcon.style.height = "20px";
  deleteIcon.style.width = "20px";
  deleteBtn.appendChild(deleteIcon)

  const deleteOrigIcon = "../assets/p-delete.png";
  const deleteHoverIcon = "../assets/w-delete.png";

  // Change image on hover
  deleteBtn.addEventListener("mouseenter", () => {
    deleteIcon.src = deleteHoverIcon;
  });

  deleteBtn.addEventListener("mouseleave", () => {
    deleteIcon.src = deleteOrigIcon;
  })

  viewBtn.onclick = () => {
    const params = new URLSearchParams({ project: project.id });
    window.open(`client.html?${params}`, '_blank');
  };

  // Make the entire row clickable to open the project,
  // but ignore clicks that originate from the action buttons.
  row.onclick = (e) => {
    if (e.target.closest('button')) return;
    const params = new URLSearchParams({ project: project.id });
    window.location.href = `admin.html?${params}`;
  };

  renameBtn.onclick = () => showRenameModal(project, nameDisplay);

  deleteBtn.onclick = () => showDeleteModal(project, row);

  row.append(nameDisplay, viewBtn, renameBtn, deleteBtn);
  return row;
}

function updateEmptyState() {
  const count = projectListEl.querySelectorAll('.project-row').length;
  emptyStateEl.style.display = count === 0 ? 'block' : 'none';
}

function renderProjectList(projects) {
  projectListEl.innerHTML = '';
  for (const p of projects) {
    projectListEl.appendChild(renderProjectRow(p));
  }
  updateEmptyState();
}

function applyProjectSearch() {
  const query = (projectSearchInput && projectSearchInput.value.trim()) || '';
  if (!query) {
    renderProjectList(allProjects);
    return;
  }
  const q = query.toLowerCase();
  const filtered = allProjects.filter((p) => (p.name || '').toLowerCase().includes(q));
  renderProjectList(filtered);
}

async function loadProjects() {
  try {
    allProjects = await fetchProjects();
    renderProjectList(allProjects);
  } catch (e) {
    emptyStateEl.textContent = 'Error loading projects: ' + e.message;
    emptyStateEl.style.display = 'block';
  }
}

document.getElementById('btn-new-project').onclick = () => {
  newProjectNameInput.value = '';
  if (newProjectErrorEl) newProjectErrorEl.textContent = '';
  newProjectModal.classList.add('visible');
  newProjectNameInput.focus();
};

modalCancelBtn.onclick = () => {
  newProjectModal.classList.remove('visible');
};

modalCreateBtn.onclick = async () => {
  const name = newProjectNameInput.value.trim();
  if (!name) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = 'Please enter a project name.';
    return;
  }
  if (projectNameExists(name)) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = 'A project with this name already exists.';
    return;
  }
  try {
    const created = await createProject(name);
    allProjects.push(created);
    renderProjectList(allProjects);
    newProjectModal.classList.remove('visible');
  } catch (e) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = e.message || 'Failed to create project.';
  }
};

document.getElementById('btn-open-project').onclick = async () => {
  try {
    const projects = await fetchProjects();
    openProjectListEl.innerHTML = '';
    if (projects.length === 0) {
      openProjectListEl.innerHTML = '<p class="empty-state">No projects yet.</p>';
    } else {
      for (const p of projects) {
        const row = document.createElement('div');
        row.className = 'project-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'project-name-input';
        input.value = p.name;
        input.disabled = true;
        input.style.cursor = 'pointer';
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-open-modal';
        openBtn.textContent = 'Open';
        openBtn.onclick = () => {
          openProjectModal.classList.remove('visible');
          openProject(p);
        };
        input.onclick = () => openProject(p);
        row.append(input, openBtn);
        openProjectListEl.appendChild(row);
      }
    }
    openProjectModal.classList.add('visible');
  } catch (e) {
    alert('Error loading projects: ' + e.message);
  }
};

openModalCloseBtn.onclick = () => {
  openProjectModal.classList.remove('visible');
};

newProjectModal.onclick = (e) => {
  if (e.target === newProjectModal) newProjectModal.classList.remove('visible');
};
openProjectModal.onclick = (e) => {
  if (e.target === openProjectModal) openProjectModal.classList.remove('visible');
};

if (projectSearchInput) {
  projectSearchInput.addEventListener('input', applyProjectSearch);
  projectSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      projectSearchInput.value = '';
      applyProjectSearch();
      projectSearchInput.blur();
    }
  });
}

loadProjects();
