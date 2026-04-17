function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizeJobNumberKey(jobNumber) {
  return asTrimmedString(jobNumber).toUpperCase();
}

function normalizeCrewLeaderKey(crewLeader) {
  return asTrimmedString(crewLeader).toUpperCase();
}

function hasResolvedAllocation(entry) {
  return Boolean(asTrimmedString(entry?.resolvedAt ?? entry?.resolved_at));
}

function isActiveUnresolvedAllocation(entry) {
  return asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE' && !hasResolvedAllocation(entry);
}

function normalizeBoxFilter(boxIds) {
  if (!boxIds) {
    return null;
  }

  if (Array.isArray(boxIds)) {
    const normalized = {};
    for (let index = 0; index < boxIds.length; index += 1) {
      const boxId = asTrimmedString(boxIds[index]);
      if (boxId) {
        normalized[boxId] = true;
      }
    }
    return normalized;
  }

  return boxIds;
}

function getSameDayCrewConflictJobs(targetJobContext, allocations, options = {}) {
  const normalizedInstallDate = asTrimmedString(
    targetJobContext?.installDate ?? targetJobContext?.jobDate ?? targetJobContext?.job_date
  );
  if (!normalizedInstallDate) {
    return [];
  }

  const normalizedTargetJobNumber = normalizeJobNumberKey(
    targetJobContext?.jobNumber ?? targetJobContext?.job_number
  );
  const normalizedTargetCrewLeader = normalizeCrewLeaderKey(
    targetJobContext?.crewLeader ?? targetJobContext?.crew_leader
  );
  const allowedBoxIds = normalizeBoxFilter(options.boxIds);
  const conflicts = [];
  const seen = {};
  const source = Array.isArray(allocations) ? allocations : [];

  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    if (!isActiveUnresolvedAllocation(entry)) {
      continue;
    }

    const boxId = asTrimmedString(entry?.boxId ?? entry?.box_id);
    if (allowedBoxIds && !allowedBoxIds[boxId]) {
      continue;
    }

    if (
      normalizeJobNumberKey(entry?.jobNumber ?? entry?.job_number) === normalizedTargetJobNumber ||
      asTrimmedString(entry?.installDate ?? entry?.jobDate ?? entry?.job_date) !== normalizedInstallDate ||
      normalizeCrewLeaderKey(entry?.crewLeader ?? entry?.crew_leader) === normalizedTargetCrewLeader
    ) {
      continue;
    }

    const conflictingJobNumber = asTrimmedString(entry?.jobNumber ?? entry?.job_number);
    if (!conflictingJobNumber || seen[conflictingJobNumber]) {
      continue;
    }

    seen[conflictingJobNumber] = true;
    conflicts.push(conflictingJobNumber);
  }

  return conflicts;
}

function hasSameDayCrewConflict(targetJobContext, allocations, options = {}) {
  return getSameDayCrewConflictJobs(targetJobContext, allocations, options).length > 0;
}

export {
  getSameDayCrewConflictJobs,
  hasSameDayCrewConflict,
  hasResolvedAllocation,
  isActiveUnresolvedAllocation,
};
