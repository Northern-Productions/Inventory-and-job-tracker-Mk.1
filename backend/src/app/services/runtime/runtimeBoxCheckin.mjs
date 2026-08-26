// Purpose: Shared planning helpers for film box check-in workflows.
import {
  HttpError,
  asTrimmedString,
  coerceNonNegativeNumber,
  integerOrZero,
  normalizeCoreType,
  deriveCoreWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveLfWeightLbsPerFtIfPossible,
  deriveFeetAvailableFromRollWeight,
  clampFeetToInitialRange,
  normalizeJobNumberKey,
  requiresFirstReturnCalibration,
} from '../runtimeDeps.mjs';
import {
  allocationReservesCapacity,
  normalizeAllocationSource,
} from '../../../../../shared/domain/filmAllocationReservations.mjs';

function canDeriveCheckInFeetFromWeight(box) {
  const coreWeightLbs = Number(box?.coreWeightLbs);
  const lfWeightLbsPerFt = Number(box?.lfWeightLbsPerFt);
  return (
    box?.coreWeightLbs !== null &&
    box?.coreWeightLbs !== undefined &&
    box?.lfWeightLbsPerFt !== null &&
    box?.lfWeightLbsPerFt !== undefined &&
    Number.isFinite(coreWeightLbs) &&
    coreWeightLbs >= 0 &&
    Number.isFinite(lfWeightLbsPerFt) &&
    lfWeightLbsPerFt > 0
  );
}

function canDeriveStoredPhysicalFeetFromWeight(box) {
  return canDeriveCheckInFeetFromWeight(box) && box?.lastRollWeightLbs !== null && box?.lastRollWeightLbs !== undefined;
}

