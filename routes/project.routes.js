const express = require('express');
const projectController = require('../controllers/project.controller');
const {
  attachAuthenticatedUser,
  requireAuthenticatedApi,
} = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', projectController.list);
router.post('/', attachAuthenticatedUser, requireAuthenticatedApi, projectController.create);
router.put('/:id', attachAuthenticatedUser, requireAuthenticatedApi, projectController.update);
router.delete('/:id', attachAuthenticatedUser, requireAuthenticatedApi, projectController.remove);

module.exports = router;
