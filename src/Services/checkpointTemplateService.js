// [BACKEND · Express] src/Services/checkpointTemplateService.js
// The ordered list of steps ("checkpoints") an ORGANIZATION wants on every trip. An admin chooses them when
// onboarding the organization (required) and can change them later. A new trip copies the list, so editing it
// never touches trips that already exist.
//
// Each step is either a STANDARD step picked from the list below, or a CUSTOM step the admin typed in
// ("Other"). Standard steps keep their fixed key (the system relies on a few: pod_upload, start_journey).
// Custom steps get a generated key like x_weigh_station.
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');

/** The standard steps offered in the drop-down. Change a label here to rename it for NEW organizations. */
const PRESETS = [
  { key: 'reached_source', label: 'Reached source', crossBorderOnly: false },
  { key: 'pickup_truck', label: 'Pick up truck', crossBorderOnly: false },
  { key: 'pickup_trailer', label: 'Pick up trailer', crossBorderOnly: false },
  { key: 'load_trailer', label: 'Load trailer', crossBorderOnly: false },
  { key: 'start_journey', label: 'Start journey', crossBorderOnly: false },
  { key: 'immigration', label: 'Immigration / customs', crossBorderOnly: true },
  { key: 'pod_upload', label: 'Upload POD', crossBorderOnly: false },
];
const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));
const PRESET_LABELS = new Set(PRESETS.map((p) => p.label.toLowerCase()));

const MAX_STEPS = 30;
// 2-60 characters: letters (any language), digits, spaces and . , ' ’ & ( ) / + -
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()/+-]{1,59}$/u;

/** x_weigh_station, x_weigh_station_2 ... (<= 30 characters, never a standard key, never repeated in the list). */
function customKey(label, taken) {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = `x_${slug || 'step'}`.slice(0, 28);
  let key = base;
  for (let n = 2; taken.has(key) || PRESET_BY_KEY.has(key); n++) {
    const suffix = `_${n}`;
    key = `${base.slice(0, 30 - suffix.length)}${suffix}`;
  }
  return key;
}

/**
 * Validates and normalizes what the admin submitted. PURE (no database).
 *   input: [{ presetKey: 'pod_upload', crossBorderOnly?: bool }   <- a standard step
 *           { label: 'Weigh station',  crossBorderOnly?: bool }]  <- a custom ("Other") step
 * Returns { problems: [text], rows: [{ seq, key, label, isCustom, crossBorderOnly }] }.
 */
function normalizeTemplate(input) {
  const problems = [];
  if (!Array.isArray(input) || input.length === 0) return { problems: ['Add at least one step.'], rows: [] };
  if (input.length > MAX_STEPS) return { problems: [`A trip can have at most ${MAX_STEPS} steps.`], rows: [] };

  const rows = [];
  const keys = new Set();
  const labels = new Set();

  input.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`Step ${n} is not valid.`);
      return;
    }
    if (raw.crossBorderOnly !== undefined && typeof raw.crossBorderOnly !== 'boolean') {
      problems.push(`Step ${n}: "only for cross-border trips" must be yes or no.`);
      return;
    }

    const wantsPreset = raw.presetKey !== undefined && raw.presetKey !== null && raw.presetKey !== '';
    let key;
    let label;
    let isCustom;
    let crossBorderOnly;

    if (wantsPreset) {
      const preset = PRESET_BY_KEY.get(raw.presetKey);
      if (!preset) {
        problems.push(`Step ${n}: choose one of the standard steps, or "Other" to type your own.`);
        return;
      }
      if (keys.has(preset.key)) {
        problems.push(`Step ${n}: "${preset.label}" is already in the list.`);
        return;
      }
      ({ key, label } = preset);
      isCustom = false;
      crossBorderOnly = raw.crossBorderOnly ?? preset.crossBorderOnly;
    } else {
      label = typeof raw.label === 'string' ? raw.label.trim().replace(/\s+/g, ' ') : '';
      if (!label) {
        problems.push(`Step ${n}: choose a step or type a name for it.`);
        return;
      }
      if (!LABEL_RE.test(label)) {
        problems.push(`Step ${n}: the name must be 2–60 characters (letters, digits, spaces and . , ' & ( ) / + - only).`);
        return;
      }
      const lower = label.toLowerCase();
      if (PRESET_LABELS.has(lower)) {
        problems.push(`Step ${n}: "${label}" is a standard step. Pick it from the list instead of typing it.`);
        return;
      }
      if (labels.has(lower)) {
        problems.push(`Step ${n}: "${label}" is already in the list.`);
        return;
      }
      key = customKey(label, keys);
      isCustom = true;
      crossBorderOnly = raw.crossBorderOnly ?? false;
    }

    keys.add(key);
    labels.add(label.toLowerCase());
    rows.push({ seq: rows.length + 1, key, label, isCustom, crossBorderOnly });
  });

  if (!problems.length && rows.every((r) => r.crossBorderOnly)) {
    problems.push('At least one step must apply to every trip (not only cross-border trips).');
  }
  return { problems, rows: problems.length ? [] : rows };
}

