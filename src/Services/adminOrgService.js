// [BACKEND · Express] src/Services/adminOrgService.js
// Admin-only, cross-organization views: the org list, one org's people, and the trips each person handles.
// Admin is platform-level (no org of their own), so here the org id DOES come from the URL, which is
// safe only because every route using this service sits behind requireCtxRole('admin').
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { fetchTrips } = require('./tripService');
const { getActiveWindow } = require('./editRequestService');

const iso = (d) => (d ? new Date(d).toISOString() : null);

async function listOverview() {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.short_name, o.org_type, o.status, o.subscription_plan, o.city, o.state_province, o.country,
            (SELECT COUNT(*) FROM user_accounts u WHERE u.org_id = o.id) AS user_count,
            (SELECT COUNT(*) FROM user_accounts u JOIN roles r ON r.id = u.role_id
              WHERE u.org_id = o.id AND lower(r.name) = 'dispatcher') AS dispatcher_count,
            (SELECT COUNT(*) FROM user_accounts u JOIN roles r ON r.id = u.role_id
              WHERE u.org_id = o.id AND lower(r.name) = 'driver') AS driver_count,
            (SELECT COUNT(*) FROM trips t WHERE t.org_id = o.id AND t.status IN ('assigned', 'in_progress')) AS open_trips,
            (SELECT COUNT(*) FROM checkpoint_edit_requests q WHERE q.org_id = o.id AND q.status = 'pending') AS pending_requests,
            (SELECT MAX(FLOOR(EXTRACT(EPOCH FROM (q.window_expires_at - now()))))::int
               FROM checkpoint_edit_requests q
              WHERE q.org_id = o.id AND q.status = 'approved' AND q.revoked_at IS NULL AND q.window_expires_at > now()) AS window_seconds
       FROM organizations o
      ORDER BY o.name`
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    shortName: r.short_name,
    orgType: r.org_type,
    status: r.status,
    subscriptionPlan: r.subscription_plan,
    city: r.city,
    stateProvince: r.state_province,
    country: r.country,
    userCount: Number(r.user_count),
    dispatcherCount: Number(r.dispatcher_count),
    driverCount: Number(r.driver_count),
    openTrips: Number(r.open_trips),
    pendingRequests: Number(r.pending_requests),
    editWindowRemainingSeconds: r.window_seconds,
  }));
}

/** One organization with its people. `role` ('dispatcher' | 'driver') narrows the people list. */
async function getDetail({ orgId, role }) {
  if (role !== undefined && !['dispatcher', 'driver'].includes(role)) {
    throw new AppError('Role must be dispatcher or driver.', 400, 'INVALID_INPUT');
  }
  const org = (
    await pool.query(
      `SELECT id, name, short_name, legal_name, org_type, status, subscription_plan, timezone, city, state_province, country, created_at
         FROM organizations WHERE id = $1`,
      [orgId]
    )
  ).rows[0];
  if (!org) throw new AppError('Organization not found.', 404, 'ORG_NOT_FOUND');

  const [users, window, pending] = await Promise.all([
    pool.query(
      `SELECT ua.id, ua.first_name, ua.last_name, ua.email, ua.username, ua.status, lower(r.name) AS role_name,
              CASE lower(r.name)
                WHEN 'driver' THEN (SELECT COUNT(*) FROM trips t WHERE t.driver_id = d.id)
                WHEN 'dispatcher' THEN (SELECT COUNT(*) FROM trips t WHERE t.created_by = ua.id AND t.org_id = $1)
                ELSE 0 END AS trip_count,
              CASE lower(r.name)
                WHEN 'driver' THEN (SELECT COUNT(*) FROM trips t WHERE t.driver_id = d.id AND t.status IN ('assigned', 'in_progress'))
                WHEN 'dispatcher' THEN (SELECT COUNT(*) FROM trips t WHERE t.created_by = ua.id AND t.org_id = $1
                                                                           AND t.status IN ('assigned', 'in_progress'))
                ELSE 0 END AS open_trip_count
         FROM user_accounts ua
         JOIN roles r ON r.id = ua.role_id
         LEFT JOIN drivers d ON d.user_id = ua.id AND d.org_id = $1
        WHERE ua.org_id = $1 AND ($2::text IS NULL OR lower(r.name) = $2)
        ORDER BY lower(r.name), ua.first_name, ua.last_name`,
      [orgId, role ?? null]
    ),
    getActiveWindow(pool, orgId),
    pool.query(`SELECT COUNT(*)::int AS n FROM checkpoint_edit_requests WHERE org_id = $1 AND status = 'pending'`, [orgId]),
  ]);

  return {
    organization: {
      id: Number(org.id),
      name: org.name,
      shortName: org.short_name,
      legalName: org.legal_name,
      orgType: org.org_type,
      status: org.status,
      subscriptionPlan: org.subscription_plan,
      timezone: org.timezone,
      city: org.city,
      stateProvince: org.state_province,
      country: org.country,
      createdAt: iso(org.created_at),
    },
    users: users.rows.map((u) => ({
      id: Number(u.id),
      name: `${u.first_name} ${u.last_name}`,
      email: u.email,
      username: u.username,
      status: u.status,
      role: u.role_name,
      tripCount: Number(u.trip_count),
      openTripCount: Number(u.open_trip_count),
    })),
    editWindow: window,
    pendingRequests: pending.rows[0].n,
  };
}

/**
 * The trips a person handles: a driver's assigned trips, or the trips a dispatcher created.
 * Newest first, up to 100, with every step's start/end time.
 */
async function listUserTrips({ orgId, userId }) {
  const user = (
    await pool.query(
      `SELECT ua.id, lower(r.name) AS role_name
         FROM user_accounts ua JOIN roles r ON r.id = ua.role_id
        WHERE ua.id = $1 AND ua.org_id = $2`,
      [userId, orgId]
    )
  ).rows[0];
  if (!user) throw new AppError('That person is not in this organization.', 404, 'ACCOUNT_NOT_FOUND');

  let trips = [];
  if (user.role_name === 'driver') {
    const driver = (await pool.query(`SELECT id FROM drivers WHERE user_id = $1 AND org_id = $2`, [userId, orgId])).rows[0];
    if (driver) trips = await fetchTrips(pool, { orgId, driverId: Number(driver.id), recentFirst: true, limit: 100 });
  } else if (user.role_name === 'dispatcher') {
    trips = await fetchTrips(pool, { orgId, createdBy: userId, recentFirst: true, limit: 100 });
  }
  return { user: { id: Number(user.id), role: user.role_name }, trips };
}

module.exports = { listOverview, getDetail, listUserTrips };
