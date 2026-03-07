import './load-env.mjs';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/g, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || '').trim();
const LOW_STOCK_THRESHOLD_LF = 10;

const CORE_WEIGHT_REFERENCE_WIDTH_IN = 72;
const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS = {
  White: 2,
  Red: 1.85,
  Cardboard: 2.05
};

const BOX_STATUSES = new Set(['ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED']);
const authIdentityCache = new Map();

const pool =
  DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
      })
    : null;

class HttpError extends Error {
  constructor(statusCode, message, warnings = []) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.warnings = warnings;
  }
}

function ok(data, warnings = []) {
  return {
    ok: true,
    data,
    warnings
  };
}

function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function requireString(value, fieldName) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  return trimmed;
}

function normalizeDateString(value, fieldName, allowBlank) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new HttpError(400, `${fieldName} is required.`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, `${fieldName} must use yyyy-mm-dd.`);
  }

  return trimmed;
}

function coerceNonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }

  if (parsed < 0) {
    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }

  return parsed;
}

function coerceOptionalNonNegativeNumber(value, fieldName) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  return coerceNonNegativeNumber(trimmed, fieldName);
}

function coerceFeetValue(value, fieldName, warnings, allowNegativeClamp) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }

  const floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(`${fieldName} was rounded down to ${floored}.`);
  }

  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(`${fieldName} was clamped to 0.`);
      return 0;
    }

    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }

  return floored;
}

function assertBoxStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!BOX_STATUSES.has(normalized)) {
    throw new HttpError(
      400,
      'Status must be ORDERED, IN_STOCK, CHECKED_OUT, ZEROED, or RETIRED.'
    );
  }

  return normalized;
}

function parseBooleanFlag(value) {
  return value === true || asTrimmedString(value).toLowerCase() === 'true';
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function formatDateValue(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return iso.slice(0, 10);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrZero(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function createLogId() {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
    String(now.getUTCMilliseconds()).padStart(3, '0')
  ].join('');
  const suffix = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  return `${timestamp}-${suffix}`;
}

function roundToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function determineWarehouseFromBoxId(boxId) {
  return requireString(boxId, 'BoxID').charAt(0).toUpperCase() === 'M' ? 'MS' : 'IL';
}

function buildFilmKey(manufacturer, filmName) {
  return `${manufacturer.toUpperCase()}|${filmName.toUpperCase()}`;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function deriveAddFeetAvailable(initialFeet, receivedDate) {
  return receivedDate && receivedDate <= todayDateString() ? initialFeet : 0;
}

function deriveLifecycleStatus(receivedDate) {
  return receivedDate && receivedDate <= todayDateString() ? 'IN_STOCK' : 'ORDERED';
}

function normalizeCoreType(value, allowBlank) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new HttpError(400, 'CoreType is required.');
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'white') {
    return 'White';
  }

  if (normalized === 'red') {
    return 'Red';
  }

  if (normalized === 'cardboard') {
    return 'Cardboard';
  }

  throw new HttpError(400, 'CoreType must be White, Red, or Cardboard.');
}

function deriveCoreWeightLbs(coreType, widthIn) {
  return roundToDecimals(
    (CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS[coreType] / CORE_WEIGHT_REFERENCE_WIDTH_IN) * widthIn,
    4
  );
}

function deriveLfWeightLbsPerFt(sqFtWeightLbsPerSqFt, widthIn) {
  return roundToDecimals(sqFtWeightLbsPerSqFt * (widthIn / 12), 6);
}

function deriveInitialWeightLbs(lfWeightLbsPerFt, initialFeet, coreWeightLbs) {
  return roundToDecimals(lfWeightLbsPerFt * initialFeet + coreWeightLbs, 2);
}

function deriveSqFtWeightLbsPerSqFt(initialWeightLbs, coreWeightLbs, widthIn, initialFeet) {
  const areaSqFt = (widthIn / 12) * initialFeet;
  if (areaSqFt <= 0) {
    throw new HttpError(400, 'WidthIn and InitialFeet must be greater than zero to derive film weight.');
  }

  const filmOnlyWeightLbs = initialWeightLbs - coreWeightLbs;
  if (filmOnlyWeightLbs < 0) {
    throw new HttpError(
      400,
      'InitialWeightLbs must be greater than or equal to the derived core weight.'
    );
  }

  return roundToDecimals(filmOnlyWeightLbs / areaSqFt, 8);
}

function deriveFeetAvailableFromRollWeight(lastRollWeightLbs, coreWeightLbs, lfWeightLbsPerFt, initialFeet) {
  if (lfWeightLbsPerFt <= 0) {
    throw new HttpError(
      400,
      'LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.'
    );
  }

  const rawFeet = (lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt;
  if (rawFeet <= 0) {
    return 0;
  }

  const flooredFeet = Math.floor(rawFeet);
  if (flooredFeet > initialFeet) {
    return initialFeet;
  }

  return flooredFeet;
}

function isLowStockBox(box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < LOW_STOCK_THRESHOLD_LF;
}

function hasPositivePhysicalFeet(box) {
  if (!box || !box.receivedDate) {
    return false;
  }

  if (
    box.lastRollWeightLbs !== null &&
    box.coreWeightLbs !== null &&
    box.lfWeightLbsPerFt !== null &&
    box.lfWeightLbsPerFt > 0
  ) {
    return (
      deriveFeetAvailableFromRollWeight(
        box.lastRollWeightLbs,
        box.coreWeightLbs,
        box.lfWeightLbsPerFt,
        box.initialFeet
      ) > 0
    );
  }

  return box.initialFeet > 0;
}

function shouldAutoMoveToZeroed(existingBox, nextBox) {
  return (
    Boolean(nextBox.receivedDate) &&
    existingBox &&
    hasPositivePhysicalFeet(existingBox) &&
    (nextBox.feetAvailable === 0 || nextBox.lastRollWeightLbs === 0)
  );
}

function determineZeroedReason(box) {
  if (box.feetAvailable === 0 && box.lastRollWeightLbs === 0) {
    return 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.';
  }

  if (box.feetAvailable === 0) {
    return 'Auto-zeroed because Available Feet reached 0.';
  }

  return 'Auto-zeroed because Last Roll Weight reached 0.';
}

function normalizeMeaningfulZeroedNote(note) {
  const trimmed = asTrimmedString(note);
  if (!trimmed) {
    return '';
  }

  if (/^Checked in at /i.test(trimmed) || /^Auto-moved to zeroed out inventory$/i.test(trimmed)) {
    return '';
  }

  return trimmed;
}

function stampZeroedMetadata(box, user, auditNote) {
  const note = normalizeMeaningfulZeroedNote(auditNote);
  box.status = 'ZEROED';
  box.feetAvailable = 0;
  box.zeroedDate = todayDateString();
  box.zeroedReason = `${determineZeroedReason(box)}${note ? ` Additional note: ${note}` : ''}`;
  box.zeroedBy = asTrimmedString(user);
}

function applyAddOrEditWarnings(warnings, currentBox, nextBox) {
  if (nextBox.receivedDate && nextBox.orderDate && nextBox.receivedDate < nextBox.orderDate) {
    warnings.push('Received Date is earlier than Order Date.');
  }

  if (nextBox.lastWeighedDate && nextBox.receivedDate && nextBox.lastWeighedDate < nextBox.receivedDate) {
    warnings.push('Last Weighed Date is earlier than Received Date.');
  }

  if (nextBox.feetAvailable > nextBox.initialFeet) {
    warnings.push('Available Feet is greater than Initial Feet.');
  }

  if (
    nextBox.receivedDate &&
    nextBox.feetAvailable === 0 &&
    nextBox.lastRollWeightLbs !== null &&
    nextBox.lastRollWeightLbs > 0
  ) {
    warnings.push('Available Feet is 0 while Last Roll Weight is still above 0.');
  }

  if (nextBox.receivedDate && nextBox.lastRollWeightLbs === 0 && nextBox.feetAvailable > 0) {
    warnings.push('Last Roll Weight is 0 while Available Feet is still above 0.');
  }

  if (
    currentBox &&
    currentBox.receivedDate &&
    (currentBox.initialWeightLbs !== null ||
      currentBox.lastRollWeightLbs !== null ||
      currentBox.lfWeightLbsPerFt !== null) &&
    (currentBox.manufacturer !== nextBox.manufacturer ||
      currentBox.filmName !== nextBox.filmName ||
      currentBox.widthIn !== nextBox.widthIn ||
      currentBox.initialFeet !== nextBox.initialFeet)
  ) {
    warnings.push('Film identity, width, or initial feet changed after weights were already established.');
  }
}

function applyCheckoutWarnings(warnings, box) {
  if (box.lastRollWeightLbs === null) {
    warnings.push('This box does not have a current Last Roll Weight saved yet.');
  }

  if (!box.lastWeighedDate) {
    warnings.push('This box does not have a Last Weighed Date saved yet.');
  }
}

function applyCheckInWarnings(warnings, existingBox, updatedBox, willAutoZero) {
  if (
    existingBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.lastRollWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box\'s previous Last Roll Weight.');
  }

  if (
    existingBox.initialWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.initialWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box\'s Initial Weight.');
  }

  if (
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > 0 &&
    updatedBox.coreWeightLbs !== null &&
    updatedBox.lastRollWeightLbs < updatedBox.coreWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is below the derived core weight.');
  }

  if (updatedBox.feetAvailable > existingBox.feetAvailable) {
    warnings.push('The recalculated Available Feet would increase compared with the current box.');
  }

  if (willAutoZero) {
    warnings.push('This check-in will auto-move the box into zeroed out inventory.');
  }
}

function normalizeCollapsedCatalogLabel(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function normalizeCatalogLookupKey(value) {
  return normalizeCollapsedCatalogLabel(value).toLowerCase();
}

function compareCatalogStrings(left, right) {
  const leftValue = asTrimmedString(left).toLowerCase();
  const rightValue = asTrimmedString(right).toLowerCase();

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

function normalizeJobNumberDigits(value, fieldName) {
  const normalized = requireString(value, fieldName || 'JobNumber');
  if (!/^\d+$/.test(normalized)) {
    throw new HttpError(400, `${fieldName || 'JobNumber'} must contain numbers only.`);
  }

  return normalized;
}

function normalizeJobWarehouse(value) {
  const normalized = requireString(value, 'Warehouse').toUpperCase();
  if (normalized !== 'IL' && normalized !== 'MS') {
    throw new HttpError(400, 'Warehouse must be IL or MS.');
  }

  return normalized;
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

  return 'ACTIVE';
}

function normalizeRequirementWidthKey(value) {
  return String(roundToDecimals(Number(value), 4));
}

function normalizeJobRequirementLookupKey(manufacturer, filmName, widthIn) {
  return [
    normalizeCatalogLookupKey(manufacturer),
    normalizeCatalogLookupKey(filmName),
    normalizeRequirementWidthKey(widthIn)
  ].join('|');
}

function normalizeJobRequirementInput(entry, warnings, index) {
  const prefix = `Requirements[${index}]`;
  const manufacturer = requireString(entry && entry.manufacturer, `${prefix}.Manufacturer`);
  const filmName = requireString(entry && entry.filmName, `${prefix}.FilmName`);
  const widthIn = coerceNonNegativeNumber(entry && entry.widthIn, `${prefix}.WidthIn`);
  const requiredFeet = coerceFeetValue(entry && entry.requiredFeet, `${prefix}.RequiredFeet`, warnings, false);

  if (widthIn <= 0) {
    throw new HttpError(400, `${prefix}.WidthIn must be greater than zero.`);
  }

  if (requiredFeet <= 0) {
    throw new HttpError(400, `${prefix}.RequiredFeet must be greater than zero.`);
  }

  return {
    manufacturer: normalizeCollapsedCatalogLabel(manufacturer),
    filmName: normalizeCollapsedCatalogLabel(filmName),
    widthIn,
    requiredFeet
  };
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

function mapDbBoxRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    initialFeet: integerOrZero(row.initial_feet),
    feetAvailable: integerOrZero(row.feet_available),
    lotRun: asTrimmedString(row.lot_run),
    status: asTrimmedString(row.status) || 'ORDERED',
    orderDate: formatDateValue(row.order_date),
    receivedDate: formatDateValue(row.received_date),
    initialWeightLbs: numericOrNull(row.initial_weight_lbs),
    lastRollWeightLbs: numericOrNull(row.last_roll_weight_lbs),
    lastWeighedDate: formatDateValue(row.last_weighed_date),
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numericOrNull(row.core_weight_lbs),
    lfWeightLbsPerFt: numericOrNull(row.lf_weight_lbs_per_ft),
    purchaseCost: numericOrNull(row.purchase_cost),
    notes: asTrimmedString(row.notes),
    hasEverBeenCheckedOut: Boolean(row.has_ever_been_checked_out),
    lastCheckoutJob: asTrimmedString(row.last_checkout_job),
    lastCheckoutDate: formatDateValue(row.last_checkout_date),
    zeroedDate: formatDateValue(row.zeroed_date),
    zeroedReason: asTrimmedString(row.zeroed_reason),
    zeroedBy: asTrimmedString(row.zeroed_by),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function toPublicBox(box) {
  return {
    boxId: box.boxId,
    warehouse: box.warehouse,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: box.feetAvailable,
    lotRun: box.lotRun,
    status: box.status,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    initialWeightLbs: box.initialWeightLbs,
    lastRollWeightLbs: box.lastRollWeightLbs,
    lastWeighedDate: box.lastWeighedDate,
    filmKey: box.filmKey,
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt,
    purchaseCost: box.purchaseCost,
    notes: box.notes,
    hasEverBeenCheckedOut: box.hasEverBeenCheckedOut,
    lastCheckoutJob: box.lastCheckoutJob,
    lastCheckoutDate: box.lastCheckoutDate,
    zeroedDate: box.zeroedDate,
    zeroedReason: box.zeroedReason,
    zeroedBy: box.zeroedBy
  };
}

function mapDbFilmCatalogRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    sqFtWeightLbsPerSqFt: numericOrNull(row.sq_ft_weight_lbs_per_sq_ft),
    defaultCoreType: asTrimmedString(row.default_core_type),
    sourceWidthIn: numericOrNull(row.source_width_in),
    sourceInitialFeet: integerOrNull(row.source_initial_feet),
    sourceInitialWeightLbs: numericOrNull(row.source_initial_weight_lbs),
    sourceBoxId: asTrimmedString(row.source_box_id),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapDbAllocationRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    allocationId: asTrimmedString(row.allocation_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    jobDate: formatDateValue(row.job_date),
    allocatedFeet: integerOrZero(row.allocated_feet),
    status: asTrimmedString(row.status) || 'ACTIVE',
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
    crewLeader: asTrimmedString(row.crew_leader),
    filmOrderId: asTrimmedString(row.film_order_id)
  };
}

function toPublicAllocation(entry) {
  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    warehouse: entry.warehouse,
    jobNumber: entry.jobNumber,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    status: entry.status,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    filmOrderId: entry.filmOrderId,
    notes: entry.notes
  };
}

function mapDbFilmOrderRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmOrderId: asTrimmedString(row.film_order_id),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requestedFeet: integerOrZero(row.requested_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    orderedFeet: integerOrZero(row.ordered_feet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet),
    jobDate: formatDateValue(row.job_date),
    crewLeader: asTrimmedString(row.crew_leader),
    status: asTrimmedString(row.status) || 'FILM_ORDER',
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes)
  };
}

