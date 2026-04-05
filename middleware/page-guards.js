const fs = require('fs');
const path = require('path');

function createPageGuards({ projectsService, getValidSessionUser, isAdminRole }) {
  async function dashboardAndViewerGuard(req, res, next) {
    const ppath = req.path || '';
    if (ppath !== '/dashboard.html' && ppath !== '/project-viewer.html') return next();
    try {
      const projectToken = await projectsService.getProjectIdFromQuery(req);
      if (!projectToken) return next();

      const project = await projectsService.findProjectByIdOrNumber(projectToken);
      if (!project) {
        const safeId = String(projectToken || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project not found</title></head><body><p style="font-family:Arial,sans-serif;padding:20px">Project not found: <strong>${safeId}</strong>.</p></body></html>`);
      }

      // Workflow visibility: only published projects are viewable publicly.
      if (ppath === '/project-viewer.html' && String(project.workflow_state || 'DRAFT') !== 'PUBLISHED') {
        const user = await getValidSessionUser(req);
        if (!user || !isAdminRole(user.role)) {
          return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not published</title><style>html,body{height:100%;margin:0} .c{height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif} .msg{font-style:italic;font-weight:700}</style></head><body><div class="c"><div class="msg">Project is not yet published.</div></div></body></html>`);
        }
      }

      const projectId = project.id;

      const folderName = projectsService.getProjectFolderName(project) || projectId;
      const p = projectsService.getProjectPaths(folderName);
      if (!p || !fs.existsSync(p.base)) {
        const safeId = String(projectId || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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
    .hint{color:#777;font-size:13px}
    .actions{margin-top:18px}
    .btn{display:inline-block;padding:10px 14px;border-radius:8px;background:#2563eb;color:white;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Project not found</h1>
      <p class="sub">We couldn't find the project<strong style="font-style:italic"> ${safeId || '(unspecified)'}</strong>.</p>
  </div>
</body>
</html>`);
      }

      if (ppath === '/dashboard.html') return next();

      const tilesDir = p.tiles;
      const hasReadyTiles = (tilesRoot) => {
        try {
          if (!fs.existsSync(tilesRoot)) return false;
          const children = fs.readdirSync(tilesRoot, { withFileTypes: true });
          for (const d of children) {
            if (!d.isDirectory()) continue;
            const metaPath = path.join(tilesRoot, d.name, 'meta.json');
            if (fs.existsSync(metaPath)) return true;
          }
        } catch (e) {
          console.error('Error checking tiles:', e);
        }
        return false;
      };

      if (!hasReadyTiles(tilesDir)) {
        return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not ready</title><style>html,body{height:100%;margin:0} .c{height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif} .msg{font-style:italic;font-weight:700}</style></head><body><div class="c"><div class="msg">Project is not yet published.</div></div></body></html>`);
      }

      return next();
    } catch (e) {
      console.error('Error in dashboard/project-viewer guard middleware:', e);
      return next();
    }
  }

  return {
    dashboardAndViewerGuard,
  };
}

module.exports = createPageGuards;
