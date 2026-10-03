// [BACKEND · Express] src/Router/driverRoutes.js
const express = require('express');
const { requireAuth } = require('../Middlewares/authMiddleware');
const { loadContext, requireCtxRole, loadDriver } = require('../Middlewares/fleetContext');
const {
  listTripsController,
  completeNextCheckpointController,
  getHoursController,
} = require('../Conntrollers/driverController');

const router = express.Router();
router.use(requireAuth, loadContext, requireCtxRole('driver'), loadDriver);

router.get('/trips', listTripsController);
router.post('/trips/:tripId/checkpoints/next', completeNextCheckpointController);
router.get('/hours', getHoursController);

module.exports = router;