function toPublicFilmOrder(entry, linkedBoxes) {
  return {
    filmOrderId: entry.filmOrderId,
    jobNumber: entry.jobNumber,
    warehouse: entry.warehouse,
    manufacturer: entry.manufacturer,
    filmName: entry.filmName,
    widthIn: entry.widthIn,
    requestedFeet: entry.requestedFeet,
    coveredFeet: entry.coveredFeet,
    orderedFeet: entry.orderedFeet,
    remainingToOrderFeet: entry.remainingToOrderFeet,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    status: entry.status,
    sourceBoxId: entry.sourceBoxId,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    notes: entry.notes,
    linkedBoxes
  };
}

function mapDbFilmOrderLinkRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    linkId: asTrimmedString(row.link_id),
    filmOrderId: asTrimmedString(row.film_order_id),
    boxId: asTrimmedString(row.box_id),
    orderedFeet: integerOrZero(row.ordered_feet),
    autoAllocatedFeet: integerOrZero(row.auto_allocated_feet),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by)
  };
}

function mapDbJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse) || 'IL',
    sections: asTrimmedString(row.sections) || null,
    dueDate: formatDateValue(row.due_date),
    lifecycleStatus: asTrimmedString(row.lifecycle_status) || 'ACTIVE',
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by)
  };
}

function mapDbRequirementRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobId: row.job_id,
    jobNumber: asTrimmedString(row.job_number),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requiredFeet: integerOrZero(row.required_feet),
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by)
  };
}

function mapDbAuditRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    date: formatTimestamp(row.created_at),
    action: asTrimmedString(row.action),
    boxId: asTrimmedString(row.box_id),
    before: row.before_state || null,
    after: row.after_state || null,
    user: asTrimmedString(row.actor),
    notes: asTrimmedString(row.notes)
  };
}

function mapDbRollHistoryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    jobNumber: asTrimmedString(row.job_number),
    checkedOutAt: formatTimestamp(row.checked_out_at),
    checkedOutBy: asTrimmedString(row.checked_out_by),
    checkedOutWeightLbs: numericOrNull(row.checked_out_weight_lbs),
    checkedInAt: formatTimestamp(row.checked_in_at),
    checkedInBy: asTrimmedString(row.checked_in_by),
    checkedInWeightLbs: numericOrNull(row.checked_in_weight_lbs),
    weightDeltaLbs: numericOrNull(row.weight_delta_lbs),
    feetBefore: integerOrZero(row.feet_before),
    feetAfter: integerOrZero(row.feet_after),
    notes: asTrimmedString(row.notes)
  };
}

function ensureConfigured() {
  if (!pool) {
    throw new HttpError(500, 'DATABASE_URL (or SUPABASE_DB_URL) is not configured.');
  }

  if (!SUPABASE_URL) {
    throw new HttpError(500, 'SUPABASE_URL is not configured.');
  }

  if (!SUPABASE_ANON_KEY) {
    throw new HttpError(500, 'SUPABASE_ANON_KEY is not configured.');
  }
}

async function withReadClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function withMutation(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query(`
      lock table
        app.boxes,
        app.allocations,
        app.film_orders,
        app.film_order_box_links,
        app.jobs,
        app.job_requirements,
        app.audit_log,
        app.roll_weight_log,
        app.film_catalog
      in share row exclusive mode
    `);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function queryRows(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

async function queryRow(client, text, params = []) {
  const rows = await queryRows(client, text, params);
  return rows[0] || null;
}

async function fetchAuthIdentity(token) {
  const cached = authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.identity;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const email = asTrimmedString(payload.email);
  const metadata =
    payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    (email ? email.split('@')[0].replace(/[._-]+/g, ' ').trim() : '') ||
    'Inventory User';

  const identity = {
    userId: asTrimmedString(payload.id),
    email,
    name,
    token
  };

  authIdentityCache.set(token, {
    expiresAt: Date.now() + 60_000,
    identity
  });

  return identity;
}

async function resolveAuthContext(headers) {
  const authorization = headers.authorization || headers.Authorization || '';
  const token = asTrimmedString(authorization).replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  const identity = await fetchAuthIdentity(token);
  if (!identity || !identity.userId || !identity.email) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  return withReadClient(async (client) => {
    const memberships = await queryRows(
      client,
      `
        select org_id
        from app.organization_members
        where user_id = $1
        order by created_at asc, org_id asc
      `,
      [identity.userId]
    );

    if (!memberships.length) {
      throw new HttpError(403, 'You do not have access to this inventory workspace.');
    }

    let orgId = DEFAULT_ORG_ID;
    if (orgId) {
      const found = memberships.some((entry) => entry.org_id === orgId);
      if (!found) {
        throw new HttpError(403, 'DEFAULT_ORG_ID is not assigned to the authenticated user.');
      }
    } else if (memberships.length === 1) {
      orgId = memberships[0].org_id;
    } else {
      throw new HttpError(
        500,
        'DEFAULT_ORG_ID is required because this user belongs to multiple organizations.'
      );
    }

    return {
      ...identity,
      orgId,
      actor: `${identity.name} <${identity.email}>`
    };
  });
}

function routeParams(method, requestUrl, bodyJson) {
  if (method === 'GET') {
    const params = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === 'path') {
        continue;
      }

      params[key] = value;
    }
    return params;
  }

  const next = bodyJson && typeof bodyJson === 'object' ? { ...bodyJson } : {};
  delete next.path;
  delete next.authToken;
  delete next.authUser;
  return next;
}

async function listBoxes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.boxes
      where org_id = $1
    `,
    [orgId]
  );

  return rows.map(mapDbBoxRow);
}

async function findBoxById(client, orgId, boxId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.boxes
      where org_id = $1
        and box_id = $2
    `,
    [orgId, boxId]
  );

  return mapDbBoxRow(row);
}

async function saveBoxRecord(client, orgId, box) {
  const row = await queryRow(
    client,
    `
      insert into app.boxes (
        org_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        initial_feet,
        feet_available,
        lot_run,
        status,
        order_date,
        received_date,
        initial_weight_lbs,
        last_roll_weight_lbs,
        last_weighed_date,
        film_key,
        core_type,
        core_weight_lbs,
        lf_weight_lbs_per_ft,
        purchase_cost,
        notes,
        has_ever_been_checked_out,
        last_checkout_job,
        last_checkout_date,
        zeroed_date,
        zeroed_reason,
        zeroed_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        nullif($12, '')::date,
        $13,$14,
        nullif($15, '')::date,
        $16,$17,$18,$19,$20,$21,$22,$23,
        nullif($24, '')::date,
        nullif($25, '')::date,
        $26,$27
      )
      on conflict (org_id, box_id) do update set
        warehouse = excluded.warehouse,
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        width_in = excluded.width_in,
        initial_feet = excluded.initial_feet,
        feet_available = excluded.feet_available,
        lot_run = excluded.lot_run,
        status = excluded.status,
        order_date = excluded.order_date,
        received_date = excluded.received_date,
        initial_weight_lbs = excluded.initial_weight_lbs,
        last_roll_weight_lbs = excluded.last_roll_weight_lbs,
        last_weighed_date = excluded.last_weighed_date,
        film_key = excluded.film_key,
        core_type = excluded.core_type,
        core_weight_lbs = excluded.core_weight_lbs,
        lf_weight_lbs_per_ft = excluded.lf_weight_lbs_per_ft,
        purchase_cost = excluded.purchase_cost,
        notes = excluded.notes,
        has_ever_been_checked_out = excluded.has_ever_been_checked_out,
        last_checkout_job = excluded.last_checkout_job,
        last_checkout_date = excluded.last_checkout_date,
        zeroed_date = excluded.zeroed_date,
        zeroed_reason = excluded.zeroed_reason,
        zeroed_by = excluded.zeroed_by
      returning *
    `,
    [
      orgId,
      box.boxId,
      box.warehouse,
      box.manufacturer,
      box.filmName,
      box.widthIn,
      box.initialFeet,
      box.feetAvailable,
      box.lotRun,
      box.status,
      box.orderDate,
      box.receivedDate,
      box.initialWeightLbs,
      box.lastRollWeightLbs,
      box.lastWeighedDate,
      box.filmKey,
      box.coreType,
      box.coreWeightLbs,
      box.lfWeightLbsPerFt,
      box.purchaseCost,
      box.notes,
      box.hasEverBeenCheckedOut,
      box.lastCheckoutJob,
      box.lastCheckoutDate,
      box.zeroedDate,
      box.zeroedReason,
      box.zeroedBy
    ]
  );

  return mapDbBoxRow(row);
}

async function deleteBoxRecord(client, orgId, boxId) {
  await client.query(
    `
      delete from app.boxes
      where org_id = $1
        and box_id = $2
    `,
    [orgId, boxId]
  );
}

async function listFilmCatalog(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
      order by manufacturer asc, film_name asc, film_key asc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmCatalogRow);
}

