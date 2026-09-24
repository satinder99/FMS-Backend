// authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  signUpController,
  signInController,
  refreshController,
  logoutController,
  logoutAllController,
  assignOrgAndRoleController,
  generateUsernameController,
} = require('../Conntrollers/authController');
const { requireAuth, requireRole } = require('../Middlewares/authMiddleware');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

router.post('/signup', signUpController);
router.post('/signin', authLimiter, signInController);
router.post('/refresh', authLimiter, refreshController);
router.post('/logout', logoutController);

// Self-service — any logged-in user can generate THEIR OWN username,
// once (guarded inside generateUsername itself: fails if already set
// or if org/role haven't been assigned yet).
router.post('/generate-username', requireAuth, generateUsernameController);

// Admin-only from here down.
router.post('/logout-all', requireAuth, requireRole('admin'), logoutAllController);
router.post('/assign', requireAuth, requireRole('admin'), assignOrgAndRoleController);

module.exports = router;