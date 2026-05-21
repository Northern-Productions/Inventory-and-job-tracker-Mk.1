import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { AllocationJobDetail, JobDetail } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { applyCheckoutAllToCaches, updateCaulkCheckinCaches, updateCheckedOutBoxCaches } from './jobMaterialMutations';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });
}

function buildAllocation(overrides: Record<string, unknown> = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-04-10',
    crewLeader: 'Crew',
    allocatedFeet: 10,
    coveredFeet: 10,
    status: 'ACTIVE' as const,
    allocationKind: 'REQUIREMENT' as const,
    allocationSource: 'MANUAL' as const,
    createdAt: '2026-04-10T10:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: 'SOLYX',
    filmName: 'Whiteout SXWF-WO',
    widthIn: 60,
    boxStatus: 'IN_STOCK' as const,
    checkedOutOnThisJob: false,
    ...overrides
  };
}

function buildJobDetail(allocations: JobDetail['allocations']): JobDetail {
  return {
    summary: {
      jobNumber: '000123',
      warehouse: 'IL1',
      sections: null,
      installDate: '2026-04-10',
      crewLeader: 'Crew',
      status: 'READY',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 20,
      allocatedFeet: 20,
      remainingFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 2,
      allocationCount: allocations.length,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '2026-04-10T00:00:00Z',
      updatedAt: '2026-04-10T00:00:00Z',
      notes: ''
    },
    requirements: [],
    allocations,
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: []
  };
}

function buildAllocationJobDetail(allocations: AllocationJobDetail['allocations']): AllocationJobDetail {
  return {
    summary: {
      jobNumber: '000123',
      installDate: '2026-04-10',
      crewLeader: 'Crew',
      status: 'READY',
      activeAllocatedFeet: 20,
      fulfilledAllocatedFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      openFilmOrderCount: 0,
      boxCount: 1,
      hasOrderedAllocations: false
    },
    allocations,
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: []
  };
}

