import {
  buildBoxReservationSnapshot,
  getAllocationReservationState,
  getCapacityReservationEntries,
  getStoredPhysicalFootprintEntries,
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
  sumAllocatedFeet,
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

function buildJobCreatedAtIndexes(jobs) {
  const source = Array.isArray(jobs) ? jobs : [];
  const createdAtByJobNumber = {};
  const createdAtByJobId = {};

  for (let index = 0; index < source.length; index += 1) {
    const jobId = asTrimmedString(source[index]?.id || source[index]?.jobId);
    const createdAt = asTrimmedString(source[index]?.createdAt);
    if (jobId && createdAt) {
      createdAtByJobId[jobId] = createdAt;
    }

    const jobNumber = asTrimmedString(source[index]?.jobNumber);
    if (!jobNumber) {
      continue;
    }

    if (!createdAt) {
      continue;
    }

    if (!createdAtByJobNumber[jobNumber] || createdAt < createdAtByJobNumber[jobNumber]) {
      createdAtByJobNumber[jobNumber] = createdAt;
    }
  }

  return {
    byJobId: createdAtByJobId,
    byJobNumber: createdAtByJobNumber,
  };
}

function buildJobCreatedAtByJobNumber(jobs) {
  return buildJobCreatedAtIndexes(jobs).byJobNumber;
}

function buildJobCreatedAtByJobId(jobs) {
  return buildJobCreatedAtIndexes(jobs).byJobId;
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

  return Math.max(0, integerOrZero(box?.feetAvailable) + sumAllocatedFeet(getStoredPhysicalFootprintEntries(allocations, box)));
}

function buildBoxReservationMetrics(box, allocations = [], options = {}) {
  const createdAtIndexes = options.jobs
    ? buildJobCreatedAtIndexes(options.jobs)
    : { byJobId: {}, byJobNumber: {} };
  const jobCreatedAtByJobId =
    options.jobCreatedAtByJobId || createdAtIndexes.byJobId;
  const jobCreatedAtByJobNumber =
    options.jobCreatedAtByJobNumber || createdAtIndexes.byJobNumber;
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
      jobCreatedAtByJobId,
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
  const source = getCapacityReservationEntries(entries);
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
  const source = getCapacityReservationEntries(entries);
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
  buildJobCreatedAtByJobId,
  buildJobCreatedAtByJobNumber,
  buildJobCreatedAtIndexes,
  canDeriveBoxPhysicalFeet,
  deriveBoxPhysicalFeetAvailable,
  getActivePlaceholderAllocatedFeet,
  getActiveScheduledAllocatedFeet,
};
