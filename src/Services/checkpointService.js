// [BACKEND · Express] src/Services/checkpointService.js
// Applies the rules in checkpointLogic.js to the database, one transaction per action:
// lock the trip -> load its steps -> plan the change -> write back the changed steps -> update the trip
// -> keep the driver's work session in step -> write the audit event.
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');
const logic = require('./checkpointLogic');
const { fetchTrips } = require('./tripService');
const { getActiveWindow } = require('./editRequestService');
const { POD_STEP_KEY } = require('./documentTypes');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(value, label) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new AppError(`${label} must be a date and time with a timezone, e.g. 2026-10-04T10:05:00-04:00.`, 400, 'INVALID_INPUT');
  }
  return new Date(value);
}

const notGiven = (v) => v === undefined || v === null || v === '';

/** Body -> { startedAt?, completedAt? } (undefined = leave that time alone). */
function parseTimes(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!notGiven(b.startedAt)) out.startedAt = parseTime(b.startedAt, 'Start time');
  if (!notGiven(b.completedAt)) out.completedAt = parseTime(b.completedAt, 'End time');
  return out;
}

function cleanReason(value, { required }) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && (text.length < 5 || text.length > 300)) {
    throw new AppError('Say why the times are being changed (5–300 characters).', 400, 'INVALID_INPUT');
  }
  if (text.length > 300) throw new AppError('The reason can be at most 300 characters.', 400, 'INVALID_INPUT');
  return text || null;
}

/**
 * The driver's work session follows the steps. Organizations choose their own steps, so the clock is:
 *   starts: when "Start journey" starts, or (if the organization has no such step) when the FIRST step starts
 *   ends:   when "Upload POD" completes, or (if there is no such step after the start) when the LAST step completes
 */
async function syncWorkSession(client, trip, cps) {
  const startStep = cps.find((c) => c.key === 'start_journey') || cps[0];
  const startIndex = cps.indexOf(startStep);
  const podIndex = cps.findIndex((c) => c.key === POD_STEP_KEY);
  const endStep = podIndex > startIndex ? cps[podIndex] : cps[cps.length - 1];

  const existing = (
    await client.query(`SELECT id FROM work_sessions WHERE trip_id = $1 AND source = 'checkpoint' FOR UPDATE`, [trip.id])
  ).rows[0];

  if (!startStep || !startStep.started_at) {
    if (existing) await client.query(`DELETE FROM work_sessions WHERE id = $1`, [existing.id]);
    return;
  }
  const endedAt = endStep && endStep.completed_at ? endStep.completed_at : null;
  if (existing) {
    await client.query(`UPDATE work_sessions SET started_at = $2, ended_at = $3 WHERE id = $1`, [existing.id, startStep.started_at, endedAt]);
  } else {
    const rate = trip.pay_type === 'hourly' ? trip.pay_rate : null; // only hourly pay can be priced from hours
    await client.query(
      `INSERT INTO work_sessions (org_id, driver_id, trip_id, started_at, ended_at, hourly_rate) VALUES ($1, $2, $3, $4, $5, $6)`,
      [trip.org_id, trip.driver_id, trip.id, startStep.started_at, endedAt, rate]
    );
  }
}

/**
 * Runs one action. `scope.driverId` (drivers only) means "this trip must be mine".
 * `plan({ cps, now, client })` returns { cps, event, reason?, editRequestId? } or throws.
 */