async function findFilmCatalogByFilmKey(client, orgId, filmKey) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
        and film_key = $2
    `,
    [orgId, filmKey]
  );

  return mapDbFilmCatalogRow(row);
}

async function upsertFilmCatalogRecord(client, orgId, record) {
  const row = await queryRow(
    client,
    `
      insert into app.film_catalog (
        org_id,
        film_key,
        manufacturer,
        film_name,
        sq_ft_weight_lbs_per_sq_ft,
        default_core_type,
        source_width_in,
        source_initial_feet,
        source_initial_weight_lbs,
        source_box_id,
        notes,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
      on conflict (org_id, film_key) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        sq_ft_weight_lbs_per_sq_ft = excluded.sq_ft_weight_lbs_per_sq_ft,
        default_core_type = excluded.default_core_type,
        source_width_in = excluded.source_width_in,
        source_initial_feet = excluded.source_initial_feet,
        source_initial_weight_lbs = excluded.source_initial_weight_lbs,
        source_box_id = excluded.source_box_id,
        notes = excluded.notes,
        updated_at = excluded.updated_at
      returning *
    `,
    [
      orgId,
      record.filmKey,
      record.manufacturer,
      record.filmName,
      record.sqFtWeightLbsPerSqFt,
      record.defaultCoreType,
      record.sourceWidthIn,
      record.sourceInitialFeet,
      record.sourceInitialWeightLbs,
      record.sourceBoxId,
      record.notes,
      record.updatedAt || new Date().toISOString()
    ]
  );

  return mapDbFilmCatalogRow(row);
}

async function listAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByBox(client, orgId, boxId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and box_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, boxId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and upper(job_number) = upper($2)
      order by created_at desc, allocation_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and status = 'ACTIVE'
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function saveAllocationRecord(client, orgId, entry) {
  const row = await queryRow(
    client,
    `
      insert into app.allocations (
        org_id,
        allocation_id,
        box_id,
        job_id,
        job_number,
        warehouse,
        job_date,
        allocated_feet,
        status,
        created_at,
        created_by,
        resolved_at,
        resolved_by,
        notes,
        crew_leader,
        film_order_id
      )
      values (
        $1,$2,$3,$4,$5,$6,
        nullif($7, '')::date,
        $8,$9,
        coalesce($10::timestamptz, now()),
        $11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16
      )
      on conflict (org_id, allocation_id) do update set
        box_id = excluded.box_id,
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        job_date = excluded.job_date,
        allocated_feet = excluded.allocated_feet,
        status = excluded.status,
        created_at = excluded.created_at,
        created_by = excluded.created_by,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        crew_leader = excluded.crew_leader,
        film_order_id = excluded.film_order_id
      returning *
    `,
    [
      orgId,
      entry.allocationId,
      entry.boxId,
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      entry.jobDate,
      entry.allocatedFeet,
      entry.status,
      entry.createdAt,
      entry.createdBy,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.crewLeader,
      entry.filmOrderId
    ]
  );

  return mapDbAllocationRow(row);
}

async function listFilmOrders(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
      order by created_at desc, film_order_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function listFilmOrdersByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and upper(job_number) = upper($2)
      order by created_at desc, film_order_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function findFilmOrderById(client, orgId, filmOrderId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );

  return mapDbFilmOrderRow(row);
}

async function saveFilmOrderRecord(client, orgId, entry) {
  const row = await queryRow(
    client,
    `
      insert into app.film_orders (
        org_id,
        film_order_id,
        job_id,
        job_number,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        requested_feet,
        covered_feet,
        ordered_feet,
        remaining_to_order_feet,
        job_date,
        crew_leader,
        status,
        source_box_id,
        resolved_at,
        resolved_by,
        notes,
        created_at,
        created_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        nullif($13, '')::date,
        $14,$15,$16,
        nullif($17, '')::timestamptz,
        $18,$19,
        coalesce($20::timestamptz, now()),
        $21
      )
      on conflict (org_id, film_order_id) do update set
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        width_in = excluded.width_in,
        requested_feet = excluded.requested_feet,
        covered_feet = excluded.covered_feet,
        ordered_feet = excluded.ordered_feet,
        remaining_to_order_feet = excluded.remaining_to_order_feet,
        job_date = excluded.job_date,
        crew_leader = excluded.crew_leader,
        status = excluded.status,
        source_box_id = excluded.source_box_id,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      entry.filmOrderId,
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      entry.manufacturer,
      entry.filmName,
      entry.widthIn,
      entry.requestedFeet,
      entry.coveredFeet,
      entry.orderedFeet,
      entry.remainingToOrderFeet,
      entry.jobDate,
      entry.crewLeader,
      entry.status,
      entry.sourceBoxId,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.createdAt,
      entry.createdBy
    ]
  );

  return mapDbFilmOrderRow(row);
}

async function deleteFilmOrderRecord(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

async function listFilmOrderLinks(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
      order by created_at desc, link_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByBoxId(client, orgId, boxId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, boxId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function saveFilmOrderLinkRecord(client, orgId, link) {
  const row = await queryRow(
    client,
    `
      insert into app.film_order_box_links (
        org_id,
        link_id,
        film_order_id,
        box_id,
        ordered_feet,
        auto_allocated_feet,
        created_at,
        created_by
      )
      values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8)
      on conflict (org_id, link_id) do update set
        film_order_id = excluded.film_order_id,
        box_id = excluded.box_id,
        ordered_feet = excluded.ordered_feet,
        auto_allocated_feet = excluded.auto_allocated_feet,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      link.linkId,
      link.filmOrderId,
      link.boxId,
      link.orderedFeet,
      link.autoAllocatedFeet,
      link.createdAt,
      link.createdBy
    ]
  );

  return mapDbFilmOrderLinkRow(row);
}

async function deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

async function listJobs(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
      order by due_date desc nulls last, updated_at desc, job_number desc
    `,
    [orgId]
  );

  return rows.map(mapDbJobRow);
}

async function findJobByNumber(client, orgId, jobNumber) {
  const row = await queryRow(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
        and job_number = $2
    `,
    [orgId, jobNumber]
  );

  return mapDbJobRow(row);
}

async function saveJobRecord(client, orgId, job) {
  const row = await queryRow(
    client,
    `
      insert into app.jobs (
        org_id,
        job_number,
        warehouse,
        sections,
        due_date,
        lifecycle_status,
        notes,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      values (
        $1,$2,$3,$4,
        nullif($5, '')::date,
        $6,$7,
        coalesce($8::timestamptz, now()),
        $9,
        coalesce($10::timestamptz, now()),
        $11
      )
      on conflict (org_id, job_number) do update set
        warehouse = excluded.warehouse,
        sections = excluded.sections,
        due_date = excluded.due_date,
        lifecycle_status = excluded.lifecycle_status,
        notes = excluded.notes,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      job.jobNumber,
      job.warehouse,
      job.sections,
      job.dueDate,
      job.lifecycleStatus,
      job.notes,
      job.createdAt,
      job.createdBy,
      job.updatedAt,
      job.updatedBy
    ]
  );

  return mapDbJobRow(row);
}

async function listJobRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select r.*, j.job_number
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
      order by j.job_number asc, r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId]
  );

  return rows.map(mapDbRequirementRow);
}

async function listJobRequirementsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select r.*, j.job_number
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
        and j.job_number = $2
      order by r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbRequirementRow);
}

async function replaceJobRequirementsForJob(client, orgId, jobHeader, entries) {
  await client.query(
    `
      delete from app.job_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobHeader.id]
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    await client.query(
      `
        insert into app.job_requirements (
          id,
          org_id,
          job_id,
          manufacturer,
          film_name,
          width_in,
          required_feet,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11::timestamptz,$12)
      `,
      [
        entry.id || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        entry.manufacturer,
        entry.filmName,
        entry.widthIn,
        entry.requiredFeet,
        entry.notes || '',
        entry.createdAt || new Date().toISOString(),
        entry.createdBy || '',
        entry.updatedAt || new Date().toISOString(),
        entry.updatedBy || ''
      ]
    );
  }
}

async function listAuditEntries(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
      order by created_at desc, log_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAuditRow);
}

async function listAuditEntriesByBox(client, orgId, boxId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and box_id = $2
      order by created_at desc, log_id desc
    `,
    [orgId, boxId]
  );

  return rows.map(mapDbAuditRow);
}

async function findAuditEntryByLogId(client, orgId, logId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and log_id = $2
    `,
    [orgId, logId]
  );

  return mapDbAuditRow(row);
}

async function appendAuditEntry(client, orgId, action, boxId, beforeState, afterState, actor, notes) {
  const logId = createLogId();
  await client.query(
    `
      insert into app.audit_log (
        org_id,
        log_id,
        action,
        box_id,
        before_state,
        after_state,
        actor,
        notes,
        created_at
      )
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::timestamptz)
    `,
    [
      orgId,
      logId,
      action,
      boxId,
      beforeState === null ? null : JSON.stringify(beforeState),
      afterState === null ? null : JSON.stringify(afterState),
      actor,
      asTrimmedString(notes),
      new Date().toISOString()
    ]
  );
  return logId;
}

async function listRollHistoryByBox(client, orgId, boxId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.roll_weight_log
      where org_id = $1
        and box_id = $2
      order by checked_in_at desc nulls last, created_at desc nulls last, log_id desc
    `,
    [orgId, boxId]
  );

  return rows.map(mapDbRollHistoryRow);
}

async function appendRollHistoryEntry(client, orgId, entry) {
  await client.query(
    `
      insert into app.roll_weight_log (
        org_id,
        log_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        job_number,
        checked_out_at,
        checked_out_by,
        checked_out_weight_lbs,
        checked_in_at,
        checked_in_by,
        checked_in_weight_lbs,
        weight_delta_lbs,
        feet_before,
        feet_after,
        notes,
        created_at
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,
        nullif($9, '')::timestamptz,
        $10,$11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16,$17,$18,now()
      )
    `,
    [
      orgId,
      entry.logId || createLogId(),
      entry.boxId,
      entry.warehouse,
      entry.manufacturer,
      entry.filmName,
      entry.widthIn,
      entry.jobNumber,
      entry.checkedOutAt,
      entry.checkedOutBy,
      entry.checkedOutWeightLbs,
      entry.checkedInAt,
      entry.checkedInBy,
      entry.checkedInWeightLbs,
      entry.weightDeltaLbs,
      entry.feetBefore,
      entry.feetAfter,
      entry.notes
    ]
  );
}

function buildActiveAllocationsByBoxIndex(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = [];
    }

    grouped[entry.boxId].push(entry);
  }

  return grouped;
}

function getActiveAllocationsForBox(boxId, activeAllocationsByBox) {
  return activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
}

function getActiveAllocatedFeetForBox(boxId, activeAllocationsByBox) {
  const entries = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  let total = 0;

  for (let index = 0; index < entries.length; index += 1) {
    total += entries[index].allocatedFeet;
  }

  return total;
}

function buildJobRequirementsByLookupKey(entries) {
  const byKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    byKey[normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn)] = entry;
  }

  return byKey;
}

function buildAllocationCoverageByRequirementKey(allocations, boxById) {
  const totals = {};

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.status === 'CANCELLED') {
      continue;
    }

    if (allocation.allocatedFeet <= 0) {
      continue;
    }

    const box = boxById[allocation.boxId];
    if (!box) {
      continue;
    }

    const key = normalizeJobRequirementLookupKey(box.manufacturer, box.filmName, box.widthIn);
    totals[key] = (totals[key] || 0) + allocation.allocatedFeet;
  }

  return totals;
}

function buildPublicJobRequirementEntries(requirements, allocations, boxById) {
  const coverage = buildAllocationCoverageByRequirementKey(allocations, boxById);
  const response = [];

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const key = normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    );
    const allocatedFeet = Math.max(0, Number(coverage[key] || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    const cappedAllocatedFeet = requiredFeet - remainingFeet;

    response.push({
      requirementId: requirement.id || createLogId(),
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      allocatedFeet: cappedAllocatedFeet,
      remainingFeet
    });
  }

  response.sort((left, right) => {
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

    return compareCatalogStrings(left.requirementId, right.requirementId);
  });

  return response;
}

function resolveAllocationJobMetadata(allocations, filmOrders) {
  let jobDate = '';
  let crewLeader = '';

  for (let index = 0; index < allocations.length; index += 1) {
    if (!jobDate && allocations[index].jobDate) {
      jobDate = allocations[index].jobDate;
    }

    if (!crewLeader && allocations[index].crewLeader) {
      crewLeader = allocations[index].crewLeader;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    if (!jobDate && filmOrders[index].jobDate) {
      jobDate = filmOrders[index].jobDate;
    }

    if (!crewLeader && filmOrders[index].crewLeader) {
      crewLeader = filmOrders[index].crewLeader;
    }
  }

  return { jobDate, crewLeader };
}

function buildAllocationJobSummary(jobNumber, allocations, filmOrders) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes = {};

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }

    if (allocation.status === 'ACTIVE') {
      hasActiveAllocation = true;
      activeAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'FULFILLED') {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (filmOrder.status === 'FILM_ORDER') {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FILM_ON_THE_WAY') {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FULFILLED') {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  let status = 'READY';
  if (hasFilmOrder) {
    status = 'FILM_ORDER';
  } else if (hasFilmOnTheWay) {
    status = 'ON_ORDER';
  } else if (hasActiveAllocation) {
    status = 'READY';
  } else if (hasCancelledRecord) {
    status = 'CANCELLED';
  } else if (hasFulfilledRecord) {
    status = 'COMPLETED';
  }

  return {
    jobNumber,
    jobDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length
  };
}

function buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let warehouse = '';
  let createdAt = '';
  let updatedAt = '';

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (!warehouse && allocation.warehouse) {
      warehouse = allocation.warehouse;
    }

    if (!createdAt || (allocation.createdAt && allocation.createdAt < createdAt)) {
      createdAt = allocation.createdAt || createdAt;
    }

    if (!updatedAt || (allocation.createdAt && allocation.createdAt > updatedAt)) {
      updatedAt = allocation.createdAt || updatedAt;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (!warehouse && filmOrder.warehouse) {
      warehouse = filmOrder.warehouse;
    }

    if (!createdAt || (filmOrder.createdAt && filmOrder.createdAt < createdAt)) {
      createdAt = filmOrder.createdAt || createdAt;
    }

    const filmUpdatedAt = filmOrder.resolvedAt || filmOrder.createdAt;
    if (!updatedAt || (filmUpdatedAt && filmUpdatedAt > updatedAt)) {
      updatedAt = filmUpdatedAt || updatedAt;
    }
  }

  return {
    id: '',
    orgId: '',
    jobNumber,
    warehouse: warehouse || 'IL',
    sections: null,
    dueDate: metadata.jobDate,
    lifecycleStatus: 'ACTIVE',
    notes: '',
    createdAt,
    createdBy: '',
    updatedAt,
    updatedBy: ''
  };
}

