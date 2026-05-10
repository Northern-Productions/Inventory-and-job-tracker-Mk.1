import type { QueryClient } from '@tanstack/react-query';
import { getJob, getJobById } from '../../../api/features/jobsClient';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { loadAllocationJobPage } from './allocationJobPageLoader';

const JOB_DETAIL_STALE_TIME_MS = 60 * 1000;

export async function prefetchJobDetail(queryClient: QueryClient, jobNumber: string) {
  const normalizedJobNumber = String(jobNumber || '').trim();
  if (!normalizedJobNumber) {
    return;
  }

  await Promise.all([
    loadAllocationJobPage(),
    queryClient.prefetchQuery({
      queryKey: inventoryKeys.job(normalizedJobNumber),
      queryFn: () => getJob(normalizedJobNumber),
      staleTime: JOB_DETAIL_STALE_TIME_MS
    })
  ]);
}

export async function prefetchJobDetailById(queryClient: QueryClient, jobId: string) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) {
    return;
  }

  await Promise.all([
    loadAllocationJobPage(),
    queryClient.prefetchQuery({
      queryKey: inventoryKeys.jobById(normalizedJobId),
      queryFn: () => getJobById(normalizedJobId),
      staleTime: JOB_DETAIL_STALE_TIME_MS
    })
  ]);
}
