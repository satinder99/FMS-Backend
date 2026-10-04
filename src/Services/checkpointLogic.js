// [BACKEND · Express] src/Services/checkpointLogic.js
// The rules for the steps ("checkpoints") of a trip, as PURE functions: no database, no clock of their
// own. Each function takes the current rows + "now" and returns the new rows + an audit event, or throws
// an AppError. checkpointService.js loads/saves the rows around these, so every rule can be unit-tested.
//
// A step is in one of three states, derived from its two business times:
//     pending      started_at = NULL                            (not started)
//     in_progress  started_at set, completed_at = NULL          (driver pressed "Start")
//     completed    started_at and completed_at set              (driver pressed "Complete")
// Steps go strictly in order, one at a time. Each tap also stores a server-side "recorded" time that is
// never editable; the driver's undo/edit window is measured from it.

const { AppError } = require('../Errors/errors');

const DRIVER_EDIT_WINDOW_MINUTES = 30;
const WINDOW_MS = DRIVER_EDIT_WINDOW_MINUTES * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000; // allows for a small difference between a phone's clock and the server's

const ms = (d) => (d ? new Date(d).getTime() : null);
const statusOf = (cp) => (cp.completed_at ? 'completed' : cp.started_at ? 'in_progress' : 'pending');
const currentIndex = (cps) => cps.findIndex((c) => statusOf(c) !== 'completed'); // -1 = every step done
const clone = (cps) => cps.map((c) => ({ ...c }));
const clear = (c) => {
  c.started_at = null;
  c.start_recorded_at = null;
  c.completed_at = null;
  c.complete_recorded_at = null;
};

function indexOfKey(cps, key) {
  const i = cps.findIndex((c) => c.key === key);
  if (i === -1) throw new AppError('That step is not part of this trip.', 404, 'CHECKPOINT_NOT_FOUND');
  return i;
}

/** Driver presses "Start" on the current step. */
function planStart(cps, key, now) {
  const i = indexOfKey(cps, key);
  const cur = currentIndex(cps);
  if (cur === -1) throw new AppError('Every step of this trip is already complete.', 409, 'TRIP_CLOSED');
  if (i !== cur) {
    throw new AppError(i < cur ? 'That step is already complete.' : 'Finish the current step first.', 409, 'NOT_CURRENT_STEP');
  }
  if (statusOf(cps[i]) !== 'pending') throw new AppError('That step has already been started.', 409, 'ALREADY_STARTED');

  const next = clone(cps);
  next[i].started_at = now;
  next[i].start_recorded_at = now;
  return { cps: next, event: { type: 'start', key, oldStart: null, oldEnd: null, newStart: now, newEnd: null, details: {} } };
}

/** Driver presses "Complete" on the current step. */
function planComplete(cps, key, now) {
  const i = indexOfKey(cps, key);
  const cur = currentIndex(cps);
  if (cur === -1) throw new AppError('Every step of this trip is already complete.', 409, 'TRIP_CLOSED');
  if (i !== cur) {
    throw new AppError(i < cur ? 'That step is already complete.' : 'Finish the current step first.', 409, 'NOT_CURRENT_STEP');
  }
  if (statusOf(cps[i]) !== 'in_progress') throw new AppError('Start this step before completing it.', 409, 'NOT_STARTED');

  const next = clone(cps);
  // the start time may sit up to 2 minutes "ahead" of the server clock; the end can never precede it
  const end = ms(now) >= ms(next[i].started_at) ? now : next[i].started_at;
  next[i].completed_at = end;
  next[i].complete_recorded_at = now;
  return {
    cps: next,
    event: { type: 'complete', key, oldStart: cps[i].started_at, oldEnd: null, newStart: cps[i].started_at, newEnd: end, details: {} },
  };
}

/**
 * Driver goes back one step on a step: completed -> in progress, or in progress -> not started.
 * Every LATER step is reset to not started too ("next checkpoint also reverted").
 * Only within 30 minutes of when the step was recorded, and never once a dispatcher adjusted it.
 */
function planUndo(cps, key, now) {
  const i = indexOfKey(cps, key);
  const status = statusOf(cps[i]);
  if (status === 'pending') throw new AppError('That step has not been started, so there is nothing to undo.', 409, 'NOTHING_TO_UNDO');
  if (cps.slice(i).some((c) => c.dispatcher_edited_at)) {
    throw new AppError('A dispatcher has adjusted this step, so it can only be changed by a dispatcher now.', 409, 'LOCKED_BY_DISPATCHER');
  }
  const recordedAt = status === 'completed' ? cps[i].complete_recorded_at : cps[i].start_recorded_at;
  if (!recordedAt || ms(now) - ms(recordedAt) > WINDOW_MS) {
    throw new AppError(
      `You can only undo a step within ${DRIVER_EDIT_WINDOW_MINUTES} minutes of recording it. Ask your dispatcher to change it.`,
      403,
      'WINDOW_EXPIRED'
    );
  }

  const next = clone(cps);
  if (status === 'completed') {
    next[i].completed_at = null;
    next[i].complete_recorded_at = null;
  } else {
    next[i].started_at = null;
    next[i].start_recorded_at = null;
  }
  const cascaded = [];
  for (let j = i + 1; j < next.length; j++) {
    if (statusOf(next[j]) !== 'pending') {
      cascaded.push(next[j].key);
      clear(next[j]);
    }
  }
  return {
    cps: next,
    event: {
      type: status === 'completed' ? 'undo_complete' : 'undo_start',
      key,
      oldStart: cps[i].started_at,
      oldEnd: cps[i].completed_at,
      newStart: next[i].started_at,
      newEnd: next[i].completed_at,
      details: { cascaded },
    },
  };
}

