import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateCaulkJobQueries, invalidateJobLifecycleQueries } from './inventoryInvalidation';
import { inventoryKeys } from './inventoryQueryKeys';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

describe('inventory invalidation job identity', () => {
  it('invalidates canonical jobId detail without invalidating same-number legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const jobId = '11111111-1111-4111-8111-111111111111';

    queryClient.setQueryData(inventoryKeys.jobById(jobId), { source: 'job-id' });
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), { source: 'legacy-allocation-job' });

    await invalidateJobLifecycleQueries(queryClient, { jobId });

    expect(queryClient.getQueryState(inventoryKeys.jobById(jobId))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
  });

  it('preserves legacy jobNumber invalidation behavior', async () => {
    const queryClient = createQueryClient();

    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), { source: 'legacy-allocation-job' });

    await invalidateJobLifecycleQueries(queryClient, '1234');

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });

  it('invalidates canonical caulk jobId detail without invalidating same-number legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const jobId = '11111111-1111-4111-8111-111111111111';

    queryClient.setQueryData(inventoryKeys.jobById(jobId), { source: 'job-id' });
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), { source: 'legacy-allocation-job' });
    queryClient.setQueryData(['caulk', 'stock'], { source: 'stock' });
    queryClient.setQueryData(['caulk', 'transactions'], { source: 'transactions' });

    await invalidateCaulkJobQueries(queryClient, { jobId, jobNumber: '1234' });

    expect(queryClient.getQueryState(inventoryKeys.jobById(jobId))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(['caulk', 'stock'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['caulk', 'transactions'])?.isInvalidated).toBe(true);
  });

  it('preserves legacy caulk jobNumber invalidation behavior', async () => {
    const queryClient = createQueryClient();

    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), { source: 'legacy-allocation-job' });

    await invalidateCaulkJobQueries(queryClient, '1234');

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });
});
