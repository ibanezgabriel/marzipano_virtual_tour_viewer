-- USERS
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active_session_id TEXT,
  active_session_expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  legacy_id TEXT UNIQUE,
  project_number TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS legacy_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_legacy_id
  ON projects(legacy_id);

-- PANORAMAS
CREATE TABLE IF NOT EXISTS panoramas (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  initial_yaw DOUBLE PRECISION,
  initial_pitch DOUBLE PRECISION,
  initial_fov DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panoramas_project_id ON panoramas(project_id);

-- LAYOUTS (multiple per project)
CREATE TABLE IF NOT EXISTS layouts (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  layout_filename TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layouts_project_id ON layouts(project_id);
CREATE INDEX IF NOT EXISTS idx_layouts_created_by ON layouts(created_by);

-- PANORAMA HOTSPOTS
CREATE TABLE IF NOT EXISTS panorama_hotspots (
  id BIGSERIAL PRIMARY KEY,
  panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
  target_panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
  yaw DOUBLE PRECISION NOT NULL,
  pitch DOUBLE PRECISION NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_panorama_id ON panorama_hotspots(panorama_id);
CREATE INDEX IF NOT EXISTS idx_panorama_hotspots_target_panorama_id ON panorama_hotspots(target_panorama_id);

-- LAYOUT HOTSPOTS
CREATE TABLE IF NOT EXISTS layout_hotspots (
  id BIGSERIAL PRIMARY KEY,
  layout_id BIGINT NOT NULL REFERENCES layouts(id),
  target_panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layout_hotspots_layout_id ON layout_hotspots(layout_id);
CREATE INDEX IF NOT EXISTS idx_layout_hotspots_target_panorama_id ON layout_hotspots(target_panorama_id);

-- BLUR MASKS
CREATE TABLE IF NOT EXISTS blur_masks (
  id BIGSERIAL PRIMARY KEY,
  panorama_id BIGINT NOT NULL REFERENCES panoramas(id),
  yaw DOUBLE PRECISION NOT NULL,
  pitch DOUBLE PRECISION NOT NULL,
  radius DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blur_masks_panorama_id ON blur_masks(panorama_id);

-- AUDIT LOGS (project-scoped only)
-- project_number + project_name are snapshots so old logs keep old values after renames/edits.
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  project_number TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_project_id ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_by ON audit_logs(created_by);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
