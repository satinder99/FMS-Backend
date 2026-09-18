// db.js — single shared pg pool for the whole app
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_DEV,
  max: 10,
  idleTimeoutMillis: 30000,
});

module.exports = pool;