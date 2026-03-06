import { describe, expect, it } from 'vitest';
import { inventoryKeys } from './useInventoryQueries';

describe('inventory query keys', () => {
  it('keeps jobs and allocation query keys distinct', () => {
    expect(inventoryKeys.jobs).not.toEqual(inventoryKeys.allocationJobs);
    expect(inventoryKeys.job('123456')).not.toEqual(inventoryKeys.allocationJob('123456'));
  });
});
