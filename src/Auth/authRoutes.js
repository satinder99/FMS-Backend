
// authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  signUpController,
  signInController,
  refreshController,
  logoutController,
  logoutAllController,
} = require('./authController');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

// Throttle sign-in/refresh attempts per IP — a second layer on top of
// the per-account lockout in authService.js.
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

// Admin-only in practice — protect this further with a role check once
// you have role-based authorization wired up, not just requireAuth.
router.post('/logout-all', requireAuth, logoutAllController);

module.exports = router;