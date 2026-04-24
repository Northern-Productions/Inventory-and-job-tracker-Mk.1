import crypto from 'node:crypto';
import {
  BOX_STATUSES,
  CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS,
  CORE_WEIGHT_REFERENCE_WIDTH_IN,
  LOW_STOCK_THRESHOLD_LF,
  UUID_PATTERN,
} from '../../config/runtime.mjs';
import { HttpError } from '../../lib/http.mjs';
import { WAREHOUSE_CODE_PATTERN } from '../../../../shared/domain/runtimeContract.mjs';

function getActiveAllocatedFeetForBox(boxId, activeAllocationsByBox = {}) {
  const entries = activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
  let total = 0;

  for (let index = 0; index < entries.length; index += 1) {
    total += integerOrZero(entries[index]?.allocatedFeet);
  }

  return total;
}

function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function deriveNameFromEmail(email) {
  const localPart = asTrimmedString(email).split('@')[0] || '';
  return localPart.replace(/[._-]+/g, ' ').trim();
}

function requireString(value, fieldName) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  return trimmed;
}

function normalizeStringArrayParam(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const normalized = [];
  const seen = new Set();

  for (let index = 0; index < rawValues.length; index += 1) {
    const rawValue = rawValues[index];
    const tokens = typeof rawValue === 'string' ? rawValue.split(',') : [rawValue];

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const trimmed = asTrimmedString(tokens[tokenIndex]);
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

function normalizeUsername(value) {
  const normalized = asTrimmedString(value).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new HttpError(400, 'Username is required.');
  }
  if (normalized.length < 2) {
    throw new HttpError(400, 'Username must be at least 2 characters.');
  }
  if (normalized.length > 64) {
    throw new HttpError(400, 'Username must be 64 characters or fewer.');
  }
  return normalized;
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
      'Status must be ORDERED, IN_STOCK, CHECKED_OUT, TRANSFER, ZEROED, or RETIRED.'
    );
  }

  return normalized;
}

function isAllocatableBoxStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  return normalized === 'IN_STOCK' || normalized === 'ORDERED' || normalized === 'TRANSFER';
}

function findPendingTransferForBox(box, pendingTransfersByBoxRecordId = {}) {
  const boxRecordId = asTrimmedString(box?.id);
  if (!boxRecordId) {
    return null;
  }

  return pendingTransfersByBoxRecordId[boxRecordId] || null;
}

function getTransferAllocationBlockReason(box, pendingTransfer, jobWarehouse) {
  return '';
}

function isJobAllocationEligibleBox(box, pendingTransfer, jobWarehouse) {
  if (!isAllocatableBoxStatus(box?.status)) {
    return false;
  }

  return getTransferAllocationBlockReason(box, pendingTransfer, jobWarehouse) === '';
}

function computeAllocationPlanningFeet(status, initialFeet, feetAvailable, activeAllocatedFeet) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  if (normalizedStatus === 'IN_STOCK' || normalizedStatus === 'TRANSFER') {
    return Math.max(0, integerOrZero(feetAvailable));
  }

  if (normalizedStatus === 'ORDERED') {
    return Math.max(0, integerOrZero(initialFeet) - integerOrZero(activeAllocatedFeet));
  }

  return 0;
}

function getBoxAllocationPlanningFeet(box, activeAllocationsByBox) {
  if (!box) {
    return 0;
  }

  if (Number.isFinite(Number(box.allocationPlanningFeet))) {
    return Math.max(0, integerOrZero(box.allocationPlanningFeet));
  }

  const activeAllocatedFeet =
    box.activeAllocatedFeet !== undefined && box.activeAllocatedFeet !== null
      ? integerOrZero(box.activeAllocatedFeet)
      : getActiveAllocatedFeetForBox(box.boxId, activeAllocationsByBox);

  return computeAllocationPlanningFeet(box.status, box.initialFeet, box.feetAvailable, activeAllocatedFeet);
}

function boxUsesOrderedPlanning(box) {
  return asTrimmedString(box?.status).toUpperCase() === 'ORDERED';
}

function boxCanReceiveReleasedAllocationFeet(box) {
  const normalizedStatus = asTrimmedString(box?.status).toUpperCase();
  return normalizedStatus !== 'ZEROED' && normalizedStatus !== 'RETIRED' && normalizedStatus !== 'ORDERED';
}

