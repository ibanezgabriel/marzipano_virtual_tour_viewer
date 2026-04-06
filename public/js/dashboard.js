/**
 * Dashboard page controller (admin).
 *
 * Responsibilities:
 * - Fetch and render the list of projects from the API
 * - Provide create/open/rename/status-update workflows via modals
 * - Provide search (with a small fade animation)
 * - Subscribe to realtime updates via Socket.IO so multiple clients stay in sync
 *
 * This file is loaded as an ES module from `dashboard.html`.
 */

// ---- DOM element handles ----
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

// ---- Admin notifications (approval decisions) ----
const notificationsBtn = document.getElementById('notifications-btn');
const notificationsBadgeEl = document.getElementById('notifications-badge');
const notificationsPanelEl = document.getElementById('notifications-panel');
const notificationsListEl = document.getElementById('notifications-list');
const notificationsEmptyEl = document.getElementById('notifications-empty');
const notificationsMarkAllBtn = document.getElementById('notifications-mark-all');
const dashboardUsernameEl = document.getElementById('dashboard-username');

// Socket.IO client (served by the backend at `/socket.io/...`)
import { io } from '/socket.io/socket.io.esm.min.js';

// ---- Validation / business rules ----
const MAX_PROJECT_NAME_LENGTH = 150;
const MAX_PROJECT_NUMBER_LENGTH = 20;
const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);

function normalizeWorkflowState(value) {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
  if (v === 'REJECTED') return 'REJECTED';
  if (v === 'MODIFIED') return 'MODIFIED';
  if (v === 'DRAFT') return 'DRAFT';
  return 'PUBLISHED';
}

function isPublishedProject(project) {
  return normalizeWorkflowState(project && project.workflow_state) === 'PUBLISHED';
}

function isStagingProject(project) {
  return !isPublishedProject(project);
}

function getDashboardView() {
  const params = new URLSearchParams(window.location.search);
  const view = String(params.get('view') || '').trim().toLowerCase();
  return view === 'staging' ? 'staging' : 'published';
}

const DASHBOARD_VIEW = getDashboardView();
const IS_STAGING_VIEW = DASHBOARD_VIEW === 'staging';

function workflowLabel(state) {
  if (state === 'PENDING_APPROVAL') return 'Pending';
  if (state === 'REJECTED') return 'Rejected';
  if (state === 'MODIFIED') return 'Modified';
  if (state === 'DRAFT') return 'Draft';
  return 'Published';
}

const dashboardTitleEl = document.querySelector('#dashboard-title h1');
const dashboardTitleBaseText = dashboardTitleEl ? dashboardTitleEl.textContent : '';
const openProjectHeaderEl = document.querySelector('.open-project-header-element');
const toggleDashboardViewBtn = document.getElementById('btn-toggle-dashboard-view');
const dashboardViewLabelEl = document.getElementById('dashboard-view-label');
let currentUserRole = null;

function isSuperAdminUser() {
  return currentUserRole === 'super_admin';
}

