import {
  buildBoxReservationSnapshot,
  getActiveReservationEntries,
  getAllocationReservationState,
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
} from '../../../../../shared/domain/filmAllocationReservations.mjs';
import {
  asTrimmedString,
  computeAllocationPlanningFeet,
  deriveFeetAvailableFromRollWeight,
  integerOrZero,
} from '../runtimeDeps.mjs';

function canDeriveBoxPhysicalFeet(box) {
  return (
    box &&
    box.lastRollWeightLbs !== null &&
    box.lastRollWeightLbs !== undefined &&
    box.coreWeightLbs !== null &&
    box.coreWeightLbs !== undefined &&
    box.lfWeightLbsPerFt !== null &&
    box.lfWeightLbsPerFt !== undefined &&
    Number(box.lfWeightLbsPerFt) > 0
  );
}

function buildJobCreatedAtByJobNumber(jobs) {
  const source = Array.isArray(jobs) ? jobs : [];
  const createdAtByJobNumber = {};

  for (let index = 0; index < source.length; index += 1) {
    const jobNumber = asTrimmedString(source[index]?.jobNumber);
    if (!jobNumber) {
      continue;
    }

    const createdAt = asTrimmedString(source[index]?.createdAt);
    if (!createdAt) {
      continue;
    }

    if (!createdAtByJobNumber[jobNumber] || createdAt < createdAtByJobNumber[jobNumber]) {
      createdAtByJobNumber[jobNumber] = createdAt;
    }
  }

  return createdAtByJobNumber;
}

function deriveBoxPhysicalFeetAvailable(box, allocations = []) {
  if (!isPhysicalFilmReservationBoxStatus(box?.status)) {
    return null;
  }

  if (canDeriveBoxPhysicalFeet(box)) {
    return deriveFeetAvailableFromRollWeight(
      Number(box.lastRollWeightLbs),
      Number(box.coreWeightLbs),
      Number(box.lfWeightLbsPerFt),
      integerOrZero(box.initialFeet)
    );
  }

  let scheduledFeet = 0;
  const activeEntries = getActiveReservationEntries(allocations);
  for (let index = 0; index < activeEntries.length; index += 1) {
    if (getAllocationReservationState(activeEntries[index]) === 'WITH_INSTALL_DATE') {
      scheduledFeet += integerOrZero(activeEntries[index].allocatedFeet);
    }
  }

  return Math.max(0, integerOrZero(box?.feetAvailable) + scheduledFeet);
}

function buildBoxReservationMetrics(box, allocations = [], options = {}) {
  const jobCreatedAtByJobNumber =
    options.jobCreatedAtByJobNumber || buildJobCreatedAtByJobNumber(options.jobs || []);
  const physicalFeetAvailableOverride =
    options.physicalFeetAvailable !== undefined && options.physicalFeetAvailable !== null
      ? integerOrZero(options.physicalFeetAvailable)
      : deriveBoxPhysicalFeetAvailable(box, allocations);
  return buildBoxReservationSnapshot(
    {
      ...box,
      physicalFeetAvailable: physicalFeetAvailableOverride,
    },
    allocations,
    {
      jobCreatedAtByJobNumber,
    }
  );
}

function applyReservationMetricsToBox(box, allocations = [], options = {}) {
  if (!box) {
    return box;
  }

  const metrics = buildBoxReservationMetrics(box, allocations, options);
  const normalizedFeetAvailable = isPhysicalFilmReservationBoxStatus(box.status)
    ? metrics.allocatableNowFeet
    : integerOrZero(box.feetAvailable);
  const nextAllocationPlanningFeet = isOrderedFilmReservationBoxStatus(box.status)
    ? computeAllocationPlanningFeet(box.status, box.initialFeet, box.feetAvailable, metrics.activeAllocatedFeet)
    : isPhysicalFilmReservationBoxStatus(box.status)
      ? metrics.allocatableNowFeet
      : computeAllocationPlanningFeet(box.status, box.initialFeet, normalizedFeetAvailable, metrics.activeAllocatedFeet);

  return {
    ...box,
    feetAvailable: normalizedFeetAvailable,
    physicalFeetAvailable:
      metrics.physicalFeetAvailable === null ? null : integerOrZero(metrics.physicalFeetAvailable),
    activeAllocatedFeet: metrics.activeAllocatedFeet,
    allocatedWithInstallDateFeet: metrics.allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet: metrics.allocatedWithoutInstallDateFeet,
    allocatableNowFeet: metrics.allocatableNowFeet,
    allocationPlanningFeet: nextAllocationPlanningFeet,
  };
}

function getActiveScheduledAllocatedFeet(entries = []) {
  let total = 0;
  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    if (
      asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE' &&
      getAllocationReservationState(entry) === 'WITH_INSTALL_DATE'
    ) {
      total += integerOrZero(entry?.allocatedFeet);
    }
  }

  return total;
}

function getActivePlaceholderAllocatedFeet(entries = []) {
  let total = 0;
  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    if (
      asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE' &&
      getAllocationReservationState(entry) === 'WITHOUT_INSTALL_DATE'
    ) {
      total += integerOrZero(entry?.allocatedFeet);
    }
  }

  return total;
}

export {
  applyReservationMetricsToBox,
  buildBoxReservationMetrics,
  buildJobCreatedAtByJobNumber,
  canDeriveBoxPhysicalFeet,
  deriveBoxPhysicalFeetAvailable,
  getActivePlaceholderAllocatedFeet,
  getActiveScheduledAllocatedFeet,
};
