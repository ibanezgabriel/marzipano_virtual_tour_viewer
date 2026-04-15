/* Registers job tracking API endpoints. */
const express = require('express');
const { getJob } = require('../services/job.service');

const router = express.Router();

/* Wires HTTP endpoints to their controller handlers. */
router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  return res.json({
    id: job.id,
    status: job.status,
    percent: job.percent,
    message: job.message,
    error: job.error,
  });
});

module.exports = router;