function applyPlanningAllocationToBox(box, allocatedFeet, options = {}) {
  const nextAllocatedFeet = Math.max(0, integerOrZero(allocatedFeet));
  const nextActiveAllocatedFeet = integerOrZero(box.activeAllocatedFeet) + nextAllocatedFeet;
  const consumesAllocatableFeet = options.consumeAllocatableFeet !== false;
  const nextFeetAvailable = boxUsesOrderedPlanning(box)
    ? 0
    : consumesAllocatableFeet
      ? Math.max(0, integerOrZero(box.feetAvailable) - nextAllocatedFeet)
      : Math.max(0, integerOrZero(box.feetAvailable));

  return {
    ...box,
    activeAllocatedFeet: nextActiveAllocatedFeet,
    feetAvailable: nextFeetAvailable,
    allocationPlanningFeet: computeAllocationPlanningFeet(
      box.status,
      box.initialFeet,
      nextFeetAvailable,
      nextActiveAllocatedFeet
    ),
  };
}

function releaseAllocationFeetFromBox(box, releasedFeet, options = {}) {
  const nextReleasedFeet = Math.max(0, integerOrZero(releasedFeet));
  const nextActiveAllocatedFeet = Math.max(0, integerOrZero(box.activeAllocatedFeet) - nextReleasedFeet);
  const restoresAllocatableFeet = options.restoreAllocatableFeet !== false;
  const nextFeetAvailable = boxUsesOrderedPlanning(box)
    ? 0
    : restoresAllocatableFeet && boxCanReceiveReleasedAllocationFeet(box)
      ? Math.min(integerOrZero(box.initialFeet), Math.max(0, integerOrZero(box.feetAvailable) + nextReleasedFeet))
      : integerOrZero(box.feetAvailable);

  return {
    ...box,
    activeAllocatedFeet: nextActiveAllocatedFeet,
    feetAvailable: nextFeetAvailable,
    allocationPlanningFeet: computeAllocationPlanningFeet(
      box.status,
      box.initialFeet,
      nextFeetAvailable,
      nextActiveAllocatedFeet
    ),
  };
}

function hasActiveOrderedAllocations(allocations, boxById = {}) {
  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (asTrimmedString(entry?.status).toUpperCase() !== 'ACTIVE') {
      continue;
    }

    const box = boxById[asTrimmedString(entry?.boxId)] || null;
    if (boxUsesOrderedPlanning(box)) {
      return true;
    }
  }

  return false;
}

function hasActiveOrderedRequirementAllocations(allocations, boxById = {}) {
  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (
      asTrimmedString(entry?.status).toUpperCase() !== 'ACTIVE' ||
      normalizeAllocationKind(entry?.allocationKind) === 'EXTRA' ||
      integerOrZero(entry?.allocatedFeet) <= 0
    ) {
      continue;
    }

    const box = boxById[asTrimmedString(entry?.boxId)] || null;
    if (boxUsesOrderedPlanning(box)) {
      return true;
    }
  }

  return false;
}

function buildOrderedAllocationReceiptMessage(action) {
  return action === 'checkout'
    ? 'Receive ordered film before checking out all materials for this job.'
    : 'Receive ordered film before staging this job.';
}

function parseBooleanFlag(value) {
  return value === true || asTrimmedString(value).toLowerCase() === 'true';
}

function parseStrictBooleanFlag(value, fieldName) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === 'true' || normalized === 't' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (
    normalized === 'false' ||
    normalized === 'f' ||
    normalized === '0' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }

  throw new HttpError(400, `${fieldName} must be true or false.`);
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

function normalizeAllocationKind(value) {
  return asTrimmedString(value).toUpperCase() === 'EXTRA' ? 'EXTRA' : 'REQUIREMENT';
}

function parseIntegerInput(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed) {
    throw new HttpError(400, `${fieldName} must be an integer.`);
  }
  return Math.trunc(parsed);
}

function requireUuid(value, fieldName) {
  const normalized = requireString(value, fieldName);
  if (!UUID_PATTERN.test(normalized)) {
    throw new HttpError(400, `${fieldName} must be a valid UUID.`);
  }
  return normalized;
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
    String(now.getUTCMilliseconds()).padStart(3, '0'),
  ].join('');
  const suffix = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  return `${timestamp}-${suffix}`;
}

function createTransferId() {
  return `TRF-${createLogId()}`;
}

function roundToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeWarehouseCodeFormat(value, fieldName) {
  const normalized = requireString(value, fieldName || 'Warehouse').toUpperCase();
  if (!WAREHOUSE_CODE_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      `${fieldName || 'Warehouse'} must match AA1, AA2, ... with a 1-based index.`
    );
  }

  return normalized;
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
  if (normalized === 'white' || normalized === 'white plastic' || normalized === 'whiteplastic') {
    return 'White plastic';
  }

  if (normalized === 'red' || normalized === 'red plastic' || normalized === 'redplastic') {
    return 'Red plastic';
  }

  if (
    normalized === 'cardboard' ||
    normalized === 'cardboard 1/8"' ||
    normalized === 'cardboard 1/8' ||
    normalized === 'cardboard 1-8"' ||
    normalized === 'cardboard 1-8'
  ) {
    return 'Cardboard 1/8"';
  }

  if (
    normalized === 'thick cardboard' ||
    normalized === 'thick-cardboard' ||
    normalized === 'thick_cardboard' ||
    normalized === 'thickcardboard' ||
    normalized === 'cardboard 3/4"' ||
    normalized === 'cardboard 3/4' ||
    normalized === 'cardboard 3-4"' ||
    normalized === 'cardboard 3-4' ||
    normalized === 'cardboard 3/8"' ||
    normalized === 'cardboard 3/8' ||
    normalized === 'cardboard 3-8"' ||
    normalized === 'cardboard 3-8'
  ) {
    return 'Cardboard 3/8"';
  }

  if (
    normalized === 'security 1/4" cardboard' ||
    normalized === 'security 1/4 cardboard' ||
    normalized === 'security 1-4" cardboard' ||
    normalized === 'security 1-4 cardboard'
  ) {
    return 'SECURITY 1/4" Cardboard';
  }

  if (
    normalized === 'security white plastic 3/8"' ||
    normalized === 'security white plastic 3/8' ||
    normalized === 'security white plastic 3-8"' ||
    normalized === 'security white plastic 3-8' ||
    normalized === 'security whiteplastic 3/8"' ||
    normalized === 'security whiteplastic 3/8' ||
    normalized === 'security whiteplastic 3-8"' ||
    normalized === 'security whiteplastic 3-8' ||
    normalized === 'security white 3/8"' ||
    normalized === 'security white 3/8' ||
    normalized === 'security white 3-8"' ||
    normalized === 'security white 3-8'
  ) {
    return 'SECURITY White plastic 3/8"';
  }

  throw new HttpError(
    400,
    'CoreType must be White plastic, Red plastic, Cardboard 1/8", Cardboard 3/8", SECURITY 1/4" Cardboard, or SECURITY White plastic 3/8".'
  );
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

function clampFeetToInitialRange(feetValue, initialFeet) {
  const normalizedInitialFeet = Math.max(Math.floor(Number(initialFeet) || 0), 0);
  const normalizedFeetValue = Math.floor(Number(feetValue) || 0);
  return Math.min(Math.max(normalizedFeetValue, 0), normalizedInitialFeet);
}

