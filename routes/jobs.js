const express = require('express');

function createJobsRouter({ jobsService }) {
  const router = express.Router();

  router.get('/jobs/:id', (req, res) => {
    const job = jobsService.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json({ id: job.id, status: job.status, percent: job.percent, message: job.message, error: job.error });
  });

  return router;
}

module.exports = createJobsRouter;