/**
 * Change the start and/or end time of a step that has already been started.
 *   actor = { role: 'driver' }                      -> only within 30 minutes of recording, never after a dispatcher edit
 *   actor = { role: 'dispatcher', windowActive }    -> one free edit per step, or unlimited while the organization's
 *                                                      admin-approved window is open
 * Times must stay in order with the neighbouring steps and cannot be in the future.
 */
function planEditTimes(cps, key, input, now, actor) {
  const i = indexOfKey(cps, key);
  const cp = cps[i];
  const status = statusOf(cp);
  if (status === 'pending') throw new AppError('That step has not been started yet, so it has no times to change.', 409, 'NOT_STARTED');

  const hasStart = input.startedAt !== undefined;
  const hasEnd = input.completedAt !== undefined;
  if (!hasStart && !hasEnd) throw new AppError('Give a new start time, a new end time, or both.', 400, 'INVALID_INPUT');
  if (hasEnd && status !== 'completed') {
    throw new AppError('This step is not complete yet, so only its start time can be changed.', 409, 'NOT_COMPLETED');
  }

  const newStart = hasStart ? input.startedAt : cp.started_at;
  const newEnd = status === 'completed' ? (hasEnd ? input.completedAt : cp.completed_at) : null;
  const unchanged = ms(newStart) === ms(cp.started_at) && (status !== 'completed' || ms(newEnd) === ms(cp.completed_at));
  if (unchanged) throw new AppError('Those times are the same as the current ones.', 400, 'NO_CHANGE');

  const limit = ms(now) + FUTURE_TOLERANCE_MS;
  if (ms(newStart) > limit || (newEnd && ms(newEnd) > limit)) throw new AppError('A time cannot be in the future.', 400, 'FUTURE_TIME');
  if (newEnd && ms(newEnd) < ms(newStart)) throw new AppError('The end time must be after the start time.', 400, 'END_BEFORE_START');

  const prev = cps[i - 1];
  if (prev && prev.completed_at && ms(newStart) < ms(prev.completed_at)) {
    throw new AppError(`This step cannot start before the previous step ("${prev.label}") ended.`, 400, 'OVERLAPS_PREVIOUS');
  }
  const following = cps[i + 1];
  if (newEnd && following && following.started_at && ms(newEnd) > ms(following.started_at)) {
    throw new AppError(`This step cannot end after the next step ("${following.label}") started.`, 400, 'OVERLAPS_NEXT');
  }

  const changes = { started_at: newStart, time_edit_count: cp.time_edit_count + 1 };
  if (status === 'completed') changes.completed_at = newEnd;
  let usedFreeEdit = false;

  if (actor.role === 'driver') {
    if (cp.dispatcher_edited_at) {
      throw new AppError('A dispatcher has adjusted this step, so only a dispatcher can change it now.', 409, 'LOCKED_BY_DISPATCHER');
    }
    const recordedAt = status === 'completed' ? cp.complete_recorded_at : cp.start_recorded_at;
    if (!recordedAt || ms(now) - ms(recordedAt) > WINDOW_MS) {
      throw new AppError(
        `You can only change a step's times within ${DRIVER_EDIT_WINDOW_MINUTES} minutes of recording it. Ask your dispatcher to change it.`,
        403,
        'WINDOW_EXPIRED'
      );
    }
  } else {
    if (!actor.windowActive) {
      if (cp.dispatcher_free_edit_used) {
        throw new AppError(
          'You have already used the one free edit for this step. Ask an admin to approve more edits for your organization.',
          403,
          'EDIT_APPROVAL_REQUIRED'
        );
      }
      usedFreeEdit = true;
      changes.dispatcher_free_edit_used = true;
    }
    changes.dispatcher_edited_at = now;
  }

  const next = clone(cps);
  Object.assign(next[i], changes);
  return {
    cps: next,
    event: {
      type: 'time_edit',
      key,
      oldStart: cp.started_at,
      oldEnd: cp.completed_at,
      newStart,
      newEnd,
      details: actor.role === 'dispatcher' ? { usedFreeEdit, viaApprovedWindow: !!actor.windowActive } : {},
    },
  };
}

/** The trip's own status/start/end follow from its steps. */
function deriveTrip(cps) {
  const allDone = cps.length > 0 && cps.every((c) => statusOf(c) === 'completed');
  return {
    status: allDone ? 'completed' : cps[0] && cps[0].started_at ? 'in_progress' : 'assigned',
    started_at: cps[0] ? cps[0].started_at : null,
    completed_at: allDone ? cps[cps.length - 1].completed_at : null,
  };
}

/** Which columns changed on which steps (so only those rows are written back). */
const TRACKED = [
  'started_at',
  'start_recorded_at',
  'completed_at',
  'complete_recorded_at',
  'dispatcher_edited_at',
  'dispatcher_free_edit_used',
  'time_edit_count',
];
function changedRows(before, after) {
  const out = [];
  after.forEach((row, i) => {
    const differs = TRACKED.some((col) => {
      const a = before[i][col];
      const b = row[col];
      return a instanceof Date || b instanceof Date ? ms(a) !== ms(b) : a !== b;
    });
    if (differs) out.push(row);
  });
  return out;
}

module.exports = {
  DRIVER_EDIT_WINDOW_MINUTES,
  TRACKED,
  statusOf,
  currentIndex,
  planStart,
  planComplete,
  planUndo,
  planEditTimes,
  deriveTrip,
  changedRows,
};
