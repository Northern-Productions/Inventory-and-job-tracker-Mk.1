import type { QueryClient } from '@tanstack/react-query';
import type { JobDetail } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import { syncJobDetailCaches } from '../../../cache/jobs';
import { invalidateJobAndFilmOrderQueries } from '../../inventoryInvalidation';

export async function cancelJobPlanningQueries(queryClient: QueryClient, jobNumber: string) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
    queryClient.cancelQueries({ queryKey: inventoryKeys.job(jobNumber) }),
    queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
    queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(jobNumber) })
  ]);
}

export async function cancelJobMaterialQueries(queryClient: QueryClient, jobNumber: string) {
  await Promise.all([
    cancelJobPlanningQueries(queryClient, jobNumber),
    queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
    queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot })
  ]);
}

export async function syncAndInvalidateJobDetail(
  queryClient: QueryClient,
  detail: JobDetail,
  { syncAllocationJobDetail = true }: { syncAllocationJobDetail?: boolean } = {}
) {
  syncJobDetailCaches(queryClient, detail, { syncAllocationJobDetail });
  await invalidateJobAndFilmOrderQueries(queryClient, detail.summary.jobNumber);
}
