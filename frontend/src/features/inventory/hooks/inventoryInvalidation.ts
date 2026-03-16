// Purpose: Reusable React Query invalidation groups for inventory workflows.
import type { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';

export async function invalidateJobAndFilmOrderQueries(queryClient: QueryClient, jobNumber: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.job(jobNumber) }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
  ]);
}

export async function invalidateJobLifecycleQueries(queryClient: QueryClient, jobNumber: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.job(jobNumber) }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(jobNumber) }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
  ]);
}

export async function invalidateGlobalPlanningQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
  ]);
}