async function run({ tripId, orgId, driverId = null }, actor, plan) {
  try {
    return await withTransaction(async (client) => {
      const trip = (
        await client.query(
          `SELECT id, org_id, driver_id, status, pay_type, pay_rate
             FROM trips
            WHERE id = $1 AND org_id = $2 AND ($3::bigint IS NULL OR driver_id = $3) AND status <> 'cancelled'
            FOR UPDATE`,
          [tripId, orgId, driverId]
        )
      ).rows[0];
      if (!trip) throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');

      const cps = (await client.query(`SELECT * FROM trip_checkpoints WHERE trip_id = $1 ORDER BY seq FOR UPDATE`, [tripId])).rows;
      const now = (await client.query(`SELECT now() AS now`)).rows[0].now;

      const { cps: next, event, reason = null, editRequestId = null } = await plan({ cps, now, client });

      for (const row of logic.changedRows(cps, next)) {
        await client.query(
          `UPDATE trip_checkpoints
              SET started_at = $2, start_recorded_at = $3, completed_at = $4, complete_recorded_at = $5,
                  dispatcher_edited_at = $6, dispatcher_free_edit_used = $7, time_edit_count = $8
            WHERE id = $1`,
          [row.id, row.started_at, row.start_recorded_at, row.completed_at, row.complete_recorded_at,
           row.dispatcher_edited_at, row.dispatcher_free_edit_used, row.time_edit_count]
        );
      }

      // May raise a unique violation if the driver/truck/trailer is already on another in-progress trip.
      const derived = logic.deriveTrip(next);
      await client.query(`UPDATE trips SET status = $2, started_at = $3, completed_at = $4 WHERE id = $1`, [
        tripId, derived.status, derived.started_at, derived.completed_at,
      ]);

      await syncWorkSession(client, trip, next);

      await client.query(
        `INSERT INTO trip_checkpoint_events
           (org_id, trip_id, checkpoint_key, event_type, actor_user_id, actor_role,
            old_started_at, old_completed_at, new_started_at, new_completed_at, reason, edit_request_id, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [orgId, tripId, event.key, event.type, actor.userId, actor.role,
         event.oldStart, event.oldEnd, event.newStart, event.newEnd, reason, editRequestId, JSON.stringify(event.details || {})]
      );

      return (await fetchTrips(client, { orgId, tripId }))[0];
    });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint === 'uq_trips_one_active_per_driver') {
        throw new AppError('You already have another ride in progress. Finish or undo it first.', 409, 'DRIVER_BUSY');
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

// ------------------------------------------------------------------ driver actions (trip must be the driver's own)

const driverActor = (userId) => ({ userId, role: 'driver' });

const driverStart = ({ tripId, orgId, driverId, userId, key }) =>
  run({ tripId, orgId, driverId }, driverActor(userId), async ({ cps, now }) => logic.planStart(cps, key, now));

const driverComplete = ({ tripId, orgId, driverId, userId, key }) =>
  run({ tripId, orgId, driverId }, driverActor(userId), async ({ cps, now, client }) => {
    const plan = logic.planComplete(cps, key, now); // first: is this the right step in the right state?
    if (key === POD_STEP_KEY) {
      const files = await client.query(
        `SELECT 1 FROM trip_documents WHERE trip_id = $1 AND doc_type = 'pod' AND deleted_at IS NULL LIMIT 1`,
        [tripId]
      );
      if (!files.rows[0]) {
        throw new AppError('Upload the proof of delivery (a photo or a PDF) before completing this step.', 409, 'POD_REQUIRED');
      }
    }
    return plan;
  });

const driverUndo = ({ tripId, orgId, driverId, userId, key }) =>
  run({ tripId, orgId, driverId }, driverActor(userId), async ({ cps, now }) => logic.planUndo(cps, key, now));

async function driverEditTimes({ tripId, orgId, driverId, userId, key, body }) {
  const input = parseTimes(body);
  const reason = cleanReason(body && body.reason, { required: false });
  return run({ tripId, orgId, driverId }, driverActor(userId), async ({ cps, now }) => ({
    ...logic.planEditTimes(cps, key, input, now, { role: 'driver' }),
    reason,
  }));
}

// ------------------------------------------------------------------ dispatcher action (any trip of their organization)

async function dispatcherEditTimes({ tripId, orgId, userId, key, body }) {
  const input = parseTimes(body);
  const reason = cleanReason(body && body.reason, { required: true });
  return run({ tripId, orgId, driverId: null }, { userId, role: 'dispatcher' }, async ({ cps, now, client }) => {
    const window = await getActiveWindow(client, orgId); // the organization's admin-approved window, if open
    return {
      ...logic.planEditTimes(cps, key, input, now, { role: 'dispatcher', windowActive: !!window }),
      reason,
      editRequestId: window ? window.id : null,
    };
  });
}

module.exports = { driverStart, driverComplete, driverUndo, driverEditTimes, dispatcherEditTimes, parseTimes };
