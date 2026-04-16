/* Handles login state, form submission, and logout behavior. */
const REDIRECT_KEY = 'ipvt_redirect_url';
const PUBLIC_PAGES = new Set(['login.html', 'project-viewer.html', 'project-viewer-panoramas.html', 'project-viewer-layout.html']);
const PROJECT_VIEWER_PAGES = new Set(['project-viewer.html', 'project-viewer-panoramas.html', 'project-viewer-layout.html']);
const SUPERADMIN_HOME_PAGE = 'user-management.html';
const ADMIN_HOME_PAGE = 'dashboard.html';

let currentUser = null;
let currentUserPromise = null;

const IDLE_GRACE_MS = 2 * 60 * 1000; // 2 minutes
const IDLE_COUNTDOWN_MS = 10 * 60 * 1000; // 10 minutes

let idleLogoutInitialized = false;
let lastActivityAt = Date.now();
let idleTimeoutId = null;
let countdownIntervalId = null;
let countdownEndAt = null;
let idleCountdownEl = null;
let idleCountdownLabelEl = null;
let idleCountdownVisible = false;
let idleLogoutInProgress = false;
let tabCloseLogoutInitialized = false;
let tabCloseLogoutInProgress = false;

const INTERNAL_NAV_KEY = 'ipvt_internal_nav_ts';

function markInternalNavigation() {
  try {
    sessionStorage.setItem(INTERNAL_NAV_KEY, String(Date.now()));
  } catch (_e) {}
}

function isInternalNavigationRecent() {
  try {
    const raw = sessionStorage.getItem(INTERNAL_NAV_KEY);
    const ts = Number(raw || 0);
    return Boolean(ts) && Date.now() - ts < 2000;
  } catch (_e) {
    return false;
  }
}

/* Gets get current page. */
function getCurrentPage() {
  return window.location.pathname.split('/').pop() || 'dashboard.html';
}

function formatCountdownMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ensureIdleCountdownUi() {
  if (idleCountdownEl) return;
  const el = document.createElement('div');
  el.id = 'idle-countdown';
  el.className = 'idle-countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.style.display = 'none';

  const label = document.createElement('div');
  label.className = 'idle-countdown-label';
  label.textContent = '';
  el.appendChild(label);

  document.body.appendChild(el);
  idleCountdownEl = el;
  idleCountdownLabelEl = label;
}

function showIdleCountdownUi() {
  ensureIdleCountdownUi();
  if (!idleCountdownEl) return;
  idleCountdownVisible = true;
  idleCountdownEl.style.display = 'flex';
  idleCountdownEl.classList.add('visible');
}

function hideIdleCountdownUi() {
  if (!idleCountdownEl) return;
  idleCountdownVisible = false;
  idleCountdownEl.classList.remove('visible');
  idleCountdownEl.style.display = 'none';
}

function stopIdleCountdown() {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
  countdownEndAt = null;
  if (idleCountdownVisible) hideIdleCountdownUi();
}

function tickIdleCountdown() {
  if (!countdownEndAt) return;
  const remaining = countdownEndAt - Date.now();
  if (remaining <= 0) {
    stopIdleCountdown();
    if (!idleLogoutInProgress) {
      idleLogoutInProgress = true;
      logout();
    }
    return;
  }
  if (idleCountdownLabelEl) {
    idleCountdownLabelEl.textContent = `Idle detected — logging out in ${formatCountdownMs(remaining)}`;
  }
}

function enterIdleCountdown() {
  if (idleLogoutInProgress) return;
  stopIdleCountdown();
  countdownEndAt = Date.now() + IDLE_COUNTDOWN_MS;
  showIdleCountdownUi();
  tickIdleCountdown();
  countdownIntervalId = setInterval(tickIdleCountdown, 1000);
}

function scheduleIdleTrigger() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
  if (idleLogoutInProgress) return;
  const elapsed = Date.now() - lastActivityAt;
  const remaining = Math.max(0, IDLE_GRACE_MS - elapsed);
  idleTimeoutId = setTimeout(() => {
    // If activity happened while the timeout was queued, reschedule.
    if (Date.now() - lastActivityAt < IDLE_GRACE_MS) {
      scheduleIdleTrigger();
      return;
    }
    enterIdleCountdown();
  }, remaining);
}

function recordActivity() {
  if (!idleLogoutInitialized) return;
  if (idleLogoutInProgress) return;
  lastActivityAt = Date.now();
  if (countdownEndAt) stopIdleCountdown();
  scheduleIdleTrigger();
}

