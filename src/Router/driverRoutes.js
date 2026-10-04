// [BACKEND · Express] src/Router/driverRoutes.js
const express = require('express');
const { requireAuth } = require('../Middlewares/authMiddleware');
const { loadContext, requireCtxRole, loadDriver } = require('../Middlewares/fleetContext');
const { listTripsController, getHoursController } = require('../Conntrollers/driverController');
const step = require('../Conntrollers/checkpointController');
const docs = require('../Conntrollers/documentController');
const { singleFileUpload } = require('../Middlewares/uploadMiddleware');

const router = express.Router();
router.use(requireAuth, loadContext, requireCtxRole('driver'), loadDriver);

router.get('/trips', listTripsController);

// One step at a time, in order. The driver names the step; the server enforces everything else.
router.post('/trips/:tripId/checkpoints/:key/start', step.startStepController);
router.post('/trips/:tripId/checkpoints/:key/complete', step.completeStepController);
router.post('/trips/:tripId/checkpoints/:key/undo', step.undoStepController);        // within 30 min of recording it
router.patch('/trips/:tripId/checkpoints/:key/times', step.driverEditTimesController); // within 30 min of recording it

// Proof of delivery: a photo (camera or gallery) or a PDF. Authentication has already run (router.use above)
// before the file is read. Multipart form: field "file" (+ optional "docType", default "pod").
router.post('/trips/:tripId/documents', singleFileUpload, docs.driverUploadController);
router.delete('/documents/:docId', docs.driverDeleteController);

router.get('/hours', getHoursController);

module.exports = router;
