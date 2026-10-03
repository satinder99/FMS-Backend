// [BACKEND · Express] src/Conntrollers/dispatcherController.js
// src/Conntrollers/dispatcherController.js — thin HTTP layer for the dispatcher portal.
// orgId ALWAYS comes from req.ctx; ids in the URL/body are only ever combined with it in the services.
const dispatcherService = require('../Services/dispatcherService');
const equipmentService = require('../Services/equipmentService');
const payRateService = require('../Services/payRateService');
const { parseId } = require('../Utils/validate');

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const listDriversController = handler(async (req, res) => {
  res.json({ drivers: await dispatcherService.listDrivers({ orgId: req.ctx.orgId }) });
});

const getDriverController = handler(async (req, res) => {
  res.json(
    await dispatcherService.getDriverDetail({ orgId: req.ctx.orgId, driverId: parseId(req.params.driverId, 'driver id') })
  );
});

const getResourcesController = handler(async (req, res) => {
  res.json(await dispatcherService.getResources({ orgId: req.ctx.orgId }));
});

const createTripController = handler(async (req, res) => {
  
  const trip = await dispatcherService.createNewTrip({ orgId: req.ctx.orgId, userId: req.ctx.userId, body: req.body });
  res.status(201).json({ trip });
});

const listPayRatesController = handler(async (req, res) => {
  res.json(await payRateService.listForDriver({ orgId: req.ctx.orgId, driverId: parseId(req.params.driverId, 'driver id') }));
});

const addPayRateController = handler(async (req, res) => {
  const rate = await payRateService.addRate({
    orgId: req.ctx.orgId,
    driverId: parseId(req.params.driverId, 'driver id'),
    userId: req.ctx.userId,
    body: req.body,
  });
  res.status(201).json({ rate });
});

// Trucks and trailers share one implementation; `kind` picks the table from a whitelist.
function equipmentControllers(kind) {
  return {
    list: handler(async (req, res) => {
      res.json({ equipment: await equipmentService.list(kind, req.ctx.orgId) });
    }),
    create: handler(async (req, res) => {
      res.status(201).json({ equipment: await equipmentService.create(kind, req.ctx.orgId, req.body) });
    }),
    update: handler(async (req, res) => {
      res.json({ equipment: await equipmentService.update(kind, req.ctx.orgId, req.params.id, req.body) });
    }),
  };
}

module.exports = {
  listDriversController,
  getDriverController,
  getResourcesController,
  createTripController,
  listPayRatesController,
  addPayRateController,
  truckControllers: equipmentControllers('truck'),
  trailerControllers: equipmentControllers('trailer'),
};
