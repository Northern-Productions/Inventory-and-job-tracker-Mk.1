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
    workScopeKey: normalizeJobWorkScopeKey(workScope),
    routeTarget: buildJobRouteTarget(jobId, jobNumber),
  };
}

function getDuplicateReason(existingJob, requestedWorkScopeKey) {
  if (!existingJob) {
    return JOB_DUPLICATE_REASONS.NO_MATCH;
  }

  if (existingJob.workScopeKey === requestedWorkScopeKey) {
    return existingJob.lifecycleStatus === 'COMPLETED'
      ? JOB_DUPLICATE_REASONS.SAME_JOB_SCOPE_COMPLETED
      : JOB_DUPLICATE_REASONS.SAME_JOB_SCOPE_ACTIVE;
  }

  return JOB_DUPLICATE_REASONS.SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED;
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
  const reason = getDuplicateReason(normalizedExistingJob, workScopeKey);
  const exists = Boolean(normalizedExistingJob);

  return {
    exists,
    allowed: !exists,
    reason,
    jobNumber: normalizedJobNumber,
    workScope,
    workScopeKey,
    job: normalizedExistingJob,
    existingJob: normalizedExistingJob,
    sameJobNumberJobs: listedJobs,
  };
}
