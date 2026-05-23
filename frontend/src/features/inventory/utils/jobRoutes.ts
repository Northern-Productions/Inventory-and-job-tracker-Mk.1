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
