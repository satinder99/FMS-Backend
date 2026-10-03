// [BACKEND · Express] src/Services/tripService.js
// src/Services/tripService.js — trip logic shared by the driver and dispatcher portals.
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');

// Checkpoint order. "immigration" only exists on cross-border trips.
const CHECKPOINT_TEMPLATE = [
  { key: 'reached_source', label: 'Reached source' },
  { key: 'pickup_truck', label: 'Pick up truck' },
  { key: 'pickup_trailer', label: 'Pick up trailer' },
  { key: 'load_trailer', label: 'Load trailer' },
  { key: 'start_journey', label: 'Start journey' },
  { key: 'immigration', label: 'Immigration / customs' },
  { key: 'pod_upload', label: 'Upload POD' },
];
const buildCheckpoints = (crossBorder) =>
  CHECKPOINT_TEMPLATE.filter((c) => c.key !== 'immigration' || crossBorder);

const TRIP_SQL = `
  SELECT t.id,
         'TRP-' || lpad(t.id::text, 6, '0') AS reference,
         t.driver_id,
         (u.first_name || ' ' || u.last_name) AS driver_name,
         tr.unit_number AS truck_number,
         tl.unit_number AS trailer_number,
         t.origin, t.destination, t.cross_border, t.scheduled_pickup_at, t.status,
         (SELECT json_agg(json_build_object('key', c.key, 'label', c.label, 'completedAt', c.completed_at)
                          ORDER BY c.seq)
            FROM trip_checkpoints c WHERE c.trip_id = t.id) AS checkpoints
    FROM trips t
    JOIN drivers d        ON d.id = t.driver_id
    JOIN user_accounts u  ON u.id = d.user_id
    JOIN trucks tr        ON tr.id = t.truck_id
    JOIN trailers tl      ON tl.id = t.trailer_id
   WHERE t.org_id = $1
     AND t.status <> 'cancelled'
     AND ($2::bigint IS NULL OR t.driver_id = $2)
     AND ($3::bigint IS NULL OR t.id = $3)
     AND ($4::text[] IS NULL OR t.status = ANY($4))
     AND ($5::int IS NULL OR t.status <> 'completed' OR t.completed_at > now() - make_interval(days => $5::int))
   ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
            t.scheduled_pickup_at, t.id`;

// pg returns BIGINT as strings; convert ids so the API matches the frontend types.
function toTrip(row) {
  return {
    id: Number(row.id),
    reference: row.reference,
    driverId: Number(row.driver_id),
    driverName: row.driver_name,
    truckNumber: row.truck_number,
    trailerNumber: row.trailer_number,
    origin: row.origin,
    destination: row.destination,
    crossBorder: row.cross_border,
    scheduledPickup: row.scheduled_pickup_at.toISOString(),
    status: row.status,
    checkpoints: row.checkpoints || [],
  };
}

/** `db` = pool or a transaction client. orgId is ALWAYS required. */
async function fetchTrips(db, { orgId, driverId = null, tripId = null, statuses = null, recentDays = null }) {
  const { rows } = await db.query(TRIP_SQL, [orgId, driverId, tripId, statuses, recentDays]);
  return rows.map(toTrip);
}

const equipmentLabel = (ownTruck, ownTrailer) =>
  ownTruck && ownTrailer
    ? 'their own truck and trailer'
    : ownTruck
      ? 'their own truck (trailer not theirs)'
      : ownTrailer
        ? 'their own trailer (truck not theirs)'
        : 'equipment they do not own';

/**
 * Dispatcher creates a trip: validates that driver/truck/trailer belong to the org and are active,
 * works out WHOSE equipment is being used, finds the pay rate in force for that combination on the
 * pickup date, and COPIES it onto the trip (so later rate/ownership changes never rewrite it).
 */
