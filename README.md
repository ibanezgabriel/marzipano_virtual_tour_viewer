# QCDE-IPVT (Quezon City Department of Engineering | Infrastructure Project Virtual Tour)
A high-performance 360-degree visualization platform for infrastructure site inspection and public transparency.

## Introduction
The QCDE-IPVT is a virtual platform that showcases LGU-led infrastructure projects through interactive experiences. By offering a clear and verifiable view of completed projects, the system enhances transparency and enables citizens to remotely explore the city's developments. It serves as a digital showcase of Quezon City's infrastructure progress, ensuring that public investments are clearly reflected in tangible, high-quality results.

> **Official mission**: Provide a transparent, high-fidelity digital record of Quezon City's infrastructure milestones. QCDE-IPVT serves as the authoritative visual archive for site inspections and project validation.

## Core features
- 360-degree Marzipano viewer
- Project dashboard (create/update projects; deletion is intentionally disabled)
- Project editor (upload/manage panoramas and layouts/floorplans)
- Hotspots (layout -> panorama and panorama -> panorama)
- Audit logs (tracks changes to projects/assets)
- User management (SuperAdmin and Admin roles)
- Realtime/session stability via Socket.IO (e.g., tab lifecycle signals)

## Tech stack / architecture
- **Backend**: Node.js + Express (serves APIs + static pages from `ipvt-app/public/`)
- **Realtime**: Socket.IO (server + client)
- **Database**: PostgreSQL (users, projects, panoramas, hotspots, audit logs, etc.)
- **Storage**: filesystem-based project storage under `ipvt-storage/` (tiles, uploads, layouts, audit files)

## Prerequisites
- Node.js (LTS) + npm
- PostgreSQL (local or remote)
- (Optional) SSL certificate + key for HTTPS (required when `NODE_ENV=production`)

## Quick start (local development)
Run these from the `ipvt-app/` folder:

1) Install dependencies
```bash
npm install
```

2) Create your environment file
- Recommended location: `ipvt-app/.env` (because `npm start` runs from `ipvt-app/`)
- Most DB scripts also support reading from a repo-root `.env` as a fallback

Example `ipvt-app/.env` (do **not** commit this file):
```ini
# --- Database ---
# Option A: use PG* variables
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=ipvt_db

# Option B: use DATABASE_URL (overrides PG* usage in DB scripts)
# DATABASE_URL=postgres://user:password@localhost:5432/ipvt_db

# --- Server ---
PORT=3152
NODE_ENV=development
SESSION_SECRET=change-me

# --- Storage (optional) ---
# Defaults to: <repo>/ipvt-storage
# IPVT_STORAGE_ROOT=C:\\path\\to\\ipvt-storage

# --- Bootstrap user (used by npm run seed:user) ---
SUPERADMIN_USERNAME=superadmin
SUPERADMIN_PASSWORD=change-me-min-8-chars

# --- Maintenance (optional) ---
# CLEAR_ALL_SESSIONS_ON_START=true
```

3) Initialize DB schema (and create the DB if needed)
```bash
npm run db:init
```

4) (Optional) Verify DB connectivity
```bash
npm run db:test
```

5) Seed the bootstrap SuperAdmin account
```bash
npm run seed:user
```

6) Start the server
```bash
npm start
```

Open:
- `http://localhost:3152/` (HTTP mode), or
- `https://localhost:3152/` (HTTPS mode, if SSL is enabled)

## Storage and project data
QCDE-IPVT stores project assets on disk under the storage root (`IPVT_STORAGE_ROOT`), defaulting to the repo sibling directory `ipvt-storage/`.

Key paths (default):
- `ipvt-storage/projects/projects.json`: project manifest (source of truth for the dashboard list)
- `ipvt-storage/projects/<project-id>/upload/`: raw panorama uploads (protected route)
- `ipvt-storage/projects/<project-id>/tiles/`: generated tiles used by the viewer
- `ipvt-storage/projects/<project-id>/layouts/`: layout/floorplan images
- `ipvt-storage/projects/<project-id>/data/`: hotspots, ordering, audit logs, etc.

### Migrating existing storage into Postgres (recommended)
If you already have projects in `ipvt-storage/` and want them reflected in the DB:
```bash
npm run migrate:data
```

## HTTPS / SSL
The server automatically starts in HTTPS mode if both files exist:
- `ipvt-app/certificates/key.pem`
- `ipvt-app/certificates/cert.pem`

Behavior:
- If **certificates are missing** and `NODE_ENV` is **not** `production`, it will start in **HTTP** mode for development.
- If `NODE_ENV=production` and certificates are missing, the server **refuses to start**.

## Roles and access
- **SuperAdmin**: can access `user-management.html` and manage users.
- **Admin**: can access the dashboard and project pages, but not SuperAdmin-only pages.

## Scripts
From `ipvt-app/`:
- `npm run db:init`: create DB (if needed) and apply schema
- `npm run db:test`: verify DB connectivity
- `npm run seed:user`: inject the bootstrap SuperAdmin account
- `npm run migrate:data`: sync the existing projects from `ipvt-storage/` into Postgres

## Deployment notes
- **Secrets**: do not commit `.env` files or `.pem` files (this repo ignores `*.env` and `*.pem`). Use a secret manager or secure environment variables.
- **Process manager** (optional): you can run the server under PM2 (install PM2 separately) using the entrypoint `ipvt-app/server.js`.
- **Persistent storage**: `ipvt-storage/` should live on a persistent disk/volume and be backed up separately from the code.

## Troubleshooting
- **Server starts in HTTP when you expect HTTPS**: ensure `ipvt-app/certificates/key.pem` and `ipvt-app/certificates/cert.pem` exist.
- **Login loops / cookie issues**: in production, cookies are `secure` and require HTTPS (`NODE_ENV=production`).
- **Viewer says `Project is not yet published.`**: the viewer requires ready tiles under `ipvt-storage/projects/<project-id>/tiles/` (a `meta.json` must exist for at least one panorama).
- **DB init fails to create the database**: create the database manually or ensure `PGDATABASE` contains only letters/numbers/underscores (the initializer refuses unsafe identifiers).
