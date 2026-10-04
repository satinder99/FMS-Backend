// [BACKEND · Express] src/Services/editRequestService.js
// Admin-approved "edit windows". A dispatcher gets ONE free time-edit per step. For more, a dispatcher
// asks for approval (one open request per organization); an admin approves it for 30 min / 1 / 2 / 3 / 4 h.
// While the window is open, every dispatcher of THAT organization can edit step times any number of times.
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');

const ALLOWED_MINUTES = [30, 60, 120, 180, 240];
const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/; // standard keys and generated custom keys such as x_gate_2

const iso = (d) => (d ? new Date(d).toISOString() : null);
const secondsLeft = (col) => `GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${col} - now()))))::int`;

/** The organization's currently open edit window, or null. `db` = pool or a transaction client. */
async function getActiveWindow(db, orgId) {
  const { rows } = await db.query(
    `SELECT id, duration_minutes, window_starts_at, window_expires_at, ${secondsLeft('window_expires_at')} AS remaining_seconds
       FROM checkpoint_edit_requests
      WHERE org_id = $1 AND status = 'approved' AND revoked_at IS NULL AND window_expires_at > now()
      ORDER BY window_expires_at DESC
      LIMIT 1`,
    [orgId]
  );
  const r = rows[0];
  return r
    ? {
        id: Number(r.id),
        durationMinutes: r.duration_minutes,
        startsAt: iso(r.window_starts_at),
        expiresAt: iso(r.window_expires_at),
        remainingSeconds: r.remaining_seconds,
      }
    : null;
}

// ------------------------------------------------------------------ dispatcher side

/** What the dispatcher screen needs: open window, open request, and how the last request ended. */
async function getAccessState(orgId) {
  const [window, pendingRes, lastRes] = await Promise.all([
    getActiveWindow(pool, orgId),
    pool.query(
      `SELECT q.id, q.reason, q.created_at, (ru.first_name || ' ' || ru.last_name) AS requested_by_name,
              CASE WHEN t.id IS NOT NULL THEN 'TRP-' || lpad(t.id::text, 6, '0') END AS trip_reference,
              c.label AS checkpoint_label
         FROM checkpoint_edit_requests q
         LEFT JOIN user_accounts ru ON ru.id = q.requested_by
         LEFT JOIN trips t ON t.id = q.trip_id
         LEFT JOIN trip_checkpoints c ON c.trip_id = q.trip_id AND c.key = q.checkpoint_key
        WHERE q.org_id = $1 AND q.status = 'pending'
        LIMIT 1`,
      [orgId]
    ),
    pool.query(
      `SELECT status, decision_note, decided_at
         FROM checkpoint_edit_requests
        WHERE org_id = $1 AND status IN ('approved', 'denied')
        ORDER BY decided_at DESC
        LIMIT 1`,
      [orgId]
    ),
  ]);
  const p = pendingRes.rows[0];
  const l = lastRes.rows[0];
  return {
    window,
    pending: p
      ? {
          id: Number(p.id),
          reason: p.reason,
          requestedByName: p.requested_by_name,
          createdAt: iso(p.created_at),
          tripReference: p.trip_reference,
          checkpointLabel: p.checkpoint_label,
        }
      : null,
    lastDecision: l ? { status: l.status, decisionNote: l.decision_note, decidedAt: iso(l.decided_at) } : null,
  };
}

