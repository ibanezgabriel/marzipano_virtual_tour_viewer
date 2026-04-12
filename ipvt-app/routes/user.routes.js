const express = require('express');
const userController = require('../controllers/user.controller');
const {
  attachAuthenticatedUser,
  requireSuperAdminApi,
} = require('../middleware/auth.middleware');

const router = express.Router();

router.use(attachAuthenticatedUser);
router.use(requireSuperAdminApi);

router.get('/', userController.list);
router.post('/', userController.create);
router.put('/:id', userController.update);
router.delete('/:id', userController.remove);

module.exports = router;
