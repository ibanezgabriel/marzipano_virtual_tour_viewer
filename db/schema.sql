-- 1. USERS: Supports User Roles (Admin vs Super Admin)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin', -- 'super_admin', 'admin', 'viewer'
    -- Enforce "single active session per account" (used to prevent concurrent logins).
    active_session_id VARCHAR(255),
    active_session_expires_at TIMESTAMP,
    -- User status for Super Admin management (suspended users cannot authenticate).
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. PROJECTS: Replaces projects.json
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(255) PRIMARY KEY, -- Slug ID (e.g. 'project-alpha')
    name VARCHAR(255) NOT NULL,
    number VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'on-going',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. PANORAMAS: Replaces panorama-order.json, initial-views.json
CREATE TABLE IF NOT EXISTS panoramas (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    rank INTEGER DEFAULT 0,
    initial_view JSONB DEFAULT '{}', -- { yaw, pitch, fov }
    blur_mask JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, filename)
);

-- 4. LAYOUTS (formerly FLOORPLANS): Replaces floorplan-order.json
CREATE TABLE IF NOT EXISTS layouts (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    rank INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, filename)
);

-- 5. HOTSPOTS: Replaces hotspots.json
CREATE TABLE IF NOT EXISTS hotspots (
    id SERIAL PRIMARY KEY,
    source_pano_id INTEGER REFERENCES panoramas(id) ON DELETE CASCADE,
    target_pano_id INTEGER REFERENCES panoramas(id) ON DELETE SET NULL,
    yaw DOUBLE PRECISION NOT NULL,
    pitch DOUBLE PRECISION NOT NULL,
    rotation DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. LAYOUT HOTSPOTS (formerly FLOORPLAN HOTSPOTS): Replaces floorplan-hotspots.json
CREATE TABLE IF NOT EXISTS layout_hotspots (
    id SERIAL PRIMARY KEY,
    layout_id INTEGER REFERENCES layouts(id) ON DELETE CASCADE,
    target_pano_id INTEGER REFERENCES panoramas(id) ON DELETE CASCADE,
    x_coord DOUBLE PRECISION NOT NULL,
    y_coord DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. AUDIT LOGS: Replaces audit/*.json
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(255) REFERENCES projects(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    message TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. APPROVAL REQUESTS: New feature for Super Admin workflow
CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    requester_id INTEGER REFERENCES users(id),
    project_id VARCHAR(255) REFERENCES projects(id) ON DELETE SET NULL,
    request_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    admin_comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
