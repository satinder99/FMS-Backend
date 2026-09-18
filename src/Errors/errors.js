// errors.js — small typed error so the controller/central error handler
// can map to the right HTTP status without string-matching messages.
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code; // machine-readable, e.g. 'INVALID_CREDENTIALS'
  }
}

module.exports = { AppError };