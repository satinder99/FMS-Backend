// [BACKEND · Express] src/Middlewares/fleetContext.js
// src/Middlewares/fleetContext.js — authorization for all business routes.
//
// requireAuth (authMiddleware.js) only proves "this access token is valid". These add:
//   loadContext    -> reads the user's CURRENT role/org from the DATABASE into req.ctx
//   requireCtxRole -> checks that role (a null role/org is always rejected)
//   loadDriver     -> for driver routes, resolves the caller's own driver profile
//
// Why the database and not the JWT claims: a token lives 10-30 minutes, so after an
// admin changes someone's role the token would still carry the old one. Why req.ctx and
// not req.body: body/params/query come from the client and can be forged; req.ctx is
// built only from trusted, server-side data. Every query takes its org from req.ctx.orgId.

const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');

async function loadContext(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT ua.id, ua.org_id, ua.status, r.name AS role_name
         FROM user_accounts ua
         LEFT JOIN roles r ON r.id = ua.role_id
        WHERE ua.id = $1`,
      [req.user.id]
    );
    const account = rows[0];

    if (!account || account.status !== 'active') {
      throw new AppError('This account is not active. Contact your administrator.', 403, 'ACCOUNT_INACTIVE');
    }
    // Closes the "null role/org = no access" gap: unassigned accounts get nothing.
    if (!account.role_name || (account.role_name !== 'admin' && account.org_id == null)) {
      throw new AppError('Your account has not been given a role and organization yet.', 403, 'NOT_ASSIGNED');
    }

    req.ctx = {
      userId: Number(account.id),
      orgId: account.org_id == null ? null : Number(account.org_id),
      role: account.role_name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireCtxRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.ctx || !allowedRoles.includes(req.ctx.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403, 'FORBIDDEN'));
    }
    next();
  };
}

async function loadDriver(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM drivers WHERE user_id = $1 AND org_id = $2 AND employment_status = 'active'`,
      [req.ctx.userId, req.ctx.orgId]
    );
    if (!rows[0]) {
      throw new AppError('No active driver profile exists for this account.', 403, 'NO_DRIVER_PROFILE');
    }
    req.driver = { id: Number(rows[0].id) };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { loadContext, requireCtxRole, loadDriver };
