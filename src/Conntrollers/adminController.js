// [BACKEND · Express] src/Conntrollers/adminController.js
// Thin HTTP layer for admin routes.
const adminService = require('../Services/adminService');
const organizationService = require('../Services/organizationService');
const { parseId } = require('../Utils/validate');

async function listUsersController(req, res, next) {
  try {
    res.json({ users: await adminService.listUsers() });
  } catch (err) {
    next(err);
  }
}

async function listOrganizationsController(req, res, next) {
  try {
    res.json({ organizations: await adminService.listOrganizations() });
  } catch (err) {
    next(err);
  }
}

// Onboard a new organization. The body is validated field by field in organizationService.
async function createOrganizationController(req, res, next) {
  try {
    console.log("req.body",req.body)
    const organization = await organizationService.createOrganization(req.body);
    res.status(201).json({ organization });
  } catch (err) {
    next(err);
  }
}

// Actor comes from req.ctx (server-derived); the target comes from the URL and is validated.
async function assignAccessController(req, res, next) {
  try {
    const { role, orgId } = req.body || {};
    const user = await adminService.assignAccess({
      actorId: req.ctx.userId,
      targetId: parseId(req.params.userId, 'user id'),
      roleName: role,
      orgId,
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listUsersController,
  listOrganizationsController,
  createOrganizationController,
  assignAccessController,
};