function syncDashboardViewUi() {
  if (IS_STAGING_VIEW) {
    const base = dashboardTitleBaseText
      ? dashboardTitleBaseText.replace(/\s*\(Infrastructure Projects Virtual Tour\)\s*/i, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (dashboardTitleEl && base) dashboardTitleEl.textContent = `${base} (Staging)`;
    document.title = 'QCDE - IPVT (Staging)';
    if (openProjectHeaderEl) openProjectHeaderEl.textContent = 'OPEN DRAFT PROJECT';
    if (emptyStateEl) emptyStateEl.textContent = 'No draft projects yet. Create one to get started.';
  } else {
    if (dashboardTitleEl && dashboardTitleBaseText) dashboardTitleEl.textContent = dashboardTitleBaseText;
    document.title = 'QCDE - IPVT';
    if (openProjectHeaderEl) openProjectHeaderEl.textContent = 'OPEN PROJECT';
    if (emptyStateEl) emptyStateEl.textContent = 'No projects yet. Create one to get started.';
  }

  if (toggleDashboardViewBtn) {
    toggleDashboardViewBtn.href = IS_STAGING_VIEW ? 'dashboard.html' : 'dashboard.html?view=staging';
  }
  if (dashboardViewLabelEl) {
    dashboardViewLabelEl.textContent = IS_STAGING_VIEW ? 'PUBLISHED DASHBOARD' : 'STAGING DASHBOARD';
  }
}

syncDashboardViewUi();

let notificationsUserKey = 'unknown';

// Set the header username (Admin side)
(async () => {
  if (!dashboardUsernameEl) return;
  try {
    const res = await fetch('/api/me', { headers: { 'Accept': 'application/json' } });
    const me = await res.json().catch(() => null);
    if (me && me.loggedIn && me.username) {
      dashboardUsernameEl.textContent = String(me.username).toUpperCase();
    }
    if (me && me.loggedIn && me.role) {
      currentUserRole = String(me.role);
    }
    if (me && me.loggedIn) {
      if (me.id !== undefined && me.id !== null && String(me.id).trim()) {
        notificationsUserKey = `id:${String(me.id).trim()}`;
      } else if (me.username) {
        notificationsUserKey = `u:${String(me.username).trim().toLowerCase()}`;
      }
    }
  } catch (e) {}
})();

// ---- Notifications behavior ----
const NOTIFICATIONS_POLL_MS = 20000;
let notificationsPollTimer = null;
const NOTIFICATIONS_LAST_SEEN_KEY_PREFIX = 'admin_notifications_last_seen_at';

const pad2 = (n) => String(n).padStart(2, '0');
function formatDateTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function setNotificationsBadge(count) {
  if (!notificationsBadgeEl) return;
  const n = Number(count) || 0;
  notificationsBadgeEl.textContent = String(n);
  notificationsBadgeEl.hidden = n <= 0;
}

function notificationsLastSeenStorageKey() {
  return `${NOTIFICATIONS_LAST_SEEN_KEY_PREFIX}:${notificationsUserKey}`;
}

function getNotificationsLastSeenMs() {
  try {
    const raw = localStorage.getItem(notificationsLastSeenStorageKey());
    const t = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
  } catch (e) {
    return 0;
  }
}

function setNotificationsLastSeenNow() {
  try {
    localStorage.setItem(notificationsLastSeenStorageKey(), new Date().toISOString());
  } catch (e) {}
}

function computeClientUnseenCount(rows) {
  const lastSeen = getNotificationsLastSeenMs();
  const list = Array.isArray(rows) ? rows : [];
  let count = 0;
  for (const r of list) {
    const t = new Date(r && (r.event_at || r.decided_at || r.created_at)).getTime();
    if (Number.isFinite(t) && t > lastSeen) count += 1;
  }
  return count;
}

function setNotificationsPanelOpen(open) {
  if (!notificationsPanelEl || !notificationsBtn) return;
  notificationsPanelEl.hidden = !open;
  notificationsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderNotifications(rows, supportsSeen) {
  if (!notificationsListEl || !notificationsEmptyEl) return;
  notificationsListEl.innerHTML = '';

  const list = Array.isArray(rows) ? rows : [];
  notificationsEmptyEl.style.display = list.length ? 'none' : 'block';

  const lastSeenMs = supportsSeen ? 0 : getNotificationsLastSeenMs();

  for (const r of list) {
    const id = r && r.id;
    const status = String((r && r.status) || '').toUpperCase();
    const projectNumber = (r && r.project_number) || '';
    const projectName = (r && r.project_name) || '';
    const decidedBy = (r && r.decided_by) || '';
    const when = formatDateTime(r && (r.event_at || r.decided_at || r.created_at));
    const comment = (r && r.admin_comment) ? String(r.admin_comment) : '';

    const item = document.createElement('div');
    item.className = 'notification-item';
    item.dataset.id = String(id || '');

    const isUnread = supportsSeen
      ? !(r && r.requester_seen_at)
      : (() => {
          const t = new Date(r && (r.event_at || r.decided_at || r.created_at)).getTime();
          return Number.isFinite(t) && t > lastSeenMs;
        })();
    if (isUnread) item.classList.add('notification-unread');

    const title = document.createElement('div');
    title.className = 'notification-title';
    title.textContent = status === 'APPROVED' ? 'Approved' : status === 'REJECTED' ? 'Rejected' : 'Update';

    const msg = document.createElement('div');
    msg.className = 'notification-message';
    if (status === 'APPROVED') {
      msg.textContent = `${projectNumber} ${projectName ? `- ${projectName}` : ''} was approved.`;
    } else if (status === 'REJECTED') {
      msg.textContent = `${projectNumber} ${projectName ? `- ${projectName}` : ''} was rejected.`;
    } else {
      msg.textContent = `${projectNumber} ${projectName ? `- ${projectName}` : ''} was updated.`;
    }

    const meta = document.createElement('div');
    meta.className = 'notification-meta';
    const bits = [];
    if (decidedBy) bits.push(`By ${decidedBy}`);
    if (when) bits.push(when);
    if (comment) bits.push(`Comment: ${comment}`);
    meta.textContent = bits.join(' • ');

    item.append(title, msg, meta);
    item.addEventListener('click', async () => {
      if (!id) return;
      try {
        await fetch(`/api/notifications/${encodeURIComponent(String(id))}/read`, { method: 'POST' });
      } catch (e) {}
      setNotificationsLastSeenNow();
      await refreshNotifications();
    });

    notificationsListEl.appendChild(item);
  }
}

async function fetchNotifications() {
  // Always include seen rows so "mark as read" does not remove items from the list.
  const res = await fetch('/api/notifications?limit=20&includeSeen=1', { headers: { 'Accept': 'application/json' } });
  const raw = await res.text().catch(() => '');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
  if (!res.ok) {
    // Let login.js handle redirects on auth failures; keep this quiet.
    throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  }
  return data || { unseen: 0, rows: [] };
}

async function refreshNotifications() {
  if (!notificationsBtn || !notificationsPanelEl) return;
  try {
    const data = await fetchNotifications();
    const supportsSeen = data && data.supports_seen === true;
    if (supportsSeen) {
      setNotificationsBadge(data.unseen);
    } else {
      setNotificationsBadge(computeClientUnseenCount(data && data.rows));
    }
    renderNotifications(data.rows, supportsSeen);
  } catch (e) {
    try { console.warn('Notifications load failed:', e); } catch (err) {}
    setNotificationsBadge(0);
    if (notificationsListEl) notificationsListEl.innerHTML = '';
    if (notificationsEmptyEl) {
      notificationsEmptyEl.style.display = 'block';
      notificationsEmptyEl.textContent = 'Failed to load notifications.';
    }
  }
}

function startNotificationsPolling() {
  if (!notificationsBtn) return;
  if (notificationsPollTimer) return;
  notificationsPollTimer = setInterval(() => {
    refreshNotifications();
  }, NOTIFICATIONS_POLL_MS);
}

function stopNotificationsPolling() {
  if (!notificationsPollTimer) return;
  clearInterval(notificationsPollTimer);
  notificationsPollTimer = null;
}

if (notificationsBtn && notificationsPanelEl) {
  notificationsBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const open = notificationsPanelEl.hidden;
    setNotificationsPanelOpen(open);
    if (open) {
      await refreshNotifications();

      // Mark as "seen" client-side so the badge clears even when DB seen-tracking
      // isn't available yet (e.g., older schema).
      setNotificationsLastSeenNow();
      await refreshNotifications();
    }
  });

  document.addEventListener('click', (e) => {
    if (notificationsPanelEl.hidden) return;
    const withinCard = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('.dashboard-user-card')
      : null;
    if (!withinCard) setNotificationsPanelOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!notificationsPanelEl.hidden) setNotificationsPanelOpen(false);
  });
}