function derivePhysicalFeetBeforeCheckIn(box, lockedAllocatedFeetBeforeCheckIn) {
  if (canDeriveStoredPhysicalFeetFromWeight(box)) {
    return deriveFeetAvailableFromRollWeight(
      Number(box.lastRollWeightLbs),
      Number(box.coreWeightLbs),
      Number(box.lfWeightLbsPerFt),
      integerOrZero(box.initialFeet)
    );
  }

  return clampFeetToInitialRange(
    integerOrZero(box.feetAvailable) + integerOrZero(lockedAllocatedFeetBeforeCheckIn),
    integerOrZero(box.initialFeet)
  );
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveBoxWeightCalibration(box, filmCatalog = null) {
  const savedCoreType = normalizeCoreType(box?.coreType, true);
  const savedCoreWeightLbs = finiteNumberOrNull(box?.coreWeightLbs);
  const savedLfWeightLbsPerFt = finiteNumberOrNull(box?.lfWeightLbsPerFt);

  if (
    savedCoreWeightLbs !== null &&
    savedCoreWeightLbs >= 0 &&
    savedLfWeightLbsPerFt !== null &&
    savedLfWeightLbsPerFt > 0
  ) {
    return {
      resolved: true,
      source: 'SAVED_BOX',
      coreType: savedCoreType,
      coreWeightLbs: savedCoreWeightLbs,
      lfWeightLbsPerFt: savedLfWeightLbsPerFt,
    };
  }

  if (savedCoreType) {
    const coreWeightLbs = deriveCoreWeightLbs(savedCoreType, Number(box?.widthIn));
    const lfWeightLbsPerFt = deriveLfWeightLbsPerFtIfPossible(
      finiteNumberOrNull(box?.initialWeightLbs),
      coreWeightLbs,
      Number(box?.widthIn),
      Number(box?.initialFeet)
    );
    if (lfWeightLbsPerFt !== null && lfWeightLbsPerFt > 0) {
      return {
        resolved: true,
        source: 'BOX_INITIAL_BASELINE',
        coreType: savedCoreType,
        coreWeightLbs,
        lfWeightLbsPerFt,
      };
    }
  }

  const catalogWeight = finiteNumberOrNull(filmCatalog?.sqFtWeightLbsPerSqFt);
  const catalogCoreType = savedCoreType || normalizeCoreType(filmCatalog?.defaultCoreType, true);
  if (catalogWeight !== null && catalogWeight > 0 && catalogCoreType) {
    const coreWeightLbs = deriveCoreWeightLbs(catalogCoreType, Number(box?.widthIn));
    const lfWeightLbsPerFt = deriveLfWeightLbsPerFt(catalogWeight, Number(box?.widthIn));
    if (lfWeightLbsPerFt > 0) {
      return {
        resolved: true,
        source: 'FILM_CATALOG',
        coreType: catalogCoreType,
        coreWeightLbs,
        lfWeightLbsPerFt,
      };
    }
  }

  return {
    resolved: false,
    source: 'UNRESOLVED',
    coreType: savedCoreType,
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
  };
}

function summarizeOtherJobs(allocations) {
  const otherJobs = [];
  const seen = new Set();

  for (let index = 0; index < allocations.length; index += 1) {
    const jobNumber = asTrimmedString(allocations[index]?.jobNumber);
    const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
    if (!normalizedJobNumber || seen.has(normalizedJobNumber)) {
      continue;
    }

    seen.add(normalizedJobNumber);
    otherJobs.push(jobNumber);
  }

  return otherJobs;
}

function allocationMatchesCheckoutJob(entry, checkoutJobNumber, checkoutJobId = '') {
  const normalizedCheckoutJobId = asTrimmedString(checkoutJobId).toLowerCase();
  if (normalizedCheckoutJobId) {
    return asTrimmedString(entry?.jobId).toLowerCase() === normalizedCheckoutJobId;
  }

  return normalizeJobNumberKey(entry?.jobNumber) === normalizeJobNumberKey(checkoutJobNumber);
}

function sumAllocatedFeet(entries) {
  return entries.reduce((total, entry) => total + integerOrZero(entry?.allocatedFeet), 0);
}

function planBoxCheckIn(existingBox, payload, allocations, checkoutJobNumber, options = {}) {
  const lastRollWeightLbs = coerceNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  const normalizedCheckoutJob = normalizeJobNumberKey(checkoutJobNumber);
  const checkoutJobId = asTrimmedString(options.jobId);
  const firstReturnCalibration = requiresFirstReturnCalibration(existingBox);
  const activeAllocations = Array.isArray(allocations)
    ? allocations.filter((entry) => asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE')
    : [];
  const activeCapacityAllocations = activeAllocations.filter((entry) =>
    allocationReservesCapacity(entry, existingBox)
  );

  const hasCheckoutIdentity = Boolean(checkoutJobId || normalizedCheckoutJob);
  const sameJobActiveAllocations = hasCheckoutIdentity
    ? activeAllocations.filter((entry) => allocationMatchesCheckoutJob(entry, checkoutJobNumber, checkoutJobId))
    : [];
  const otherActiveAllocations = hasCheckoutIdentity
    ? activeCapacityAllocations.filter((entry) => !allocationMatchesCheckoutJob(entry, checkoutJobNumber, checkoutJobId))
    : activeCapacityAllocations;
  const otherStoredCapacityAllocations = otherActiveAllocations.filter(
    (entry) => normalizeAllocationSource(entry?.allocationSource ?? entry?.allocation_source) !== 'AUTO_PLANNED'
  );
  const otherAutoPlannedAllocations = otherActiveAllocations.filter(
    (entry) => normalizeAllocationSource(entry?.allocationSource ?? entry?.allocation_source) === 'AUTO_PLANNED'
  );
  const activeLockedAllocatedFeetBeforeCheckIn = sumAllocatedFeet(activeCapacityAllocations);
  const sameJobActiveAllocatedFeet = sumAllocatedFeet(sameJobActiveAllocations);
  const otherActiveAllocatedFeet = sumAllocatedFeet(otherActiveAllocations);
  const otherStoredAllocatedFeet = sumAllocatedFeet(otherStoredCapacityAllocations);
  const otherAutoPlannedAllocatedFeet = sumAllocatedFeet(otherAutoPlannedAllocations);
  const physicalFeetBeforeCheckIn = derivePhysicalFeetBeforeCheckIn(
    existingBox,
    activeLockedAllocatedFeetBeforeCheckIn
  );

  const calibration = options.calibration || resolveBoxWeightCalibration(existingBox, options.filmCatalog);

  /**
   * PURPOSE:
   * Keeps the approved direct-to-site first-return exception aligned with the
   * normal check-in planner so only that checked-out branch can establish the
   * first warehouse weight/LF baseline.
   *
   * AFFECTS:
   * Box check-in, zeroed transitions on first return, roll history metrics, and
   * the warehouse/UI requirement for CurrentFeetOnRoll.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * `statusTransitions.mjs`, SQL `api_boxes_set_status`, frontend
   * `boxCheckin.ts`, and direct-to-site audit/history tests.
   *
   * COMMON FAILURE MODES:
   * Blocking valid first returns, letting generic status edits bypass
   * calibration, or failing to zero out fully-consumed direct-to-site returns.
   */
  if (!calibration.resolved) {
    throw new HttpError(
      400,
      'This box is missing the roll-weight calibration needed to calculate remaining LF. Update its roll-tracking details before checking it in.'
    );
  }

  const physicalFeetAfterCheckIn = deriveFeetAvailableFromRollWeight(
    lastRollWeightLbs,
    calibration.coreWeightLbs,
    calibration.lfWeightLbsPerFt,
    integerOrZero(existingBox.initialFeet)
  );

  const manualReservationOverageFeet = Math.max(otherStoredAllocatedFeet - physicalFeetAfterCheckIn, 0);

  const autoPlannedReservationOverageFeet = Math.max(
    otherActiveAllocatedFeet - Math.max(physicalFeetAfterCheckIn, otherStoredAllocatedFeet),
    0
  );
  const feetAvailableAfterCheckIn = Math.max(
    physicalFeetAfterCheckIn - Math.min(otherStoredAllocatedFeet, physicalFeetAfterCheckIn),
    0
  );
  const autoMoveToZeroed =
    (Boolean(existingBox.receivedDate) || firstReturnCalibration) &&
    integerOrZero(existingBox.initialFeet) > 0 &&
    (physicalFeetAfterCheckIn === 0 || lastRollWeightLbs === 0);

  return {
    lastRollWeightLbs,
    physicalFeetBeforeCheckIn,
    physicalFeetAfterCheckIn,
    feetAvailableAfterCheckIn,
    sameJobActiveAllocationCount: sameJobActiveAllocations.length,
    sameJobActiveAllocatedFeet,
    otherActiveAllocatedFeet,
    otherStoredAllocatedFeet,
    otherAutoPlannedAllocatedFeet,
    manualReservationOverageFeet,
    autoPlannedReservationOverageFeet,
    otherJobs: summarizeOtherJobs(otherActiveAllocations),
    coreType: calibration.coreType,
    coreWeightLbs: calibration.coreWeightLbs,
    lfWeightLbsPerFt: calibration.lfWeightLbsPerFt,
    calibrationSource: calibration.source,
    usedCalibration: calibration.source !== 'SAVED_BOX',
    autoMoveToZeroed,
  };
}

export {
  canDeriveCheckInFeetFromWeight,
  canDeriveStoredPhysicalFeetFromWeight,
  derivePhysicalFeetBeforeCheckIn,
  resolveBoxWeightCalibration,
  planBoxCheckIn,
};