// ------------------------------------------------------------------ database

/** `db` = pool or a transaction client. */
async function getTemplate(db, orgId) {
  const { rows } = await db.query(
    `SELECT seq, key, label, is_custom, cross_border_only
       FROM org_checkpoint_templates WHERE org_id = $1 ORDER BY seq`,
    [orgId]
  );
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    isCustom: r.is_custom,
    crossBorderOnly: r.cross_border_only,
  }));
}

/** Replace the whole list for an organization (used at onboarding and when an admin edits the steps). */
async function replaceTemplate(client, orgId, rows) {
  await client.query(`DELETE FROM org_checkpoint_templates WHERE org_id = $1`, [orgId]);
  await client.query(
    `INSERT INTO org_checkpoint_templates (org_id, seq, key, label, is_custom, cross_border_only)
     SELECT $1, s, k, l, c, b
       FROM unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::boolean[]) AS x(s, k, l, c, b)`,
    [orgId, rows.map((r) => r.seq), rows.map((r) => r.key), rows.map((r) => r.label), rows.map((r) => r.isCustom), rows.map((r) => r.crossBorderOnly)]
  );
}

/** The steps a NEW trip gets: the organization's list, minus cross-border-only steps on domestic trips. */
async function stepsForTrip(client, orgId, crossBorder) {
  const template = await getTemplate(client, orgId);
  if (template.length === 0) {
    throw new AppError(
      "This organization has no trip steps set up yet. An admin needs to choose them first (Admin → the organization → Trip steps).",
      409,
      'NO_CHECKPOINT_TEMPLATE'
    );
  }
  const steps = template.filter((s) => crossBorder || !s.crossBorderOnly);
  if (steps.length === 0) {
    throw new AppError('This organization\'s steps do not apply to this kind of trip.', 409, 'NO_CHECKPOINT_TEMPLATE');
  }
  return steps;
}

/** Admin: the steps of one organization, in the shape the editor uses. */
async function getOrgSteps(orgId) {
  const exists = await pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [orgId]);
  if (!exists.rows[0]) throw new AppError('Organization not found.', 404, 'ORG_NOT_FOUND');
  return getTemplate(pool, orgId);
}

/** Admin: validate and save a new list for an existing organization. Applies to trips created from now on. */
async function setOrgSteps(orgId, input) {
  const { problems, rows } = normalizeTemplate(input);
  if (problems.length) throw new AppError(problems.join(' '), 400, 'VALIDATION_FAILED');
  return withTransaction(async (client) => {
    const org = await client.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [orgId]);
    if (!org.rows[0]) throw new AppError('Organization not found.', 404, 'ORG_NOT_FOUND');
    await replaceTemplate(client, orgId, rows);
    return rows.map(({ key, label, isCustom, crossBorderOnly }) => ({ key, label, isCustom, crossBorderOnly }));
  });
}

module.exports = {
  PRESETS,
  MAX_STEPS,
  normalizeTemplate,
  customKey,
  getTemplate,
  replaceTemplate,
  stepsForTrip,
  getOrgSteps,
  setOrgSteps,
};