function deriveJobStatusFromLegacyAllocationData(allocations, filmOrders) {
  const legacySummary = buildAllocationJobSummary('', allocations || [], filmOrders || []);
  if (legacySummary.status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacySummary.status === 'READY' || legacySummary.status === 'COMPLETED') {
    return 'READY';
  }

  return 'ALLOCATE';
}

function computeJobStatusFromRequirements(lifecycleStatus, requirements, allocations, filmOrders) {
  if (normalizeJobLifecycleStatus(lifecycleStatus) === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (!requirements.length) {
    if (!allocations.length && !filmOrders.length) {
      return 'ALLOCATE';
    }

    return deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  }

  for (let index = 0; index < requirements.length; index += 1) {
    if (requirements[index].remainingFeet > 0) {
      return 'ALLOCATE';
    }
  }

  return 'READY';
}

function buildJobListEntry(jobHeader, requirements, allocations, filmOrders) {
  let dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = resolveAllocationJobMetadata(allocations, filmOrders).jobDate;
  }

  let requiredFeet = 0;
  let allocatedFeet = 0;
  let remainingFeet = 0;

  for (let index = 0; index < requirements.length; index += 1) {
    requiredFeet += requirements[index].requiredFeet;
    allocatedFeet += requirements[index].allocatedFeet;
    remainingFeet += requirements[index].remainingFeet;
  }

  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || 'IL',
    sections: jobHeader.sections,
    dueDate,
    status: computeJobStatusFromRequirements(
      jobHeader.lifecycleStatus,
      requirements,
      allocations,
      filmOrders
    ),
    lifecycleStatus: normalizeJobLifecycleStatus(jobHeader.lifecycleStatus),
    requiredFeet,
    allocatedFeet,
    remainingFeet,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    updatedAt: jobHeader.updatedAt || '',
    notes: jobHeader.notes || ''
  };
}

function buildPublicAllocationEntriesForJob(allocations, boxById) {
  return allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'ACTIVE' ? -1 : right.status === 'ACTIVE' ? 1 : left.status < right.status ? -1 : 1;
      }

      if (left.jobDate !== right.jobDate) {
        if (left.jobDate && right.jobDate) {
          return left.jobDate < right.jobDate ? -1 : 1;
        }

        if (left.jobDate) {
          return -1;
        }

        if (right.jobDate) {
          return 1;
        }
      }

      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    })
    .map((entry) => {
      const box = boxById[entry.boxId];
      return {
        ...toPublicAllocation(entry),
        manufacturer: box ? box.manufacturer : '',
        filmName: box ? box.filmName : '',
        widthIn: box ? box.widthIn : 0,
        boxStatus: box ? box.status : ''
      };
    });
}

async function buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  const response = [];

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const box = await findBoxById(client, orgId, link.boxId);
    if (!box) {
      continue;
    }

    response.push({
      boxId: link.boxId,
      orderedFeet: link.orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet
    });
  }

  response.sort((left, right) => (left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0));
  return response;
}

async function buildPublicFilmOrdersForJob(client, orgId, filmOrders) {
  const response = [];
  const sorted = filmOrders.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { jobDate: left.createdAt, jobNumber: left.filmOrderId },
      { jobDate: right.createdAt, jobNumber: right.filmOrderId }
    )
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const linkedBoxes = await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId);
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }

  return response;
}

async function resolveJobContext(client, orgId, jobNumber, jobDate, crewLeader) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const normalizedJobDate = normalizeDateString(jobDate, 'JobDate', true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingJobDate = '';
  let existingCrewLeader = '';

  for (let index = 0; index < existingAllocations.length; index += 1) {
    if (!existingJobDate && existingAllocations[index].jobDate) {
      existingJobDate = existingAllocations[index].jobDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (let index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingJobDate && existingFilmOrders[index].jobDate) {
      existingJobDate = existingFilmOrders[index].jobDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new HttpError(400, 'JobDate must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, 'CrewLeader must stay the same for an existing Job Number.');
  }

  const resolvedJobDate = normalizedJobDate || existingJobDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new HttpError(400, 'CrewLeader is required when JobDate is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox(boxId, jobContext, activeAllocationsByBox) {
  if (!jobContext.jobDate) {
    return [];
  }

  const active = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  const conflicts = [];
  const seen = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = active[index];
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobContext.jobNumber)
    ) {
      continue;
    }

    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizeCrewLeaderKey(jobContext.crewLeader)) {
      continue;
    }

    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

function buildAllocationPreviewPlan(sourceBox, requestedFeet, jobContext, options) {
  const requested = coerceFeetValue(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const useCrossWarehouse = options && options.crossWarehouse === true;
  const activeAllocationsByBox = (options && options.activeAllocationsByBox) || {};
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, activeAllocationsByBox);
  const sourceSuggestedFeet = sourceConflicts.length ? 0 : Math.min(sourceBox.feetAvailable, requested);
  let remaining = requested - sourceSuggestedFeet;
  const candidates = [];
  const candidateBoxes = useCrossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates = [];

  for (let index = 0; index < candidateBoxes.length; index += 1) {
    const candidate = candidateBoxes[index];
    if (
      candidate.boxId === sourceBox.boxId ||
      candidate.status !== 'IN_STOCK' ||
      candidate.feetAvailable <= 0 ||
      candidate.manufacturer !== sourceBox.manufacturer ||
      candidate.filmName !== sourceBox.filmName ||
      candidate.widthIn !== sourceBox.widthIn
    ) {
      continue;
    }

    filteredCandidates.push(candidate);
  }

  filteredCandidates.sort(compareBoxesByOldestStock);

  for (let index = 0; index < filteredCandidates.length; index += 1) {
    const candidate = filteredCandidates[index];
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }

    candidates.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      availableFeet: candidate.feetAvailable,
      suggestedFeet: remaining > 0 ? Math.min(candidate.feetAvailable, remaining) : 0,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate
    });

    if (remaining > 0) {
      remaining -= Math.min(candidate.feetAvailable, remaining);
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet,
    sourceConflicts,
    suggestions: candidates,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining
  };
}

function calculateSelectedSuggestionAllocations(plan, selectedBoxIds) {
  const selectedMap = {};
  const allocations = [];
  let remaining = plan.requestedFeet;

  if (plan.sourceSuggestedFeet > 0) {
    allocations.push({
      boxId: plan.sourceBoxId,
      allocatedFeet: plan.sourceSuggestedFeet
    });
    remaining -= plan.sourceSuggestedFeet;
  }

  for (let index = 0; index < selectedBoxIds.length; index += 1) {
    selectedMap[selectedBoxIds[index]] = true;
  }

  for (let index = 0; index < plan.suggestions.length; index += 1) {
    const suggestion = plan.suggestions[index];
    if (!selectedMap[suggestion.boxId] || remaining <= 0) {
      continue;
    }

    const allocatedFeet = Math.min(suggestion.availableFeet, remaining);
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations,
    remainingFeet: remaining
  };
}

function parseCrossWarehouseFlag(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeOptionalWarehouse(value, fieldName) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized !== 'IL' && normalized !== 'MS') {
    throw new HttpError(400, `${fieldName || 'Warehouse'} must be IL or MS.`);
  }

  return normalized;
}

async function getOrResolveJobId(client, orgId, jobNumber) {
  const header = await findJobByNumber(client, orgId, jobNumber);
  return header ? header.id : null;
}

async function createAllocationRecord(client, orgId, box, jobContext, allocatedFeet, user, filmOrderId) {
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);
  return saveAllocationRecord(client, orgId, {
    allocationId: createLogId(),
    boxId: box.boxId,
    warehouse: box.warehouse,
    jobId,
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    allocatedFeet,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString(filmOrderId)
  });
}

async function sumFilmOrderCoveredFeet(client, orgId, filmOrderId) {
  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    if (allocations[index].status !== 'CANCELLED') {
      total += allocations[index].allocatedFeet;
    }
  }

  return total;
}

async function sumFilmOrderOrderedFeet(client, orgId, filmOrderId) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < links.length; index += 1) {
    const box = await findBoxById(client, orgId, links[index].boxId);
    if (box) {
      total += links[index].orderedFeet;
    }
  }

  return total;
}

async function recalculateFilmOrder(client, orgId, filmOrderId, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return null;
  }

  const updated = cloneValue(existing);
  updated.coveredFeet = await sumFilmOrderCoveredFeet(client, orgId, filmOrderId);
  updated.orderedFeet = await sumFilmOrderOrderedFeet(client, orgId, filmOrderId);
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (updated.coveredFeet >= updated.requestedFeet) {
      updated.status = 'FULFILLED';
      if (!updated.resolvedAt) {
        updated.resolvedAt = new Date().toISOString();
        updated.resolvedBy = asTrimmedString(user);
      }
    } else if (updated.orderedFeet >= updated.requestedFeet) {
      updated.status = 'FILM_ON_THE_WAY';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    } else {
      updated.status = 'FILM_ORDER';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    }
  }

  return saveFilmOrderRecord(client, orgId, updated);
}

async function createFilmOrderForShortage(
  client,
  orgId,
  sourceBox,
  jobContext,
  requestedFeet,
  shortageFeet,
  user,
  shortageWarehouse
) {
  if (shortageFeet <= 0) {
    return null;
  }

  const resolvedWarehouse = asTrimmedString(shortageWarehouse).toUpperCase() || sourceBox.warehouse;
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);

  return saveFilmOrderRecord(client, orgId, {
    filmOrderId: createLogId(),
    jobId,
    jobNumber: jobContext.jobNumber,
    warehouse: resolvedWarehouse,
    manufacturer: sourceBox.manufacturer,
    filmName: sourceBox.filmName,
    widthIn: sourceBox.widthIn,
    requestedFeet: shortageFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: shortageFeet,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    status: 'FILM_ORDER',
    sourceBoxId: sourceBox.boxId,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: `Created from a shortage while trying to allocate ${requestedFeet} LF.`
  });
}

async function linkBoxToFilmOrder(client, orgId, filmOrderId, box, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  if (existing.status === 'CANCELLED') {
    throw new HttpError(400, 'Cancelled Film Orders cannot receive new boxes.');
  }

  await saveFilmOrderLinkRecord(client, orgId, {
    linkId: createLogId(),
    filmOrderId: existing.filmOrderId,
    boxId: box.boxId,
    orderedFeet: box.initialFeet,
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user)
  });

  return recalculateFilmOrder(client, orgId, existing.filmOrderId, user);
}

