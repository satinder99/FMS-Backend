// [BACKEND · Express] src/Services/adminService.js
// src/Services/adminService.js — admin-only user/organization management.
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');
const { parseId } = require('../Utils/validate');

const ROLES = ['admin', 'dispatcher', 'driver'];

const USER_SQL = `
  SELECT ua.id, ua.first_name, ua.last_name, ua.email, ua.username, ua.org_id,
         r.name AS role_name, ua.status, ua.created_at
    FROM user_accounts ua
    LEFT JOIN roles r ON r.id = ua.role_id`;

const toAdminUser = (row) => ({
  id: Number(row.id),
  first_name: row.first_name,
  last_name: row.last_name,
  email: row.email,
  username: row.username,
  org_id: row.org_id == null ? null : Number(row.org_id),
  role_name: row.role_name,
  status: row.status,
  created_at: row.created_at.toISOString(),
});

async function listUsers() {
  const { rows } = await pool.query(`${USER_SQL} ORDER BY ua.created_at DESC LIMIT 500`);
  return rows.map(toAdminUser);
}

async function listOrganizations() {
  const { rows } = await pool.query(`SELECT id, name, short_name FROM organizations ORDER BY name`);
  return rows.map((o) => ({ id: Number(o.id), name: o.name, short_name: o.short_name }));
}

/**
 * Grant or change a user's role + organization (takes the role NAME, e.g. 'driver').
 *  - admin is platform-level: org is forced to NULL; every other role needs a real org
 *  - nobody can change their own access (so at least one admin always remains)
 *  - 'driver' creates/re-activates the driver profile; any other role marks it inactive (never deleted)
 *  - a driver with open trips cannot be moved off driver duty or to another org
 *  - all of the user's refresh tokens are revoked so the new access applies on the next login
 */
async function assignAccess({ actorId, targetId, roleName, orgId }) {
  if (!ROLES.includes(roleName)) throw new AppError('Choose a valid role.', 400, 'INVALID_ROLE');
  if (actorId === targetId) {
    throw new AppError('You cannot change your own access.', 403, 'CANNOT_CHANGE_SELF');
  }

  let finalOrgId = null;
  if (roleName !== 'admin') {
    if (orgId === undefined || orgId === null) throw new AppError('Choose an organization.', 400, 'ORG_REQUIRED');
    finalOrgId = parseId(orgId, 'organization id');
  }

  return withTransaction(async (client) => {
    const target = (
      await client.query(
        `SELECT ua.id, ua.org_id, r.name AS role_name
           FROM user_accounts ua LEFT JOIN roles r ON r.id = ua.role_id
          WHERE ua.id = $1 FOR UPDATE OF ua`,
        [targetId]
      )
    ).rows[0];
    if (!target) throw new AppError('User not found.', 404, 'ACCOUNT_NOT_FOUND');

    const role = (await client.query(`SELECT id FROM roles WHERE lower(name) = $1`, [roleName])).rows[0];
    if (!role) throw new AppError('That role does not exist.', 400, 'ROLE_NOT_FOUND');

    if (finalOrgId !== null) {
      const org = (await client.query(`SELECT id FROM organizations WHERE id = $1`, [finalOrgId])).rows[0];
      if (!org) throw new AppError('Organization not found.', 404, 'ORG_NOT_FOUND');
    }

    const currentOrg = target.org_id == null ? null : Number(target.org_id);
    const unchanged = target.role_name === roleName && currentOrg === finalOrgId;

    if (!unchanged) {
      const driver = (
        await client.query(`SELECT id, org_id, employment_status FROM drivers WHERE user_id = $1 FOR UPDATE`, [targetId])
      ).rows[0];

      // Moving an existing driver off driver duty / to another org: no open trips allowed.
      if (driver) {
        const staysSameDriver = roleName === 'driver' && Number(driver.org_id) === finalOrgId;
        if (!staysSameDriver) {
          const open = await client.query(
            `SELECT 1 FROM trips WHERE driver_id = $1 AND status IN ('assigned', 'in_progress') LIMIT 1`,
            [driver.id]
          );
          if (open.rows[0]) {
            throw new AppError(
              'This driver still has open trips. Reassign or finish them first.',
              409,
              'HAS_ACTIVE_TRIPS'
            );
          }
        }
      }

      await client.query(
        `UPDATE user_accounts
            SET org_id = $2, role_id = $3, assigned_by = $4, assigned_at = now()
          WHERE id = $1`,
        [targetId, finalOrgId, role.id, actorId]
      );

      if (roleName === 'driver') {
        if (!driver) {
          await client.query(`INSERT INTO drivers (org_id, user_id, created_by) VALUES ($1, $2, $3)`, [
            finalOrgId,
            targetId,
            actorId,
          ]);
        } else if (Number(driver.org_id) !== finalOrgId) {
          const history = await client.query(`SELECT 1 FROM trips WHERE driver_id = $1 LIMIT 1`, [driver.id]);
          if (history.rows[0]) {
            throw new AppError('This driver has trip history in another organization.', 409, 'DRIVER_HAS_HISTORY');
          }
          await client.query(
            `UPDATE drivers SET org_id = $2, employment_status = 'active', updated_by = $3 WHERE id = $1`,
            [driver.id, finalOrgId, actorId]
          );
        } else if (driver.employment_status === 'inactive') {
          // Only an 'inactive' profile is revived. terminated/suspended/on_leave are HR decisions.
          await client.query(`UPDATE drivers SET employment_status = 'active', updated_by = $2 WHERE id = $1`, [
            driver.id,
            actorId,
          ]);
        }
      } else if (driver && driver.employment_status === 'active') {
        await client.query(`UPDATE drivers SET employment_status = 'inactive', updated_by = $2 WHERE id = $1`, [
          driver.id,
          actorId,
        ]);
      }

      // Same effect as logoutAll(): old sessions were minted under the old role's token policy.
      await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_account_id = $1 AND revoked_at IS NULL`, [
        targetId,
      ]);
    }

    const fresh = await client.query(`${USER_SQL} WHERE ua.id = $1`, [targetId]);
    return toAdminUser(fresh.rows[0]);
  });
}

module.exports = { listUsers, listOrganizations, assignAccess };
