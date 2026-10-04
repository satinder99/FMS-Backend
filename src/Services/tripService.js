// [BACKEND · Express] src/Services/tripService.js
// Reading trips (for all three portals) and creating them. Step actions: checkpointService.js. Step lists: checkpointTemplateService.js.
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');
const { DRIVER_EDIT_WINDOW_MINUTES } = require('./checkpointLogic');
const { stepsForTrip } = require('./checkpointTemplateService');
const { downloadNameFor } = require('./documentTypes');
const { extensionFor } = require('../Utils/fileType');

// One row per trip. Each step carries its start/end time, whether it was edited, and how many seconds the
// DRIVER still has to undo/change it (measured from the server-recorded tap time; NULL once locked).
const TRIP_SQL = `
  SELECT t.id,
         'TRP-' || lpad(t.id::text, 6, '0') AS reference,
         t.driver_id,
         (u.first_name || ' ' || u.last_name) AS driver_name,
         (cu.first_name || ' ' || cu.last_name) AS created_by_name,
         tr.unit_number AS truck_number,
         tl.unit_number AS trailer_number,
         t.origin, t.destination, t.cross_border, t.scheduled_pickup_at, t.status,
         (SELECT json_agg(json_build_object(
                    'key', c.key,
                    'label', c.label,
                    'startedAt', c.started_at,
                    'completedAt', c.completed_at,
                    'timeEditCount', c.time_edit_count,
                    'dispatcherEdited', c.dispatcher_edited_at IS NOT NULL,
                    'freeEditUsed', c.dispatcher_free_edit_used,
                    'driverEditableSeconds',
                      CASE WHEN c.dispatcher_edited_at IS NULL
                                AND COALESCE(c.complete_recorded_at, c.start_recorded_at) IS NOT NULL
                           THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                                  COALESCE(c.complete_recorded_at, c.start_recorded_at)
                                  + make_interval(mins => ${DRIVER_EDIT_WINDOW_MINUTES}) - now()))))::int
                      END
                  ) ORDER BY c.seq)
            FROM trip_checkpoints c WHERE c.trip_id = t.id) AS checkpoints,
         (SELECT COALESCE(json_agg(json_build_object(
                    'id', d.id,
                    'docType', d.doc_type,
                    'checkpointKey', d.checkpoint_key,
                    'filename', d.original_filename,
                    'contentType', d.content_type,
                    'sizeBytes', d.size_bytes,
                    'uploadedAt', d.uploaded_at,
                    'uploadedByName', (du.first_name || ' ' || du.last_name)
                  ) ORDER BY d.uploaded_at, d.id), '[]'::json)
            FROM trip_documents d
            LEFT JOIN user_accounts du ON du.id = d.uploaded_by
           WHERE d.trip_id = t.id AND d.deleted_at IS NULL) AS documents
    FROM trips t
    JOIN drivers d        ON d.id = t.driver_id
    JOIN user_accounts u  ON u.id = d.user_id
    LEFT JOIN user_accounts cu ON cu.id = t.created_by
    JOIN trucks tr        ON tr.id = t.truck_id
    JOIN trailers tl      ON tl.id = t.trailer_id
   WHERE t.org_id = $1
     AND t.status <> 'cancelled'
     AND ($2::bigint IS NULL OR t.driver_id = $2)
     AND ($3::bigint IS NULL OR t.id = $3)
     AND ($4::text[] IS NULL OR t.status = ANY($4))
     AND ($5::int IS NULL OR t.status <> 'completed' OR t.completed_at > now() - make_interval(days => $5::int))
     AND ($6::bigint IS NULL OR t.created_by = $6)
   ORDER BY (CASE WHEN $7::boolean THEN 0 ELSE CASE t.status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END END),
            (CASE WHEN $7::boolean THEN NULL ELSE t.scheduled_pickup_at END) ASC NULLS LAST,
            (CASE WHEN $7::boolean THEN t.scheduled_pickup_at END) DESC NULLS LAST,
            t.id
   LIMIT $8::int`;

const stepStatus = (c) => (c.completedAt ? 'completed' : c.startedAt ? 'in_progress' : 'pending');

// pg returns BIGINT as strings; convert ids so the API matches the frontend types.
function toTrip(row) {
  // The query returns documents oldest first; number them per kind exactly as the download endpoints do.
  const seen = {};
  const documents = (row.documents || []).map((d) => {
    seen[d.docType] = (seen[d.docType] || 0) + 1;
    return { ...d, downloadName: downloadNameFor(row.id, d.docType, seen[d.docType], extensionFor(d.contentType)) };
  });
  return {
    id: Number(row.id),
    reference: row.reference,
    driverId: Number(row.driver_id),
    driverName: row.driver_name,
    createdByName: row.created_by_name,
    truckNumber: row.truck_number,
    trailerNumber: row.trailer_number,
    origin: row.origin,
    destination: row.destination,
    crossBorder: row.cross_border,
    scheduledPickup: row.scheduled_pickup_at.toISOString(),
    status: row.status,
    checkpoints: (row.checkpoints || []).map((c) => ({ ...c, status: stepStatus(c) })),
    documents,
  };
}

/**
 * `db` = pool or a transaction client. orgId is ALWAYS required.
 * Optional filters: driverId, tripId, statuses, recentDays (hide old completed trips), createdBy (the dispatcher
 * who created it). recentFirst = newest pickup first (admin lists); limit = maximum rows (null = all).
 */
async function fetchTrips(
  db,
  { orgId, driverId = null, tripId = null, statuses = null, recentDays = null, createdBy = null, recentFirst = false, limit = null }
) {
  const { rows } = await db.query(TRIP_SQL, [orgId, driverId, tripId, statuses, recentDays, createdBy, recentFirst, limit]);
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

    const list = await stepsForTrip(client, orgId, crossBorder); // the organization's own steps, in its order
    await client.query(
      `INSERT INTO trip_checkpoints (org_id, trip_id, seq, key, label)
       SELECT $1, $2, s, k, l FROM unnest($3::int[], $4::text[], $5::text[]) AS x(s, k, l)`,
      [orgId, tripId, list.map((_, i) => i + 1), list.map((c) => c.key), list.map((c) => c.label)]
    );

    return (await fetchTrips(client, { orgId, tripId }))[0];
  });
}

module.exports = { fetchTrips, createTrip };
