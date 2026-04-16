import { describe, expect, it } from 'vitest';
import type { CaulkStockEntry, JobCaulkRequirementLine } from '../../../domain';
import {
  buildAddCaulkAllocationDefaults,
  buildCaulkAllocationBreakdownMessage,
  buildCaulkAllocationValuesForRequirement,
  findFirstUnmetCaulkRequirement,
  formatCaulkTubeBreakdown,
  getCaulkAllocationTransferPlan,
  getCaulkTubeBreakdown,
  sortCaulkStockEntriesForAllocation
} from './caulkAllocationPlanning';

function createRequirement(overrides: Partial<JobCaulkRequirementLine> = {}): JobCaulkRequirementLine {
  return {
    requirementId: 'req-1',
    jobNumber: '12345',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: 'DOW',
    productName: '995 Black',
    productCode: 'DOW-995',
    tubesPerCase: 12,
    requiredTubes: 58,
    allocatedTubes: 0,
    remainingTubes: 58,
    notes: '',
    updatedAt: '2026-03-23T00:00:00Z',
    ...overrides
  };
}

function createStockEntry(overrides: Partial<CaulkStockEntry> = {}): CaulkStockEntry {
  return {
    warehouse: 'IL1',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: 'DOW',
    productName: '995 Black',
    productCode: 'DOW-995',
    tubesPerCase: 16,
    tubesOnHand: 58,
    casesOnHand: 3,
    looseTubes: 10,
    updatedAt: '2026-03-23T00:00:00Z',
    updatedBy: 'tester',
    ...overrides
  };
}

describe('caulkAllocationPlanning', () => {
  it('picks the first unmet requirement and uses its remaining tubes for add defaults', () => {
    const defaults = buildAddCaulkAllocationDefaults({
      requirements: [
        createRequirement({ requirementId: 'req-closed', productId: 'product-closed', remainingTubes: 0 }),
        createRequirement({ requirementId: 'req-open', productId: 'product-open', remainingTubes: 58 })
      ],
      fallbackProductId: 'fallback-product',
      defaultWarehouse: 'IL1'
    });

    expect(defaults).toEqual({
      requirementId: 'req-open',
      productId: 'product-open',
      warehouse: 'IL1',
      allocatedTubes: '58'
    });
    expect(
      findFirstUnmetCaulkRequirement([
        createRequirement({ remainingTubes: 0 }),
        createRequirement({ requirementId: 'req-open', remainingTubes: 4 })
      ])?.requirementId
    ).toBe('req-open');
  });

  it('falls back to ad-hoc defaults when no unmet requirement exists', () => {
    const defaults = buildAddCaulkAllocationDefaults({
      requirements: [createRequirement({ requirementId: 'req-1', productId: 'product-1', remainingTubes: 0 })],
      fallbackProductId: 'preferred-product',
      defaultWarehouse: 'MS1'
    });

    expect(defaults).toEqual({
      requirementId: '',
      productId: 'preferred-product',
      warehouse: 'MS1',
      allocatedTubes: '1'
    });
  });

  it('rebuilds product and tube values when the user selects a requirement in the dialog', () => {
    expect(
      buildCaulkAllocationValuesForRequirement(
        createRequirement({ productId: 'product-58', remainingTubes: 58 })
      )
    ).toEqual({
      productId: 'product-58',
      allocatedTubes: '58'
    });
  });

  it('calculates total tubes, full cases, and loose tubes from the product case pack', () => {
    expect(getCaulkTubeBreakdown(58, 12)).toEqual({
      totalTubes: 58,
      fullCases: 4,
      looseTubes: 10
    });
    expect(formatCaulkTubeBreakdown(58, 12)).toBe('58 tubes | 4 full cases | 10 loose tubes');
  });

  it('treats the full amount as loose tubes when the case pack is unavailable', () => {
    expect(getCaulkTubeBreakdown(10, 0)).toEqual({
      totalTubes: 10,
      fullCases: 0,
      looseTubes: 10
    });
  });

  it('builds the full-width helper text for requirement-prefilled and ad-hoc allocations', () => {
    expect(
      buildCaulkAllocationBreakdownMessage({
        selectedRequirementRemainingTubes: 58,
        allocationTubeCount: 58,
        tubesPerCase: 16
      })
    ).toBe(
      'Prefilled from remaining requirement: 58 tubes still needed on this job. 58 tubes | 3 full cases | 10 loose tubes'
    );

    expect(
      buildCaulkAllocationBreakdownMessage({
        allocationTubeCount: 10,
        tubesPerCase: 16
      })
    ).toBe('Current allocation breakdown: 10 tubes | 0 full cases | 10 loose tubes');
  });

  it('sorts the selected warehouse first and keeps the remaining stock rows alphabetical', () => {
    const sorted = sortCaulkStockEntriesForAllocation(
      [
        createStockEntry({ warehouse: 'MS1' }),
        createStockEntry({ warehouse: 'AZ1' }),
        createStockEntry({ warehouse: 'IL1' })
      ],
      'IL1'
    );

    expect(sorted.map((entry) => entry.warehouse)).toEqual(['IL1', 'AZ1', 'MS1']);
  });

  it('calculates shortage and eligible single-source transfer warehouses for add allocations', () => {
    const transferPlan = getCaulkAllocationTransferPlan({
      mode: 'add',
      productId: 'product-1',
      warehouse: 'MS1',
      allocatedTubesInput: '3',
      stockEntries: [
        createStockEntry({ warehouse: 'MS1', tubesOnHand: 0 }),
        createStockEntry({ warehouse: 'IL1', tubesOnHand: 8 }),
        createStockEntry({ warehouse: 'AZ1', tubesOnHand: 2 })
      ]
    });

    expect(transferPlan).toMatchObject({
      reserveDeltaTubes: 3,
      targetWarehouseTubesOnHand: 0,
      shortageTubes: 3
    });
    expect(transferPlan.eligibleSourceStock.map((entry) => entry.warehouse)).toEqual(['IL1']);
  });

  it('uses only the incremental reserve delta when editing the same product and warehouse', () => {
    const transferPlan = getCaulkAllocationTransferPlan({
      mode: 'edit',
      productId: 'product-1',
      warehouse: 'MS1',
      allocatedTubesInput: '12',
      existingAllocation: {
        productId: 'product-1',
        warehouse: 'MS1',
        allocatedTubes: 10,
        reservedTubesRemaining: 10,
        checkedOutTubesTotal: 0
      },
      stockEntries: [
        createStockEntry({ warehouse: 'MS1', tubesOnHand: 1 }),
        createStockEntry({ warehouse: 'IL1', tubesOnHand: 5 })
      ]
    });

    expect(transferPlan).toMatchObject({
      reserveDeltaTubes: 2,
      targetWarehouseTubesOnHand: 1,
      shortageTubes: 1
    });
    expect(transferPlan.eligibleSourceStock.map((entry) => entry.warehouse)).toEqual(['IL1']);
  });
});