function initIdleLogoutTimer() {
  if (idleLogoutInitialized) return;
  idleLogoutInitialized = true;
  lastActivityAt = Date.now();

  const opts = { passive: true };
  window.addEventListener('mousemove', recordActivity, opts);
  window.addEventListener('mousedown', recordActivity, opts);
  window.addEventListener('keydown', recordActivity, opts);
  window.addEventListener('touchstart', recordActivity, opts);
  window.addEventListener('touchmove', recordActivity, opts);
  window.addEventListener('wheel', recordActivity, opts);
  // scroll doesn't bubble; capture catches scroll on nested containers too.
  document.addEventListener('scroll', recordActivity, { passive: true, capture: true });

  scheduleIdleTrigger();
}

/* Updates sanitize redirect target. */
function sanitizeRedirectTarget(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    return null;
  }
}

/* Updates set stored redirect. */
function setStoredRedirect(value) {
  const target = sanitizeRedirectTarget(value);
  if (target) {
    localStorage.setItem(REDIRECT_KEY, target);
  } else {
    localStorage.removeItem(REDIRECT_KEY);
  }
}

/* Gets get stored redirect. */
function getStoredRedirect() {
  const fromQuery = sanitizeRedirectTarget(new URLSearchParams(window.location.search).get('redirect'));
  if (fromQuery) {
    setStoredRedirect(fromQuery);
    return fromQuery;
  }
  return sanitizeRedirectTarget(localStorage.getItem(REDIRECT_KEY));
}

/* Updates update current user ui. */
function updateCurrentUserUi(user) {
  const roleLabel = document.querySelector('.user-role-label');
  if (roleLabel) {
    roleLabel.textContent = user && user.username ? user.username : '';
  }
  document.body.dataset.authRole = user && user.role ? user.role : '';
}

/* Gets get home page for user. */
function getHomePageForUser(user) {
  if (!user) return ADMIN_HOME_PAGE;
  if (user.homePath) return user.homePath.replace(/^\//, '');
  return user.role === 'superadmin' ? SUPERADMIN_HOME_PAGE : ADMIN_HOME_PAGE;
}

/* Gets fetch current user. */
async function fetchCurrentUser() {
  const response = await fetch('/api/auth/me', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Not signed in');
  }
  const data = await response.json();
  return data && data.user ? data.user : null;
}

/* Gets fetch auth status. */
async function fetchAuthStatus() {
  const response = await fetch('/api/auth/status', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Unable to read auth status');
  }
  const data = await response.json();
  return data || { authenticated: false, user: null };
}

/* Gets get current user. */
async function getCurrentUser() {
  if (currentUser) return currentUser;
  if (!currentUserPromise) {
    currentUserPromise = fetchCurrentUser()
      .then((user) => {
        currentUser = user;
        updateCurrentUserUi(user);
        return user;
      })
      .catch(() => {
        currentUser = null;
        updateCurrentUserUi(null);
        return null;
      })
      .finally(() => {
        currentUserPromise = null;
      });
  }
  return currentUserPromise;
}

/* Handles is authenticated. */
async function isAuthenticated() {
  return Boolean(await getCurrentUser());
}

/* Validates check authentication. */
async function checkAuthentication() {
  const currentPage = getCurrentPage();
  if (PUBLIC_PAGES.has(currentPage)) return null;

  const user = await getCurrentUser();
  if (!user) {
    setStoredRedirect(window.location.href);
    markInternalNavigation();
    window.location.href = `login.html?redirect=${encodeURIComponent(window.location.href)}`;
    return null;
  }

  const homePage = getHomePageForUser(user);

  if (user.role === 'superadmin' && currentPage !== SUPERADMIN_HOME_PAGE) {
    markInternalNavigation();
    window.location.href = SUPERADMIN_HOME_PAGE;
    return null;
  }

  if (currentPage === SUPERADMIN_HOME_PAGE && user.role !== 'superadmin') {
    markInternalNavigation();
    window.location.href = homePage;
    return null;
  }

  updateCurrentUserUi(user);
  return user;
}

/* Handles handle successful login. */
async function handleSuccessfulLogin() {
  currentUser = null;
  await redirectToStoredPage();
}

/* Handles redirect to stored page. */
async function redirectToStoredPage() {
  const user = await getCurrentUser();
  const homePage = getHomePageForUser(user);
  const redirectUrl = getStoredRedirect() || homePage;
  localStorage.removeItem(REDIRECT_KEY);
  if (!user) {
    markInternalNavigation();
    window.location.href = 'login.html';
    return;
  }
  if (user.role === 'superadmin') {
    markInternalNavigation();
    window.location.href = SUPERADMIN_HOME_PAGE;
    return;
  }
  if (redirectUrl.includes(SUPERADMIN_HOME_PAGE) && user.role !== 'superadmin') {
    markInternalNavigation();
    window.location.href = homePage;
    return;
  }
  markInternalNavigation();
  window.location.href = redirectUrl;
}

/* Shows show error. */
function showError(message) {
  const errorElement = document.getElementById('login-error');
  if (errorElement) {
    errorElement.textContent = message || '';
    errorElement.style.display = message ? 'block' : 'none';
  }
}

/* Handles logout. */
async function logout() {
  tabCloseLogoutInProgress = true;
  idleLogoutInProgress = true;
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
  stopIdleCountdown();
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {}
  currentUser = null;
  currentUserPromise = null;
  localStorage.removeItem(REDIRECT_KEY);
  window.location.href = 'login.html';
}

function attemptLogoutBeacon() {
  try {
    if (typeof navigator === 'undefined') return false;
    if (typeof navigator.sendBeacon !== 'function') return false;
    const blob = new Blob([JSON.stringify({ reason: 'tab_close' })], { type: 'application/json' });
    return navigator.sendBeacon('/api/auth/logout', blob);
  } catch (_e) {
    return false;
  }
}

function attemptLogoutKeepaliveFetch() {
  try {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'tab_close' }),
      keepalive: true,
      cache: 'no-store',
    }).catch(() => {});
  } catch (_e) {}
}

