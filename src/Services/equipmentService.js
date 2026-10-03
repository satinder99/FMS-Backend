// [BACKEND · Express] src/Services/equipmentService.js
// src/Services/equipmentService.js — trucks and trailers (same rules, two tables).
// Each unit is company-owned or owned by a person ('owner_operator'): either one of OUR drivers
// (owner_driver_id) or an outside person/entity (owner_name). Ownership decides which pay rate
// applies when a driver is assigned the unit (see tripService.createTrip).
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');
const { parseId, requireText, optionalText, requireOneOf } = require('../Utils/validate');

// Table/column names are chosen from this whitelist, never from user input.
const KINDS = {
  truck: { table: 'trucks', tripColumn: 'truck_id' },
  trailer: { table: 'trailers', tripColumn: 'trailer_id' },
};
const OWNERSHIP = ['company', 'owner_operator'];
const STATUSES = ['active', 'maintenance', 'retired'];

const kindOf = (kind) => {
  if (!KINDS[kind]) throw new AppError('Unknown equipment type.', 400, 'INVALID_INPUT');
  return KINDS[kind];
};

const SELECT = (table) => `
  SELECT e.id, e.unit_number, e.plate_number, e.ownership_type, e.owner_driver_id, e.owner_name, e.status,
         COALESCE(u.first_name || ' ' || u.last_name, e.owner_name) AS owner_label
    FROM ${table} e
    LEFT JOIN drivers d       ON d.id = e.owner_driver_id
    LEFT JOIN user_accounts u ON u.id = d.user_id`;

const toEquipment = (r) => ({
  id: Number(r.id),
  unitNumber: r.unit_number,
  plateNumber: r.plate_number,
  ownership: r.ownership_type,
  ownerDriverId: r.owner_driver_id == null ? null : Number(r.owner_driver_id),
  ownerName: r.owner_name,
  ownerLabel: r.owner_label,
  status: r.status,
});

async function list(kind, orgId) {
  const { table } = kindOf(kind);
  const { rows } = await pool.query(
    `${SELECT(table)} WHERE e.org_id = $1 ORDER BY (e.status = 'retired'), e.unit_number`,
    [orgId]
  );
  return rows.map(toEquipment);
}

// Validates the ownership fields together; returns the values to store.
async function resolveOwner(client, orgId, ownership, ownerDriverId, ownerName) {
  if (ownership === 'company') return { ownerDriverId: null, ownerName: null };

  const driverId = ownerDriverId == null || ownerDriverId === '' ? null : parseId(ownerDriverId, 'owner driver');
  const name = optionalText(ownerName, 'Owner name', 150);
  if (driverId === null && name === null) {
    throw new AppError('Say who owns it: pick one of your drivers or enter the owner’s name.', 400, 'OWNER_REQUIRED');
  }
  if (driverId !== null) {
    const d = (await client.query(`SELECT 1 FROM drivers WHERE id = $1 AND org_id = $2`, [driverId, orgId])).rows[0];
    if (!d) throw new AppError('That driver is not in your organization.', 400, 'INVALID_DRIVER');
    return { ownerDriverId: driverId, ownerName: null };
  }
  return { ownerDriverId: null, ownerName: name };
}

async function create(kind, orgId, body) {
  const { table } = kindOf(kind);
  const b = body || {};
  const unitNumber = requireText(b.unitNumber, 'Unit number', 30);
  const plateNumber = optionalText(b.plateNumber, 'Plate number', 20);
  const ownership = requireOneOf(b.ownership, 'Ownership', OWNERSHIP);

  try {
    return await withTransaction(async (client) => {
      const owner = await resolveOwner(client, orgId, ownership, b.ownerDriverId, b.ownerName);
      const { rows } = await client.query(
        `INSERT INTO ${table} (org_id, unit_number, plate_number, ownership_type, owner_driver_id, owner_name)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orgId, unitNumber, plateNumber, ownership, owner.ownerDriverId, owner.ownerName]
      );
      return (await client.query(`${SELECT(table)} WHERE e.id = $1 AND e.org_id = $2`, [rows[0].id, orgId])).rows.map(
        toEquipment
      )[0];
    });
  } catch (err) {
    if (err.code === '23505') throw new AppError(`Unit ${unitNumber} already exists.`, 409, 'UNIT_EXISTS');
    throw err;
  }
}

/** Partial update: status, plate, and/or ownership (ownership fields are replaced together). */
async function update(kind, orgId, id, body) {
  const { table, tripColumn } = kindOf(kind);
  const unitId = parseId(id, 'unit id');
  const b = body || {};

  return withTransaction(async (client) => {
    const current = (
      await client.query(`SELECT * FROM ${table} WHERE id = $1 AND org_id = $2 FOR UPDATE`, [unitId, orgId])
    ).rows[0];
    if (!current) throw new AppError('Unit not found.', 404, 'NOT_FOUND');

    const status = b.status === undefined ? current.status : requireOneOf(b.status, 'Status', STATUSES);
    const plateNumber = b.plateNumber === undefined ? current.plate_number : optionalText(b.plateNumber, 'Plate number', 20);

    // A unit that is on an open trip can't be taken out of service.
    if (status !== 'active' && current.status === 'active') {
      const open = await client.query(
        `SELECT 1 FROM trips WHERE org_id = $1 AND ${tripColumn} = $2 AND status IN ('assigned', 'in_progress') LIMIT 1`,
        [orgId, unitId]
      );
      if (open.rows[0]) {
        throw new AppError('This unit is on an open trip. Reassign or finish the trip first.', 409, 'IN_USE');
      }
    }

    let ownership = current.ownership_type;
    let owner = { ownerDriverId: current.owner_driver_id, ownerName: current.owner_name };
    if (b.ownership !== undefined) {
      ownership = requireOneOf(b.ownership, 'Ownership', OWNERSHIP);
      owner = await resolveOwner(client, orgId, ownership, b.ownerDriverId, b.ownerName);
    }

    await client.query(
      `UPDATE ${table}
          SET status = $3, plate_number = $4, ownership_type = $5, owner_driver_id = $6, owner_name = $7
        WHERE id = $1 AND org_id = $2`,
      [unitId, orgId, status, plateNumber, ownership, owner.ownerDriverId, owner.ownerName]
    );
    return (await client.query(`${SELECT(table)} WHERE e.id = $1 AND e.org_id = $2`, [unitId, orgId])).rows.map(
      toEquipment
    )[0];
  });
}

module.exports = { list, create, update };