function buildBox(boxId: string, overrides: Record<string, unknown> = {}) {
  return {
    boxId,
    warehouse: 'IL1',
    manufacturer: 'SOLYX',
    filmName: 'Whiteout SXWF-WO',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 25,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-04-01',
    receivedDate: '2026-04-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: 'SOLYX|WHITEOUT SXWF-WO',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function buildCaulkJobDetail(): JobDetail {
  return {
    summary: {
      jobNumber: '5143',
      warehouse: 'IL1',
      sections: 'Section 1',
      installDate: '2026-05-21',
      crewLeader: 'Crew',
      status: 'READY',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 0,
      allocatedFeet: 0,
      remainingFeet: 0,
      requiredTubes: 8,
      allocatedTubes: 8,
      remainingTubes: 0,
      requirementCount: 0,
      allocationCount: 1,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '',
      updatedAt: '',
      notes: ''
    },
    requirements: [],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [
      {
        requirementId: 'caulk-req-1',
        jobNumber: '5143',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA',
        productCode: 'Black',
        tubesPerCase: 12,
        requiredTubes: 8,
        status: 'ACTIVE',
        isComplete: false,
        actualUsedTubes: 0,
        completionResult: '',
        allocatedTubes: 8,
        remainingTubes: 0,
        notes: '',
        updatedAt: ''
      }
    ],
    caulkAllocations: [
      {
        caulkAllocationId: 'caulk-alloc-1',
        requirementId: 'caulk-req-1',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA',
        productCode: 'Black',
        tubesPerCase: 12,
        warehouse: 'IL1',
        allocatedTubes: 8,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: 8,
        returnedUnusedTubesTotal: 0,
        usedTubesTotal: 0,
        overageTubesTotal: 0,
        outstandingCheckoutTubes: 8,
        openCheckoutCount: 1,
        status: 'ACTIVE',
        allocationSource: 'MANUAL',
        createdAt: '',
        createdBy: '',
        updatedAt: '',
        updatedBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
        pendingTransfer: null
      }
    ],
    caulkCheckouts: [
      {
        caulkCheckoutId: 'caulk-checkout-1',
        caulkAllocationId: 'caulk-alloc-1',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA',
        productCode: 'Black',
        tubesPerCase: 12,
        warehouse: 'IL1',
        checkoutTubes: 8,
        overageTubes: 0,
        status: 'OPEN',
        checkedOutAt: '',
        checkedOutBy: '',
        checkedInAt: '',
        checkedInBy: '',
        unusedTubes: 0,
        usedTubes: 0,
        notes: ''
      }
    ],
    filmOrders: []
  };
}

describe('jobMaterialMutations', () => {
  it('marks only unresolved current film rows as checked out during a single checkout', () => {
    const queryClient = createQueryClient();
    const allocations = [
      buildAllocation({
        allocationId: 'alloc-history',
        resolvedAt: '2026-04-10T09:55:00Z'
      }),
      buildAllocation({
        allocationId: 'alloc-current',
        createdAt: '2026-04-10T10:32:00Z'
      })
    ];

    queryClient.setQueryData(inventoryKeys.job('000123'), buildJobDetail(allocations));
    queryClient.setQueryData(inventoryKeys.allocationJob('000123'), buildAllocationJobDetail(allocations));

    updateCheckedOutBoxCaches(queryClient, 'IL1-100', 'CHECKED_OUT');

    const updatedJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job('000123'));
    expect(updatedJob?.allocations).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-history',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: false
      }),
      expect.objectContaining({
        allocationId: 'alloc-current',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      })
    ]);
  });

  it('clears only the current checked-out row state during check-in', () => {
    const queryClient = createQueryClient();
    const allocations = [
      buildAllocation({
        allocationId: 'alloc-history',
        resolvedAt: '2026-04-10T09:55:00Z',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: false
      }),
      buildAllocation({
        allocationId: 'alloc-current',
        resolvedAt: '2026-04-10T10:35:00Z',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      })
    ];

    queryClient.setQueryData(inventoryKeys.job('000123'), buildJobDetail(allocations));
    queryClient.setQueryData(inventoryKeys.allocationJob('000123'), buildAllocationJobDetail(allocations));

    updateCheckedOutBoxCaches(queryClient, 'IL1-100', 'IN_STOCK');

    const updatedJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job('000123'));
    expect(updatedJob?.allocations).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-history',
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }),
      expect.objectContaining({
        allocationId: 'alloc-current',
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      })
    ]);
  });

  it('checks out only unresolved current rows during checkout all and leaves history rows hidden', () => {
    const queryClient = createQueryClient();
    const allocations = [
      buildAllocation({
        allocationId: 'alloc-history',
        resolvedAt: '2026-04-10T09:55:00Z'
      }),
      buildAllocation({
        allocationId: 'alloc-current',
        createdAt: '2026-04-10T10:32:00Z'
      }),
      buildAllocation({
        allocationId: 'alloc-second-box',
        boxId: 'IL1-101',
        createdAt: '2026-04-10T10:34:00Z'
      })
    ];

    queryClient.setQueryData(inventoryKeys.job('000123'), buildJobDetail(allocations));
    queryClient.setQueryData(inventoryKeys.allocationJob('000123'), buildAllocationJobDetail(allocations));
    queryClient.setQueryData(inventoryKeys.box('IL1-100'), buildBox('IL1-100'));
    queryClient.setQueryData(inventoryKeys.box('IL1-101'), buildBox('IL1-101', { feetAvailable: 18 }));

    applyCheckoutAllToCaches(queryClient, '000123');

    const updatedJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job('000123'));
    expect(updatedJob?.allocations).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-history',
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }),
      expect.objectContaining({
        allocationId: 'alloc-current',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      }),
      expect.objectContaining({
        allocationId: 'alloc-second-box',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      })
    ]);

    expect(queryClient.getQueryData(inventoryKeys.box('IL1-100'))).toMatchObject({
      status: 'CHECKED_OUT',
      hasEverBeenCheckedOut: true,
      lastCheckoutJob: '000123'
    });
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-101'))).toMatchObject({
      status: 'CHECKED_OUT',
      hasEverBeenCheckedOut: true,
      lastCheckoutJob: '000123'
    });
  });

  it('records checked-in caulk usage on the requirement and resolves the consumed allocation', () => {
    const queryClient = createQueryClient();
    const detail = buildCaulkJobDetail();
    queryClient.setQueryData(inventoryKeys.job('5143'), detail);

    updateCaulkCheckinCaches(queryClient, 'caulk-alloc-1', 'caulk-checkout-1', {
      checkoutTubes: 8,
      unusedLooseTubes: 0,
      unusedCases: 0,
      sourceCheckout: detail.caulkCheckouts[0]
    });

    const updatedJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job('5143'));
    expect(updatedJob?.summary).toMatchObject({
      allocatedTubes: 0,
      remainingTubes: 8
    });
    expect(updatedJob?.caulkRequirements[0]).toMatchObject({
      actualUsedTubes: 8,
      allocatedTubes: 0,
      remainingTubes: 8
    });
    expect(updatedJob?.caulkAllocations[0]).toMatchObject({
      status: 'CANCELLED',
      openCheckoutCount: 0,
      outstandingCheckoutTubes: 0,
      usedTubesTotal: 8
    });
    expect(updatedJob?.caulkCheckouts[0]).toMatchObject({
      status: 'CLOSED',
      unusedTubes: 0,
      usedTubes: 8
    });
  });
});
