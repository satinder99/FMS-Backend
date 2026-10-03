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

const router = express.Router();
router.use(requireAuth, loadContext, requireCtxRole('admin'));

router.get('/users', listUsersController);
router.get('/organizations', listOrganizationsController);
router.post('/organizations', createOrganizationController); // onboard a new organization
router.patch('/users/:userId/access', assignAccessController);

module.exports = router;
