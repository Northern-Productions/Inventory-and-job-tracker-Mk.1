import {
  HttpError,
  asTrimmedString,
  integerOrZero,
  parseStrictBooleanFlag,
} from '../../runtimeDeps.mjs';

const DIRECT_TO_SITE_CREATED_PREFIX = 'DIRECT_TO_SITE_CREATED';
const DIRECT_TO_SITE_CHECKED_OUT_PREFIX = 'DIRECT_TO_SITE_CHECKED_OUT';
const DIRECT_TO_SITE_FIRST_RETURN_PREFIX = 'DIRECT_TO_SITE_FIRST_RETURN';

/**
 * PURPOSE:
 * Centralizes the direct-to-job-site fulfillment rules and standardized event
 * text so add, checkout, and first-return flows stay aligned.
 *
 * AFFECTS:
 * Film-order fulfillment, checked-out box invariants, job traceability, and
 * roll/job history messaging for direct-to-site inventory.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * `crud.mjs`, `statusTransitions.mjs`, SQL `api_boxes_add` / `api_boxes_set_status`,
 * film-order linked-box serializers, and direct-to-site frontend tests.
 *
 * COMMON FAILURE MODES:
 * Generic add/edit flows setting the flag directly, warehouse receipt data
 * leaking into direct-to-site boxes, and inconsistent audit wording between
 * box history and job history.
 */

function hasOwn(payload, key) {
  return Boolean(payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, key));
}

function parseShipDirectToJobSiteFlag(payload) {
  if (!hasOwn(payload, 'shipDirectToJobSite')) {
    return false;
  }

  return parseStrictBooleanFlag(payload.shipDirectToJobSite, 'ShipDirectToJobSite');
}

function assertDirectToJobSiteFlagIsServerOwned(payload, contextLabel) {
  if (hasOwn(payload, 'directToJobSite')) {
    throw new HttpError(
      400,
      `${contextLabel} cannot set DirectToJobSite directly. Use Ship Directly to Job Site on the approved Film Order fulfillment flow instead.`
    );
  }
}

function assertNoShipDirectToJobSiteFlag(payload, contextLabel) {
  if (!hasOwn(payload, 'shipDirectToJobSite')) {
    return;
  }

  throw new HttpError(
    400,
    `${contextLabel} cannot set ShipDirectToJobSite. That flag is only allowed when adding a box through Film Order fulfillment.`
  );
}

function hasMeaningfulDirectToSiteReceiptInput(payload) {
  return (
    asTrimmedString(payload?.receivedDate) !== '' ||
    asTrimmedString(payload?.lastWeighedDate) !== '' ||
    payload?.initialWeightLbs !== null && payload?.initialWeightLbs !== undefined && asTrimmedString(payload.initialWeightLbs) !== '' ||
    payload?.lastRollWeightLbs !== null && payload?.lastRollWeightLbs !== undefined && asTrimmedString(payload.lastRollWeightLbs) !== '' ||
    asTrimmedString(payload?.coreType) !== '' ||
    payload?.coreWeightLbs !== null && payload?.coreWeightLbs !== undefined && asTrimmedString(payload.coreWeightLbs) !== '' ||
    payload?.lfWeightLbsPerFt !== null && payload?.lfWeightLbsPerFt !== undefined && asTrimmedString(payload.lfWeightLbsPerFt) !== ''
  );
}

function assertNoWarehouseReceiptInputsForDirectToJobSite(payload) {
  if (!hasMeaningfulDirectToSiteReceiptInput(payload)) {
    return;
  }

  throw new HttpError(
    400,
    'Ship Directly to Job Site boxes cannot include warehouse receipt dates or initial warehouse weight fields.'
  );
}

function getDirectToJobSiteCommittedFeet(filmOrder, initialFeet) {
  const normalizedInitialFeet = Math.max(0, integerOrZero(initialFeet));
  const remainingNeed = Math.max(
    integerOrZero(filmOrder?.requestedFeet) - integerOrZero(filmOrder?.coveredFeet),
    0
  );
  if (remainingNeed <= 0) {
    return 0;
  }

  return Math.min(remainingNeed, normalizedInitialFeet);
}

function getDirectToJobSiteAvailableFeet(initialFeet, committedFeet) {
  return Math.max(0, integerOrZero(initialFeet) - integerOrZero(committedFeet));
}

function appendUserNote(baseNote, userNote) {
  const normalizedUserNote = asTrimmedString(userNote);
  if (!normalizedUserNote) {
    return baseNote;
  }

  return `${baseNote} Additional note: ${normalizedUserNote}`;
}

function buildDirectToJobSiteCreatedAuditNote({ filmOrderId, jobNumber, userNote = '' }) {
  return appendUserNote(
    `${DIRECT_TO_SITE_CREATED_PREFIX}: Created from Film Order ${filmOrderId} for job ${jobNumber}; shipped directly to job site; no warehouse receipt; no initial weight recorded.`,
    userNote
  );
}

function buildDirectToJobSiteCheckedOutAuditNote({ filmOrderId, jobNumber }) {
  return `${DIRECT_TO_SITE_CHECKED_OUT_PREFIX}: Box committed directly to job ${jobNumber} from Film Order ${filmOrderId}.`;
}

function buildDirectToJobSiteFirstReturnNote({
  jobNumber,
  lastRollWeightLbs,
  currentFeetOnRoll,
  userNote = ''
}) {
  return appendUserNote(
    `${DIRECT_TO_SITE_FIRST_RETURN_PREFIX}: First warehouse return from job ${jobNumber}; received at ${lastRollWeightLbs} lbs with ${currentFeetOnRoll} LF remaining.`,
    userNote
  );
}

export {
  DIRECT_TO_SITE_CREATED_PREFIX,
  DIRECT_TO_SITE_CHECKED_OUT_PREFIX,
  DIRECT_TO_SITE_FIRST_RETURN_PREFIX,
  parseShipDirectToJobSiteFlag,
  assertDirectToJobSiteFlagIsServerOwned,
  assertNoShipDirectToJobSiteFlag,
  assertNoWarehouseReceiptInputsForDirectToJobSite,
  getDirectToJobSiteCommittedFeet,
  getDirectToJobSiteAvailableFeet,
  buildDirectToJobSiteCreatedAuditNote,
  buildDirectToJobSiteCheckedOutAuditNote,
  buildDirectToJobSiteFirstReturnNote,
};
