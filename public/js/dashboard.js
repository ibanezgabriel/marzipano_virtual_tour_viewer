const projectListEl = document.getElementById('project-list');
const emptyStateEl = document.getElementById('empty-state');
const projectSearchInput = document.getElementById('project-search-input');
const newProjectModal = document.getElementById('new-project-modal');
const newProjectNumberInput = document.getElementById('new-project-number');
const newProjectNameInput = document.getElementById('new-project-name');
const newProjectErrorEl = document.getElementById('new-project-error');
const modalCreateBtn = document.getElementById('modal-create');
const modalCancelBtn = document.getElementById('modal-cancel');
const openProjectModal = document.getElementById('open-project-modal');
const openProjectListEl = document.getElementById('open-project-list');
const openProjectSearchInput = document.getElementById('open-project-search-input');
const openModalCloseBtn = document.getElementById('open-modal-close');
const renameProjectModal = document.getElementById('rename-project-modal');
const renameProjectNumberInput = document.getElementById('rename-project-number');
const renameProjectNameInput = document.getElementById('rename-project-name');
const renameProjectStatusSelect = document.getElementById('rename-project-status');
const renameProjectErrorEl = document.getElementById('rename-project-error');
const renameModalCancelBtn = document.getElementById('rename-modal-cancel');
const renameModalSaveBtn = document.getElementById('rename-modal-save');
import { io } from '/socket.io/socket.io.esm.min.js';

const MAX_PROJECT_NAME_LENGTH = 150;
const MAX_PROJECT_NUMBER_LENGTH = 20;
const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);
let allProjects = [];
let openProjectProjects = [];
const SEARCH_FADE_MS = 140;
let searchFadeOutTimer = null;
let searchFadeInTimer = null;

// Ensure project number input only allows alphanumeric characters and "-"
if (newProjectNumberInput) {
  newProjectNumberInput.addEventListener('input', (e) => {
    let value = e.target.value || '';
    // Strip disallowed characters and enforce max length
    value = value.replace(/[^A-Za-z0-9-]+/g, '').slice(0, MAX_PROJECT_NUMBER_LENGTH);
    if (e.target.value !== value) e.target.value = value;
  });
  newProjectNumberInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text') || '';
    const filtered = paste.replace(/[^A-Za-z0-9-]+/g, '');
    const el = e.target;
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    let newValue = (el.value.slice(0, start) + filtered + el.value.slice(end)).replace(/[^A-Za-z0-9-]+/g, '');
    if (newValue.length > MAX_PROJECT_NUMBER_LENGTH) {
      newValue = newValue.slice(0, MAX_PROJECT_NUMBER_LENGTH);
    }
    el.value = newValue;
  });
}

// Ensure rename project number input only allows alphanumeric characters and "-"
if (renameProjectNumberInput) {
  renameProjectNumberInput.addEventListener('input', (e) => {
    let value = (e.target.value || '').replace(/[^A-Za-z0-9-]+/g, '');
    if (value.length > MAX_PROJECT_NUMBER_LENGTH) {
      value = value.slice(0, MAX_PROJECT_NUMBER_LENGTH);
    }
    if (e.target.value !== value) e.target.value = value;
  });
  renameProjectNumberInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text') || '';
    const filtered = paste.replace(/[^A-Za-z0-9-]+/g, '');
    const el = e.target;
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    let newValue = (el.value.slice(0, start) + filtered + el.value.slice(end)).replace(/[^A-Za-z0-9-]+/g, '');
    if (newValue.length > MAX_PROJECT_NUMBER_LENGTH) {
      newValue = newValue.slice(0, MAX_PROJECT_NUMBER_LENGTH);
    }
    el.value = newValue;
  });
}

function normalizeProjectName(name) {
  return (name || '').trim().toLowerCase();
}

function normalizeProjectStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'in-progress') return 'on-going';
  return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
}

function mergeProjectStatuses(prevList, nextList) {
  if (!Array.isArray(nextList)) return [];
  const prevById = new Map((prevList || []).map((p) => [p.id, p]));
  return nextList.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const prev = prevById.get(p.id);
    const status = p.status !== undefined
      ? normalizeProjectStatus(p.status)
      : normalizeProjectStatus(prev && prev.status);
    return { ...p, status };
  });
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

