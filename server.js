/**
 * Express backend for the IPVT (Infrastructure Projects Virtual Tour) tool.
 *
 * High-level responsibilities:
 * - Session-based authentication (Admin / Super Admin)
 * - Project CRUD APIs backed by PostgreSQL
 * - Static asset serving for the frontend (HTML/CSS/JS)
 * - File-based project assets (tiles/uploads) served via project-scoped routes
 * - Realtime updates via Socket.IO (e.g., projects list changes)
 * - Audit logging of important actions (when the DB table is available)
 *
 * NOTE: This file is intentionally a thin "composition root".
 * Route logic lives under `routes/`, shared logic under `services/` and `middleware/`.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const https = require('https');
const { Server } = require('socket.io');

const db = require('./db');
const { upload, floorplanUpload } = require('./utils/multer-config');
const {
  buildTilesForImage,
  readTilesMeta,
  tileIdFromFilename,
  removeDirIfExists,
} = require('./public/js/tiler');

const createAuthMiddleware = require('./middleware/auth');
const createPageGuards = require('./middleware/page-guards');

const createDbBootstrapService = require('./services/db-bootstrap');
const createProjectsService = require('./services/projects');
const createRealtimeService = require('./services/realtime');
const createAuditLogsService = require('./services/audit-logs');
const createLegacyAuditLogService = require('./services/legacy-audit-log');
const createApprovalRequestsService = require('./services/approval-requests');
const createProjectWorkflowService = require('./services/project-workflow');
const createJobsService = require('./services/jobs');

const createAuthRouter = require('./routes/auth');
const createNotificationsRouter = require('./routes/notifications');
const createAuditLogsRouter = require('./routes/audit-logs');
const createApprovalRequestsRouter = require('./routes/approval-requests');
const createUsersRouter = require('./routes/users');
const createProjectsRouter = require('./routes/projects');
const createJobsRouter = require('./routes/jobs');
const createArchiveRouter = require('./routes/archive');
const createLayoutsRouter = require('./routes/layouts');
const createPanoramasRouter = require('./routes/panoramas');
const createHotspotsRouter = require('./routes/hotspots');
const createBlurMasksRouter = require('./routes/blur-masks');
const createInitialViewsRouter = require('./routes/initial-views');

const createPanoramaUploadRouter = require('./routes/panorama-upload');
const createLayoutUploadsRouter = require('./routes/layout-uploads');
const createProjectStaticRouter = require('./routes/project-static');

const app = express();
const PORT = 3000;

const projectsDir = path.join(__dirname, 'projects');
if (!fs.existsSync(projectsDir)) {
  fs.mkdirSync(projectsDir, { recursive: true });
}

// Middleware to parse JSON bodies
app.use(express.json());

// ---- Authentication & Session ----
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_key_change_in_prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// ---- Core services / middleware ----
const auth = createAuthMiddleware({ db });
const projectsService = createProjectsService({ db, projectsDir });

const dbBootstrapService = createDbBootstrapService({ db });
dbBootstrapService.ensureSingleSessionColumns().catch(() => {});
dbBootstrapService.ensureProjectWorkflowColumns().catch(() => {});
dbBootstrapService.ensureProjectFolderColumns().catch(() => {});

const auditLogsService = createAuditLogsService({ db });
auditLogsService.ensureAuditLogSnapshotColumns().catch(() => {});

// ---- Static page protection & redirects ----
app.use(auth.protectAdmin);

// Backward-compatible redirects (staging pages were merged into the main pages).
app.get('/staging-dashboard.html', (req, res) => {
  res.redirect('/dashboard.html?view=staging');
});
app.get('/staging-editor.html', (req, res) => {
  try {
    const url = new URL(req.originalUrl, 'http://localhost');
    if (!url.searchParams.get('view')) url.searchParams.set('view', 'staging');
    const qs = url.searchParams.toString();
    res.redirect(qs ? `/project-editor.html?${qs}` : '/project-editor.html');
  } catch (e) {
    res.redirect('/dashboard.html?view=staging');
  }
});

const pageGuards = createPageGuards({
  projectsService,
  getValidSessionUser: auth.getValidSessionUser,
  isAdminRole: auth.isAdminRole,
});
app.use(pageGuards.dashboardAndViewerGuard);

// Serve static files
app.get(['/', '/index.html'], (req, res) => res.redirect('/login.html'));
app.use(express.static(path.join(__dirname, 'public')));

// Project-scoped static: /projects/:id/upload and /projects/:id/tiles
app.use(
  '/projects/:projectId',
  createProjectStaticRouter({
    projectsService,
    getValidSessionUser: auth.getValidSessionUser,
    isAdminRole: auth.isAdminRole,
  })
);

// ---- HTTPS server + Socket.IO ----
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

const server = https.createServer(sslOptions, app);
const io = new Server(server);

const realtimeService = createRealtimeService({ db, io });
realtimeService.registerSocketHandlers();

// ---- Remaining services (depend on io and/or audit logging) ----
const legacyAuditLogService = createLegacyAuditLogService({
  insertAuditLog: auditLogsService.insertAuditLog,
});

const approvalRequestsService = createApprovalRequestsService({
  db,
  normalizeProjectStatus: projectsService.normalizeProjectStatus,
  insertAuditLog: auditLogsService.insertAuditLog,
  emitProjectsChanged: realtimeService.emitProjectsChanged,
});
approvalRequestsService.ensureApprovalRequestNotificationColumns().catch(() => {});

const projectWorkflowService = createProjectWorkflowService({
  db,
  emitProjectsChanged: realtimeService.emitProjectsChanged,
  insertAuditLog: auditLogsService.insertAuditLog,
  isSuperAdminRole: auth.isSuperAdminRole,
});

const jobsService = createJobsService();

// ---- Routers ----
const apiRouter = express.Router();

apiRouter.use(createAuthRouter({ db, bcrypt, auth }));
apiRouter.use(
  createNotificationsRouter({
    db,
    approvalRequestsService,
    requireApiAuth: auth.requireApiAuth,
  })
);
apiRouter.use(
  createAuditLogsRouter({
    auditLogsService,
    requireSuperAdminApiAuth: auth.requireSuperAdminApiAuth,
  })
);
apiRouter.use(
  createApprovalRequestsRouter({
    approvalRequestsService,
    requireApiAuth: auth.requireApiAuth,
    requireSuperAdminApiAuth: auth.requireSuperAdminApiAuth,
  })
);
apiRouter.use(
  createUsersRouter({
    db,
    bcrypt,
    insertAuditLog: auditLogsService.insertAuditLog,
    requireSuperAdminApiAuth: auth.requireSuperAdminApiAuth,
    isSuperAdminRole: auth.isSuperAdminRole,
  })
);
apiRouter.use(
  createProjectsRouter({
    db,
    projectsService,
    requireApiAuth: auth.requireApiAuth,
    getValidSessionUser: auth.getValidSessionUser,
    isAdminRole: auth.isAdminRole,
    isSuperAdminRole: auth.isSuperAdminRole,
    emitProjectsChanged: realtimeService.emitProjectsChanged,
    insertAuditLog: auditLogsService.insertAuditLog,
  })
);
apiRouter.use(createJobsRouter({ jobsService }));
apiRouter.use(createArchiveRouter({ projectsService, legacyAuditLogService }));
apiRouter.use(
  createLayoutsRouter({
    db,
    io,
    projectsService,
    legacyAuditLogService,
    insertAuditLog: auditLogsService.insertAuditLog,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    requireApiAuth: auth.requireApiAuth,
  })
);
apiRouter.use(
  createPanoramasRouter({
    db,
    io,
    projectsService,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    buildTilesForImage,
    readTilesMeta,
    tileIdFromFilename,
    requireApiAuth: auth.requireApiAuth,
  })
);
apiRouter.use(
  createHotspotsRouter({
    db,
    io,
    projectsService,
    insertAuditLog: auditLogsService.insertAuditLog,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    requireApiAuth: auth.requireApiAuth,
  })
);
apiRouter.use(
  createBlurMasksRouter({
    db,
    io,
    projectsService,
    insertAuditLog: auditLogsService.insertAuditLog,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    requireApiAuth: auth.requireApiAuth,
  })
);
apiRouter.use(
  createInitialViewsRouter({
    db,
    io,
    projectsService,
    insertAuditLog: auditLogsService.insertAuditLog,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    requireApiAuth: auth.requireApiAuth,
  })
);

app.use('/api', apiRouter);

// Upload routes intentionally remain at the root (not under /api) for backward compatibility.
app.use(
  createPanoramaUploadRouter({
    db,
    io,
    upload,
    jobsService,
    projectsService,
    legacyAuditLogService,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    buildTilesForImage,
    tileIdFromFilename,
    removeDirIfExists,
    requireApiAuth: auth.requireApiAuth,
  })
);
app.use(
  createLayoutUploadsRouter({
    db,
    io,
    floorplanUpload,
    projectsService,
    legacyAuditLogService,
    markProjectModifiedIfPublished: projectWorkflowService.markProjectModifiedIfPublished,
    requireApiAuth: auth.requireApiAuth,
  })
);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at https://localhost:${PORT}`);
});
