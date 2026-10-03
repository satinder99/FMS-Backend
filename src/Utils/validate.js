// [BACKEND · Express] src/Utils/validate.js
// src/Utils/validate.js — small input validators. Everything from req.body / req.params /
// req.query is untrusted; services call these before touching the database.
const { AppError } = require('../Errors/errors');

const bad = (message) => new AppError(message, 400, 'INVALID_INPUT');

function parseId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(`Invalid ${label}.`, 400, 'INVALID_ID');
  return n;
}

function requireText(value, label, max = 200) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > max) throw bad(`${label} is required (max ${max} characters).`);
  return s;
}

function optionalText(value, label, max = 200) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw bad(`${label} must be text up to ${max} characters.`);
  return value.trim() || null;
}

function requireOneOf(value, label, allowed) {
  if (!allowed.includes(value)) throw bad(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw bad(`${label} must be true or false.`);
  return value;
}

module.exports = { parseId, requireText, optionalText, requireOneOf, requireBoolean };
