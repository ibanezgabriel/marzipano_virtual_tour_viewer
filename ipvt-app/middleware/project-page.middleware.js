/* Validates project access before project pages are served. */
const fs = require('fs');
const path = require('path');
const {
  getProjectIdFromQuery,
  getProjectPaths,
} = require('../services/project-paths.service');

/* Handles escape html. */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Handles has ready tiles. */
function hasReadyTiles(tilesRoot) {
  try {
    if (!fs.existsSync(tilesRoot)) return false;
    const children = fs.readdirSync(tilesRoot, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const metaPath = path.join(tilesRoot, child.name, 'meta.json');
      if (fs.existsSync(metaPath)) return true;
    }
  } catch (error) {
    console.error('Error checking tiles:', error);
  }
  return false;
}

/* Handles guard project pages. */
function guardProjectPages(req, res, next) {
  const requestPath = req.path || '';
  if (
    requestPath !== '/dashboard.html' &&
    requestPath !== '/project-viewer-panoramas.html' &&
    requestPath !== '/project-viewer-layout.html'
  ) return next();

  try {
    const projectId = getProjectIdFromQuery(req);
    if (!projectId) return next();

    const projectPaths = getProjectPaths(projectId);
    if (!projectPaths || !fs.existsSync(projectPaths.base)) {
      const safeId = escapeHtml(projectId);
      return res.status(404).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Project not found</title>
  <style>
    html,body{height:100%;margin:0;background:#f7f7fb;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{max-width:640px;width:100%;background:white;border-radius:12px;box-shadow:0 8px 30px rgba(22,30,60,0.08);padding:32px;text-align:center}
    .title{font-size:20px;margin:0 0 8px;font-weight:700;font-style:italic}
    .sub{color:#555;margin:0 0 16px}
    .btn{display:inline-block;padding:10px 14px;border-radius:8px;background:#2563eb;color:white;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Project not found</h1>
      <p class="sub">We couldn't find the project<strong style="font-style:italic"> ${safeId || '(unspecified)'}</strong>.</p>
    </div>
  </div>
</body>
</html>`);
    }

    if (requestPath === '/dashboard.html') return next();

    if (!hasReadyTiles(projectPaths.tiles)) {
      return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not ready</title><style>html,body{height:100%;margin:0} .c{height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif} .msg{font-style:italic;font-weight:700}</style></head><body><div class="c"><div class="msg">Project is not yet published.</div></div></body></html>`);
    }

    return next();
  } catch (error) {
    console.error('Error in dashboard/project-viewer guard middleware:', error);
    return next();
  }
}

module.exports = {
  guardProjectPages,
};
