/**
 * Homepage: project list, New Project, Open Project, Rename, Delete
 */

const projectListEl = document.getElementById('project-list');
const emptyStateEl = document.getElementById('empty-state');
const newProjectModal = document.getElementById('new-project-modal');
const newProjectNameInput = document.getElementById('new-project-name');
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

const MAX_PROJECT_NAME_LENGTH = 100;

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
    try {
      const updated = await renameProject(project.id, name.trim());
      project.name = updated.name || name.trim();
      nameDisplayEl.textContent = project.name;
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
  viewBtn.textContent = 'View';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn-rename';
  renameBtn.textContent = 'Rename';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = 'Delete';

  viewBtn.onclick = () => {
    const params = new URLSearchParams({ project: project.id });
    window.location.href = `client.html?${params}`;
  };

  renameBtn.onclick = () => showRenameModal(project, nameDisplay);

  deleteBtn.onclick = async () => {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    try {
      await deleteProject(project.id);
      row.remove();
      updateEmptyState();
    } catch (e) {
      alert(e.message);
    }
  };

  row.append(nameDisplay, viewBtn, renameBtn, deleteBtn);
  return row;
}

function updateEmptyState() {
  const count = projectListEl.querySelectorAll('.project-row').length;
  emptyStateEl.style.display = count === 0 ? 'block' : 'none';
}

async function loadProjects() {
  try {
    const projects = await fetchProjects();
    projectListEl.innerHTML = '';
    for (const p of projects) {
      projectListEl.appendChild(renderProjectRow(p));
    }
    updateEmptyState();
  } catch (e) {
    emptyStateEl.textContent = 'Error loading projects: ' + e.message;
    emptyStateEl.style.display = 'block';
  }
}

document.getElementById('btn-new-project').onclick = () => {
  newProjectNameInput.value = '';
  newProjectModal.classList.add('visible');
  newProjectNameInput.focus();
};

modalCancelBtn.onclick = () => {
  newProjectModal.classList.remove('visible');
};

modalCreateBtn.onclick = async () => {
  const name = newProjectNameInput.value.trim();
  if (!name) {
    alert('Please enter a project name');
    return;
  }
  try {
    const created = await createProject(name);
    projectListEl.appendChild(renderProjectRow(created));
    updateEmptyState();
    newProjectModal.classList.remove('visible');
    openProject(created);
  } catch (e) {
    alert(e.message);
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
        input.readOnly = true;
        input.style.cursor = 'pointer';
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-open';
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

loadProjects();
