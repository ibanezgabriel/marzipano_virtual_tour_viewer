const express = require('express');
const authController = require('../controllers/auth.controller');
const { attachAuthenticatedUser } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/login', authController.login);
router.get('/status', attachAuthenticatedUser, authController.status);
router.get('/me', attachAuthenticatedUser, authController.me);
router.post('/logout', attachAuthenticatedUser, authController.logout);

module.exports = router;