async function processLinkedFilmOrderReceipt(client, orgId, box, user, warnings) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, box.boxId);
  const recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
    return box;
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = cloneValue(links[index]);
    const filmOrder = await findFilmOrderById(client, orgId, link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    const remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    const linkCapacity = Math.max(link.orderedFeet - link.autoAllocatedFeet, 0);
    const allocationFeet = Math.min(remainingNeed, linkCapacity, box.feetAvailable);

    if (allocationFeet <= 0) {
      continue;
    }

    await createAllocationRecord(
      client,
      orgId,
      box,
      {
        jobNumber: filmOrder.jobNumber,
        jobDate: filmOrder.jobDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      user,
      filmOrder.filmOrderId
    );

    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    await saveFilmOrderLinkRecord(client, orgId, link);
    warnings.push(
      `${allocationFeet} LF from ${box.boxId} was automatically allocated to job ${filmOrder.jobNumber} for Film Order ${filmOrder.filmOrderId}.`
    );
    recalculatedOrders[filmOrder.filmOrderId] = true;
  }

  for (const filmOrderId of Object.keys(recalculatedOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return box;
}

async function cancelJobAndReleaseAllocations(client, orgId, jobNumber, user, reason) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const activeByBoxId = {};
  let activeCount = 0;
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const resolvedAt = new Date().toISOString();
  const note = asTrimmedString(reason) || 'Job cancelled.';

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || box.status === 'ZEROED' || box.status === 'RETIRED') {
      continue;
    }

    box.feetAvailable += activeByBoxId[boxId];
    await saveBoxRecord(client, orgId, box);
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = cloneValue(filmOrders[index]);
    if (order.status === 'CANCELLED') {
      continue;
    }

    order.status = 'CANCELLED';
    order.resolvedAt = resolvedAt;
    order.resolvedBy = asTrimmedString(user);
    order.notes = note;
    await saveFilmOrderRecord(client, orgId, order);
  }

  return {
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

async function cancelFilmOrderAndReleaseAllocations(client, orgId, filmOrderId, user, reason) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  const activeByBoxId = {};
  let activeCount = 0;
  const resolvedAt = new Date().toISOString();
  const note = asTrimmedString(reason) || 'Film order deleted.';

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || box.status === 'ZEROED' || box.status === 'RETIRED') {
      continue;
    }

    box.feetAvailable += activeByBoxId[boxId];
    await saveBoxRecord(client, orgId, box);
  }

  await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  await deleteFilmOrderRecord(client, orgId, filmOrderId);

  return {
    filmOrder: existing,
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

async function cancelActiveFilmOrderAllocationsForBox(client, orgId, boxId, user, reason) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const resolvedAt = new Date().toISOString();
  const affectedFilmOrders = {};
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status !== 'ACTIVE' || !entry.filmOrderId) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = asTrimmedString(reason) || 'Cancelled because linked box state was undone.';
    await saveAllocationRecord(client, orgId, entry);
    affectedFilmOrders[entry.filmOrderId] = true;
    count += 1;
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return count;
}

async function recalculateFilmOrdersForBoxLinks(client, orgId, boxId, user) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, boxId);
  const seen = {};

  for (let index = 0; index < links.length; index += 1) {
    if (!seen[links[index].filmOrderId]) {
      seen[links[index].filmOrderId] = true;
      await recalculateFilmOrder(client, orgId, links[index].filmOrderId, user);
    }
  }
}

async function resolveAllocationsForCheckout(client, orgId, boxId, jobNumber, user) {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const resolvedAt = new Date().toISOString();
  const result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  const otherJobs = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = cloneValue(active[index]);
    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
      entry.status = 'FULFILLED';
      entry.resolvedAt = resolvedAt;
      entry.resolvedBy = asTrimmedString(user);
      entry.notes = `Fulfilled by checkout for job ${jobNumber}.`;
      await saveAllocationRecord(client, orgId, entry);
      result.fulfilledCount += 1;
      result.fulfilledFeet += entry.allocatedFeet;
      continue;
    }

    if (entry.jobNumber && !otherJobs[entry.jobNumber]) {
      otherJobs[entry.jobNumber] = true;
      result.otherJobs.push(entry.jobNumber);
    }
  }

  return result;
}

async function cancelActiveAllocationsForBox(client, orgId, boxId, user, reason) {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const resolvedAt = new Date().toISOString();
  const trimmedReason = asTrimmedString(reason);
  const affectedFilmOrders = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = cloneValue(active[index]);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = trimmedReason || entry.notes;
    await saveAllocationRecord(client, orgId, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return active.length;
}

async function reactivateFulfilledAllocationsForUndo(client, orgId, boxId, jobNumber) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = `Fulfilled by checkout for job ${jobNumber}.`;
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (
      entry.status === 'FULFILLED' &&
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobNumber) &&
      entry.notes === expectedNote
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      count += 1;
    }
  }

  return count;
}

async function reactivateCancelledAllocationsForZeroUndo(client, orgId, boxId) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = 'Auto-cancelled because the box was moved to zeroed out inventory.';
  let count = 0;
  const affectedFilmOrders = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, '');
  }

  return count;
}

async function findLatestCheckoutAuditEntryByBoxId(client, orgId, boxId) {
  const entries = await listAuditEntriesByBox(client, orgId, boxId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.action !== 'SET_STATUS') {
      continue;
    }

    if (entry.after && entry.after.status === 'CHECKED_OUT') {
      return entry;
    }
  }

  return null;
}

function getCheckoutJobNumberFromAuditNotes(notes) {
  const text = asTrimmedString(notes);
  const match = text.match(/^Checked out for job\s+(.+)$/i);
  return match ? asTrimmedString(match[1]) : '';
}

function groupEntriesByJobNumber(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.jobNumber) {
      continue;
    }

    if (!grouped[entry.jobNumber]) {
      grouped[entry.jobNumber] = [];
    }

    grouped[entry.jobNumber].push(entry);
  }

  return grouped;
}

function buildRequirementRowsForReplace(jobNumber, requirementEntries, existingByKey, user, nowIso) {
  const rows = [];

  for (let index = 0; index < requirementEntries.length; index += 1) {
    const requirement = requirementEntries[index];
    const key = normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    );
    const existing = existingByKey[key] || null;

    rows.push({
      id: existing ? existing.id : '',
      jobNumber,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet: requirement.requiredFeet,
      createdAt: existing ? existing.createdAt : nowIso,
      createdBy: existing ? existing.createdBy : user,
      updatedAt: nowIso,
      updatedBy: user,
      notes: existing ? existing.notes : ''
    });
  }

  return rows;
}

async function buildBoxFromPayload(client, orgId, payload, warnings, existingBox) {
  const boxId = existingBox ? existingBox.boxId : requireString(payload.boxId, 'BoxID');
  const manufacturer = requireString(payload.manufacturer, 'Manufacturer');
  const filmName = requireString(payload.filmName, 'FilmName');
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const initialFeet = coerceFeetValue(payload.initialFeet, 'InitialFeet', warnings, false);
  const orderDate = normalizeDateString(payload.orderDate, 'OrderDate', false);
  const receivedDate = normalizeDateString(payload.receivedDate, 'ReceivedDate', true);
  const feetAvailableInput = asTrimmedString(payload.feetAvailable);
  const filmKey = asTrimmedString(payload.filmKey) || buildFilmKey(manufacturer, filmName);
  const initialWeightInput = coerceOptionalNonNegativeNumber(payload.initialWeightLbs, 'InitialWeightLbs');
  const lastRollWeightInput = coerceOptionalNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  const lastWeighedDateInput = normalizeDateString(payload.lastWeighedDate, 'LastWeighedDate', true);
  const coreTypeInput = normalizeCoreType(payload.coreType, true);
  const existingCoreType = existingBox ? normalizeCoreType(existingBox.coreType, true) : '';
  let feetAvailable;
  let resolvedInitialWeightLbs = initialWeightInput;
  let resolvedLastRollWeightLbs = lastRollWeightInput;
  let resolvedLastWeighedDate = lastWeighedDateInput;
  let resolvedCoreType = coreTypeInput || existingCoreType;
  let resolvedCoreWeightLbs = null;
  let resolvedLfWeightLbsPerFt = null;
  let shouldRefreshReceivingMetrics = false;

  if (!feetAvailableInput) {
    if (existingBox) {
      feetAvailable = existingBox.feetAvailable;
    } else {
      feetAvailable = deriveAddFeetAvailable(initialFeet, receivedDate);
    }
  } else {
    feetAvailable = coerceFeetValue(payload.feetAvailable, 'FeetAvailable', warnings, true);
  }

  if (existingBox && existingBox.receivedDate && !receivedDate) {
    throw new HttpError(400, 'ReceivedDate cannot be cleared after a box has been received.');
  }

  if (receivedDate) {
    if (widthIn <= 0) {
      throw new HttpError(400, 'WidthIn must be greater than zero for received boxes.');
    }

    if (initialFeet <= 0) {
      throw new HttpError(400, 'InitialFeet must be greater than zero for received boxes.');
    }

    shouldRefreshReceivingMetrics =
      !existingBox ||
      !existingBox.receivedDate ||
      existingBox.filmKey !== filmKey ||
      existingBox.widthIn !== widthIn ||
      existingBox.initialFeet !== initialFeet ||
      (coreTypeInput && coreTypeInput !== existingCoreType) ||
      initialWeightInput !== null;

    if (shouldRefreshReceivingMetrics) {
      const filmData = await findFilmCatalogByFilmKey(client, orgId, filmKey);
      const filmDataCoreType = filmData ? normalizeCoreType(filmData.defaultCoreType, true) : '';
      const effectiveCoreType = coreTypeInput || filmDataCoreType || existingCoreType;

      if (filmData && filmData.sqFtWeightLbsPerSqFt !== null) {
        if (!effectiveCoreType) {
          throw new HttpError(400, 'CoreType is required before this film can be received.');
        }

        const knownSqFtWeight = coerceNonNegativeNumber(
          filmData.sqFtWeightLbsPerSqFt,
          'SqFtWeightLbsPerSqFt'
        );
        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);

        if (initialWeightInput !== null) {
          const inputSqFtWeight = deriveSqFtWeightLbsPerSqFt(
            initialWeightInput,
            resolvedCoreWeightLbs,
            widthIn,
            initialFeet
          );
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(inputSqFtWeight, widthIn);
          resolvedInitialWeightLbs = roundToDecimals(initialWeightInput, 2);
        } else {
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(knownSqFtWeight, widthIn);
          resolvedInitialWeightLbs = deriveInitialWeightLbs(
            resolvedLfWeightLbsPerFt,
            initialFeet,
            resolvedCoreWeightLbs
          );
        }

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate =
            existingBox && existingBox.lastWeighedDate ? existingBox.lastWeighedDate : receivedDate;
        }

        if ((!existingBox || !existingBox.receivedDate) && initialWeightInput === null) {
          warnings.push('Initial and last roll weights were auto-filled from FILM DATA.');
        }

        if (!filmDataCoreType || filmDataCoreType !== effectiveCoreType) {
          await upsertFilmCatalogRecord(client, orgId, {
            filmKey,
            manufacturer: filmData.manufacturer || manufacturer,
            filmName: filmData.filmName || filmName,
            sqFtWeightLbsPerSqFt: knownSqFtWeight,
            defaultCoreType: effectiveCoreType,
            sourceWidthIn: filmData.sourceWidthIn,
            sourceInitialFeet: filmData.sourceInitialFeet,
            sourceInitialWeightLbs: filmData.sourceInitialWeightLbs,
            updatedAt: new Date().toISOString(),
            sourceBoxId: filmData.sourceBoxId || boxId,
            notes: filmData.notes
          });
          warnings.push('FILM DATA was updated with the selected core type.');
        }
      } else {
        if (!effectiveCoreType) {
          throw new HttpError(400, 'CoreType is required the first time a received film is saved.');
        }

        const seedInitialWeight =
          initialWeightInput !== null
            ? initialWeightInput
            : existingBox && existingBox.initialWeightLbs !== null
              ? existingBox.initialWeightLbs
              : null;

        if (seedInitialWeight === null) {
          throw new HttpError(400, 'InitialWeightLbs is required the first time a received film is saved.');
        }

        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);
        const derivedSqFtWeight = deriveSqFtWeightLbsPerSqFt(
          seedInitialWeight,
          resolvedCoreWeightLbs,
          widthIn,
          initialFeet
        );
        resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(derivedSqFtWeight, widthIn);
        resolvedInitialWeightLbs = roundToDecimals(seedInitialWeight, 2);

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate = receivedDate;
        }

        await upsertFilmCatalogRecord(client, orgId, {
          filmKey,
          manufacturer,
          filmName,
          sqFtWeightLbsPerSqFt: derivedSqFtWeight,
          defaultCoreType: effectiveCoreType,
          sourceWidthIn: widthIn,
          sourceInitialFeet: initialFeet,
          sourceInitialWeightLbs: resolvedInitialWeightLbs,
          updatedAt: new Date().toISOString(),
          sourceBoxId: boxId,
          notes: ''
        });
        warnings.push(`FILM DATA was created from the first received weight for ${filmKey}.`);
      }
    } else {
      resolvedInitialWeightLbs = existingBox ? existingBox.initialWeightLbs : resolvedInitialWeightLbs;
      resolvedCoreType = coreTypeInput || existingCoreType;
      resolvedCoreWeightLbs = existingBox ? existingBox.coreWeightLbs : null;
      resolvedLfWeightLbsPerFt = existingBox ? existingBox.lfWeightLbsPerFt : null;
      resolvedLastRollWeightLbs =
        resolvedLastRollWeightLbs !== null
          ? resolvedLastRollWeightLbs
          : existingBox
            ? existingBox.lastRollWeightLbs
            : resolvedInitialWeightLbs;
      resolvedLastWeighedDate =
        resolvedLastWeighedDate || (existingBox ? existingBox.lastWeighedDate : receivedDate);
    }
  } else {
    resolvedInitialWeightLbs = null;
    resolvedLastRollWeightLbs = null;
    resolvedLastWeighedDate = '';
    resolvedCoreType = '';
    resolvedCoreWeightLbs = null;
    resolvedLfWeightLbsPerFt = null;
  }

  if (receivedDate) {
    if (resolvedLastRollWeightLbs === null) {
      throw new HttpError(
        400,
        'LastRollWeightLbs is required for received boxes because FeetAvailable is derived from roll weight.'
      );
    }

    if (
      resolvedCoreWeightLbs === null ||
      resolvedLfWeightLbsPerFt === null ||
      resolvedLfWeightLbsPerFt <= 0
    ) {
      throw new HttpError(
        400,
        'CoreWeightLbs and LfWeightLbsPerFt must be set for received boxes because FeetAvailable is derived from roll weight.'
      );
    }

    const physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
      resolvedLastRollWeightLbs,
      resolvedCoreWeightLbs,
      resolvedLfWeightLbsPerFt,
      initialFeet
    );
    let activeAllocatedFeet = 0;

    if (existingBox) {
      const existingAllocations = await listAllocationsByBox(client, orgId, boxId);
      for (let index = 0; index < existingAllocations.length; index += 1) {
        if (existingAllocations[index].status === 'ACTIVE') {
          activeAllocatedFeet += existingAllocations[index].allocatedFeet;
        }
      }
    }

    const recalculatedFeetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeet, 0);
    if (feetAvailable !== recalculatedFeetAvailable) {
      feetAvailable = recalculatedFeetAvailable;
      warnings.push('FeetAvailable was recalculated from Last Roll Weight and weight metadata.');
    }
  }

  return {
    boxId,
    warehouse: determineWarehouseFromBoxId(boxId),
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    feetAvailable,
    lotRun: asTrimmedString(payload.lotRun),
    status:
      existingBox &&
      (existingBox.status === 'CHECKED_OUT' ||
        existingBox.status === 'ZEROED' ||
        existingBox.status === 'RETIRED')
        ? existingBox.status
        : deriveLifecycleStatus(receivedDate),
    orderDate,
    receivedDate,
    initialWeightLbs: resolvedInitialWeightLbs,
    lastRollWeightLbs: resolvedLastRollWeightLbs,
    lastWeighedDate: resolvedLastWeighedDate,
    filmKey,
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    purchaseCost: coerceOptionalNonNegativeNumber(payload.purchaseCost, 'PurchaseCost'),
    notes: asTrimmedString(payload.notes),
    hasEverBeenCheckedOut: existingBox ? existingBox.hasEverBeenCheckedOut === true : false,
    lastCheckoutJob: existingBox ? existingBox.lastCheckoutJob : '',
    lastCheckoutDate: existingBox ? existingBox.lastCheckoutDate : '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

async function buildSearchBoxes(client, orgId, params) {
  const warehouse = requireString(params.warehouse, 'warehouse').toUpperCase();
  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new HttpError(400, 'warehouse must be IL or MS.');
  }

  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === 'true';
  const boxes = (await listBoxes(client, orgId)).filter((box) => box.warehouse === warehouse);
  let filtered = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query) {
      const haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
        .join(' ')
        .toLowerCase();

      if (haystack.indexOf(query) === -1) {
        continue;
      }
    }

    filtered.push(toPublicBox(box));
  }

  if (film) {
    const lowStock = [];
    const remaining = [];

    for (let index = 0; index < filtered.length; index += 1) {
      if (isLowStockBox(filtered[index])) {
        lowStock.push(filtered[index]);
      } else {
        remaining.push(filtered[index]);
      }
    }

    lowStock.sort((left, right) => {
      if (left.feetAvailable !== right.feetAvailable) {
        return left.feetAvailable - right.feetAvailable;
      }

      return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
    });

    filtered = lowStock.concat(remaining);
  }

  return filtered;
}