function deriveLfWeightLbsPerFtIfPossible(initialWeightLbs, coreWeightLbs, widthIn, initialFeet) {
  if (
    initialWeightLbs === null ||
    coreWeightLbs === null ||
    !Number.isFinite(Number(widthIn)) ||
    Number(widthIn) <= 0 ||
    !Number.isFinite(Number(initialFeet)) ||
    Number(initialFeet) <= 0
  ) {
    return null;
  }

  try {
    const sqFtWeightLbsPerSqFt = deriveSqFtWeightLbsPerSqFt(
      initialWeightLbs,
      coreWeightLbs,
      widthIn,
      initialFeet
    );
    return deriveLfWeightLbsPerFt(sqFtWeightLbsPerSqFt, widthIn);
  } catch {
    return null;
  }
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

function hasBoxWeightBaseline(box) {
  return box?.lastRollWeightLbs !== null && box?.lastRollWeightLbs !== undefined;
}

function isDirectToJobSiteBox(box) {
  return box?.directToJobSite === true;
}

function requiresFirstReturnCalibration(box) {
  return (
    asTrimmedString(box?.status).toUpperCase() === 'CHECKED_OUT' &&
    isDirectToJobSiteBox(box) &&
    !asTrimmedString(box?.receivedDate) &&
    !hasBoxWeightBaseline(box)
  );
}

function isIllegalCheckedOutBoxWithoutWeightBaseline(box) {
  return (
    asTrimmedString(box?.status).toUpperCase() === 'CHECKED_OUT' &&
    !hasBoxWeightBaseline(box) &&
    !isDirectToJobSiteBox(box)
  );
}

function getWarehouseCheckoutWeightRequirementMessage(boxId) {
  const normalizedBoxId = asTrimmedString(boxId).toUpperCase();
  return normalizedBoxId
    ? `Box ${normalizedBoxId} must be weighed and have a saved Last Roll Weight before it can be checked out from warehouse inventory.`
    : 'This box must be weighed and have a saved Last Roll Weight before it can be checked out from warehouse inventory.';
}

/**
 * PURPOSE:
 * Enforces the box lifecycle invariant around outbound roll-weight baselines.
 *
 * AFFECTS:
 * Box add/update/save flows, checkout transitions, direct-to-site fulfillment,
 * and any path that persists checked-out inventory state.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * `/services/runtime/boxes`, `/services/runtime/checkout`, SQL `app_api.save_box`,
 * first-return check-in validation, and frontend checkout/check-in helpers.
 *
 * COMMON FAILURE MODES:
 * Partial checkout side effects, checked-out boxes with no outbound weight,
 * and direct-to-site exceptions drifting away from warehouse rules.
 */
function assertLegalBoxWeightState(box) {
  if (!isIllegalCheckedOutBoxWithoutWeightBaseline(box)) {
    return;
  }

  throw new HttpError(
    400,
    'A checked-out box without a saved Last Roll Weight is only allowed when it originated from direct-to-job-site fulfillment.'
  );
}

function assertCanCheckoutBoxFromWarehouse(box) {
  if (asTrimmedString(box?.status).toUpperCase() !== 'IN_STOCK' || hasBoxWeightBaseline(box)) {
    return;
  }

  throw new HttpError(400, getWarehouseCheckoutWeightRequirementMessage(box?.boxId));
}

function hasIncompleteBoxHistoryForZeroedEdit(box) {
  if (!box) {
    return false;
  }

  return (
    !asTrimmedString(box.receivedDate) ||
    box.initialWeightLbs === null ||
    box.coreWeightLbs === null ||
    !asTrimmedString(box.lastWeighedDate)
  );
}

function hasExplicitZeroNumericInput(value) {
  if (value === null || value === undefined) {
    return false;
  }

  const rawValue = asTrimmedString(value);
  if (!rawValue) {
    return false;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue <= 0;
}

function hasExplicitZeroFeetAvailableInput(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const hasSubmittedCurrentFeetOnRoll = Object.prototype.hasOwnProperty.call(
    payload,
    'currentFeetOnRoll'
  );

  if (hasSubmittedCurrentFeetOnRoll) {
    return hasExplicitZeroNumericInput(payload.currentFeetOnRoll);
  }

  return hasExplicitZeroNumericInput(payload.feetAvailable);
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

function normalizeRequirementWidthKey(value) {
  return String(roundToDecimals(Number(value), 4));
}

function canonicalizeNumericDigits(digits) {
  const withoutLeadingZeros = String(digits).replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

export {
  asTrimmedString,
  deriveNameFromEmail,
  requireString,
  normalizeStringArrayParam,
  normalizeUsername,
  normalizeDateString,
  coerceNonNegativeNumber,
  coerceOptionalNonNegativeNumber,
  coerceFeetValue,
  assertBoxStatus,
  isAllocatableBoxStatus,
  findPendingTransferForBox,
  getTransferAllocationBlockReason,
  isJobAllocationEligibleBox,
  computeAllocationPlanningFeet,
  getBoxAllocationPlanningFeet,
  boxUsesOrderedPlanning,
  boxCanReceiveReleasedAllocationFeet,
  applyPlanningAllocationToBox,
  releaseAllocationFeetFromBox,
  hasActiveOrderedAllocations,
  hasActiveOrderedRequirementAllocations,
  buildOrderedAllocationReceiptMessage,
  parseBooleanFlag,
  parseStrictBooleanFlag,
  formatTimestamp,
  formatDateValue,
  numericOrNull,
  integerOrZero,
  integerOrNull,
  normalizeAllocationKind,
  parseIntegerInput,
  requireUuid,
  cloneValue,
  createLogId,
  createTransferId,
  roundToDecimals,
  normalizeWarehouseCodeFormat,
  buildFilmKey,
  todayDateString,
  deriveAddFeetAvailable,
  deriveLifecycleStatus,
  normalizeCoreType,
  deriveCoreWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveInitialWeightLbs,
  deriveSqFtWeightLbsPerSqFt,
  deriveFeetAvailableFromRollWeight,
  clampFeetToInitialRange,
  deriveLfWeightLbsPerFtIfPossible,
  isLowStockBox,
  hasPositivePhysicalFeet,
  hasBoxWeightBaseline,
  isDirectToJobSiteBox,
  requiresFirstReturnCalibration,
  isIllegalCheckedOutBoxWithoutWeightBaseline,
  getWarehouseCheckoutWeightRequirementMessage,
  assertLegalBoxWeightState,
  assertCanCheckoutBoxFromWarehouse,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroNumericInput,
  hasExplicitZeroFeetAvailableInput,
  determineZeroedReason,
  normalizeMeaningfulZeroedNote,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  applyCheckoutWarnings,
  applyCheckInWarnings,
  compareCatalogStrings,
  normalizeRequirementWidthKey,
  canonicalizeNumericDigits,
};
