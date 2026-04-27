function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.floor(parsed));
}

function compareAscendingStrings(left, right) {
  if (left === right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return left < right ? -1 : 1;
}

function normalizeReservationState(value) {
  return asTrimmedString(value) ? 'WITH_INSTALL_DATE' : 'WITHOUT_INSTALL_DATE';
}

function normalizeAllocationKind(value) {
  return asTrimmedString(value).toUpperCase() === 'EXTRA' ? 'EXTRA' : 'REQUIREMENT';
}

function normalizeAllocationSource(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (
    normalized === 'AUTO_PLANNED' ||
    normalized === 'FILM_ORDER_RECEIPT' ||
    normalized === 'DIRECT_TO_JOB_SITE'
  ) {
    return normalized;
  }

  return 'MANUAL';
}

function isPhysicalFilmReservationBoxStatus(status) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === 'IN_STOCK' || normalizedStatus === 'TRANSFER';
}

function isOrderedFilmReservationBoxStatus(status) {
  return asTrimmedString(status).toUpperCase() === 'ORDERED';
}

function isCheckedOutFilmReservationBoxStatus(status) {
  return asTrimmedString(status).toUpperCase() === 'CHECKED_OUT';
}

function getAllocationStatus(entry) {
  return asTrimmedString(entry?.status).toUpperCase();
}

function getAllocationRequirementId(entry) {
  return asTrimmedString(entry?.requirementId ?? entry?.requirement_id);
}

function isRequirementAllocationEntry(entry) {
  return normalizeAllocationKind(entry?.allocationKind ?? entry?.allocation_kind) === 'REQUIREMENT';
}

function isRequirementAllocationWithRequirement(entry) {
  return isRequirementAllocationEntry(entry) && Boolean(getAllocationRequirementId(entry));
}

function allocationHasJobTie(entry) {
  return Boolean(
    asTrimmedString(entry?.jobNumber ?? entry?.job_number) ||
    asTrimmedString(entry?.jobId ?? entry?.job_id)
  );
}

function isRequirementBoundReservationEntry(entry) {
  return isRequirementAllocationWithRequirement(entry) && allocationHasJobTie(entry);
}

/**
 * PURPOSE:
 * Defines the one capacity-reservation rule for film boxes.
 *
 * AFFECTS:
 * Allocation modal candidates, backend preview/apply guards, Edge mirrors,
 * planner SQL parity, checked-out box visibility, and job requirement coverage.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * runtimeAllocationReservations.mjs, core/helpers.mjs, SQL allocation
 * availability functions, Edge read/mutation handlers, and modal tests.
 *
 * COMMON FAILURE MODES:
 * Offering AUTO_PLANNED LF twice, counting EXTRA/placeholders as reserved,
 * losing fulfilled checked-out allocations, or trusting allocationPlanningFeet.
 */
function allocationReservesCapacity(entry, box) {
  if (!isRequirementBoundReservationEntry(entry) || integerOrZero(entry?.allocatedFeet) <= 0) {
    return false;
  }

  const status = getAllocationStatus(entry);
  const isCheckedOutBox = isCheckedOutFilmReservationBoxStatus(box?.status);

  if (status === 'ACTIVE') {
    return true;
  }

  if (status === 'FULFILLED') {
    return isCheckedOutBox;
  }

  return false;
}

function allocationConsumesStoredPhysicalFeet(entry, box) {
  const allocationSource = normalizeAllocationSource(entry?.allocationSource ?? entry?.allocation_source);
  const isPhysicalCommitment =
    getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' || allocationSource === 'FILM_ORDER_RECEIPT';

  return (
    allocationReservesCapacity(entry, box) &&
    getAllocationStatus(entry) === 'ACTIVE' &&
    isPhysicalCommitment &&
    isPhysicalFilmReservationBoxStatus(box?.status) &&
    allocationSource !== 'AUTO_PLANNED'
  );
}

function getActiveReservationEntries(allocations, box = null) {
  const source = Array.isArray(allocations) ? allocations : [];
  return source.filter((entry) => getAllocationStatus(entry) === 'ACTIVE' && allocationReservesCapacity(entry, box));
}

function getCapacityReservationEntries(allocations, box = null) {
  const source = Array.isArray(allocations) ? allocations : [];
  return source.filter((entry) => allocationReservesCapacity(entry, box));
}

function getStoredPhysicalFootprintEntries(allocations, box = null) {
  const source = Array.isArray(allocations) ? allocations : [];
  return source.filter((entry) => allocationConsumesStoredPhysicalFeet(entry, box));
}

function getNonReservingPlaceholderEntries(allocations, box = null) {
  const source = Array.isArray(allocations) ? allocations : [];
  return source.filter(
    (entry) =>
      getAllocationStatus(entry) === 'ACTIVE' &&
      isRequirementAllocationWithRequirement(entry) &&
      integerOrZero(entry?.allocatedFeet) > 0 &&
      !allocationReservesCapacity(entry, box)
  );
}

function getAllocationReservationState(entry) {
  return normalizeReservationState(entry?.installDate ?? entry?.jobDate ?? entry?.job_date);
}

