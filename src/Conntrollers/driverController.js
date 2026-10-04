// [BACKEND · Express] src/Conntrollers/driverController.js — thin HTTP layer for the driver portal (trips list + hours).
// Step actions (start / complete / undo / edit times) are in checkpointController.js.
const driverService = require('../Services/driverService');

async function listTripsController(req, res, next) {
  try {
    res.json({ trips: await driverService.listTrips({ orgId: req.ctx.orgId, driverId: req.driver.id }) });
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

module.exports = { listTripsController, getHoursController };
