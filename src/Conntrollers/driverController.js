// [BACKEND · Express] src/Conntrollers/driverController.js
// src/Conntrollers/driverController.js — thin HTTP layer for the driver portal.
// Every handler works on req.driver / req.ctx (resolved server-side), never on ids from the client,
// except :tripId, which the service only accepts if the trip belongs to this driver.
const driverService = require('../Services/driverService');
const { parseId } = require('../Utils/validate');

async function listTripsController(req, res, next) {
  try {
    res.json({ trips: await driverService.listTrips({ orgId: req.ctx.orgId, driverId: req.driver.id }) });
  } catch (err) {
    next(err);
  }
}

async function completeNextCheckpointController(req, res, next) {
  try {
    const trip = await driverService.completeNext({
      tripId: parseId(req.params.tripId, 'trip id'),
      orgId: req.ctx.orgId,
      driverId: req.driver.id,
      userId: req.ctx.userId,
    });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

async function getHoursController(req, res, next) {
  try {
    res.json(await driverService.getHours({ driverId: req.driver.id }));
  } catch (err) {
    next(err);
  }
}

module.exports = { listTripsController, completeNextCheckpointController, getHoursController };
