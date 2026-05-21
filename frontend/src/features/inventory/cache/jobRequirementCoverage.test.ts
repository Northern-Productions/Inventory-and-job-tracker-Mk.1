import { describe, expect, it } from 'vitest';
import type { JobDetail } from '../../../domain';
import {
  createOptimisticJobDetailAfterRequirementStateChange,
  reconcileJobDetailCaulkCoverage
} from './jobRequirementCoverage';

function buildSummary(overrides: Partial<JobDetail['summary']> = {}): JobDetail['summary'] {
  return {
    jobNumber: '19413',
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-05-06',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 20,
    allocatedTubes: 0,
    remainingTubes: 20,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '2026-05-06T00:00:00Z',
    updatedAt: '2026-05-06T00:00:00Z',
    notes: '',
    ...overrides
  };
}

function buildCaulkRequirement(
  overrides: Partial<JobDetail['caulkRequirements'][number]> = {}
): JobDetail['caulkRequirements'][number] {
  return {
    requirementId: 'req-1',
    jobNumber: '19413',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: '3M',
    productName: 'IPA Black',
    productCode: 'IPA-BLK',
    tubesPerCase: 12,
    requiredTubes: 20,
    allocatedTubes: 0,
    remainingTubes: 20,
    notes: '',
    updatedAt: '2026-05-06T00:00:00Z',
    ...overrides
  };
}

function buildCaulkAllocation(
  overrides: Partial<JobDetail['caulkAllocations'][number]> & { jobNumber?: string } = {}
): JobDetail['caulkAllocations'][number] {
  return {
    caulkAllocationId: 'alloc-1',
    requirementId: 'req-1',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: '3M',
    productName: 'IPA Black',
    productCode: 'IPA-BLK',
    tubesPerCase: 12,
    warehouse: 'IL1',
    allocatedTubes: 20,
    reservedTubesRemaining: 20,
    checkedOutTubesTotal: 0,
    returnedUnusedTubesTotal: 0,
    usedTubesTotal: 0,
    overageTubesTotal: 0,
    outstandingCheckoutTubes: 0,
    openCheckoutCount: 0,
    status: 'ACTIVE',
    allocationSource: 'MANUAL',
    createdAt: '2026-05-06T10:00:00Z',
    createdBy: 'tester',
    updatedAt: '2026-05-06T10:00:00Z',
    updatedBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    pendingTransfer: null,
    ...overrides
  } as JobDetail['caulkAllocations'][number];
}

function buildFilmRequirement(
  overrides: Partial<JobDetail['requirements'][number]> = {}
): JobDetail['requirements'][number] {
  return {
    requirementId: 'film-req-1',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requiredFeet: 25,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedFeet: 20,
    completionResult: '',
    allocatedFeet: 0,
    remainingFeet: 25,
    autoPlanningSuppressed: false,
    ...overrides
  };
}

function buildJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  const caulkRequirements = overrides.caulkRequirements || [buildCaulkRequirement()];

  return {
    ...overrides,
    summary: buildSummary({
      requiredTubes: caulkRequirements.reduce((sum, entry) => sum + entry.requiredTubes, 0),
      allocatedTubes: caulkRequirements.reduce((sum, entry) => sum + entry.allocatedTubes, 0),
      remainingTubes: caulkRequirements.reduce((sum, entry) => sum + entry.remainingTubes, 0),
      ...(overrides.summary || {})
    }),
    requirements: overrides.requirements || [],
    allocations: overrides.allocations || [],
    usage: overrides.usage || [],
    usageTimeline: overrides.usageTimeline || [],
    caulkRequirements,
    caulkAllocations: overrides.caulkAllocations || [],
    caulkCheckouts: overrides.caulkCheckouts || [],
    filmOrders: overrides.filmOrders || [],
    ...(overrides.filmTransferAlerts ? { filmTransferAlerts: overrides.filmTransferAlerts } : {}),
    ...(overrides.caulkTransferAlerts ? { caulkTransferAlerts: overrides.caulkTransferAlerts } : {})
  };
}

function rebuildCaulkRequirementCoverage(detail: JobDetail) {
  return reconcileJobDetailCaulkCoverage(detail);
}

