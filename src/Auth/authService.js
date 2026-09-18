// authService.js — business logic for signup/signin/refresh/logout
// against user_accounts + refresh_tokens.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');

const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const ACCESS_TOKEN_EXPIRES_IN = '15m';        // short-lived — used on every request
const REFRESH_TOKEN_EXPIRES_DAYS = 30;         // long-lived — only used to mint new access tokens

function toSafeUser(row) {
  const { password_hash, password_reset_token_hash, mfa_secret_encrypted, ...safe } = row;
  return safe;
}

function signAccessToken(account) {
  return jwt.sign(
    { sub: account.id, orgId: account.org_id, username: account.username },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
}

// Raw refresh token = what the client holds. We only ever store its hash.
function generateRawRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ---------------------------------------------------------------------
// Issue a fresh access + refresh token pair, storing the refresh token
// (hashed) in the DB. Used after signup, signin, and on rotation.
// ---------------------------------------------------------------------
async function issueTokenPair(account, { deviceInfo, ipAddress, replacesTokenId } = {}) {
  const accessToken = signAccessToken(account);

  const rawRefreshToken = generateRawRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO refresh_tokens (user_account_id, token_hash, expires_at, device_info, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [account.id, refreshTokenHash, expiresAt, deviceInfo || null, ipAddress || null]
  );

  const newTokenId = result.rows[0].id;

  // If this call is a rotation (replacing an old refresh token), link the chain.
  if (replacesTokenId) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_token_id = $1 WHERE id = $2`,
      [newTokenId, replacesTokenId]
    );
  }

  return { accessToken, refreshToken: rawRefreshToken, refreshExpiresAt: expiresAt };
}

// ---------------------------------------------------------------------
// SIGN UP
// ---------------------------------------------------------------------
async function signUp({ orgId, username, email, phone, password }, requestMeta = {}) {
  if (!orgId || !username || !email || !password) {
    throw new AppError('orgId, username, email, and password are required.', 400, 'MISSING_FIELDS');
  }
  if (password.length < 10) {
    throw new AppError('Password must be at least 10 characters.', 400, 'WEAK_PASSWORD');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existing = await pool.query(
    `SELECT id FROM user_accounts
     WHERE org_id = $1 AND (username = $2 OR lower(email) = $3)
     LIMIT 1`,
    [orgId, username, normalizedEmail]
  );
  if (existing.rows.length > 0) {
    throw new AppError('Username or email already in use for this organization.', 409, 'ACCOUNT_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO user_accounts
       (org_id, username, email, phone, password_hash, password_updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING *`,
    [orgId, username, normalizedEmail, phone || null, passwordHash]
  );

  const account = result.rows[0];
  const tokens = await issueTokenPair(account, requestMeta);

  return { user: toSafeUser(account), ...tokens };
}

// ---------------------------------------------------------------------
// SIGN IN
// ---------------------------------------------------------------------
async function signIn({ orgId, usernameOrEmail, password }, requestMeta = {}) {
  if (!orgId || !usernameOrEmail || !password) {
    throw new AppError('orgId, usernameOrEmail, and password are required.', 400, 'MISSING_FIELDS');
  }

  const identifier = usernameOrEmail.trim().toLowerCase();

  const result = await pool.query(
    `SELECT * FROM user_accounts
     WHERE org_id = $1 AND (lower(username) = $2 OR lower(email) = $2)
     LIMIT 1`,
    [orgId, identifier]
  );

  if (result.rows.length === 0) {
    throw new AppError('Invalid username/email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const account = result.rows[0];

  if (account.status !== 'active') {
    throw new AppError('This account is not active. Contact your administrator.', 403, 'ACCOUNT_INACTIVE');
  }

  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    throw new AppError(
      `Account is temporarily locked. Try again after ${account.locked_until}.`,
      423,
      'ACCOUNT_LOCKED'
    );
  }

  const passwordMatches = await bcrypt.compare(password, account.password_hash);

  if (!passwordMatches) {
    const attempts = account.failed_login_attempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;

    await pool.query(
      `UPDATE user_accounts SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
      [
        shouldLock ? 0 : attempts,
        shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
        account.id,
      ]
    );

    throw new AppError('Invalid username/email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const updated = await pool.query(
    `UPDATE user_accounts
     SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), last_login_ip = $2
     WHERE id = $1
     RETURNING *`,
    [account.id, requestMeta.ipAddress || null]
  );

  const tokens = await issueTokenPair(updated.rows[0], requestMeta);

  return { user: toSafeUser(updated.rows[0]), ...tokens };
}

// ---------------------------------------------------------------------
// REFRESH — exchange a valid refresh token for a new access+refresh pair.
// Implements rotation + reuse detection.
// ---------------------------------------------------------------------
async function refreshAccessToken({ refreshToken }, requestMeta = {}) {
  if (!refreshToken) {
    throw new AppError('Refresh token is required.', 400, 'MISSING_REFRESH_TOKEN');
  }

  const tokenHash = hashToken(refreshToken);

  const result = await pool.query(
    `SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new AppError('Invalid refresh token.', 401, 'INVALID_REFRESH_TOKEN');
  }

  const tokenRow = result.rows[0];

  // Reuse detection: this token was already rotated away once before,
  // but it's being presented again. That means either a client bug or
  // a stolen token being replayed — treat it as compromise and kill
  // every session for this user.
  if (tokenRow.revoked_at) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_account_id = $1 AND revoked_at IS NULL`,
      [tokenRow.user_account_id]
    );
    throw new AppError('Refresh token reuse detected. All sessions revoked — please sign in again.', 401, 'TOKEN_REUSE_DETECTED');
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    throw new AppError('Refresh token expired. Please sign in again.', 401, 'REFRESH_TOKEN_EXPIRED');
  }

  const accountResult = await pool.query(`SELECT * FROM user_accounts WHERE id = $1`, [tokenRow.user_account_id]);
  const account = accountResult.rows[0];

  if (!account || account.status !== 'active') {
    throw new AppError('Account is no longer active.', 403, 'ACCOUNT_INACTIVE');
  }

  const tokens = await issueTokenPair(account, { ...requestMeta, replacesTokenId: tokenRow.id });

  return { user: toSafeUser(account), ...tokens };
}

// ---------------------------------------------------------------------
// LOGOUT — revoke a single refresh token (the device signing out).
// ---------------------------------------------------------------------
async function logout({ refreshToken }) {
  if (!refreshToken) return; // nothing to do
  const tokenHash = hashToken(refreshToken);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

// ---------------------------------------------------------------------
// LOGOUT ALL — revoke every refresh token for a user. Call this on
// termination, password change, or a suspected security incident —
// this is your "kick them out everywhere, right now" lever.
// ---------------------------------------------------------------------
async function logoutAll({ userAccountId }) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_account_id = $1 AND revoked_at IS NULL`,
    [userAccountId]
  );
}

module.exports = { signUp, signIn, refreshAccessToken, logout, logoutAll };