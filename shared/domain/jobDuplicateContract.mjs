import {
  normalizeJobWorkScopeDisplay,
  normalizeJobWorkScopeKey,
} from './jobWorkScopeNormalization.mjs';

export const JOB_DUPLICATE_REASONS = Object.freeze({
  NO_MATCH: 'NO_MATCH',
  SAME_JOB_SCOPE_ACTIVE: 'SAME_JOB_SCOPE_ACTIVE',
  SAME_JOB_SCOPE_COMPLETED: 'SAME_JOB_SCOPE_COMPLETED',
  SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED:
    'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED',
});

export const JOB_DUPLICATE_SCOPE_MODES = Object.freeze({
  NO_MATCH: 'NO_MATCH',
  EXACT_SCOPE: 'EXACT_SCOPE',
  DIFFERENT_SCOPE: 'DIFFERENT_SCOPE',
  MIXED_SCOPE: 'MIXED_SCOPE',
});

export function getJobDuplicateWorkScopeInput(payload) {
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'workScope')) {
    return payload.workScope;
  }

  return payload?.sections;
}

function asContractString(value) {
  return String(value ?? '').trim();
}

function normalizeLifecycleStatus(value) {
  const normalized = asContractString(value).toUpperCase();
  if (normalized === 'COMPLETED' || normalized === 'CANCELLED') {
    return normalized;
  }

  return 'ACTIVE';
}

function buildJobRouteTarget(jobId, jobNumber) {
  if (jobId) {
    return `/allocations/jobs/${encodeURIComponent(jobId)}`;
  }

  return jobNumber ? `/allocations/${encodeURIComponent(jobNumber)}` : '';
}

export function normalizeDuplicateJobEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const jobId = asContractString(entry.jobId ?? entry.id);
  const jobNumber = asContractString(entry.jobNumber ?? entry.job_number);
  const workScope = normalizeJobWorkScopeDisplay(entry.workScope ?? entry.sections);
  const persistedWorkScopeKey = asContractString(entry.workScopeKey ?? entry.work_scope_key);
  const lifecycleStatus = normalizeLifecycleStatus(entry.lifecycleStatus ?? entry.lifecycle_status);
  const status = asContractString(entry.status) || (
    lifecycleStatus === 'COMPLETED' || lifecycleStatus === 'CANCELLED'
      ? lifecycleStatus
      : 'FILM_ORDER'
  );

  return {
    ...entry,
    jobId: jobId || undefined,
    jobNumber,
    workScope,
    sections: workScope,
    lifecycleStatus,
    status,
    workScopeKey: persistedWorkScopeKey || normalizeJobWorkScopeKey(workScope),
    routeTarget: buildJobRouteTarget(jobId, jobNumber),
  };
}

function getExactScopeDuplicateReason(exactScopeJobs) {
  if (!exactScopeJobs.length) {
    return JOB_DUPLICATE_REASONS.NO_MATCH;
  }

  const hasActiveExactScopeJob = exactScopeJobs.some(
    (job) => job.lifecycleStatus !== 'COMPLETED'
  );
  if (hasActiveExactScopeJob) {
    return JOB_DUPLICATE_REASONS.SAME_JOB_SCOPE_ACTIVE;
  }

  return JOB_DUPLICATE_REASONS.SAME_JOB_SCOPE_COMPLETED;
}

function getDuplicateScopeMode(exactScopeJobs, differentScopeJobs) {
  if (exactScopeJobs.length && differentScopeJobs.length) {
    return JOB_DUPLICATE_SCOPE_MODES.MIXED_SCOPE;
  }

  if (exactScopeJobs.length) {
    return JOB_DUPLICATE_SCOPE_MODES.EXACT_SCOPE;
  }

  if (differentScopeJobs.length) {
    return JOB_DUPLICATE_SCOPE_MODES.DIFFERENT_SCOPE;
  }

  return JOB_DUPLICATE_SCOPE_MODES.NO_MATCH;
}

export function buildJobDuplicateCheckResult({
  jobNumber,
  workScopeInput,
  existingJob,
  sameJobNumberJobs,
}) {
  const normalizedJobNumber = asContractString(jobNumber);
  const workScope = normalizeJobWorkScopeDisplay(workScopeInput);
  const workScopeKey = normalizeJobWorkScopeKey(workScopeInput);
  const normalizedExistingJob = normalizeDuplicateJobEntry(existingJob);
  const normalizedSameJobNumberJobs = Array.isArray(sameJobNumberJobs)
    ? sameJobNumberJobs.map(normalizeDuplicateJobEntry).filter(Boolean)
    : [];
  const listedJobs = normalizedSameJobNumberJobs.length
    ? normalizedSameJobNumberJobs
    : normalizedExistingJob
      ? [normalizedExistingJob]
      : [];
  const exactScopeJobs = listedJobs.filter((entry) => entry.workScopeKey === workScopeKey);
  const differentScopeJobs = listedJobs.filter((entry) => entry.workScopeKey !== workScopeKey);
  const exactScopeDuplicateExists = exactScopeJobs.length > 0;
  const sameJobNumberDifferentScopeExists = differentScopeJobs.length > 0;
  const duplicateScopeMode = getDuplicateScopeMode(exactScopeJobs, differentScopeJobs);
  const exists = listedJobs.length > 0;
  const reason = !exists
    ? JOB_DUPLICATE_REASONS.NO_MATCH
    : exactScopeDuplicateExists
      ? getExactScopeDuplicateReason(exactScopeJobs)
      : JOB_DUPLICATE_REASONS.SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED;
  const primaryDuplicateJob = exactScopeJobs[0] || differentScopeJobs[0] || null;
  const canCreate = !exists;

  return {
    exists,
    allowed: canCreate,
    canCreate,
    duplicatesEnabled: false,
    reason,
    blockingReason: exists ? reason : null,
    duplicateScopeMode,
    jobNumber: normalizedJobNumber,
    workScope,
    workScopeKey,
    requestedWorkScope: workScope,
    requestedWorkScopeKey: workScopeKey,
    exactScopeDuplicateExists,
    sameJobNumberDifferentScopeExists,
    futureCanCreateAfterEnablement: sameJobNumberDifferentScopeExists && !exactScopeDuplicateExists,
    exactScopeJobs,
    differentScopeJobs,
    job: primaryDuplicateJob,
    existingJob: primaryDuplicateJob,
    sameJobNumberJobs: listedJobs,
  };
}
