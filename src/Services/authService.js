// authService.js — business logic for signup/signin/refresh/logout
// against user_accounts + refresh_tokens + roles.
//
// Registration is self-contained: signUp only needs username/email/
// phone/password. org_id and role_id start NULL and are only ever set
// via assignOrgAndRole(), which is an admin-only action (enforce the
// "admin" check at the controller/route level).

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');

const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// Per-role token policy. Dispatcher = desk-bound web portal. Driver =
// mobile/PWA, patchy connectivity + long HOS shifts, so longer windows
// avoid forcing re-logins mid-route. An account with no role assigned
// yet falls back to DEFAULT_POLICY — it shouldn't have meaningful
// access anyway until an admin assigns org+role (enforce that in your
// authorization layer, not here).
const TOKEN_POLICY = {
  dispatcher: {
    accessTokenExpiresIn: '10m',
    refreshTokenMinutes: 60,        // 1 hour sliding — also doubles as idle protection
    absoluteSessionHours: 8,        // one full shift, then must re-login regardless of activity
  },
  driver: {
    accessTokenExpiresIn: '30m',
    refreshTokenMinutes: 360,       // 6 hours sliding — tolerates connectivity gaps mid-route
    absoluteSessionHours: 24,       // covers a full day including layovers/multi-stop routes
  },
  admin: {
    accessTokenExpiresIn: '10m',
    refreshTokenMinutes: 30,        // tightest — highest-privilege role, shortest leash
    absoluteSessionHours: 4,
  },
};
const DEFAULT_POLICY = TOKEN_POLICY.dispatcher; // fallback for null/unrecognized role

function getPolicy(roleName) {
  return TOKEN_POLICY[roleName] || DEFAULT_POLICY;
}

// Every query that returns a user_accounts row for auth purposes joins
// roles so we get the role NAME (what TOKEN_POLICY and the JWT need),
// not just role_id. LEFT JOIN because role_id can be NULL.
const ACCOUNT_SELECT_WITH_ROLE = `
  SELECT ua.*, r.name AS role_name
  FROM user_accounts ua
  LEFT JOIN roles r ON r.id = ua.role_id
`;

function toSafeUser(row) {
  const { password_hash, password_reset_token_hash, mfa_secret_encrypted, ...safe } = row;
  return safe;
}

function signAccessToken(account) {
  const policy = getPolicy(account.role_name);
  return jwt.sign(
    {
      sub: account.id,
      orgId: account.org_id,       // may be null — unassigned account
      role: account.role_name,     // may be null — unassigned account
      username: account.username,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: policy.accessTokenExpiresIn }
  );
}

function generateRawRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ---------------------------------------------------------------------
// Issue a fresh access + refresh token pair.
// ---------------------------------------------------------------------
async function issueTokenPair(account, { deviceInfo, ipAddress, replacesTokenId, sessionStartedAt } = {}) {
  const policy = getPolicy(account.role_name);
  const accessToken = signAccessToken(account);

  const rawRefreshToken = generateRawRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + policy.refreshTokenMinutes * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO refresh_tokens (user_account_id, token_hash, expires_at, device_info, ip_address, session_started_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
     RETURNING id`,
    [account.id, refreshTokenHash, expiresAt, deviceInfo || null, ipAddress || null, sessionStartedAt || null]
  );

  const newTokenId = result.rows[0].id;

  if (replacesTokenId) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_token_id = $1 WHERE id = $2`,
      [newTokenId, replacesTokenId]
    );
  }

  return { accessToken, refreshToken: rawRefreshToken, refreshExpiresAt: expiresAt };
}

