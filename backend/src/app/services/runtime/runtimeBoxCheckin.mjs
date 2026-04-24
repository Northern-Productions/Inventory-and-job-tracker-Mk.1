// Purpose: Shared planning helpers for film box check-in workflows.
import {
  HttpError,
  asTrimmedString,
  coerceNonNegativeNumber,
  integerOrZero,
  roundToDecimals,
  normalizeCoreType,
  deriveCoreWeightLbs,
  deriveFeetAvailableFromRollWeight,
  clampFeetToInitialRange,
  normalizeJobNumberKey,
  requiresFirstReturnCalibration,
} from '../runtimeDeps.mjs';
import { getAllocationReservationState } from '../../../../../shared/domain/filmAllocationReservations.mjs';

function canDeriveCheckInFeetFromWeight(box) {
  return (
    box?.coreWeightLbs !== null &&
    box?.coreWeightLbs !== undefined &&
    box?.lfWeightLbsPerFt !== null &&
    box?.lfWeightLbsPerFt !== undefined &&
    Number(box.lfWeightLbsPerFt) > 0
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

function parseOptionalCurrentFeetOnRoll(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new HttpError(400, 'CurrentFeetOnRoll must be a whole number greater than or equal to 0.');
  }

  return Number(trimmed);
}

function resolveCheckInCoreMetrics(box, payloadCoreType) {
  const submittedCoreType = normalizeCoreType(payloadCoreType, true);
  if (submittedCoreType) {
    return {
      coreType: submittedCoreType,
      coreWeightLbs: deriveCoreWeightLbs(submittedCoreType, box.widthIn),
    };
  }

  const existingCoreType = normalizeCoreType(box.coreType, true);
  if (box.coreWeightLbs !== null && box.coreWeightLbs !== undefined) {
    return {
      coreType: existingCoreType,
      coreWeightLbs: Number(box.coreWeightLbs),
    };
  }

  if (existingCoreType) {
    return {
      coreType: existingCoreType,
      coreWeightLbs: deriveCoreWeightLbs(existingCoreType, box.widthIn),
    };
  }

  return {
    coreType: '',
    coreWeightLbs: null,
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

function planBoxCheckIn(existingBox, payload, allocations, checkoutJobNumber) {
  const lastRollWeightLbs = coerceNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  const normalizedCheckoutJob = normalizeJobNumberKey(checkoutJobNumber);
  const firstReturnCalibration = requiresFirstReturnCalibration(existingBox);
  const currentFeetOnRoll = parseOptionalCurrentFeetOnRoll(payload.currentFeetOnRoll);
  const activeAllocations = Array.isArray(allocations)
    ? allocations.filter((entry) => asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE')
    : [];

  const sameJobActiveAllocations = normalizedCheckoutJob
    ? activeAllocations.filter((entry) => normalizeJobNumberKey(entry.jobNumber) === normalizedCheckoutJob)
    : [];
  const otherActiveAllocations = normalizedCheckoutJob
    ? activeAllocations.filter((entry) => normalizeJobNumberKey(entry.jobNumber) !== normalizedCheckoutJob)
    : activeAllocations;
  const activeLockedAllocatedFeetBeforeCheckIn = activeAllocations.reduce(
    (total, entry) =>
      total +
      (getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? integerOrZero(entry?.allocatedFeet) : 0),
    0
  );
  const sameJobActiveAllocatedFeet = sameJobActiveAllocations.reduce(
    (total, entry) => total + integerOrZero(entry?.allocatedFeet),
    0
  );
  const otherActiveAllocatedFeet = otherActiveAllocations.reduce(
    (total, entry) =>
      total +
      (getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? integerOrZero(entry?.allocatedFeet) : 0),
    0
  );
  const physicalFeetBeforeCheckIn = derivePhysicalFeetBeforeCheckIn(
    existingBox,
    activeLockedAllocatedFeetBeforeCheckIn
  );

  let physicalFeetAfterCheckIn = 0;
  let resolvedCoreType = normalizeCoreType(existingBox.coreType, true);
  let resolvedCoreWeightLbs =
    existingBox.coreWeightLbs === null || existingBox.coreWeightLbs === undefined
      ? null
      : Number(existingBox.coreWeightLbs);
  let resolvedLfWeightLbsPerFt =
    existingBox.lfWeightLbsPerFt === null || existingBox.lfWeightLbsPerFt === undefined
      ? null
      : Number(existingBox.lfWeightLbsPerFt);
  let usedCalibration = false;

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
  if (canDeriveCheckInFeetFromWeight(existingBox)) {
    physicalFeetAfterCheckIn = deriveFeetAvailableFromRollWeight(
      lastRollWeightLbs,
      Number(existingBox.coreWeightLbs),
      Number(existingBox.lfWeightLbsPerFt),
      integerOrZero(existingBox.initialFeet)
    );
  } else {
    if (currentFeetOnRoll === null) {
      throw new HttpError(
        400,
        'CurrentFeetOnRoll is required when this box cannot derive feet from weight alone.'
      );
    }

    if (currentFeetOnRoll > integerOrZero(existingBox.initialFeet)) {
      throw new HttpError(
        400,
        `CurrentFeetOnRoll cannot be greater than this box's InitialFeet (${integerOrZero(existingBox.initialFeet)}).`
      );
    }

    physicalFeetAfterCheckIn = currentFeetOnRoll;
    usedCalibration = true;

    if (currentFeetOnRoll === 0) {
      if (lastRollWeightLbs > 0) {
        throw new HttpError(
          400,
          'CurrentFeetOnRoll cannot be 0 while LastRollWeightLbs is still above 0.'
        );
      }

      resolvedCoreType = normalizeCoreType(payload.coreType, true) || resolvedCoreType;
      if (!resolvedCoreWeightLbs && resolvedCoreType) {
        resolvedCoreWeightLbs = deriveCoreWeightLbs(resolvedCoreType, existingBox.widthIn);
      }
    } else {
      const resolvedCoreMetrics = resolveCheckInCoreMetrics(existingBox, payload.coreType);
      if (resolvedCoreMetrics.coreWeightLbs === null) {
        throw new HttpError(
          400,
          'CoreType is required before this return can establish future weight-based LF math.'
        );
      }

      if (lastRollWeightLbs <= resolvedCoreMetrics.coreWeightLbs) {
        throw new HttpError(
          400,
          'LastRollWeightLbs must be greater than the core weight when CurrentFeetOnRoll is above 0.'
        );
      }

      resolvedCoreType = resolvedCoreMetrics.coreType;
      resolvedCoreWeightLbs = resolvedCoreMetrics.coreWeightLbs;
      resolvedLfWeightLbsPerFt = roundToDecimals(
        (lastRollWeightLbs - resolvedCoreWeightLbs) / currentFeetOnRoll,
        6
      );
    }
  }

  if (otherActiveAllocatedFeet > physicalFeetAfterCheckIn) {
    throw new HttpError(
      400,
      `Received physical LF cannot be lower than the box's active allocated feet (${otherActiveAllocatedFeet}).`
    );
  }

  const feetAvailableAfterCheckIn = Math.max(physicalFeetAfterCheckIn - otherActiveAllocatedFeet, 0);
  const autoMoveToZeroed =
    (Boolean(existingBox.receivedDate) || firstReturnCalibration) &&
    integerOrZero(existingBox.initialFeet) > 0 &&
    (physicalFeetAfterCheckIn === 0 || lastRollWeightLbs === 0);

  return {
    lastRollWeightLbs,
    currentFeetOnRoll,
    physicalFeetBeforeCheckIn,
    physicalFeetAfterCheckIn,
    feetAvailableAfterCheckIn,
    sameJobActiveAllocationCount: sameJobActiveAllocations.length,
    sameJobActiveAllocatedFeet,
    otherActiveAllocatedFeet,
    otherJobs: summarizeOtherJobs(otherActiveAllocations),
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    usedCalibration,
    autoMoveToZeroed,
  };
}

export {
  canDeriveCheckInFeetFromWeight,
  canDeriveStoredPhysicalFeetFromWeight,
  derivePhysicalFeetBeforeCheckIn,
  planBoxCheckIn,
};
