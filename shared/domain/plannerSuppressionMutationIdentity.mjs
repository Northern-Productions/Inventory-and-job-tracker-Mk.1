// Purpose: Shared requirement ownership validation for planner suppression jobId-transition guards.
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

function normalizeJobNumberValue(value, options = {}) {
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

export function normalizePlannerSuppressionMaterialType(value) {
  const normalized = asTrimmedString(value || 'FILM').toUpperCase();
  if (!normalized) {
    return 'FILM';
  }
  return normalized;
}

export function getPlannerSuppressionRequirementIdentity(requirement = {}, options = {}) {
  return {
    requirementId: asTrimmedString(readFirst(requirement, ['requirementId', 'requirement_id', 'id'])),
    jobId: asTrimmedString(readFirst(requirement, ['jobId', 'job_id'])),
    jobNumber: normalizeJobNumberValue(readFirst(requirement, ['jobNumber', 'job_number']), options),
  };
}

export function validatePlannerSuppressionRequirementOwnership({
  requirement,
  requirementId,
  materialType,
  target,
  normalizeJobNumberDigits,
  normalizeJobNumber,
} = {}) {
  const normalizedMaterialType = normalizePlannerSuppressionMaterialType(materialType);
  if (normalizedMaterialType !== 'FILM' && normalizedMaterialType !== 'CAULK') {
    return {
      ok: false,
      reason: 'UNSUPPORTED_MATERIAL_TYPE',
      status: 400,
      message: 'materialType must be FILM or CAULK.',
    };
  }

  const requestedRequirementId = asTrimmedString(requirementId);
  const materialLabel = normalizedMaterialType === 'CAULK' ? 'Caulk' : 'Film';
  if (!requirement) {
    return {
      ok: false,
      reason: 'REQUIREMENT_NOT_FOUND',
      status: 404,
      message: `${materialLabel} requirement ${requestedRequirementId || '(unknown)'} was not found.`,
    };
  }

  const options = { normalizeJobNumberDigits, normalizeJobNumber };
  const requirementIdentity = getPlannerSuppressionRequirementIdentity(requirement, options);
  const targetJobId = asTrimmedString(readFirst(target, ['jobId', 'job_id', 'id']));
  const targetJobNumber = normalizeJobNumberValue(
    readFirst(target, ['jobNumber', 'job_number']),
    options
  );

  if (!targetJobId) {
    return {
      ok: false,
      reason: 'MISSING_TARGET_JOB_ID',
      status: 400,
      message: 'A jobId is required to validate planner suppression ownership.',
    };
  }

  if (!requirementIdentity.jobId) {
    return {
      ok: false,
      reason: 'MISSING_REQUIREMENT_JOB_ID',
      status: 409,
      message: `${materialLabel} requirement ${requirementIdentity.requirementId || requestedRequirementId || '(unknown)'} does not have job ownership and cannot be safely resumed from a canonical jobId route.`,
    };
  }

  if (requirementIdentity.jobId !== targetJobId) {
    return {
      ok: false,
      reason: 'REQUIREMENT_JOB_ID_MISMATCH',
      status: 409,
      message: `${materialLabel} requirement ${requirementIdentity.requirementId || requestedRequirementId || '(unknown)'} belongs to a different job.`,
      requirementJobId: requirementIdentity.jobId,
      targetJobId,
    };
  }

  if (
    requirementIdentity.jobNumber &&
    targetJobNumber &&
    requirementIdentity.jobNumber !== targetJobNumber
  ) {
    return {
      ok: false,
      reason: 'REQUIREMENT_JOB_NUMBER_MISMATCH',
      status: 409,
      message: `${materialLabel} requirement ${requirementIdentity.requirementId || requestedRequirementId || '(unknown)'} belongs to job ${requirementIdentity.jobNumber}, not ${targetJobNumber}.`,
      requirementJobNumber: requirementIdentity.jobNumber,
      targetJobNumber,
    };
  }

  return {
    ok: true,
    reason: 'MATCH',
    requirementId: requirementIdentity.requirementId || requestedRequirementId,
    materialType: normalizedMaterialType,
    jobId: targetJobId,
    jobNumber: targetJobNumber || requirementIdentity.jobNumber,
  };
}
