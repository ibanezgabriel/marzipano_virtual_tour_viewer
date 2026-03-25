// Authentication and session management
const REDIRECT_KEY = 'ipvt_redirect_url';

// Check authentication status from server
async function checkAuthentication() {
    const currentPage = window.location.pathname.split('/').pop();
    
    // Public viewer is allowed without login
    if (currentPage === 'project-viewer.html') {
        return;
    }

    // Check if we are on the login page (or root)
    const isLoginPage = currentPage === 'login.html' || currentPage === 'index.html' || currentPage === '';

    try {
        const res = await fetch('/api/me');
        const data = await res.json();
        
        if (data.loggedIn) {
            if (isLoginPage) redirectToStoredPage();
        } else {
            if (!isLoginPage) {
                localStorage.setItem(REDIRECT_KEY, window.location.href);
                window.location.href = '/';
            }
        }
    } catch (e) {
        console.error('Auth check failed:', e);
        if (!isLoginPage) window.location.href = '/';
    }
}

// Handle login form submission
document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('login-form');
    const errorElement = document.getElementById('login-error');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            if (!username || !password) {
                showError('Please enter both username and password');
                return;
            }
            
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (data.success) {
                    redirectToStoredPage();
                } else {
                    showError(data.message || 'Invalid credentials');
                }
            } catch (err) {
                console.error(err);
                showError('Server connection error');
            }
        });
    }
});

function redirectToStoredPage() {
    const redirectUrl = localStorage.getItem(REDIRECT_KEY) || 'dashboard.html';
    localStorage.removeItem(REDIRECT_KEY);
    window.location.href = redirectUrl;
}

function showError(message) {
    const errorElement = document.getElementById('login-error');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = 'block';
    }
}

// Logout function (can be called from other pages)
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {
        console.error(e);
    }
    window.location.href = '/';
}

// Simple modal confirm (reuses dialog.css styles)
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

// Add event listeners to logout buttons
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

// Export functions for use in other scripts
window.auth = {
    checkAuthentication,
    logout
};

// Run authentication check on page load
checkAuthentication();