// ---------------------------------------------------------------------
// SIGN UP — self-contained registration. No orgId, no role, no
// username. username stays NULL until the user generates one via
// generateUsername() (below), after an admin assigns org+role. Login
// works via email in the meantime.
// ---------------------------------------------------------------------
async function signUp({ firstName, lastName, email, phone, password }, requestMeta = {}) {
  if (!firstName || !lastName || !email || !password) {
    throw new AppError('firstName, lastName, email, and password are required.', 400, 'MISSING_FIELDS');
  }
  // if (password.length < 10) {
  //   throw new AppError('Password must be at least 10 characters.', 400, 'WEAK_PASSWORD');
  // }

  const normalizedEmail = email.trim().toLowerCase();

  // GLOBAL uniqueness — org isn't known yet to scope against. No
  // username to check yet either, since one hasn't been generated.
  const existing = await pool.query(
    `SELECT id FROM user_accounts WHERE lower(email) = $1 LIMIT 1`,
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    throw new AppError('Email already in use.', 409, 'ACCOUNT_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO user_accounts (first_name, last_name, email, phone, password_hash, password_updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id, first_name, last_name, username, email, phone, org_id, role_id, status, created_at, updated_at`,
    [firstName.trim(), lastName.trim(), normalizedEmail, phone || null, passwordHash]
  );

  // role_name is null for a fresh signup (role_id is null) — no join needed.
  const account = { ...result.rows[0], role_name: null };
  const tokens = await issueTokenPair(account, requestMeta);

  return { user: toSafeUser(account), ...tokens };
}

// ---------------------------------------------------------------------
// SIGN IN — no orgId needed anymore; username/email is globally unique.
// existingRefreshToken = whatever raw refresh token was already sitting
// in this browser's cookie, if any (passed through by the controller).
// ---------------------------------------------------------------------
async function signIn({ usernameOrEmail, password, existingRefreshToken }, requestMeta = {}) {
  if (!usernameOrEmail || !password) {
    throw new AppError('usernameOrEmail and password are required.', 400, 'MISSING_FIELDS');
  }

  const identifier = usernameOrEmail.trim().toLowerCase();

  const result = await pool.query(
    `${ACCOUNT_SELECT_WITH_ROLE}
     WHERE lower(ua.username) = $1 OR lower(ua.email) = $1
     LIMIT 1`,
    [identifier]
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
     RETURNING id`,
    [account.id, requestMeta.ipAddress || null]
  );
  // Re-fetch with the role join so we have role_name, since the UPDATE...RETURNING above doesn't join roles.
  const freshResult = await pool.query(`${ACCOUNT_SELECT_WITH_ROLE} WHERE ua.id = $1`, [updated.rows[0].id]);
  const freshAccount = freshResult.rows[0];

  // Check for an existing, still-valid session tied to THIS browser
  // before creating a new one.
  if (existingRefreshToken) {
    const existingHash = hashToken(existingRefreshToken);
    const existingSession = await pool.query(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = $1
         AND user_account_id = $2
         AND revoked_at IS NULL
         AND expires_at > now()
       LIMIT 1`,
      [existingHash, freshAccount.id]
    );

    if (existingSession.rows.length > 0) {
      const policy = getPolicy(freshAccount.role_name);
      const sessionAgeHours =
        (Date.now() - new Date(existingSession.rows[0].session_started_at).getTime()) / 3600000;

      if (sessionAgeHours <= policy.absoluteSessionHours) {
        // Valid previous session for this browser + account, still
        // within this role's absolute cap — reuse it as-is. Just mint
        // a fresh access token; don't touch the refresh_tokens row.
        const accessToken = signAccessToken(freshAccount);
        return {
          user: toSafeUser(freshAccount),
          accessToken,
          refreshToken: existingRefreshToken,
          reusedExistingSession: true,
        };
      }
      // Too old for this role's absolute cap — don't reuse. Falls
      // through to issuing a genuinely new session below.
    }
    // Falls through if the cookie was present but expired/revoked/
    // for a different account/too old — treated as "no cookie".
  }

  const tokens = await issueTokenPair(freshAccount, requestMeta);

  return { user: toSafeUser(freshAccount), ...tokens };
}

// ---------------------------------------------------------------------
// REFRESH — exchange a valid refresh token for a new access+refresh
// pair. Implements rotation + reuse detection + role-based absolute cap.
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
  // but it's being presented again — client bug or stolen token being
  // replayed. Treat as compromise, kill every session for this user.
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

  const accountResult = await pool.query(`${ACCOUNT_SELECT_WITH_ROLE} WHERE ua.id = $1`, [tokenRow.user_account_id]);
  const account = accountResult.rows[0];

  if (!account || account.status !== 'active') {
    throw new AppError('Account is no longer active.', 403, 'ACCOUNT_INACTIVE');
  }

  // Absolute session cap: has this session been alive — continuously or
  // not — longer than this role's shift-length limit? A continuously-
  // refreshed (or stolen-and-kept-alive) token would otherwise never
  // hit this. Limit depends on the account's role, just fetched above.
  const policy = getPolicy(account.role_name);
  const sessionAgeHours = (Date.now() - new Date(tokenRow.session_started_at).getTime()) / 3600000;
  if (sessionAgeHours > policy.absoluteSessionHours) {
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [tokenRow.id]);
    throw new AppError(
      `Session expired after ${policy.absoluteSessionHours} hours. Please sign in again.`,
      401,
      'SESSION_ABSOLUTE_LIMIT'
    );
  }

  const tokens = await issueTokenPair(account, {
    ...requestMeta,
    replacesTokenId: tokenRow.id,
    sessionStartedAt: tokenRow.session_started_at, // carried forward, never resets
  });

  return { user: toSafeUser(account), ...tokens };
}

// ---------------------------------------------------------------------
// LOGOUT — revoke a single refresh token (the device signing out).
// ---------------------------------------------------------------------
async function logout({ refreshToken }) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

