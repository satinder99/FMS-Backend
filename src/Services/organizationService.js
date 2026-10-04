// [BACKEND · Express] src/Services/organizationService.js
// Onboarding a new organization (admin only — enforced by adminRoutes.js).
//
// Every rule here mirrors the `organizations` table (column lengths, CHECK lists, unique indexes)
// and is mirrored again in the frontend's lib/orgValidation.ts. The frontend check is for
// convenience; THIS file is the real gatekeeper. Keep the two in sync.
//
// Only 3 columns are NOT NULL in the table: name, slug, short_name. On top of that the trip STEPS
// (checkpoints) are required: an organization cannot be created without choosing them. Everything else is optional.
// Columns with a DB default (org_type, country, timezone, subscription_plan, status) are always
// given an explicit value here, because passing NULL would override the default with NULL.

const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { withTransaction } = require('../Utils/dbHelpers');
const { normalizeTemplate, replaceTemplate } = require('./checkpointTemplateService');

const ORG_TYPES = ['carrier', 'broker', 'shipper'];
const PLANS = ['trial', 'starter', 'pro', 'enterprise'];
const COUNTRIES = ['US', 'CA', 'MX']; // North America only for now
const DEFAULT_TRIAL_DAYS = 14;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s().-]+$/;
const POSTAL = {
  US: { re: /^\d{5}(-\d{4})?$/, hint: 'a ZIP code like 60601 or 60601-1234' },
  CA: { re: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, hint: 'a postal code like L6T 4S9' },
  MX: { re: /^\d{5}$/, hint: 'a 5-digit postal code' },
};

// Returns the normalized URL (scheme added if missing) or null when it isn't a safe http(s) address.
// Rejecting every other scheme (javascript:, data:, ...) matters because these get shown as links.
function normalizeUrl(raw, max) {
  const s = raw.trim();
  if (/\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.hostname.includes('.')) return null;
    return withScheme.length <= max ? withScheme : null;
  } catch {
    return null;
  }
}

/**
 * Pure validation + normalization (no database). Returns { errors, values, trialEndsOn }
 * where `errors` maps field name -> message (empty object = valid).
 */
function checkOrganizationInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const v = {}; // column -> value, in the shape the INSERT needs

  // ----- small helpers that record errors instead of throwing, so the admin sees everything at once
  const str = (field, label, { max, min = 0, required = false } = {}) => {
    const raw = b[field];
    if (isBlank(raw)) {
      if (required) errors[field] = `${label} is required.`;
      return null;
    }
    if (typeof raw !== 'string') {
      errors[field] = `${label} must be text.`;
      return null;
    }
    const s = raw.trim();
    if (s.length < min || s.length > max) {
      errors[field] = min ? `${label} must be ${min}–${max} characters.` : `${label} must be ${max} characters or fewer.`;
      return null;
    }
    return s;
  };
  const oneOf = (field, label, list, fallback) => {
    if (isBlank(b[field])) return fallback;
    if (!list.includes(b[field])) {
      errors[field] = `${label} must be one of: ${list.join(', ')}.`;
      return fallback;
    }
    return b[field];
  };
  const email = (field, label) => {
    const s = str(field, label, { max: 255 });
    if (s === null) return null;
    if (!EMAIL_RE.test(s)) {
      errors[field] = `${label} must be a valid email address.`;
      return null;
    }
    return s.toLowerCase();
  };
  const phone = (field, label) => {
    const s = str(field, label, { max: 20 });
    if (s === null) return null;
    const digits = s.replace(/\D/g, '').length;
    if (!PHONE_RE.test(s) || s.slice(1).includes('+') || digits < 7 || digits > 15) {
      errors[field] = `${label} must be a phone number with 7–15 digits (e.g. +1 905 555 0100).`;
      return null;
    }
    return s;
  };
  const url = (field, label, max) => {
    const s = str(field, label, { max: max + 20 }); // length is checked on the normalized value below
    if (s === null) return null;
    const normalized = normalizeUrl(s, max);
    if (!normalized) {
      errors[field] = `${label} must be a web address starting with http:// or https:// (up to ${max} characters).`;
      return null;
    }
    return normalized;
  };
  const date = (field, label) => {
    const s = str(field, label, { max: 10 });
    if (s === null) return null;
    if (!isRealDate(s)) {
      errors[field] = `${label} must be a real date like 2027-06-30.`;
      return null;
    }
    return s;
  };

  // ===== Organization (required: name, shortName, slug) =====
  v.name = str('name', 'Organization name', { min: 2, max: 200, required: true });
  v.legal_name = str('legalName', 'Legal name', { max: 200 });

  const shortRaw = str('shortName', 'Short name', { required: true, max: 100 });
  if (shortRaw !== null) {
    if (/^[A-Za-z0-9]{2,20}$/.test(shortRaw)) v.short_name = shortRaw.toUpperCase();
    else errors.shortName = 'Short name must be 2–20 letters or digits, with no spaces (it becomes the username prefix, e.g. DFS).';
  }

  const slugRaw = isBlank(b.slug) ? slugify(b.name) : typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : null;
  if (slugRaw === null) errors.slug = 'URL name must be text.';
  else if (!slugRaw) errors.slug = 'URL name is required (it is built from the organization name if left blank).';
  else if (slugRaw.length > 100 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugRaw)) {
    errors.slug = 'URL name may only use lowercase letters, digits and single hyphens (up to 100 characters).';
  } else v.slug = slugRaw;

  v.org_type = oneOf('orgType', 'Organization type', ORG_TYPES, 'carrier');
  v.logo_url = url('logoUrl', 'Logo link', 2048);

  // ===== Regulatory identifiers =====
  if (!isBlank(b.dotNumber)) {
    const s = String(b.dotNumber).trim().replace(/^(usdot|dot)[\s-]*/i, '');
    if (/^\d{1,8}$/.test(s)) v.dot_number = s;
    else errors.dotNumber = 'USDOT number must be 1–8 digits.';
  }
  if (!isBlank(b.mcNumber)) {
    const s = String(b.mcNumber).trim().replace(/^mc[\s-]*/i, '');
    if (/^\d{1,8}$/.test(s)) v.mc_number = s;
    else errors.mcNumber = 'MC number must be 1–8 digits.';
  }
  if (!isBlank(b.scacCode)) {
    const s = String(b.scacCode).trim().toUpperCase();
    if (/^[A-Z]{2,4}$/.test(s)) v.scac_code = s;
    else errors.scacCode = 'SCAC code must be 2–4 letters.';
  }
  if (!isBlank(b.einTaxId)) {
    const s = String(b.einTaxId).trim().toUpperCase();
    if (/^\d{2}-?\d{7}$/.test(s) || /^\d{9}(RT\d{4})?$/.test(s)) v.ein_tax_id = s;
    else errors.einTaxId = 'Tax ID must be a US EIN (12-3456789) or a Canadian business number (123456789 or 123456789RT0001).';
  }

  // ===== Insurance =====
  v.insurance_provider = str('insuranceProvider', 'Insurance provider', { max: 150 });
  v.insurance_policy_number = str('insurancePolicyNumber', 'Policy number', { max: 100 });
  v.insurance_expiry_date = date('insuranceExpiryDate', 'Insurance expiry date');
  if (!isBlank(b.cargoInsuranceAmount)) {
    const s = String(b.cargoInsuranceAmount).trim().replace(/,/g, '');
    if (/^\d{1,10}(\.\d{1,2})?$/.test(s)) v.cargo_insurance_amount = s;
    else errors.cargoInsuranceAmount = 'Cargo insurance must be an amount up to 9,999,999,999.99.';
  }

  // ===== Contact =====
  v.primary_contact_name = str('primaryContactName', 'Contact name', { max: 150 });
  v.primary_contact_email = email('primaryContactEmail', 'Contact email');
  v.primary_contact_phone = phone('primaryContactPhone', 'Contact phone');
  v.billing_email = email('billingEmail', 'Billing email');
  v.phone = phone('phone', 'Main phone');
  v.website = url('website', 'Website', 255);

  // ===== Address (postal code format depends on the country) =====
  v.address_line1 = str('addressLine1', 'Address line 1', { max: 255 });
  v.address_line2 = str('addressLine2', 'Address line 2', { max: 255 });
  v.city = str('city', 'City', { max: 100 });
  v.state_province = str('stateProvince', 'State / province', { max: 50 });
  v.country = oneOf('country', 'Country', COUNTRIES, 'US');
  const postal = str('postalCode', 'Postal code', { max: 20 });
  if (postal !== null) {
    const rule = POSTAL[v.country];
    if (rule.re.test(postal)) v.postal_code = v.country === 'CA' ? postal.toUpperCase() : postal;
    else errors.postalCode = `Postal code must be ${rule.hint}.`;
  }
  // Checked against Postgres' own list in createOrganization (the pay/hours queries use it).
  v.timezone = isBlank(b.timezone) ? 'America/New_York' : typeof b.timezone === 'string' ? b.timezone.trim() : null;
  if (v.timezone === null || v.timezone.length > 50) {
    errors.timezone = 'Timezone must be a name like America/Toronto.';
    v.timezone = 'America/New_York';
  }

  // ===== Plan =====
  v.subscription_plan = oneOf('subscriptionPlan', 'Plan', PLANS, 'trial');
  v.status = v.subscription_plan === 'trial' ? 'trial' : 'active';

  let trialEndsOn = null;
  if (!isBlank(b.trialEndsOn)) {
    if (v.subscription_plan !== 'trial') errors.trialEndsOn = 'A trial end date only applies to the trial plan.';
    else trialEndsOn = date('trialEndsOn', 'Trial end date');
  }

  if (!isBlank(b.fleetSize)) {
    const s = String(b.fleetSize).trim();
    if (/^\d{1,6}$/.test(s) && Number(s) <= 100000) v.fleet_size = Number(s);
    else errors.fleetSize = 'Fleet size must be a whole number from 0 to 100,000.';
  }

  // ===== Trip steps (REQUIRED): the checkpoints every trip of this organization will go through =====
  const template = normalizeTemplate(b.checkpoints);
  if (template.problems.length) errors.checkpoints = template.problems.join(' ');

  // Missing optional values become NULL.
  for (const k of Object.keys(v)) if (v[k] === undefined) v[k] = null;

  return { errors, values: v, trialEndsOn, template: template.rows };
}