function getJobCreatedAtForAllocation(entry, options = {}) {
  if (typeof options.getJobCreatedAt === 'function') {
    const resolved = asTrimmedString(options.getJobCreatedAt(entry));
    if (resolved) {
      return resolved;
    }
  }

  const jobNumber = asTrimmedString(entry?.jobNumber ?? entry?.job_number);
  if (jobNumber && options.jobCreatedAtByJobNumber) {
    const resolved = asTrimmedString(options.jobCreatedAtByJobNumber[jobNumber]);
    if (resolved) {
      return resolved;
    }
  }

  return asTrimmedString(entry?.createdAt ?? entry?.created_at);
}

function compareScheduledReservationEntries(left, right, options = {}) {
  const installDateCompare = compareAscendingStrings(
    asTrimmedString(left?.installDate ?? left?.jobDate ?? left?.job_date),
    asTrimmedString(right?.installDate ?? right?.jobDate ?? right?.job_date)
  );
  if (installDateCompare !== 0) {
    return installDateCompare;
  }

  const jobCreatedAtCompare = compareAscendingStrings(
    getJobCreatedAtForAllocation(left, options),
    getJobCreatedAtForAllocation(right, options)
  );
  if (jobCreatedAtCompare !== 0) {
    return jobCreatedAtCompare;
  }

  const allocationCreatedAtCompare = compareAscendingStrings(
    asTrimmedString(left?.createdAt ?? left?.created_at),
    asTrimmedString(right?.createdAt ?? right?.created_at)
  );
  if (allocationCreatedAtCompare !== 0) {
    return allocationCreatedAtCompare;
  }

  return compareAscendingStrings(
    asTrimmedString(left?.allocationId ?? left?.allocation_id),
    asTrimmedString(right?.allocationId ?? right?.allocation_id)
  );
}

function comparePlaceholderReservationEntries(left, right, options = {}) {
  const jobCreatedAtCompare = compareAscendingStrings(
    getJobCreatedAtForAllocation(left, options),
    getJobCreatedAtForAllocation(right, options)
  );
  if (jobCreatedAtCompare !== 0) {
    return jobCreatedAtCompare;
  }

  const allocationCreatedAtCompare = compareAscendingStrings(
    asTrimmedString(left?.createdAt ?? left?.created_at),
    asTrimmedString(right?.createdAt ?? right?.created_at)
  );
  if (allocationCreatedAtCompare !== 0) {
    return allocationCreatedAtCompare;
  }

  return compareAscendingStrings(
    asTrimmedString(left?.allocationId ?? left?.allocation_id),
    asTrimmedString(right?.allocationId ?? right?.allocation_id)
  );
}

function sumAllocatedFeet(entries) {
  let total = 0;
  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    total += integerOrZero(source[index]?.allocatedFeet);
  }

  return total;
}

function resolveExplicitPhysicalFeet(box) {
  if (
    box &&
    box.physicalFeetAvailable !== undefined &&
    box.physicalFeetAvailable !== null &&
    Number.isFinite(Number(box.physicalFeetAvailable))
  ) {
    return integerOrZero(box.physicalFeetAvailable);
  }

  return null;
}