async function createTrip({ orgId, userId, input }) {
  const { driverId, truckId, trailerId, origin, destination, scheduledPickup, crossBorder } = input;

  return withTransaction(async (client) => {
    const driver = (
      await client.query(
        `SELECT id FROM drivers WHERE id = $1 AND org_id = $2 AND employment_status = 'active'`,
        [driverId, orgId]
      )
    ).rows[0];
    if (!driver) throw new AppError('Choose an active driver from your organization.', 400, 'INVALID_DRIVER');

    const truck = (
      await client.query(
        `SELECT id, owner_driver_id FROM trucks WHERE id = $1 AND org_id = $2 AND status = 'active'`,
        [truckId, orgId]
      )
    ).rows[0];
    if (!truck) throw new AppError('Choose an active truck from your organization.', 400, 'INVALID_TRUCK');

    const trailer = (
      await client.query(
        `SELECT id, owner_driver_id FROM trailers WHERE id = $1 AND org_id = $2 AND status = 'active'`,
        [trailerId, orgId]
      )
    ).rows[0];
    if (!trailer) throw new AppError('Choose an active trailer from your organization.', 400, 'INVALID_TRAILER');

    const ownsTruck = truck.owner_driver_id != null && Number(truck.owner_driver_id) === driverId;
    const ownsTrailer = trailer.owner_driver_id != null && Number(trailer.owner_driver_id) === driverId;

    
    // Latest rate whose effective date is on/before the pickup date (in the org's timezone).
    const rate = (
      await client.query(
        `SELECT r.id, r.pay_type, r.pay_rate
           FROM driver_pay_rates r
          WHERE r.driver_id = $1 AND r.org_id = $2 AND r.own_truck = $3 AND r.own_trailer = $4
            AND r.effective_from <= ($5::timestamptz AT TIME ZONE
                  (SELECT COALESCE(timezone, 'UTC') FROM organizations WHERE id = $2))::date
          ORDER BY r.effective_from DESC
          LIMIT 1`,
        [driverId, orgId, ownsTruck, ownsTrailer, scheduledPickup]
      )
    ).rows[0];
    if (!rate) {
      throw new AppError(
        `No pay rate is set for this driver on ${equipmentLabel(ownsTruck, ownsTrailer)}. ` +
          `Add one under the driver's pay rates first.`,
        409,
        'NO_PAY_RATE'
      );
    }

    const inserted = await client.query(
      `INSERT INTO trips (org_id, driver_id, truck_id, trailer_id, origin, destination, cross_border,
                          scheduled_pickup_at, driver_owns_truck, driver_owns_trailer,
                          pay_rate_id, pay_type, pay_rate, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [orgId, driverId, truckId, trailerId, origin, destination, crossBorder, scheduledPickup,
       ownsTruck, ownsTrailer, rate.id, rate.pay_type, rate.pay_rate, userId]
    );
    const tripId = inserted.rows[0].id;

    const list = buildCheckpoints(crossBorder);
    await client.query(
      `INSERT INTO trip_checkpoints (org_id, trip_id, seq, key, label)
       SELECT $1, $2, s, k, l FROM unnest($3::int[], $4::text[], $5::text[]) AS x(s, k, l)`,
      [orgId, tripId, list.map((_, i) => i + 1), list.map((c) => c.key), list.map((c) => c.label)]
    );

    return (await fetchTrips(client, { orgId, tripId }))[0];
  });
}

/**
 * Driver completes the NEXT checkpoint on one of THEIR trips. The client never says which
 * checkpoint: the server always completes the first incomplete one, so order can't be skipped.
 */
async function completeNextCheckpoint({ tripId, orgId, driverId, userId }) {
  try {
    return await withTransaction(async (client) => {
      // Ownership is part of the WHERE clause: someone else's trip simply looks "not found".
      const trip = (
        await client.query(
          `SELECT id, status FROM trips WHERE id = $1 AND org_id = $2 AND driver_id = $3 FOR UPDATE`,
          [tripId, orgId, driverId]
        )
      ).rows[0];
      if (!trip) throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      if (['completed', 'cancelled'].includes(trip.status)) {
        throw new AppError('This trip is already closed.', 409, 'TRIP_CLOSED');
      }

      const cp = (
        await client.query(
          `UPDATE trip_checkpoints
              SET completed_at = now(), completed_by = $2
            WHERE id = (SELECT id FROM trip_checkpoints
                         WHERE trip_id = $1 AND completed_at IS NULL
                         ORDER BY seq LIMIT 1)
          RETURNING key`,
          [tripId, userId]
        )
      ).rows[0];
      if (!cp) throw new AppError('Every checkpoint is already complete.', 409, 'TRIP_CLOSED');

      const left = (
        await client.query(
          `SELECT COUNT(*)::int AS n FROM trip_checkpoints WHERE trip_id = $1 AND completed_at IS NULL`,
          [tripId]
        )
      ).rows[0].n;
      const finished = left === 0;

      // Raises a unique violation if driver/truck/trailer is already on another in-progress trip.
      await client.query(
        `UPDATE trips
            SET status = $2::text,
                started_at = COALESCE(started_at, now()),
                completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE NULL END
          WHERE id = $1`,
        [tripId, finished ? 'completed' : 'in_progress']
      );

      // Hours placeholder (until ELD): the clock runs from "start journey" to "upload POD".
      // The rate is the trip's snapshot, and only hourly pay can be priced from hours.
      if (cp.key === 'start_journey') {
        await client.query(
          `INSERT INTO work_sessions (org_id, driver_id, trip_id, started_at, hourly_rate)
           SELECT t.org_id, t.driver_id, t.id, now(), CASE WHEN t.pay_type = 'hourly' THEN t.pay_rate END
             FROM trips t WHERE t.id = $1`,
          [tripId]
        );
      }
      if (cp.key === 'pod_upload') {
        await client.query(
          `UPDATE work_sessions SET ended_at = now() WHERE trip_id = $1 AND ended_at IS NULL`,
          [tripId]
        );
      }

      return (await fetchTrips(client, { orgId, tripId }))[0];
    });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint === 'uq_trips_one_active_per_driver') {
        throw new AppError('You already have a ride in progress. Finish it before starting another.', 409, 'DRIVER_BUSY');
      }
      if (err.constraint === 'uq_trips_one_active_per_truck') {
        throw new AppError('That truck is on another ride that is still in progress.', 409, 'TRUCK_BUSY');
      }
      if (err.constraint === 'uq_trips_one_active_per_trailer') {
        throw new AppError('That trailer is on another ride that is still in progress.', 409, 'TRAILER_BUSY');
      }
    }
    throw err;
  }
}

module.exports = { fetchTrips, createTrip, completeNextCheckpoint };
