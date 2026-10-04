// [BACKEND · Express] src/Conntrollers/documentController.js
// Thin HTTP layer for trip documents. Driver handlers use req.driver / req.ctx; dispatcher handlers use
// req.ctx.orgId. Downloads are streamed by this server (never a public link) with "attachment" so the browser
// saves the file instead of opening it.
const { pipeline } = require('stream');
const documentService = require('../Services/documentService');
const { parseId } = require('../Utils/validate');

/** Content-Disposition with a plain ASCII fallback plus the real (UTF-8) name. */
function attachment(filename) {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ----- driver
async function driverUploadController(req, res, next) {
  try {
    const body = req.body || {};
    const trip = await documentService.uploadForDriver({
      tripId: parseId(req.params.tripId, 'trip id'),
      orgId: req.ctx.orgId,
      driverId: req.driver.id,
      userId: req.ctx.userId,
      docType: typeof body.docType === 'string' && body.docType ? body.docType : 'pod',
      file: req.file,
    });
    res.status(201).json({ trip });
  } catch (err) {
    next(err);
  }
}

async function driverDeleteController(req, res, next) {
  try {
    const trip = await documentService.deleteForDriver({
      docId: parseId(req.params.docId, 'document id'),
      orgId: req.ctx.orgId,
      driverId: req.driver.id,
      userId: req.ctx.userId,
    });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// ----- dispatcher
async function downloadDocumentController(req, res, next) {
  try {
    const doc = await documentService.openDocument({
      docId: parseId(req.params.docId, 'document id'),
      orgId: req.ctx.orgId,
    });
    res.setHeader('Content-Type', doc.contentType);
    res.setHeader('Content-Length', String(doc.size));
    res.setHeader('Content-Disposition', attachment(doc.filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    pipeline(doc.stream, res, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
}

async function downloadTripZipController(req, res, next) {
  try {
    await documentService.streamTripZip({
      tripId: parseId(req.params.tripId, 'trip id'),
      orgId: req.ctx.orgId,
      res,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { driverUploadController, driverDeleteController, downloadDocumentController, downloadTripZipController, attachment };
