export function buildAllocationJobRoute(
  job: {
    jobId?: string | null;
    jobNumber?: string | null;
    phaseId?: string | null;
  },
  options: { includePhaseTarget?: boolean } = {}
) {
  const jobId = String(job.jobId || '').trim();
  if (jobId) {
    const phaseId = options.includePhaseTarget ? String(job.phaseId || '').trim() : '';
    const jobRoute = `/allocations/jobs/${encodeURIComponent(jobId)}`;
    return phaseId ? `${jobRoute}?phaseId=${encodeURIComponent(phaseId)}` : jobRoute;
  }

  const jobNumber = String(job.jobNumber || '').trim();
  return `/allocations/${encodeURIComponent(jobNumber)}`;
}

export function getJobNavigationIdentity(job: {
  jobId?: string | null;
  jobNumber?: string | null;
  phaseId?: string | null;
  workScopeKey?: string | null;
  workScope?: string | null;
  sections?: string | null;
  warehouse?: string | null;
}) {
  const jobId = String(job.jobId || '').trim();
  const phaseId = String(job.phaseId || '').trim();
  if (jobId) {
    return phaseId ? `job:${jobId}:phase:${phaseId}` : `job:${jobId}`;
  }

  return [
    'legacy-job',
    String(job.jobNumber || '').trim(),
    phaseId,
    String(job.workScopeKey || job.workScope || job.sections || '').trim(),
    String(job.warehouse || '').trim()
  ].join(':');
}
