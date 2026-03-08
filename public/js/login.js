// Authentication and session management
const AUTH_KEY = 'ipvt_auth_token';
const REDIRECT_KEY = 'ipvt_redirect_url';

// Simple authentication check (in production, this would validate against a server)
function isAuthenticated() {
    return localStorage.getItem(AUTH_KEY) === 'true';
}

function setAuthenticated(status) {
    if (status) {
        localStorage.setItem(AUTH_KEY, 'true');
    } else {
        localStorage.removeItem(AUTH_KEY);
    }
}

// Check authentication on page load for all pages except login
function checkAuthentication() {
    const currentPage = window.location.pathname.split('/').pop();
    
  // Don't check authentication for login page itself or public client view
  if (currentPage === 'login.html' || currentPage === 'project-viewer.html') {
        return;
    }
    
    if (!isAuthenticated()) {
        // Store the intended destination before redirecting to login
        localStorage.setItem(REDIRECT_KEY, window.location.href);
        window.location.href = 'login.html';
    }
}

// Handle login form submission
document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('login-form');
    const errorElement = document.getElementById('login-error');
    
    if (loginForm) {
        loginForm.addEventListener('submit', function(e) {
            e.preventDefault();
            
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            // Simple validation (in production, this would call an API)
            if (!username || !password) {
                showError('Please enter both username and password');
                return;
            }
            
            // Simple demo authentication (replace with actual authentication)
            if (username === 'admin' && password === 'password') {
                handleSuccessfulLogin();
            } else {
                showError('Invalid credentials. please try again');
            }
        });
    }
    
    // Check if user is already logged in and redirect if necessary
    if (window.location.pathname.includes('login.html') && isAuthenticated()) {
        redirectToStoredPage();
    }
});

function handleSuccessfulLogin() {
    setAuthenticated(true);
    redirectToStoredPage();
}

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
function logout() {
    setAuthenticated(false);
    window.location.href = 'login.html';
}

// Add event listeners to logout buttons
document.addEventListener('DOMContentLoaded', function() {
    const logoutButtons = document.querySelectorAll('#logout-btn');
    logoutButtons.forEach(button => {
        button.addEventListener('click', function(e) {
            e.preventDefault();
            logout();
        });
    });
});

// Export functions for use in other scripts
window.auth = {
    isAuthenticated,
    setAuthenticated,
    checkAuthentication,
    logout
};

// Run authentication check on page load
checkAuthentication();