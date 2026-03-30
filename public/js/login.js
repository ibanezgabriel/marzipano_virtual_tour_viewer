/**
 * Client-side authentication helpers.
 *
 * This file is included on both the login page and protected admin pages.
 * It:
 * - Checks whether the current browser session is authenticated (`/api/me`)
 * - Remembers the originally requested page so we can redirect after login
 * - Implements a shared logout flow (`/api/logout`) with a confirmation modal
 */

/** localStorage key used to store the page to return to after login */
const REDIRECT_KEY = 'ipvt_redirect_url';

/**
 * Checks the current authentication status from the server.
 *
 * Behavior:
 * - `project-viewer.html` is public and does not require login.
 * - If not logged in and we are on a protected page, remember the current URL
 *   and redirect to `login.html`.
 * - If logged in and we are on the login page, redirect to the stored URL
 *   (or the role-based landing page).
 *
 * @returns {Promise<void>}
 */
async function checkAuthentication() {
    const currentPage = window.location.pathname.split('/').pop();
    
    // Public viewer is allowed without login
    if (currentPage === 'project-viewer.html') {
        return;
    }

    // Check if we are on the login page (or root)
    const isLoginPage = currentPage === 'login.html' || currentPage === '';

    try {
        const res = await fetch('/api/me');
        const data = await res.json();
        
        if (data.loggedIn) {
            if (isLoginPage) redirectToStoredPage(data.role);
        } else {
            if (!isLoginPage) {
                localStorage.setItem(REDIRECT_KEY, window.location.href);
                window.location.href = '/login.html';
            }
        }
    } catch (e) {
        console.error('Auth check failed:', e);
        if (!isLoginPage) window.location.href = '/login.html';
    }
}

// Handle login form submission
document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('login-form');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (data.success) {
                    redirectToStoredPage(data.user && data.user.role);
                } else {
                    showError(data.message || 'Invalid credentials');
                }
            } catch (err) {
                // console.error(err);
                showError('Server connection error', err);
            }
        });
    }
});

/**
 * Returns the default landing page for a role.
 *
 * @param {string} role
 * @returns {string} relative URL
 */
function getDefaultLandingPage(role) {
    return role === 'super_admin' ? 'superadmindb.html' : 'dashboard.html';
}

function normalizeRedirectUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value), window.location.origin);
        if (url.origin !== window.location.origin) return null;
        return `${url.pathname}${url.search}${url.hash}`;
    } catch (e) {
        return null;
    }
}

function isRedirectAllowedForRole(redirectUrl, role) {
    const url = String(redirectUrl || '');
    if (role === 'super_admin') {
        // Super Admins should land on the Super Admin dashboard by default, even if they were
        // redirected from the normal admin dashboard.
        if (url.includes('dashboard.html')) return false;
        return true;
    }
    // Non-super-admin users must never be redirected to the Super Admin dashboard.
    if (url.includes('superadmindb.html')) return false;
    return true;
}

/**
 * Redirects the user after a successful login.
 * Uses the URL we stored before redirecting them to the login page; otherwise
 * routes them to a role-appropriate landing page.
 *
 * @param {string} [role]
 * @returns {void}
 */
function redirectToStoredPage(role) {
    const stored = normalizeRedirectUrl(localStorage.getItem(REDIRECT_KEY));
    const fallback = getDefaultLandingPage(role);
    const redirectUrl = stored && isRedirectAllowedForRole(stored, role) ? stored : fallback;
    localStorage.removeItem(REDIRECT_KEY);
    window.location.href = redirectUrl;
}

/**
 * Shows an error message in the login form.
 *
 * @param {string} message
 * @returns {void}
 */
function showError(message) {
    const errorElement = document.getElementById('login-error');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = 'block';
    }
}

/**
 * Logs out the current user by destroying the server session and returning to login.
 * Safe to call from any page; even if the request fails, we still return to login.
 *
 * @returns {Promise<void>}
 */
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {
        console.error(e);
    }
    localStorage.removeItem(REDIRECT_KEY);
    window.location.replace('/login.html');
}

// ---- Simple modal confirm (reuses dialog.css styles) ----
const DIALOG_OVERLAY_ID = 'app-dialog-overlay';
const DIALOG_BOX_ID = 'app-dialog-box';
const DIALOG_TITLE_ID = 'app-dialog-title';
const DIALOG_MESSAGE_ID = 'app-dialog-message';
const DIALOG_ACTIONS_ID = 'app-dialog-actions';

/**
 * Lazily creates the shared dialog DOM nodes (once) and reuses them.
 * This keeps the markup out of every HTML file and ensures a consistent style.
 *
 * @returns {HTMLDivElement} overlay element that contains the dialog
 */
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

/**
 * Shows a confirm dialog and resolves to `true` only when the user clicks Logout.
 *
 * @param {string} message - Text shown to the user
 * @param {string} [title='Logout'] - Dialog title
 * @returns {Promise<boolean>}
 */
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

// Add event listeners to logout buttons (used on dashboard/project-editor pages)
document.addEventListener('DOMContentLoaded', function() {
    const logoutButtons = document.querySelectorAll('#logout-btn');
    logoutButtons.forEach(button => {
        button.addEventListener('click', async function(e) {
            e.preventDefault();
            const message = button.dataset && button.dataset.logoutMessage
                ? button.dataset.logoutMessage
                : 'Are you sure you want to log out?';
            const confirmed = await showLogoutConfirm(message, 'Logout');
            if (!confirmed) return;
            logout();
        });
    });
});

// Export functions for use in other scripts / pages
window.auth = {
    checkAuthentication,
    logout
};

// Run authentication check on page load
checkAuthentication();
