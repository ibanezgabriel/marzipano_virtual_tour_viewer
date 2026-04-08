const adminListEl = document.getElementById('admin-list');
const emptyStateEl = document.getElementById('admin-empty-state');
const searchInput = document.getElementById('admin-search-input');

const createModal = document.getElementById('create-admin-modal');
const editModal = document.getElementById('edit-admin-modal');

const createBtn = document.getElementById('btn-create-admin');
const createCancel = document.getElementById('create-admin-cancel');
const createSubmit = document.getElementById('create-admin-submit');
const createError = document.getElementById('create-admin-error');

const editCancel = document.getElementById('edit-admin-cancel');
const editSave = document.getElementById('edit-admin-save');
const editError = document.getElementById('edit-admin-error');

const createUsername = document.getElementById('create-admin-username');
const createName = document.getElementById('create-admin-name');
const createPassword = document.getElementById('create-admin-password');

const editUsername = document.getElementById('edit-admin-username');
const editName = document.getElementById('edit-admin-name');
const editStatus = document.getElementById('edit-admin-status');
const editPassword = document.getElementById('edit-admin-password');

const settingsBtn = document.getElementById('settings-btn');
const editModalContent = document.getElementById('edit-admin-modal-content');
const editTitle = document.getElementById('edit-admin-title');

let admins = [];
let currentPageUser = null;
let currentEditId = null;
let currentEditMode = 'admin';

function formatAdminId(id) {
  const normalized = String(id || '').trim();
  if (/^ADM-\d+$/i.test(normalized)) {
    const digits = normalized.match(/\d+$/);
    return digits ? `ADM-${digits[0].padStart(3, '0')}` : normalized.toUpperCase();
  }
  if (/^\d+$/.test(normalized)) {
    return `ADM-${normalized.padStart(3, '0')}`;
  }
  return normalized;
}

function openModal(modal) {
  if (!modal) return;
  modal.classList.add('visible');
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('visible');
}

function resetCreateForm() {
  createUsername.value = '';
  createName.value = '';
  createPassword.value = '';
  createError.textContent = '';
}

function resetEditForm() {
  editUsername.value = '';
  editName.value = '';
  if (editStatus) editStatus.value = 'Active';
  editPassword.value = '';
  editError.textContent = '';
}

function setEmptyState(list) {
  if (!emptyStateEl) return;
  emptyStateEl.style.display = list.length === 0 ? 'block' : 'none';
}

function matchesSearch(admin, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    formatAdminId(admin.id).toLowerCase().includes(q) ||
    admin.username.toLowerCase().includes(q) ||
    admin.name.toLowerCase().includes(q) ||
    admin.statusLabel.toLowerCase().includes(q)
  );
}

function getFilteredAdmins() {
  const query = searchInput ? searchInput.value.trim() : '';
  return admins.filter((admin) => matchesSearch(admin, query));
}

function createActionButton(className, title, iconSrc) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = title;
  btn.style.background = className === 'btn-delete' ? '#c62828' : '#0d3d52';

  if (iconSrc) {
    const icon = document.createElement('img');
    icon.src = iconSrc;
    icon.style.height = '20px';
    icon.style.width = '20px';
    btn.appendChild(icon);
  } else {
    btn.textContent = title;
  }

  return btn;
}

function renderAdminList(list) {
  if (!adminListEl) return;
  adminListEl.innerHTML = '';

  list.forEach((admin) => {
    const row = document.createElement('section');
    row.className = 'project-row';
    row.dataset.adminId = String(admin.id);

    const idCell = document.createElement('div');
    idCell.className = 'project-number-cell';
    const idDisplay = document.createElement('div');
    idDisplay.className = 'project-number-display';
    idDisplay.textContent = formatAdminId(admin.id);
    idCell.appendChild(idDisplay);

    const userCell = document.createElement('div');
    userCell.className = 'project-name-cell';
    const userDisplay = document.createElement('div');
    userDisplay.className = 'project-name-display';
    userDisplay.textContent = admin.username;
    userCell.appendChild(userDisplay);

    const statusCell = document.createElement('div');
    statusCell.className = 'project-status-cell';
    const statusDisplay = document.createElement('div');
    statusDisplay.className = 'project-status-display';
    statusDisplay.textContent = admin.statusLabel;
    statusCell.appendChild(statusDisplay);

    const actionsCell = document.createElement('div');
    actionsCell.className = 'project-actions-cell';

    const editBtn = createActionButton('btn-edit', 'Manage Account');
    editBtn.addEventListener('click', () => {
      openEditModal(admin.id);
    });

    actionsCell.appendChild(editBtn);

    row.appendChild(idCell);
    row.appendChild(userCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);

    adminListEl.appendChild(row);
  });

  setEmptyState(list);
}

