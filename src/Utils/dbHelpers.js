// [BACKEND · Express] src/Utils/dbHelpers.js
// src/Utils/dbHelpers.js — transaction helper shared by the fleet services.
const pool = require('../config/dbConfig');

/** Runs fn(client) inside BEGIN/COMMIT; rolls back and rethrows on any error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* surface the original error, not the rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
