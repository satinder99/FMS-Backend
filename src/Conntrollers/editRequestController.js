// [BACKEND · Express] src/Conntrollers/editRequestController.js
// Thin HTTP layer for edit-access requests. Dispatcher handlers work on req.ctx.orgId (their own
// organization); admin handlers are cross-organization and sit behind requireCtxRole('admin').
const editRequestService = require('../Services/editRequestService');
const { parseId } = require('../Utils/validate');

const handler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// ----- dispatcher
const getEditAccessController = handler(async (req, res) => {
  res.json(await editRequestService.getAccessState(req.ctx.orgId));
});

const createEditRequestController = handler(async (req, res) => {
  const request = await editRequestService.createRequest({ orgId: req.ctx.orgId, userId: req.ctx.userId, body: req.body });
  res.status(201).json({ request });
});

const cancelEditRequestController = handler(async (req, res) => {
  const request = await editRequestService.cancelRequest({
    orgId: req.ctx.orgId,
    userId: req.ctx.userId,
    requestId: parseId(req.params.requestId, 'request id'),
  });
  res.json({ request });
});

// ----- admin
const listEditRequestsController = handler(async (req, res) => {
  res.json({ requests: await editRequestService.listRequests(String(req.query.scope || 'pending')) });
});

const countEditRequestsController = handler(async (req, res) => {
  res.json({ count: await editRequestService.pendingCount() });
});

const approveEditRequestController = handler(async (req, res) => {
  const body = req.body || {};
  res.json({
    request: await editRequestService.approve({
      adminId: req.ctx.userId,
      requestId: parseId(req.params.requestId, 'request id'),
      durationMinutes: body.durationMinutes,
    }),
  });
});

const denyEditRequestController = handler(async (req, res) => {
  const body = req.body || {};
  res.json({
    request: await editRequestService.deny({
      adminId: req.ctx.userId,
      requestId: parseId(req.params.requestId, 'request id'),
      note: body.note,
    }),
  });
});

const revokeEditWindowController = handler(async (req, res) => {
  res.json({
    request: await editRequestService.revoke({ adminId: req.ctx.userId, requestId: parseId(req.params.requestId, 'request id') }),
  });
});

module.exports = {
  getEditAccessController,
  createEditRequestController,
  cancelEditRequestController,
  listEditRequestsController,
  countEditRequestsController,
  approveEditRequestController,
  denyEditRequestController,
  revokeEditWindowController,
};