describe('jobRequirementCoverage caulk fallback coverage', () => {
  it('counts requirement-linked caulk allocation toward optimistic caulk requirement coverage', () => {
    const detail = buildJobDetail({
      caulkRequirements: [buildCaulkRequirement({ requiredTubes: 20 })],
      caulkAllocations: [buildCaulkAllocation({ requirementId: 'req-1', reservedTubesRemaining: 20 })]
    });

    const nextDetail = rebuildCaulkRequirementCoverage(detail);

    expect(nextDetail.caulkRequirements[0]).toMatchObject({
      allocatedTubes: 20,
      remainingTubes: 0
    });
    expect(nextDetail.summary).toMatchObject({
      status: 'READY',
      allocatedTubes: 20,
      remainingTubes: 0
    });
  });

  it('counts unbound same-product caulk allocation toward unmet requirement coverage', () => {
    const detail = buildJobDetail({
      caulkRequirements: [buildCaulkRequirement({ requiredTubes: 20 })],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: '',
          reservedTubesRemaining: 20
        })
      ]
    });

    const nextDetail = rebuildCaulkRequirementCoverage(detail);

    expect(nextDetail.caulkRequirements[0]).toMatchObject({
      allocatedTubes: 20,
      remainingTubes: 0
    });
    expect(nextDetail.summary.status).toBe('READY');
  });

  it('distributes one unbound same-product caulk allocation across duplicate product requirements in stable order', () => {
    const detail = buildJobDetail({
      caulkRequirements: [
        buildCaulkRequirement({ requirementId: 'req-a', requiredTubes: 10 }),
        buildCaulkRequirement({ requirementId: 'req-b', requiredTubes: 10 })
      ],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: '',
          caulkAllocationId: 'alloc-span',
          allocatedTubes: 15,
          reservedTubesRemaining: 15
        })
      ]
    });

    const nextDetail = rebuildCaulkRequirementCoverage(detail);

    expect(
      nextDetail.caulkRequirements.map((entry) => ({
        requirementId: entry.requirementId,
        allocatedTubes: entry.allocatedTubes,
        remainingTubes: entry.remainingTubes
      }))
    ).toEqual([
      { requirementId: 'req-a', allocatedTubes: 10, remainingTubes: 0 },
      { requirementId: 'req-b', allocatedTubes: 5, remainingTubes: 5 }
    ]);
  });

  it('does not count returned unused or wrong-warehouse unbound caulk allocations', () => {
    const detail = buildJobDetail({
      caulkRequirements: [buildCaulkRequirement({ requiredTubes: 20 })],
      caulkAllocations: [
        buildCaulkAllocation({
          caulkAllocationId: 'returned-unused',
          requirementId: '',
          allocatedTubes: 20,
          reservedTubesRemaining: 0,
          checkedOutTubesTotal: 20,
          returnedUnusedTubesTotal: 20
        }),
        buildCaulkAllocation({
          caulkAllocationId: 'wrong-warehouse',
          requirementId: '',
          warehouse: 'MS1',
          allocatedTubes: 20,
          reservedTubesRemaining: 20
        })
      ]
    });

    const nextDetail = rebuildCaulkRequirementCoverage(detail);

    expect(nextDetail.caulkRequirements[0]).toMatchObject({
      allocatedTubes: 0,
      remainingTubes: 20
    });
    expect(nextDetail.summary.status).toBe('FILM_ORDER');
  });
});

describe('jobRequirementCoverage requirement usage state', () => {
  it('removes completed film requirements from material demand while preserving actual usage', () => {
    const detail = buildJobDetail({
      summary: buildSummary({
        requiredFeet: 25,
        remainingFeet: 25,
        status: 'FILM_ORDER',
        requiredTubes: 0,
        remainingTubes: 0
      }),
      requirements: [buildFilmRequirement({ actualUsedFeet: 20 })],
      caulkRequirements: []
    });

    const nextDetail = createOptimisticJobDetailAfterRequirementStateChange(detail, {
      requirementId: 'film-req-1',
      status: 'COMPLETE'
    });

    expect(nextDetail.requirements[0]).toMatchObject({
      status: 'COMPLETE',
      actualUsedFeet: 20,
      remainingFeet: 0,
      completionResult: 'ON_TARGET'
    });
    expect(nextDetail.summary).toMatchObject({
      requiredFeet: 0,
      remainingFeet: 0,
      status: 'READY'
    });
  });

  it('reactivates completed requirements without clearing actual used LF', () => {
    const detail = buildJobDetail({
      summary: buildSummary({
        requiredFeet: 0,
        remainingFeet: 0,
        status: 'READY',
        requiredTubes: 0,
        remainingTubes: 0
      }),
      requirements: [
        buildFilmRequirement({
          status: 'COMPLETE',
          isComplete: true,
          actualUsedFeet: 28,
          remainingFeet: 0,
          completionResult: 'OVERUSED'
        })
      ],
      caulkRequirements: []
    });

    const nextDetail = createOptimisticJobDetailAfterRequirementStateChange(detail, {
      requirementId: 'film-req-1',
      status: 'ACTIVE'
    });

    expect(nextDetail.requirements[0]).toMatchObject({
      status: 'ACTIVE',
      actualUsedFeet: 28,
      completionResult: '',
      remainingFeet: 25
    });
    expect(nextDetail.summary.status).toBe('FILM_ORDER');
  });
});
