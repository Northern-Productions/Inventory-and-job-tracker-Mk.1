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

function isPhysicalFilmReservationBoxStatus(status) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === 'IN_STOCK' || normalizedStatus === 'TRANSFER';
}

function isOrderedFilmReservationBoxStatus(status) {
  return asTrimmedString(status).toUpperCase() === 'ORDERED';
}

function getActiveReservationEntries(allocations) {
  const source = Array.isArray(allocations) ? allocations : [];
  return source.filter(
    (entry) =>
      asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE' && integerOrZero(entry?.allocatedFeet) > 0
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
  const activeEntries = getActiveReservationEntries(allocations);
  const activeScheduledEntries = activeEntries
    .filter((entry) => getAllocationReservationState(entry) === 'WITH_INSTALL_DATE')
    .slice()
    .sort((left, right) => compareScheduledReservationEntries(left, right, options));
  const activePlaceholderEntries = activeEntries
    .filter((entry) => getAllocationReservationState(entry) === 'WITHOUT_INSTALL_DATE')
    .slice()
    .sort((left, right) => comparePlaceholderReservationEntries(left, right, options));
  const allocatedWithInstallDateFeet = sumAllocatedFeet(activeScheduledEntries);
  const allocatedWithoutInstallDateFeet = sumAllocatedFeet(activePlaceholderEntries);
  const activeAllocatedFeet = allocatedWithInstallDateFeet + allocatedWithoutInstallDateFeet;
  const allocationSnapshotsById = {};

  if (isOrderedFilmReservationBoxStatus(box?.status)) {
    const allocatableNowFeet = Math.max(0, integerOrZero(box?.initialFeet) - activeAllocatedFeet);
    for (let index = 0; index < activeEntries.length; index += 1) {
      const entry = activeEntries[index];
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

  if (!isPhysicalFilmReservationBoxStatus(box?.status)) {
    for (let index = 0; index < activeEntries.length; index += 1) {
      const entry = activeEntries[index];
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
  const physicalFeetAvailable =
    explicitPhysicalFeet === null
      ? Math.max(0, integerOrZero(box?.feetAvailable) + allocatedWithInstallDateFeet)
      : explicitPhysicalFeet;
  let remainingPhysicalFeet = physicalFeetAvailable;
  const prioritizedEntries = [...activeScheduledEntries, ...activePlaceholderEntries];

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
    allocatableNowFeet: Math.max(0, physicalFeetAvailable - allocatedWithInstallDateFeet),
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    activeAllocatedFeet,
    allocationSnapshotsById,
  };
}

export {
  buildBoxReservationSnapshot,
  comparePlaceholderReservationEntries,
  compareScheduledReservationEntries,
  getActiveReservationEntries,
  getAllocationReservationState,
  getJobCreatedAtForAllocation,
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
  normalizeReservationState,
  sumAllocatedFeet,
};
