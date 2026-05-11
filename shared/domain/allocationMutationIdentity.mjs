// Purpose: Shared allocation ownership validation for jobId-transition mutation guards.
function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function readFirst(record, keys) {
  const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function normalizeJobNumber(value, options = {}) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return '';
  }

  if (typeof options.normalizeJobNumberDigits === 'function') {
    return options.normalizeJobNumberDigits(trimmed, 'JobNumber');
  }

  if (typeof options.normalizeJobNumber === 'function') {
    return options.normalizeJobNumber(trimmed, 'JobNumber');
  }

  return trimmed;
}

export function getAllocationJobIdentity(allocation = {}, options = {}) {
  return {
    allocationId: asTrimmedString(readFirst(allocation, ['allocationId', 'allocation_id', 'id'])),
    jobId: asTrimmedString(readFirst(allocation, ['jobId', 'job_id'])),
    jobNumber: normalizeJobNumber(readFirst(allocation, ['jobNumber', 'job_number']), options),
  };
}

export function getMutationTargetJobIdentity(target = {}, options = {}) {
  return {
    jobId: asTrimmedString(readFirst(target, ['jobId', 'job_id', 'id'])),
    jobNumber: normalizeJobNumber(readFirst(target, ['jobNumber', 'job_number']), options),
  };
}

export function validateAllocationJobMutationOwnership({
  allocation,
  allocationId,
  target,
  normalizeJobNumberDigits,
  normalizeJobNumber,
} = {}) {
  const requestedAllocationId = asTrimmedString(allocationId);
  if (!allocation) {
    return {
      ok: false,
      reason: 'ALLOCATION_NOT_FOUND',
      status: 404,
      message: `Allocation ${requestedAllocationId || '(unknown)'} was not found.`,
    };
  }

  const options = { normalizeJobNumberDigits, normalizeJobNumber };
  const allocationIdentity = getAllocationJobIdentity(allocation, options);
  const targetIdentity = getMutationTargetJobIdentity(target, options);

  if (!targetIdentity.jobId) {
    return {
      ok: false,
      reason: 'MISSING_TARGET_JOB_ID',
      status: 400,
      message: 'A jobId is required to validate allocation ownership.',
    };
  }

  if (!allocationIdentity.jobId) {
    return {
      ok: false,
      reason: 'MISSING_ALLOCATION_JOB_ID',
      status: 409,
      message: `Allocation ${allocationIdentity.allocationId || requestedAllocationId || '(unknown)'} does not have job ownership and cannot be safely removed from a canonical jobId route.`,
    };
  }

  if (allocationIdentity.jobId !== targetIdentity.jobId) {
    return {
      ok: false,
      reason: 'ALLOCATION_JOB_ID_MISMATCH',
      status: 409,
      message: `Allocation ${allocationIdentity.allocationId || requestedAllocationId || '(unknown)'} belongs to a different job.`,
      allocationJobId: allocationIdentity.jobId,
      targetJobId: targetIdentity.jobId,
    };
  }

  if (
    allocationIdentity.jobNumber &&
    targetIdentity.jobNumber &&
    allocationIdentity.jobNumber !== targetIdentity.jobNumber
  ) {
    return {
      ok: false,
      reason: 'ALLOCATION_JOB_NUMBER_MISMATCH',
      status: 409,
      message: `Allocation ${allocationIdentity.allocationId || requestedAllocationId || '(unknown)'} belongs to job ${allocationIdentity.jobNumber}, not ${targetIdentity.jobNumber}.`,
      allocationJobNumber: allocationIdentity.jobNumber,
      targetJobNumber: targetIdentity.jobNumber,
    };
  }

  return {
    ok: true,
    reason: 'MATCH',
    allocationId: allocationIdentity.allocationId || requestedAllocationId,
    jobId: targetIdentity.jobId,
    jobNumber: targetIdentity.jobNumber || allocationIdentity.jobNumber,
  };
}
