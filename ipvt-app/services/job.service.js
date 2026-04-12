const jobs = new Map();

function createJob(filenames, projectId) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = {
    id,
    projectId,
    filenames,
    status: 'processing',
    percent: 0,
    message: '',
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  createJob,
  getJob,
};