function initLogoutOnTabClose() {
  if (tabCloseLogoutInitialized) return;
  tabCloseLogoutInitialized = true;

  // Mark internal navigations so we don't log the user out when they click links/forms inside the app.
  // This is best-effort; browser APIs do not reliably distinguish navigation vs tab close.
  try {
    document.addEventListener('click', (e) => {
      const a = e && e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const target = (a.getAttribute('target') || '').toLowerCase();
      if (!href || href.startsWith('#')) return;
      if (target === '_blank') return;
      if (a.hasAttribute('download')) return;
      markInternalNavigation();
    }, { capture: true, passive: true });

    document.addEventListener('submit', () => markInternalNavigation(), { capture: true, passive: true });
  } catch (_e) {}

  const handlePotentialClose = (ev) => {
    if (tabCloseLogoutInProgress || idleLogoutInProgress) return;
    if (isInternalNavigationRecent()) return;
    if (ev && ev.persisted) return; // bfcache
    tabCloseLogoutInProgress = true;
    const ok = attemptLogoutBeacon();
    if (!ok) attemptLogoutKeepaliveFetch();
  };

  // pagehide fires for tab close and navigation; best-effort skip internal nav via the marker above.
  window.addEventListener('pagehide', handlePotentialClose);
  // beforeunload is a fallback in browsers that don't reliably fire pagehide.
  window.addEventListener('beforeunload', handlePotentialClose);
}

const DIALOG_OVERLAY_ID = 'app-dialog-overlay';
const DIALOG_BOX_ID = 'app-dialog-box';
const DIALOG_TITLE_ID = 'app-dialog-title';
const DIALOG_MESSAGE_ID = 'app-dialog-message';
const DIALOG_ACTIONS_ID = 'app-dialog-actions';

/* Gets get or create dialog. */
function getOrCreateDialog() {
  let overlay = document.getElementById(DIALOG_OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = DIALOG_OVERLAY_ID;
  overlay.className = 'app-dialog-overlay';

  const box = document.createElement('div');
  box.id = DIALOG_BOX_ID;
  box.className = 'app-dialog-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', DIALOG_TITLE_ID);

  const title = document.createElement('div');
  title.id = DIALOG_TITLE_ID;
  title.className = 'app-dialog-title';

  const message = document.createElement('div');
  message.id = DIALOG_MESSAGE_ID;
  message.className = 'app-dialog-message';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'app-dialog-input-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'app-dialog-input';
  inputWrap.appendChild(input);

  const selectWrap = document.createElement('div');
  selectWrap.className = 'app-dialog-select-wrap';

  const actions = document.createElement('div');
  actions.id = DIALOG_ACTIONS_ID;
  actions.className = 'app-dialog-actions';

  box.appendChild(title);
  box.appendChild(message);
  box.appendChild(inputWrap);
  box.appendChild(selectWrap);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.setAttribute('aria-hidden', 'true');
  return overlay;
}

