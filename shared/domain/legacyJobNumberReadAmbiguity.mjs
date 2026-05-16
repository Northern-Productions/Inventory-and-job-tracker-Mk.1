export const JOB_NUMBER_AMBIGUOUS_CODE = 'JOB_NUMBER_AMBIGUOUS';

function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizeLegacyJobNumberKey(value) {
  return asTrimmedString(value).toUpperCase();
}

function resolveCandidateWorkScope(job) {
  const workScope = job?.workScope ?? job?.sections ?? null;
  if (workScope === null || workScope === undefined) {
    return null;
  }
  const normalized = asTrimmedString(workScope);
  return normalized || null;
}

export function buildLegacyJobNumberAmbiguityCandidate(job) {
  const jobId = asTrimmedString(job?.id || job?.jobId);
  const jobNumber = asTrimmedString(job?.jobNumber);
  const workScope = resolveCandidateWorkScope(job);
  const lifecycleStatus = asTrimmedString(job?.lifecycleStatus);

  return {
    jobId,
    jobNumber,
    routeTarget: jobId ? `/allocations/jobs/${encodeURIComponent(jobId)}` : '',
    workScope,
    sections: workScope,
    warehouse: asTrimmedString(job?.warehouse),
    installDate: asTrimmedString(job?.installDate),
    crewLeader: asTrimmedString(job?.crewLeader),
    status: asTrimmedString(job?.status),
    lifecycleStatus,
    updatedAt: asTrimmedString(job?.updatedAt),
  };
}

export function findLegacyJobNumberHeaderMatches(jobs, jobNumber) {
  const targetKey = normalizeLegacyJobNumberKey(jobNumber);
  return (Array.isArray(jobs) ? jobs : []).filter(
    (job) => normalizeLegacyJobNumberKey(job?.jobNumber) === targetKey
  );
}

export function resolveLegacyJobNumberReadTargetFromHeaders(jobs, jobNumber) {
  const normalizedJobNumber = asTrimmedString(jobNumber);
  const matches = findLegacyJobNumberHeaderMatches(jobs, normalizedJobNumber);

  if (matches.length > 1) {
    const candidates = matches
      .map(buildLegacyJobNumberAmbiguityCandidate)
      .filter((candidate) => candidate.jobId && candidate.jobNumber);
    return {
      kind: 'ambiguous',
      jobNumber: normalizedJobNumber,
      candidates,
      details: {
        code: JOB_NUMBER_AMBIGUOUS_CODE,
        jobNumber: normalizedJobNumber,
        candidates,
      },
    };
  }

  if (matches.length === 1) {
    return {
      kind: 'selected',
      jobNumber: normalizedJobNumber,
      job: matches[0],
      jobId: asTrimmedString(matches[0]?.id || matches[0]?.jobId),
    };
  }

  return {
    kind: 'legacy-fallback',
    jobNumber: normalizedJobNumber,
    job: null,
    jobId: '',
  };
}
