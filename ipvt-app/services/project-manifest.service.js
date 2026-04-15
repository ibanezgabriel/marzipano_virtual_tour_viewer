/* Reads and writes the project manifest file. */
const fs = require('fs');
const path = require('path');

const { projectsDir } = require('../config/storage-paths');
const projectsManifestPath = path.join(projectsDir, 'projects.json');
const MAX_PROJECT_NUMBER_LENGTH = 20;
const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);

if (!fs.existsSync(projectsDir)) {
  fs.mkdirSync(projectsDir, { recursive: true });
}

/* Maps project status values to the allowed set. */
function normalizeProjectStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'in-progress') return 'on-going';
  return ALLOWED_PROJECT_STATUSES.has(normalized) ? normalized : 'on-going';
}

/* Gets get projects manifest. */
function getProjectsManifest() {
  try {
    const raw = fs.readFileSync(projectsManifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let changed = false;
    const normalized = parsed.map((project) => {
      if (!project || typeof project !== 'object') return project;
      const status = normalizeProjectStatus(project.status);
      if (project.status !== status) changed = true;
      return { ...project, status };
    });
    if (changed) {
      writeProjectsManifest(normalized);
    }
    return normalized;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading projects manifest:', error);
    return [];
  }
}

/* Updates write projects manifest. */
function writeProjectsManifest(projects) {
  const normalized = Array.isArray(projects)
    ? projects.map((project) => {
        if (!project || typeof project !== 'object') return project;
        return { ...project, status: normalizeProjectStatus(project.status) };
      })
    : projects;
  fs.writeFileSync(projectsManifestPath, JSON.stringify(normalized, null, 2), 'utf8');
}

/* Gets find project by id or number. */
function findProjectByIdOrNumber(token) {
  if (!token) return null;
  const value = String(token).trim();
  if (!value) return null;
  const projects = getProjectsManifest();
  return projects.find((project) => (
    project.id === value ||
    (project.number && String(project.number).trim() === value)
  )) || null;
}

/* Updates sanitize project id. */
function sanitizeProjectId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || 'project';
}

module.exports = {
  projectsDir,
  projectsManifestPath,
  MAX_PROJECT_NUMBER_LENGTH,
  getProjectsManifest,
  writeProjectsManifest,
  findProjectByIdOrNumber,
  sanitizeProjectId,
  normalizeProjectStatus,
};