function refreshList() {
  renderAdminList(getFilteredAdmins());
}

function findAdminById(id) {
  return admins.find((admin) => admin.id === id);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Request failed.');
  }
  return data;
}

async function loadCurrentUser() {
  const data = await requestJson('/api/auth/me', { cache: 'no-store' });
  currentPageUser = data.user || null;
  const roleLabel = document.querySelector('.user-role-label');
  if (roleLabel && currentPageUser) {
    roleLabel.textContent = currentPageUser.username || '';
  }
}

async function loadAdmins() {
  const data = await requestJson('/api/users?role=admin', { cache: 'no-store' });
  admins = Array.isArray(data) ? data : [];
  refreshList();
}

function openCreateModal() {
  resetCreateForm();
  openModal(createModal);
}

function openEditModal(id) {
  const admin = findAdminById(id);
  if (!admin) return;
  currentEditMode = 'admin';
  currentEditId = id;
  if (editModalContent) editModalContent.classList.remove('settings-mode');
  if (editTitle) editTitle.textContent = 'UPDATE ADMIN ACCOUNT';
  editUsername.value = admin.username;
  editName.value = admin.name;
  if (editStatus) editStatus.value = admin.isActive ? 'Active' : 'Suspended';
  editPassword.value = '';
  editError.textContent = '';
  openModal(editModal);
}

function openSettingsEditModal() {
  if (!currentPageUser) return;
  currentEditMode = 'self';
  currentEditId = currentPageUser.id;
  if (editModalContent) editModalContent.classList.add('settings-mode');
  if (editTitle) editTitle.textContent = 'EDIT USERNAME & PASSWORD';
  editUsername.value = currentPageUser.username;
  editName.value = currentPageUser.name || '';
  if (editStatus) editStatus.value = currentPageUser.isActive ? 'Active' : 'Suspended';
  editPassword.value = '';
  editError.textContent = '';
  openModal(editModal);
}

async function handleCreateSubmit() {
  createError.textContent = '';

  const username = createUsername.value.trim();
  const name = createName.value.trim();
  const password = createPassword.value;

  if (!username || !name || !password) {
    createError.textContent = 'Please complete all fields.';
    return;
  }

  try {
    await requestJson('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        name,
        password,
        role: 'admin',
      }),
    });
    closeModal(createModal);
    resetCreateForm();
    await loadAdmins();
  } catch (error) {
    createError.textContent = error.message || 'Unable to create the admin account.';
  }
}

async function handleEditSave() {
  editError.textContent = '';
  if (!currentEditId) return;

  const username = editUsername.value.trim();
  const name = currentEditMode === 'self' ? (currentPageUser ? currentPageUser.name : editName.value.trim()) : editName.value.trim();
  const status = editStatus ? editStatus.value : 'Active';
  const password = editPassword.value;

  if (!username || !name) {
    editError.textContent = 'Username and name are required.';
    return;
  }

  try {
    const data = await requestJson(`/api/users/${encodeURIComponent(currentEditId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        name,
        isActive: currentEditMode === 'self' ? true : status === 'Active',
        password: password || undefined,
      }),
    });

    if (currentPageUser && currentPageUser.id === currentEditId) {
      currentPageUser = data.user;
      const roleLabel = document.querySelector('.user-role-label');
      if (roleLabel && currentPageUser) {
        roleLabel.textContent = currentPageUser.username || '';
      }
    }

    closeModal(editModal);
    resetEditForm();
    await loadAdmins();
  } catch (error) {
    editError.textContent = error.message || 'Unable to update the account.';
  }
}

async function initializePage() {
  try {
    await loadCurrentUser();
    await loadAdmins();
  } catch (error) {
    if (adminListEl) {
      adminListEl.innerHTML = '';
    }
    if (emptyStateEl) {
      emptyStateEl.style.display = 'block';
      emptyStateEl.textContent = error.message || 'Unable to load users.';
    }
  }
}

if (createBtn) {
  createBtn.addEventListener('click', openCreateModal);
}

if (createCancel) {
  createCancel.addEventListener('click', () => closeModal(createModal));
}

if (createSubmit) {
  createSubmit.addEventListener('click', handleCreateSubmit);
}

if (editCancel) {
  editCancel.addEventListener('click', () => closeModal(editModal));
}

if (editSave) {
  editSave.addEventListener('click', handleEditSave);
}

if (searchInput) {
  searchInput.addEventListener('input', refreshList);
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', openSettingsEditModal);
}

initializePage();