async function createProject(name, number) {
  const status = 'in-progress';
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), number: number ? number.trim() : '', status }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to create project');
  return data;
}

async function renameProject(id, newName, newNumber, status) {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: newName.trim(),
      number: newNumber ? newNumber.trim() : '',
      status: normalizeProjectStatus(status),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to rename project');
  return data;
}

async function updateProjectStatus(project, nextStatus) {
  const status = normalizeProjectStatus(nextStatus);
  const updated = await renameProject(project.id, project.name, project.number || '', status);
  return {
    ...project,
    ...updated,
    status: updated.status !== undefined ? updated.status : status,
  };
}

function openProject(project) {
  // Prefer project number in shared URLs when available.
  const projectToken = (project.number && String(project.number).trim()) || project.id;
  const params = new URLSearchParams({ project: projectToken });
  window.location.href = `project-editor.html?${params}`;
}

function validateProjectName(name, currentName = null) {
  const trimmed = name.trim();
  if (!trimmed) return 'Project name is required.';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`;
  if (/[<>:"/\\|?*]/.test(trimmed)) return 'Project name cannot contain: < > : " / \\ | ? *';
  return null;
}

function validateProjectNumber(number, requiredMessage = 'Project number is required.') {
  const trimmed = (number || '').trim();
  if (!trimmed) return requiredMessage;
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return 'Project number can only contain letters, numbers, and "-".';
  if (trimmed.length > MAX_PROJECT_NUMBER_LENGTH) {
    return `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less.`;
  }
  return null;
}

function showRenameModal(project, nameDisplayEl) {
  renameProjectErrorEl.textContent = '';
  if (renameProjectNumberInput) {
    renameProjectNumberInput.value = project.number || '';
  }
  renameProjectNameInput.value = project.name;
  if (renameProjectStatusSelect) {
    renameProjectStatusSelect.value = normalizeProjectStatus(project.status);
  }
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
    const numberRaw = renameProjectNumberInput ? renameProjectNumberInput.value || '' : '';
    const number = numberRaw.replace(/[^A-Za-z0-9-]+/g, '').slice(0, MAX_PROJECT_NUMBER_LENGTH);
    const status = renameProjectStatusSelect
      ? normalizeProjectStatus(renameProjectStatusSelect.value)
      : normalizeProjectStatus(project.status);
    const numberError = validateProjectNumber(number, 'Project number is required.');
    if (numberError) {
      renameProjectErrorEl.textContent = numberError;
      return;
    }
    const error = validateProjectName(name, project.name);
    if (error) {
      renameProjectErrorEl.textContent = error;
      return;
    }
    // If the name is changing, enforce the "unique name" rule.
    if (name.trim() !== project.name.trim()) {
      if (projectNameExists(name, project.id)) {
        renameProjectErrorEl.textContent = 'A project with this name already exists.';
        return;
      }
    }
    // If neither name, number, nor status actually changed, do nothing.
    const currentNumber = String(project.number || '');
    const currentStatus = normalizeProjectStatus(project.status);
    if (name.trim() === project.name.trim() && number === currentNumber && status === currentStatus) {
      renameProjectErrorEl.textContent = 'No changes made.';
      return;
    }
    try {
      const updated = await renameProject(project.id, name.trim(), number, status);
      const finalProject = {
        ...project,
        ...updated,
        name: updated.name || name.trim(),
        number: updated.number !== undefined ? updated.number : number,
        status: updated.status !== undefined ? updated.status : status,
      };
      // Update in-memory list
      allProjects = allProjects.map((p) => (p.id === project.id ? finalProject : p));
      // Re-render list so both name and number reflect changes
      renderProjectList(allProjects);
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

  // cell for project number
  const numberDisplay = document.createElement('div');
  numberDisplay.className = 'project-number-display';
  numberDisplay.textContent = project.number || '';
  const numberCell = document.createElement('div');
  numberCell.className = 'project-number-cell';
  numberCell.appendChild(numberDisplay);

  // cell for project name
  const nameDisplay = document.createElement('div');
  nameDisplay.className = 'project-name-display';
  nameDisplay.textContent = project.name;
  const nameCell = document.createElement('div');
  nameCell.className = 'project-name-cell';
  nameCell.appendChild(nameDisplay);

  // cell for status
  const statusDisplay = document.createElement('span');
  statusDisplay.className = 'project-status-display project-status-text';
  const normalizedStatus = normalizeProjectStatus(project.status);
  statusDisplay.textContent = normalizedStatus === 'completed' ? 'Completed' : 'On-Going';
  statusDisplay.classList.toggle('status-completed', normalizedStatus === 'completed');
  statusDisplay.classList.toggle('status-ongoing', normalizedStatus === 'on-going');
  const statusCell = document.createElement('div');
  statusCell.className = 'project-status-cell';
  statusCell.appendChild(statusDisplay);

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn-open';
  viewBtn.title = "View"
  const viewIcon = document.createElement('img')
  viewIcon.src = "../assets/icons/view1.png";
  viewIcon.style.height = '20px';
  viewIcon.style.width = '20px';
  viewBtn.appendChild(viewIcon)

  // Store original and hover image paths
  const viewOrigIcon = "../assets/icons/view1.png";
  const viewHoverIcon = "../assets/icons/view2.png";

  // Change image on hover
  viewBtn.addEventListener("mouseenter", () => {
    viewIcon.src = viewHoverIcon;
  });

  viewBtn.addEventListener("mouseleave", () => {
    viewIcon.src = viewOrigIcon;
  });

  const editBTN = document.createElement('button');
  editBTN.type = 'button';
  editBTN.className = 'btn-edit';
  editBTN.title = "Edit"
  // editBTN.textContent = 'Rename';
  const renameIcon = document.createElement('img');
  renameIcon.src = "../assets/icons/edit1.png"
  renameIcon.style.height = "20px";
  renameIcon.style.width = "20px";
  editBTN.appendChild(renameIcon)

  const renameOrigIcon = "../assets/icons/edit1.png";
  const renameHoverIcon = "../assets/icons/edit2.png";

  // Change image on hover
  editBTN.addEventListener("mouseenter", () => {
    renameIcon.src = renameHoverIcon;
  });

  editBTN.addEventListener("mouseleave", () => {
    renameIcon.src = renameOrigIcon;
  })

  // Prefer project number in shared URLs when available.
  const projectToken = (project.number && String(project.number).trim()) || project.id;

  viewBtn.onclick = () => {
    const params = new URLSearchParams({ project: projectToken });
    window.open(`project-viewer.html?${params}`, '_blank');
  };

  // Make the entire row clickable to open the project,
  // but ignore clicks that originate from the action buttons.
  row.onclick = (e) => {
    if (e.target.closest('button')) return;
    const params = new URLSearchParams({ project: projectToken });
    window.location.href = `project-editor.html?${params}`;
  };

  editBTN.onclick = () => showRenameModal(project, nameDisplay);

  // group buttons into their own cell
  const actionsCell = document.createElement('div');
  actionsCell.className = 'project-actions-cell';
  actionsCell.append(viewBtn, editBTN);

  row.append(numberCell, nameCell, statusCell, actionsCell);
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

function renderOpenProjectList(projects) {
  if (!openProjectListEl) return;
  openProjectListEl.innerHTML = '';
  if (!projects || projects.length === 0) {
    openProjectListEl.innerHTML = '<p class="empty-state">No projects yet.</p>';
    return;
  }
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

function renderProjectListWithSearchAnimation(projects) {
  if (!projectListEl) {
    renderProjectList(projects);
    return;
  }

  if (searchFadeOutTimer) {
    clearTimeout(searchFadeOutTimer);
    searchFadeOutTimer = null;
  }
  if (searchFadeInTimer) {
    clearTimeout(searchFadeInTimer);
    searchFadeInTimer = null;
  }

  projectListEl.classList.remove('search-fade-in');
  projectListEl.classList.add('search-fade-out');

  searchFadeOutTimer = setTimeout(() => {
    renderProjectList(projects);
    projectListEl.classList.remove('search-fade-out');
    projectListEl.classList.add('search-fade-in');

    searchFadeInTimer = setTimeout(() => {
      projectListEl.classList.remove('search-fade-in');
      searchFadeInTimer = null;
    }, SEARCH_FADE_MS);

    searchFadeOutTimer = null;
  }, SEARCH_FADE_MS);
}

function applyProjectSearch(options = {}) {
  const { animate = false } = options;
  const query = (projectSearchInput && projectSearchInput.value.trim()) || '';
  let projectsToRender = allProjects;

  if (!query) {
    projectsToRender = allProjects;
  } else {
    const q = query.toLowerCase();
    projectsToRender = allProjects.filter((p) => 
      (p.name || '').toLowerCase().includes(q) || 
      (p.number || '').toLowerCase().includes(q) ||
      normalizeProjectStatus(p.status).includes(q)
    );
  }

  if (animate) {
    renderProjectListWithSearchAnimation(projectsToRender);
  } else {
    renderProjectList(projectsToRender);
  }
}

function applyOpenProjectSearch() {
  const query = (openProjectSearchInput && openProjectSearchInput.value.trim()) || '';
  let projectsToRender = openProjectProjects;
  if (!query) {
    projectsToRender = openProjectProjects;
  } else {
    const q = query.toLowerCase();
    projectsToRender = openProjectProjects.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.number || '').toLowerCase().includes(q) ||
      normalizeProjectStatus(p.status).includes(q)
    );
  }
  renderOpenProjectList(projectsToRender);
}

async function loadProjects() {
  try {
    const fetched = await fetchProjects();
    allProjects = mergeProjectStatuses(allProjects, fetched);
    renderProjectList(allProjects);
  } catch (e) {
    emptyStateEl.textContent = 'Error loading projects: ' + e.message;
    emptyStateEl.style.display = 'block';
  }
}

document.getElementById('btn-new-project').onclick = () => {
  newProjectNumberInput.value = '';
  newProjectNameInput.value = '';
  if (newProjectErrorEl) newProjectErrorEl.textContent = '';
  newProjectModal.classList.add('visible');
  newProjectNumberInput.focus();
};

modalCancelBtn.onclick = () => {
  newProjectModal.classList.remove('visible');
};

modalCreateBtn.onclick = async () => {
  const numberRaw = (newProjectNumberInput.value || '').trim();
  const number = numberRaw.replace(/[^A-Za-z0-9-]+/g, '').slice(0, MAX_PROJECT_NUMBER_LENGTH);
  const name = newProjectNameInput.value.trim();
  const numberError = validateProjectNumber(number, 'Please enter a project number.');
  if (numberError) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = numberError;
    return;
  }
  if (!name) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = 'Please enter a project name.';
    return;
  }
  if (projectNameExists(name)) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = 'A project with this name already exists.';
    return;
  }
  try {
    const created = await createProject(name, number);
    // Avoid duplicating the project if the realtime socket already added it
    if (!allProjects.some(p => p.id === created.id)) {
      allProjects.push(created);
    } else {
      allProjects = allProjects.map(p => p.id === created.id ? created : p);
    }
    renderProjectList(allProjects);
    newProjectModal.classList.remove('visible');
  } catch (e) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = e.message || 'Failed to create project.';
  }
};

document.getElementById('btn-open-project').onclick = async () => {
  try {
    const projects = await fetchProjects();
    openProjectProjects = mergeProjectStatuses(allProjects, projects);
    if (openProjectSearchInput) {
      openProjectSearchInput.value = '';
    }
    applyOpenProjectSearch();
    openProjectModal.classList.add('visible');
    if (openProjectSearchInput) openProjectSearchInput.focus();
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
  projectSearchInput.addEventListener('input', () => applyProjectSearch({ animate: true }));
  projectSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      projectSearchInput.value = '';
      applyProjectSearch({ animate: true });
      projectSearchInput.blur();
    }
  });
}

if (openProjectSearchInput) {
  openProjectSearchInput.addEventListener('input', () => applyOpenProjectSearch());
  openProjectSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      openProjectSearchInput.value = '';
      applyOpenProjectSearch();
      openProjectSearchInput.blur();
    }
  });
}

loadProjects();

// Realtime updates: update project list when other clients change it
try {
  const socket = io();
  socket.on('projects:changed', (projects) => {
    if (!Array.isArray(projects)) return;
    allProjects = mergeProjectStatuses(allProjects, projects);
    applyProjectSearch();
    if (openProjectModal && openProjectModal.classList.contains('visible')) {
      openProjectProjects = mergeProjectStatuses(openProjectProjects, projects);
      applyOpenProjectSearch();
    }
  });
} catch (e) {
  // ignore if sockets unavailable
}
