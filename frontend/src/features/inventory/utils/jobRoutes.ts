export function buildAllocationJobRoute(job: { jobId?: string | null; jobNumber?: string | null }) {
  const jobId = String(job.jobId || '').trim();
  if (jobId) {
    return `/allocations/jobs/${encodeURIComponent(jobId)}`;
  }

  const jobNumber = String(job.jobNumber || '').trim();
  return `/allocations/${encodeURIComponent(jobNumber)}`;
}
