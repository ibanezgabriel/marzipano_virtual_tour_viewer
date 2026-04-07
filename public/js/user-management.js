const adminListEl = document.getElementById('admin-list');
const emptyStateEl = document.getElementById('admin-empty-state');
const searchInput = document.getElementById('admin-search-input');

const createModal = document.getElementById('create-admin-modal');
const editModal = document.getElementById('edit-admin-modal');
const deleteModal = document.getElementById('delete-admin-modal');

const createBtn = document.getElementById('btn-create-admin');
const createCancel = document.getElementById('create-admin-cancel');
const createSubmit = document.getElementById('create-admin-submit');
const createError = document.getElementById('create-admin-error');

const editCancel = document.getElementById('edit-admin-cancel');
const editSave = document.getElementById('edit-admin-save');
const editError = document.getElementById('edit-admin-error');

const deleteCancel = document.getElementById('delete-admin-cancel');
const deleteConfirm = document.getElementById('delete-admin-confirm');

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

let currentEditId = null;
let currentDeleteId = null;

const admins = [
  {
    id: 'ADM-001',
    username: 'admin.qcde',
    name: 'QCDE Main Admin',
    email: 'admin@qcde.gov',
    status: 'Active'
  },
  {
    id: 'ADM-002',
    username: 'admin.projects',
    name: 'Projects Admin',
    email: 'projects@qcde.gov',
    status: 'Active'
  },
  {
    id: 'ADM-003',
    username: 'admin.support',
    name: 'Support Admin',
    email: 'support@qcde.gov',
    status: 'Suspended'
  }
];

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
    admin.id.toLowerCase().includes(q) ||
    admin.username.toLowerCase().includes(q) ||
    admin.name.toLowerCase().includes(q) ||
    admin.email.toLowerCase().includes(q) ||
    admin.status.toLowerCase().includes(q)
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
    row.dataset.adminId = admin.id;

    const idCell = document.createElement('div');
    idCell.className = 'project-number-cell';
    const idDisplay = document.createElement('div');
    idDisplay.className = 'project-number-display';
    idDisplay.textContent = admin.id;
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
    statusDisplay.textContent = admin.status;
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

function generateAdminId() {
  const numericIds = admins
    .map((admin) => parseInt(admin.id.replace('ADM-', ''), 10))
    .filter((value) => !Number.isNaN(value));
  const next = numericIds.length ? Math.max(...numericIds) + 1 : 1;
  return `ADM-${String(next).padStart(3, '0')}`;
}

function findAdminById(id) {
  return admins.find((admin) => admin.id === id);
}

function isDuplicate(field, value, excludeId = null) {
  const normalized = value.trim().toLowerCase();
  return admins.some((admin) => {
    if (excludeId && admin.id === excludeId) return false;
    return admin[field].toLowerCase() === normalized;
  });
}

function openCreateModal() {
  resetCreateForm();
  openModal(createModal);
}

function openEditModal(id) {
  const admin = findAdminById(id);
  if (!admin) return;
  if (editModalContent) editModalContent.classList.remove('settings-mode');
  if (editTitle) editTitle.textContent = 'UPDATE ADMIN ACCOUNT';
  currentEditId = id;
  editUsername.value = admin.username;
  editName.value = admin.name;
  if (editStatus) editStatus.value = admin.status || 'Active';
  editPassword.value = '';
  editError.textContent = '';
  openModal(editModal);
}

function openSettingsEditModal() {
  if (editModalContent) editModalContent.classList.add('settings-mode');
  if (editTitle) editTitle.textContent = 'EDIT USERNAME & PASSWORD';

  if (admins.length) {
    openEditModal(admins[0].id);
    if (editModalContent) editModalContent.classList.add('settings-mode');
    if (editTitle) editTitle.textContent = 'EDIT USERNAME & PASSWORD';
    return;
  }

  currentEditId = null;
  resetEditForm();
  if (editStatus) editStatus.value = 'Active';
  openModal(editModal);
}

function openDeleteModal(id) {
  currentDeleteId = id;
  openModal(deleteModal);
}

function handleCreateSubmit() {
  createError.textContent = '';

  const username = createUsername.value.trim();
  const name = createName.value.trim();
  const password = createPassword.value.trim();

  if (!username || !name || !password) {
    createError.textContent = 'Please complete all fields.';
    return;
  }

  if (isDuplicate('username', username)) {
    createError.textContent = 'Username is already in use.';
    return;
  }

  admins.unshift({
    id: generateAdminId(),
    username,
    name,
    email: '',
    status: 'Active',
    password
  });

  closeModal(createModal);
  resetCreateForm();
  refreshList();
}

function handleEditSave() {
  editError.textContent = '';
  if (!currentEditId) return;
  const admin = findAdminById(currentEditId);
  if (!admin) return;

  const username = editUsername.value.trim();
  const name = editName.value.trim();
  const status = editStatus ? editStatus.value : admin.status;
  const password = editPassword.value.trim();

  if (!username || !name) {
    editError.textContent = 'Username and name are required.';
    return;
  }

  if (isDuplicate('username', username, currentEditId)) {
    editError.textContent = 'Username is already in use.';
    return;
  }

  admin.username = username;
  admin.name = name;
  admin.status = status;
  if (password) {
    admin.password = password;
  }

  closeModal(editModal);
  resetEditForm();
  refreshList();
}

function handleDeleteConfirm() {
  if (!currentDeleteId) return;
  const index = admins.findIndex((admin) => admin.id === currentDeleteId);
  if (index !== -1) {
    admins.splice(index, 1);
  }
  currentDeleteId = null;
  closeModal(deleteModal);
  refreshList();
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

if (deleteCancel) {
  deleteCancel.addEventListener('click', () => closeModal(deleteModal));
}

if (deleteConfirm) {
  deleteConfirm.addEventListener('click', handleDeleteConfirm);
}

if (searchInput) {
  searchInput.addEventListener('input', refreshList);
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', openSettingsEditModal);
}

refreshList();
