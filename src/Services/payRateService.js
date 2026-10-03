// [BACKEND · Express] src/Services/payRateService.js
// src/Services/payRateService.js — a driver's pay rates by whose equipment they run.
// APPEND-ONLY history: a raise is a NEW row with a later effective date, never an edit.
// Trips copy the rate in force when they are created, so history is never rewritten.
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { requireBoolean, requireOneOf } = require('../Utils/validate');

const PAY_TYPES = ['hourly', 'per_mile', 'percentage', 'salary'];

const toRate = (r) => ({
  id: Number(r.id),
  ownTruck: r.own_truck,
  ownTrailer: r.own_trailer,
  payType: r.pay_type,
  payRate: Number(r.pay_rate),
  effectiveFrom: r.effective_from, // already 'YYYY-MM-DD' (to_char in SQL; avoids timezone shifts)
});

const RATE_SQL = `SELECT id, own_truck, own_trailer, pay_type, pay_rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
                    FROM driver_pay_rates`;

async function assertDriverInOrg(orgId, driverId) {
  const { rows } = await pool.query(
    `SELECT d.id, u.first_name, u.last_name, u.phone
       FROM drivers d JOIN user_accounts u ON u.id = d.user_id
      WHERE d.id = $1 AND d.org_id = $2`,
    [driverId, orgId]
  );
  if (!rows[0]) throw new AppError('Driver not found.', 404, 'DRIVER_NOT_FOUND');
  return { id: Number(rows[0].id), name: `${rows[0].first_name} ${rows[0].last_name}`, phone: rows[0].phone };
}

async function listForDriver({ orgId, driverId }) {
  const driver = await assertDriverInOrg(orgId, driverId);
  const { rows } = await pool.query(
    `${RATE_SQL} WHERE driver_id = $1 AND org_id = $2 ORDER BY effective_from DESC, id DESC`,
    [driverId, orgId]
  );
  return { driver, rates: rows.map(toRate) };
}

async function addRate({ orgId, driverId, userId, body }) {
  await assertDriverInOrg(orgId, driverId);
  const b = body || {};
  const ownTruck = requireBoolean(b.ownTruck, 'Own truck');
  const ownTrailer = requireBoolean(b.ownTrailer, 'Own trailer');
  const payType = requireOneOf(b.payType, 'Pay type', PAY_TYPES);

  const payRate = Number(b.payRate);
  if (!Number.isFinite(payRate) || payRate < 0 || payRate > 100000) {
    throw new AppError('Enter a pay rate between 0 and 100,000.', 400, 'INVALID_INPUT');
  }

  let effectiveFrom = null; // null -> database default (today)
  if (b.effectiveFrom !== undefined && b.effectiveFrom !== null && b.effectiveFrom !== '') {
    if (typeof b.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.effectiveFrom) || Number.isNaN(Date.parse(b.effectiveFrom))) {
      throw new AppError('Effective date must look like 2026-10-01.', 400, 'INVALID_INPUT');
    }
    effectiveFrom = b.effectiveFrom;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO driver_pay_rates (org_id, driver_id, own_truck, own_trailer, pay_type, pay_rate, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8)
       RETURNING id, own_truck, own_trailer, pay_type, pay_rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from`,
      [orgId, driverId, ownTruck, ownTrailer, payType, payRate, effectiveFrom, userId]
    );
    return toRate(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(
        'A rate for that equipment and date already exists. Choose a later effective date.',
        409,
        'RATE_EXISTS'
      );
    }
    throw err;
  }
}

module.exports = { listForDriver, addRate };
