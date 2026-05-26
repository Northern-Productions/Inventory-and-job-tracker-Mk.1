import { describe, expect, it } from 'vitest';
import { inventoryKeys } from './useInventoryQueries';

describe('inventory query keys', () => {
  it('keeps jobs and allocation query keys distinct', () => {
    expect(inventoryKeys.jobs).not.toEqual(inventoryKeys.allocationJobs);
    expect(inventoryKeys.jobsListRoot).not.toEqual(inventoryKeys.jobsSearch);
    expect(
      inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' })
    ).not.toEqual(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'COMPLETED' }));
    expect(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' })).not.toEqual(
      inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE', warehouse: 'MS1' })
    );
    expect(
      inventoryKeys.jobsSearchResults({ query: '123', limit: 25, lifecycleStatus: 'ACTIVE' })
    ).not.toEqual(
      inventoryKeys.jobsSearchResults({
        query: '123',
        limit: 25,
        lifecycleStatus: 'COMPLETED'
      })
    );
    expect(
      inventoryKeys.jobsSearchResults({ query: '123', limit: 25, lifecycleStatus: 'ACTIVE' })
    ).not.toEqual(
      inventoryKeys.jobsSearchResults({
        query: '123',
        limit: 25,
        lifecycleStatus: 'ACTIVE',
        warehouse: 'MS1'
      })
    );
    expect(inventoryKeys.filmOrders).not.toEqual(
      inventoryKeys.filmOrdersList({ warehouse: 'MS1' })
    );
    expect(inventoryKeys.job('123456')).not.toEqual(inventoryKeys.allocationJob('123456'));
    expect(inventoryKeys.ownerReportsRoot).not.toEqual(inventoryKeys.reportsRoot);
  });
});
