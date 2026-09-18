// authMiddleware.js — verifies the short-lived access token on
// protected routes. Apply this to everything except /signup, /signin,
// /refresh.

const jwt = require('jsonwebtoken');
const { AppError } = require('../Errors/errors');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError('Missing or malformed Authorization header.', 401, 'MISSING_TOKEN'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    // Attach identity for downstream handlers/authorization checks.
    req.user = { id: payload.sub, orgId: payload.orgId, username: payload.username };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Access token expired.', 401, 'ACCESS_TOKEN_EXPIRED'));
    }
    return next(new AppError('Invalid access token.', 401, 'INVALID_TOKEN'));
  }
}

module.exports = { requireAuth };