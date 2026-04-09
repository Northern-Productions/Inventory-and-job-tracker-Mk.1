import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  compareCatalogStrings,
  normalizeRequirementWidthKey,
  requireString,
} from './helpers.mjs';
import {
  normalizeCanonicalManufacturerAndFilm,
  normalizeJobRequirementInput,
  normalizeCatalogManufacturerLookupKey,
  normalizeCatalogLookupKey,
} from './catalog.mjs';

function normalizeJobNumberDigits(value, fieldName) {
  const normalized = requireString(value, fieldName || 'JobNumber');
  if (!/^\d+$/.test(normalized)) {
    throw new HttpError(400, `${fieldName || 'JobNumber'} must contain numbers only.`);
  }

  return normalized;
}

function normalizeJobWarehouse(value) {
  return requireString(value, 'Warehouse').toUpperCase();
}

function normalizeJobSections(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  const rawParts = trimmed.split(',');
  const normalizedParts = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const token = asTrimmedString(rawParts[index]);
    if (!token) {
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new HttpError(400, 'Sections must contain numbers separated by commas.');
    }

    normalizedParts.push(token);
  }

  if (!normalizedParts.length) {
    return null;
  }

  return normalizedParts.join(', ');
}

function normalizeJobLifecycleStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (normalized === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalized === 'COMPLETED') {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

function normalizeJobLifecycleFilter(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'ACTIVE' || normalized === 'COMPLETED') {
    return normalized;
  }

  throw new HttpError(400, 'lifecycleStatus must be ACTIVE or COMPLETED.');
}

function normalizeJobRequirementLookupKey(manufacturer, filmName, widthIn) {
  const canonical = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  return [
    normalizeCatalogManufacturerLookupKey(canonical.manufacturer),
    normalizeCatalogLookupKey(canonical.filmName),
    normalizeRequirementWidthKey(widthIn),
  ].join('|');
}

function dedupeJobRequirements(requirements, warnings) {
  const deduped = {};

  if (!requirements || !Array.isArray(requirements)) {
    return [];
  }

  for (let index = 0; index < requirements.length; index += 1) {
    const normalized = normalizeJobRequirementInput(requirements[index], warnings, index);
    const key = normalizeJobRequirementLookupKey(
      normalized.manufacturer,
      normalized.filmName,
      normalized.widthIn
    );

    if (!deduped[key]) {
      deduped[key] = normalized;
      continue;
    }

    deduped[key].requiredFeet += normalized.requiredFeet;
  }

  const values = Object.values(deduped);
  values.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }

    return 0;
  });

  return values;
}

function normalizeJobNumberKey(jobNumber) {
  return asTrimmedString(jobNumber).toUpperCase();
}

function normalizeCrewLeaderKey(crewLeader) {
  return asTrimmedString(crewLeader).toUpperCase();
}

function compareBoxesByOldestStock(left, right) {
  const leftDate = left.receivedDate || left.orderDate || '9999-12-31';
  const rightDate = right.receivedDate || right.orderDate || '9999-12-31';

  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1;
  }

  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

function compareAllocationJobSummaries(left, right) {
  if (left.jobDate && right.jobDate && left.jobDate !== right.jobDate) {
    return left.jobDate < right.jobDate ? -1 : 1;
  }

  if (left.jobDate && !right.jobDate) {
    return -1;
  }

  if (!left.jobDate && right.jobDate) {
    return 1;
  }

  return left.jobNumber < right.jobNumber ? -1 : left.jobNumber > right.jobNumber ? 1 : 0;
}

function compareJobsListEntries(left, right) {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
    return left.dueDate > right.dueDate ? -1 : 1;
  }

  if (left.dueDate && !right.dueDate) {
    return -1;
  }

  if (!left.dueDate && right.dueDate) {
    return 1;
  }

  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }

  if (left.updatedAt && !right.updatedAt) {
    return -1;
  }

  if (!left.updatedAt && right.updatedAt) {
    return 1;
  }

  return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
}

function extractJobNumberDigitsForSearch(value) {
  return asTrimmedString(value).replace(/[^0-9]/g, '');
}

function compareBigInt(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value;
}

export {
  normalizeJobNumberDigits,
  normalizeJobWarehouse,
  normalizeJobSections,
  normalizeJobLifecycleStatus,
  normalizeJobLifecycleFilter,
  normalizeJobRequirementLookupKey,
  dedupeJobRequirements,
  normalizeJobNumberKey,
  normalizeCrewLeaderKey,
  compareBoxesByOldestStock,
  compareAllocationJobSummaries,
  compareJobsListEntries,
  extractJobNumberDigitsForSearch,
  compareBigInt,
  absoluteBigInt,
};
