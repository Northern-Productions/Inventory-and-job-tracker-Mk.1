// Purpose: Reusable React Query invalidation groups for inventory workflows.
import type { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';

const CAULK_QUERY_KEY = ['caulk'] as const;

export interface JobCacheIdentity {
  jobId?: string | null;
  jobNumber?: string | null;
}

function normalizeJobCacheIdentity(identity: string | JobCacheIdentity): Required<JobCacheIdentity> {
  if (typeof identity === 'string') {
    return { jobId: '', jobNumber: identity.trim() };
  }

  return {
    jobId: String(identity.jobId || '').trim(),
    jobNumber: String(identity.jobNumber || '').trim()
  };
}

export async function invalidateQueryKeys(
  queryClient: QueryClient,
  queryKeys: readonly (readonly unknown[])[]
) {
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
}

export async function invalidateJobAndFilmOrderQueries(
  queryClient: QueryClient,
  identity: string | JobCacheIdentity
) {
  const { jobId, jobNumber } = normalizeJobCacheIdentity(identity);
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.jobs,
    ...(jobId ? [inventoryKeys.jobById(jobId)] : []),
    ...(jobNumber ? [inventoryKeys.job(jobNumber)] : []),
    inventoryKeys.jobsCalendarRoot,
    inventoryKeys.allocationJobs,
    inventoryKeys.filmOrders
  ]);
}

export async function invalidateJobLifecycleQueries(
  queryClient: QueryClient,
  identity: string | JobCacheIdentity
) {
  const { jobId, jobNumber } = normalizeJobCacheIdentity(identity);
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.jobs,
    ...(jobId ? [inventoryKeys.jobById(jobId)] : []),
    ...(jobNumber ? [inventoryKeys.job(jobNumber)] : []),
    inventoryKeys.jobsCalendarRoot,
    inventoryKeys.allocationJobs,
    ...(jobNumber ? [inventoryKeys.allocationJob(jobNumber)] : []),
    inventoryKeys.filmOrders,
    inventoryKeys.reportsRoot
  ]);
}

export async function invalidateCaulkJobQueries(
  queryClient: QueryClient,
  identity: string | JobCacheIdentity,
  options: { includeJobCollections?: boolean } = {}
) {
  const { jobId, jobNumber } = normalizeJobCacheIdentity(identity);
  const includeLegacyJobDetail = !jobId && jobNumber;
  const queryKeys: (readonly unknown[])[] = [
    ...(jobId ? [inventoryKeys.jobById(jobId)] : []),
    ...(includeLegacyJobDetail ? [inventoryKeys.job(jobNumber), inventoryKeys.allocationJob(jobNumber)] : []),
    CAULK_QUERY_KEY,
    ['caulk', 'stock'],
    ['caulk', 'transactions']
  ];

  if (options.includeJobCollections || jobId) {
    queryKeys.unshift(
      inventoryKeys.jobs,
      inventoryKeys.jobsCalendarRoot,
      inventoryKeys.allocationJobs,
      inventoryKeys.reportsRoot
    );
  }

  await invalidateQueryKeys(queryClient, queryKeys);
}

export async function invalidateGlobalPlanningQueries(queryClient: QueryClient) {
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.listRoot,
    inventoryKeys.boxRoot,
    inventoryKeys.boxTransferRoot,
    inventoryKeys.allocationsRoot,
    inventoryKeys.jobs,
    inventoryKeys.jobsCalendarRoot,
    inventoryKeys.jobRoot,
    inventoryKeys.allocationJobs,
    inventoryKeys.allocationJobRoot,
    inventoryKeys.filmOrders,
    inventoryKeys.reportsRoot
  ]);
}
