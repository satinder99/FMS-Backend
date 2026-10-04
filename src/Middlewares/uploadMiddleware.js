// [BACKEND · Express] src/Middlewares/uploadMiddleware.js
// Reads ONE uploaded file (form field "file") into memory so it can be checked and sent to storage.
// Runs only after the user has been authenticated (see the routers), and turns the upload library's own
// errors into the { error, code } answers the rest of the API gives.
const multer = require('multer');
const { AppError } = require('../Errors/errors');
const { MAX_FILE_BYTES } = require('../Services/documentTypes');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
}).single('file');

function singleFileUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('That file is too large (15 MB maximum).', 413, 'FILE_TOO_LARGE'));
    }
    if (err.name === 'MulterError') {
      return next(new AppError('The upload could not be read. Send exactly one file in the "file" field.', 400, 'INVALID_UPLOAD'));
    }
    return next(err);
  });
}

module.exports = { singleFileUpload };
