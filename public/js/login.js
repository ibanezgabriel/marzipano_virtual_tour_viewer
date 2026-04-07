const REDIRECT_KEY = 'ipvt_redirect_url';
const PUBLIC_PAGES = new Set(['login.html', 'project-viewer.html']);
const SUPERADMIN_HOME_PAGE = 'user-management.html';
const ADMIN_HOME_PAGE = 'dashboard.html';

let currentUser = null;
let currentUserPromise = null;

function getCurrentPage() {
  return window.location.pathname.split('/').pop() || 'dashboard.html';
}

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

function setStoredRedirect(value) {
  const target = sanitizeRedirectTarget(value);
  if (target) {
    localStorage.setItem(REDIRECT_KEY, target);
  } else {
    localStorage.removeItem(REDIRECT_KEY);
  }
}

function getStoredRedirect() {
  const fromQuery = sanitizeRedirectTarget(new URLSearchParams(window.location.search).get('redirect'));
  if (fromQuery) {
    setStoredRedirect(fromQuery);
    return fromQuery;
  }
  return sanitizeRedirectTarget(localStorage.getItem(REDIRECT_KEY));
}

function updateCurrentUserUi(user) {
  const roleLabel = document.querySelector('.user-role-label');
  if (roleLabel && user) {
    roleLabel.textContent = user.roleLabel || (user.role === 'superadmin' ? 'SuperAdmin' : 'Admin');
  }
  document.body.dataset.authRole = user && user.role ? user.role : '';
}

function getHomePageForUser(user) {
  if (!user) return ADMIN_HOME_PAGE;
  if (user.homePath) return user.homePath.replace(/^\//, '');
  return user.role === 'superadmin' ? SUPERADMIN_HOME_PAGE : ADMIN_HOME_PAGE;
}

async function fetchCurrentUser() {
  const response = await fetch('/api/auth/me', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Not signed in');
  }
  const data = await response.json();
  return data && data.user ? data.user : null;
}

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

async function isAuthenticated() {
  return Boolean(await getCurrentUser());
}

async function checkAuthentication() {
  const currentPage = getCurrentPage();
  if (PUBLIC_PAGES.has(currentPage)) return null;

  const user = await getCurrentUser();
  if (!user) {
    setStoredRedirect(window.location.href);
    window.location.href = `login.html?redirect=${encodeURIComponent(window.location.href)}`;
    return null;
  }

  const homePage = getHomePageForUser(user);

  if (user.role === 'superadmin' && currentPage !== SUPERADMIN_HOME_PAGE) {
    window.location.href = SUPERADMIN_HOME_PAGE;
    return null;
  }

  if (currentPage === SUPERADMIN_HOME_PAGE && user.role !== 'superadmin') {
    window.location.href = homePage;
    return null;
  }

  updateCurrentUserUi(user);
  return user;
}

async function handleSuccessfulLogin() {
  currentUser = null;
  await redirectToStoredPage();
}

async function redirectToStoredPage() {
  const user = await getCurrentUser();
  const homePage = getHomePageForUser(user);
  const redirectUrl = getStoredRedirect() || homePage;
  localStorage.removeItem(REDIRECT_KEY);
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  if (user.role === 'superadmin') {
    window.location.href = SUPERADMIN_HOME_PAGE;
    return;
  }
  if (redirectUrl.includes(SUPERADMIN_HOME_PAGE) && user.role !== 'superadmin') {
    window.location.href = homePage;
    return;
  }
  window.location.href = redirectUrl;
}

function showError(message) {
  const errorElement = document.getElementById('login-error');
  if (errorElement) {
    errorElement.textContent = message || '';
    errorElement.style.display = message ? 'block' : 'none';
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {}
  currentUser = null;
  currentUserPromise = null;
  localStorage.removeItem(REDIRECT_KEY);
  window.location.href = 'login.html';
}

const DIALOG_OVERLAY_ID = 'app-dialog-overlay';
const DIALOG_BOX_ID = 'app-dialog-box';
const DIALOG_TITLE_ID = 'app-dialog-title';
const DIALOG_MESSAGE_ID = 'app-dialog-message';
const DIALOG_ACTIONS_ID = 'app-dialog-actions';

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
    const user = await getCurrentUser();
    if (user) {
      await redirectToStoredPage();
    }
    return;
  }

  await checkAuthentication();
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