async function createRequest({ orgId, userId, body }) {
  const b = body && typeof body === 'object' ? body : {};
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) {
    throw new AppError('Explain why you need the extra edits (10–500 characters).', 400, 'INVALID_INPUT');
  }

  let tripId = null;
  let checkpointKey = null;
  if (b.tripId !== undefined && b.tripId !== null) {
    tripId = Number(b.tripId);
    checkpointKey = b.checkpointKey;
    if (!Number.isSafeInteger(tripId) || tripId <= 0 || typeof checkpointKey !== 'string' || !KEY_RE.test(checkpointKey)) {
      throw new AppError('The trip and step for this request are not valid.', 400, 'INVALID_INPUT');
    }
  }

  return withTransaction(async (client) => {
    if (tripId !== null) {
      // the step must belong to a trip of THIS organization
      const ok = await client.query(
        `SELECT 1 FROM trip_checkpoints WHERE trip_id = $1 AND org_id = $2 AND key = $3`,
        [tripId, orgId, checkpointKey]
      );
      if (!ok.rows[0]) throw new AppError('That trip or step was not found in your organization.', 404, 'NOT_FOUND');
    }
    if (await getActiveWindow(client, orgId)) {
      throw new AppError('Your organization already has an approved edit window. You can edit times now.', 409, 'WINDOW_ACTIVE');
    }
    try {
      const { rows } = await client.query(
        `INSERT INTO checkpoint_edit_requests (org_id, requested_by, reason, trip_id, checkpoint_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, userId, reason, tripId, checkpointKey]
      );
      return { id: Number(rows[0].id) };
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError('A request from your organization is already waiting for an admin.', 409, 'REQUEST_PENDING');
      }
      throw err;
    }
  });
}

async function cancelRequest({ orgId, userId, requestId }) {
  const { rows } = await pool.query(
    `UPDATE checkpoint_edit_requests
        SET status = 'cancelled', decided_by = $3, decided_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'pending'
      RETURNING id`,
    [requestId, orgId, userId]
  );
  if (!rows[0]) throw new AppError('There is no open request with that number.', 404, 'NOT_FOUND');
  return { id: Number(rows[0].id) };
}

// ------------------------------------------------------------------ admin side

const LIST_SQL = `
  SELECT q.id, q.org_id, o.name AS org_name, o.short_name AS org_short_name,
         (ru.first_name || ' ' || ru.last_name) AS requested_by_name,
         q.reason, q.status, q.created_at, q.decided_at, q.decision_note, q.duration_minutes,
         q.window_starts_at, q.window_expires_at, q.revoked_at,
         (du.first_name || ' ' || du.last_name) AS decided_by_name,
         CASE WHEN t.id IS NOT NULL THEN 'TRP-' || lpad(t.id::text, 6, '0') END AS trip_reference,
         c.label AS checkpoint_label,
         (q.status = 'approved' AND q.revoked_at IS NULL AND q.window_expires_at > now()) AS is_active,
         CASE WHEN q.status = 'approved' AND q.revoked_at IS NULL AND q.window_expires_at > now()
              THEN ${secondsLeft('q.window_expires_at')} END AS remaining_seconds
    FROM checkpoint_edit_requests q
    JOIN organizations o ON o.id = q.org_id
    LEFT JOIN user_accounts ru ON ru.id = q.requested_by
    LEFT JOIN user_accounts du ON du.id = q.decided_by
    LEFT JOIN trips t ON t.id = q.trip_id
    LEFT JOIN trip_checkpoints c ON c.trip_id = q.trip_id AND c.key = q.checkpoint_key`;

// Fixed SQL per scope (never built from user input).
const SCOPES = {
  pending: `WHERE q.status = 'pending' ORDER BY q.created_at ASC LIMIT 100`,
  active: `WHERE q.status = 'approved' AND q.revoked_at IS NULL AND q.window_expires_at > now() ORDER BY q.window_expires_at ASC LIMIT 100`,
  history: `WHERE q.status <> 'pending' ORDER BY COALESCE(q.decided_at, q.created_at) DESC LIMIT 50`,
};

const toAdminRequest = (r) => ({
  id: Number(r.id),
  orgId: Number(r.org_id),
  orgName: r.org_name,
  orgShortName: r.org_short_name,
  requestedByName: r.requested_by_name,
  reason: r.reason,
  tripReference: r.trip_reference,
  checkpointLabel: r.checkpoint_label,
  status: r.status,
  createdAt: iso(r.created_at),
  decidedByName: r.decided_by_name,
  decidedAt: iso(r.decided_at),
  decisionNote: r.decision_note,
  durationMinutes: r.duration_minutes,
  windowExpiresAt: iso(r.window_expires_at),
  revokedAt: iso(r.revoked_at),
  isActive: r.is_active === true,
  remainingSeconds: r.remaining_seconds,
});

async function listRequests(scope) {
  if (!SCOPES[scope]) throw new AppError('Scope must be pending, active or history.', 400, 'INVALID_INPUT');
  const { rows } = await pool.query(`${LIST_SQL} ${SCOPES[scope]}`);
  return rows.map(toAdminRequest);
}

async function pendingCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM checkpoint_edit_requests WHERE status = 'pending'`);
  return rows[0].n;
}

async function approve({ adminId, requestId, durationMinutes }) {
  const minutes = Number(durationMinutes);
  if (!ALLOWED_MINUTES.includes(minutes)) {
    throw new AppError(`Choose a duration of ${ALLOWED_MINUTES.join(', ')} minutes.`, 400, 'INVALID_INPUT');
  }
  const { rows } = await pool.query(
    `UPDATE checkpoint_edit_requests
        SET status = 'approved', decided_by = $2, decided_at = now(), duration_minutes = $3,
            window_starts_at = now(), window_expires_at = now() + make_interval(mins => $3::int)
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [requestId, adminId, minutes]
  );
  if (!rows[0]) throw new AppError('That request is no longer waiting for a decision.', 409, 'NOT_PENDING');
  return { id: Number(rows[0].id), durationMinutes: minutes };
}

async function deny({ adminId, requestId, note }) {
  const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;
  const { rows } = await pool.query(
    `UPDATE checkpoint_edit_requests
        SET status = 'denied', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [requestId, adminId, text]
  );
  if (!rows[0]) throw new AppError('That request is no longer waiting for a decision.', 409, 'NOT_PENDING');
  return { id: Number(rows[0].id) };
}

/** End an approved window early. */
async function revoke({ adminId, requestId }) {
  const { rows } = await pool.query(
    `UPDATE checkpoint_edit_requests
        SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND status = 'approved' AND revoked_at IS NULL AND window_expires_at > now()
      RETURNING id`,
    [requestId, adminId]
  );
  if (!rows[0]) throw new AppError('That edit window is not open any more.', 409, 'NOT_ACTIVE');
  return { id: Number(rows[0].id) };
}

module.exports = {
  ALLOWED_MINUTES,
  getActiveWindow,
  getAccessState,
  createRequest,
  cancelRequest,
  listRequests,
  pendingCount,
  approve,
  deny,
  revoke,
};