/* Shows show logout confirm. */
function showLogoutConfirm(message, title = 'Logout') {
  return new Promise((resolve) => {
    const overlay = getOrCreateDialog();
    const titleEl = document.getElementById(DIALOG_TITLE_ID);
    const messageEl = document.getElementById(DIALOG_MESSAGE_ID);
    const actionsEl = document.getElementById(DIALOG_ACTIONS_ID);
    const inputWrap = overlay.querySelector('.app-dialog-input-wrap');
    const selectWrap = overlay.querySelector('.app-dialog-select-wrap');

    if (titleEl) {
      titleEl.textContent = title;
      titleEl.style.display = 'block';
    }
    if (messageEl) {
      messageEl.textContent = message;
      messageEl.style.display = 'block';
    }
    if (inputWrap) inputWrap.style.display = 'none';
    if (selectWrap) selectWrap.style.display = 'none';

    if (actionsEl) {
      actionsEl.innerHTML = '';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        overlay.classList.remove('app-dialog-visible');
        overlay.setAttribute('aria-hidden', 'true');
        resolve(false);
      });
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
      okBtn.textContent = 'Logout';
      okBtn.addEventListener('click', () => {
        overlay.classList.remove('app-dialog-visible');
        overlay.setAttribute('aria-hidden', 'true');
        resolve(true);
      });
      actionsEl.appendChild(cancelBtn);
      actionsEl.appendChild(okBtn);
      cancelBtn.focus();
    }

    overlay.removeAttribute('aria-hidden');
    overlay.classList.add('app-dialog-visible');
  });
}

document.addEventListener('DOMContentLoaded', async function() {
  const currentPage = getCurrentPage();
  const loginForm = document.getElementById('login-form');

  getStoredRedirect();

  if (loginForm) {
    loginForm.addEventListener('submit', async function(e) {
      e.preventDefault();

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const submitButton = loginForm.querySelector('button[type="submit"]');

      if (!username || !password) {
        showError('Please enter both username and password.');
        return;
      }

      if (submitButton) submitButton.disabled = true;
      showError('');

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          showError(data.message || 'Invalid username or password.');
          return;
        }

        currentUser = data && data.user ? data.user : null;
        updateCurrentUserUi(currentUser);
        await handleSuccessfulLogin();
      } catch (error) {
        showError('Unable to sign in right now. Please try again.');
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  if (currentPage === 'login.html') {
    const status = await fetchAuthStatus().catch(() => ({ authenticated: false, user: null }));
    const user = status && status.authenticated ? status.user : null;
    if (user) {
      currentUser = user;
      updateCurrentUserUi(user);
      markInternalNavigation();
      await redirectToStoredPage();
    }
    return;
  }

  if (PUBLIC_PAGES.has(currentPage)) {
    // Project viewers are intended for non-admin use; do not apply idle logout there.
    if (PROJECT_VIEWER_PAGES.has(currentPage)) return;
    // Public pages should not redirect, but if a user is currently signed in,
    // still apply idle logout.
    const status = await fetchAuthStatus().catch(() => ({ authenticated: false, user: null }));
    const user = status && status.authenticated ? status.user : null;
    if (user) {
      currentUser = user;
      updateCurrentUserUi(user);
      initIdleLogoutTimer();
      initLogoutOnTabClose();
    }
    return;
  }

  const user = await checkAuthentication();
  if (user) {
    initIdleLogoutTimer();
    initLogoutOnTabClose();
  }
});

document.addEventListener('DOMContentLoaded', function() {
  const logoutButtons = document.querySelectorAll('#logout-btn');
  logoutButtons.forEach((button) => {
    button.addEventListener('click', async function(e) {
      e.preventDefault();
      const message = button.dataset && button.dataset.logoutMessage
        ? button.dataset.logoutMessage
        : 'Are you sure you want to log out?';
      const confirmed = await showLogoutConfirm(message, 'Logout');
      if (!confirmed) return;
      await logout();
    });
  });
});

window.auth = {
  checkAuthentication,
  getCurrentUser,
  isAuthenticated,
  logout,
};
