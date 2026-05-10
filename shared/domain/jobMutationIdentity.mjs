// Purpose: Shared normalization/validation for job mutation identity during the jobId transition.
function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function normalizeWithOptionalJobNumberNormalizer(value, normalizeJobNumber) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return '';
  }

  if (typeof normalizeJobNumber === 'function') {
    return normalizeJobNumber(trimmed, 'JobNumber');
  }

  return trimmed;
}

export function normalizeJobMutationIdentityInput(payload = {}, options = {}) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const normalizeJobNumber = options.normalizeJobNumberDigits || options.normalizeJobNumber;
  const jobId = asTrimmedString(record.jobId);
  const jobNumber = normalizeWithOptionalJobNumberNormalizer(record.jobNumber, normalizeJobNumber);

  return {
    jobId,
    jobNumber,
    hasJobId: Boolean(jobId),
    hasJobNumber: Boolean(jobNumber),
  };
}

export function getResolvedJobIdentity(job = {}, options = {}) {
  const normalizeJobNumber = options.normalizeJobNumberDigits || options.normalizeJobNumber;
  const record = job && typeof job === 'object' && !Array.isArray(job) ? job : {};
  const jobId = asTrimmedString(record.id || record.jobId || record.job_id);
  const jobNumber = normalizeWithOptionalJobNumberNormalizer(
    record.jobNumber || record.job_number,
    normalizeJobNumber
  );

  return {
    jobId,
    jobNumber,
  };
}

export function validateResolvedJobMutationIdentity(input, resolvedJob, options = {}) {
  const normalizedInput = normalizeJobMutationIdentityInput(input, options);
  const resolvedIdentity = getResolvedJobIdentity(resolvedJob, options);

  if (normalizedInput.hasJobNumber && resolvedIdentity.jobNumber !== normalizedInput.jobNumber) {
    return {
      ok: false,
      reason: 'JOB_ID_JOB_NUMBER_MISMATCH',
      status: 409,
      jobId: normalizedInput.jobId,
      jobNumber: normalizedInput.jobNumber,
      resolvedJobNumber: resolvedIdentity.jobNumber,
      message: `Job identity mismatch: jobId ${normalizedInput.jobId} belongs to job ${resolvedIdentity.jobNumber || '(unknown)'}, not ${normalizedInput.jobNumber}.`,
    };
  }

  return {
    ok: true,
    reason: 'MATCH',
    jobId: normalizedInput.jobId || resolvedIdentity.jobId,
    jobNumber: normalizedInput.jobNumber || resolvedIdentity.jobNumber,
    resolvedJobNumber: resolvedIdentity.jobNumber,
  };
}