function buildBoxReservationSnapshot(box, allocations, options = {}) {
  const reservationEntries = getCapacityReservationEntries(allocations, box);
  const activeEntries = reservationEntries.filter((entry) => getAllocationStatus(entry) === 'ACTIVE');
  const nonReservingPlaceholderEntries = getNonReservingPlaceholderEntries(allocations, box);
  const activeScheduledEntries = activeEntries
    .filter((entry) => getAllocationReservationState(entry) === 'WITH_INSTALL_DATE')
    .slice()
    .sort((left, right) => compareScheduledReservationEntries(left, right, options));
  const activeUnscheduledReservationEntries = activeEntries
    .filter((entry) => getAllocationReservationState(entry) === 'WITHOUT_INSTALL_DATE')
    .slice()
    .sort((left, right) => comparePlaceholderReservationEntries(left, right, options));
  const fulfilledCheckedOutEntries = reservationEntries
    .filter((entry) => getAllocationStatus(entry) === 'FULFILLED')
    .slice()
    .sort((left, right) => compareScheduledReservationEntries(left, right, options));
  const allocatedWithInstallDateFeet = sumAllocatedFeet(activeScheduledEntries);
  const allocatedWithoutInstallDateFeet = sumAllocatedFeet(activeUnscheduledReservationEntries);
  const activeAllocatedFeet = sumAllocatedFeet(reservationEntries);
  const allocationSnapshotsById = {};

  for (let index = 0; index < nonReservingPlaceholderEntries.length; index += 1) {
    const entry = nonReservingPlaceholderEntries[index];
    const allocationId = asTrimmedString(entry?.allocationId ?? entry?.allocation_id);
    allocationSnapshotsById[allocationId] = {
      allocationId,
      reservationState: getAllocationReservationState(entry),
      backedPhysicalFeet: 0,
      shortageFeet: 0,
    };
  }

  if (isOrderedFilmReservationBoxStatus(box?.status)) {
    const allocatableNowFeet = Math.max(0, integerOrZero(box?.initialFeet) - activeAllocatedFeet);
    for (let index = 0; index < reservationEntries.length; index += 1) {
      const entry = reservationEntries[index];
      const allocationId = asTrimmedString(entry?.allocationId ?? entry?.allocation_id);
      allocationSnapshotsById[allocationId] = {
        allocationId,
        reservationState: getAllocationReservationState(entry),
        backedPhysicalFeet: integerOrZero(entry?.allocatedFeet),
        shortageFeet: 0,
      };
    }

    return {
      physicalFeetAvailable: null,
      allocatableNowFeet,
      allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet,
      activeAllocatedFeet,
      allocationSnapshotsById,
    };
  }

  if (isCheckedOutFilmReservationBoxStatus(box?.status)) {
    const explicitPhysicalFeet = resolveExplicitPhysicalFeet(box);
    const physicalFeetAvailable =
      explicitPhysicalFeet === null ? integerOrZero(box?.initialFeet) : explicitPhysicalFeet;
    let remainingPhysicalFeet = physicalFeetAvailable;
    const prioritizedEntries = [
      ...activeScheduledEntries,
      ...activeUnscheduledReservationEntries,
      ...fulfilledCheckedOutEntries,
    ];

    for (let index = 0; index < prioritizedEntries.length; index += 1) {
      const entry = prioritizedEntries[index];
      const allocationId = asTrimmedString(entry?.allocationId ?? entry?.allocation_id);
      const allocatedFeet = integerOrZero(entry?.allocatedFeet);
      const backedPhysicalFeet = Math.min(allocatedFeet, remainingPhysicalFeet);
      remainingPhysicalFeet = Math.max(0, remainingPhysicalFeet - backedPhysicalFeet);
      allocationSnapshotsById[allocationId] = {
        allocationId,
        reservationState: getAllocationReservationState(entry),
        backedPhysicalFeet,
        shortageFeet: Math.max(0, allocatedFeet - backedPhysicalFeet),
      };
    }

    return {
      physicalFeetAvailable,
      allocatableNowFeet: 0,
      allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet,
      activeAllocatedFeet,
      allocationSnapshotsById,
    };
  }

  if (!isPhysicalFilmReservationBoxStatus(box?.status)) {
    for (let index = 0; index < reservationEntries.length; index += 1) {
      const entry = reservationEntries[index];
      const allocationId = asTrimmedString(entry?.allocationId ?? entry?.allocation_id);
      allocationSnapshotsById[allocationId] = {
        allocationId,
        reservationState: getAllocationReservationState(entry),
        backedPhysicalFeet: 0,
        shortageFeet: integerOrZero(entry?.allocatedFeet),
      };
    }

    return {
      physicalFeetAvailable: null,
      allocatableNowFeet: 0,
      allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet,
      activeAllocatedFeet,
      allocationSnapshotsById,
    };
  }

  const explicitPhysicalFeet = resolveExplicitPhysicalFeet(box);
  const storedPhysicalFootprintFeet = sumAllocatedFeet(getStoredPhysicalFootprintEntries(allocations, box));
  const physicalFeetAvailable =
    explicitPhysicalFeet === null
      ? Math.max(0, integerOrZero(box?.feetAvailable) + storedPhysicalFootprintFeet)
      : explicitPhysicalFeet;
  let remainingPhysicalFeet = physicalFeetAvailable;
  const prioritizedEntries = [...activeScheduledEntries, ...activeUnscheduledReservationEntries];

  for (let index = 0; index < prioritizedEntries.length; index += 1) {
    const entry = prioritizedEntries[index];
    const allocationId = asTrimmedString(entry?.allocationId ?? entry?.allocation_id);
    const allocatedFeet = integerOrZero(entry?.allocatedFeet);
    const backedPhysicalFeet = Math.min(allocatedFeet, remainingPhysicalFeet);
    remainingPhysicalFeet = Math.max(0, remainingPhysicalFeet - backedPhysicalFeet);
    allocationSnapshotsById[allocationId] = {
      allocationId,
      reservationState: getAllocationReservationState(entry),
      backedPhysicalFeet,
      shortageFeet: Math.max(0, allocatedFeet - backedPhysicalFeet),
    };
  }

  return {
    physicalFeetAvailable,
    allocatableNowFeet: Math.max(0, physicalFeetAvailable - activeAllocatedFeet),
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    activeAllocatedFeet,
    allocationSnapshotsById,
  };
}

export {
  allocationConsumesStoredPhysicalFeet,
  allocationReservesCapacity,
  buildBoxReservationSnapshot,
  comparePlaceholderReservationEntries,
  compareScheduledReservationEntries,
  getActiveReservationEntries,
  getAllocationReservationState,
  getCapacityReservationEntries,
  getJobCreatedAtForAllocation,
  getStoredPhysicalFootprintEntries,
  isCheckedOutFilmReservationBoxStatus,
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
  isRequirementBoundReservationEntry,
  normalizeAllocationKind,
  normalizeAllocationSource,
  normalizeReservationState,
  sumAllocatedFeet,
};