if (notificationsMarkAllBtn) {
  notificationsMarkAllBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await fetch('/api/notifications/read-all', { method: 'POST' });
    } catch (err) {}
    setNotificationsLastSeenNow();
    await refreshNotifications();
  });
}

// Initial badge update + polling.
refreshNotifications();
startNotificationsPolling();

// ---- In-memory state used for filtering and rendering ----
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

/**
 * Normalizes a project name for comparisons (case-insensitive and whitespace-trimmed).
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeProjectName(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Normalizes a project status so older values and different spellings map consistently.
 *
 * @param {string} value
 * @returns {'on-going'|'completed'}
 */
function normalizeProjectStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'in-progress') return 'on-going';
  return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
}

function projectStatusLabel(value) {
  const normalized = normalizeProjectStatus(value);
  return normalized === 'completed' ? 'Completed' : 'On-going';
}

/**
 * Merges a freshly fetched project list with any previously-known statuses.
 * This is used to keep the UI stable when the API returns older records with missing/legacy fields.
 *
 * @param {Array<object>} prevList
 * @param {Array<object>} nextList
 * @returns {Array<object>}
 */
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

/**
 * Checks whether a project name already exists in the current in-memory list.
 * Used to provide immediate feedback before attempting to create/rename on the server.
 *
 * @param {string} name
 * @param {string|null} [excludeId=null] - ID to ignore (useful when renaming an existing project)
 * @returns {boolean}
 */
