import { describe, expect, it } from 'vitest';
import type { JobDetail } from '../../../domain';
import {
  canMarkJobStagedForPickup,
  canMarkJobStagedForPickupWithAutoCheckout,
  getJobStagingBlockingMessage,
  getJobStagingBlockingMessageWithOptions,
  isLaborOnlyJob
} from './jobStaging';

function buildFilmAllocation(overrides: Record<string, unknown> = {}) {
  const allocatedFeet = Number(overrides.allocatedFeet ?? 8);
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-04-01',
    crewLeader: 'Crew',
    allocatedFeet,
    coveredFeet: Number(overrides.coveredFeet ?? allocatedFeet),
    status: 'FULFILLED' as const,
    allocationKind: 'REQUIREMENT' as const,
    allocationSource: 'MANUAL' as const,
    createdAt: '',
    createdBy: '',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    boxStatus: 'CHECKED_OUT' as const,
    checkedOutOnThisJob: true,
    ...overrides
  };
}

function buildDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    summary: {
      jobNumber: '000123',
      warehouse: 'IL1',
      sections: null,
      installDate: '2026-04-01',
      crewLeader: 'Crew',
      status: 'FILM_ORDER',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 8,
      allocatedFeet: 8,
      remainingFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 1,
      allocationCount: 1,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '',
      updatedAt: '',
      notes: ''
    },
    requirements: [
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }
    ],
    allocations: [
      buildFilmAllocation()
    ],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    ...overrides
  };
}

describe('jobStaging', () => {
  it('allows staging once required film is fully checked out', () => {
    const detail = buildDetail();

    expect(getJobStagingBlockingMessage(detail)).toBe('');
    expect(canMarkJobStagedForPickup(detail)).toBe(true);
  });

  it('blocks staging while required ordered film is still waiting for receipt', () => {
    const detail = buildDetail({
      allocations: [
        buildFilmAllocation({
          ...buildDetail().allocations[0],
          status: 'ACTIVE',
          boxStatus: 'ORDERED',
          checkedOutOnThisJob: false
        })
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe(
      'Receive ordered film before staging this job.'
    );
    expect(canMarkJobStagedForPickup(detail)).toBe(false);
    expect(canMarkJobStagedForPickupWithAutoCheckout(detail)).toBe(false);
  });

  it('blocks staging while required caulk is still reserved', () => {
    const detail = buildDetail({
      summary: {
        ...buildDetail().summary,
        requiredFeet: 0,
        allocatedFeet: 0,
        remainingFeet: 0,
        requiredTubes: 12,
        allocatedTubes: 12,
        remainingTubes: 0
      },
      requirements: [],
      allocations: [],
      caulkRequirements: [
        {
          requirementId: 'caulk-1',
          jobNumber: '000123',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: 'DOW',
          productName: '795 Black',
          productCode: '795-BLK',
          tubesPerCase: 12,
          requiredTubes: 12,
          allocatedTubes: 12,
          remainingTubes: 0,
          notes: '',
          updatedAt: ''
        }
      ],
      caulkAllocations: [
        {
          caulkAllocationId: 'caulk-alloc-1',
          requirementId: 'caulk-1',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: 'DOW',
          productName: '795 Black',
          productCode: '795-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 12,
          reservedTubesRemaining: 12,
          checkedOutTubesTotal: 0,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 0,
          openCheckoutCount: 0,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
          updatedBy: '',
          resolvedAt: '',
          resolvedBy: '',
          notes: ''
        }
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe(
      'Check out the allocated caulk before staging this job.'
    );
    expect(canMarkJobStagedForPickup(detail)).toBe(false);
  });

  it('allows staging when the remaining film is allocated from in-stock boxes', () => {
    const detail = buildDetail({
      allocations: [
        buildFilmAllocation({
          ...buildDetail().allocations[0],
          status: 'ACTIVE',
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        })
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe('');
    expect(getJobStagingBlockingMessageWithOptions(detail, { allowAutoCheckout: true })).toBe('');
    expect(canMarkJobStagedForPickup(detail)).toBe(true);
    expect(canMarkJobStagedForPickupWithAutoCheckout(detail)).toBe(true);
  });

  it('blocks staging while cross-warehouse film is still waiting on transfer', () => {
    const detail = buildDetail({
      summary: {
        ...buildDetail().summary,
        warehouse: 'MS1'
      },
      allocations: [
        buildFilmAllocation({
          boxId: 'IL1-100',
          warehouse: 'IL1',
          status: 'ACTIVE',
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        })
      ],
      filmTransferAlerts: [
        {
          boxId: 'IL1-100',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1',
          state: 'NEEDS_TRANSFER'
        }
      ]
    });

    expect(getJobStagingBlockingMessageWithOptions(detail, { allowAutoCheckout: true })).toBe(
      'Receive transferred film before staging this job.'
    );
    expect(canMarkJobStagedForPickupWithAutoCheckout(detail)).toBe(false);
  });

  it('allows staging when requirements are covered even if a film order record is still open', () => {
    const detail = buildDetail({
      filmOrders: [
        {
          filmOrderId: 'film-order-1',
          jobNumber: '000123',
          warehouse: 'IL1',
          manufacturer: '3M',
          filmName: 'Night Vision 35',
          widthIn: 60,
          requestedFeet: 8,
          coveredFeet: 8,
          orderedFeet: 0,
          remainingToOrderFeet: 0,
          installDate: '2026-04-01',
          crewLeader: 'Crew',
          status: 'FILM_ORDER',
          sourceBoxId: '',
          createdAt: '',
          createdBy: '',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          linkedBoxes: []
        }
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe('');
    expect(canMarkJobStagedForPickup(detail)).toBe(true);
  });

  it('treats jobs with zero material requirements as labor-only workflow', () => {
    const detail = buildDetail({
      summary: {
        ...buildDetail().summary,
        requiredFeet: 0,
        allocatedFeet: 0,
        remainingFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        isLaborOnly: false
      },
      requirements: [],
      allocations: [],
      caulkRequirements: []
    });

    expect(isLaborOnlyJob(detail)).toBe(true);
    expect(getJobStagingBlockingMessage(detail)).toBe('');
  });
});
