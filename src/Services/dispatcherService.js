// [BACKEND · Express] src/Services/dispatcherService.js
// src/Services/dispatcherService.js — the dispatcher's view of drivers and rides.
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { fetchTrips, createTrip } = require('./tripService');
const { getAccessState } = require('./editRequestService');
const { parseId, requireText, requireBoolean } = require('../Utils/validate');

const fullName = (r) => `${r.first_name} ${r.last_name}`;

/** Every active driver in the org, with their current (or next) ride. */
async function listDrivers({ orgId }) {
  const [driversRes, trips] = await Promise.all([
    pool.query(
      `SELECT d.id, u.first_name, u.last_name, u.phone
         FROM drivers d JOIN user_accounts u ON u.id = d.user_id
        WHERE d.org_id = $1 AND d.employment_status = 'active'
        ORDER BY u.first_name, u.last_name`,
      [orgId]
    ),
    fetchTrips(pool, { orgId, statuses: ['in_progress', 'assigned'] }),
  ]);

  // Trips come ordered in_progress first, then by pickup time: first one per driver wins.
  const activeByDriver = new Map();
  for (const t of trips) if (!activeByDriver.has(t.driverId)) activeByDriver.set(t.driverId, t);

  return driversRes.rows.map((r) => ({
    id: Number(r.id),
    name: fullName(r),
    phone: r.phone,
    activeTrip: activeByDriver.get(Number(r.id)) || null,
  }));
}

async function getDriverDetail({ orgId, driverId }) {
  const { rows } = await pool.query(
    `SELECT d.id, u.first_name, u.last_name, u.phone
       FROM drivers d JOIN user_accounts u ON u.id = d.user_id
      WHERE d.id = $1 AND d.org_id = $2`,
    [driverId, orgId]
  );
  if (!rows[0]) throw new AppError('Driver not found.', 404, 'DRIVER_NOT_FOUND');
  const [trips, editAccess] = await Promise.all([
    fetchTrips(pool, { orgId, driverId, recentDays: 30 }),
    getAccessState(orgId), // open edit window / open request, so the screen can show the right buttons
  ]);
  return { driver: { id: Number(rows[0].id), name: fullName(rows[0]), phone: rows[0].phone }, trips, editAccess };
}

/** Options for the "New trip" form. */
async function getResources({ orgId }) {
  const [drivers, trucks, trailers] = await Promise.all([
    pool.query(
      `SELECT d.id, u.first_name, u.last_name FROM drivers d JOIN user_accounts u ON u.id = d.user_id
        WHERE d.org_id = $1 AND d.employment_status = 'active' ORDER BY u.first_name, u.last_name`,
      [orgId]
    ),
    pool.query(`SELECT id, unit_number, ownership_type FROM trucks WHERE org_id = $1 AND status = 'active' ORDER BY unit_number`, [orgId]),
    pool.query(`SELECT id, unit_number, ownership_type FROM trailers WHERE org_id = $1 AND status = 'active' ORDER BY unit_number`, [orgId]),
  ]);
  const unit = (r) => ({ id: Number(r.id), unitNumber: r.unit_number, ownership: r.ownership_type });
  return {
    drivers: drivers.rows.map((r) => ({ id: Number(r.id), name: fullName(r) })),
    trucks: trucks.rows.map(unit),
    trailers: trailers.rows.map(unit),
  };
}

function validateTripInput(body) {
  const b = body || {};
  const pickup = new Date(b.scheduledPickup);
  if (Number.isNaN(pickup.getTime())) throw new AppError('Pickup date and time is required.', 400, 'INVALID_INPUT');
  return {
    driverId: parseId(b.driverId, 'driver'),
    truckId: parseId(b.truckId, 'truck'),
    trailerId: parseId(b.trailerId, 'trailer'),
    origin: requireText(b.origin, 'Origin'),
    destination: requireText(b.destination, 'Destination'),
    scheduledPickup: pickup.toISOString(),
    crossBorder: requireBoolean(b.crossBorder, 'Cross-border'),
  };
}

const createNewTrip = ({ orgId, userId, body }) => createTrip({ orgId, userId, input: validateTripInput(body) });

module.exports = { listDrivers, getDriverDetail, getResources, createNewTrip };