function projectNameExists(name, excludeId = null) {
  const n = normalizeProjectName(name);
  if (!n) return false;
  return allProjects.some((p) => normalizeProjectName(p.name) === n && (!excludeId || p.id !== excludeId));
}

/**
 * Converts a user-facing project name into a safe identifier.
 * Note: The backend uses its own canonical IDs; this helper is kept for legacy or client-only cases.
 *
 * @param {string} name
 * @returns {string}
 */
function toProjectId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

/**
 * Fetches all projects from the server.
 *
 * @returns {Promise<Array<object>>}
 * @throws {Error} when the request fails
 */
async function fetchProjects() {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error('Failed to load projects');
  return res.json();
}

/**
 * Creates a project via the API.
 *
 * @param {string} name
 * @param {string} number
 * @returns {Promise<object>} created project
 * @throws {Error} when the API rejects the request
 */
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

/**
 * Updates a project (rename / number / status) via the API.
 *
 * @param {string} id
 * @param {string} newName
 * @param {string} newNumber
 * @param {string} status
 * @returns {Promise<object>} updated project partial/record
 * @throws {Error} when the API rejects the request
 */
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

async function requestProjectApproval(projectId, changes = null, requestType = null) {
  const body = {};
  if (changes && typeof changes === 'object') {
    body.changes = changes;
  }
  if (requestType) {
    body.request_type = String(requestType);
  }
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/request-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/**
 * Convenience wrapper to update only a project's status.
 *
 * @param {object} project - current project object
 * @param {string} nextStatus
 * @returns {Promise<object>} merged updated project
 */
async function updateProjectStatus(project, nextStatus) {
  const status = normalizeProjectStatus(nextStatus);
  const updated = await renameProject(project.id, project.name, project.number || '', status);
  return {
    ...project,
    ...updated,
    status: updated.status !== undefined ? updated.status : status,
  };
}

/**
 * Navigates to the project editor for a given project.
 * Uses the project number for links when available (more human-friendly).
 *
 * @param {object} project
 * @returns {void}
 */
function openProject(project) {
  if (IS_STAGING_VIEW) {
    const params = new URLSearchParams({ project: project.id });
    window.location.href = `staging-editor.html?${params}`;
    return;
  }

  // Prefer project number in shared URLs when available.
  const projectToken = (project.number && String(project.number).trim()) || project.id;
  const params = new URLSearchParams({ project: projectToken });
  window.location.href = `project-editor.html?${params}`;
}

/**
 * Validates project names for UI input.
 *
 * @param {string} name
 * @param {string|null} [currentName=null] - provided for context; the function does not treat it specially
 * @returns {string|null} error message, or null if valid
 */
function validateProjectName(name, currentName = null) {
  const trimmed = name.trim();
  if (!trimmed) return 'Project name is required.';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`;
  if (/[<>:"/\\|?*]/.test(trimmed)) return 'Project name cannot contain: < > : " / \\ | ? *';
  return null;
}

/**
 * Validates project numbers for UI input.
 *
 * @param {string} number
 * @param {string} [requiredMessage='Project number is required.']
 * @returns {string|null} error message, or null if valid
 */
function validateProjectNumber(number, requiredMessage = 'Project number is required.') {
  const trimmed = (number || '').trim();
  if (!trimmed) return requiredMessage;
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return 'Project number can only contain letters, numbers, and "-".';
  if (trimmed.length > MAX_PROJECT_NUMBER_LENGTH) {
    return `Project number must be ${MAX_PROJECT_NUMBER_LENGTH} characters or less.`;
  }
  return null;
}

/**
 * Opens the rename modal, wires up its event handlers, and cleans up listeners when closed.
 * The modal performs client-side validation first, then calls the API.
 *
 * @param {object} project
 * @param {HTMLElement} nameDisplayEl - element that displays the name in the table row (used for context)
 * @returns {void}
 */
function showRenameModal(project, nameDisplayEl) {
  renameProjectErrorEl.textContent = '';
  if (renameProjectNumberInput) {
    renameProjectNumberInput.value = project.number || '';
  }
  renameProjectNameInput.value = project.name;
  if (renameProjectStatusSelect) {
    renameProjectStatusSelect.value = normalizeProjectStatus(project.status);
  }
  if (renameModalSaveBtn) {
    renameModalSaveBtn.textContent = (IS_STAGING_VIEW || isSuperAdminUser()) ? 'Save' : 'Request Approval';
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
    const nextStatus = normalizeProjectStatus(renameProjectStatusSelect ? renameProjectStatusSelect.value : project.status);
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
    // If neither name nor number actually changed, do nothing.
    const currentNumber = String(project.number || '');
    const currentStatus = normalizeProjectStatus(project.status);
    if (name.trim() === project.name.trim() && number === currentNumber && nextStatus === currentStatus) {
      renameProjectErrorEl.textContent = 'No changes made.';
      return;
    }
    try {
      renameModalSaveBtn.disabled = true;
      if (!IS_STAGING_VIEW && !isSuperAdminUser()) {
        await requestProjectApproval(
          project.id,
          {
            previous: {
              name: project.name,
              number: currentNumber,
              status: currentStatus,
            },
            next: {
              name: name.trim(),
              number,
              status: nextStatus,
            },
          },
          'project:update'
        );
        window.alert('Approval request submitted. The published project will remain unchanged until a Super Admin approves it.');
        applyProjectSearch();
        cleanup();
        return;
      }

      const updated = await renameProject(project.id, name.trim(), number, nextStatus);
      const finalProject = {
        ...project,
        ...updated,
        name: updated.name || name.trim(),
        number: updated.number !== undefined ? updated.number : number,
        status: updated.status !== undefined ? updated.status : nextStatus,
      };
      // Update in-memory list
      allProjects = allProjects.map((p) => (p.id === project.id ? finalProject : p));
      renderProjectList(allProjects);
      cleanup();
    } catch (e) {
      renameProjectErrorEl.textContent = e.message || 'Failed to update project.';
    } finally {
      renameModalSaveBtn.disabled = false;
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

/**
 * Builds a single row in the project table.
 *
 * Row interactions:
 * - Clicking the row opens the project editor (except when clicking buttons)
 * - "View" opens the public viewer in a new tab
 * - "Edit" opens the rename modal
 * - Status is edited via the modal
 *
 * @param {object} project
 * @returns {HTMLDivElement}
 */
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

  // cell for status / workflow state
  const statusCell = document.createElement('div');
  statusCell.className = 'project-status-cell';

  if (IS_STAGING_VIEW) {
    const state = normalizeWorkflowState(project.workflow_state);
    const statusDisplay = document.createElement('div');
    statusDisplay.className = 'project-status-display';
    statusDisplay.textContent = workflowLabel(state);
    statusCell.appendChild(statusDisplay);
  } else {
    const statusDisplay = document.createElement('div');
    statusDisplay.className = 'project-status-display';
    statusDisplay.textContent = projectStatusLabel(project.status);
    statusCell.appendChild(statusDisplay);
  }

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
    openProject(project);
  };

  editBTN.onclick = () => showRenameModal(project, nameDisplay);

  // group buttons into their own cell
  const actionsCell = document.createElement('div');
  actionsCell.className = 'project-actions-cell';
  actionsCell.append(viewBtn, editBTN);

  row.append(numberCell, nameCell, statusCell, actionsCell);
  return row;
}

/**
 * Shows/hides the dashboard empty-state text.
 * We derive emptiness from the rendered list so it works with search filtering.
 *
 * @returns {void}
 */
function updateEmptyState() {
  const count = projectListEl.querySelectorAll('.project-row').length;
  emptyStateEl.style.display = count === 0 ? 'block' : 'none';
}

/**
 * Renders the main project list in the dashboard table.
 *
 * @param {Array<object>} projects
 * @returns {void}
 */
function renderProjectList(projects) {
  projectListEl.innerHTML = '';
  for (const p of projects) {
    projectListEl.appendChild(renderProjectRow(p));
  }
  updateEmptyState();
}

/**
 * Renders the list inside the "Open Existing Project" modal.
 *
 * @param {Array<object>} projects
 * @returns {void}
 */
function renderOpenProjectList(projects) {
  if (!openProjectListEl) return;
  openProjectListEl.innerHTML = '';
  if (!projects || projects.length === 0) {
    openProjectListEl.innerHTML = IS_STAGING_VIEW
      ? '<p class="empty-state">No draft projects yet.</p>'
      : '<p class="empty-state">No projects yet.</p>';
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

/**
 * Renders a filtered list with a short fade-out/fade-in animation.
 * This improves perceived responsiveness when typing in the search input.
 *
 * @param {Array<object>} projects
 * @returns {void}
 */
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

/**
 * Applies the main dashboard search query and renders the result.
 *
 * @param {{animate?: boolean}} [options]
 * @returns {void}
 */
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
      (IS_STAGING_VIEW
        ? workflowLabel(normalizeWorkflowState(p.workflow_state)).toLowerCase().includes(q) ||
          normalizeWorkflowState(p.workflow_state).toLowerCase().includes(q)
        : normalizeProjectStatus(p.status).includes(q))
    );
  }

  if (animate) {
    renderProjectListWithSearchAnimation(projectsToRender);
  } else {
    renderProjectList(projectsToRender);
  }
}

/**
 * Applies search filtering inside the "Open Existing Project" modal.
 *
 * @returns {void}
 */
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
      (IS_STAGING_VIEW
        ? workflowLabel(normalizeWorkflowState(p.workflow_state)).toLowerCase().includes(q) ||
          normalizeWorkflowState(p.workflow_state).toLowerCase().includes(q)
        : normalizeProjectStatus(p.status).includes(q))
    );
  }
  renderOpenProjectList(projectsToRender);
}

/**
 * Loads projects from the server and renders them.
 * Called on initial page load and indirectly through realtime socket updates.
 *
 * @returns {Promise<void>}
 */
async function loadProjects() {
  try {
    const fetched = await fetchProjects();
    const merged = mergeProjectStatuses(allProjects, fetched);
    allProjects = merged.filter(IS_STAGING_VIEW ? isStagingProject : isPublishedProject);
    renderProjectList(allProjects);
  } catch (e) {
    emptyStateEl.textContent = 'Error loading projects: ' + e.message;
    emptyStateEl.style.display = 'block';
  }
}

// ---- UI event wiring ----
// Modal open/close, create/rename actions, and search input listeners.
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
    // Newly created projects start as DRAFT; open them in the staging editor.
    newProjectModal.classList.remove('visible');
    const params = new URLSearchParams({ project: created.id });
    window.location.href = `staging-editor.html?${params.toString()}`;
  } catch (e) {
    if (newProjectErrorEl) newProjectErrorEl.textContent = e.message || 'Failed to create project.';
  }
};

document.getElementById('btn-open-project').onclick = async () => {
  try {
    const projects = await fetchProjects();
    const merged = mergeProjectStatuses(allProjects, projects);
    openProjectProjects = merged.filter(IS_STAGING_VIEW ? isStagingProject : isPublishedProject);
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

// ---- Realtime updates ----
// When any client creates/updates projects, the server broadcasts `projects:changed`.
try {
  const socket = io();
  socket.on('projects:changed', (projects) => {
    if (!Array.isArray(projects)) return;
    allProjects = mergeProjectStatuses(allProjects, projects).filter(IS_STAGING_VIEW ? isStagingProject : isPublishedProject);
    applyProjectSearch();
    if (openProjectModal && openProjectModal.classList.contains('visible')) {
      openProjectProjects = mergeProjectStatuses(openProjectProjects, projects).filter(IS_STAGING_VIEW ? isStagingProject : isPublishedProject);
      applyOpenProjectSearch();
    }
  });
} catch (e) {
  // ignore if sockets unavailable
}
