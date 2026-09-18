// authController.js — thin HTTP layer. Parses req, calls the service,
// shapes the response. All real logic stays in authService.js.
//
// Cookie strategy: the REFRESH token goes in an httpOnly cookie (not
// readable by JS — mitigates XSS stealing it). The ACCESS token goes in
// the JSON body — the frontend keeps it in memory (not localStorage)
// and attaches it as `Authorization: Bearer <token>`.

const authService = require('./authService');

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production', // requires HTTPS in prod
  sameSite: 'strict',
  path: '/api/auth', // only sent to auth endpoints, not every request
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — keep in sync with authService.js
};

function requestMetaFrom(req) {
  return {
    deviceInfo: req.headers['user-agent'],
    ipAddress: req.ip,
  };
}

async function signUpController(req, res, next) {
  try {
    const { orgId, username, email, phone, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.signUp(
      { orgId, username, email, phone, password },
      requestMetaFrom(req)
    );
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
    res.status(201).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

async function signInController(req, res, next) {
  try {
    const { orgId, usernameOrEmail, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.signIn(
      { orgId, usernameOrEmail, password },
      requestMetaFrom(req)
    );
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
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
    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, REFRESH_COOKIE_OPTIONS);
    res.status(200).json({ user, accessToken });
  } catch (err) {
    // Reuse detection or expiry — clear the bad cookie either way.
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    next(err);
  }
}

async function logoutController(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    await authService.logout({ refreshToken });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// For admin/system use — e.g. HR terminates a driver, or a security
// incident requires killing every session for one account immediately.
async function logoutAllController(req, res, next) {
  try {
    const { userAccountId } = req.body;
    await authService.logoutAll({ userAccountId });
    res.status(204).send();
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
};