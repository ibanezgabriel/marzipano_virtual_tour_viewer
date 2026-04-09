const {
  AUTH_REQUIRED_PAGE_PATHS,
  SUPERADMIN_ONLY_PAGE_PATHS,
  SUPERADMIN_HOME_PATH,
  ADMIN_HOME_PATH,
} = require('../config/auth');
const {
  clearSessionCookie,
  getAuthenticatedUserFromRequest,
} = require('../services/auth.service');

async function attachAuthenticatedUser(req, _res, next) {
  if (req.authUser !== undefined) return next();
  try {
    req.authUser = await getAuthenticatedUserFromRequest(req);
    return next();
  } catch (error) {
    console.error('Authentication lookup failed:', error);
    return next(error);
  }
}

function requireAuthenticatedApi(req, res, next) {
  if (req.authUser) return next();
  clearSessionCookie(res);
  return res.status(401).json({ message: 'Authentication required.' });
}

function requireSuperAdminApi(req, res, next) {
  if (!req.authUser) {
    clearSessionCookie(res);
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (req.authUser.role !== 'superadmin') {
    return res.status(403).json({ message: 'Super admin access is required.' });
  }
  return next();
}

function isProtectedMutationRequest(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
  const requestPath = req.path || '';
  return (
    requestPath === '/api/projects' ||
    /^\/api\/projects\/[^/]+$/.test(requestPath) ||
    requestPath === '/upload' ||
    requestPath === '/upload-floorplan' ||
    requestPath === '/upload-floorplan/update' ||
    requestPath === '/api/floorplans/rename' ||
    /^\/api\/floorplans\/[^/]+$/.test(requestPath) ||
    requestPath === '/api/floorplans/order' ||
    requestPath === '/api/panos/order' ||
    requestPath === '/upload/rename' ||
    requestPath === '/upload/update' ||
    requestPath === '/api/floorplan-hotspots' ||
    requestPath === '/api/blur-masks' ||
    requestPath === '/api/hotspots' ||
    requestPath === '/api/initial-views' ||
    /^\/upload\/[^/]+$/.test(requestPath)
  );
}

async function protectHtmlPages(req, res, next) {
  const requestPath = req.path || '';
  if (!AUTH_REQUIRED_PAGE_PATHS.has(requestPath)) return next();

  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      clearSessionCookie(res);
      const redirect = encodeURIComponent(req.originalUrl || req.url || '/dashboard.html');
      return res.redirect(`/login.html?redirect=${redirect}`);
    }

    req.authUser = user;

    if (user.role === 'superadmin' && requestPath !== SUPERADMIN_HOME_PATH) {
      return res.redirect(SUPERADMIN_HOME_PATH);
    }

    if (SUPERADMIN_ONLY_PAGE_PATHS.has(requestPath) && user.role !== 'superadmin') {
      return res.redirect(ADMIN_HOME_PATH);
    }

    return next();
  } catch (error) {
    console.error('Protected page check failed:', error);
    return res.status(503).send('Authentication is temporarily unavailable.');
  }
}

async function protectMutationRequests(req, res, next) {
  if (!isProtectedMutationRequest(req)) return next();

  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ message: 'Authentication required.' });
    }

    req.authUser = user;
    return next();
  } catch (error) {
    console.error('Protected API check failed:', error);
    return res.status(503).json({ message: 'Authentication is temporarily unavailable.' });
  }
}

module.exports = {
  attachAuthenticatedUser,
  requireAuthenticatedApi,
  requireSuperAdminApi,
  protectHtmlPages,
  protectMutationRequests,
};