async function buildAllocationJobList(client, orgId) {
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const jobNumbers = {};
  const response = [];

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      jobNumbers[allAllocations[index].jobNumber] = true;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      jobNumbers[allFilmOrders[index].jobNumber] = true;
    }
  }

  const keys = Object.keys(jobNumbers);
  for (let index = 0; index < keys.length; index += 1) {
    const jobNumber = keys[index];
    response.push(
      buildAllocationJobSummary(
        jobNumber,
        groupedAllocations[jobNumber] || [],
        groupedFilmOrders[jobNumber] || []
      )
    );
  }

  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);

  if (!allocations.length && !filmOrders.length) {
    throw new HttpError(404, 'Job not found.');
  }

  const boxById = {};
  const boxes = await listBoxes(client, orgId);
  for (let index = 0; index < boxes.length; index += 1) {
    boxById[boxes[index].boxId] = boxes[index];
  }

  return {
    summary: buildAllocationJobSummary(normalizedJobNumber, allocations, filmOrders),
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders)
  };
}

async function buildJobsList(client, orgId, limit) {
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const groupedRequirements = groupEntriesByJobNumber(allRequirements);
  const byJobNumber = {};
  const boxById = {};
  const response = [];

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  for (let index = 0; index < jobs.length; index += 1) {
    byJobNumber[jobs[index].jobNumber] = jobs[index];
  }

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      byJobNumber[allAllocations[index].jobNumber] =
        byJobNumber[allAllocations[index].jobNumber] || null;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      byJobNumber[allFilmOrders[index].jobNumber] =
        byJobNumber[allFilmOrders[index].jobNumber] || null;
    }
  }

  const jobNumbers = Object.keys(byJobNumber);
  for (let index = 0; index < jobNumbers.length; index += 1) {
    const jobNumber = jobNumbers[index];
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById
    );
    const header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);

    response.push(buildJobListEntry(header, requirements, allocations, filmOrders));
  }

  response.sort(compareJobsListEntries);

  if (limit > 0 && response.length > limit) {
    return response.slice(0, limit);
  }

  return response;
}

async function buildJobDetail(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  let header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);

  if (!header && !allocations.length && !filmOrders.length && !requirements.length) {
    throw new HttpError(404, 'Job not found.');
  }

  if (!header) {
    header = buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders);
  }

  const boxById = {};
  const boxes = await listBoxes(client, orgId);
  for (let index = 0; index < boxes.length; index += 1) {
    boxById[boxes[index].boxId] = boxes[index];
  }

  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders),
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders)
  };
}

async function ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, user, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return existing;
  }

  const legacyAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const legacyFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const derived = buildLegacyJobHeaderFromData(jobNumber, legacyAllocations, legacyFilmOrders);

  derived.warehouse = payload.warehouse ? normalizeJobWarehouse(payload.warehouse) : derived.warehouse;
  derived.sections = normalizeJobSections(payload.sections);
  derived.dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  derived.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || user;
  derived.updatedAt = nowIso;
  derived.updatedBy = user;
  derived.notes = asTrimmedString(payload.notes || derived.notes);

  return saveJobRecord(client, orgId, derived);
}

function boxMatchesReportFilters(box, filters) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }

  if (
    filters.manufacturer &&
    box.manufacturer.toLowerCase().indexOf(filters.manufacturer.toLowerCase()) === -1
  ) {
    return false;
  }

  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }

  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

async function buildReportsSummary(client, orgId, params) {
  const filters = {
    warehouse: asTrimmedString(params.warehouse).toUpperCase(),
    manufacturer: asTrimmedString(params.manufacturer),
    film: asTrimmedString(params.film),
    width: asTrimmedString(params.width),
    from: asTrimmedString(params.from),
    to: asTrimmedString(params.to)
  };
  const allBoxes = await listBoxes(client, orgId);
  const activeBoxes = allBoxes.filter((box) => box.status !== 'ZEROED' && box.status !== 'RETIRED');
  const widthGroups = {};
  const availableFeetByWidth = [];
  const neverCheckedOut = [];
  const zeroedByMonthMap = {};
  const zeroedByMonth = [];

  for (let index = 0; index < activeBoxes.length; index += 1) {
    const activeBox = activeBoxes[index];
    if (!boxMatchesReportFilters(activeBox, filters)) {
      continue;
    }

    const widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0
      };
    }

    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (const widthGroupKey of Object.keys(widthGroups)) {
    availableFeetByWidth.push(widthGroups[widthGroupKey]);
  }

  availableFeetByWidth.sort((left, right) => left.widthIn - right.widthIn);

  for (let index = 0; index < allBoxes.length; index += 1) {
    const box = allBoxes[index];
    if (!boxMatchesReportFilters(box, filters)) {
      continue;
    }

    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }

      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }

      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable
      });
    }

    if (box.status === 'ZEROED' && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }

      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }

      const monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort((left, right) => {
    if (left.receivedDate !== right.receivedDate) {
      return left.receivedDate < right.receivedDate ? -1 : 1;
    }

    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  for (const month of Object.keys(zeroedByMonthMap)) {
    zeroedByMonth.push({
      month,
      zeroedCount: zeroedByMonthMap[month]
    });
  }

  zeroedByMonth.sort((left, right) => (left.month < right.month ? -1 : left.month > right.month ? 1 : 0));

  return {
    availableFeetByWidth,
    neverCheckedOut,
    zeroedByMonth
  };
}

async function addBox(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');

  if (await findBoxById(client, orgId, boxId)) {
    throw new HttpError(400, 'A box with this BoxID already exists.');
  }

  let box = await buildBoxFromPayload(client, orgId, payload, warnings, null);
  applyAddOrEditWarnings(warnings, null, box);
  box = await saveBoxRecord(client, orgId, box);

  if (asTrimmedString(payload.filmOrderId)) {
    const linkedOrder = await linkBoxToFilmOrder(client, orgId, payload.filmOrderId, box, actor);
    warnings.push(
      `Box ${box.boxId} was linked to Film Order ${linkedOrder.filmOrderId} for job ${linkedOrder.jobNumber}.`
    );

    if (box.receivedDate && box.status === 'IN_STOCK') {
      box = await processLinkedFilmOrderReceipt(client, orgId, cloneValue(box), actor, warnings);
      box = await saveBoxRecord(client, orgId, box);
    }
  }

  const publicBox = toPublicBox(box);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'ADD_BOX',
    box.boxId,
    null,
    publicBox,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicBox, logId }, warnings);
}

