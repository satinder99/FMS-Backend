// [BACKEND · Express] src/Router/adminRoutes.js
// Every route below requires: a valid access token -> an active, assigned account -> the 'admin' role.
const express = require('express');
const { requireAuth } = require('../Middlewares/authMiddleware');
const { loadContext, requireCtxRole } = require('../Middlewares/fleetContext');
const {
  listUsersController,
  listOrganizationsController,
  createOrganizationController,
  assignAccessController,
} = require('../Conntrollers/adminController');
const org = require('../Conntrollers/adminOrgController');
const requests = require('../Conntrollers/editRequestController');

const router = express.Router();
router.use(requireAuth, loadContext, requireCtxRole('admin'));

router.get('/users', listUsersController);
router.get('/organizations', listOrganizationsController);
router.post('/organizations', createOrganizationController); // onboard a new organization
router.patch('/users/:userId/access', assignAccessController);

// Organizations: the list (admin home), then one organization's people and the trips each person handles.
// '/organizations/overview' must stay ABOVE '/organizations/:orgId' or "overview" would be read as an id.
router.get('/organizations/overview', org.orgOverviewController);
router.get('/organizations/:orgId', org.orgDetailController);                           // ?role=dispatcher|driver
router.get('/organizations/:orgId/users/:userId/trips', org.orgUserTripsController);

// The steps an organization wants on every trip (chosen at onboarding, editable here). Affects new trips only.
router.get('/checkpoint-presets', org.checkpointPresetsController);
router.get('/organizations/:orgId/checkpoints', org.getOrgCheckpointsController);
router.put('/organizations/:orgId/checkpoints', org.putOrgCheckpointsController);   // { steps: [...] }

// Dispatcher requests for extra checkpoint-time edits
router.get('/edit-requests', requests.listEditRequestsController);                      // ?scope=pending|active|history
router.get('/edit-requests/count', requests.countEditRequestsController);
router.post('/edit-requests/:requestId/approve', requests.approveEditRequestController); // { durationMinutes: 30|60|120|180|240 }
router.post('/edit-requests/:requestId/deny', requests.denyEditRequestController);       // { note? }
router.post('/edit-requests/:requestId/revoke', requests.revokeEditWindowController);     // end an open window early

module.exports = router;
