// Purpose: Reusable React Query invalidation groups for inventory workflows.
import type { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';

const CAULK_QUERY_KEY = ['caulk'] as const;

export async function invalidateQueryKeys(
  queryClient: QueryClient,
  queryKeys: readonly (readonly unknown[])[]
) {
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
}

export async function invalidateJobAndFilmOrderQueries(queryClient: QueryClient, jobNumber: string) {
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.jobs,
    inventoryKeys.job(jobNumber),
    inventoryKeys.jobsCalendarRoot,
    inventoryKeys.allocationJobs,
    inventoryKeys.filmOrders
  ]);
}

export async function invalidateJobLifecycleQueries(queryClient: QueryClient, jobNumber: string) {
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.jobs,
    inventoryKeys.job(jobNumber),
    inventoryKeys.jobsCalendarRoot,
    inventoryKeys.allocationJobs,
    inventoryKeys.allocationJob(jobNumber),
    inventoryKeys.filmOrders,
    inventoryKeys.reportsRoot
  ]);
}

export async function invalidateCaulkJobQueries(
  queryClient: QueryClient,
  jobNumber: string,
  options: { includeJobCollections?: boolean } = {}
) {
  const queryKeys: (readonly unknown[])[] = [
    inventoryKeys.job(jobNumber),
    inventoryKeys.allocationJob(jobNumber),
    CAULK_QUERY_KEY
  ];

  if (options.includeJobCollections) {
    queryKeys.splice(2, 0, inventoryKeys.jobs, inventoryKeys.allocationJobs);
  }

  await invalidateQueryKeys(queryClient, queryKeys);
}

export async function invalidateGlobalPlanningQueries(queryClient: QueryClient) {
  await invalidateQueryKeys(queryClient, [
    inventoryKeys.listRoot,
    inventoryKeys.boxRoot,
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