async function updateBox(client, orgId, payload, actor) {
  const warnings = [];
  const requestedMoveToZeroed = payload.moveToZeroed === true || String(payload.moveToZeroed) === 'true';
  const existing = await findBoxById(client, orgId, payload.boxId);

  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot be edited directly. Use audit undo instead.');
  }

  let updatedBox = await buildBoxFromPayload(client, orgId, payload, warnings, existing);
  if (
    existing.status !== 'CHECKED_OUT' &&
    existing.status !== 'RETIRED' &&
    deriveLifecycleStatus(existing.receivedDate) === 'ORDERED' &&
    updatedBox.status === 'IN_STOCK'
  ) {
    updatedBox.feetAvailable = updatedBox.initialFeet;
  }

  applyAddOrEditWarnings(warnings, existing, updatedBox);

  let auditAction = 'UPDATE_BOX';
  const autoMoveToZeroed = shouldAutoMoveToZeroed(existing, updatedBox);
  const moveToZeroed = requestedMoveToZeroed || autoMoveToZeroed;
  const reachedZeroState =
    Boolean(updatedBox.receivedDate) &&
    (updatedBox.feetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

  if (moveToZeroed) {
    if (!autoMoveToZeroed) {
      throw new HttpError(
        400,
        'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
      );
    }

    stampZeroedMetadata(updatedBox, actor, payload.auditNote);
    const cancelledAllocationCount = await cancelActiveAllocationsForBox(
      client,
      orgId,
      updatedBox.boxId,
      actor,
      'Auto-cancelled because the box was moved to zeroed out inventory.'
    );
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    auditAction = 'ZERO_OUT_BOX';

    if (autoMoveToZeroed && !requestedMoveToZeroed) {
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );
    }

    if (cancelledAllocationCount > 0) {
      warnings.push(
        `${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
      );
    }
  } else {
    if (reachedZeroState && !hasPositivePhysicalFeet(existing)) {
      warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
    }

    updatedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  }

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

async function setBoxStatus(client, orgId, payload, actor) {
  const warnings = [];
  const status = assertBoxStatus(payload.status);

  if (status === 'ORDERED') {
    throw new HttpError(400, 'ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new HttpError(400, 'RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new HttpError(400, 'ZEROED status is assigned automatically when a received box reaches 0.');
  }

  const existing = await findBoxById(client, orgId, payload.boxId);
  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }

  if (deriveLifecycleStatus(existing.receivedDate) === 'ORDERED') {
    throw new HttpError(400, 'Add a ReceivedDate on or before today before changing status.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot change status directly. Use audit undo instead.');
  }

  if (existing.status === 'RETIRED') {
    throw new HttpError(400, 'Retired boxes cannot change status directly. Use audit undo instead.');
  }

  let updatedBox = cloneValue(existing);
  let auditAction = 'SET_STATUS';

  if (status === 'CHECKED_OUT') {
    const jobNumber = getCheckoutJobNumberFromAuditNotes(payload.auditNote);
    if (!jobNumber) {
      throw new HttpError(400, 'A checkout job number is required.');
    }

    updatedBox.status = 'CHECKED_OUT';
    updatedBox.hasEverBeenCheckedOut = true;
    updatedBox.lastCheckoutJob = jobNumber;
    updatedBox.lastCheckoutDate = todayDateString();
    updatedBox.zeroedDate = '';
    updatedBox.zeroedReason = '';
    updatedBox.zeroedBy = '';
    applyCheckoutWarnings(warnings, existing);

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      updatedBox.boxId,
      jobNumber,
      actor
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Fulfilled ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF for job ${jobNumber}.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  } else {
    updatedBox.status = 'IN_STOCK';
    updatedBox.lastRollWeightLbs = coerceNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
    updatedBox.lastWeighedDate = todayDateString();
    let physicalFeetAvailable = updatedBox.feetAvailable;

    if (
      updatedBox.coreWeightLbs !== null &&
      updatedBox.lfWeightLbsPerFt !== null &&
      updatedBox.lfWeightLbsPerFt > 0
    ) {
      physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
        updatedBox.lastRollWeightLbs,
        updatedBox.coreWeightLbs,
        updatedBox.lfWeightLbsPerFt,
        updatedBox.initialFeet
      );
    } else {
      warnings.push(
        'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
      );
    }

    const existingAllocations = await listAllocationsByBox(client, orgId, updatedBox.boxId);
    let activeAllocatedFeetAfterCheckIn = 0;
    for (let index = 0; index < existingAllocations.length; index += 1) {
      if (existingAllocations[index].status === 'ACTIVE') {
        activeAllocatedFeetAfterCheckIn += existingAllocations[index].allocatedFeet;
      }
    }

    updatedBox.feetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeetAfterCheckIn, 0);
    const willAutoZero =
      Boolean(updatedBox.receivedDate) &&
      existing.initialFeet > 0 &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

    applyCheckInWarnings(warnings, existing, updatedBox, willAutoZero);
    if (activeAllocatedFeetAfterCheckIn > physicalFeetAvailable) {
      warnings.push(
        'This box now has more LF allocated to future jobs than the weight-based remaining feet.'
      );
    } else if (activeAllocatedFeetAfterCheckIn > 0 && updatedBox.feetAvailable === 0) {
      warnings.push('All remaining LF on this box is reserved by active allocations.');
    }

    const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, updatedBox.boxId);
    let checkoutJob = asTrimmedString(existing.lastCheckoutJob);
    let checkoutDate = asTrimmedString(existing.lastCheckoutDate);
    let checkoutUser = '';

    if (checkoutAudit) {
      if (!checkoutJob) {
        checkoutJob = getCheckoutJobNumberFromAuditNotes(checkoutAudit.notes);
      }

      if (!checkoutDate) {
        checkoutDate = asTrimmedString(checkoutAudit.date);
      }

      checkoutUser = asTrimmedString(checkoutAudit.user);
    }

    if (!checkoutJob) {
      checkoutJob = 'UNKNOWN';
      warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
    }

    if (!checkoutDate) {
      checkoutDate = todayDateString();
    }

    const checkedOutWeight = existing.lastRollWeightLbs;
    const weightDelta =
      checkedOutWeight === null ? null : roundToDecimals(checkedOutWeight - updatedBox.lastRollWeightLbs, 2);

    if (checkedOutWeight === null) {
      warnings.push(
        'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
      );
    }

    await appendRollHistoryEntry(client, orgId, {
      logId: '',
      boxId: updatedBox.boxId,
      warehouse: updatedBox.warehouse,
      manufacturer: updatedBox.manufacturer,
      filmName: updatedBox.filmName,
      widthIn: updatedBox.widthIn,
      jobNumber: checkoutJob,
      checkedOutAt: checkoutDate,
      checkedOutBy: checkoutUser,
      checkedOutWeightLbs: checkedOutWeight,
      checkedInAt: new Date().toISOString(),
      checkedInBy: actor,
      checkedInWeightLbs: updatedBox.lastRollWeightLbs,
      weightDeltaLbs: weightDelta,
      feetBefore: existing.feetAvailable,
      feetAfter: updatedBox.feetAvailable,
      notes: asTrimmedString(payload.auditNote)
    });

    updatedBox.lastCheckoutJob = '';
    updatedBox.lastCheckoutDate = '';

    const reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);
    const autoMoveToZeroed = willAutoZero;

    if (autoMoveToZeroed) {
      stampZeroedMetadata(updatedBox, actor, payload.auditNote);
      const cancelledAllocationCount = await cancelActiveAllocationsForBox(
        client,
        orgId,
        updatedBox.boxId,
        actor,
        'Auto-cancelled because the box was moved to zeroed out inventory.'
      );
      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
      auditAction = 'ZERO_OUT_BOX';
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );

      if (cancelledAllocationCount > 0) {
        warnings.push(
          `${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
        );
      }
    } else {
      if (reachedZeroState && existing.feetAvailable <= 0) {
        warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
      }

      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    }
  }

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

async function createJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const warehouse = normalizeJobWarehouse(payload.warehouse);
  const sections = normalizeJobSections(payload.sections);
  const dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  const lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  const notes = asTrimmedString(payload.notes);
  const incomingRequirements = dedupeJobRequirements(payload.requirements, warnings);
  const nowIso = new Date().toISOString();
  const existingHeader = await findJobByNumber(client, orgId, jobNumber);
  let nextHeader =
    existingHeader ||
    {
      id: '',
      orgId,
      jobNumber,
      warehouse,
      sections,
      dueDate,
      lifecycleStatus,
      notes,
      createdAt: nowIso,
      createdBy: actor,
      updatedAt: nowIso,
      updatedBy: actor
    };

  if (existingHeader) {
    nextHeader = {
      ...cloneValue(existingHeader),
      warehouse,
      sections,
      dueDate,
      lifecycleStatus,
      updatedAt: nowIso,
      updatedBy: actor,
      notes
    };
  }

  nextHeader = await saveJobRecord(client, orgId, nextHeader);

  const existingRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const merged = {};

  for (let index = 0; index < existingRequirements.length; index += 1) {
    const existing = existingRequirements[index];
    const existingKey = normalizeJobRequirementLookupKey(
      existing.manufacturer,
      existing.filmName,
      existing.widthIn
    );
    merged[existingKey] = {
      manufacturer: existing.manufacturer,
      filmName: existing.filmName,
      widthIn: existing.widthIn,
      requiredFeet: existing.requiredFeet
    };
  }

  for (let index = 0; index < incomingRequirements.length; index += 1) {
    const incoming = incomingRequirements[index];
    const incomingKey = normalizeJobRequirementLookupKey(
      incoming.manufacturer,
      incoming.filmName,
      incoming.widthIn
    );

    if (!merged[incomingKey]) {
      merged[incomingKey] = incoming;
      continue;
    }

    merged[incomingKey].requiredFeet += incoming.requiredFeet;
  }

  const mergedValues = Object.values(merged);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    nextHeader,
    buildRequirementRowsForReplace(jobNumber, mergedValues, existingByKey, actor, nowIso)
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function updateJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const requirements = dedupeJobRequirements(payload.requirements, warnings);
  const nowIso = new Date().toISOString();
  const header = await ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, actor, nowIso);
  const nextHeader = cloneValue(header);

  if (payload.warehouse !== undefined) {
    nextHeader.warehouse = normalizeJobWarehouse(payload.warehouse);
  }

  if (payload.sections !== undefined) {
    nextHeader.sections = normalizeJobSections(payload.sections);
  }

  if (payload.dueDate !== undefined) {
    nextHeader.dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  }

  if (payload.lifecycleStatus !== undefined) {
    nextHeader.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  }

  if (payload.notes !== undefined) {
    nextHeader.notes = asTrimmedString(payload.notes);
  }

  nextHeader.updatedAt = nowIso;
  nextHeader.updatedBy = actor;

  const savedHeader = await saveJobRecord(client, orgId, nextHeader);
  const existingRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    savedHeader,
    buildRequirementRowsForReplace(jobNumber, requirements, existingByKey, actor, nowIso)
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function createFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const warehouse = requireString(payload.warehouse, 'Warehouse').toUpperCase();
  const jobNumber = requireString(payload.jobNumber, 'JobNumber');
  const manufacturer = requireString(payload.manufacturer, 'Manufacturer');
  const filmName = requireString(payload.filmName, 'FilmName');
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const requestedFeet = coerceFeetValue(payload.requestedFeet, 'RequestedFeet', warnings, false);

  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new HttpError(400, 'Warehouse must be IL or MS.');
  }

  if (widthIn <= 0) {
    throw new HttpError(400, 'WidthIn must be greater than zero.');
  }

  if (requestedFeet <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const jobId = await getOrResolveJobId(client, orgId, jobNumber);
  const entry = await saveFilmOrderRecord(client, orgId, {
    filmOrderId: '',
    jobId,
    jobNumber,
    warehouse,
    manufacturer,
    filmName,
    widthIn,
    requestedFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: requestedFeet,
    jobDate: '',
    crewLeader: '',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(actor),
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Created manually from Film Orders.'
  });

  return ok(toPublicFilmOrder(entry, []), warnings);
}

async function cancelJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = requireString(payload.jobNumber, 'JobNumber');
  const result = await cancelJobAndReleaseAllocations(client, orgId, jobNumber, actor, payload.reason);
  const existingJob = await findJobByNumber(client, orgId, jobNumber);

  if (existingJob) {
    existingJob.lifecycleStatus = 'CANCELLED';
    existingJob.updatedAt = new Date().toISOString();
    existingJob.updatedBy = actor;
    await saveJobRecord(client, orgId, existingJob);
  }

  warnings.push(
    `Cancelled job ${jobNumber}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'}.`
  );

  return ok({ jobNumber }, warnings);
}

async function deleteFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const filmOrderId = requireString(payload.filmOrderId, 'FilmOrderID');
  const result = await cancelFilmOrderAndReleaseAllocations(
    client,
    orgId,
    filmOrderId,
    actor,
    payload.reason || 'Deleted from Film Orders.'
  );

  warnings.push(
    `Deleted film order ${filmOrderId}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'}.`
  );

  return ok(toPublicFilmOrder(result.filmOrder, []), warnings);
}

async function deleteBox(client, orgId, payload, actor) {
  const boxId = requireString(payload.boxId, 'BoxID');
  const reason = asTrimmedString(payload.reason) || 'Deleted from box details.';
  const current = await findBoxById(client, orgId, boxId);

  if (!current) {
    throw new HttpError(404, 'Box not found.');
  }

  if (current.status === 'CHECKED_OUT') {
    throw new HttpError(
      400,
      'Checked-out boxes cannot be deleted. Check the box in or zero it out first.'
    );
  }

  const activeAllocationRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.allocations
      where org_id = $1
        and box_id = $2
        and status = 'ACTIVE'
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(activeAllocationRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes with active allocations cannot be deleted. Resolve the allocations first.'
    );
  }

  const linkedFilmOrderRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(linkedFilmOrderRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes linked to film orders cannot be deleted. Resolve the linked film order first.'
    );
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'DELETE_BOX',
    current.boxId,
    toPublicBox(current),
    null,
    actor,
    reason
  );

  return ok({ boxId: current.boxId, logId });
}

async function previewAllocationPlan(client, orgId, payload) {
  const source = await findBoxById(client, orgId, payload.boxId);
  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (source.status !== 'IN_STOCK') {
    throw new HttpError(400, 'Only in-stock boxes can be allocated.');
  }

  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const allBoxes = await listBoxes(client, orgId);
  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );

  return buildAllocationPreviewPlan(source, payload.requestedFeet, jobContext, {
    crossWarehouse,
    allBoxes,
    activeAllocationsByBox
  });
}