// ---------------------------------------------------------------------
// LOGOUT ALL — revoke every refresh token for a user. Termination,
// password change, security incident, or a role/org reassignment (an
// account's old sessions were minted under its OLD role's token
// policy — call this after assignOrgAndRole so the next login picks
// up the new policy cleanly, not a stale-role session limping along).
// ---------------------------------------------------------------------
async function logoutAll({ userAccountId }) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_account_id = $1 AND revoked_at IS NULL`,
    [userAccountId]
  );
}

// ---------------------------------------------------------------------
// ASSIGN ORG + ROLE — admin-only action. Enforce the "caller is an
// admin" check at the controller/route level (requireRole('admin')) —
// this function itself just does the write, it doesn't check who's
// calling it.
// ---------------------------------------------------------------------
async function assignOrgAndRole({ userAccountId, orgId, roleId, assignedByUserAccountId }) {
  if (!userAccountId || !orgId || !roleId) {
    throw new AppError('userAccountId, orgId, and roleId are required.', 400, 'MISSING_FIELDS');
  }

  const orgCheck = await pool.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]);
  if (orgCheck.rows.length === 0) {
    throw new AppError('Organization not found.', 404, 'ORG_NOT_FOUND');
  }

  const roleCheck = await pool.query(`SELECT id, name FROM roles WHERE id = $1`, [roleId]);
  if (roleCheck.rows.length === 0) {
    throw new AppError('Role not found.', 404, 'ROLE_NOT_FOUND');
  }

  const result = await pool.query(
    `UPDATE user_accounts
     SET org_id = $1, role_id = $2, assigned_by = $3, assigned_at = now()
     WHERE id = $4
     RETURNING id, username, email, org_id, role_id, assigned_by, assigned_at`,
    [orgId, roleId, assignedByUserAccountId || null, userAccountId]
  );

  if (result.rows.length === 0) {
    throw new AppError('User account not found.', 404, 'ACCOUNT_NOT_FOUND');
  }

  // Old sessions were minted under the previous (likely null) role's
  // token policy — force a fresh login under the new policy rather
  // than letting a stale session limp along on old assumptions.
  await logoutAll({ userAccountId });

  return { user: { ...result.rows[0], role_name: roleCheck.rows[0].name } };
}

// ---------------------------------------------------------------------
// GENERATE USERNAME — self-service, called by the user themselves
// (their own account only — see the controller, which uses req.user.id
// rather than accepting an id in the request body). Only possible once
// an admin has assigned org+role, and only once ever — a second call
// on an account that already has a username is rejected, not
// re-generated.
//
// Format: <org short_name><first initial><last name>, then a
// sequential suffix (2, 3, 4...) appended only if that base value is
// already taken by someone else. Example: "DFS" + "John Smith" →
// DFSJSmith, or DFSJSmith2 if DFSJSmith is already in use.
// ---------------------------------------------------------------------
function sanitizeForUsername(value) {
  // Strip anything that isn't a letter or digit — org names/surnames
  // can contain spaces, hyphens, apostrophes, etc.
  return (value || '').replace(/[^a-zA-Z0-9]/g, '');
}

async function generateUsername({ userAccountId }) {
  const result = await pool.query(
    `SELECT ua.id, ua.username, ua.first_name, ua.last_name, ua.org_id, o.short_name AS org_short_name
     FROM user_accounts ua
     LEFT JOIN organizations o ON o.id = ua.org_id
     WHERE ua.id = $1`,
    [userAccountId]
  );

  if (result.rows.length === 0) {
    throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  }

  const account = result.rows[0];

  if (account.username) {
    throw new AppError('A username has already been generated for this account.', 409, 'USERNAME_ALREADY_SET');
  }

  if (!account.org_id || !account.org_short_name) {
    throw new AppError(
      'Your account has not been assigned to an organization yet. Contact your administrator.',
      403,
      'NOT_ASSIGNED'
    );
  }

  const orgPrefix = sanitizeForUsername(account.org_short_name);
  const firstInitial = sanitizeForUsername(account.first_name).charAt(0);
  const lastName = sanitizeForUsername(account.last_name);
  const baseUsername = `${orgPrefix}${firstInitial}${lastName}`;

  if (!baseUsername) {
    throw new AppError('Unable to generate a username from the account name/org.', 400, 'GENERATION_FAILED');
  }

  // Find the smallest available suffix by checking existing usernames
  // matching this base, then picking the first gap — avoids a
  // check-one-at-a-time loop of individual queries.
  const existingMatches = await pool.query(
    `SELECT username FROM user_accounts WHERE lower(username) LIKE lower($1) || '%'`,
    [baseUsername]
  );
  const takenLower = new Set(existingMatches.rows.map((r) => r.username.toLowerCase()));

  let candidate = baseUsername;
  let suffix = 2;
  while (takenLower.has(candidate.toLowerCase())) {
    candidate = `${baseUsername}${suffix}`;
    suffix += 1;
  }

  // Guard against a double-click / race: only writes if still NULL.
  const updateResult = await pool.query(
    `UPDATE user_accounts
     SET username = $1
     WHERE id = $2 AND username IS NULL
     RETURNING id, username, email, first_name, last_name`,
    [candidate, userAccountId]
  );

  if (updateResult.rows.length === 0) {
    // Someone else's concurrent call (or a second click) already set it.
    throw new AppError('A username has already been generated for this account.', 409, 'USERNAME_ALREADY_SET');
  }

  return { user: updateResult.rows[0] };
}

module.exports = {
  signUp,
  signIn,
  refreshAccessToken,
  logout,
  logoutAll,
  assignOrgAndRole,
  generateUsername,
  getPolicy,
};