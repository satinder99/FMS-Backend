// [BACKEND · Express] src/Services/driverService.js
// src/Services/driverService.js — what a driver sees about their own trips, hours and pay.
const pool = require('../config/dbConfig');
const { fetchTrips } = require('./tripService');

const DAILY_DRIVE_LIMIT_HOURS = 11; // US property-carrying driving limit; make configurable later

const listTrips = ({ orgId, driverId }) => fetchTrips(pool, { orgId, driverId, recentDays: 30 });

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Hours + earnings for today / week / month / year-to-date, in the ORGANIZATION's timezone
 * (weeks start Monday). A session crossing a boundary is clipped; an open session counts up to now.
 *
 * Earnings = hours x the rate copied onto each session from its trip. Only hourly pay can be priced
 * from hours: hours on per-mile / percentage / salary trips are reported as `unpricedHours`
 * (those earnings are worked out at settlement, once distance/revenue exist).
 */
async function getHours({ driverId }) {
  const { rows } = await pool.query(
    `WITH tz AS (
       SELECT COALESCE(o.timezone, 'UTC') AS name
         FROM drivers d JOIN organizations o ON o.id = d.org_id
        WHERE d.id = $1
     ),
     bounds AS (
       SELECT p.period,
              date_trunc(p.unit, now() AT TIME ZONE tz.name) AT TIME ZONE tz.name AS start_at
         FROM tz
         CROSS JOIN (VALUES ('today','day'), ('week','week'), ('month','month'), ('ytd','year')) AS p(period, unit)
     )
     SELECT b.period,
            COALESCE(SUM(h.hrs), 0) AS hours,
            COALESCE(SUM(h.hrs * s.hourly_rate), 0) AS earnings,
            COALESCE(SUM(h.hrs) FILTER (WHERE s.id IS NOT NULL AND s.hourly_rate IS NULL), 0) AS unpriced_hours
       FROM bounds b
       LEFT JOIN work_sessions s
              ON s.driver_id = $1 AND COALESCE(s.ended_at, now()) > b.start_at
       LEFT JOIN LATERAL (
              SELECT CASE WHEN s.id IS NULL THEN 0
                          ELSE EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - GREATEST(s.started_at, b.start_at))) / 3600.0
                     END AS hrs
            ) h ON TRUE
      GROUP BY b.period`,
    [driverId]
  );

  const out = { dailyDriveLimit: DAILY_DRIVE_LIMIT_HOURS };
  for (const key of ['today', 'week', 'month', 'ytd']) {
    const r = rows.find((x) => x.period === key);
    out[key] = {
      hours: r ? round2(r.hours) : 0,
      earnings: r ? round2(r.earnings) : 0,
      unpricedHours: r ? round2(r.unpriced_hours) : 0,
    };
  }
  return out;
}

module.exports = { listTrips, getHours };