async function applyAllocationPlan(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');
  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const source = await findBoxById(client, orgId, boxId);

  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (source.status !== 'IN_STOCK') {
    throw new HttpError(400, 'Only in-stock boxes can be allocated.');
  }

  const allBoxes = await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = cloneValue(allBoxes[index]);
  }

  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );
  const plan = buildAllocationPreviewPlan(source, payload.requestedFeet, jobContext, {
    crossWarehouse,
    allBoxes,
    activeAllocationsByBox
  });
  const selectedSuggestionBoxIds = Array.isArray(payload.selectedSuggestionBoxIds)
    ? payload.selectedSuggestionBoxIds.map((value) => asTrimmedString(value))
    : plan.suggestions.map((suggestion) => suggestion.boxId);
  const selection = calculateSelectedSuggestionAllocations(plan, selectedSuggestionBoxIds);
  const createdAllocations = [];

  for (let index = 0; index < selection.allocations.length; index += 1) {
    const plannedAllocation = selection.allocations[index];
    if (plannedAllocation.allocatedFeet <= 0) {
      continue;
    }

    const currentBox = boxById[plannedAllocation.boxId] || (await findBoxById(client, orgId, plannedAllocation.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedAllocation.boxId}`);
    }

    if (currentBox.status !== 'IN_STOCK') {
      throw new HttpError(400, `Box ${currentBox.boxId} is no longer in stock.`);
    }

    if (currentBox.feetAvailable < plannedAllocation.allocatedFeet) {
      throw new HttpError(400, `Box ${currentBox.boxId} no longer has enough available LF.`);
    }

    const allocation = await createAllocationRecord(
      client,
      orgId,
      currentBox,
      jobContext,
      plannedAllocation.allocatedFeet,
      actor,
      ''
    );
    currentBox.feetAvailable = Math.max(currentBox.feetAvailable - plannedAllocation.allocatedFeet, 0);
    boxById[currentBox.boxId] = await saveBoxRecord(client, orgId, currentBox);
    createdAllocations.push(toPublicAllocation(allocation));
  }

  let publicFilmOrder = null;
  if (selection.remainingFeet > 0) {
    const filmOrder = await createFilmOrderForShortage(
      client,
      orgId,
      source,
      jobContext,
      payload.requestedFeet,
      selection.remainingFeet,
      actor,
      normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse')
    );
    publicFilmOrder = filmOrder
      ? toPublicFilmOrder(filmOrder, await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId))
      : null;

    if (filmOrder) {
      warnings.push(
        `Film Order ${filmOrder.filmOrderId} was created for the remaining ${selection.remainingFeet} LF.`
      );
    }
  }

  return ok(
    {
      allocations: createdAllocations,
      filmOrder: publicFilmOrder,
      remainingUncoveredFeet: selection.remainingFeet
    },
    warnings
  );
}

async function listAudit(client, orgId, params) {
  const from = asTrimmedString(params.from);
  const to = asTrimmedString(params.to);
  const user = asTrimmedString(params.user).toLowerCase();
  const action = asTrimmedString(params.action).toLowerCase();
  const entries = await listAuditEntries(client, orgId);
  const filtered = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryDate = entry.date.slice(0, 10);

    if (from && entryDate < from) {
      continue;
    }

    if (to && entryDate > to) {
      continue;
    }

    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      continue;
    }

    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      continue;
    }

    filtered.push(entry);
  }

  return filtered;
}

async function undoAudit(client, orgId, payload, actor) {
  const reason = asTrimmedString(payload.reason);
  const warnings = [];
  const auditEntry = await findAuditEntryByLogId(client, orgId, payload.logId);

  if (!auditEntry) {
    throw new HttpError(404, 'Audit entry not found.');
  }

  const current = await findBoxById(client, orgId, auditEntry.boxId);
  const notes = `Undo ${auditEntry.action}${reason ? `: ${reason}` : ''}`;

  if (auditEntry.before) {
    let resultBox = cloneValue(auditEntry.before);
    resultBox = await saveBoxRecord(client, orgId, resultBox);

    if (auditEntry.action === 'SET_STATUS' && auditEntry.after && auditEntry.after.status === 'CHECKED_OUT') {
      const checkoutJobNumber = getCheckoutJobNumberFromAuditNotes(auditEntry.notes);
      if (checkoutJobNumber) {
        const reactivatedFulfilledCount = await reactivateFulfilledAllocationsForUndo(
          client,
          orgId,
          auditEntry.boxId,
          checkoutJobNumber
        );
        if (reactivatedFulfilledCount > 0) {
          warnings.push(
            `${reactivatedFulfilledCount} allocation${reactivatedFulfilledCount === 1 ? ' was' : 's were'} reactivated for job ${checkoutJobNumber}.`
          );
        }
      }
    }

    if (auditEntry.action === 'ZERO_OUT_BOX') {
      const reactivatedCancelledCount = await reactivateCancelledAllocationsForZeroUndo(
        client,
        orgId,
        auditEntry.boxId
      );
      if (reactivatedCancelledCount > 0) {
        warnings.push(
          `${reactivatedCancelledCount} zero-cancelled allocation${reactivatedCancelledCount === 1 ? ' was' : 's were'} reactivated.`
        );
      }
    }

    if (auditEntry.after && auditEntry.after.receivedDate && auditEntry.before && !auditEntry.before.receivedDate) {
      const cancelledFilmOrderAllocations = await cancelActiveFilmOrderAllocationsForBox(
        client,
        orgId,
        auditEntry.boxId,
        actor,
        'Cancelled because undo restored the box to its pre-receipt state.'
      );
      if (cancelledFilmOrderAllocations > 0) {
        warnings.push(
          `${cancelledFilmOrderAllocations} auto-allocation${cancelledFilmOrderAllocations === 1 ? ' was' : 's were'} cancelled because the linked box was reverted to pre-receipt.`
        );
      }
    }

    await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

    const newLogId = await appendAuditEntry(
      client,
      orgId,
      'UNDO',
      auditEntry.boxId,
      current ? toPublicBox(current) : null,
      toPublicBox(resultBox),
      actor,
      notes
    );

    return ok({ box: toPublicBox(resultBox), logId: newLogId }, warnings);
  }

  if (!current) {
    throw new HttpError(400, 'Cannot undo add because the current box row is missing.');
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  await cancelActiveFilmOrderAllocationsForBox(
    client,
    orgId,
    auditEntry.boxId,
    actor,
    'Cancelled because the linked box was removed by undo.'
  );
  await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

  const newLogId = await appendAuditEntry(
    client,
    orgId,
    'UNDO_ADD_DELETE',
    auditEntry.boxId,
    toPublicBox(current),
    null,
    actor,
    notes
  );

  return ok({ box: null, logId: newLogId }, warnings);
}

async function buildFilmOrdersList(client, orgId) {
  const entries = await listFilmOrders(client, orgId);
  const sorted = entries.slice().sort((left, right) => {
    const leftOpen = left.status === 'FILM_ORDER' || left.status === 'FILM_ON_THE_WAY';
    const rightOpen = right.status === 'FILM_ORDER' || right.status === 'FILM_ON_THE_WAY';

    if (leftOpen !== rightOpen) {
      return leftOpen ? -1 : 1;
    }

    if (leftOpen) {
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    }

    const leftResolved = left.resolvedAt || left.createdAt;
    const rightResolved = right.resolvedAt || right.createdAt;
    return leftResolved < rightResolved ? -1 : leftResolved > rightResolved ? 1 : 0;
  });
  const response = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    response.push(
      toPublicFilmOrder(
        entry,
        await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId)
      )
    );
  }

  return response;
}

async function buildFilmCatalog(client, orgId) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const manufacturer = normalizeCollapsedCatalogLabel(entry.manufacturer);
    const filmName = normalizeCollapsedCatalogLabel(entry.filmName);
    const manufacturerKey = normalizeCatalogLookupKey(manufacturer);
    const filmNameKey = normalizeCatalogLookupKey(filmName);

    if (!manufacturerKey || !filmNameKey) {
      continue;
    }

    dedupedByKey[`${manufacturerKey}|${filmNameKey}`] = {
      filmKey: asTrimmedString(entry.filmKey).toUpperCase(),
      manufacturer,
      filmName,
      updatedAt: asTrimmedString(entry.updatedAt)
    };
  }

  const response = Object.values(dedupedByKey);
  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    return compareCatalogStrings(left.filmKey, right.filmKey);
  });

  return response;
}

const READ_PATHS = new Set([
  '/boxes/search',
  '/boxes/get',
  '/audit/list',
  '/audit/by-box',
  '/allocations/by-box',
  '/allocations/jobs',
  '/allocations/by-job',
  '/allocations/preview',
  '/jobs/list',
  '/jobs/get',
  '/film-orders/list',
  '/film-data/catalog',
  '/roll-history/by-box',
  '/reports/summary'
]);

export async function handleSupabaseRequest({ method, logicalPath, requestUrl, bodyJson, headers }) {
  try {
    ensureConfigured();

    if (logicalPath === '/health') {
      return {
        statusCode: 200,
        payload: ok({
          status: 'ok',
          timestamp: new Date().toISOString(),
          sheets: [],
          mode: 'supabase'
        })
      };
    }

    const params = routeParams(method, requestUrl, bodyJson);
    const authContext = await resolveAuthContext(headers);

    if (method === 'GET' || (method === 'POST' && READ_PATHS.has(logicalPath))) {
      const payload = await withReadClient(async (client) => {
        switch (logicalPath) {
          case '/boxes/search':
            return ok(await buildSearchBoxes(client, authContext.orgId, params));
          case '/boxes/get': {
            const found = await findBoxById(client, authContext.orgId, params.boxId);
            if (!found) {
              throw new HttpError(404, 'Box not found.');
            }
            return ok(toPublicBox(found));
          }
          case '/audit/list':
            return ok({ entries: await listAudit(client, authContext.orgId, params) });
          case '/audit/by-box':
            return ok({
              entries: await listAuditEntriesByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))
            });
          case '/allocations/by-box':
            return ok({
              entries: (await listAllocationsByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))).map(
                toPublicAllocation
              )
            });
          case '/allocations/jobs':
            return ok({ entries: await buildAllocationJobList(client, authContext.orgId) });
          case '/allocations/by-job':
            return ok(await buildAllocationJobDetail(client, authContext.orgId, params.jobNumber));
          case '/allocations/preview':
            return ok(await previewAllocationPlan(client, authContext.orgId, params));
          case '/jobs/list': {
            const limitValue = Number(params && params.limit);
            const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
            return ok({ entries: await buildJobsList(client, authContext.orgId, limit) });
          }
          case '/jobs/get':
            return ok(await buildJobDetail(client, authContext.orgId, params.jobNumber));
          case '/film-orders/list':
            return ok({ entries: await buildFilmOrdersList(client, authContext.orgId) });
          case '/film-data/catalog':
            return ok({ entries: await buildFilmCatalog(client, authContext.orgId) });
          case '/roll-history/by-box':
            return ok({
              entries: await listRollHistoryByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))
            });
          case '/reports/summary':
            return ok(await buildReportsSummary(client, authContext.orgId, params));
          default:
            throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
        }
      });

      return {
        statusCode: 200,
        payload
      };
    }

    const payload = await withMutation(async (client) => {
      switch (logicalPath) {
        case '/boxes/add':
          return addBox(client, authContext.orgId, params, authContext.actor);
        case '/allocations/add':
        case '/allocations/apply':
          return applyAllocationPlan(client, authContext.orgId, params, authContext.actor);
        case '/jobs/create':
          return createJob(client, authContext.orgId, params, authContext.actor);
        case '/jobs/update':
          return updateJob(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/create':
          return createFilmOrder(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/cancel':
          return cancelJob(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/delete':
          return deleteFilmOrder(client, authContext.orgId, params, authContext.actor);
        case '/boxes/update':
          return updateBox(client, authContext.orgId, params, authContext.actor);
        case '/boxes/delete':
          return deleteBox(client, authContext.orgId, params, authContext.actor);
        case '/boxes/set-status':
          return setBoxStatus(client, authContext.orgId, params, authContext.actor);
        case '/audit/undo':
          return undoAudit(client, authContext.orgId, params, authContext.actor);
        default:
          throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
      }
    });

    return {
      statusCode: 200,
      payload
    };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        statusCode: error.statusCode,
        payload: {
          ok: false,
          error: error.message,
          warnings: error.warnings || []
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: error instanceof Error ? error.message : 'Unexpected server error.',
        warnings: []
      }
    };
  }
}