const todayIn = (timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

const toOrganization = (r) => ({
  id: Number(r.id),
  name: r.name,
  legalName: r.legal_name,
  slug: r.slug,
  shortName: r.short_name,
  orgType: r.org_type,
  timezone: r.timezone,
  subscriptionPlan: r.subscription_plan,
  trialEndsAt: r.trial_ends_at ? r.trial_ends_at.toISOString() : null,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});

const UNIQUE_CONFLICTS = {
  idx_organizations_slug: ['ORG_SLUG_EXISTS', 'Another organization already uses that URL name. Change it and try again.'],
  idx_organizations_short_name: ['ORG_SHORT_NAME_EXISTS', 'That short name is already taken (names are compared ignoring upper/lower case).'],
  idx_organizations_dot_number: ['ORG_DOT_EXISTS', 'An organization with that USDOT number already exists.'],
  idx_organizations_mc_number: ['ORG_MC_EXISTS', 'An organization with that MC number already exists.'],
};

async function createOrganization(body) {
  // Express leaves req.body undefined when the request wasn't sent as JSON. Say so, instead of
  // reporting "name is required" for a form that was actually filled in.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'The request arrived without a JSON body. It must be sent with the header Content-Type: application/json.',
      400,
      'INVALID_BODY'
    );
  }
  const { errors, values, trialEndsOn, template } = checkOrganizationInput(body);
  const problems = Object.values(errors);
  if (problems.length) throw new AppError(problems.join(' '), 400, 'VALIDATION_FAILED');

  // The timezone must be one Postgres knows, otherwise "AT TIME ZONE" breaks the hours/pay queries later.
  const tz = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [values.timezone]);
  if (!tz.rows[0]) throw new AppError('Timezone is not recognized. Pick one from the list.', 400, 'VALIDATION_FAILED');

  if (trialEndsOn && trialEndsOn < todayIn(values.timezone)) {
    throw new AppError('Trial end date cannot be in the past.', 400, 'VALIDATION_FAILED');
  }

  // Column names come from the keys above (our own code), never from the request.
  const columns = Object.keys(values);
  const params = columns.map((c) => values[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`);

  if (values.subscription_plan === 'trial') {
    columns.push('trial_ends_at');
    if (trialEndsOn) {
      // Trial runs THROUGH the chosen day: end = start of the next day in the organization's timezone.
      placeholders.push(`(($${params.length + 1}::date + 1)::timestamp AT TIME ZONE $${params.length + 2})`);
      params.push(trialEndsOn, values.timezone);
    } else {
      placeholders.push(`now() + make_interval(days => $${params.length + 1}::int)`);
      params.push(DEFAULT_TRIAL_DAYS);
    }
  }

  try {
    // The organization and its step list are saved together, or not at all.
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO organizations (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING id, name, legal_name, slug, short_name, org_type, timezone,
                   subscription_plan, trial_ends_at, status, created_at`,
        params
      );
      await replaceTemplate(client, rows[0].id, template);
      return { ...toOrganization(rows[0]), stepCount: template.length };
    });
  } catch (err) {
    const conflict = err.code === '23505' && UNIQUE_CONFLICTS[err.constraint];
    if (conflict) throw new AppError(conflict[1], 409, conflict[0]);
    throw err;
  }
}

module.exports = { createOrganization, checkOrganizationInput, slugify, DEFAULT_TRIAL_DAYS };
