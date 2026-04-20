/* Stores authentication-related configuration values. */
const SESSION_COOKIE_NAME = 'ipvt_session';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: IS_PRODUCTION,
  path: '/',
};

const AUTH_REQUIRED_PAGE_PATHS = new Set(['/dashboard.html', '/project-editor.html', '/user-management.html']);
const SUPERADMIN_ONLY_PAGE_PATHS = new Set(['/user-management.html']);
const SUPERADMIN_HOME_PATH = '/user-management.html';
const ADMIN_HOME_PATH = '/dashboard.html';

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  AUTH_REQUIRED_PAGE_PATHS,
  SUPERADMIN_ONLY_PAGE_PATHS,
  SUPERADMIN_HOME_PATH,
  ADMIN_HOME_PATH,
};
