// [BACKEND · Express] src/Router/dispatcherRoutes.js
const express = require('express');
const { requireAuth } = require('../Middlewares/authMiddleware');
const { loadContext, requireCtxRole } = require('../Middlewares/fleetContext');
const c = require('../Conntrollers/dispatcherController');

const router = express.Router();
router.use(requireAuth, loadContext, requireCtxRole('dispatcher'));

// Drivers and their rides
router.get('/drivers', c.listDriversController);
router.get('/drivers/:driverId', c.getDriverController);

// Pay rates (append-only history per driver)
router.get('/drivers/:driverId/pay-rates', c.listPayRatesController);
router.post('/drivers/:driverId/pay-rates', c.addPayRateController);

// New-trip form options + trip creation
router.get('/resources', c.getResourcesController);
router.post('/trips', c.createTripController);

// Fleet equipment
router.get('/trucks', c.truckControllers.list);
router.post('/trucks', c.truckControllers.create);
router.patch('/trucks/:id', c.truckControllers.update);

router.get('/trailers', c.trailerControllers.list);
router.post('/trailers', c.trailerControllers.create);
router.patch('/trailers/:id', c.trailerControllers.update);

module.exports = router;
