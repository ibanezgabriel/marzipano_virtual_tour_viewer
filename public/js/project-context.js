/**
 * Project context: read ?project= from URL, provide helpers for API URLs and asset paths.
 */

function getProjectId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('project') || null;
}

/** Append ?project=id to a URL if we have a project. */
function appendProjectParams(url) {
  const id = getProjectId();
  if (!id) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}project=${encodeURIComponent(id)}`;
}

/** Base path for upload assets (project-scoped or legacy). */
function getUploadBase() {
  const id = getProjectId();
  return id ? `/projects/${encodeURIComponent(id)}/upload` : '/upload';
}

/** Base path for tile assets (project-scoped or legacy). */
function getTilesBase() {
  const id = getProjectId();
  return id ? `/projects/${encodeURIComponent(id)}/tiles` : '/tiles';
}

export { getProjectId, appendProjectParams, getUploadBase, getTilesBase };
