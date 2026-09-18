// errorHandler.js — central Express error middleware.
// Wire this up LAST in app.js: app.use(errorHandler)

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  if (statusCode === 500) {
    // Don't leak internals to the client; log server-side instead.
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong.', code: 'INTERNAL_ERROR' });
  }

  res.status(statusCode).json({ error: err.message, code });
}

module.exports = errorHandler;