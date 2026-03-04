// Paste into Apps Script file: validate.gs

function asTrimmedString_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function requireString_(value, fieldName) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    throw new Error(fieldName + ' is required.');
  }

  return trimmed;
}

function normalizeDateString_(value, fieldName, allowBlank) {
  var trimmed = asTrimmedString_(value);

  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new Error(fieldName + ' is required.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(fieldName + ' must use yyyy-mm-dd.');
  }

  return trimmed;
}

function coerceNonNegativeNumber_(value, fieldName) {
  var parsed = Number(value);
  if (!isFinite(parsed)) {
    throw new Error(fieldName + ' must be numeric.');
  }

  if (parsed < 0) {
    throw new Error(fieldName + ' must be zero or greater.');
  }

  return parsed;
}

function coerceOptionalNonNegativeNumber_(value, fieldName) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    return null;
  }

  return coerceNonNegativeNumber_(trimmed, fieldName);
}

function coerceFeetValue_(value, fieldName, warnings, allowNegativeClamp) {
  var parsed = Number(value);
  if (!isFinite(parsed)) {
    throw new Error(fieldName + ' must be numeric.');
  }

  var floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(fieldName + ' was rounded down to ' + floored + '.');
  }

  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(fieldName + ' was clamped to 0.');
      return 0;
    }

    throw new Error(fieldName + ' must be zero or greater.');
  }

  return floored;
}

function assertBoxStatus_(status) {
  var normalized = asTrimmedString_(status).toUpperCase();
  if (
    normalized !== 'ORDERED' &&
    normalized !== 'IN_STOCK' &&
    normalized !== 'CHECKED_OUT' &&
    normalized !== 'ZEROED' &&
    normalized !== 'RETIRED'
  ) {
    throw new Error('Status must be ORDERED, IN_STOCK, CHECKED_OUT, ZEROED, or RETIRED.');
  }

  return normalized;
}
