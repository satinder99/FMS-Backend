// authMiddleware.js — verifies the short-lived access token on
// protected routes, and optionally checks role.

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
    // role/orgId may be null here — an account that hasn't been
    // assigned by an admin yet. Downstream handlers/requireRole are
    // responsible for rejecting those where appropriate.
    req.user = { id: payload.sub, orgId: payload.orgId, username: payload.username, role: payload.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Access token expired.', 401, 'ACCESS_TOKEN_EXPIRED'));
    }
    return next(new AppError('Invalid access token.', 401, 'INVALID_TOKEN'));
  }
}

// requireRole('admin') — use AFTER requireAuth on a route. Rejects if
// the token's role doesn't match (including an unassigned, null role).
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403, 'FORBIDDEN'));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };