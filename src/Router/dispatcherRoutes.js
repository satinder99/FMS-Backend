// [BACKEND · Express] src/Router/dispatcherRoutes.js
const express = require('express');
const { requireAuth } = require('../Middlewares/authMiddleware');
const { loadContext, requireCtxRole } = require('../Middlewares/fleetContext');
const c = require('../Conntrollers/dispatcherController');
const step = require('../Conntrollers/checkpointController');
const access = require('../Conntrollers/editRequestController');
const docs = require('../Conntrollers/documentController');

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

// Correct a step's start/end time: ONE free edit per step; more only inside an admin-approved window
router.patch('/trips/:tripId/checkpoints/:key/times', step.dispatcherEditTimesController);

// Ask an admin to approve more edits for the organization (one open request at a time)
router.get('/edit-access', access.getEditAccessController);
router.post('/edit-access/requests', access.createEditRequestController);
router.post('/edit-access/requests/:requestId/cancel', access.cancelEditRequestController);

// Documents: one file, or everything for a trip as a single ZIP
router.get('/documents/:docId/download', docs.downloadDocumentController);
router.get('/trips/:tripId/documents/download', docs.downloadTripZipController);

// Fleet equipment
router.get('/trucks', c.truckControllers.list);
router.post('/trucks', c.truckControllers.create);
router.patch('/trucks/:id', c.truckControllers.update);

router.get('/trailers', c.trailerControllers.list);
router.post('/trailers', c.trailerControllers.create);
router.patch('/trailers/:id', c.trailerControllers.update);

module.exports = router;
