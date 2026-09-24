// authController.js — thin HTTP layer. Parses req, calls the service,
// shapes the response. All real logic stays in authService.js.
//
// Cookie strategy: the REFRESH token goes in an httpOnly cookie (not
// readable by JS — mitigates XSS stealing it). The ACCESS token goes in
// the JSON body — the frontend keeps it in memory (not localStorage)
// and attaches it as `Authorization: Bearer <token>`.

const authService = require('../Services/authService');

const REFRESH_COOKIE_NAME = 'refreshToken';

function refreshCookieOptions(role) {
  const policy = authService.getPolicy(role);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // requires HTTPS in prod
    sameSite: 'strict',
    path: '/api/auth', // only sent to auth endpoints, not every request
    maxAge: policy.refreshTokenMinutes * 60 * 1000, // matches refresh_tokens.expires_at for this role
  };
}

function requestMetaFrom(req) {
  return {
    deviceInfo: req.headers['user-agent'],
    ipAddress: req.ip,
  };
}

async function signUpController(req, res, next) {
  try {
    // No orgId, no role, no username — registration is self-contained.
    // firstName/lastName are collected here (used later to build the
    // auto-generated username); an admin assigns org+role afterward
    // via POST /api/auth/assign, and the user generates their own
    // username afterward via POST /api/auth/generate-username.
    const { firstName, lastName, email, phone, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.signUp(
      { firstName, lastName, email, phone, password },
      requestMetaFrom(req)
    );
    console.log("refresh token from signup controller : ",refreshToken);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(user.role_name));
    res.status(201).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

async function signInController(req, res, next) {
  try {
    // No orgId needed — username/email is globally unique now.
    const { usernameOrEmail, password } = req.body;
    const existingRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

    const { user, accessToken, refreshToken } = await authService.signIn(
      { usernameOrEmail, password, existingRefreshToken },
      requestMetaFrom(req)
    );
    console.log("refresh token from signin controller : ",refreshToken);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(user.role_name));
    res.status(200).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

async function refreshController(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    const { user, accessToken, refreshToken: newRefreshToken } = await authService.refreshAccessToken(
      { refreshToken },
      requestMetaFrom(req)
    );
    console.log("refresh token from refresh controller : ",newRefreshToken);
    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions(user.role_name));
    res.status(200).json({ user, accessToken });
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    next(err);
  }
}

async function logoutController(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    console.log("refresh token from logout controller : ",refreshToken);
    await authService.logout({ refreshToken });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function logoutAllController(req, res, next) {
  try {
    const { userAccountId } = req.body;
    console.log("logout all for user id : ",userAccountId);
    
    await authService.logoutAll({ userAccountId });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// Admin-only: assigns org + role to an already-registered account.
// req.user.id is the ADMIN performing this (from requireAuth) — recorded
// as assigned_by for the audit trail. Route wires requireRole('admin').
async function assignOrgAndRoleController(req, res, next) {
  try {
    const { userAccountId, orgId, roleId } = req.body;
    const result = await authService.assignOrgAndRole({
      userAccountId,
      orgId,
      roleId,
      assignedByUserAccountId: req.user.id,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Self-service: the logged-in user generating THEIR OWN username.
// Deliberately uses req.user.id (from requireAuth), never an id from
// the request body — otherwise any authenticated user could generate
// (or overwrite) someone else's username.
async function generateUsernameController(req, res, next) {
  try {
    const result = await authService.generateUsername({ userAccountId: req.user.id });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  signUpController,
  signInController,
  refreshController,
  logoutController,
  logoutAllController,
  assignOrgAndRoleController,
  generateUsernameController,
};