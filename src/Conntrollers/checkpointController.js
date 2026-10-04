// [BACKEND · Express] src/Conntrollers/checkpointController.js
// Thin HTTP layer for step actions. Driver handlers use req.driver (resolved server-side); the dispatcher
// handler uses req.ctx.orgId. The step key and trip id from the URL are validated and only ever applied to
// a trip the caller is allowed to touch.
const checkpointService = require('../Services/checkpointService');
const { parseId } = require('../Utils/validate');
const { AppError } = require('../Errors/errors');

const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/; // standard keys and generated custom keys such as x_gate_2

function stepKey(req) {
  if (!KEY_RE.test(req.params.key || '')) throw new AppError('Invalid step.', 400, 'INVALID_INPUT');
  return req.params.key;
}

const driverAction = (fn) => async (req, res, next) => {
  try {
    const trip = await fn({
      tripId: parseId(req.params.tripId, 'trip id'),
      orgId: req.ctx.orgId,
      driverId: req.driver.id,
      userId: req.ctx.userId,
      key: stepKey(req),
      body: req.body,
    });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
};

const startStepController = driverAction(checkpointService.driverStart);
const completeStepController = driverAction(checkpointService.driverComplete);
const undoStepController = driverAction(checkpointService.driverUndo);
const driverEditTimesController = driverAction(checkpointService.driverEditTimes);

async function dispatcherEditTimesController(req, res, next) {
  try {
    const trip = await checkpointService.dispatcherEditTimes({
      tripId: parseId(req.params.tripId, 'trip id'),
      orgId: req.ctx.orgId,
      userId: req.ctx.userId,
      key: stepKey(req),
      body: req.body,
    });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  startStepController,
  completeStepController,
  undoStepController,
  driverEditTimesController,
  dispatcherEditTimesController,
};
