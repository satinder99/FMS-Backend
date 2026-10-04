// [BACKEND · Express] src/Conntrollers/adminOrgController.js — admin views of organizations, their people and trips.
const adminOrgService = require('../Services/adminOrgService');
const templates = require('../Services/checkpointTemplateService');
const { parseId } = require('../Utils/validate');

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const orgOverviewController = handler(async (req, res) => {
  res.json({ organizations: await adminOrgService.listOverview() });
});

const orgDetailController = handler(async (req, res) => {
  const role = req.query.role === undefined || req.query.role === '' ? undefined : String(req.query.role);
  res.json(await adminOrgService.getDetail({ orgId: parseId(req.params.orgId, 'organization id'), role }));
});

const orgUserTripsController = handler(async (req, res) => {
  res.json(
    await adminOrgService.listUserTrips({
      orgId: parseId(req.params.orgId, 'organization id'),
      userId: parseId(req.params.userId, 'user id'),
    })
  );
});

// The steps ("checkpoints") an organization wants on every trip
const checkpointPresetsController = handler(async (req, res) => {
  res.json({ presets: templates.PRESETS });
});

const getOrgCheckpointsController = handler(async (req, res) => {
  res.json({ steps: await templates.getOrgSteps(parseId(req.params.orgId, 'organization id')) });
});

const putOrgCheckpointsController = handler(async (req, res) => {
  const body = req.body || {};
  res.json({ steps: await templates.setOrgSteps(parseId(req.params.orgId, 'organization id'), body.steps) });
});

module.exports = {
  orgOverviewController,
  orgDetailController,
  orgUserTripsController,
  checkpointPresetsController,
  getOrgCheckpointsController,
  putOrgCheckpointsController,
};
